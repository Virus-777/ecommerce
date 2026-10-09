/**
 * The seller ledger replayed end to end: sales with seller- and platform-funded discounts (funding split from
 * promotions), a cancellation before dispatch (plan scenario 4), delivery and the hold window, a payout run,
 * a refund after payout that makes the balance negative and becomes an amount owed (scenario 6), and later
 * earnings that offset it. After every step the balances equal the sum of the ledger entries, and replaying
 * every event changes nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { signWebhook } from '../../../testing/app.js';
import { ADMIN, boot, expectLedgerMatches, SELLER, USD, type FakeOrder, type Kit } from './helpers.js';

const DAY = 86_400_000;
let k: Kit;
const S = newId();
const OTHER = newId();
const sellerTokenOf = () => k.sellerToken(S);
let orderA: FakeOrder;
let orderB: FakeOrder;
let run1: any;

async function verifiedDestination(k: Kit, sellerId: string, token: string) {
  const providerDestinationId = `dest_${sellerId.slice(0, 8)}`;
  await k.emit('sellers.payout_account.changed', { sellerId, changeId: newId(), providerDestinationId, label: 'Pacific Coast Credit Union •••• 6620', accountHolderName: 'Northwind LLC', accountType: 'business_checking', previousLabel: null, isInitial: true, requestedBy: { kind: 'seller', id: newId() } });
  const [a, b] = k.provider.testDepositsFor(providerDestinationId);
  const ok = await k.call('POST', `${SELLER}/payout-destination/confirm-deposits`, token, { amounts: [USD(a), USD(b)] });
  expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  expect(ok.body.destination.status).toBe('verified');
}

async function paid(k: Kit, providerPayoutId: string, event: 'paid' | 'failed' | 'returned' = 'paid', extra: Record<string, unknown> = {}) {
  const raw = JSON.stringify({ providerPayoutId, event, at: k.clock.now().toISOString(), ...extra });
  const res = await k.app.inject({ method: 'POST', url: '/webhooks/finance/payouts', headers: { 'content-type': 'application/json', 'x-event-id': newId(), ...signWebhook('dev-webhook-secret', raw, Math.floor(k.clock.now().getTime() / 1000)) }, payload: raw });
  await k.app.kernel.events.drain();
  return res.statusCode;
}

beforeAll(async () => {
  k = await boot();
  await verifiedDestination(k, S, sellerTokenOf());
});
afterAll(async () => {
  await k?.close();
});

describe('sales at order acceptance', () => {
  it('books each seller item as a pending lot: sale, seller-funded discount, shipping charged and the fee on the right basis', async () => {
    orderA = k.order(S, [
      { title: 'Pocket speaker', quantity: 2, price: 5900, sellerDiscount: 1180, platformDiscount: 500, shipping: 699 },
      { title: 'Cable kit', quantity: 1, price: 2400 },
    ]);
    await k.accept(orderA);
    const t = await expectLedgerMatches(k, S);
    // item 1: 11800 − 1180 + 699 = 11319 proceeds, fee 10% of 10620 (after the seller's discount; the platform-funded 500 is not deducted) = 1062
    // item 2: 2400 proceeds, fee 240
    expect(t).toEqual({ total: 11319 - 1062 + 2400 - 240, pending: 12417, held: 0, available: 0 });
    const ledger = await k.call('GET', `${SELLER}/ledger?types=marketplace_fee`, sellerTokenOf());
    expect(ledger.status).toBe(200);
    expect(ledger.body.items.map((e: any) => e.amount.amount).sort()).toEqual([-1062, -240]);
    expect(ledger.body.items.find((e: any) => e.amount.amount === -1062).description).toContain('10% of $106.20');
  });

  it('never posts the same sale twice (event redelivery)', async () => {
    await k.accept(orderA);
    const t = await expectLedgerMatches(k, S);
    expect(t.pending).toBe(12417);
  });

  it('keeps Official Store sales in company trading, never in a seller ledger', async () => {
    const official = k.order(null, [{ title: 'Marketly kettle', quantity: 1, price: 4500, shipping: 500 }]);
    await k.accept(official);
    const trading = await k.call('GET', `${ADMIN}/trading?from=${k.svc.core.today()}&to=${k.svc.core.today()}`, k.staff);
    expect(trading.status).toBe(200);
    expect(trading.body.productSales.amount).toBe(4500);
    expect(await k.svc.core.repo.count('ledger_entries', { ref_id: official.id })).toBe(0);
  });
});

describe('a cancellation before dispatch (scenario 4: only the selected item changes)', () => {
  it('reverses the cancelled item and returns its fee; the other item is untouched', async () => {
    const item = orderA.groups[0]!.items[1]!;
    const cancel = { orderId: orderA.id, ref: orderA.ref, groupId: orderA.groups[0]!.id, ownerType: 'seller', sellerId: S, itemId: item.id, offerId: newId(), stockItemId: newId(), quantity: 1, cancellationId: newId(), initiatedBy: 'customer', reasonCode: 'changed_mind', beforeDispatch: true, countsAgainstSeller: false, refund: { itemAmount: USD(2400), discountShare: USD(0), shippingRefund: USD(0), taxRefund: USD(0), total: USD(2400) }, paymentIntentId: newId(), trustReportId: null };
    await k.emit('orders.item.cancelled', cancel);
    await k.emit('orders.item.cancelled', cancel); // redelivered
    const t = await expectLedgerMatches(k, S);
    expect(t.pending).toBe(11319 - 1062);
    const lot = await k.svc.core.repo.findOne('earnings_lots', { order_item_id: item.id });
    expect(lot?.state).toBe('reversed');
    const charge = await k.svc.core.repo.findOne('fee_charges', { order_item_id: item.id });
    expect(charge).toMatchObject({ refunded_fee: 240, status: 'reversed' });
  });
});

describe('delivery, the hold window and the payout run', () => {
  it('makes earnings available only after delivery plus availableAfterDeliveryDays', async () => {
    await k.deliver(orderA, [orderA.groups[0]!.items[0]!.id]);
    await k.app.kernel.jobs.runNow('finance.release-pending');
    expect((await expectLedgerMatches(k, S)).available).toBe(0);
    k.clock.advance(8 * DAY);
    await k.app.kernel.jobs.runNow('finance.release-pending');
    const t = await expectLedgerMatches(k, S);
    expect(t).toMatchObject({ pending: 0, available: 10257 });
    const bal = await k.call('GET', `${SELLER}/balances`, sellerTokenOf());
    expect(bal.status).toBe(200);
    expect(bal.body).toMatchObject({ pending: USD(0), available: USD(10257), held: USD(0), negative: false });
    expect(bal.body.nextPayout.estimatedAmount).toEqual(USD(10257));
  });

  it('issues the statement at the cutoff and pays exactly what it reconciles to', async () => {
    const res = await k.call('POST', `${ADMIN}/payout-runs`, k.staff, { cutoffAt: k.clock.now().toISOString(), scheduledRelease: new Date(k.clock.now().getTime() + 3_600_000).toISOString() }, { 'idempotency-key': newId() });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    run1 = res.body;
    expect(run1).toMatchObject({ status: 'draft', total: USD(10257), payingNow: USD(10257) });
    expect(k.of('finance.statement.issued').some((e) => e.sellerId === S)).toBe(true);
    const again = await k.call('POST', `${ADMIN}/payout-runs`, k.staff, { cutoffAt: run1.cutoffAt, scheduledRelease: run1.scheduledRelease }, { 'idempotency-key': newId() });
    expect(again.status).toBe(409);
    expect(again.body.error).toMatchObject({ code: 'RUN_ALREADY_EXISTS', details: { runId: run1.id } });

    const statements = await k.call('GET', `${ADMIN}/payout-runs/${run1.id}/statements`, k.staff);
    expect(statements.body.items).toHaveLength(1);
    const st = await k.call('GET', `${SELLER}/statements/${statements.body.items[0].statementId}`, sellerTokenOf());
    expect(st.status).toBe(200);
    const sections = Object.fromEntries(st.body.sections.map((s: any) => [s.key, s.total.amount]));
    expect(sections).toEqual({ sales: 11800 - 1180 + 699 + 2400 - 2400, fees: -1062 - 240 + 240, refunds: 0, holds: 0, adjustments: 0, ads: 0 });
    expect(st.body.reconciliation).toMatchObject({ openingAvailable: USD(0), payout: USD(10257), closingAvailable: USD(0) });
    expect(st.body.sections.find((s: any) => s.key === 'fees').lines.find((l: any) => l.amount.amount === -1062).basis).toEqual(USD(10620));
    // another seller never sees it
    expect((await k.call('GET', `${SELLER}/statements/${st.body.id}`, k.sellerToken(OTHER))).status).toBe(404);
  });

  it('submits, approves and releases the run; the payout is paid only when the provider confirms', async () => {
    expect((await k.call('POST', `${ADMIN}/payout-runs/${run1.id}/submit`, k.staff)).body.status).toBe('pending_approval');
    const approved = await k.call('POST', `${ADMIN}/payout-runs/${run1.id}/approve`, k.staff, { confirmedReview: true, note: 'Checked' }, { 'idempotency-key': newId() });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.status).toBe('approved');
    expect(k.of('finance.payout_run.approved')).toHaveLength(1);
    const released = await k.call('POST', `${ADMIN}/payout-runs/${run1.id}/release`, k.staff, undefined, { 'idempotency-key': newId() });
    expect(released.body.status).toBe('releasing');
    expect(k.of('finance.payout.processing')).toHaveLength(1);
    expect((await expectLedgerMatches(k, S)).available).toBe(0);
    const payout = (await k.svc.core.repo.find('payouts', { run_id: run1.id }))[0]!;
    expect(payout.status).toBe('processing');
    expect(await paid(k, payout.provider_payout_id!)).toBe(204);
    expect(await paid(k, payout.provider_payout_id!)).toBe(204); // duplicate delivery
    const after = await k.call('GET', `${SELLER}/payouts/${payout.id}`, sellerTokenOf());
    expect(after.body).toMatchObject({ status: 'paid', amount: USD(10257) });
    expect(k.of('finance.payout.paid')).toHaveLength(1);
    expect((await k.call('GET', `${ADMIN}/payout-runs/${run1.id}`, k.staff)).body.status).toBe('completed');
    expect((await k.svc.core.repo.findOne('earnings_lots', { order_item_id: orderA.groups[0]!.items[0]!.id }))?.state).toBe('paid_out');
  });
});

describe('a refund after payout (scenario 6)', () => {
  it('deducts the refund (with the funding split and the fee returned pro rata) from later earnings', async () => {
    const item = orderA.groups[0]!.items[0]!;
    const refundRequestId = newId();
    await k.emit('returns.refund.approved', { refundRequestId, returnId: newId(), caseId: null, orderId: orderA.id, orderItemIds: [item.id], ownerType: 'seller', sellerId: S, source: 'return', trustReportId: null, total: USD(5560), breakdown: { itemAmount: USD(5900), discountShare: USD(340), shippingRefund: USD(0), returnShippingDeduction: USD(0), deductions: [], total: USD(5560), maxRefundable: USD(11319), destination: 'Visa •••• 4417', isEstimate: false }, fundedBy: 'shared', sellerShare: USD(5310), platformShare: USD(250), approvedBy: { kind: 'staff', id: newId() } });
    const sent = { refundId: newId(), ref: 'RT-261020-0533', orderId: orderA.id, origin: 'return', originId: refundRequestId, amount: USD(5560), items: [{ orderItemId: item.id, title: 'Pocket speaker', groupId: orderA.groups[0]!.id, sellerId: S, amount: USD(5560) }], destination: 'Visa •••• 4417', sentAt: k.clock.now().toISOString() };
    await k.emit('payments.refund.sent', sent);
    await k.emit('payments.refund.sent', sent); // redelivered
    const t = await expectLedgerMatches(k, S);
    expect(t.available).toBe(-5310 + 531);
    const entries = await k.call('GET', `${SELLER}/ledger?type=refunds`, sellerTokenOf());
    expect(entries.body.items[0]).toMatchObject({ type: 'refund_after_payout', amount: USD(-5310) });
    expect(entries.body.items[0].description).toContain('after payout');
    expect(k.of('finance.balance.negative')).toEqual([expect.objectContaining({ sellerId: S, available: USD(-4779) })]);
    const bal = await k.call('GET', `${SELLER}/balances`, sellerTokenOf());
    expect(bal.body).toMatchObject({ negative: true, available: USD(-4779) });
  });

  it('turns a negative balance not covered in time into an amount owed, offset by new earnings first', async () => {
    k.clock.advance(31 * DAY);
    await k.svc.negativeBalanceAge();
    await k.app.kernel.events.drain();
    await k.app.kernel.jobs.runNow('finance.negative-balance.age'); // once only
    expect(k.of('finance.amount_owed.created')).toEqual([expect.objectContaining({ sellerId: S, amount: USD(4779) })]);
    const owed = await k.call('GET', `${ADMIN}/amounts-owed?sellerId=${S}`, k.staff);
    expect(owed.body.items).toEqual([expect.objectContaining({ amount: USD(4779), remaining: USD(4779), status: 'open' })]);
    expect((await k.call('GET', `${SELLER}/balances`, sellerTokenOf())).body.amountOwed).toEqual(USD(4779));

    orderB = k.order(S, [{ title: 'Studio headphones', quantity: 1, price: 10000 }]);
    await k.accept(orderB);
    await k.deliver(orderB);
    k.clock.advance(8 * DAY);
    await k.app.kernel.jobs.runNow('finance.release-pending');
    const t = await expectLedgerMatches(k, S);
    expect(t.available).toBe(-4779 + 9000);
    const settled = await k.call('GET', `${ADMIN}/amounts-owed?sellerId=${S}`, k.staff);
    expect(settled.body.items[0]).toMatchObject({ remaining: USD(0), status: 'settled' });
  });

  it('shows the deduction with its payout reference on the next statement, which reconciles to the next payout', async () => {
    const res = await k.call('POST', `${ADMIN}/payout-runs`, k.staff, { cutoffAt: k.clock.now().toISOString(), scheduledRelease: new Date(k.clock.now().getTime() + 3_600_000).toISOString() }, { 'idempotency-key': newId() });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.total).toEqual(USD(4221));
    const rows = await k.call('GET', `${ADMIN}/payout-runs/${res.body.id}/statements`, k.staff);
    const st = await k.call('GET', `${SELLER}/statements/${rows.body.items[0].statementId}`, sellerTokenOf());
    const refunds = st.body.sections.find((s: any) => s.key === 'refunds');
    expect(refunds.total).toEqual(USD(-5310));
    expect(refunds.lines[0].description).toMatch(/after payout \(paid out in PO-/);
    expect(st.body.afterPayoutNotices[0]).toContain('RT-261020-0533');
    expect(st.body.reconciliation).toMatchObject({ openingAvailable: USD(0), payout: USD(4221), closingAvailable: USD(0) });
    const total = st.body.reconciliation.lines.reduce((s: number, l: any) => s + l.amount.amount, 0);
    expect(st.body.reconciliation.openingAvailable.amount + total - st.body.reconciliation.payout.amount).toBe(st.body.reconciliation.closingAvailable.amount);
    const list = await k.call('GET', `${SELLER}/statements`, sellerTokenOf());
    expect(list.body.items.filter((s: any) => s.status === 'issued')).toHaveLength(2);
    await expectLedgerMatches(k, S);
  });

  it('lists the seller ledger with a running balance and a statement reference (own seller only)', async () => {
    const page = await k.call('GET', `${SELLER}/ledger?limit=100`, sellerTokenOf());
    expect(page.status).toBe(200);
    const items = page.body.items as any[];
    expect(items[0].balanceAfter.amount).toBe((await expectLedgerMatches(k, S)).total);
    expect(items.some((e) => e.statementRef?.startsWith('ST-'))).toBe(true);
    const other = await k.call('GET', `${SELLER}/ledger`, k.sellerToken(OTHER));
    expect(other.body.items).toEqual([]);
    expect((await k.call('GET', `${SELLER}/payouts/${(await k.svc.core.repo.find('payouts', { seller_id: S }))[0]!.id}`, k.sellerToken(OTHER))).status).toBe(404);
  });
});
