/**
 * Staff: Official Store returns (auto-approval, warehouse receipt, inspection queue, remedy), Finance
 * approval of refund requests with limits through access, exception refunds from the order page, platform
 * interventions (take over, overturn, assign, refund without return) and the queues.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { OFFICIAL_STORE_ID } from '../../../spec/common.js';
import { group, harness, idem, line, now, placeOrder, product, tokens, type Harness } from './helpers.js';

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

async function officialReturn(reason = 'defective') {
  const p = product(h, { title: 'Kettle', price: 5000, ownerType: 'official' });
  const m = await placeOrder(h, [group(h, [line(p, 1, { tax: 400 })], { ownerType: 'official' })]);
  const token = tokens.customer(m.customerId);
  const res = await h.call('POST', '/api/store/returns/requests', token, { orderId: m.order.id, items: [{ orderItemId: m.items[0]![0]!, quantity: 1 }], reason, details: 'Stopped heating', remedy: 'refund' }, idem());
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return { ...m, p, token, ret: res.body.returns[0] };
}

async function sellerReturn(reason = 'damaged') {
  const sellerId = newId();
  const p = product(h, { title: 'Vase', price: 4000, sellerId });
  const m = await placeOrder(h, [group(h, [line(p, 1)], { sellerId })]);
  const token = tokens.customer(m.customerId);
  const res = await h.call('POST', '/api/store/returns/requests', token, { orderId: m.order.id, items: [{ orderItemId: m.items[0]![0]!, quantity: 1 }], reason, details: 'Cracked', remedy: 'refund' }, idem());
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return { ...m, p, sellerId, token, ret: res.body.returns[0], seller: tokens.seller(sellerId) };
}

describe('Official Store returns', () => {
  it('approves automatically inside the window, with Marketly paying the label', async () => {
    const m = await officialReturn();
    expect(m.ret).toMatchObject({ status: 'approved', handledBy: 'official_store', seller: { ownerType: 'official', id: null }, shipment: { paidBy: 'platform', method: 'prepaid_qr' } });
    // the Official Store return address is the officialReturnAddress setting (default)
    expect(h.calls.labels.at(-1)).toMatchObject({ returnId: m.ret.id, billedTo: 'company', to: { name: 'Marketly Returns', line1: '1250 Logistics Way', city: 'Reno' } });
    expect(h.named('returns.return.approved').find((e) => e.returnId === m.ret.id)).toMatchObject({ ownerType: 'official', sellerId: null, platformDecision: false });
  });

  it('is received at the dock, inspected from the queue and refunded after Finance approval', async () => {
    const m = await officialReturn();
    const arriving = await h.call('GET', '/api/admin/returns/inspections?tab=arriving', staff());
    expect(arriving.body.items.map((r: any) => r.returnId)).toContain(m.ret.id);
    const scanned = await h.service.recordWarehouseReceipt(m.ret.id, now(), { kind: 'staff', id: newId(), name: 'Dock' }, null);
    expect(scanned.status).toBe('received');
    await h.service.recordWarehouseReceipt(m.ret.id, now(), { kind: 'staff', id: newId() }, null); // a second scan is harmless
    await h.app.kernel.events.drain();
    expect(h.named('returns.return.received').filter((e) => e.returnId === m.ret.id)).toHaveLength(1);
    const stats = await h.call('GET', '/api/admin/returns/inspections/stats', staff());
    expect(stats.body.waiting).toBeGreaterThanOrEqual(1);

    const me = newId();
    const inspector = tokens.staff(['returns.inspections.record'], { sub: me });
    const other = await h.call('POST', `/api/admin/returns/requests/${m.ret.id}/start-inspection`, inspector, { inspectorId: newId() });
    expect(other.status).toBe(403);
    const started = await h.call('POST', `/api/admin/returns/requests/${m.ret.id}/start-inspection`, inspector, {});
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    expect(started.body).toMatchObject({ status: 'Inspecting', inspector: { kind: 'staff', id: me } });
    expect((await h.call('POST', `/api/admin/returns/requests/${m.ret.id}/start-inspection`, inspector, {})).status).toBe(200);
    const draft = await h.call('PUT', `/api/admin/returns/requests/${m.ret.id}/inspection-draft`, inspector, { inspection: { checks: [{ label: 'Heats up', passed: false }] } });
    expect(draft.body.savedBy).toMatchObject({ id: me });
    const inspected = await h.call('POST', `/api/admin/returns/requests/${m.ret.id}/inspection`, inspector, { conditionOutcome: 'as_described', grade: 'damaged', proposedStockOutcome: 'return_to_supplier', checks: [{ label: 'Heats up', passed: false }] });
    expect(inspected.status, JSON.stringify(inspected.body)).toBe(200);
    expect(h.named('returns.return.inspected').find((e) => e.returnId === m.ret.id)).toMatchObject({ ownerType: 'official', orderItemId: m.items[0]![0]!, variantId: m.p.variantId, stockItemId: m.p.stockItemId, quantity: 1, proposedStockOutcome: 'return_to_supplier' });
    expect(h.audits.at(-1)).toMatchObject({ action: 'returns.inspection.record' });

    const remedy = await h.call('POST', `/api/admin/returns/requests/${m.ret.id}/remedy`, staff(), { kind: 'full_refund' }, idem());
    expect(remedy.status, JSON.stringify(remedy.body)).toBe(200);
    expect(remedy.body.refundRequest).toMatchObject({ source: 'return', status: 'under_review', fundedBy: 'official_store', breakdown: { total: { amount: 5400 } } });
    const rr = remedy.body.refundRequest;
    expect(h.named('returns.refund.requested').find((e) => e.refundRequestId === rr.id)).toMatchObject({ source: 'return', total: { amount: 5400 } });
    expect(h.calls.refunds.find((r) => r.originId === rr.id)).toBeUndefined();

    const queue = await h.call('GET', '/api/admin/returns/refunds?status=under_review', staff());
    expect(queue.body.items.map((r: any) => r.id)).toContain(rr.id);

    h.authority.decision = 'approval_required';
    const above = await h.call('POST', `/api/admin/returns/refunds/${rr.id}/approve`, staff(), {}, idem());
    // saved pending approval: 200 with the approval in the body (FORMAT.md, Approval responses)
    expect(above.status).toBe(200);
    expect(above.body).toMatchObject({ id: rr.id, status: 'under_review', approval: { required: true } });
    expect(h.calls.approvals.at(-1)).toMatchObject({ action: 'returns.refunds.approve', amount: { amount: 5400 }, target: { type: 'refund_request', id: rr.id } });
    const pending = await h.call('GET', `/api/admin/returns/refunds/${rr.id}`, staff());
    expect(pending.body).toMatchObject({ status: 'under_review', approval: { required: true } });

    // the approver decides in access
    const approvalId = above.body.approval.approvalRequestId;
    await h.publish('access', 'access.approval.decided', { requestId: approvalId, ref: 'AP-1', actionKey: 'returns.refunds.approve', module: 'returns', target: { type: 'refund_request', id: rr.id }, outcome: 'approved', decidedBy: { kind: 'staff', id: newId(), name: 'Olivia Owner' }, reason: null, amount: { amount: 5400, currency: 'USD' }, approverIds: [], requestedById: newId() });
    const approved = await h.call('GET', `/api/admin/returns/refunds/${rr.id}`, staff());
    expect(approved.body).toMatchObject({ status: 'processing', approvedBy: { name: 'Olivia Owner' } });
    expect(h.calls.refunds.find((r) => r.originId === rr.id)).toMatchObject({ origin: 'return', orderId: m.order.id });
    expect(h.named('returns.refund.approved').find((e) => e.refundRequestId === rr.id)).toMatchObject({ source: 'return', ownerType: 'official', fundedBy: 'official_store' });
    const store = await h.call('GET', `/api/store/returns/requests/${m.ret.id}`, m.token);
    expect(store.body.refund).toMatchObject({ status: 'processing', explanation: expect.any(String) });
    expect(store.body.status).toBe('awaiting_remedy');

    await h.publish('payments', 'payments.refund.failed', { refundId: newId(), ref: rr.ref, orderId: m.order.id, origin: 'return', originId: rr.id, amount: { amount: 5400, currency: 'USD' }, reason: 'Card closed', attempts: 1, finalAttempt: false });
    const failed = await h.call('GET', `/api/admin/returns/requests/${m.ret.id}`, staff());
    expect(failed.body.refundRequest).toMatchObject({ status: 'failed', failedReason: 'Card closed' });
    expect(failed.body.flags.map((f: any) => f.kind)).toContain('refund_failed');
  });

  it('declines, revises and approves within the limit', async () => {
    const m = await officialReturn();
    await h.service.recordWarehouseReceipt(m.ret.id, now(), { kind: 'staff', id: newId() }, null);
    await h.call('POST', `/api/admin/returns/requests/${m.ret.id}/inspection`, staff(), { conditionOutcome: 'missing_parts', grade: 'good', missingParts: ['Lid'], proposedStockOutcome: 'repair' });
    const remedy = await h.call('POST', `/api/admin/returns/requests/${m.ret.id}/remedy`, staff(), { kind: 'full_refund' }, idem());
    const rr = remedy.body.refundRequest;
    const declined = await h.call('POST', `/api/admin/returns/refunds/${rr.id}/decline`, staff(), { reason: 'The lid is missing; deduct it' });
    expect(declined.body).toMatchObject({ status: 'declined', declineReason: 'The lid is missing; deduct it' });
    expect(h.named('returns.refund.declined').find((e) => e.refundRequestId === rr.id)).toBeTruthy();
    expect((await h.call('POST', `/api/admin/returns/refunds/${rr.id}/decline`, staff(), { reason: 'again' })).status).toBe(409);
    const revised = await h.call('POST', `/api/admin/returns/refunds/${rr.id}/revise`, staff(), { kind: 'partial_refund', deductions: [{ label: 'Missing lid', amount: { amount: 900, currency: 'USD' }, reason: 'The lid was not returned' }] });
    expect(revised.status, JSON.stringify(revised.body)).toBe(200);
    expect(revised.body).toMatchObject({ status: 'under_review', breakdown: { total: { amount: 4500 }, deductions: [{ label: 'Missing lid' }] } });
    const ok = await h.call('POST', `/api/admin/returns/refunds/${rr.id}/approve`, staff(), { note: 'OK' }, idem());
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.status).toBe('processing');
    expect(h.audits.some((a) => a.action === 'returns.refund.approve' && a.target.id === rr.id)).toBe(true);
    // approving again is harmless (idempotent)
    expect((await h.call('POST', `/api/admin/returns/refunds/${rr.id}/approve`, staff(), {}, idem())).body.status).toBe('processing');
    const sent = h.calls.refunds.find((r) => r.originId === rr.id)!;
    await h.publish('payments', 'payments.refund.sent', { refundId: newId(), ref: rr.ref, orderId: m.order.id, origin: 'return', originId: rr.id, amount: { amount: 4500, currency: 'USD' }, items: sent.items.map((i) => ({ ...i, title: 'Kettle', groupId: m.order.groups[0]!.id })), destination: 'Visa', sentAt: now() });
    const done = await h.call('GET', `/api/store/returns/requests/${m.ret.id}`, m.token);
    expect(done.body).toMatchObject({ status: 'completed', statusLabel: 'Partly refunded' });
    expect(h.named('returns.return.completed').find((e) => e.returnId === m.ret.id)).toMatchObject({ outcome: 'partly_refunded' });
  });

  it('sends a replacement when stock allows and completes once it ships', async () => {
    const m = await officialReturn();
    await h.service.recordWarehouseReceipt(m.ret.id, now(), { kind: 'staff', id: newId() }, null);
    await h.call('POST', `/api/admin/returns/requests/${m.ret.id}/inspection`, staff(), { conditionOutcome: 'as_described', grade: 'like_new', proposedStockOutcome: 'restock' });
    const none = await h.call('POST', `/api/admin/returns/requests/${m.ret.id}/remedy`, staff(), { kind: 'replacement' }, idem());
    expect(none.body.error.code).toBe('REMEDY_NOT_AVAILABLE');
    h.stock.set(m.p.stockItemId, 5);
    const rep = await h.call('POST', `/api/admin/returns/requests/${m.ret.id}/remedy`, staff(), { kind: 'replacement' }, idem());
    expect(rep.status, JSON.stringify(rep.body)).toBe(200);
    expect(rep.body.detail.replacement).toMatchObject({ kind: 'replacement', status: 'reserved', quantity: 1 });
    const created = h.named('returns.replacement.created').find((e) => e.returnId === m.ret.id);
    expect(created).toMatchObject({ orderId: m.order.id, ownerType: 'official', variantId: m.p.variantId, offerId: m.p.offerId, quantity: 1, kind: 'replacement' });
    // orders adds the zero-charge replacement line
    expect((await h.orders.getOrder(m.order.id))!.groups[0]!.items.some((i) => i.replacementOfItemId === m.items[0]![0]!)).toBe(true);
    await h.publish('shipping', 'shipping.shipment.dispatched', { shipmentId: newId(), kind: 'replacement', orderId: m.order.id, groupId: m.order.groups[0]!.id, returnId: m.ret.id, ownerType: 'official', fulfilledBy: 'official_warehouse', sellerId: null, lines: [], shippedAt: now(), dispatchDueAt: null, onTime: true, trackingValid: true, estimatedArrival: null });
    const done = await h.call('GET', `/api/store/returns/requests/${m.ret.id}`, m.token);
    expect(done.body).toMatchObject({ status: 'completed', statusLabel: 'Replaced', replacement: { status: 'shipped' } });
    expect(h.named('returns.return.completed').find((e) => e.returnId === m.ret.id)).toMatchObject({ outcome: 'replaced' });
  });
});

describe('platform interventions', () => {
  it('takes over, decides for the seller and keeps the seller informed', async () => {
    const m = await sellerReturn();
    const remedy = await h.call('POST', `/api/admin/returns/requests/${m.ret.id}/remedy`, staff(), { kind: 'full_refund' }, idem());
    expect(remedy.status).toBe(409);
    const ownerId = newId();
    const took = await h.call('POST', `/api/admin/returns/requests/${m.ret.id}/take-over`, staff(), { reason: 'seller_no_response', note: 'Seller unreachable', ownerId });
    expect(took.status, JSON.stringify(took.body)).toBe(200);
    expect(took.body).toMatchObject({ owner: { id: ownerId }, detail: { handledBy: 'marketplace_support' } });
    expect(h.named('returns.return.escalated').find((e) => e.returnId === m.ret.id)).toMatchObject({ reason: 'seller_no_response', by: { kind: 'staff' } });
    expect(h.audits.at(-1)).toMatchObject({ action: 'returns.return.take-over', reason: 'Seller unreachable' });
    const sellerView = await h.call('GET', `/api/seller/returns/requests/${m.ret.id}`, m.seller);
    expect(sellerView.status).toBe(200);
    expect((await h.call('GET', '/api/seller/returns/requests', m.seller)).body.items[0]).toMatchObject({ id: m.ret.id, statusLabel: 'Escalated', platformInvolved: true });
    const blocked = await h.call('POST', `/api/seller/returns/requests/${m.ret.id}/approve`, m.seller, { labelMethod: 'prepaid_qr' });
    expect(blocked.body.error.code).toBe('RESPONSE_DEADLINE_PASSED');
    const approve = await h.call('POST', `/api/admin/returns/requests/${m.ret.id}/approve`, staff(), { labelMethod: 'prepaid_label', reason: 'Platform decision' });
    expect(approve.status, JSON.stringify(approve.body)).toBe(200);
    expect(approve.body.detail.decision).toMatchObject({ platformDecision: true });
    expect(h.named('returns.return.approved').find((e) => e.returnId === m.ret.id)).toMatchObject({ platformDecision: true });
    const assigned = await h.call('POST', `/api/admin/returns/requests/${m.ret.id}/assign`, staff(), { ownerId: newId(), note: 'Your queue' });
    expect(assigned.body.owner.name).toBe('Rita Returns');
    const received = await h.call('POST', `/api/admin/returns/requests/${m.ret.id}/receive`, staff(), { trackingNumber: '1ZX' });
    expect(received.status, JSON.stringify(received.body)).toBe(200);
    expect(received.body.detail.status).toBe('received');
  });

  it('overturns a seller rejection with or without the item coming back', async () => {
    const a = await sellerReturn('changed_mind');
    await h.call('POST', `/api/seller/returns/requests/${a.ret.id}/reject`, a.seller, { reasonCode: 'outside_window', explanation: 'Too late' });
    expect((await h.call('POST', `/api/admin/returns/requests/${a.ret.id}/overturn`, staff(), { withoutReturn: false, reason: 'Inside the window', labelMethod: 'customer_arranged' })).status).toBe(200);
    const view = await h.call('GET', `/api/admin/returns/requests/${a.ret.id}`, staff());
    expect(view.body.detail).toMatchObject({ status: 'approved', decision: { kind: 'overturned', platformDecision: true }, shipment: { method: 'customer_arranged' } });

    const b = await sellerReturn();
    await h.call('POST', `/api/seller/returns/requests/${b.ret.id}/reject`, b.seller, { reasonCode: 'damaged_by_customer', explanation: 'Dropped' });
    const without = await h.call('POST', `/api/admin/returns/requests/${b.ret.id}/overturn`, staff(), { withoutReturn: true, reason: 'Photos show transit damage' });
    expect(without.body.detail).toMatchObject({ status: 'awaiting_remedy', statusLabel: 'Approved without return' });
    expect(h.named('returns.return.approved').find((e) => e.returnId === b.ret.id)).toMatchObject({ withoutReturn: true, platformDecision: true });
    expect((await h.call('POST', `/api/admin/returns/requests/${b.ret.id}/overturn`, staff(), { withoutReturn: true, reason: 'again' })).status).toBe(409);
    const remedy = await h.call('POST', `/api/admin/returns/requests/${b.ret.id}/remedy`, staff(), { kind: 'full_refund' }, idem());
    expect(remedy.body.refundRequest).toMatchObject({ status: 'under_review', fundedBy: 'seller' });
  });

  it('proposes refund without return for Finance and approves the exception with the refund', async () => {
    const m = await sellerReturn();
    const res = await h.call('POST', `/api/admin/returns/requests/${m.ret.id}/approve-without-return`, staff(), { reasonCode: 'unsafe_to_ship', details: 'Shattered glass', remedy: { kind: 'full_refund' } }, idem());
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ detail: { status: 'awaiting_remedy' }, exception: { reasonCode: 'unsafe_to_ship', approvedBy: null, stockOutcome: 'write_off' }, refundRequest: { status: 'under_review' } });
    expect(res.body.flags.map((f: any) => f.kind)).toContain('refund_without_return_proposed');
    expect(h.named('returns.exception.proposed').find((e) => e.returnId === m.ret.id)).toMatchObject({ reasonCode: 'unsafe_to_ship' });
    const ok = await h.call('POST', `/api/admin/returns/refunds/${res.body.refundRequest.id}/approve`, staff(), {}, idem());
    expect(ok.body.status).toBe('processing');
    expect(h.named('returns.exception.approved').find((e) => e.returnId === m.ret.id)).toMatchObject({ approvedBy: { kind: 'staff' } });
    const after = await h.call('GET', `/api/admin/returns/requests/${m.ret.id}`, staff());
    expect(after.body.flags.map((f: any) => f.kind)).toContain('refund_without_return_approved');
  });
});

describe('exception refunds from the order page', () => {
  it('approves within the limit, caps by what is refundable and guards duplicates', async () => {
    const sellerId = newId();
    const p = product(h, { title: 'Chair', price: 8000, sellerId });
    const m = await placeOrder(h, [group(h, [line(p, 1, { shipping: 500 })], { sellerId })]);
    const body = { orderId: m.order.id, items: [{ orderItemId: m.items[0]![0]!, quantity: 1, amount: { amount: 2000, currency: 'USD' } }], reasonCode: 'late_delivery', reason: 'Arrived a week late', fundedBy: 'shared' };
    const over = await h.call('POST', '/api/admin/returns/refunds', staff(), { ...body, items: [{ ...body.items[0], amount: { amount: 9000, currency: 'USD' } }] }, idem());
    expect(over.body.error).toMatchObject({ code: 'REFUND_EXCEEDS_REFUNDABLE', details: { maxRefundable: { amount: 8500 } } });
    const key = idem();
    const res = await h.call('POST', '/api/admin/returns/refunds', staff(), body, key);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ source: 'exception', status: 'processing', fundedBy: 'shared', sellerShare: { amount: 1000 }, platformShare: { amount: 1000 }, customerName: 'Sam Rivera' });
    expect(h.named('returns.refund.requested').find((e) => e.refundRequestId === res.body.id)).toMatchObject({ source: 'exception' });
    expect(h.named('returns.refund.approved').find((e) => e.refundRequestId === res.body.id)).toMatchObject({ source: 'exception', returnId: null });
    expect(h.calls.refunds.find((r) => r.originId === res.body.id)).toMatchObject({ origin: 'exception' });
    expect(h.audits.some((a) => a.action === 'returns.refund.issue')).toBe(true);
    const dup = await h.call('POST', '/api/admin/returns/refunds', staff(), body, idem());
    expect(dup.body.error).toMatchObject({ code: 'DUPLICATE_REFUND', details: { refundRequestId: res.body.id } });
    const credit = await h.call('POST', '/api/admin/returns/refunds', staff(), { ...body, destination: 'store_credit' }, idem());
    expect(credit.body.error.code).toBe('REMEDY_NOT_AVAILABLE');
    expect((await h.service.listRefundRequestsForOrder(m.order.id)).map((r) => r.id)).toContain(res.body.id);
  });

  it('queues the request when the amount is above the caller limit', async () => {
    h.authority.decision = 'approval_required';
    const sellerId = newId();
    const p = product(h, { title: 'Desk', price: 30000, sellerId });
    const m = await placeOrder(h, [group(h, [line(p, 1)], { sellerId })]);
    const res = await h.call('POST', '/api/admin/returns/refunds', staff(), { orderId: m.order.id, items: [{ orderItemId: m.items[0]![0]!, quantity: 1, amount: { amount: 30000, currency: 'USD' } }], reasonCode: 'damaged_not_returned', reason: 'Broken in transit', fundedBy: 'platform' }, idem());
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ status: 'under_review', approval: { required: true } });
    expect(h.calls.approvals.at(-1)).toMatchObject({ action: 'returns.refunds.approve', amount: { amount: 30000 } });
  });

  it('takes case refunds from support into the Finance queue', async () => {
    const sellerId = newId();
    const p = product(h, { title: 'Rug', price: 7000, sellerId });
    const m = await placeOrder(h, [group(h, [line(p, 1)], { sellerId })]);
    const caseId = newId();
    const rr = await h.service.requestRefund({
      source: 'case',
      caseId,
      orderId: m.order.id,
      orderItemIds: [m.items[0]![0]!],
      breakdown: { itemAmount: { amount: 7000, currency: 'USD' }, discountShare: { amount: 0, currency: 'USD' }, shippingRefund: { amount: 0, currency: 'USD' }, returnShippingDeduction: { amount: 0, currency: 'USD' }, deductions: [], total: { amount: 3500, currency: 'USD' }, maxRefundable: { amount: 7000, currency: 'USD' }, destination: 'Visa', isEstimate: false },
      fundedBy: 'seller',
      reason: 'Partial refund decided in the case',
      proposedBy: { kind: 'staff', id: newId() },
    });
    expect(rr).toMatchObject({ source: 'case', status: 'under_review', caseId, breakdown: { total: { amount: 3500 } } });
    expect((await h.service.listRefundRequestsForCase(caseId)).map((r) => r.id)).toEqual([rr.id]);
    // the same decision again returns the same request
    expect((await h.service.requestRefund({ source: 'case', caseId, orderId: m.order.id, orderItemIds: [m.items[0]![0]!], breakdown: rr.breakdown, fundedBy: 'seller', reason: 'again', proposedBy: { kind: 'system' } })).id).toBe(rr.id);
  });
});

describe('queues and views', () => {
  it('serves stats, lists with tabs and GraphQL', async () => {
    const m = await sellerReturn();
    const stats = await h.call('GET', '/api/admin/returns/requests/stats', staff());
    expect(stats.status).toBe(200);
    expect(stats.body.open).toBeGreaterThan(0);
    expect(stats.body.queueOwner.lead).toBe('Rita Returns');
    const list = await h.call('GET', `/api/admin/returns/requests?tab=needs_decision&sellerId=${m.sellerId}`, staff());
    expect(list.body.items.map((r: any) => r.id)).toEqual([m.ret.id]);
    expect(list.body.items[0]).toMatchObject({ seller: { ownerType: 'seller', id: m.sellerId }, status: 'Return requested' });
    const byOrder = await h.call('GET', `/api/admin/returns/requests?orderId=${m.order.id}`, staff());
    expect(byOrder.body.items).toHaveLength(1);

    const store = await h.gql('store', m.token, 'query($ref: String!) { return(ref: $ref) { id ref status statusLabel items { title options { name value } unitPrice { formatted } } terms { windowDays source } actions } }', { ref: m.ret.ref });
    expect(store.errors, JSON.stringify(store.errors)).toBeUndefined();
    expect(store.data.return).toMatchObject({ id: m.ret.id, status: 'REQUESTED', items: [{ title: 'Vase', options: [{ name: 'Color', value: 'Teal' }] }], terms: { windowDays: 30 } });
    const other = await h.gql('store', tokens.customer(newId()), 'query($ref: String!) { return(ref: $ref) { id } }', { ref: m.ret.ref });
    expect(other.data.return).toBeNull();
    const seller = await h.gql('seller', m.seller, 'query($ref: String!) { sellerReturn(ref: $ref) { id status allowedActions deadlines { respondBy { state } } payment { itemPaid { amount } } } }', { ref: m.ret.ref });
    expect(seller.errors, JSON.stringify(seller.errors)).toBeUndefined();
    expect(seller.data.sellerReturn).toMatchObject({ id: m.ret.id, allowedActions: expect.arrayContaining(['approve']), payment: { itemPaid: { amount: 4000 } } });
    const admin = await h.gql('admin', staff(), 'query($ref: String!) { returnAdmin(ref: $ref) { id flags { kind } owner { id } } refundRequests(status: UNDER_REVIEW) { total items { id status } } }', { ref: m.ret.ref });
    expect(admin.errors, JSON.stringify(admin.errors)).toBeUndefined();
    expect(admin.data.returnAdmin.id).toBe(m.ret.id);
    const mine = await h.gql('store', m.token, '{ returns { total items { id refund { status } } } }');
    expect(mine.errors, JSON.stringify(mine.errors)).toBeUndefined();
    expect(mine.data.returns.items.map((r: any) => r.id)).toContain(m.ret.id);

    const state = await h.service.returnStateForItems([m.items[0]![0]!]);
    expect(state[0]).toMatchObject({ returnId: m.ret.id, status: 'requested', refundStatus: null });
    const elig = await h.service.eligibilityForItems([m.items[0]![0]!]);
    expect(elig[0]).toMatchObject({ eligible: false, ineligibleReason: 'return_open', latestReturn: { returnId: m.ret.id } });
    expect(await h.service.countOpenReturnsForProducts([m.p.productId])).toEqual({ [m.p.productId]: 1 });
    expect((await h.service.listForOrder(m.order.id, { area: 'seller', sellerId: newId() })).length).toBe(0);
    expect((await h.service.listForOrder(m.order.id, { area: 'admin' })).length).toBe(1);
  });
});

describe('staff reads and case refunds for support', () => {
  const breakdown = (total: number, item = total) => ({ itemAmount: { amount: item, currency: 'USD' }, discountShare: { amount: 0, currency: 'USD' }, shippingRefund: { amount: 0, currency: 'USD' }, returnShippingDeduction: { amount: 0, currency: 'USD' }, deductions: [], total: { amount: total, currency: 'USD' }, maxRefundable: { amount: item, currency: 'USD' }, destination: 'Visa', isEstimate: false });

  it('gets any return by id in the staff view (warehouse)', async () => {
    const m = await sellerReturn();
    const ret = await h.service.getReturn(m.ret.id);
    expect(ret).toMatchObject({ detail: { id: m.ret.id, ref: m.ret.ref }, policyApplied: { sellerId: m.sellerId } });
    expect(ret!.activity.length).toBeGreaterThan(0);
    expect(await h.service.getReturn(newId())).toBeNull();
    expect(await h.service.getReturn('not-a-uuid')).toBeNull();
  });

  it('freezes the shared Official Store id on Official Store terms', async () => {
    const m = await officialReturn();
    expect((await h.service.getReturn(m.ret.id))!.policyApplied.sellerId).toBe(OFFICIAL_STORE_ID);
    expect((await h.service.resolveTerms(null, null, null)).sellerId).toBe(OFFICIAL_STORE_ID);
  });

  it('cancels the refund requests of an overturned case decision; money already moving is reported', async () => {
    const sellerId = newId();
    const p1 = product(h, { title: 'Stool', price: 6000, sellerId });
    const p2 = product(h, { title: 'Shelf', price: 4000, sellerId });
    const p3 = product(h, { title: 'Clock', price: 3000, sellerId });
    const m = await placeOrder(h, [group(h, [line(p1, 1), line(p2, 1), line(p3, 1)], { sellerId })]);
    const caseId = newId();
    const ask = (orderItemId: string, total: number) => h.service.requestRefund({ source: 'case', caseId, orderId: m.order.id, orderItemIds: [orderItemId], breakdown: breakdown(total), fundedBy: 'seller', reason: 'Case decision', proposedBy: { kind: 'staff', id: newId() } });
    const review = await ask(m.items[0]![0]!, 2000);
    const moving = await ask(m.items[0]![1]!, 1500);
    expect((await h.call('POST', `/api/admin/returns/refunds/${moving.id}/approve`, staff(), {}, idem())).body.status).toBe('processing');
    // above the approver's limit: waiting for access, cancelled with its approval request
    h.authority.decision = 'approval_required';
    const waiting = await ask(m.items[0]![2]!, 1000);
    // saved pending approval: the normal answer with the approval in the body (FORMAT.md, Approval responses)
    const pending = await h.call('POST', `/api/admin/returns/refunds/${waiting.id}/approve`, staff(), {}, idem());
    expect(pending.status).toBe(200);
    expect(pending.body).toMatchObject({ status: 'under_review', approval: { required: true } });
    expect((await h.service.listRefundRequestsForCase(caseId)).find((r) => r.id === waiting.id)!.approval).toMatchObject({ required: true });
    const cancelledApprovals = h.calls.cancelledApprovals.length;

    const appealer = { kind: 'staff' as const, id: newId(), name: 'Ana Appeals' };
    const res = await h.service.cancelRefundsForCase(caseId, 'The appeal changed the decision', appealer);
    await h.app.kernel.events.drain();
    expect(res.cancelled.map((r) => r.id).sort()).toEqual([review.id, waiting.id].sort());
    expect(res.cancelled.every((r) => r.status === 'cancelled')).toBe(true);
    expect(res.notCancellable).toEqual([expect.objectContaining({ id: moving.id, status: 'processing' })]);
    expect(h.calls.cancelledApprovals.length).toBe(cancelledApprovals + 1);
    expect(h.audits.filter((a) => a.action === 'returns.refund.cancel').map((a) => a.target.id)).toEqual(expect.arrayContaining([review.id, waiting.id]));
    // recorded as the staff member deciding the appeal, and published
    expect(h.audits.filter((a) => a.action === 'returns.refund.cancel').every((a) => a.actor.id === appealer.id)).toBe(true);
    expect(h.named('returns.refund.cancelled')).toEqual(
      expect.arrayContaining([expect.objectContaining({ refundRequestId: review.id, caseId, reason: 'The appeal changed the decision', by: appealer }), expect.objectContaining({ refundRequestId: waiting.id })]),
    );

    // a second call changes nothing; a new refund for the cancelled items is no duplicate any more
    const again = await h.service.cancelRefundsForCase(caseId, 'again', appealer);
    expect(again.cancelled).toEqual([]);
    expect(again.notCancellable.map((r) => r.id)).toEqual([moving.id]);
    h.authority.decision = 'allowed';
    expect((await ask(m.items[0]![0]!, 2500)).status).toBe('under_review');
    expect(await h.service.cancelRefundsForCase(newId(), 'unknown case', appealer)).toEqual({ cancelled: [], notCancellable: [] });
  });

  it('carries the customer and contact email on refunds of a case without a return', async () => {
    const sellerId = newId();
    const p = product(h, { title: 'Bench', price: 9000, sellerId });
    const m = await placeOrder(h, [group(h, [line(p, 1)], { sellerId })], { customerId: null });
    const rr = await h.service.requestRefund({ source: 'case', caseId: newId(), orderId: m.order.id, orderItemIds: [m.items[0]![0]!], breakdown: breakdown(2000, 9000), fundedBy: 'seller', reason: 'Late', proposedBy: { kind: 'staff', id: newId() } });
    expect((await h.call('POST', `/api/admin/returns/refunds/${rr.id}/approve`, staff(), {}, idem())).body.status).toBe('processing');
    expect(h.named('returns.refund.approved').find((e) => e.refundRequestId === rr.id)).toMatchObject({ customerId: null, contactEmail: 'gia@example.com', returnId: null });
  });
});
