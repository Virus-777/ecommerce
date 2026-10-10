/**
 * Store credit: balance, lots and the append-only ledger; holds at checkout (hold → capture | release | expire),
 * refunds to credit, expiry, the balance check and the consumers of orders and payments events.
 */
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isAppError } from '../../../kernel/errors/index.js';
import { dateInZone } from '../../../kernel/lib/clock.js';
import { newId } from '../../../kernel/lib/ids.js';
import { callers } from '../../../testing/app.js';
import { DAY, harness, USD, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h?.app.close();
});

const STORE = '/api/store/wallet';
const db = () => h.app.kernel.database.kysely;

/** Sum of the ledger, lots and holds next to the account (the balance check's invariant) */
async function invariant(customerId: string) {
  const r = await sql<{ available: number; held: number; ledger: number; lots: number; holds: number }>`
    select a.available, a.held,
      (select coalesce(sum(amount), 0) from wallet.ledger where customer_id = a.customer_id)::bigint as ledger,
      (select coalesce(sum(remaining), 0) from wallet.lots where customer_id = a.customer_id and state = 'active')::bigint as lots,
      (select coalesce(sum(amount), 0) from wallet.holds where customer_id = a.customer_id and state = 'held')::bigint as holds
    from wallet.accounts a where a.customer_id = ${customerId}`.execute(db());
  const x = r.rows[0]!;
  expect(Number(x.ledger)).toBe(x.available + x.held);
  expect(Number(x.lots)).toBe(x.available);
  expect(Number(x.holds)).toBe(x.held);
  return x;
}

describe('balance and history', () => {
  it('shows an empty wallet to a customer without credit', async () => {
    const c = h.customer();
    const res = await h.call('GET', `${STORE}/credit`, c.token);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ balance: { customerId: c.id, available: USD(0), held: USD(0), nextExpiry: null }, lots: [], recent: [], giftCardsEnabled: false, howToUse: expect.any(String) });
    expect((await h.call('GET', `${STORE}/credit/entries`, c.token)).body.items).toEqual([]);
    // a visitor has no wallet
    expect((await h.call('GET', `${STORE}/credit`, callers.visitor())).status).toBe(401);
  });

  it('adds refund credit as a lot and a ledger entry; the customer sees only their own wallet', async () => {
    const c = h.customer();
    const other = h.customer();
    const orderId = newId();
    h.orderRefs.set(orderId, 'MK-261009-10001');
    const entry = await h.service.creditRefund({ customerId: c.id, refundId: newId(), orderId, amount: USD(4500), reason: 'Returned headphones' }, newId());
    expect(entry).toMatchObject({ kind: 'refund_to_credit', amount: USD(4500), balanceAfter: USD(4500), orderId, orderRef: 'MK-261009-10001', label: 'Refund to store credit · order MK-261009-10001' });
    await h.app.kernel.events.drain();
    expect(h.named('wallet.credit.granted').find((e) => e.entryId === entry.id)).toEqual({ customerId: c.id, entryId: entry.id, kind: 'refund_to_credit', amount: USD(4500), chargedTo: null, sellerId: null, caseId: null, orderId });

    const mine = await h.call('GET', `${STORE}/credit`, c.token);
    expect(mine.body.balance.available).toEqual(USD(4500));
    expect(mine.body.lots).toEqual([expect.objectContaining({ source: 'refund', original: USD(4500), remaining: USD(4500), expiresAt: null, reference: 'order MK-261009-10001' })]);
    expect(mine.body.recent[0]).toMatchObject({ id: entry.id, actor: null, reason: null });
    expect((await h.call('GET', `${STORE}/credit`, other.token)).body.balance.available).toEqual(USD(0));
    expect((await h.call('GET', `${STORE}/credit/entries`, other.token)).body.items).toEqual([]);
    await invariant(c.id);
  });

  it('credits a refund once per refund id, whatever the key', async () => {
    const c = h.customer();
    const refundId = newId();
    const input = { customerId: c.id, refundId, orderId: newId(), amount: USD(1200), reason: 'Refund' };
    const [a, b] = await Promise.all([h.service.creditRefund(input, 'k1'), h.service.creditRefund(input, 'k1')]);
    const again = await h.service.creditRefund(input, 'another-key');
    expect(b.id).toBe(a.id);
    expect(again.id).toBe(a.id);
    expect((await h.service.getBalance(c.id)).available).toEqual(USD(1200));
    // the same refund with another amount is refused
    await expect(h.service.creditRefund({ ...input, amount: USD(1300) }, 'k2')).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(h.service.creditRefund({ ...input, amount: USD(0) }, 'k3')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await invariant(c.id);
  });

  it('refuses to edit or delete ledger entries (append-only)', async () => {
    const c = h.customer();
    await h.give(c.id, 500);
    await expect(sql`update wallet.ledger set amount = 99999 where customer_id = ${c.id}`.execute(db())).rejects.toThrow(/append-only/);
    await expect(sql`delete from wallet.ledger where customer_id = ${c.id}`.execute(db())).rejects.toThrow(/append-only/);
  });
});

describe('holds at checkout', () => {
  it('reserves credit earliest-expiring first, then uses it on the accepted order', async () => {
    const c = h.customer();
    await h.give(c.id, 3000); // refund credit: no expiry
    await h.service.grantGoodwill({ customerId: c.id, amount: USD(2000), reason: 'Late parcel', reasonCode: 'late_delivery', chargedTo: 'platform', expiresInDays: 30 }, { kind: 'staff', id: newId() }, newId());
    const quoteId = newId();
    const hold = await h.service.holdCredit(c.id, quoteId, USD(2500), `${quoteId}:1`);
    expect(hold).toMatchObject({ customerId: c.id, quoteId, amount: USD(2500), state: 'held', orderId: null });
    const bal = await h.service.getBalance(c.id);
    expect(bal).toMatchObject({ available: USD(2500), held: USD(2500) });
    // the goodwill lot (expires in 30 days) went first: 2000 from it, 500 from the refund lot
    const lots = await db().selectFrom('wallet.lots' as never).selectAll().where('customer_id' as never, '=', c.id as never).execute();
    expect(lots.map((l: any) => [l.source, l.remaining]).sort()).toEqual([
      ['goodwill', 0],
      ['refund', 2500],
    ]);
    // the same key or the same checkout is the same reservation
    expect((await h.service.holdCredit(c.id, quoteId, USD(2500), `${quoteId}:1`)).id).toBe(hold.id);
    expect((await h.service.holdCredit(c.id, quoteId, USD(2500), `${quoteId}:2`)).id).toBe(hold.id);
    await expect(h.service.holdCredit(c.id, quoteId, USD(100), `${quoteId}:3`)).rejects.toMatchObject({ code: 'CONFLICT' });

    const orderId = newId();
    h.orderRefs.set(orderId, 'MK-261009-20002');
    const captured = await h.service.captureHold(hold.id, orderId);
    expect(captured).toMatchObject({ state: 'captured', orderId });
    expect((await h.service.captureHold(hold.id, orderId)).state).toBe('captured'); // idempotent
    await expect(h.service.captureHold(hold.id, newId())).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(h.service.releaseHold(hold.id)).rejects.toMatchObject({ code: 'ILLEGAL_TRANSITION' });
    await h.app.kernel.events.drain();
    expect(h.named('wallet.credit.used').filter((e) => e.orderId === orderId)).toEqual([{ customerId: c.id, orderId, amount: USD(2500) }]);
    expect(await h.service.getBalance(c.id)).toMatchObject({ available: USD(2500), held: USD(0) });
    const history = await h.call('GET', `${STORE}/credit/entries`, c.token);
    expect(history.body.items[0]).toMatchObject({ kind: 'capture', amount: USD(-2500), balanceAfter: USD(2500), label: 'Used on order MK-261009-20002', orderRef: 'MK-261009-20002' });
    expect(history.body.items.map((e: any) => e.kind)).not.toContain('hold'); // reservations are staff detail
    const admin = await h.call('GET', `/api/admin/wallet/customers/${c.id}/entries?kind=hold`, h.staff(['wallet.credit.view']));
    expect(admin.body.items).toEqual([expect.objectContaining({ kind: 'hold', amount: USD(0), label: '$25.00 reserved for checkout' })]);
    await invariant(c.id);
  });

  it('refuses a hold above the available credit with INSUFFICIENT_CREDIT', async () => {
    const c = h.customer();
    const err = await h.service.holdCredit(c.id, newId(), USD(100), newId()).catch((e) => e);
    expect(isAppError(err) && err.code).toBe('INSUFFICIENT_CREDIT');
    expect(err.status).toBe(409);
    await h.give(c.id, 700);
    await expect(h.service.holdCredit(c.id, newId(), USD(701), newId())).rejects.toMatchObject({ code: 'INSUFFICIENT_CREDIT', details: { available: USD(700) } });
  });

  it('gives a released hold back to its lots', async () => {
    const c = h.customer();
    await h.give(c.id, 1000);
    const hold = await h.service.holdCredit(c.id, newId(), USD(600), newId());
    const released = await h.service.releaseHold(hold.id);
    expect(released.state).toBe('released');
    expect((await h.service.releaseHold(hold.id)).state).toBe('released'); // idempotent
    expect(await h.service.getBalance(c.id)).toMatchObject({ available: USD(1000), held: USD(0) });
    await expect(h.service.releaseHold(newId())).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await invariant(c.id);
  });

  it('never overspends under concurrent holds (one writer per account)', async () => {
    const c = h.customer();
    await h.give(c.id, 5000);
    const tries = await Promise.allSettled(Array.from({ length: 12 }, () => h.service.holdCredit(c.id, newId(), USD(1000), newId())));
    const ok = tries.filter((t) => t.status === 'fulfilled');
    const refused = tries.filter((t) => t.status === 'rejected') as PromiseRejectedResult[];
    expect(ok).toHaveLength(5);
    expect(refused.every((r) => r.reason.code === 'INSUFFICIENT_CREDIT')).toBe(true);
    expect(await h.service.getBalance(c.id)).toMatchObject({ available: USD(0), held: USD(5000) });
    // concurrent captures, releases and a refund on the same account keep the ledger whole
    const holds = ok.map((t) => (t as PromiseFulfilledResult<{ id: string }>).value.id);
    await Promise.all([...holds.slice(0, 3).map((id) => h.service.captureHold(id, newId())), ...holds.slice(3).map((id) => h.service.releaseHold(id)), h.give(c.id, 250)]);
    expect(await h.service.getBalance(c.id)).toMatchObject({ available: USD(2250), held: USD(0) });
    await invariant(c.id);
  });

  it('uses the credit again when checkout captures a hold that expired while the payment was being checked', async () => {
    const c = h.customer();
    await h.give(c.id, 3000);
    const hold = await h.service.holdCredit(c.id, newId(), USD(1800), newId());
    await h.service.ledger.releaseHold(hold.id, 'expire'); // wallet.release-stale-holds: the pending check outlived the hold
    const orderId = newId();
    const used = await h.service.captureHold(hold.id, orderId); // checkout: the retry was accepted
    expect(used).toMatchObject({ state: 'captured', orderId, amount: USD(1800) });
    expect(used.id).not.toBe(hold.id);
    expect((await h.service.captureHold(hold.id, orderId)).id).toBe(used.id);
    expect(await h.service.getBalance(c.id)).toMatchObject({ available: USD(1200), held: USD(0) });
    await invariant(c.id);
  });

  it('releases holds past holdTtlMinutes (wallet.release-stale-holds)', async () => {
    const c = h.customer();
    await h.give(c.id, 900);
    const hold = await h.service.holdCredit(c.id, newId(), USD(900), newId());
    await h.app.kernel.jobs.runNow('wallet.release-stale-holds');
    expect((await h.service.getBalance(c.id)).held).toEqual(USD(900));
    h.clock.advance(31 * 60_000);
    await h.app.kernel.jobs.runNow('wallet.release-stale-holds');
    expect(await h.service.getBalance(c.id)).toMatchObject({ available: USD(900), held: USD(0) });
    const row = await db().selectFrom('wallet.holds' as never).selectAll().where('id' as never, '=', hold.id as never).executeTakeFirst();
    expect((row as any).state).toBe('released');
  });
});

describe('refunds of orders paid with credit', () => {
  it('returns the credit part of the order first (order_refund_returned), the rest as a refund to credit', async () => {
    const c = h.customer();
    await h.give(c.id, 2000);
    const orderId = newId();
    const hold = await h.service.holdCredit(c.id, newId(), USD(1500), newId());
    await h.service.captureHold(hold.id, orderId);
    const refundId = newId();
    const entry = await h.service.creditRefund({ customerId: c.id, refundId, orderId, amount: USD(2500), reason: 'Order cancelled' }, newId());
    expect(entry).toMatchObject({ kind: 'refund_to_credit', amount: USD(1000), refundId });
    const rows = await db().selectFrom('wallet.ledger' as never).selectAll().where('refund_id' as never, '=', refundId as never).execute();
    expect(rows.map((r: any) => [r.kind, Number(r.amount)]).sort()).toEqual([
      ['order_refund_returned', 1500],
      ['refund_to_credit', 1000],
    ]);
    // a second refund of the same order has no credit part left
    const next = await h.service.creditRefund({ customerId: c.id, refundId: newId(), orderId, amount: USD(300), reason: 'Partial' }, newId());
    expect(next.kind).toBe('refund_to_credit');
    expect((await h.service.getBalance(c.id)).available).toEqual(USD(500 + 2500 + 300));
    await invariant(c.id);
  });
});

describe('events from orders and payments', () => {
  it('captures the checkout hold when the order is placed with an accepted payment', async () => {
    const c = h.customer();
    await h.give(c.id, 1000);
    const sessionId = newId();
    const hold = await h.service.holdCredit(c.id, sessionId, USD(400), newId());
    const orderId = newId();
    const placed = { orderId, ref: 'MK-261009-30003', checkoutSessionId: sessionId, attemptNo: 1, customerId: c.id, guestEmail: null, contactName: 'Ana Lopez', paymentIntentId: newId(), paymentState: 'accepted', total: USD(9900), couponCodes: [], groups: [], placedAt: h.clock.now().toISOString() };
    await h.publish('orders', 'orders.order.placed', placed);
    await h.publish('orders', 'orders.order.placed', placed); // twice: still one use
    const row: any = await db().selectFrom('wallet.holds' as never).selectAll().where('id' as never, '=', hold.id as never).executeTakeFirst();
    expect(row).toMatchObject({ state: 'captured', order_id: orderId });
    expect(h.named('wallet.credit.used').filter((e) => e.orderId === orderId)).toHaveLength(1);
  });

  it('keeps the hold for a payment being checked and releases it when the payment fails', async () => {
    const c = h.customer();
    await h.give(c.id, 1000);
    const sessionId = newId();
    const hold = await h.service.holdCredit(c.id, sessionId, USD(400), newId());
    const orderId = newId();
    await h.publish('orders', 'orders.order.placed', { orderId, ref: 'MK-261009-30004', checkoutSessionId: sessionId, attemptNo: 1, customerId: c.id, guestEmail: null, contactName: 'Ana Lopez', paymentIntentId: newId(), paymentState: 'pending_check', total: USD(9900), couponCodes: [], groups: [], placedAt: h.clock.now().toISOString() });
    let row: any = await db().selectFrom('wallet.holds' as never).selectAll().where('id' as never, '=', hold.id as never).executeTakeFirst();
    expect(row).toMatchObject({ state: 'held', order_id: orderId });
    expect(new Date(row.expires_at).getTime()).toBeGreaterThan(h.clock.now().getTime() + 20 * 3_600_000);
    await h.publish('payments', 'payments.payment.failed', { intentId: newId(), checkoutSessionId: sessionId, orderId, declineCategory: 'card_declined', afterPendingCheck: true, at: h.clock.now().toISOString() });
    row = await db().selectFrom('wallet.holds' as never).selectAll().where('id' as never, '=', hold.id as never).executeTakeFirst();
    expect(row.state).toBe('released');
    expect((await h.service.getBalance(c.id)).available).toEqual(USD(1000));
    // unknown checkouts are ignored
    await h.publish('payments', 'payments.payment.failed', { intentId: newId(), checkoutSessionId: newId(), orderId: null, declineCategory: 'card_declined', afterPendingCheck: false, at: h.clock.now().toISOString() });
    await h.publish('identity', 'identity.user.registered', { accountId: newId(), email: 'new@example.com', firstName: 'N', lastName: 'C', marketingOptIn: false, acceptedTermsVersion: '2026-01', at: h.clock.now().toISOString() });
  });
});

describe('expiry and checks', () => {
  it('expires lots past their date, reminds 30 and 7 days before, and never expires reserved credit', async () => {
    const c = h.customer();
    const staff = { kind: 'staff' as const, id: newId() };
    await h.service.grantGoodwill({ customerId: c.id, amount: USD(1500), reason: 'Sorry', reasonCode: 'service_failure', chargedTo: 'platform', expiresInDays: 40 }, staff, newId());
    await h.give(c.id, 500);
    expect((await h.service.getBalance(c.id)).nextExpiry).toMatchObject({ amount: USD(1500) });

    const expiring = () => h.named('wallet.credit.expiring').filter((e) => e.customerId === c.id);
    h.clock.advance(5 * DAY); // 35 days left: no reminder yet
    await h.app.kernel.jobs.runNow('wallet.expire-lots');
    await h.app.kernel.events.drain();
    expect(expiring()).toEqual([]);
    h.clock.advance(5.5 * DAY); // 29.5 days left
    await h.app.kernel.jobs.runNow('wallet.expire-lots');
    await h.app.kernel.jobs.runNow('wallet.expire-lots'); // a second run the same day changes nothing
    await h.app.kernel.events.drain();
    const lotId = expiring()[0]?.lotId;
    expect(expiring()).toEqual([{ customerId: c.id, lotId: expect.any(String), amount: USD(1500), expiresAt: expect.any(String), daysLeft: 30 }]);
    // notifications tells the customer from the event; wallet no longer calls notify itself
    expect(h.notices.filter((n) => n.topic === 'credit.expiring')).toEqual([]);
    h.clock.advance(10 * DAY); // 19.5 days left: between reminders
    await h.app.kernel.jobs.runNow('wallet.expire-lots');
    h.clock.advance(13 * DAY); // 6.5 days left: the 7-day reminder, once
    await h.app.kernel.jobs.runNow('wallet.expire-lots');
    await h.app.kernel.jobs.runNow('wallet.expire-lots');
    await h.app.kernel.events.drain();
    expect(expiring().map((e) => [e.lotId, e.daysLeft])).toEqual([
      [lotId, 30],
      [lotId, 7],
    ]);
    h.clock.advance(-23 * DAY); // back to 29.5 days left

    const hold = await h.service.holdCredit(c.id, newId(), USD(1000), newId()); // 1000 from the goodwill lot
    h.clock.advance(30 * DAY); // past the expiry
    await h.app.kernel.jobs.runNow('wallet.expire-lots');
    await h.app.kernel.events.drain();
    expect(await h.service.getBalance(c.id)).toMatchObject({ available: USD(500), held: USD(1000), nextExpiry: null });
    expect(h.named('wallet.credit.expired').filter((e) => e.customerId === c.id).map((e) => e.amount)).toEqual([USD(500)]);
    // released after the expiry date: the reserved part expires then
    await h.service.releaseHold(hold.id);
    await h.app.kernel.events.drain();
    expect(await h.service.getBalance(c.id)).toMatchObject({ available: USD(500), held: USD(0) });
    expect(h.named('wallet.credit.expired').filter((e) => e.customerId === c.id).map((e) => e.amount)).toEqual([USD(500), USD(1000)]);
    const kinds = (await h.call('GET', `${STORE}/credit/entries`, c.token)).body.items.map((e: any) => e.kind);
    expect(kinds.filter((k: string) => k === 'expiry')).toHaveLength(2);
    await invariant(c.id);
  });

  it('flags accounts whose balance differs from the ledger to Finance (audit) in wallet.balance-check', async () => {
    const c = h.customer();
    await h.give(c.id, 800);
    await h.app.kernel.jobs.runNow('wallet.balance-check');
    expect(h.audits.filter((a) => a.action === 'wallet.balance_check.difference')).toEqual([]);
    await sql`update wallet.accounts set available = available + 1 where customer_id = ${c.id}`.execute(db());
    await h.app.kernel.jobs.runNow('wallet.balance-check');
    const flagged = h.audits.filter((a) => a.action === 'wallet.balance_check.difference');
    expect(flagged).toHaveLength(1);
    expect(flagged[0]).toMatchObject({ category: 'financial', target: { type: 'wallet_account', id: c.id } });
    await sql`update wallet.accounts set available = available - 1 where customer_id = ${c.id}`.execute(db());
  });
});

describe('pass 3: holds kept alive, liability total, expiry payload', () => {
  const holdMadeAt = async (holdId: string) => {
    const r = await sql<{ at: Date }>`select at from wallet.ledger where hold_id = ${holdId} and kind = 'hold'`.execute(db());
    return r.rows[0]!.at.getTime();
  };

  it('extendHold keeps a hold past holdTtlMinutes so the capture after a slow payment check succeeds (no INSUFFICIENT_CREDIT)', async () => {
    const c = h.customer();
    await h.give(c.id, 5000);
    const hold = await h.service.holdCredit(c.id, newId(), USD(3000), newId());
    const made = await holdMadeAt(hold.id);
    expect(Math.abs(new Date(hold.expiresAt).getTime() - (made + 30 * 60_000))).toBeLessThan(1_000); // holdTtlMinutes default

    const until = new Date(made + 6 * 3_600_000).toISOString();
    const extended = await h.service.extendHold(hold.id, until);
    expect(extended).toMatchObject({ id: hold.id, state: 'held', amount: USD(3000), expiresAt: until });

    h.clock.advance(60 * 60_000); // past the original 30 minutes
    await h.app.kernel.jobs.runNow('wallet.release-stale-holds');
    expect(await h.service.getBalance(c.id)).toMatchObject({ available: USD(2000), held: USD(3000) });

    const orderId = newId();
    const captured = await h.service.captureHold(hold.id, orderId);
    expect(captured).toMatchObject({ state: 'captured', amount: USD(3000) });
    expect(await h.service.getBalance(c.id)).toMatchObject({ available: USD(2000), held: USD(0) });
    await h.app.kernel.events.drain();
    expect(h.named('wallet.credit.used').filter((e) => e.customerId === c.id)).toEqual([{ customerId: c.id, orderId, amount: USD(3000) }]);
    await invariant(c.id);
  });

  it('extendHold never shortens, is capped at pendingHoldMaxHours after the hold was made, and leaves captured or released holds unchanged', async () => {
    const c = h.customer();
    await h.give(c.id, 4000);
    const hold = await h.service.holdCredit(c.id, newId(), USD(1000), newId());
    const made = await holdMadeAt(hold.id);
    const capped = await h.service.extendHold(hold.id, new Date(made + 100 * 3_600_000).toISOString());
    expect(new Date(capped.expiresAt).getTime()).toBe(made + 48 * 3_600_000);
    const notShorter = await h.service.extendHold(hold.id, new Date(made + 3_600_000).toISOString());
    expect(notShorter.expiresAt).toBe(capped.expiresAt);

    h.settings['wallet.pendingHoldMaxHours'] = 2;
    try {
      const other = await h.service.holdCredit(c.id, newId(), USD(500), newId());
      const otherMade = await holdMadeAt(other.id);
      expect(new Date((await h.service.extendHold(other.id, new Date(otherMade + 5 * 3_600_000).toISOString())).expiresAt).getTime()).toBe(otherMade + 2 * 3_600_000);
    } finally {
      delete h.settings['wallet.pendingHoldMaxHours'];
    }

    const released = await h.service.releaseHold(hold.id);
    const again = await h.service.extendHold(hold.id, new Date(made + 10 * 3_600_000).toISOString());
    expect(again).toEqual(released);
    await expect(h.service.extendHold(newId(), new Date().toISOString())).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(h.service.extendHold(hold.id, 'soon')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await invariant(c.id);
  });

  it('getLiabilityTotal sums available and held credit over all accounts, now and as of a past time', async () => {
    const before = await h.service.getLiabilityTotal();
    const a = h.customer();
    const b = h.customer();
    await h.give(a.id, 1000);
    await h.give(b.id, 2500);
    await h.service.holdCredit(b.id, newId(), USD(700), newId());
    const at = await h.service.getLiabilityTotal();
    expect(at.available.amount - before.available.amount).toBe(1000 + 2500 - 700);
    expect(at.held.amount - before.held.amount).toBe(700);
    expect(at.accounts - before.accounts).toBe(2);
    expect(at.available.currency).toBe('USD');

    const t1 = h.clock.now().toISOString();
    h.clock.advance(1_000);
    // later activity: a captured hold and a new account do not change the total as of t1
    const hold = await h.service.holdCredit(a.id, newId(), USD(400), newId());
    await h.service.captureHold(hold.id, newId());
    await h.give(h.customer().id, 900);
    expect(await h.service.getLiabilityTotal(t1)).toEqual(at);
    const now = await h.service.getLiabilityTotal();
    expect(now.available.amount - at.available.amount).toBe(-400 + 900);
    expect(now.held.amount).toBe(at.held.amount);
    expect(now.accounts - at.accounts).toBe(1);
  });

  it('wallet.credit.expired carries the expiry ledger entry and the lot source (finance books breakage on it)', async () => {
    const c = h.customer();
    await h.service.grantGoodwill({ customerId: c.id, amount: USD(1300), reason: 'Late parcel', reasonCode: 'late_delivery', chargedTo: 'platform', expiresInDays: 2 }, { kind: 'staff', id: newId() }, newId());
    const lot = (await h.service.ledger.lots(c.id))[0]!;
    h.clock.advance(3 * DAY);
    await h.app.kernel.jobs.runNow('wallet.expire-lots');
    await h.app.kernel.events.drain();
    const entry = (await h.call('GET', `/api/admin/wallet/customers/${c.id}/entries?kind=expiry`, callers.staff())).body.items[0];
    expect(entry).toMatchObject({ kind: 'expiry', amount: USD(-1300) });
    expect(h.named('wallet.credit.expired').filter((e) => e.customerId === c.id)).toEqual([{ customerId: c.id, entryId: entry.id, lotId: lot.id, source: 'goodwill', amount: USD(1300) }]);
  });
});

describe('balance check reports differences to finance', () => {
  let hf: Harness;
  beforeAll(async () => {
    hf = await harness({ modules: ['finance'] });
  });
  afterAll(async () => {
    await hf?.app.close();
  });

  it('calls finance.recordExternalDifference with expected = ledger sum, actual = balance, key = customer id + market date', async () => {
    const c = hf.customer();
    await hf.give(c.id, 800);
    await hf.app.kernel.jobs.runNow('wallet.balance-check');
    expect(hf.financeDiffs).toEqual([]);
    const fdb = hf.app.kernel.database.kysely;
    await sql`update wallet.accounts set available = available + 25 where customer_id = ${c.id}`.execute(fdb);
    await hf.app.kernel.jobs.runNow('wallet.balance-check');
    const date = dateInZone(hf.clock.now(), hf.app.kernel.config.market.timeZone);
    expect(hf.financeDiffs).toEqual([
      { check: 'store_credit', subject: `Store credit account ${c.id}`, description: 'Store credit balance $8.25 differs from its ledger sum $8.00', expected: USD(800), actual: USD(825), key: `${c.id}:${date}` },
    ]);
    expect(hf.audits.filter((a) => a.action === 'wallet.balance_check.difference')).toHaveLength(1);
    await sql`update wallet.accounts set available = available - 25 where customer_id = ${c.id}`.execute(fdb);
  });
});
