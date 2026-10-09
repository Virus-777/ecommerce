/**
 * The customer's return journey with a marketplace seller: eligibility, the request (one return per seller),
 * the seller's decisions, the return parcel, receipt, inspection and the seller-approved refund that payments
 * sends. Record scope: other customers and sellers get 404.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { group, harness, idem, line, now, placeOrder, product, tokens, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h.app.close();
});

async function twoSellers(o: { deliver?: boolean } = {}) {
  const sellerA = newId();
  const sellerB = newId();
  const pa = product(h, { title: 'Headphones', price: 6000, sellerId: sellerA });
  const pb = product(h, { title: 'Lamp', price: 3000, sellerId: sellerB });
  const placed = await placeOrder(h, [group(h, [line(pa, 2, { shipping: 400, tax: 600, discount: 1000 })], { sellerId: sellerA }), group(h, [line(pb, 1, { tax: 200 })], { sellerId: sellerB })], o);
  return { ...placed, sellerA, sellerB, pa, pb, token: tokens.customer(placed.customerId) };
}

const create = (token: string, body: unknown) => h.call('POST', '/api/store/returns/requests', token, body, idem());

describe('eligibility', () => {
  it('lists returnable items with reasons and keeps other customers out', async () => {
    const m = await twoSellers({ deliver: false });
    const res = await h.call('GET', `/api/store/returns/orders/${m.order.id}/returnable-items`, m.token);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items[0]).toMatchObject({ eligible: false, ineligibleReason: 'not_shipped', quantityPurchased: 2, quantityReturnable: 0, sellerId: m.sellerA });
    expect((await h.call('GET', `/api/store/returns/orders/${m.order.id}/returnable-items`, tokens.customer(newId()))).status).toBe(404);
  });

  it('groups delivered items by seller with destination, who pays and a refund estimate', async () => {
    const m = await twoSellers();
    const res = await h.call('POST', '/api/store/returns/eligibility', m.token, {
      orderId: m.order.id,
      items: [
        { orderItemId: m.items[0]![0]!, quantity: 1 },
        { orderItemId: m.items[1]![0]!, quantity: 1 },
      ],
      reason: 'damaged',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.groups).toHaveLength(2);
    const a = res.body.groups.find((g: any) => g.sellerId === m.sellerA);
    // 1 of 2 units: (6000 + 300 tax) − 500 discount + 200 shipping (refunded for a damaged item)
    expect(a).toMatchObject({ eligible: true, shippingPaidBy: 'seller', returnShippingCost: null, labelMethod: 'prepaid_qr', destination: { kind: 'seller_address' } });
    expect(a.estimate).toMatchObject({ itemAmount: { amount: 6300 }, discountShare: { amount: 500 }, shippingRefund: { amount: 200 }, total: { amount: 6000 }, isEstimate: true });
    const mind = await h.call('POST', '/api/store/returns/eligibility', m.token, { orderId: m.order.id, items: [{ orderItemId: m.items[1]![0]!, quantity: 1 }], reason: 'changed_mind' });
    expect(mind.body.groups[0]).toMatchObject({ shippingPaidBy: 'customer', returnShippingCost: { amount: 799 } });
    expect(mind.body.groups[0].estimate).toMatchObject({ returnShippingDeduction: { amount: 799 }, total: { amount: 3200 - 799 } });
    expect((await h.call('POST', '/api/store/returns/eligibility', m.token, { orderId: m.order.id, items: [{ orderItemId: m.items[1]![0]!, quantity: 2 }] })).body.error.code).toBe('QUANTITY_EXCEEDS_RETURNABLE');
  });
});

describe('the request', () => {
  it('splits by seller, re-checks eligibility and quantities', async () => {
    const m = await twoSellers();
    const res = await create(m.token, {
      orderId: m.order.id,
      items: [
        { orderItemId: m.items[0]![0]!, quantity: 1 },
        { orderItemId: m.items[1]![0]!, quantity: 1 },
      ],
      reason: 'damaged',
      details: 'The box was crushed',
      remedy: 'refund',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.returns).toHaveLength(2);
    expect(res.body.returns[0]).toMatchObject({ status: 'requested', statusLabel: 'Requested', handledBy: 'seller', remedy: 'refund', actions: expect.arrayContaining(['withdraw', 'report_problem']) });
    expect(res.body.returns[0].ref).toMatch(/^RT-\d{6}-\d{4}$/);
    const requested = h.named('returns.return.requested').filter((e) => e.orderId === m.order.id);
    expect(requested).toHaveLength(2);
    expect(requested[0]).toMatchObject({ reason: 'damaged', ownerType: 'seller' });
    // orders mirrors the request on the items
    const order = (await h.orders.getOrder(m.order.id))!;
    expect(order.groups[0]!.items[0]!.state).toBe('return_requested');
    // one unit left on the first line; the second line is fully covered
    const again = await create(m.token, { orderId: m.order.id, items: [{ orderItemId: m.items[1]![0]!, quantity: 1 }], reason: 'damaged', details: '', remedy: 'refund' });
    expect(again.status).toBe(422);
    expect(again.body.error.code).toBe('RETURN_NOT_ELIGIBLE');
    expect(again.body.error.details.items[0]).toMatchObject({ reason: 'return_open' });
    const second = await create(m.token, { orderId: m.order.id, items: [{ orderItemId: m.items[0]![0]!, quantity: 1 }], reason: 'defective', details: '', remedy: 'refund' });
    expect(second.status, JSON.stringify(second.body)).toBe(201);
  });

  it('refuses items that are not delivered, closed windows and remedies that are not offered', async () => {
    const pending = await twoSellers({ deliver: false });
    const notDelivered = await create(pending.token, { orderId: pending.order.id, items: [{ orderItemId: pending.items[0]![0]!, quantity: 1 }], reason: 'damaged', details: '', remedy: 'refund' });
    expect(notDelivered.body.error.code).toBe('RETURN_NOT_ELIGIBLE');

    const m = await twoSellers();
    const credit = await create(m.token, { orderId: m.order.id, items: [{ orderItemId: m.items[1]![0]!, quantity: 1 }], reason: 'damaged', details: '', remedy: 'store_credit' });
    expect(credit.body.error.code).toBe('REMEDY_NOT_AVAILABLE');
    h.clock.advance(31 * 86_400_000);
    try {
      const late = await create(tokens.customer(m.customerId), { orderId: m.order.id, items: [{ orderItemId: m.items[1]![0]!, quantity: 1 }], reason: 'changed_mind', details: '', remedy: 'refund' });
      expect(late.body.error.code).toBe('RETURN_WINDOW_CLOSED');
      expect(late.body.error.details.returnBy).toBeTruthy();
    } finally {
      h.clock.advance(-31 * 86_400_000);
    }
  });

  it('lets guests with order access return items', async () => {
    const seller = newId();
    const p = product(h, { title: 'Mug', price: 1500, sellerId: seller });
    const m = await placeOrder(h, [group(h, [line(p, 1)], { sellerId: seller })], { customerId: null });
    const visitor = tokens.visitor();
    const denied = await h.call('GET', `/api/store/returns/orders/${m.order.id}/returnable-items`, visitor);
    expect(denied.status).toBe(404);
    const sessionId = JSON.parse(Buffer.from(visitor.split('.')[1]!, 'base64url').toString()).sid as string;
    h.guestGrants.add(`${sessionId}:${m.order.id}`);
    const res = await create(visitor, { orderId: m.order.id, items: [{ orderItemId: m.items[0]![0]!, quantity: 1 }], reason: 'wrong_item', details: 'Blue not teal', remedy: 'refund' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const mine = await h.call('GET', '/api/store/returns/requests', visitor);
    expect(mine.body.items.map((r: any) => r.id)).toContain(res.body.returns[0].id);
  });
});

describe('seller decisions and the return parcel', () => {
  async function requested(reason = 'damaged') {
    const m = await twoSellers();
    const res = await create(m.token, { orderId: m.order.id, items: [{ orderItemId: m.items[0]![0]!, quantity: 2 }], reason, details: 'Broken hinge', remedy: 'refund' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return { ...m, ret: res.body.returns[0], seller: tokens.seller(m.sellerA) };
  }

  it('keeps sellers to their own returns', async () => {
    const m = await requested();
    expect((await h.call('GET', `/api/seller/returns/requests/${m.ret.id}`, tokens.seller(m.sellerB))).status).toBe(404);
    expect((await h.call('POST', `/api/seller/returns/requests/${m.ret.id}/approve`, tokens.seller(m.sellerB), { labelMethod: 'prepaid_qr' })).status).toBe(404);
    expect((await h.call('GET', `/api/store/returns/requests/${m.ret.id}`, tokens.customer(newId()))).status).toBe(404);
    const own = await h.call('GET', `/api/seller/returns/requests/${m.ret.id}`, m.seller);
    expect(own.status).toBe(200);
    expect(own.body).toMatchObject({ detail: { id: m.ret.id, statusLabel: 'Requested' }, shippingPaidBy: 'seller', allowedActions: expect.arrayContaining(['approve', 'reject', 'request-info']) });
    expect(own.body.payment).toMatchObject({ itemPaid: { amount: 12600 }, discountShare: { amount: 1000 }, maxRefundable: { amount: 12000 }, methodLabel: 'Visa •••• 4417' });
    expect(own.body.deadlines.respondBy.state).toBe('on_time');
  });

  it('asks the customer, pauses the clock, and refuses customer-paid shipping for a damaged item', async () => {
    const m = await requested();
    const ask = await h.call('POST', `/api/seller/returns/requests/${m.ret.id}/request-info`, m.seller, { question: 'Can you send a photo of the hinge?' });
    expect(ask.status, JSON.stringify(ask.body)).toBe(200);
    expect(ask.body.detail).toMatchObject({ status: 'info_requested', responseDue: null, infoRequest: { question: 'Can you send a photo of the hinge?' } });
    expect(h.named('returns.return.info_requested').find((e) => e.returnId === m.ret.id)).toMatchObject({ customerId: m.customerId, contactEmail: 'sam@example.com' });
    expect((await h.call('POST', `/api/seller/returns/requests/${m.ret.id}/approve`, m.seller, { labelMethod: 'prepaid_qr' })).status).toBe(409);
    const reply = await h.call('POST', `/api/store/returns/requests/${m.ret.id}/info`, m.token, { reply: 'Attached' });
    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({ status: 'requested', infoRequest: { reply: 'Attached' } });
    expect(reply.body.responseDue).toBeTruthy();
    const payer = await h.call('POST', `/api/seller/returns/requests/${m.ret.id}/approve`, m.seller, { labelMethod: 'customer_arranged' });
    expect(payer.status).toBe(422);
    expect(payer.body.error.code).toBe('SHIPPING_PAYER_NOT_ALLOWED');
  });

  it('approves with a prepaid label, tracks the parcel, receives, inspects and refunds', async () => {
    const m = await requested();
    const ok = await h.call('POST', `/api/seller/returns/requests/${m.ret.id}/approve`, m.seller, { labelMethod: 'prepaid_qr', note: 'Sorry about that' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.detail).toMatchObject({ status: 'approved', decision: { kind: 'approved', platformDecision: false }, shipment: { status: 'label_issued', method: 'prepaid_qr', paidBy: 'seller', cost: { amount: 650 } } });
    expect(h.calls.labels.at(-1)).toMatchObject({ kind: 'return', returnId: m.ret.id, labelMethod: 'prepaid_qr', billedTo: 'seller' });
    expect(h.named('returns.return.approved').find((e) => e.returnId === m.ret.id)).toMatchObject({
      withoutReturn: false,
      platformDecision: false,
      ref: m.ret.ref,
      orderId: m.order.id,
      customerId: m.customerId,
      contactEmail: 'sam@example.com',
      items: [{ orderItemId: m.items[0]![0]!, quantity: 2 }],
      trackingNumber: ok.body.detail.shipment.trackingNumber,
    });
    expect(ok.body.detail.shipment.trackingNumber).toBeTruthy();
    expect(h.named('returns.label.created').find((e) => e.returnId === m.ret.id)).toMatchObject({ paidBy: 'seller', cost: { amount: 650 }, customerId: m.customerId, contactEmail: 'sam@example.com' });

    const label = await h.call('GET', `/api/store/returns/requests/${m.ret.id}/label?near=97201`, m.token);
    expect(label.status).toBe(200);
    expect(label.body).toMatchObject({ method: 'prepaid_qr', qrCodeUrl: 'https://labels.example/return-qr.png' });
    expect(label.body.instructions.length).toBeGreaterThan(0);
    expect((await h.call('POST', `/api/store/returns/requests/${m.ret.id}/label/email`, m.token)).status).toBe(204);
    expect(h.calls.notices.at(-1)).toMatchObject({ topic: 'customer.return.label_ready', recipients: [{ kind: 'customer', accountId: m.customerId }] });

    const shipmentId = ok.body.detail.shipment.shippingShipmentId;
    await h.publish('shipping', 'shipping.shipment.dispatched', { shipmentId, kind: 'return', orderId: m.order.id, groupId: m.order.groups[0]!.id, returnId: m.ret.id, ownerType: 'seller', sellerId: m.sellerA, lines: [], shippedAt: now(), dispatchDueAt: null, onTime: null, trackingValid: true, estimatedArrival: null });
    let detail = await h.call('GET', `/api/store/returns/requests/${m.ret.id}`, m.token);
    expect(detail.body).toMatchObject({ status: 'in_transit', statusLabel: 'Sent back', shipment: { status: 'in_transit' } });
    expect(h.named('returns.return.shipped').find((e) => e.returnId === m.ret.id)).toBeTruthy();
    expect((await h.call('POST', `/api/store/returns/requests/${m.ret.id}/withdraw`, m.token, {})).status).toBe(409);

    const received = await h.call('POST', `/api/seller/returns/requests/${m.ret.id}/receive`, m.seller, {});
    expect(received.body.detail.status).toBe('received');
    expect(received.body.inspectionChecklist.items.length).toBeGreaterThan(0);
    expect(h.named('returns.return.received').find((e) => e.returnId === m.ret.id)).toMatchObject({
      ownerType: 'seller',
      sellerId: m.sellerA,
      customerId: m.customerId,
      contactEmail: 'sam@example.com',
      items: [{ orderItemId: m.items[0]![0]!, quantity: 2, variantId: m.pa.variantId, stockItemId: m.pa.stockItemId }],
    });
    expect((await h.orders.getOrder(m.order.id))!.groups[0]!.items[0]!.state).toBe('returned');

    const draft = await h.call('PUT', `/api/seller/returns/requests/${m.ret.id}/inspection-draft`, m.seller, { inspection: { grade: 'good' }, remedy: { kind: 'full_refund' } });
    expect(draft.status).toBe(200);
    expect((await h.call('GET', `/api/seller/returns/requests/${m.ret.id}`, m.seller)).body.inspectionDraft).toMatchObject({ inspection: { grade: 'good' } });
    const inspected = await h.call('POST', `/api/seller/returns/requests/${m.ret.id}/inspection`, m.seller, { conditionOutcome: 'as_described', grade: 'good', proposedStockOutcome: 'restock', checks: [{ label: 'Powers on', passed: true }] });
    expect(inspected.status, JSON.stringify(inspected.body)).toBe(200);
    expect(inspected.body).toMatchObject({ detail: { status: 'awaiting_remedy', statusLabel: 'Inspected' }, inspection: { conditionOutcome: 'as_described', grade: 'good' }, inspectionDraft: null });
    expect(h.named('returns.return.inspected').filter((e) => e.returnId === m.ret.id)).toEqual([expect.objectContaining({ orderItemId: m.items[0]![0]!, variantId: m.pa.variantId, stockItemId: m.pa.stockItemId, quantity: 2, proposedStockOutcome: 'restock', customerId: m.customerId, contactEmail: 'sam@example.com' })]);

    const partial = await h.call('POST', `/api/seller/returns/requests/${m.ret.id}/remedy`, m.seller, { kind: 'partial_refund' }, idem());
    expect(partial.status).toBe(400);
    const tooMuch = await h.call('POST', `/api/seller/returns/requests/${m.ret.id}/remedy`, m.seller, { kind: 'partial_refund', amount: { amount: 99999, currency: 'USD' }, deductions: [{ label: 'Scratch', amount: { amount: 100, currency: 'USD' }, reason: 'Scratched lid' }] }, idem());
    expect(tooMuch.body.error).toMatchObject({ code: 'REFUND_EXCEEDS_REFUNDABLE', details: { maxRefundable: { amount: 12000 } } });

    const refund = await h.call('POST', `/api/seller/returns/requests/${m.ret.id}/remedy`, m.seller, { kind: 'full_refund' }, idem());
    expect(refund.status, JSON.stringify(refund.body)).toBe(200);
    expect(refund.body.refundRequest).toMatchObject({ source: 'seller', status: 'processing', fundedBy: 'seller', breakdown: { total: { amount: 12000 }, shippingRefund: { amount: 400 } } });
    expect(refund.body.detail.refund).toMatchObject({ status: 'processing', statusLabel: 'Processing' });
    expect(refund.body.detail.status).toBe('awaiting_remedy');
    const startRefund = h.calls.refunds.at(-1)!;
    expect(startRefund).toMatchObject({ orderId: m.order.id, origin: 'return', originId: refund.body.refundRequest.id, destination: 'original_method' });
    expect(startRefund.items.reduce((s, i) => s + i.amount.amount, 0)).toBe(12000);
    expect(h.named('returns.refund.approved').find((e) => e.returnId === m.ret.id)).toMatchObject({ source: 'seller', total: { amount: 12000 }, approvedBy: { kind: 'seller' }, customerId: m.customerId, contactEmail: 'sam@example.com' });
    expect((await h.call('POST', `/api/seller/returns/requests/${m.ret.id}/remedy`, m.seller, { kind: 'full_refund' }, idem())).body.error.code).toBe('DUPLICATE_REFUND');

    await h.publish('payments', 'payments.refund.sent', { refundId: newId(), ref: refund.body.refundRequest.ref, orderId: m.order.id, origin: 'return', originId: refund.body.refundRequest.id, amount: { amount: 12000, currency: 'USD' }, items: startRefund.items.map((i) => ({ ...i, title: 'Headphones', groupId: m.order.groups[0]!.id })), destination: 'Visa •••• 4417', sentAt: now() });
    detail = await h.call('GET', `/api/store/returns/requests/${m.ret.id}`, m.token);
    expect(detail.body).toMatchObject({ status: 'completed', statusLabel: 'Refunded', refund: { status: 'sent' } });
    expect(h.named('returns.return.completed').find((e) => e.returnId === m.ret.id)).toMatchObject({ outcome: 'refunded' });
    // a second delivery of the event changes nothing
    await h.publish('payments', 'payments.refund.sent', { refundId: newId(), ref: refund.body.refundRequest.ref, orderId: m.order.id, origin: 'return', originId: refund.body.refundRequest.id, amount: { amount: 12000, currency: 'USD' }, items: startRefund.items.map((i) => ({ ...i, title: 'Headphones', groupId: m.order.groups[0]!.id })), destination: 'Visa •••• 4417', sentAt: now() });
    expect(h.named('returns.return.completed').filter((e) => e.returnId === m.ret.id)).toHaveLength(1);
  });

  it('rejects with an explanation and lets the customer ask Marketly to step in', async () => {
    const m = await requested('changed_mind');
    const early = await h.call('POST', `/api/store/returns/requests/${m.ret.id}/escalate`, m.token, { reason: 'seller_no_response' });
    expect(early.body.error.code).toBe('ESCALATION_NOT_AVAILABLE');
    expect(early.body.error.details.availableFrom).toBeTruthy();
    const rejected = await h.call('POST', `/api/seller/returns/requests/${m.ret.id}/reject`, m.seller, { reasonCode: 'damaged_by_customer', explanation: 'The hinge was glued' });
    expect(rejected.body.detail).toMatchObject({ status: 'rejected', decision: { kind: 'rejected', reasonCode: 'damaged_by_customer' } });
    expect(h.named('returns.return.rejected').find((e) => e.returnId === m.ret.id)).toMatchObject({ reasonCode: 'damaged_by_customer', platformDecision: false, customerId: m.customerId, contactEmail: 'sam@example.com' });
    const esc = await h.call('POST', `/api/store/returns/requests/${m.ret.id}/escalate`, m.token, { reason: 'customer_disagrees', note: 'It was broken on arrival' });
    expect(esc.status, JSON.stringify(esc.body)).toBe(200);
    expect(esc.body).toMatchObject({ handledBy: 'marketplace_support', escalation: { reason: 'customer_disagrees', caseRef: 'CS-000123' } });
    expect(h.calls.cases.at(-1)).toMatchObject({ kind: 'dispute', returnId: m.ret.id });
    expect(h.named('returns.return.escalated').find((e) => e.returnId === m.ret.id)).toMatchObject({ reason: 'customer_disagrees', by: { kind: 'customer' } });
    const seller = await h.call('GET', `/api/seller/returns/requests/${m.ret.id}`, m.seller);
    expect(seller.body.flags.map((f: any) => f.kind)).toEqual(expect.arrayContaining(['customer_escalated', 'dispute_open', 'platform_took_over']));
  });

  it('lets the customer withdraw and send it back themselves for a change of mind', async () => {
    const m = await requested('changed_mind');
    const ok = await h.call('POST', `/api/seller/returns/requests/${m.ret.id}/approve`, m.seller, { labelMethod: 'customer_arranged' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.detail.shipment).toMatchObject({ method: 'customer_arranged', paidBy: 'customer', labelUrl: null });
    expect(h.named('returns.label.created').find((e) => e.returnId === m.ret.id)).toBeUndefined();
    const tracked = await h.call('POST', `/api/store/returns/requests/${m.ret.id}/shipment`, m.token, { carrier: 'usps', trackingNumber: '9400100000000000000000' });
    expect(tracked.status, JSON.stringify(tracked.body)).toBe(200);
    expect(tracked.body).toMatchObject({ status: 'in_transit', shipment: { status: 'in_transit', trackingNumber: '9400100000000000000000' } });
    expect(h.calls.tracking.at(-1)).toMatchObject({ returnId: m.ret.id, trackingNumber: '9400100000000000000000' });

    const other = await requested('changed_mind');
    const withdrawn = await h.call('POST', `/api/store/returns/requests/${other.ret.id}/withdraw`, other.token, { reason: 'Kept it' });
    expect(withdrawn.body).toMatchObject({ status: 'cancelled', statusLabel: 'Cancelled' });
    expect(h.named('returns.return.cancelled').find((e) => e.returnId === other.ret.id)).toMatchObject({ reason: 'Kept it', by: { kind: 'customer' } });
    expect((await h.orders.getOrder(other.order.id))!.groups[0]!.items[0]!.state).toBe('delivered');
  });

  it('refunds without return as the seller with a recorded reason', async () => {
    const m = await requested();
    const res = await h.call('POST', `/api/seller/returns/requests/${m.ret.id}/approve-without-return`, m.seller, { reasonCode: 'return_cost_exceeds_value', details: 'Shipping costs more than the item', remedy: { kind: 'full_refund' } }, idem());
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.detail).toMatchObject({ status: 'awaiting_remedy', statusLabel: 'Approved without return', decision: { kind: 'approved_without_return' } });
    expect(res.body.refundRequest).toMatchObject({ status: 'processing', source: 'seller' });
    expect(res.body.exception).toMatchObject({ reasonCode: 'return_cost_exceeds_value', approvedBy: { kind: 'seller' } });
    expect(h.named('returns.exception.approved').find((e) => e.returnId === m.ret.id)).toBeTruthy();
    expect(h.named('returns.return.approved').find((e) => e.returnId === m.ret.id)).toMatchObject({ withoutReturn: true });
  });

  it('serves the seller queue, lists and evidence', async () => {
    const m = await requested();
    const counts = await h.call('GET', '/api/seller/returns/requests/counts', m.seller);
    expect(counts.body).toMatchObject({ awaitingResponse: 1, responseOverdue: 0, tabs: { requests: 1 } });
    const list = await h.call('GET', '/api/seller/returns/requests?tab=requests', m.seller);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({ id: m.ret.id, statusLabel: 'Return requested', amount: { amount: 12000 } });
    const ev = await h.call('POST', `/api/seller/returns/requests/${m.ret.id}/evidence`, m.seller, { kind: 'other', mediaIds: [], note: 'Customer called us' });
    expect(ev.status, JSON.stringify(ev.body)).toBe(201);
    expect(ev.body).toMatchObject({ party: 'seller', note: 'Customer called us' });
    expect(await h.service.listEvidence(m.ret.id)).toHaveLength(1);
    expect(h.audits.at(-1)).toMatchObject({ action: 'returns.evidence.add' });
    const exp = await h.call('POST', '/api/seller/returns/requests/exports', m.seller, { filters: { tab: 'requests' } });
    expect(exp.status).toBe(202);
    expect(h.calls.exports.at(-1)).toMatchObject({ dataset: 'returns.seller.requests', sellerId: m.sellerA });
    const rows = await h.service.exportRows('returns.seller.requests', { tab: 'requests' }, { kind: 'seller', sellerId: m.sellerA, audience: 'seller', sessionId: 's' } as never);
    expect(rows.rows).toHaveLength(1);
    const overview = await h.call('GET', '/api/store/returns/requests/overview', m.token);
    expect(overview.body).toMatchObject({ openReturns: 1 });
  });
});
