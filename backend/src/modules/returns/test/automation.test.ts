/**
 * Jobs (response and inspection deadlines, information and drop-off expiry) and the events returns reacts
 * to (orders, shipping, sellers, support).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { group, harness, idem, line, now, placeOrder, product, tokens, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h.app.close();
});
let base: number;
beforeEach(() => {
  base = h.clock.now().getTime();
});
const restore = () => h.clock.set(new Date(base));
const job = async (name: 'returns.response-deadlines' | 'returns.inspection-deadlines' | 'returns.info-expiry' | 'returns.dropoff-expiry') => {
  await h.app.kernel.jobs.runNow(name);
  await h.app.kernel.events.drain();
};

async function sellerReturn(reason = 'damaged') {
  const sellerId = newId();
  const p = product(h, { title: 'Toaster', price: 4500, sellerId });
  const m = await placeOrder(h, [group(h, [line(p, 1)], { sellerId })]);
  const token = tokens.customer(m.customerId);
  const res = await h.call('POST', '/api/store/returns/requests', token, { orderId: m.order.id, items: [{ orderItemId: m.items[0]![0]!, quantity: 1 }], reason, details: 'Sparks', remedy: 'refund' }, idem());
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return { ...m, sellerId, ret: res.body.returns[0], seller: () => tokens.seller(sellerId), customer: () => tokens.customer(m.customerId) };
}

const detail = async (id: string, sellerId: string) => (await h.call('GET', `/api/seller/returns/requests/${id}`, tokens.seller(sellerId))).body;

describe('jobs', () => {
  it('reminds the seller before the respond-by time and hands the return to Marketly after it', async () => {
    const m = await sellerReturn();
    const due = new Date(m.ret.responseDue.dueAt).getTime();
    try {
      h.clock.set(new Date(due - 6 * 3_600_000));
      await job('returns.response-deadlines');
      expect(h.calls.notices.find((n) => n.dedupeKey === `return:${m.ret.id}:respond-soon`)).toMatchObject({ topic: 'seller.return.requested', recipients: [{ kind: 'seller', sellerId: m.sellerId }] });
      expect(h.named('returns.return.escalated').find((e) => e.returnId === m.ret.id)).toBeUndefined();
      h.clock.set(new Date(due + 3_600_000));
      await job('returns.response-deadlines');
      expect(h.named('returns.return.escalated').find((e) => e.returnId === m.ret.id)).toMatchObject({ reason: 'seller_no_response', by: { kind: 'system' } });
      const d = await detail(m.ret.id, m.sellerId);
      expect(d.flags.map((f: any) => f.kind)).toEqual(expect.arrayContaining(['seller_missed_deadline', 'platform_took_over']));
      const late = await h.call('POST', `/api/seller/returns/requests/${m.ret.id}/reject`, m.seller(), { reasonCode: 'other', explanation: 'No' });
      expect(late.body.error.code).toBe('RESPONSE_DEADLINE_PASSED');
      await job('returns.response-deadlines'); // nothing more happens
      expect(h.named('returns.return.escalated').filter((e) => e.returnId === m.ret.id)).toHaveLength(1);
    } finally {
      restore();
    }
  });

  it('cancels returns whose question was not answered and returns not dropped off', async () => {
    const a = await sellerReturn();
    const asked = await h.call('POST', `/api/seller/returns/requests/${a.ret.id}/request-info`, a.seller(), { question: 'Which plug?' });
    const b = await sellerReturn();
    const approved = await h.call('POST', `/api/seller/returns/requests/${b.ret.id}/approve`, b.seller(), { labelMethod: 'prepaid_label' });
    try {
      h.clock.set(new Date(new Date(asked.body.detail.infoRequest.replyDueAt).getTime() + 3_600_000));
      await job('returns.info-expiry');
      expect((await detail(a.ret.id, a.sellerId)).detail.status).toBe('cancelled');
      expect(h.named('returns.return.cancelled').find((e) => e.returnId === a.ret.id)).toMatchObject({ by: { kind: 'system' } });
      h.clock.set(new Date(new Date(approved.body.detail.shipment.dropOffBy).getTime() + 3_600_000));
      await job('returns.dropoff-expiry');
      const d = await detail(b.ret.id, b.sellerId);
      expect(d.detail).toMatchObject({ status: 'cancelled', shipment: { status: 'expired' } });
      expect(h.calls.voided).toContain(approved.body.detail.shipment.id);
    } finally {
      restore();
    }
  });

  it('expires an unanswered question behind 1000 questions not due yet', async () => {
    const m = await sellerReturn();
    const asked = await h.call('POST', `/api/seller/returns/requests/${m.ret.id}/request-info`, m.seller(), { question: 'Which plug?' });
    const repo = h.service.core.repo;
    const base = (await repo.get('returns', m.ret.id))!;
    // 1000 open questions due next year, placed first in every order the query could read them in: lower ids, a
    // later request time, no response deadline. The old job read 1000 rows and then filtered by the due time.
    const old = h.clock.now().getTime() - 30 * 86_400_000;
    const farOff = new Date(h.clock.now().getTime() + 365 * 86_400_000).toISOString();
    const clones = Array.from({ length: 1000 }, (_, i) => ({ ...base, id: newId(old + i), ref: `RT-INFO-${i}-${newId().slice(-6)}`, requested_at: new Date(h.clock.now().getTime() + 86_400_000), response_due_at: null, info_request: { ...base.info_request!, replyDueAt: farOff } }));
    await repo.insertMany('returns', clones);
    // the real return stored again after them, so it is also last where the rows tie (stored order)
    await h.app.kernel.mongo.db.collection('returns.returns').deleteOne({ _id: m.ret.id as never });
    await repo.insert('returns', base);
    try {
      h.clock.set(new Date(new Date(asked.body.detail.infoRequest.replyDueAt).getTime() + 3_600_000));
      await job('returns.info-expiry');
      expect((await detail(m.ret.id, m.sellerId)).detail.status).toBe('cancelled');
      expect(await repo.count('returns', { id: clones.map((c) => c.id), status: 'info_requested' })).toBe(1000);
    } finally {
      restore();
      await h.app.kernel.mongo.db.collection('returns.returns').deleteMany({ _id: { $in: clones.map((c) => c.id) } as never });
    }
  });

  it('expires a return not dropped off behind 200 unused labels of returns no longer approved', async () => {
    const b = await sellerReturn();
    const approved = await h.call('POST', `/api/seller/returns/requests/${b.ret.id}/approve`, b.seller(), { labelMethod: 'prepaid_label' });
    const repo = h.service.core.repo;
    const label = (await repo.get('return_shipments', approved.body.detail.shipment.id))!;
    const dropOffBy = new Date(approved.body.detail.shipment.dropOffBy).getTime();
    // 200 unused labels past their drop-off date whose return is gone, first in id and in drop-off order
    const old = h.clock.now().getTime() - 30 * 86_400_000;
    const stale = Array.from({ length: 200 }, (_, i) => ({ ...label, id: newId(old + i), return_id: newId(), drop_off_by: new Date(dropOffBy - 86_400_000) }));
    await repo.insertMany('return_shipments', stale);
    try {
      h.clock.set(new Date(dropOffBy + 3_600_000));
      await job('returns.dropoff-expiry');
      expect((await detail(b.ret.id, b.sellerId)).detail).toMatchObject({ status: 'cancelled', shipment: { status: 'expired' } });
    } finally {
      restore();
      await h.app.kernel.mongo.db.collection('returns.return_shipments').deleteMany({ _id: { $in: stale.map((s) => s.id) } as never });
    }
  });

  it('escalates received returns the seller does not inspect in time', async () => {
    const m = await sellerReturn();
    await h.call('POST', `/api/seller/returns/requests/${m.ret.id}/approve`, m.seller(), { labelMethod: 'prepaid_qr' });
    const received = await h.call('POST', `/api/seller/returns/requests/${m.ret.id}/receive`, m.seller(), {});
    const inspectBy = new Date(received.body.deadlines.inspectBy.dueAt).getTime();
    try {
      h.clock.set(new Date(inspectBy + 3_600_000));
      await job('returns.inspection-deadlines');
      expect(h.named('returns.return.escalated').find((e) => e.returnId === m.ret.id)).toMatchObject({ reason: 'seller_missed_inspection' });
    } finally {
      restore();
    }
  });

  it('walks every candidate: a late return behind returns still inside their inspection target is escalated', async () => {
    // three returns requested first (lower ids) but received a week later, so their target is not reached yet
    const waiting = [await sellerReturn(), await sellerReturn(), await sellerReturn()];
    for (const w of waiting) await h.call('POST', `/api/seller/returns/requests/${w.ret.id}/approve`, w.seller(), { labelMethod: 'prepaid_qr' });
    const late = await sellerReturn();
    await h.call('POST', `/api/seller/returns/requests/${late.ret.id}/approve`, late.seller(), { labelMethod: 'prepaid_qr' });
    const received = await h.call('POST', `/api/seller/returns/requests/${late.ret.id}/receive`, late.seller(), {});
    const inspectBy = new Date(received.body.deadlines.inspectBy.dueAt).getTime();
    try {
      h.clock.set(new Date(base + 7 * 86_400_000));
      for (const w of waiting) expect((await h.call('POST', `/api/seller/returns/requests/${w.ret.id}/receive`, w.seller(), {})).status).toBe(200);
      h.clock.set(new Date(inspectBy + 3_600_000));
      // batches of 2: the first batch holds only returns the job skips
      h.service.automation.jobBatchSize = 2;
      await job('returns.inspection-deadlines');
      expect(h.named('returns.return.escalated').find((e) => e.returnId === late.ret.id)).toMatchObject({ reason: 'seller_missed_inspection' });
      for (const w of waiting) expect(h.named('returns.return.escalated').find((e) => e.returnId === w.ret.id)).toBeUndefined();
    } finally {
      h.service.automation.jobBatchSize = 200;
      restore();
    }
  });
});

describe('events from other modules', () => {
  it('cancels a pending return when its item is cancelled', async () => {
    const m = await sellerReturn();
    await h.publish('orders', 'orders.item.cancelled', {
      orderId: m.order.id,
      ref: m.order.ref,
      groupId: m.order.groups[0]!.id,
      ownerType: 'seller',
      sellerId: m.sellerId,
      fulfilledBy: 'seller',
      itemId: m.items[0]![0]!,
      offerId: newId(),
      stockItemId: newId(),
      quantity: 1,
      cancellationId: newId(),
      initiatedBy: 'staff',
      notifyCustomer: true,
      reasonCode: 'other',
      beforeDispatch: false,
      countsAgainstSeller: false,
      refund: { itemAmount: { amount: 0, currency: 'USD' }, discountShare: { amount: 0, currency: 'USD' }, shippingRefund: { amount: 0, currency: 'USD' }, taxRefund: { amount: 0, currency: 'USD' }, total: { amount: 0, currency: 'USD' } },
      paymentIntentId: newId(),
    });
    expect((await detail(m.ret.id, m.sellerId)).detail.status).toBe('cancelled');
    // unknown items are ignored
    await h.publish('orders', 'orders.item.delivered', { orderId: newId(), groupId: newId(), ownerType: 'seller', sellerId: newId(), itemId: newId(), quantity: 1, deliveredAt: now(), returnWindowEndsAt: now() });
  });

  it('moves open returns of a suspended seller to Marketly', async () => {
    const m = await sellerReturn();
    await h.publish('sellers', 'sellers.seller.suspended', { sellerId: m.sellerId, suspensionId: newId(), reasonCode: 'fraud', reason: 'Fraud', reviewDate: '2026-12-01', openOrders: 'seller_keeps_fulfilling', appealDeadline: now() });
    const d = await detail(m.ret.id, m.sellerId);
    expect(d.detail.handledBy).toBe('marketplace_support');
    expect(h.named('returns.return.escalated').find((e) => e.returnId === m.ret.id)).toBeTruthy();
  });

  it('follows the return parcel through shipping events', async () => {
    const m = await sellerReturn();
    const ok = await h.call('POST', `/api/seller/returns/requests/${m.ret.id}/approve`, m.seller(), { labelMethod: 'prepaid_qr' });
    const shipmentId = ok.body.detail.shipment.shippingShipmentId;
    const groupId = m.order.groups[0]!.id;
    await h.publish('shipping', 'shipping.shipment.status_changed', { shipmentId, kind: 'return', orderId: m.order.id, groupId, returnId: m.ret.id, from: 'label_created', to: 'in_transit', statusLabel: 'In transit', estimatedArrival: { from: '2026-10-12', to: '2026-10-13' }, at: now() });
    let d = await detail(m.ret.id, m.sellerId);
    expect(d.detail).toMatchObject({ status: 'in_transit', shipment: { status: 'in_transit' } });
    await h.publish('shipping', 'shipping.shipment.exception', { exceptionId: newId(), kind: 'lost_or_damaged', orderId: m.order.id, groupId, shipmentId, sellerId: m.sellerId, fulfilledBy: 'seller', orderItemIds: [], dueAt: now(), customerAction: null, source: 'carrier', caseRef: null });
    d = await detail(m.ret.id, m.sellerId);
    expect(d.detail.shipment.status).toBe('exception');
    await h.publish('shipping', 'shipping.shipment.delivered', { shipmentId, kind: 'return', orderId: m.order.id, groupId, returnId: m.ret.id, sellerId: m.sellerId, fulfilledBy: 'seller', lines: [], deliveredAt: now() });
    d = await detail(m.ret.id, m.sellerId);
    expect(d.detail.shipment.status).toBe('delivered');
    expect(d.detail.shipment.events.map((e: any) => e.label)).toEqual(expect.arrayContaining(['In transit']));
    // the carrier's delivery scan is the receipt: the return no longer waits for the seller to mark it received
    expect(d.detail.status).toBe('received');
    expect(h.named('returns.return.received').find((e) => e.returnId === m.ret.id)).toBeTruthy();
    // a "mark received" click afterwards changes nothing
    expect((await h.call('POST', `/api/seller/returns/requests/${m.ret.id}/receive`, m.seller(), {})).status).toBe(200);
  });

  it('applies a case decision that refunds without the item coming back', async () => {
    const m = await sellerReturn();
    const caseId = newId();
    await h.publish('support', 'support.case.decided', { caseId, ref: 'CS-000777', outcome: 'customer_favour', orderId: m.order.id, returnId: m.ret.id, sellerId: m.sellerId, remedies: [{ id: newId(), kind: 'refund', orderItemIds: [m.items[0]![0]!], status: 'approved', statusLabel: 'Approved', track: [] }], appealDeadline: null, final: true, notified: true });
    const d = await detail(m.ret.id, m.sellerId);
    expect(d).toMatchObject({ caseId, detail: { status: 'awaiting_remedy', decision: { kind: 'approved_without_return', platformDecision: true } } });
    // the refund decided in the case completes the return once it is sent
    const rr = await h.service.requestRefund({
      source: 'case',
      caseId,
      orderId: m.order.id,
      orderItemIds: [m.items[0]![0]!],
      breakdown: { itemAmount: { amount: 4500, currency: 'USD' }, discountShare: { amount: 0, currency: 'USD' }, shippingRefund: { amount: 0, currency: 'USD' }, returnShippingDeduction: { amount: 0, currency: 'USD' }, deductions: [], total: { amount: 4500, currency: 'USD' }, maxRefundable: { amount: 4500, currency: 'USD' }, destination: 'Visa', isEstimate: false },
      fundedBy: 'seller',
      reason: 'Case decision',
      proposedBy: { kind: 'staff', id: newId() },
    });
    expect(rr.returnId).toBe(m.ret.id);
    const ok = await h.call('POST', `/api/admin/returns/refunds/${rr.id}/approve`, tokens.staff(), {}, idem());
    expect(ok.body.status).toBe('processing');
    const started = h.calls.refunds.find((r) => r.originId === rr.id)!;
    expect(started.origin).toBe('case');
    await h.publish('payments', 'payments.refund.sent', { refundId: newId(), ref: rr.ref, orderId: m.order.id, origin: 'case', originId: rr.id, amount: { amount: 4500, currency: 'USD' }, items: started.items.map((i) => ({ ...i, title: 'Toaster', groupId: m.order.groups[0]!.id })), destination: 'Visa', sentAt: now() });
    expect((await detail(m.ret.id, m.sellerId)).detail.status).toBe('completed');
  });
});
