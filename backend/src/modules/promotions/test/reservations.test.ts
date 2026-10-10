/**
 * Reservations as checkout uses them (bugs found by checkout): a released reservation is never handed out again, a
 * declined payment keeps the reservation for the retry window (checkout keeps it until holdUntil), and the
 * orders.order.placed fallback commit never overwrites checkout's explicit commit with its line → item map.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { boot, campaignInput, HOME, line, liveCampaign, SELLER_A, USD, type Kit } from './helpers.js';

let k: Kit;
beforeAll(async () => {
  k = await boot();
});
afterAll(() => k?.close());

const MIN = 60_000;
const cart = (lines: ReturnType<typeof line>[], codes: string[]) => k.svc.evaluateCart({ customerId: newId(), guestSessionId: null, region: 'CA', lines, codes, shipping: null });
const campaignRow = (id: string) => k.svc.core.repo.get('campaigns', id);
const rowsOf = (reservationId: string) => k.svc.core.repo.find('redemptions', { reservation_id: reservationId });
const declined = (checkoutSessionId: string) => k.emit('payments.payment.failed', { intentId: newId(), checkoutSessionId, orderId: null, customerId: null, contactEmail: 'g@example.com', declineCategory: 'card_declined', afterPendingCheck: false, at: k.clock.now().toISOString() });
const placed = (orderId: string, checkoutSessionId: string) =>
  k.emit('orders.order.placed', { orderId, ref: 'MK-261010-00001', checkoutSessionId, customerId: null, guestEmail: 'g@example.com', paymentIntentId: newId(), paymentState: 'accepted', total: USD(9000), couponCodes: [], groups: [], placedAt: k.clock.now().toISOString(), attemptNo: 1, contactName: 'Guest Shopper' });

async function coupon(code: string) {
  const o = k.offer({ sellerId: SELLER_A, categoryId: HOME, price: USD(10000) });
  const camp = await liveCampaign(k, campaignInput(k.clock, { code, discount: { kind: 'percent_coupon', percentOffBps: 1000 }, limits: { budget: USD(100_000) } }));
  return { o, camp, ev: await cart([line(o, 1)], [code]) };
}

describe('a released reservation is never reused', () => {
  it('reserves afresh for the same evaluation and key, with a new reservation id', async () => {
    const { o, camp, ev } = await coupon('AGAIN10');
    const first = await k.svc.reserveRedemption(ev.evaluationId, 'checkout-again');
    await k.svc.releaseRedemption(first.reservationId);
    expect(await campaignRow(camp.id)).toMatchObject({ budget_used: 0, usage_count: 0 });

    const second = await k.svc.reserveRedemption(ev.evaluationId, 'checkout-again');
    expect(second.reservationId).not.toBe(first.reservationId);
    expect(await campaignRow(camp.id)).toMatchObject({ budget_used: 1000, usage_count: 1 });
    expect((await rowsOf(first.reservationId)).map((r) => r.state)).toEqual(['expired']);
    expect((await rowsOf(second.reservationId)).map((r) => r.state)).toEqual(['reserved']);
    // the live one answers again; the released one cannot be committed
    expect((await k.svc.reserveRedemption(ev.evaluationId, 'checkout-again')).reservationId).toBe(second.reservationId);
    await expect(k.svc.commitRedemption(first.reservationId, newId(), {})).rejects.toMatchObject({ code: 'CONFLICT' });
    const orderId = newId();
    await k.svc.commitRedemption(second.reservationId, orderId, { [line(o).lineId]: newId() });
    expect((await rowsOf(second.reservationId))[0]).toMatchObject({ state: 'committed', order_id: orderId });
    expect(await campaignRow(camp.id)).toMatchObject({ budget_used: 1000, usage_count: 1 });

    // a committed reservation is not handed out again either (a retry after the order was cancelled reserves afresh)
    const third = await k.svc.reserveRedemption(ev.evaluationId, 'checkout-again');
    expect([first.reservationId, second.reservationId]).not.toContain(third.reservationId);
  });
});

describe('a declined payment keeps the reservation for the retry window', () => {
  it('decline → retry within the hold uses the same reservation; it outlives its first expiry', async () => {
    const { o, camp, ev } = await coupon('RETRY10');
    const session = newId();
    const res = await k.svc.reserveRedemption(ev.evaluationId, session);
    k.clock.advance(20 * MIN);
    await declined(session); // checkout: payment_failed, held until now + the retry window
    expect(await campaignRow(camp.id)).toMatchObject({ budget_used: 1000, usage_count: 1 });

    k.clock.advance(15 * MIN); // past the reservation's first expiry (35 min after it was made), inside the retry window
    await k.app.kernel.jobs.runNow('promotions.release-expired-reservations');
    expect((await rowsOf(res.reservationId)).map((r) => r.state)).toEqual(['reserved']);

    const retry = await k.svc.reserveRedemption(ev.evaluationId, session); // the retry reserves the same quote again
    expect(retry.reservationId).toBe(res.reservationId);
    expect(await campaignRow(camp.id)).toMatchObject({ budget_used: 1000, usage_count: 1 });
    const orderId = newId();
    const itemId = newId();
    await k.svc.commitRedemption(retry.reservationId, orderId, { [line(o).lineId]: itemId });
    expect((await rowsOf(res.reservationId))[0]).toMatchObject({ state: 'committed', order_id: orderId });
    expect((await k.svc.fundingSplitFor(itemId)).platformFunded).toEqual(USD(1000));
    k.clock.set(new Date());
  });

  it('a decline that is never retried gives the discount back when the window ends', async () => {
    const { camp, ev } = await coupon('LAPSE10');
    const session = newId();
    const res = await k.svc.reserveRedemption(ev.evaluationId, session);
    await declined(session);
    k.clock.advance(31 * MIN);
    await k.app.kernel.jobs.runNow('promotions.release-expired-reservations');
    expect((await rowsOf(res.reservationId)).map((r) => r.state)).toEqual(['expired']);
    expect(await campaignRow(camp.id)).toMatchObject({ budget_used: 0, usage_count: 0 });
    k.clock.set(new Date());
  });
});

describe('commit is idempotent and checkout’s explicit commit wins', () => {
  it('the orders.order.placed fallback after checkout committed changes nothing', async () => {
    const { o, ev } = await coupon('EXPL10');
    const session = newId();
    const res = await k.svc.reserveRedemption(ev.evaluationId, session);
    const orderId = newId();
    const itemId = newId();
    await k.svc.commitRedemption(res.reservationId, orderId, { [line(o).lineId]: itemId });
    await placed(orderId, session);
    const lines = await k.svc.core.repo.find('redemption_lines', { redemption_id: (await rowsOf(res.reservationId))[0]!.id });
    expect(lines.map((l) => l.order_item_id)).toEqual([itemId]);
    expect(k.of('promotions.coupon.redeemed').filter((e) => e.orderId === orderId)).toHaveLength(1);
  });

  it('when the fallback commits first, the explicit commit still binds its lines and redeems once', async () => {
    const { o, camp, ev } = await coupon('RACE10');
    const session = newId();
    const res = await k.svc.reserveRedemption(ev.evaluationId, session);
    const orderId = newId();
    await placed(orderId, session); // orders not running here: committed without a line map
    const [row] = await rowsOf(res.reservationId);
    expect(row).toMatchObject({ state: 'committed', order_id: orderId });
    expect((await k.svc.core.repo.find('redemption_lines', { redemption_id: row!.id }))[0]!.order_item_id).toBeNull();

    const itemId = newId();
    const reds = await k.svc.commitRedemption(res.reservationId, orderId, { [line(o).lineId]: itemId });
    await k.app.kernel.events.drain();
    expect(reds).toEqual([expect.objectContaining({ state: 'committed', orderId })]);
    expect((await k.svc.core.repo.find('redemption_lines', { redemption_id: row!.id }))[0]!.order_item_id).toBe(itemId);
    expect(k.of('promotions.coupon.redeemed').filter((e) => e.orderId === orderId)).toHaveLength(1);
    expect(await campaignRow(camp.id)).toMatchObject({ budget_used: 1000, usage_count: 1 });

    // a fallback commit never binds over the lines checkout bound
    await k.svc.checkout.commit(res.reservationId, orderId, { [line(o).lineId]: newId() }, undefined, { fallback: { inboxKey: `order-placed:${orderId}:${res.reservationId}` } });
    expect((await k.svc.core.repo.find('redemption_lines', { redemption_id: row!.id }))[0]!.order_item_id).toBe(itemId);
  });
});
