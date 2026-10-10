import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { ADMIN, boot, campaignInput, HOME, line, liveCampaign, SELLER_A, SELLER_B, USD, type Kit } from './helpers.js';

let k: Kit;
beforeAll(async () => {
  k = await boot();
});
afterAll(() => k?.close());

const cart = (lines: ReturnType<typeof line>[], o: { codes?: string[]; customerId?: string | null; shipping?: Record<string, { amount: number; currency: string }> } = {}) =>
  k.svc.evaluateCart({ customerId: o.customerId === undefined ? newId() : o.customerId, guestSessionId: o.customerId === null ? newId() : null, region: 'CA', lines, codes: o.codes ?? [], shipping: o.shipping ?? null });

const campaignRow = (id: string) => k.svc.core.repo.get('campaigns', id);

const cancelledEvent = (orderId: string, itemId: string, offerId: string, quantity: number, beforeDispatch = true) => ({
  orderId,
  ref: 'MK-261009-00001',
  groupId: newId(),
  ownerType: 'seller',
  sellerId: SELLER_A,
  itemId,
  offerId,
  stockItemId: newId(),
  quantity,
  cancellationId: newId(),
  initiatedBy: 'customer',
  reasonCode: 'changed_mind',
  beforeDispatch,
  countsAgainstSeller: false,
  refund: { itemAmount: USD(0), discountShare: USD(0), shippingRefund: USD(0), taxRefund: USD(0), total: USD(0) },
  paymentIntentId: newId(),
});

describe('cart evaluation and redemption', () => {
  it('applies a code, explains rejections, and reserves → commits with the funding split per order item', async () => {
    const o1 = k.offer({ sellerId: SELLER_A, categoryId: HOME, price: USD(6000) });
    const o2 = k.offer({ sellerId: SELLER_A, categoryId: HOME, price: USD(4000) });
    const camp = await liveCampaign(k, campaignInput(k.clock, { code: 'HOME20', limits: { budget: USD(100_000), perCustomer: 1 } }));
    const customerId = newId();
    const ev = await cart([line(o1, 1), line(o2, 2)], { codes: ['home20', 'NOPE'], customerId });
    expect(ev.applied).toEqual([expect.objectContaining({ campaignId: camp.id, code: 'HOME20', amount: USD(2800), source: 'code' })]);
    expect(ev.rejected).toEqual([expect.objectContaining({ code: 'NOPE', reason: 'not_found' })]);
    expect(ev.lines.map((l) => l.lineDiscount.amount)).toEqual([1200, 1600]);
    expect(ev.totals).toEqual({ total: USD(2800), platform: USD(2800), seller: USD(0) });

    const res = await k.svc.reserveRedemption(ev.evaluationId, 'checkout-1');
    const again = await k.svc.reserveRedemption(ev.evaluationId, 'checkout-1');
    expect(again.reservationId).toBe(res.reservationId);
    expect((await campaignRow(camp.id))).toMatchObject({ budget_used: 2800, usage_count: 1 });

    const orderId = newId();
    const items = { [line(o1).lineId]: newId(), [line(o2).lineId]: newId() };
    const reds = await k.svc.commitRedemption(res.reservationId, orderId, items);
    await k.app.kernel.events.drain();
    expect(reds).toEqual([expect.objectContaining({ campaignId: camp.id, state: 'committed', orderId, code: 'HOME20', items: 3 })]);
    expect(k.of('promotions.coupon.redeemed').at(-1)).toMatchObject({ campaignId: camp.id, orderId, amount: USD(2800), platformPart: USD(2800), sellerPart: USD(0) });
    expect(await k.svc.commitRedemption(res.reservationId, orderId, items)).toHaveLength(1);

    const split = await k.svc.fundingSplitFor(items[line(o2).lineId]!);
    expect(split).toMatchObject({ allocations: [{ campaignId: camp.id, code: 'HOME20', amount: USD(1600), platformPart: USD(1600), sellerPart: USD(0) }], platformFunded: USD(1600), sellerFunded: USD(0) });
    const share = await k.svc.refundShare(items[line(o2).lineId]!, 1);
    expect(share).toMatchObject({ couponShare: USD(800), platformPart: USD(800), sellerPart: USD(0) });

    // the same customer can't use it twice
    const second = await cart([line(o1, 1)], { codes: ['HOME20'], customerId });
    expect(second.rejected[0]).toMatchObject({ reason: 'usage_limit' });
    expect(second.changes).toEqual([]);

    // cancelling one unit of the second item before dispatch reverses its share and gives the budget back
    await k.svc.checkout.onItemCancelled(cancelledEvent(orderId, items[line(o2).lineId]!, o2.id, 1) as any);
    await k.app.kernel.events.drain();
    expect(k.of('promotions.redemption.reversed').at(-1)).toMatchObject({ orderItemId: items[line(o2).lineId], amount: USD(800), platformPart: USD(800) });
    expect(await campaignRow(camp.id)).toMatchObject({ budget_used: 2000, usage_count: 1 });
    const list = await k.call('GET', `${ADMIN}/campaigns/${camp.id}/redemptions`, k.staff);
    expect(list.body.items[0]).toMatchObject({ state: 'partially_reversed', reversed: USD(800) });
  });

  it('applies seller markdowns to the unit price and splits shared funding by the consented share', async () => {
    const o = k.offer({ sellerId: SELLER_B, categoryId: HOME, price: USD(10000) });
    const md = await k.call('POST', '/api/seller/promotions/discounts', (await import('../../../testing/app.js')).callers.seller({ sellerId: SELLER_B }), {
      name: 'Audio week',
      kind: 'markdown',
      discount: { kind: 'markdown', percentOffBps: 1000 },
      offerIds: [o.id],
      startsAt: new Date(Date.now() - 60_000).toISOString(),
      endsAt: new Date(Date.now() + 86_400_000).toISOString(),
      combinesWithPlatformCoupons: true,
    });
    await k.call('POST', `/api/seller/promotions/discounts/${md.body.campaign.id}/schedule`, (await import('../../../testing/app.js')).callers.seller({ sellerId: SELLER_B }));
    const ev = await cart([line(o, 1)]);
    expect(ev.lines[0]).toMatchObject({ regularUnitPrice: USD(10000), unitPrice: USD(9000), lineDiscount: USD(1000), allocations: [{ sellerPart: USD(1000), platformPart: USD(0) }] });
    expect(ev.applied[0]).toMatchObject({ source: 'automatic', amount: USD(1000) });
    const prices = await k.svc.priceOffers([o.id], {});
    expect(prices[0]!.price).toEqual(ev.lines[0]!.unitPrice); // the same price everywhere
  });

  it('gives free shipping per package when the minimum spend is met', async () => {
    const o = k.offer({ sellerId: SELLER_A, categoryId: HOME, price: USD(8000) });
    await liveCampaign(k, campaignInput(k.clock, { name: 'Free shipping over $75', autoApply: true, discount: { kind: 'free_shipping', minSpend: USD(7500), minSpendScope: 'seller_package' }, scope: { mode: 'sitewide', include: [], exclude: [] }, stacking: { withSellerMarkdowns: true, withOtherCoupons: true, withFreeShipping: true, withFlashSalePrices: true } }));
    const pkg = line(o).packageId;
    const ev = await cart([line(o, 1)], { shipping: { [pkg]: USD(799), other: USD(500) } });
    expect(ev.packages[0]).toMatchObject({ packageId: pkg, freeShipping: true, shippingDiscount: USD(799), allocation: { platformPart: USD(799) } });
    const small = k.offer({ sellerId: SELLER_B, categoryId: HOME, price: USD(1000) });
    const ev2 = await cart([line(small, 1)], { shipping: { [line(small).packageId]: USD(799) } });
    expect(ev2.packages[0]).toMatchObject({ freeShipping: false, shippingDiscount: USD(0) });
  });

  it('keeps holds through a payment failure until checkout releases them, commits on orders.order.placed and expires stale reservations', async () => {
    const o = k.offer({ sellerId: SELLER_A, categoryId: HOME, price: USD(10000) });
    const camp = await liveCampaign(k, campaignInput(k.clock, { code: 'REL10', discount: { kind: 'percent_coupon', percentOffBps: 1000 }, limits: { budget: USD(100_000) } }));
    const session = newId();
    const ev = await cart([line(o, 1)], { codes: ['REL10'] });
    const res = await k.svc.reserveRedemption(ev.evaluationId, session);
    expect((await campaignRow(camp.id))!.budget_used).toBe(1000);
    await k.emit('payments.payment.failed', { intentId: newId(), checkoutSessionId: session, orderId: null, declineCategory: 'card_declined', afterPendingCheck: false, at: new Date().toISOString() });
    expect(await campaignRow(camp.id)).toMatchObject({ budget_used: 1000, usage_count: 1 }); // kept for the retry window
    await k.svc.releaseRedemption(res.reservationId); // checkout: the session was abandoned
    expect(await campaignRow(camp.id)).toMatchObject({ budget_used: 0, usage_count: 0 });

    const session2 = newId();
    const ev2 = await cart([line(o, 1)], { codes: ['REL10'] });
    const res2 = await k.svc.reserveRedemption(ev2.evaluationId, session2);
    const orderId = newId();
    await k.emit('orders.order.placed', { orderId, ref: 'MK-261009-00002', checkoutSessionId: session2, customerId: null, guestEmail: 'g@example.com', paymentIntentId: newId(), paymentState: 'accepted', total: USD(9000), couponCodes: ['REL10'], groups: [], placedAt: new Date().toISOString(), attemptNo: 1, contactName: 'Guest Shopper' });
    const rows = await k.svc.core.repo.find('redemptions', { reservation_id: res2.reservationId });
    expect(rows[0]).toMatchObject({ state: 'committed', order_id: orderId });

    const ev3 = await cart([line(o, 1)], { codes: ['REL10'] });
    const res3 = await k.svc.reserveRedemption(ev3.evaluationId, newId());
    k.clock.advance(31 * 60_000);
    await k.app.kernel.jobs.runNow('promotions.release-expired-reservations');
    expect((await k.svc.core.repo.find('redemptions', { reservation_id: res3.reservationId }))[0]!.state).toBe('expired');
    await expect(k.svc.commitRedemption(res3.reservationId, newId(), {})).rejects.toMatchObject({ code: 'CONFLICT' });
    k.clock.set(new Date());
    expect((await campaignRow(camp.id))!.budget_used).toBe(1000);
  });
});

describe('concurrency: caps hold under parallel checkouts', () => {
  it('never exceeds the usage cap', async () => {
    const o = k.offer({ sellerId: SELLER_A, categoryId: HOME, price: USD(10000) });
    const camp = await liveCampaign(k, campaignInput(k.clock, { code: 'CAP3', discount: { kind: 'fixed_coupon', amountOff: USD(500) }, limits: { usageCap: 3 } }));
    const evs = await Promise.all(Array.from({ length: 10 }, () => cart([line(o, 1)], { codes: ['CAP3'] })));
    expect(evs.every((e) => e.applied.some((a) => a.code === 'CAP3'))).toBe(true);
    const results = await Promise.allSettled(evs.map((e, i) => k.svc.reserveRedemption(e.evaluationId, `cap-${i}`)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(refused).toHaveLength(7);
    expect(refused.every((r) => r.reason.code === 'USAGE_LIMIT_REACHED' && r.reason.status === 409)).toBe(true);
    expect(await campaignRow(camp.id)).toMatchObject({ usage_count: 3, budget_used: 1500 });
  });

  it('never exceeds the budget', async () => {
    const o = k.offer({ sellerId: SELLER_A, categoryId: HOME, price: USD(10000) });
    const camp = await liveCampaign(k, campaignInput(k.clock, { code: 'BUDGET20', limits: { budget: USD(4500) } }));
    const evs = await Promise.all(Array.from({ length: 8 }, () => cart([line(o, 1)], { codes: ['BUDGET20'] })));
    const results = await Promise.allSettled(evs.map((e, i) => k.svc.reserveRedemption(e.evaluationId, `budget-${i}`)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    expect(results.filter((r) => r.status === 'rejected').every((r) => (r as PromiseRejectedResult).reason.code === 'BUDGET_EXHAUSTED')).toBe(true);
    const row = await campaignRow(camp.id);
    expect(row!.budget_used).toBe(4000);
    expect(row!.budget_used).toBeLessThanOrEqual(row!.budget_amount!);
    expect(k.of('promotions.budget.threshold_reached').filter((e) => e.campaignId === camp.id)).toHaveLength(0); // 4000 of 4500 is under 90%
  });

  it('allows one use per customer even when the same customer checks out twice at once', async () => {
    const o = k.offer({ sellerId: SELLER_A, categoryId: HOME, price: USD(10000) });
    const camp = await liveCampaign(k, campaignInput(k.clock, { code: 'ONCE', limits: { perCustomer: 1 } }));
    const customerId = newId();
    const evs = await Promise.all(Array.from({ length: 5 }, () => cart([line(o, 1)], { codes: ['ONCE'], customerId })));
    const results = await Promise.allSettled(evs.map((e, i) => k.svc.reserveRedemption(e.evaluationId, `once-${i}`)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await campaignRow(camp.id)).toMatchObject({ usage_count: 1 });
  });

  it('never sells more flash deal stock than allocated; sold out publishes and the regular offer stays', async () => {
    const o = k.offer({ sellerId: null, ownerType: 'official', categoryId: HOME, price: USD(20000), stock: 100 });
    const input = campaignInput(k.clock, { name: 'Lightning deals', discount: { kind: 'flash_sale' }, scope: { mode: 'offers', include: [{ kind: 'offer', id: o.id }], exclude: [] } });
    const created = await k.call('POST', `${ADMIN}/campaigns`, k.staff, input);
    const id = created.body.id;
    const put = await k.call('PUT', `${ADMIN}/campaigns/${id}/flash-items`, k.staff, { items: [{ offerId: o.id, dealPrice: USD(12000), dealStock: 2, purchaseLimit: 1 }] });
    expect(put.status).toBe(200);
    expect(put.body[0]).toMatchObject({ dealStock: 2, claimed: 0, percentOffBps: 4000, state: 'active' });
    const tooMuch = await k.call('PUT', `${ADMIN}/campaigns/${id}/flash-items`, k.staff, { items: [{ offerId: o.id, dealPrice: USD(12000), dealStock: 500, purchaseLimit: 1 }] });
    expect(tooMuch.body.error.code).toBe('INSUFFICIENT_STOCK');
    for (const step of ['submit', 'confirm-funding', 'schedule']) expect((await k.call('POST', `${ADMIN}/campaigns/${id}/${step}`, k.staff, {})).status).toBe(200);

    const evs = await Promise.all(Array.from({ length: 5 }, () => cart([line(o, 1)])));
    expect(evs.every((e) => e.lines[0]!.unitPrice.amount === 12000)).toBe(true);
    const results = await Promise.allSettled(evs.map((e, i) => k.svc.reserveRedemption(e.evaluationId, `flash-${i}`)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    expect(results.filter((r) => r.status === 'rejected').every((r) => (r as PromiseRejectedResult).reason.code === 'DEAL_SOLD_OUT')).toBe(true);
    await k.app.kernel.events.drain();
    expect(k.of('promotions.flash_item.sold_out').at(-1)).toMatchObject({ campaignId: id, offerId: o.id });
    const sale = await k.call('GET', `/api/store/promotions/flash-sales/${id}`, (await import('../../../testing/app.js')).callers.visitor());
    expect(sale.body.items[0]).toMatchObject({ state: 'sold_out', claimedPct: 100, regularOffer: { price: USD(20000) } });
    // after deal stock ends the offer is priced at its regular price again
    const after = await cart([line(o, 1)]);
    expect(after.lines[0]!.unitPrice).toEqual(USD(20000));
    // purchase limit: one unit per customer at the deal price
    const many = await cart([line(o, 3)]);
    expect(many.lines[0]!.unitPrice).toEqual(USD(20000));
  });
});

describe('refunds after delivery', () => {
  it('reverses the coupon share of refunded items without restoring budget (refundRestoresBudget off)', async () => {
    const o = k.offer({ sellerId: SELLER_A, categoryId: HOME, price: USD(5000) });
    const camp = await liveCampaign(k, campaignInput(k.clock, { code: 'RET10', discount: { kind: 'fixed_coupon', amountOff: USD(1000) } }));
    const ev = await cart([line(o, 2)], { codes: ['RET10'] });
    const res = await k.svc.reserveRedemption(ev.evaluationId, newId());
    const itemId = newId();
    const orderId = newId();
    await k.svc.commitRedemption(res.reservationId, orderId, { [line(o).lineId]: itemId });
    const before = (await campaignRow(camp.id))!.budget_used;
    const share = await k.svc.refundShare(itemId, 1);
    expect(share.couponShare).toEqual(USD(500));
    const breakdown = { itemAmount: USD(5000), discountShare: USD(500), shippingRefund: USD(0), returnShippingDeduction: USD(0), deductions: [], total: USD(4500), maxRefundable: USD(9000), destination: 'Visa', isEstimate: false };
    const event = { refundRequestId: newId(), returnId: newId(), caseId: null, orderId, orderItemIds: [itemId], items: [{ orderItemId: itemId, quantity: 1 }], ownerType: 'seller', sellerId: SELLER_A, source: 'return', total: USD(4500), breakdown, fundedBy: 'seller', approvedBy: { kind: 'staff', id: newId() } };
    await k.emit('returns.refund.approved', event);
    await k.emit('returns.refund.approved', event); // the same event twice: once
    expect(k.of('promotions.redemption.reversed').filter((e) => e.orderItemId === itemId)).toHaveLength(1);
    expect((await campaignRow(camp.id))!.budget_used).toBe(before);
    expect((await k.svc.refundShare(itemId, 1)).couponShare).toEqual(USD(500));
    await k.app.kernel.jobs.runNow('promotions.results-rollup');
    const results = await k.call('GET', `${ADMIN}/campaigns/${camp.id}/results`, k.staff);
    expect(results.body.result).toMatchObject({ redemptions: 1, orders: 1, sales: USD(9000), discountCost: { total: USD(500), platform: USD(500) } });
    expect(results.body.bySeller[0]).toMatchObject({ sellerId: SELLER_A, sellerName: 'Casa Verde Home' });
  });
});
