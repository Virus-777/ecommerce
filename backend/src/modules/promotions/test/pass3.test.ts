/**
 * Gap pass 3: Official Store seller ids on redemption lines, autoApply as the authority, guest limits by
 * contact email, order item splits, refunds by item quantity, one-campaign live deals, automatic discounts
 * on offer prices and the store-wide return rate left empty.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { OFFICIAL_STORE_ID } from '../../../spec/common.js';
import { ADMIN, boot, campaignInput, HOME, line, liveCampaign, SELLER_A, USD, type Kit } from './helpers.js';

let k: Kit;
beforeAll(async () => {
  k = await boot();
});
afterAll(() => k?.close());

const guestCart = (lines: ReturnType<typeof line>[], codes: string[], contactEmail: string | null, guestSessionId = newId()) =>
  k.svc.evaluateCart({ customerId: null, guestSessionId, contactEmail, region: 'CA', lines, codes, shipping: null });
const customerCart = (lines: ReturnType<typeof line>[], codes: string[] = [], customerId = newId()) => k.svc.evaluateCart({ customerId, guestSessionId: null, region: 'CA', lines, codes, shipping: null });

describe('Official Store lines', () => {
  it('reserves and commits a discount on an Official Store line sent with an empty seller id (OFFICIAL_STORE_ID on redemption_lines)', async () => {
    const o = k.offer({ ownerType: 'official', sellerId: null, categoryId: HOME, price: USD(5000) });
    await liveCampaign(k, campaignInput(k.clock, { code: 'OFFICIAL10', discount: { kind: 'fixed_coupon', amountOff: USD(1000) } }));
    // the bug: cart and checkout sent sellerId '' for Official Store lines, a 500 on the uuid column at reserve
    const ev = await customerCart([{ ...line(o, 1), sellerId: '' }], ['OFFICIAL10']);
    expect(ev.applied).toEqual([expect.objectContaining({ code: 'OFFICIAL10', amount: USD(1000) })]);
    expect(ev.packages[0]!.sellerId).toBe(OFFICIAL_STORE_ID);
    const res = await k.svc.reserveRedemption(ev.evaluationId, newId());
    const rows = await k.svc.core.repo.find('redemptions', { reservation_id: res.reservationId });
    const lines = await k.svc.core.repo.find('redemption_lines', { redemption_id: rows.map((r) => r.id) });
    expect(lines).toEqual([expect.objectContaining({ seller_id: OFFICIAL_STORE_ID, amount: 1000 })]);
    const itemId = newId();
    await k.svc.commitRedemption(res.reservationId, newId(), { [line(o).lineId]: itemId });
    expect((await k.svc.fundingSplitFor(itemId)).platformFunded).toEqual(USD(1000));
  });

  it('refuses a marketplace line without a seller id (VALIDATION_FAILED) instead of storing it', async () => {
    const o = k.offer({ sellerId: SELLER_A, categoryId: HOME, price: USD(5000) });
    await expect(customerCart([{ ...line(o, 1), sellerId: '' }])).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(customerCart([{ ...line(o, 1), sellerId: null as never }])).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('accepts lines without a category (catalog off): category-scoped campaigns simply do not match', async () => {
    const o = k.offer({ sellerId: SELLER_A, categoryId: HOME, price: USD(5000) });
    await liveCampaign(k, campaignInput(k.clock, { code: 'HOMEONLY', discount: { kind: 'fixed_coupon', amountOff: USD(500) } }));
    const ev = await customerCart([{ ...line(o, 1), categoryId: null as never }], ['HOMEONLY']);
    expect(ev.rejected).toEqual([expect.objectContaining({ code: 'HOMEONLY', reason: 'no_eligible_items' })]);
  });
});

describe('autoApply is authoritative (decision P1)', () => {
  it('applies an autoApply campaign without its code, and a campaign without code or autoApply only when clipped', async () => {
    const o = k.offer({ sellerId: SELLER_A, categoryId: HOME, price: USD(10000) });
    const auto = await liveCampaign(k, campaignInput(k.clock, { name: 'Auto with code', code: 'AUTO5', autoApply: true, discount: { kind: 'fixed_coupon', amountOff: USD(500) }, stacking: { withSellerMarkdowns: true, withOtherCoupons: true, withFreeShipping: true, withFlashSalePrices: false } }));
    const clipOnly = await liveCampaign(k, campaignInput(k.clock, { name: 'Clip only', discount: { kind: 'fixed_coupon', amountOff: USD(700) }, stacking: { withSellerMarkdowns: true, withOtherCoupons: true, withFreeShipping: true, withFlashSalePrices: false } }));
    expect(clipOnly.autoApply).toBe(false);
    const ev = await customerCart([line(o, 1)]);
    expect(ev.applied.map((a) => a.campaignId)).toEqual([auto.id]);
    expect(ev.applied[0]).toMatchObject({ source: 'automatic', amount: USD(500) });
  });
});

describe('guests: limits and new-customer checks by contact email', () => {
  it('counts a one-per-customer coupon against the contact email, not the guest session', async () => {
    const o = k.offer({ sellerId: SELLER_A, categoryId: HOME, price: USD(10000) });
    await liveCampaign(k, campaignInput(k.clock, { code: 'ONCEPP', discount: { kind: 'fixed_coupon', amountOff: USD(1000) }, limits: { budget: USD(100_000), perCustomer: 1 } }));
    const first = await guestCart([line(o, 1)], ['ONCEPP'], 'Ana@Example.com');
    expect(first.applied).toHaveLength(1);
    await k.svc.reserveRedemption(first.evaluationId, newId());
    // a new guest session with the same email (any case) is the same person
    const again = await guestCart([line(o, 1)], ['ONCEPP'], ' ana@example.com ');
    expect(again.rejected).toEqual([expect.objectContaining({ code: 'ONCEPP', reason: 'usage_limit' })]);
    const other = await guestCart([line(o, 1)], ['ONCEPP'], 'ben@example.com');
    expect(other.applied).toHaveLength(1);
  });

  it('a guest without a contact email is not eligible for new-customer offers', async () => {
    const o = k.offer({ sellerId: SELLER_A, categoryId: HOME, price: USD(10000) });
    await liveCampaign(k, campaignInput(k.clock, { code: 'WELCOME', eligibility: { audience: 'new_customers' }, discount: { kind: 'fixed_coupon', amountOff: USD(1000) } }));
    const anon = await guestCart([line(o, 1)], ['WELCOME'], null);
    expect(anon.rejected).toEqual([expect.objectContaining({ code: 'WELCOME', reason: 'customer_not_eligible' })]);
    // with an email and orders off, nothing proves an earlier order: eligible
    const withEmail = await guestCart([line(o, 1)], ['WELCOME'], 'new@example.com');
    expect(withEmail.applied).toHaveLength(1);
  });
});

describe('order item splits and refunds', () => {
  async function committed(qty: number) {
    const o = k.offer({ sellerId: SELLER_A, categoryId: HOME, price: USD(3000) });
    const code = `SPLIT${Math.floor(Math.random() * 1e6)}`;
    await liveCampaign(k, campaignInput(k.clock, { code, discount: { kind: 'fixed_coupon', amountOff: USD(900) } }));
    const ev = await customerCart([line(o, qty)], [code]);
    const res = await k.svc.reserveRedemption(ev.evaluationId, newId());
    const itemId = newId();
    const orderId = newId();
    await k.svc.commitRedemption(res.reservationId, orderId, { [line(o).lineId]: itemId });
    return { o, itemId, orderId };
  }

  it('orders.item.split moves the split-off units’ share to the new item, once', async () => {
    const { o, itemId, orderId } = await committed(3);
    const newItemId = newId();
    const split = { orderId, groupId: newId(), itemId, newItemId, rootItemId: itemId, offerId: o.id, stockItemId: o.stockItemId, quantity: 1, remainingQuantity: 2, reason: 'cancellation' as const, at: k.clock.now().toISOString() };
    await k.emit('orders.item.split', split);
    await k.emit('orders.item.split', split); // redelivered: nothing more moves
    expect((await k.svc.fundingSplitFor(newItemId)).platformFunded).toEqual(USD(300));
    expect((await k.svc.fundingSplitFor(itemId)).platformFunded).toEqual(USD(600));
    expect((await k.svc.refundShare(newItemId, 1)).couponShare).toEqual(USD(300));
    expect((await k.svc.refundShare(itemId, 2)).couponShare).toEqual(USD(600));
  });

  it('returns.refund.approved reverses each item by its refunded quantity; a refund without items reverses nothing', async () => {
    const { itemId, orderId } = await committed(3);
    const breakdown = { itemAmount: USD(3000), discountShare: USD(300), shippingRefund: USD(0), returnShippingDeduction: USD(0), deductions: [], total: USD(2700), maxRefundable: USD(8100), destination: 'Visa', isEstimate: false };
    const base = { returnId: null, caseId: null, orderId, orderItemIds: [itemId], ownerType: 'seller', sellerId: SELLER_A, source: 'return', total: USD(2700), breakdown, fundedBy: 'seller', approvedBy: { kind: 'staff', id: newId() } };
    await k.emit('returns.refund.approved', { ...base, refundRequestId: newId(), items: [] });
    expect(k.of('promotions.redemption.reversed').filter((e) => e.orderItemId === itemId)).toHaveLength(0);
    await k.emit('returns.refund.approved', { ...base, refundRequestId: newId(), items: [{ orderItemId: itemId, quantity: 2 }] });
    expect(k.of('promotions.redemption.reversed').filter((e) => e.orderItemId === itemId)).toEqual([expect.objectContaining({ amount: USD(600) })]);
    expect((await k.svc.refundShare(itemId, 3)).couponShare).toEqual(USD(300));
  });
});

describe('storefront', () => {
  it('liveDeals({ campaignId }) answers only that flash sale', async () => {
    const o = k.offer({ ownerType: 'official', sellerId: null, categoryId: HOME, price: USD(8000), stock: 50 });
    const created = await k.call('POST', `${ADMIN}/campaigns`, k.staff, campaignInput(k.clock, { name: 'One deal', discount: { kind: 'flash_sale' }, scope: { mode: 'offers', include: [{ kind: 'offer', id: o.id }], exclude: [] } }));
    const id = created.body.id;
    await k.call('PUT', `${ADMIN}/campaigns/${id}/flash-items`, k.staff, { items: [{ offerId: o.id, dealPrice: USD(6000), dealStock: 5, purchaseLimit: 1 }] });
    for (const step of ['submit', 'confirm-funding', 'schedule']) expect((await k.call('POST', `${ADMIN}/campaigns/${id}/${step}`, step === 'confirm-funding' ? k.finance : k.staff, {})).status).toBe(200);
    const deals = await k.svc.liveDeals({ limit: 4, campaignId: id });
    expect(deals.map((d) => d.campaignId)).toEqual([id]);
    expect(await k.svc.liveDeals({ limit: 4, campaignId: newId() })).toEqual([]);
  });

  it('priceOffers shows the automatic discount a customer gets without doing anything', async () => {
    const o = k.offer({ sellerId: SELLER_A, categoryId: HOME, price: USD(10000) });
    await liveCampaign(k, campaignInput(k.clock, { name: 'Everything 10% off', autoApply: true, scope: { mode: 'sitewide', include: [], exclude: [] }, discount: { kind: 'percent_coupon', percentOffBps: 1000 } }));
    const [p] = await k.svc.priceOffers([o.id], {});
    expect(p).toMatchObject({ price: USD(10000), automaticDiscount: USD(1000) });
    expect(p!.automaticDiscountLabel).toContain('Everything 10% off');
  });

  it('the dashboard leaves storeReturnsPct empty instead of 0', async () => {
    const res = await k.call('GET', `${ADMIN}/dashboard`, k.staff);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.storeReturnsPct ?? null).toBeNull();
  });
});
