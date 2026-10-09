import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { checkout, group, harness, line, product, sellerOrder, tokens, ups, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h.app.close();
});

const SELLER = '/api/seller/shipping';
const ADMIN = '/api/admin/shipping';
const HOUR = 3_600_000;

describe('late shipment (scenario 5)', () => {
  it('opens one late_dispatch per deadline, delays the items, escalates a second miss and closes on dispatch', async () => {
    const o = await sellerOrder(h, { dispatchInHours: 2 });
    const watch = await h.service.core.repo.get('dispatch_watch', o.groupId);
    expect(watch).toMatchObject({ order_id: o.order.id, owner_type: 'seller', seller_id: o.sellerId, overdue_since: null });

    await h.runJob('shipping.detect-late-dispatch');
    expect(h.named('shipping.dispatch.overdue').filter((e) => e.groupId === o.groupId)).toHaveLength(0);

    h.clock.advance(3 * HOUR);
    await h.runJob('shipping.detect-late-dispatch');
    await h.runJob('shipping.detect-late-dispatch'); // once per group and deadline
    const overdue = h.named('shipping.dispatch.overdue').filter((e) => e.groupId === o.groupId);
    expect(overdue).toHaveLength(1);
    expect(overdue[0]).toMatchObject({ orderId: o.order.id, orderRef: o.order.ref, ownerType: 'seller', sellerId: o.sellerId, orderItemIds: expect.arrayContaining([o.speaker.id, o.lamp.id]) });

    // orders turns the items Delayed (customer told, with the support route)
    const order = (await h.orders.getOrder(o.order.id))!;
    expect(order.groups[0]!.items.every((i) => i.state === 'delayed')).toBe(true);

    // the Shipping Manager and the seller both see it
    const staff = tokens.staff();
    const list = await h.call('GET', `${ADMIN}/exceptions?kind=late_dispatch&q=${encodeURIComponent(o.order.ref)}`, staff);
    expect(list.body.items).toHaveLength(1);
    const ex = list.body.items[0];
    expect(ex).toMatchObject({ id: overdue[0].exceptionId, kind: 'late_dispatch', status: 'open', sellerName: 'Casa Verde Home', requiredResponse: expect.stringContaining('notify the seller'), deadline: { state: 'on_time' } });
    expect(ex.sellerNotifiedAt).toBeTruthy();
    const counts = await h.call('GET', `${ADMIN}/exceptions/counts`, staff);
    expect(counts.body.lateDispatch).toBeGreaterThanOrEqual(1);
    const mine = await h.call('GET', `${SELLER}/exceptions`, tokens.seller(o.sellerId));
    expect(mine.body.items.map((x: any) => x.id)).toEqual([ex.id]);
    expect((await h.call('GET', `${SELLER}/exceptions`, tokens.seller(newId()))).body.items).toEqual([]);

    // the seller promises a ship-by date: it becomes the deadline
    const seller = tokens.seller(o.sellerId);
    expect((await h.call('POST', `${SELLER}/exceptions/${ex.id}/respond`, tokens.seller(newId()), { action: 'other', note: 'x' })).status).toBe(404);
    expect((await h.call('POST', `${SELLER}/exceptions/${ex.id}/respond`, seller, { action: 'will_ship_by' })).status).toBe(400);
    const shipBy = new Date(h.clock.now().getTime() + 5 * HOUR).toISOString();
    const promised = await h.call('POST', `${SELLER}/exceptions/${ex.id}/respond`, seller, { action: 'will_ship_by', shipBy, note: 'Restock arrives today' });
    expect(promised.status).toBe(200);
    expect(promised.body.sellerResponse).toMatchObject({ action: 'will_ship_by', shipBy });
    expect(h.named('shipping.exception.updated').at(-1)).toMatchObject({ exceptionId: ex.id, action: 'seller_responded:will_ship_by' });
    expect(h.named('orders.dispatch_deadline.changed').at(-1)).toMatchObject({ groupId: o.groupId });
    expect((await h.service.core.repo.get('dispatch_watch', o.groupId))!.overdue_since).toBeNull();

    // missing the promised date escalates to the Seller Manager
    h.clock.advance(6 * HOUR);
    await h.runJob('shipping.detect-late-dispatch');
    const again = (await h.call('GET', `${ADMIN}/exceptions/${ex.id}`, staff)).body;
    expect(again).toMatchObject({ status: 'escalated', escalatedTo: 'seller_manager' });
    expect(again.history.map((x: any) => x.label)).toEqual(expect.arrayContaining(['Late dispatch opened', 'Seller promised a ship-by date', 'Seller missed another deadline', 'Escalated to Seller Manager']));
    expect(h.named('shipping.dispatch.overdue').filter((e) => e.groupId === o.groupId)).toHaveLength(2);

    // dispatching everything closes it
    const ship = await h.call('POST', `${SELLER}/shipments`, seller, {
      groupId: o.groupId,
      carrierCode: 'ups',
      trackingNumber: ups(),
      shippedAt: h.clock.now().toISOString(),
      items: (await h.orders.getOrder(o.order.id))!.groups[0]!.items.map((i) => ({ orderItemId: i.id, quantity: i.quantity })),
    });
    expect(ship.status, JSON.stringify(ship.body)).toBe(201);
    expect(ship.body.dispatchedOnTime).toBe(false);
    const closed = (await h.call('GET', `${ADMIN}/exceptions/${ex.id}`, staff)).body;
    expect(closed).toMatchObject({ status: 'closed', resolution: { kind: 'shipped' } });
    expect(h.named('shipping.exception.resolved').at(-1)).toMatchObject({ exceptionId: ex.id, resolution: 'shipped' });
    expect(await h.service.core.repo.get('dispatch_watch', o.groupId)).toBeUndefined();
  });
});

describe('dispatch watch', () => {
  it('moves the deadline when the payment is accepted on a later day', async () => {
    const sellerId = newId();
    const a = product(h, { title: 'Kettle', price: 4000, sellerId });
    const input = checkout([group(h, [line(a, 1)], { sellerId })], { customerId: newId(), pending: true });
    const placed = await h.orders.createOrder(input);
    await h.app.kernel.events.drain();
    expect(await h.service.core.repo.get('dispatch_watch', placed.groups[0]!.id)).toBeUndefined();
    h.clock.advance(3 * 24 * HOUR);
    await h.orders.acceptOrder(placed.id, input.paymentIntentId);
    await h.app.kernel.events.drain();
    const watch = (await h.service.core.repo.get('dispatch_watch', placed.groups[0]!.id))!;
    expect(watch.due_at.getTime()).toBeGreaterThan(new Date(placed.groups[0]!.delivery.dispatchBy).getTime());
    expect(h.named('orders.dispatch_deadline.changed').at(-1)).toMatchObject({ groupId: placed.groups[0]!.id, dueAt: watch.due_at.toISOString(), reason: 'Payment accepted after the order was placed' });
  });

  it('watches a replacement like an original shipment', async () => {
    const o = await sellerOrder(h);
    await h.call('POST', '/api/seller/shipping/shipments', tokens.seller(o.sellerId), { groupId: o.groupId, carrierCode: 'ups', trackingNumber: ups(), shippedAt: h.clock.now().toISOString(), items: [{ orderItemId: o.speaker.id, quantity: 2 }, { orderItemId: o.lamp.id, quantity: 1 }] });
    expect(await h.service.core.repo.get('dispatch_watch', o.groupId)).toBeUndefined();
    const replacementId = newId();
    await h.publish('returns', 'returns.replacement.created', { replacementId, returnId: newId(), orderId: o.order.id, orderItemId: o.lamp.id, ownerType: 'seller', sellerId: o.sellerId, variantId: newId(), offerId: newId(), quantity: 1, kind: 'replacement' });
    const watch = await h.service.core.repo.get('dispatch_watch', o.groupId);
    expect(watch).toMatchObject({ seller_id: o.sellerId, open_item_ids: [`replacement:${replacementId}`] });
    expect(watch!.due_at.getTime()).toBeGreaterThan(h.clock.now().getTime());
  });
});

describe('staff handling of exceptions', () => {
  it('opens manually, assigns, reminds (rate limited), notifies, requests tracking, escalates and resolves', async () => {
    const o = await sellerOrder(h);
    const staff = tokens.staff();
    const opened = await h.call('POST', `${ADMIN}/exceptions`, staff, { kind: 'lost_or_damaged', groupId: o.groupId, orderItemIds: [o.lamp.id], situation: 'Customer called: box crushed' });
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    expect(opened.body).toMatchObject({ kind: 'lost_or_damaged', status: 'open', itemsSummary: expect.stringContaining('Desk Lamp'), openedBy: { kind: 'staff' } });
    expect(h.named('shipping.shipment.exception').at(-1)).toMatchObject({ exceptionId: opened.body.id, orderItemIds: [o.lamp.id], customerId: o.customerId, contactEmail: 'jordan@example.com' });
    expect(h.audits.at(-1)).toMatchObject({ action: 'shipping.exception.open' });
    const dup = await h.call('POST', `${ADMIN}/exceptions`, staff, { kind: 'lost_or_damaged', groupId: o.groupId, situation: 'again' });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toMatchObject({ code: 'EXCEPTION_ALREADY_OPEN', details: { exceptionId: opened.body.id } });
    const id = opened.body.id;
    const owner = newId();
    const assigned = await h.call('POST', `${ADMIN}/exceptions/${id}/assign`, staff, { ownerStaffId: owner });
    expect(assigned.body).toMatchObject({ status: 'in_progress', owner: { staffId: owner, name: 'Theo Grant, Shipping Manager' } });
    const reminded = await h.call('POST', `${ADMIN}/exceptions/${id}/notify-seller`, staff, { message: 'Please check the packing' });
    expect(reminded.status).toBe(200);
    expect(reminded.body.sellerNotifiedAt).toBeTruthy();
    expect(h.notices.at(-1)).toMatchObject({ recipients: [{ kind: 'seller', sellerId: o.sellerId }] });
    expect((await h.call('POST', `${ADMIN}/exceptions/${id}/notify-seller`, staff, {})).status).toBe(429);
    const told = await h.call('POST', `${ADMIN}/exceptions/${id}/notify-customer`, staff, {});
    expect(told.body.customerNotifiedAt).toBeTruthy();
    expect(h.notices.at(-1)).toMatchObject({ topic: 'customer.shipment.exception', recipients: [{ kind: 'guest_email', email: 'jordan@example.com' }] });
    expect((await h.call('POST', `${ADMIN}/exceptions/${id}/request-tracking`, staff, { dueAt: new Date(h.clock.now().getTime() - HOUR).toISOString() })).status).toBe(400);
    const requested = await h.call('POST', `${ADMIN}/exceptions/${id}/request-tracking`, staff, { dueAt: new Date(h.clock.now().getTime() + 24 * HOUR).toISOString() });
    expect(requested.body.nextStep).toMatch(/valid tracking/);
    const escalated = await h.call('POST', `${ADMIN}/exceptions/${id}/escalate`, staff, { to: 'support', reason: 'Customer wants a refund' });
    expect(escalated.body).toMatchObject({ status: 'escalated', escalatedTo: 'support' });
    const resolved = await h.call('POST', `${ADMIN}/exceptions/${id}/resolve`, staff, { kind: 'replacement_sent', note: 'Seller sent a new lamp' });
    expect(resolved.body).toMatchObject({ status: 'resolved', resolution: { kind: 'replacement_sent', note: 'Seller sent a new lamp', by: { kind: 'staff' } } });
    expect(h.named('shipping.exception.resolved').at(-1)).toMatchObject({ exceptionId: id, resolution: 'replacement_sent' });
    expect((await h.call('POST', `${ADMIN}/exceptions/${id}/resolve`, staff, { kind: 'no_action', note: 'x' })).status).toBe(409);
    expect((await h.call('POST', `${ADMIN}/exceptions/${id}/assign`, staff, { ownerStaffId: owner })).status).toBe(409);
    const history = (await h.call('GET', `${ADMIN}/exceptions/${id}`, staff)).body.history.map((x: any) => x.label);
    expect(history).toEqual(['Lost or damaged opened', 'Owner assigned', 'Seller reminded', 'Customer updated', 'Tracking requested from the seller', 'Escalated to Customer Support', 'Resolved: Replacement sent']);
  });

  it('runs bulk actions and reports the ones that failed', async () => {
    const a = await sellerOrder(h);
    const b = await sellerOrder(h);
    const staff = tokens.staff();
    const ea = (await h.call('POST', `${ADMIN}/exceptions`, staff, { kind: 'missing_tracking', groupId: a.groupId, situation: 'No tracking' })).body;
    const eb = (await h.call('POST', `${ADMIN}/exceptions`, staff, { kind: 'missing_tracking', groupId: b.groupId, situation: 'No tracking' })).body;
    await h.call('POST', `${ADMIN}/exceptions/${eb.id}/resolve`, staff, { kind: 'no_action', note: 'Found it' });
    const r = await h.call('POST', `${ADMIN}/exceptions/bulk`, staff, { ids: [ea.id, eb.id, newId()], action: 'escalate', to: 'seller_manager', reason: 'Repeat issue' });
    expect(r.body).toEqual({ updated: 1, failed: [eb.id, expect.any(String)] });
    expect(h.audits.at(-1)).toMatchObject({ action: 'shipping.exception.bulk' });
    const notNotified = await h.call('GET', `${ADMIN}/exceptions?customerNotNotified=true&kind=missing_tracking`, staff);
    expect(notNotified.body.items.map((x: any) => x.id)).toContain(ea.id);
  });
});

describe('detection jobs', () => {
  it('opens missing_tracking for labels never scanned and lost_or_damaged for stalled packages', async () => {
    const o = await sellerOrder(h);
    const seller = tokens.seller(o.sellerId);
    const other = await sellerOrder(h);
    const quote = (await h.call('POST', `${SELLER}/labels/quotes`, tokens.seller(other.sellerId), { groupId: other.groupId, items: [{ orderItemId: other.lamp.id, quantity: 1 }], parcel: { weightGrams: 800 } })).body[0];
    const label = (await h.call('POST', `${SELLER}/labels`, tokens.seller(other.sellerId), { quoteId: quote.id, items: [{ orderItemId: other.lamp.id, quantity: 1 }] }, { 'idempotency-key': newId() })).body;
    const shipped = (await h.call('POST', `${SELLER}/shipments`, seller, { groupId: o.groupId, carrierCode: 'ups', trackingNumber: ups(), shippedAt: h.clock.now().toISOString(), items: [{ orderItemId: o.speaker.id, quantity: 2 }] })).body;
    h.clock.advance(37 * HOUR);
    await h.runJob('shipping.detect-missing-tracking');
    await h.runJob('shipping.detect-missing-tracking');
    const opened = h.named('shipping.shipment.exception').filter((e) => (e.groupId === o.groupId || e.groupId === other.groupId) && e.kind === 'missing_tracking');
    expect(opened.map((e) => e.shipmentId).sort()).toEqual([label.shipment.id, shipped.id].sort());
    const labelled = (await h.call('GET', `${ADMIN}/exceptions/${opened.find((e) => e.shipmentId === label.shipment.id).exceptionId}`, tokens.staff())).body;
    expect(labelled.situation).toBe('Label created, no scan 36 h');
    const rows = await h.service.core.repo.find('exceptions', { group_id: o.groupId, kind: 'missing_tracking' });
    expect(rows.length).toBe(1);
    // a carrier scan closes it
    await h.webhook('ups', { id: `scan-${shipped.id}`, trackingNumber: shipped.trackingNumber, code: 'in_transit', at: h.clock.now().toISOString() });
    expect((await h.service.core.repo.get('exceptions', rows[0]!.id))!.status).toBe('closed');

    h.clock.advance(8 * 24 * HOUR);
    await h.runJob('shipping.detect-stalled');
    const stalled = h.named('shipping.shipment.exception').filter((e) => e.groupId === o.groupId && e.kind === 'lost_or_damaged');
    expect(stalled).toHaveLength(1);
    expect(stalled[0].shipmentId).toBe(shipped.id);
    // the package turns up: the review closes
    await h.webhook('ups', { id: `scan2-${shipped.id}`, trackingNumber: shipped.trackingNumber, code: 'out_for_delivery', at: h.clock.now().toISOString() });
    expect((await h.service.core.repo.find('exceptions', { group_id: o.groupId, kind: 'lost_or_damaged' }))[0]!.status).toBe('closed');
  });

  it('polls carriers in polling mode', async () => {
    const o = await sellerOrder(h);
    const carriers = await h.call('GET', `${ADMIN}/carriers`, tokens.staff());
    const usps = carriers.body.find((c: any) => c.code === 'usps');
    await h.call('PATCH', `${ADMIN}/carriers/${usps.id}`, tokens.staff(), { trackingMode: 'polling', reason: 'Webhook outage' });
    const s = (await h.call('POST', `${SELLER}/shipments`, tokens.seller(o.sellerId), { groupId: o.groupId, carrierCode: 'usps', trackingNumber: `9400${String(Date.now()).padStart(18, '0')}`, shippedAt: h.clock.now().toISOString(), items: [{ orderItemId: o.lamp.id, quantity: 1 }] })).body;
    h.clock.advance(2 * HOUR);
    await h.runJob('shipping.poll-tracking');
    const after = (await h.call('GET', `${ADMIN}/shipments/${s.id}`, tokens.staff())).body;
    expect(after.trackingState).toBe('valid');
    expect(after.events.some((e: any) => e.source === 'carrier_poll' && e.code === 'accepted')).toBe(true);
    await h.call('PATCH', `${ADMIN}/carriers/${usps.id}`, tokens.staff(), { trackingMode: 'webhook', reason: 'Back' });
  });
});

describe('events from other modules', () => {
  it('seller cancellations open seller_cannot_fulfill; the refund closes it; nothing left closes late dispatch', async () => {
    const o = await sellerOrder(h);
    const refund = { itemAmount: { amount: 3000, currency: 'USD' }, discountShare: { amount: 0, currency: 'USD' }, shippingRefund: { amount: 0, currency: 'USD' }, taxRefund: { amount: 0, currency: 'USD' }, total: { amount: 3000, currency: 'USD' } };
    await h.publish('orders', 'orders.item.cancelled', { orderId: o.order.id, ref: o.order.ref, groupId: o.groupId, ownerType: 'seller', sellerId: o.sellerId, itemId: o.lamp.id, offerId: newId(), stockItemId: newId(), quantity: 1, cancellationId: newId(), initiatedBy: 'seller', reasonCode: 'out_of_stock', beforeDispatch: true, countsAgainstSeller: true, refund, paymentIntentId: newId() });
    const ex = h.named('shipping.shipment.exception').at(-1);
    expect(ex).toMatchObject({ kind: 'seller_cannot_fulfill', groupId: o.groupId, orderItemIds: [o.lamp.id] });
    const view = (await h.call('GET', `${ADMIN}/exceptions/${ex.exceptionId}`, tokens.staff())).body;
    expect(view.nextStep).toBe('Cancel item, refund $30.00');
    await h.publish('payments', 'payments.refund.sent', { refundId: newId(), ref: 'RF-1', orderId: o.order.id, origin: 'cancellation', originId: null, amount: refund.total, items: [{ orderItemId: o.lamp.id, title: 'Desk Lamp', groupId: o.groupId, sellerId: o.sellerId, amount: refund.total }], destination: 'card', sentAt: h.clock.now().toISOString() });
    expect((await h.call('GET', `${ADMIN}/exceptions/${ex.exceptionId}`, tokens.staff())).body).toMatchObject({ status: 'closed', resolution: { kind: 'cancelled_refunded' } });
  });

  it('restricted sellers have their open exceptions marked for the Seller Manager; support cases open lost_or_damaged', async () => {
    const o = await sellerOrder(h);
    const e = (await h.call('POST', `${ADMIN}/exceptions`, tokens.staff(), { kind: 'missing_tracking', groupId: o.groupId, situation: 'No tracking' })).body;
    await h.publish('sellers', 'sellers.seller.restricted', { sellerId: o.sellerId, restrictionId: newId(), reasonCode: 'late_dispatch', reason: 'Too many late orders', affectedActivities: ['sales'], scope: { categoryIds: [] }, categoryIds: [], appealRoute: 'seller/appeals', appealDeadline: h.clock.now().toISOString(), reviewDate: h.clock.now().toISOString().slice(0, 10) });
    expect((await h.call('GET', `${ADMIN}/exceptions/${e.id}`, tokens.staff())).body).toMatchObject({ status: 'escalated', escalatedTo: 'seller_manager' });
    await h.publish('support', 'support.case.opened', { caseId: newId(), ref: 'CS-261009-0001', kind: 'order_problem', category: 'package_not_received', priority: 'high', customerId: o.customerId, sellerId: o.sellerId, orderId: o.order.id, orderItemIds: [o.speaker.id], handler: 'support', nextResponseDueAt: null });
    const opened = h.named('shipping.shipment.exception').at(-1);
    expect(opened).toMatchObject({ kind: 'lost_or_damaged', groupId: o.groupId, orderItemIds: [o.speaker.id] });
    expect((await h.call('GET', `${ADMIN}/exceptions/${opened.exceptionId}`, tokens.staff())).body.caseRef).toBe('CS-261009-0001');
    // the same report twice does not open a second one
    await h.publish('support', 'support.case.opened', { caseId: newId(), ref: 'CS-261009-0002', kind: 'order_problem', category: 'package_not_received', priority: 'high', customerId: o.customerId, sellerId: o.sellerId, orderId: o.order.id, orderItemIds: [o.speaker.id], handler: 'support', nextResponseDueAt: null });
    expect(await h.service.core.repo.count('exceptions', { group_id: o.groupId, kind: 'lost_or_damaged' })).toBe(1);
  });
});

describe('carrier claims', () => {
  it('needs Finance approval above the limit before submitting; the seller records its own claims', async () => {
    const o = await sellerOrder(h);
    const seller = tokens.seller(o.sellerId);
    const s = (await h.call('POST', `${SELLER}/shipments`, seller, { groupId: o.groupId, carrierCode: 'ups', trackingNumber: ups(), shippedAt: h.clock.now().toISOString(), items: [{ orderItemId: o.lamp.id, quantity: 1 }] })).body;
    const staff = tokens.staff();
    const ex = (await h.call('POST', `${ADMIN}/exceptions`, staff, { kind: 'lost_or_damaged', groupId: o.groupId, shipmentId: s.id, situation: 'Lost in transit' })).body;
    h.access.decision = 'approval_required';
    const claim = await h.call('POST', `${ADMIN}/claims`, staff, { shipmentId: s.id, exceptionId: ex.id, carrierCode: 'ups', amount: { amount: 150000, currency: 'USD' }, note: 'Declared value' });
    expect(claim.status, JSON.stringify(claim.body)).toBe(201);
    expect(claim.body).toMatchObject({ status: 'draft', filedBy: 'platform', approval: { required: true, approvalRequestId: expect.any(String) }, orderRef: o.order.ref });
    expect(h.access.requested.at(-1)).toMatchObject({ action: 'shipping.claims.open', amount: { amount: 150000 } });
    expect(h.named('shipping.claim.status_changed').at(-1)).toMatchObject({ claimId: claim.body.id, status: 'draft', filedBy: 'platform' });
    expect((await h.call('GET', `${ADMIN}/exceptions/${ex.id}`, staff)).body.claimId).toBe(claim.body.id);
    const blocked = await h.call('POST', `${ADMIN}/claims/${claim.body.id}/status`, staff, { event: 'submit', note: 'Filing' });
    expect(blocked.body.error.code).toBe('APPROVAL_REQUIRED');
    h.access.approvals.set(claim.body.approval.approvalRequestId, 'approved');
    const submitted = await h.call('POST', `${ADMIN}/claims/${claim.body.id}/status`, staff, { event: 'submit', claimNumber: 'UPS-CLM-88412', note: 'Filed online' });
    expect(submitted.body).toMatchObject({ status: 'submitted', claimNumber: 'UPS-CLM-88412' });
    expect((await h.call('POST', `${ADMIN}/claims/${claim.body.id}/status`, staff, { event: 'pay', note: 'Paid' })).status).toBe(400);
    const paid = await h.call('POST', `${ADMIN}/claims/${claim.body.id}/status`, staff, { event: 'pay', paidAmount: { amount: 120000, currency: 'USD' }, note: 'Paid by UPS' });
    expect(paid.body).toMatchObject({ status: 'paid', paidAmount: { amount: 120000 }, decidedAt: expect.any(String) });
    expect(h.named('shipping.claim.status_changed').at(-1)).toMatchObject({ status: 'paid', paidAmount: { amount: 120000, currency: 'USD' } });
    expect((await h.call('POST', `${ADMIN}/claims/${claim.body.id}/status`, staff, { event: 'withdraw', note: 'x' })).status).toBe(409);

    h.access.decision = 'denied';
    expect((await h.call('POST', `${ADMIN}/claims`, staff, { shipmentId: s.id, carrierCode: 'ups', amount: { amount: 500, currency: 'USD' }, note: 'x' })).status).toBe(403);
    h.access.decision = 'allowed';

    const own = await h.call('POST', `${SELLER}/claims`, seller, { shipmentId: s.id, carrierCode: 'ups', amount: { amount: 4000, currency: 'USD' }, note: 'Filed with my UPS account' });
    expect(own.body).toMatchObject({ status: 'submitted', filedBy: 'seller', sellerId: o.sellerId });
    expect((await h.call('POST', `${SELLER}/claims`, tokens.seller(newId()), { shipmentId: s.id, carrierCode: 'ups', amount: { amount: 4000, currency: 'USD' }, note: 'x' })).status).toBe(404);
    const list = await h.call('GET', `${SELLER}/claims`, seller);
    expect(list.body.items.map((c: any) => c.id)).toEqual(expect.arrayContaining([own.body.id, claim.body.id]));
    expect((await h.call('GET', `${SELLER}/claims`, tokens.seller(newId()))).body.items).toEqual([]);
    expect((await h.call('GET', `${ADMIN}/claims?status=paid`, staff)).body.items.map((c: any) => c.id)).toContain(claim.body.id);
  });
});

describe('exports', () => {
  it('exports delivery exception rows for reports', async () => {
    const o = await sellerOrder(h);
    await h.call('POST', `${ADMIN}/exceptions`, tokens.staff(), { kind: 'failed_delivery', groupId: o.groupId, situation: 'Wrong address' });
    const r = await h.service.exportRows('shipping.admin.exceptions', { kind: 'failed_delivery' }, { kind: 'staff', accountId: newId() });
    expect(r.rows.length).toBeGreaterThan(0);
    expect(r.rows[0]).toMatchObject({ kind: 'Failed delivery', orderRef: expect.any(String), status: 'open' });
  });
});
