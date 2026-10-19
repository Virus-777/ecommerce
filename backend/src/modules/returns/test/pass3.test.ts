/**
 * Gap pass 3: second refunds after a sent or failed one, eligibility of items without a return, exchanges
 * (same product, seller and price), replacement stock allocated (never a timed hold) and cancelled with a
 * release, replacements requested by support without a return, case refund rules (one seller group, items,
 * no goodwill), the drop-off deadline and label kept from shipping, event references and parent-category
 * exceptions.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import type * as offers from '../../../spec/offers.js';
import { group, harness, idem, line, now, placeOrder, product, REAUTH, tokens, USD, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h.app.close();
});
beforeEach(() => {
  h.authority.decision = 'allowed';
  h.authority.decideStatus = 'approved';
});

const staff = () => tokens.staff();
const day = 86_400_000;
const breakdown = (total: number, max: number) => ({ itemAmount: USD(max), discountShare: USD(0), shippingRefund: USD(0), returnShippingDeduction: USD(0), deductions: [], total: USD(total), maxRefundable: USD(max), destination: 'Visa', isEstimate: false });

async function sent(rr: { id: string; ref: string }, orderId: string) {
  await h.publish('payments', 'payments.refund.sent', { refundId: newId(), ref: rr.ref, orderId, origin: 'exception', originId: rr.id, amount: USD(1), items: [], destination: 'Visa •••• 4417', sentAt: now() });
}

/** An Official Store return inspected and waiting for its remedy */
async function officialAwaitingRemedy(o: { remedy?: string; exchangeVariantId?: string; price?: number } = {}) {
  const p = product(h, { title: 'Kettle', price: o.price ?? 5000, ownerType: 'official' });
  const m = await placeOrder(h, [group(h, [line(p, 1)], { ownerType: 'official' })]);
  const token = tokens.customer(m.customerId);
  return { p, m, token };
}

describe('second refunds (DUPLICATE_REFUND only while a refund is in progress)', () => {
  it('allows a second refund on an item whose first refund was sent or failed, capped by what is left', async () => {
    const sellerId = newId();
    const p = product(h, { title: 'Chair', price: 8000, sellerId });
    const m = await placeOrder(h, [group(h, [line(p, 1)], { sellerId })]);
    const itemId = m.items[0]![0]!;
    const body = (amount: number) => ({ orderId: m.order.id, items: [{ orderItemId: itemId, quantity: 1, amount: USD(amount) }], reasonCode: 'late_delivery', reason: 'Late', fundedBy: 'platform' });
    const first = await h.call('POST', '/api/admin/returns/refunds', staff(), body(2000), idem());
    expect(first.body.status).toBe('processing');
    // still in progress: blocked
    expect((await h.call('POST', '/api/admin/returns/refunds', staff(), body(1000), idem())).body.error).toMatchObject({ code: 'DUPLICATE_REFUND', details: { refundRequestId: first.body.id } });
    await sent(first.body, m.order.id);
    // sent: the rest can be refunded (before pass 3 this was DUPLICATE_REFUND)
    const second = await h.call('POST', '/api/admin/returns/refunds', staff(), body(3000), idem());
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    expect(second.body.status).toBe('processing');
    // never above what payments still counts as refundable (8000 − 2000 − 3000)
    await sent(second.body, m.order.id);
    expect((await h.call('POST', '/api/admin/returns/refunds', staff(), body(3500), idem())).body.error).toMatchObject({ code: 'REFUND_EXCEEDS_REFUNDABLE', details: { maxRefundable: { amount: 3000 } } });
    // a failed request blocks nothing in returns
    const third = await h.call('POST', '/api/admin/returns/refunds', staff(), body(500), idem());
    await h.publish('payments', 'payments.refund.failed', { refundId: newId(), ref: third.body.ref, orderId: m.order.id, origin: 'exception', originId: third.body.id, amount: USD(500), reason: 'Card closed', attempts: 1, finalAttempt: false });
    expect((await h.call('GET', `/api/admin/returns/refunds/${third.body.id}`, staff())).body.status).toBe('failed');
    expect((await h.call('POST', '/api/admin/returns/refunds', staff(), body(400), idem())).status).toBe(201);
  });
});

describe('eligibility from the order item (orders.getOrderItem)', () => {
  it('judges an item with no return record by its own state', async () => {
    const sellerId = newId();
    const p = product(h, { title: 'Lamp', price: 3000, sellerId });
    const delivered = await placeOrder(h, [group(h, [line(p, 2)], { sellerId })]);
    const pending = await placeOrder(h, [group(h, [line(p, 1)], { sellerId })], { deliver: false });
    const [a, b] = await h.service.eligibilityForItems([delivered.items[0]![0]!, pending.items[0]![0]!]);
    // before pass 3 an item without a return was always "not eligible"
    expect(a).toMatchObject({ eligible: true, quantityPurchased: 2, quantityReturnable: 2, latestReturn: null });
    expect(a!.returnBy).toBeTruthy();
    expect(b).toMatchObject({ eligible: false, ineligibleReason: 'not_shipped', quantityPurchased: 1 });
    // units on a return are subtracted
    const token = tokens.customer(delivered.customerId);
    await h.call('POST', '/api/store/returns/requests', token, { orderId: delivered.order.id, items: [{ orderItemId: delivered.items[0]![0]!, quantity: 1 }], reason: 'damaged', details: 'Cracked', remedy: 'refund' }, idem());
    const [after] = await h.service.eligibilityForItems([delivered.items[0]![0]!]);
    expect(after).toMatchObject({ eligible: true, quantityReturnable: 1, latestReturn: { status: 'requested' } });
    expect((await h.service.eligibilityForItems([newId()]))[0]).toMatchObject({ eligible: false, quantityPurchased: 0 });
  });
});

describe('exchanges: same product, same seller, same price', () => {
  const offer = (p: { productId: string }, o: Partial<offers.Offer>): offers.Offer => ({ id: newId(), ownerType: 'official', sellerId: null, productId: p.productId, variantId: newId(), stockItemId: newId(), price: USD(5000), status: 'active', ...o }) as offers.Offer;

  it('refuses another product, another price, and allocates the same-price variant', async () => {
    const { p, m, token } = await officialAwaitingRemedy();
    h.stock.set(p.stockItemId, 3);
    const cheaper = offer(p, { price: USD(4500) });
    const same = offer(p, {});
    h.stock.set(same.stockItemId, 2);
    h.ownOffers.set(p.productId, [cheaper, same]);
    const ask = (variantId: string) => h.call('POST', '/api/store/returns/requests', token, { orderId: m.order.id, items: [{ orderItemId: m.items[0]![0]!, quantity: 1 }], reason: 'wrong_size', details: 'Too small', remedy: 'exchange', exchangeVariantId: variantId }, idem());
    const other = await ask(newId());
    expect(other.status).toBe(422);
    expect(other.body.error).toMatchObject({ code: 'EXCHANGE_NOT_ALLOWED', details: { reason: 'different_product' } });
    expect((await ask(cheaper.variantId)).body.error).toMatchObject({ code: 'EXCHANGE_NOT_ALLOWED', details: { reason: 'different_price' } });
    const ok = await ask(same.variantId);
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    const id = ok.body.returns[0].id;
    await h.service.recordWarehouseReceipt(id, now(), { kind: 'staff', id: newId() }, null);
    await h.call('POST', `/api/admin/returns/requests/${id}/inspection`, staff(), { conditionOutcome: 'as_described', grade: 'like_new', proposedStockOutcome: 'restock' });
    const holds = h.calls.holds.length;
    const res = await h.call('POST', `/api/admin/returns/requests/${id}/remedy`, staff(), { kind: 'exchange', exchangeVariantId: same.variantId }, idem());
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.detail.replacement).toMatchObject({ kind: 'exchange', status: 'reserved', variantId: same.variantId, returnId: id, orderId: m.order.id, orderItemId: m.items[0]![0]! });
    expect(h.calls.allocations.at(-1)).toMatchObject({ orderId: m.order.id, source: { kind: 'exchange' }, lines: [{ stockItemId: same.stockItemId, quantity: 1, orderItemId: m.items[0]![0]! }] });
    expect(h.calls.holds.length).toBe(holds);
    expect(h.named('returns.replacement.created').find((e) => e.returnId === id)).toMatchObject({ kind: 'exchange', offerId: same.id, caseId: null });
  });
});

describe('replacements: allocated, cancelled with a release', () => {
  async function replaced() {
    const { p, m, token } = await officialAwaitingRemedy();
    const res = await h.call('POST', '/api/store/returns/requests', token, { orderId: m.order.id, items: [{ orderItemId: m.items[0]![0]!, quantity: 1 }], reason: 'defective', details: 'Dead', remedy: 'refund' }, idem());
    const id = res.body.returns[0].id;
    await h.service.recordWarehouseReceipt(id, now(), { kind: 'staff', id: newId() }, null);
    await h.call('POST', `/api/admin/returns/requests/${id}/inspection`, staff(), { conditionOutcome: 'as_described', grade: 'like_new', proposedStockOutcome: 'restock' });
    h.stock.set(p.stockItemId, 4);
    const rep = await h.call('POST', `/api/admin/returns/requests/${id}/remedy`, staff(), { kind: 'replacement' }, idem());
    expect(rep.status, JSON.stringify(rep.body)).toBe(200);
    return { id, p, m, token, replacement: rep.body.detail.replacement };
  }

  it('allocates through inventory.allocateForOrder (no timed hold) and cancels with a reason, releasing it', async () => {
    const holds = h.calls.holds.length;
    const r = await replaced();
    expect(h.calls.holds.length).toBe(holds);
    const allocation = h.calls.allocations.at(-1)!;
    expect(allocation).toMatchObject({ orderId: r.m.order.id, orderRef: r.m.order.ref, source: { kind: 'replacement', id: r.replacement.id }, lines: [{ stockItemId: r.p.stockItemId, quantity: 1 }] });

    expect((await h.call('POST', `/api/seller/returns/replacements/${r.replacement.id}/cancel`, tokens.seller(newId()), { reason: 'x' })).status).toBe(404);
    expect((await h.call('POST', `/api/admin/returns/replacements/${r.replacement.id}/cancel`, staff(), { reason: ' ' })).status).toBe(400);
    const cancelled = await h.call('POST', `/api/admin/returns/replacements/${r.replacement.id}/cancel`, staff(), { reason: 'Out of stock at the warehouse' });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(cancelled.body).toMatchObject({ id: r.replacement.id, status: 'cancelled', cancelReason: 'Out of stock at the warehouse', returnId: r.id });
    expect(h.calls.released.at(-1)?.reason).toBe('Out of stock at the warehouse');
    expect(h.named('returns.replacement.cancelled').find((e) => e.replacementId === r.replacement.id)).toMatchObject({ returnId: r.id, caseId: null, orderId: r.m.order.id, ownerType: 'official', reason: 'Out of stock at the warehouse' });
    expect(h.audits.some((a) => a.action === 'returns.replacement.cancel' && a.target.id === r.replacement.id)).toBe(true);
    // the return is back to awaiting a remedy: a refund can be issued instead
    const detail = await h.call('GET', `/api/admin/returns/requests/${r.id}`, staff());
    expect(detail.body.detail.status).toBe('awaiting_remedy');
    expect(detail.body.allowedActions).toContain('remedy');
    expect((await h.call('POST', `/api/admin/returns/replacements/${r.replacement.id}/cancel`, staff(), { reason: 'again' })).status).toBe(409);
  });

  it("lets the seller cancel its own replacement, not another's", async () => {
    const sellerId = newId();
    const p = product(h, { title: 'Vase', price: 4000, sellerId });
    const m = await placeOrder(h, [group(h, [line(p, 1)], { sellerId })]);
    const res = await h.call('POST', '/api/store/returns/requests', tokens.customer(m.customerId), { orderId: m.order.id, items: [{ orderItemId: m.items[0]![0]!, quantity: 1 }], reason: 'damaged', details: 'Cracked', remedy: 'refund' }, idem());
    const id = res.body.returns[0].id;
    const seller = tokens.seller(sellerId);
    await h.call('POST', `/api/seller/returns/requests/${id}/approve`, seller, { labelMethod: 'prepaid_qr' });
    await h.call('POST', `/api/seller/returns/requests/${id}/receive`, seller, {});
    await h.call('POST', `/api/seller/returns/requests/${id}/inspection`, seller, { conditionOutcome: 'as_described', grade: 'good', proposedStockOutcome: 'restock' });
    h.stock.set(p.stockItemId, 2);
    const rep = await h.call('POST', `/api/seller/returns/requests/${id}/remedy`, seller, { kind: 'replacement' }, idem());
    expect(rep.status, JSON.stringify(rep.body)).toBe(200);
    const repId = rep.body.detail.replacement.id;
    expect((await h.call('POST', `/api/seller/returns/replacements/${repId}/cancel`, tokens.seller(newId()), { reason: 'No stock' })).status).toBe(404);
    const ok = await h.call('POST', `/api/seller/returns/replacements/${repId}/cancel`, seller, { reason: 'No stock' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(h.named('returns.replacement.cancelled').find((e) => e.replacementId === repId)).toMatchObject({ ownerType: 'seller', sellerId, by: { kind: 'seller' } });
  });

  it('creates a replacement for a support case without a return, idempotent, and ships it by order item', async () => {
    const sellerId = newId();
    const p = product(h, { title: 'Bowl', price: 2500, sellerId });
    const m = await placeOrder(h, [group(h, [line(p, 2)], { sellerId })]);
    const itemId = m.items[0]![0]!;
    const caseId = newId();
    const input = { caseId, orderId: m.order.id, orderItemId: itemId, quantity: 1, reason: 'Lost in transit', requestedBy: { kind: 'staff' as const, id: newId() } };
    await expect(h.service.requestReplacement(input, 'case-rep-1')).rejects.toMatchObject({ code: 'REMEDY_NOT_AVAILABLE' });
    h.stock.set(p.stockItemId, 5);
    const rep = await h.service.requestReplacement(input, 'case-rep-2');
    expect(rep).toMatchObject({ returnId: null, caseId, orderId: m.order.id, orderItemId: itemId, kind: 'replacement', status: 'reserved', quantity: 1, title: 'Bowl' });
    const allocations = h.calls.allocations.length;
    expect((await h.service.requestReplacement(input, 'case-rep-2')).id).toBe(rep.id);
    expect(h.calls.allocations.length).toBe(allocations);
    await h.app.kernel.events.drain();
    expect(h.named('returns.replacement.created').find((e) => e.replacementId === rep.id)).toMatchObject({ returnId: null, caseId, orderId: m.order.id, orderRef: m.order.ref, customerId: m.customerId, ownerType: 'seller', sellerId, variantId: p.variantId, offerId: p.offerId, quantity: 1, kind: 'replacement' });

    // shipping matches the parcel by the replacement's order items (no return id)
    const shipmentId = newId();
    await h.publish('shipping', 'shipping.shipment.dispatched', { shipmentId, kind: 'replacement', orderId: m.order.id, groupId: m.order.groups[0]!.id, returnId: null, ownerType: 'seller', fulfilledBy: 'seller', sellerId, lines: [{ orderItemId: itemId, title: 'Bowl', variantLabel: '', quantity: 1 }], shippedAt: now(), dispatchDueAt: null, onTime: true, trackingValid: true, estimatedArrival: null });
    let row = (await h.service.core.repo.get('replacements', rep.id))!;
    expect(row).toMatchObject({ status: 'shipped', shipping_shipment_id: shipmentId });
    await h.publish('shipping', 'shipping.shipment.delivered', { shipmentId, kind: 'replacement', orderId: m.order.id, groupId: m.order.groups[0]!.id, returnId: null, sellerId, fulfilledBy: sellerId ? 'seller' : 'official_warehouse', lines: [{ orderItemId: itemId, title: 'Bowl', variantLabel: '', quantity: 1 }], deliveredAt: now() });
    row = (await h.service.core.repo.get('replacements', rep.id))!;
    expect(row.status).toBe('delivered');
    expect((await h.call('POST', `/api/admin/returns/replacements/${rep.id}/cancel`, staff(), { reason: 'late' })).status).toBe(409);

    // not delivered yet: refused
    const pending = await placeOrder(h, [group(h, [line(p, 1)], { sellerId })], { deliver: false });
    await expect(h.service.requestReplacement({ ...input, orderId: pending.order.id, orderItemId: pending.items[0]![0]! }, 'case-rep-3')).rejects.toMatchObject({ code: 'REMEDY_NOT_AVAILABLE' });
  });
});

describe('case replacements on a case with a return', () => {
  it("links the replacement to the case's return, which completes when it ships", async () => {
    const { p, m, token } = await officialAwaitingRemedy();
    const res = await h.call('POST', '/api/store/returns/requests', token, { orderId: m.order.id, items: [{ orderItemId: m.items[0]![0]!, quantity: 1 }], reason: 'defective', details: 'Dead', remedy: 'refund' }, idem());
    const id = res.body.returns[0].id;
    await h.service.recordWarehouseReceipt(id, now(), { kind: 'staff', id: newId() }, null);
    await h.call('POST', `/api/admin/returns/requests/${id}/inspection`, staff(), { conditionOutcome: 'as_described', grade: 'like_new', proposedStockOutcome: 'restock' });
    const caseId = newId();
    await h.service.core.repo.update('returns', id, { case_id: caseId });
    h.stock.set(p.stockItemId, 2);
    const rep = await h.service.requestReplacement({ caseId, orderId: m.order.id, orderItemId: m.items[0]![0]!, quantity: 1, reason: 'Decided on the case', requestedBy: { kind: 'staff', id: newId() } }, `case:${caseId}`);
    expect(rep).toMatchObject({ returnId: id, caseId, status: 'reserved' });
    await h.app.kernel.events.drain();
    expect(h.named('returns.replacement.created').find((e) => e.replacementId === rep.id)).toMatchObject({ returnId: id, caseId });
    // the return cannot get a second remedy
    expect((await h.call('POST', `/api/admin/returns/requests/${id}/remedy`, staff(), { kind: 'full_refund' }, idem())).status).toBe(409);
    await h.publish('shipping', 'shipping.shipment.dispatched', { shipmentId: newId(), kind: 'replacement', orderId: m.order.id, groupId: m.order.groups[0]!.id, returnId: id, ownerType: 'official', fulfilledBy: 'official_warehouse', sellerId: null, lines: [], shippedAt: now(), dispatchDueAt: null, onTime: true, trackingValid: true, estimatedArrival: null });
    expect((await h.call('GET', `/api/admin/returns/requests/${id}`, staff())).body.detail).toMatchObject({ status: 'completed', replacement: { id: rep.id, status: 'shipped' } });
  });
});

describe('case refunds (requestRefund)', () => {
  it('takes one seller group at a time, the refunded quantities and refuses goodwill', async () => {
    const sellerA = newId();
    const sellerB = newId();
    const pa = product(h, { title: 'Mug', price: 1000, sellerId: sellerA });
    const pb = product(h, { title: 'Plate', price: 2000, sellerId: sellerB });
    const m = await placeOrder(h, [group(h, [line(pa, 3)], { sellerId: sellerA }), group(h, [line(pb, 1)], { sellerId: sellerB })]);
    const base = { source: 'case' as const, caseId: newId(), orderId: m.order.id, breakdown: breakdown(1500, 3000), fundedBy: 'seller', reason: 'Two mugs broken', proposedBy: { kind: 'staff' as const, id: newId() } };
    await expect(h.service.requestRefund({ ...base, orderItemIds: [m.items[0]![0]!, m.items[1]![0]!] })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { groups: expect.arrayContaining([expect.objectContaining({ sellerId: sellerA, orderItemIds: [m.items[0]![0]!] }), expect.objectContaining({ sellerId: sellerB })]) },
    });
    await expect(h.service.requestRefund({ ...base, orderItemIds: [m.items[0]![0]!], reasonCode: 'customer_goodwill' })).rejects.toMatchObject({ code: 'REMEDY_NOT_AVAILABLE' });
    await expect(h.service.requestRefund({ ...base, orderItemIds: [m.items[0]![0]!], items: [{ orderItemId: m.items[0]![0]!, quantity: 4 }] })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const rr = await h.service.requestRefund({ ...base, orderItemIds: [m.items[0]![0]!], items: [{ orderItemId: m.items[0]![0]!, quantity: 2 }], reasonCode: 'damaged_in_transit' });
    expect(rr).toMatchObject({ status: 'under_review', source: 'case', sellerId: sellerA });
    const approved = await h.call('POST', `/api/admin/returns/refunds/${rr.id}/approve`, staff(), {}, idem());
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(h.named('returns.refund.approved').find((e) => e.refundRequestId === rr.id)).toMatchObject({ items: [{ orderItemId: m.items[0]![0]!, quantity: 2 }], caseId: base.caseId });
    // without items: each item's full quantity
    const other = await h.service.requestRefund({ ...base, caseId: newId(), orderItemIds: [m.items[1]![0]!], breakdown: breakdown(2000, 2000) });
    await h.call('POST', `/api/admin/returns/refunds/${other.id}/approve`, staff(), {}, idem());
    expect(h.named('returns.refund.approved').find((e) => e.refundRequestId === other.id)).toMatchObject({ items: [{ orderItemId: m.items[1]![0]!, quantity: 1 }] });
  });

  it('asks for the password again (a re-auth token) when access says the amount is above stepUpAbove', async () => {
    const sellerId = newId();
    const p = product(h, { title: 'Sofa', price: 90000, sellerId });
    const m = await placeOrder(h, [group(h, [line(p, 1)], { sellerId })]);
    const proposer = newId();
    const rr = await h.service.requestRefund({ source: 'case', caseId: newId(), orderId: m.order.id, orderItemIds: [m.items[0]![0]!], breakdown: breakdown(90000, 90000), fundedBy: 'seller', reason: 'Wrong item', proposedBy: { kind: 'staff', id: proposer } });
    // a case refund always waits for Finance through an approval request, filed under the support staff member
    expect(rr).toMatchObject({ status: 'under_review', approval: { required: true } });
    expect(h.calls.approvals.at(-1)).toMatchObject({ action: 'returns.refunds.approve', target: { type: 'refund_request', id: rr.id }, requestedBy: { kind: 'staff', accountId: proposer } });
    // a request left from before approval requests existed: Finance's own limit decides
    await h.service.core.repo.update('refund_requests', rr.id, { approval_request_id: null });
    h.authority.stepUp = true;
    try {
      const missing = await h.call('POST', `/api/admin/returns/refunds/${rr.id}/approve`, staff(), {}, idem());
      expect(missing.body.error).toMatchObject({ code: 'STEP_UP_REQUIRED', details: { kind: 'reauth', purpose: 'approval' } });
      // a token identity did not issue to this session is refused the same way
      const wrong = await h.call('POST', `/api/admin/returns/refunds/${rr.id}/approve`, staff(), { reauthToken: 'ra.-.not-issued' }, idem());
      expect(wrong.body.error.code).toBe('STEP_UP_REQUIRED');
      expect(h.calls.refunds.find((r) => r.originId === rr.id)).toBeUndefined();
      const ok = await h.call('POST', `/api/admin/returns/refunds/${rr.id}/approve`, staff(), { reauthToken: REAUTH }, idem());
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(ok.body.status).toBe('processing');
    } finally {
      h.authority.stepUp = false;
    }
  });

  it('the proposer cannot send a refund back and resubmit it to approve it alone, even within their own limit', async () => {
    const sellerId = newId();
    const p = product(h, { title: 'Skillet', price: 5098, sellerId });
    const m = await placeOrder(h, [group(h, [line(p, 1)], { sellerId })]);
    const proposer = newId();
    const mine = tokens.staff(undefined, { sub: proposer });
    const rr = await h.service.requestRefund({ source: 'case', caseId: newId(), orderId: m.order.id, orderItemIds: [m.items[0]![0]!], breakdown: breakdown(5098, 5098), fundedBy: 'seller', reason: 'Returned to sender', proposedBy: { kind: 'staff', id: proposer } });
    expect((await h.call('POST', `/api/admin/returns/refunds/${rr.id}/decline`, mine, { reason: 'Sending back to adjust' })).body.status).toBe('declined');
    // within the proposer's own limit (access allows), the resubmission still waits for someone else
    const revised = await h.call('POST', `/api/admin/returns/refunds/${rr.id}/revise`, mine, { kind: 'full_refund', explanation: 'Resubmit' });
    expect(revised.status, JSON.stringify(revised.body)).toBe(200);
    expect(revised.body).toMatchObject({ status: 'under_review', approval: { required: true }, proposedBy: { id: proposer } });
    expect(h.calls.approvals.at(-1)).toMatchObject({ target: { id: rr.id }, requestedBy: { accountId: proposer } });
    expect(h.calls.refunds.find((r) => r.originId === rr.id)).toBeUndefined();
    // with the approval request lapsed, the fallback does not let the proposer approve it either
    await h.service.core.repo.update('refund_requests', rr.id, { approval_request_id: null });
    const self = await h.call('POST', `/api/admin/returns/refunds/${rr.id}/approve`, mine, {}, idem());
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe('SELF_APPROVAL_NOT_ALLOWED');
    const list = await h.call('GET', '/api/admin/returns/refunds?awaitingApproval=true', mine);
    expect(list.body.items.find((r: any) => r.id === rr.id)).toMatchObject({ canApprove: false });
    const other = await h.call('POST', `/api/admin/returns/refunds/${rr.id}/approve`, staff(), {}, idem());
    expect(other.body.status, JSON.stringify(other.body)).toBe('processing');
  });
});

describe('staff refunds take one decision path (access returns.refunds.approve)', () => {
  const body = (orderId: string, orderItemId: string, amount: number) => ({ orderId, items: [{ orderItemId, quantity: 1, amount: USD(amount) }], reasonCode: 'late_delivery', reason: 'Late', fundedBy: 'platform' });
  async function order(price = 20000) {
    const sellerId = newId();
    const p = product(h, { title: 'Lamp', price, sellerId });
    return placeOrder(h, [group(h, [line(p, 1)], { sellerId })]);
  }

  it('order page within the limit above stepUpAbove: the password first, nothing saved without it', async () => {
    const m = await order();
    h.authority.stepUp = true;
    try {
      const missing = await h.call('POST', '/api/admin/returns/refunds', staff(), body(m.order.id, m.items[0]![0]!, 15000), idem());
      expect(missing.status).toBe(403);
      expect(missing.body.error).toMatchObject({ code: 'STEP_UP_REQUIRED', details: { kind: 'reauth', purpose: 'approval' } });
      expect(await h.service.listRefundRequestsForOrder(m.order.id)).toEqual([]);
      const ok = await h.call('POST', '/api/admin/returns/refunds', staff(), { ...body(m.order.id, m.items[0]![0]!, 15000), reauthToken: REAUTH }, idem());
      expect(ok.status, JSON.stringify(ok.body)).toBe(201);
      expect(ok.body).toMatchObject({ status: 'processing', approval: null });
      expect(h.calls.refunds.find((r) => r.originId === ok.body.id)).toBeTruthy();
    } finally {
      h.authority.stepUp = false;
    }
  });

  it('order page without refund authority: saved under review with an approval request; approving it hands the refund over', async () => {
    const m = await order();
    h.authority.decision = 'denied';
    const before = h.calls.approvals.length;
    const res = await h.call('POST', '/api/admin/returns/refunds', staff(), body(m.order.id, m.items[0]![0]!, 5000), idem());
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ status: 'under_review', approval: { required: true, approvalRequestId: expect.any(String) } });
    expect(h.calls.approvals.length).toBe(before + 1);
    expect(h.calls.approvals.at(-1)).toMatchObject({ action: 'returns.refunds.approve', amount: USD(5000), target: { type: 'refund_request', id: res.body.id, screen: 'admin/finance' } });
    // the caller cannot approve it from the list, and approving is refused for them
    expect((await h.call('GET', `/api/admin/returns/refunds/${res.body.id}`, staff())).body.canApprove).toBe(false);
    h.authority.decision = 'allowed';
    // the approver decides in access (Inbox)
    const requestId = res.body.approval.approvalRequestId;
    await h.publish('access', 'access.approval.decided', { requestId, ref: 'AP-1', actionKey: 'returns.refunds.approve', module: 'returns', target: { type: 'refund_request', id: res.body.id }, outcome: 'approved', decidedBy: { kind: 'staff', id: newId(), name: 'Fran Finance' }, reason: null, amount: USD(5000), approverIds: [], requestedById: newId() });
    const after = await h.call('GET', `/api/admin/returns/refunds/${res.body.id}`, staff());
    expect(after.body).toMatchObject({ status: 'processing', approvedBy: { name: 'Fran Finance' } });
    expect(h.calls.refunds.find((r) => r.originId === res.body.id)).toMatchObject({ origin: 'exception' });
  });

  it('approve without permission to refund at all is refused, not forwarded', async () => {
    const m = await order();
    h.authority.decision = 'denied';
    const res = await h.call('POST', '/api/admin/returns/refunds', staff(), body(m.order.id, m.items[0]![0]!, 4000), idem());
    // the open approval request is decided by access; with none, a caller without refund authority gets FORBIDDEN
    await h.service.core.repo.update('refund_requests', res.body.id, { approval_request_id: null });
    const refused = await h.call('POST', `/api/admin/returns/refunds/${res.body.id}/approve`, staff(), {}, idem());
    expect(refused.status).toBe(403);
    h.authority.decision = 'allowed';
  });

  it('awaitingApproval lists only refunds waiting for a refund approver', async () => {
    const m = await order();
    h.authority.decision = 'approval_required';
    const waiting = await h.call('POST', '/api/admin/returns/refunds', staff(), body(m.order.id, m.items[0]![0]!, 3000), idem());
    h.authority.decision = 'allowed';
    const m2 = await order();
    const done = await h.call('POST', '/api/admin/returns/refunds', staff(), body(m2.order.id, m2.items[0]![0]!, 3000), idem());
    const list = await h.call('GET', '/api/admin/returns/refunds?awaitingApproval=true', staff());
    const ids = list.body.items.map((r: any) => r.id);
    expect(ids).toContain(waiting.body.id);
    expect(ids).not.toContain(done.body.id);
    expect(list.body.items.find((r: any) => r.id === waiting.body.id)).toMatchObject({ orderRef: m.order.ref, returnRef: null, source: 'exception', reason: 'Late', proposedBy: { kind: 'staff' }, createdAt: expect.any(String), canApprove: true });
  });
});

describe('labels, references and categories', () => {
  it("passes the policy's drop-off deadline to shipping and keeps the label and its carrier service", async () => {
    const sellerId = newId();
    const p = product(h, { title: 'Clock', price: 3000, sellerId });
    const m = await placeOrder(h, [group(h, [line(p, 1)], { sellerId })]);
    const res = await h.call('POST', '/api/store/returns/requests', tokens.customer(m.customerId), { orderId: m.order.id, items: [{ orderItemId: m.items[0]![0]!, quantity: 1 }], reason: 'damaged', details: 'Glass cracked', remedy: 'refund' }, idem());
    expect(res.status).toBe(201);
    const id = res.body.returns[0].id;
    expect(h.named('returns.return.requested').find((e) => e.returnId === id)).toMatchObject({ ref: res.body.returns[0].ref, orderId: m.order.id, orderRef: m.order.ref });
    const before = h.clock.now().getTime();
    const ok = await h.call('POST', `/api/seller/returns/requests/${id}/approve`, tokens.seller(sellerId), { labelMethod: 'prepaid_qr' });
    expect(ok.status).toBe(200);
    const request = h.calls.labels.at(-1)!;
    // seeded baseline 1.0: 7 days to drop off (shipping never invents the date)
    expect(new Date(request.dropOffBy!).getTime()).toBeGreaterThanOrEqual(before + 7 * day - 60_000);
    expect(new Date(request.dropOffBy!).getTime()).toBeLessThanOrEqual(h.clock.now().getTime() + 7 * day + 60_000);
    const [shipment] = await h.service.core.repo.find('return_shipments', { return_id: id });
    expect(shipment).toMatchObject({ carrier_service_id: h.carrierServiceId });
    expect(shipment!.label_id).toBeTruthy();
    expect(h.named('returns.label.created').find((e) => e.returnId === id)).toMatchObject({ ref: res.body.returns[0].ref, orderId: m.order.id, orderRef: m.order.ref, labelId: shipment!.label_id });
    expect(h.named('returns.return.approved').find((e) => e.returnId === id)).toMatchObject({ orderRef: m.order.ref });
    await h.call('POST', `/api/store/returns/requests/${id}/withdraw`, tokens.customer(m.customerId), {});
    expect(h.calls.voided).toContain(shipment!.label_id);
    expect(h.named('returns.return.cancelled').find((e) => e.returnId === id)).toMatchObject({ ref: res.body.returns[0].ref, orderId: m.order.id, orderRef: m.order.ref });
  });

  it('applies an exception set on a parent category to its subcategories and shows category names (catalog)', async () => {
    const parent = newId();
    const child = newId();
    h.categoryPaths.set(parent, { categoryId: parent, names: ['Home'], ids: [parent] });
    h.categoryPaths.set(child, { categoryId: child, names: ['Home', 'Lighting'], ids: [parent, child] });
    const ex = await h.call('POST', '/api/admin/returns/category-exceptions', staff(), {
      categoryId: parent,
      windowDays: 45,
      changeOfMindAllowed: true,
      condition: 'Unused',
      faultReturnsWindowDays: 60,
      shownOn: ['product_page'],
      effectiveFrom: new Date(h.clock.now().getTime() - 60_000).toISOString(),
      reason: 'Home goods',
    });
    expect(ex.status, JSON.stringify(ex.body)).toBe(201);
    expect(ex.body.categoryName).toBe('Home');
    const terms = await h.service.resolveTerms(newId(), child, null);
    expect(terms).toMatchObject({ categoryId: child, windowDays: 45, source: 'category_exception' });
    // without a path the exact category only
    expect((await h.service.resolveTerms(newId(), newId(), null)).source).toBe('baseline');
  });
});

describe('returns that finish (H16)', () => {
  it('replaces every item of a multi-item return from its own stock, and completes once all are on their way', async () => {
    const kettle = product(h, { title: 'Kettle', price: 5000, ownerType: 'official' });
    const toaster = product(h, { title: 'Toaster', price: 3000, ownerType: 'official' });
    const m = await placeOrder(h, [group(h, [line(kettle, 1), line(toaster, 2)], { ownerType: 'official' })]);
    const [kettleItem, toasterItem] = m.items[0]!;
    const res = await h.call('POST', '/api/store/returns/requests', tokens.customer(m.customerId), { orderId: m.order.id, items: [{ orderItemId: kettleItem!, quantity: 1 }, { orderItemId: toasterItem!, quantity: 2 }], reason: 'defective', details: 'Both stopped working', remedy: 'refund' }, idem());
    const id = res.body.returns[0].id;
    await h.service.recordWarehouseReceipt(id, now(), { kind: 'staff', id: newId() }, null);
    await h.call('POST', `/api/admin/returns/requests/${id}/inspection`, staff(), { conditionOutcome: 'as_described', grade: 'good', proposedStockOutcome: 'restock' });
    h.stock.set(kettle.stockItemId, 3);
    h.stock.set(toaster.stockItemId, 3);
    const rep = await h.call('POST', `/api/admin/returns/requests/${id}/remedy`, staff(), { kind: 'replacement' }, idem());
    expect(rep.status, JSON.stringify(rep.body)).toBe(200);
    const created = h.named('returns.replacement.created').filter((e) => e.returnId === id);
    expect(created.map((e) => [e.orderItemId, e.quantity]).sort()).toEqual([[kettleItem, 1], [toasterItem, 2]].sort());
    expect(h.calls.allocations.slice(-2).map((a) => a.lines[0])).toEqual(expect.arrayContaining([expect.objectContaining({ stockItemId: kettle.stockItemId, quantity: 1 }), expect.objectContaining({ stockItemId: toaster.stockItemId, quantity: 2 })]));
    const ship = (orderItemId: string) => h.publish('shipping', 'shipping.shipment.dispatched', { shipmentId: newId(), kind: 'replacement', orderId: m.order.id, groupId: m.order.groups[0]!.id, returnId: id, ownerType: 'official', fulfilledBy: 'official_warehouse', sellerId: null, lines: [{ orderItemId, title: 'x', variantLabel: '', quantity: 1 }], shippedAt: now(), dispatchDueAt: null, onTime: true, trackingValid: true, estimatedArrival: null });
    await ship(kettleItem!);
    expect((await h.call('GET', `/api/admin/returns/requests/${id}`, staff())).body.detail.status, 'one of two shipped').toBe('awaiting_remedy');
    await ship(toasterItem!);
    expect((await h.call('GET', `/api/admin/returns/requests/${id}`, staff())).body.detail.status).toBe('completed');
  });

  it('declines a return without a refund after an inspection that found an empty package, with photos', async () => {
    const sellerId = newId();
    const p = product(h, { title: 'Speaker', price: 9000, sellerId });
    const m = await placeOrder(h, [group(h, [line(p, 1)], { sellerId })]);
    const token = tokens.customer(m.customerId);
    const res = await h.call('POST', '/api/store/returns/requests', token, { orderId: m.order.id, items: [{ orderItemId: m.items[0]![0]!, quantity: 1 }], reason: 'changed_mind', details: 'Not needed', remedy: 'refund' }, idem());
    const id = res.body.returns[0].id;
    const seller = tokens.seller(sellerId);
    await h.call('POST', `/api/seller/returns/requests/${id}/approve`, seller, { labelMethod: 'prepaid_qr' });
    await h.call('POST', `/api/seller/returns/requests/${id}/receive`, seller, {});
    await h.call('POST', `/api/seller/returns/requests/${id}/inspection`, seller, { conditionOutcome: 'empty_package', grade: 'damaged', proposedStockOutcome: 'write_off' });
    const noPhotos = await h.call('POST', `/api/seller/returns/requests/${id}/remedy`, seller, { kind: 'decline', explanation: 'The box arrived empty.' }, idem());
    expect(noPhotos.status).toBe(400);
    // the inspection photos are the evidence (stored on the inspection; media uploads are not part of this test)
    const repo = (h.service as any).core.repo;
    const [insp] = await repo.find('inspections', { return_id: id });
    await repo.update('inspections', insp.id, { media_ids: [newId()] });
    const declined = await h.call('POST', `/api/seller/returns/requests/${id}/remedy`, seller, { kind: 'decline', explanation: 'The box arrived empty.' }, idem());
    expect(declined.status, JSON.stringify(declined.body)).toBe(200);
    expect(declined.body.detail.status).toBe('rejected');
    expect(h.named('returns.return.rejected').find((e) => e.returnId === id)).toMatchObject({ reasonCode: 'failed_inspection' });
    // the units stay with the declined return: the customer asks Marketly to review it instead of starting again
    const again = await h.call('POST', '/api/store/returns/requests', token, { orderId: m.order.id, items: [{ orderItemId: m.items[0]![0]!, quantity: 1 }], reason: 'changed_mind', details: 'Again', remedy: 'refund' }, idem());
    expect(again.body.error?.code, JSON.stringify(again.body)).toBe('RETURN_NOT_ELIGIBLE');
    expect(JSON.stringify(again.body.error.details)).toContain('Ask Marketly to review it');
  });

  it('cancels another open return for the same units once one of them is refunded, never one for other units', async () => {
    const sellerId = newId();
    const p = product(h, { title: 'Mug', price: 1500, sellerId });
    const m = await placeOrder(h, [group(h, [line(p, 2)], { sellerId })]);
    const token = tokens.customer(m.customerId);
    const itemId = m.items[0]![0]!;
    const open = async () => (await h.call('POST', '/api/store/returns/requests', token, { orderId: m.order.id, items: [{ orderItemId: itemId, quantity: 1 }], reason: 'changed_mind', details: 'Spare', remedy: 'refund' }, idem())).body.returns[0].id as string;
    const a = await open();
    const b = await open();
    const c = (await h.call('POST', '/api/store/returns/requests', token, { orderId: m.order.id, items: [{ orderItemId: itemId, quantity: 1 }], reason: 'changed_mind', details: 'Third', remedy: 'refund' }, idem())).body;
    expect(c.error?.code, 'both units are on a return already').toBe('RETURN_NOT_ELIGIBLE');
    // a return made before the one-return-per-unit rule claimed a unit already on return a
    const repo = (h.service as any).core.repo;
    const [bItem] = await repo.find('return_items', { return_id: b });
    await repo.update('return_items', bItem.id, { quantity: 2 });
    const res = await h.call('POST', `/api/seller/returns/requests/${a}/approve-without-return`, tokens.seller(sellerId), { reasonCode: 'return_cost_exceeds_value', details: 'Not worth shipping', remedy: { kind: 'full_refund' } }, idem());
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const rr = res.body.refundRequest;
    await h.publish('payments', 'payments.refund.sent', { refundId: newId(), ref: rr.ref, orderId: m.order.id, origin: 'return', originId: rr.id, amount: USD(1500), items: [{ orderItemId: itemId, title: 'Mug', groupId: m.order.groups[0]!.id, sellerId, amount: USD(1500) }], destination: 'Visa', sentAt: now() });
    expect((await h.call('GET', `/api/admin/returns/requests/${b}`, staff())).body.detail.status, 'b claimed the refunded unit').toBe('cancelled');
  });

  it('does not decline a return whose inspection found it as described', async () => {
    const { p, m, token } = await officialAwaitingRemedy();
    void p;
    const res = await h.call('POST', '/api/store/returns/requests', token, { orderId: m.order.id, items: [{ orderItemId: m.items[0]![0]!, quantity: 1 }], reason: 'defective', details: 'Dead', remedy: 'refund' }, idem());
    const id = res.body.returns[0].id;
    await h.service.recordWarehouseReceipt(id, now(), { kind: 'staff', id: newId() }, null);
    await h.call('POST', `/api/admin/returns/requests/${id}/inspection`, staff(), { conditionOutcome: 'as_described', grade: 'like_new', proposedStockOutcome: 'restock' });
    const res2 = await h.call('POST', `/api/admin/returns/requests/${id}/remedy`, staff(), { kind: 'decline', explanation: 'No' }, idem());
    expect(res2.body.error?.code).toBe('REMEDY_NOT_AVAILABLE');
  });
});
