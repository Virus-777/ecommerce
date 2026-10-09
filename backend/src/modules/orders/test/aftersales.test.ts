import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { checkout, group, harness, line, product, tokens, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h.app.close();
});

const now = () => new Date().toISOString();

async function twoSellerOrder() {
  const customerId = newId();
  const sellerA = newId();
  const sellerB = newId();
  const pa = product(h, { title: 'Headphones', price: 6000, sellerId: sellerA });
  const pb = product(h, { title: 'Lamp', price: 3000, sellerId: sellerB });
  const order = await h.service.createOrder(checkout([group(h, [line(pa, 2, { shipping: 400, tax: 600 })], { sellerId: sellerA }), group(h, [line(pb, 1, { tax: 200 })], { sellerId: sellerB })], { customerId }));
  await h.app.kernel.events.drain();
  return { order, customerId, sellerA, sellerB, gA: order.groups[0]!, gB: order.groups[1]! };
}

async function ship(orderId: string, groupId: string, sellerId: string, lines: { orderItemId: string; quantity: number }[], trackingNumber = '1Z1') {
  const shipmentId = newId();
  const l = lines.map((x) => ({ ...x, title: 'x', variantLabel: '' }));
  await h.publish('shipping', 'shipping.shipment.created', { shipmentId, kind: 'outbound', orderId, groupId, sellerId, packageLabel: 'Package', carrierCode: 'ups', carrierName: 'UPS', serviceName: null, trackingNumber, trackingUrl: null, lines: l, status: 'label_created' });
  await h.publish('shipping', 'shipping.shipment.dispatched', { shipmentId, kind: 'outbound', orderId, groupId, ownerType: 'seller', sellerId, lines: l, shippedAt: now(), dispatchDueAt: null, onTime: true, trackingValid: true, estimatedArrival: { from: '2026-10-12', to: '2026-10-14' } });
  return shipmentId;
}

describe('shipping and delivery', () => {
  it('ships partial quantities (splitting the line), delivers them and derives the overall status', async () => {
    const m = await twoSellerOrder();
    const item = m.gA.items[0]!;
    expect((await h.service.canShipItems(m.gA.id, [{ orderItemId: item.id, quantity: 3 }])).ok).toBe(false);
    expect(await h.service.canShipItems(m.gA.id, [{ orderItemId: item.id, quantity: 1 }])).toEqual({ ok: true, problems: [] });
    const s1 = await ship(m.order.id, m.gA.id, m.sellerA, [{ orderItemId: item.id, quantity: 1 }]);
    let o = (await h.service.getOrder(m.order.id))!;
    expect(o.groups[0]!.items.map((i) => [i.quantity, i.state])).toEqual([
      [1, 'shipped'],
      [1, 'confirmed'],
    ]);
    expect(o.groups[0]!.status).toBe('partly_shipped');
    expect(o.status.value).toBe('partly_shipped');
    expect(o.groups[0]!.shipments[0]).toMatchObject({ shipmentId: s1, trackingNumber: '1Z1', status: 'shipped', itemIds: [item.id] });
    expect(o.groups[0]!.items[0]!.paidAmount.amount + o.groups[0]!.items[1]!.paidAmount.amount).toBe(2 * 6000 + 400 + 600);
    const task = await h.service.getFulfillmentTask(m.gA.id);
    expect(task.openLines).toHaveLength(1);
    expect(task.openLines[0]!.quantityToShip).toBe(1);

    await h.publish('shipping', 'shipping.shipment.status_changed', { shipmentId: s1, kind: 'outbound', orderId: m.order.id, groupId: m.gA.id, from: 'shipped', to: 'in_transit', statusLabel: 'In transit', estimatedArrival: null, at: now() });
    await h.publish('shipping', 'shipping.shipment.delivered', { shipmentId: s1, kind: 'outbound', orderId: m.order.id, groupId: m.gA.id, sellerId: m.sellerA, lines: [{ orderItemId: item.id, title: 'x', variantLabel: '', quantity: 1 }], deliveredAt: now() });
    const delivered = h.named('orders.item.delivered').find((e) => e.itemId === item.id);
    expect(delivered).toMatchObject({ orderId: m.order.id, ownerType: 'seller', sellerId: m.sellerA, quantity: 1 });
    expect(new Date(delivered.returnWindowEndsAt).getTime() - new Date(delivered.deliveredAt).getTime()).toBe(30 * 86_400_000);
    o = (await h.service.getOrder(m.order.id))!;
    expect(o.status.value).toBe('partly_delivered');
    expect(o.progress.delivery.state).toBe('partly_shipped');
    expect(await h.service.isVerifiedPurchase(m.customerId, o.groups[0]!.items[0]!.product.productId)).toMatchObject({ orderItemId: item.id });
  });

  it('turns unshipped items Delayed on an overdue dispatch, and staff set a final dispatch date', async () => {
    const m = await twoSellerOrder();
    await h.publish('shipping', 'shipping.dispatch.overdue', { orderId: m.order.id, orderRef: m.order.ref, groupId: m.gB.id, ownerType: 'seller', sellerId: m.sellerB, orderItemIds: [m.gB.items[0]!.id], dueAt: now(), exceptionId: newId() });
    expect(h.named('orders.item.delayed').find((e) => e.groupId === m.gB.id)).toMatchObject({ source: 'overdue', expectedDispatchBy: null });
    expect((await h.service.getOrder(m.order.id))!.groups[1]!.status).toBe('delayed');
    const staff = tokens.staff();
    const dueAt = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const res = await h.call('POST', `/api/admin/orders/orders/${m.order.id}/groups/${m.gB.id}/dispatch-deadline`, staff, { dueAt, reason: 'Seller restocking', notifyCustomer: true });
    expect(res.status).toBe(200);
    expect(res.body.order.groups[1].dispatchDeadline.dueAt).toBe(dueAt);
    expect(h.named('orders.dispatch_deadline.changed').find((e) => e.groupId === m.gB.id)).toMatchObject({ dueAt, previousDueAt: m.gB.dispatchDeadline.dueAt, by: { kind: 'staff' } });
    expect(h.audits.at(-1)).toMatchObject({ action: 'orders.dispatch_deadline.set', reason: 'Seller restocking' });
    expect((await h.call('POST', `/api/admin/orders/orders/${m.order.id}/groups/${newId()}/dispatch-deadline`, staff, { dueAt, reason: 'x', notifyCustomer: false })).status).toBe(404);
  });

  it('flags delivery exceptions and corrects tracking', async () => {
    const m = await twoSellerOrder();
    const s = await ship(m.order.id, m.gB.id, m.sellerB, [{ orderItemId: m.gB.items[0]!.id, quantity: 1 }], '1ZBAD');
    await h.publish('shipping', 'shipping.shipment.exception', { exceptionId: newId(), kind: 'failed_delivery', orderId: m.order.id, groupId: m.gB.id, shipmentId: s, sellerId: m.sellerB, orderItemIds: [m.gB.items[0]!.id], dueAt: now(), customerAction: null });
    await h.publish('shipping', 'shipping.tracking.corrected', { shipmentId: s, orderId: m.order.id, from: '1ZBAD', to: '1ZGOOD12345', reason: 'Typo', by: { kind: 'seller', id: m.sellerB } });
    const o = (await h.service.getOrder(m.order.id))!;
    expect(o.status.flags).toContain('delivery_issue');
    expect(o.progress.delivery.state).toBe('delivery_issue');
    expect(o.groups[1]!.alert).toMatchObject({ tone: 'danger', title: 'Delivery problem' });
    expect(o.groups[1]!.shipments[0]!.trackingNumber).toBe('1ZGOOD12345');
    const list = await h.call('GET', '/api/admin/orders/orders?q=1ZGOOD12345', tokens.staff());
    expect(list.body.items.map((r: any) => r.id)).toEqual([m.order.id]);
  });

  it('moves Official Store items to Preparing when warehouse picking starts, closing instant cancellation', async () => {
    const customerId = newId();
    const p = product(h, { title: 'Pan', price: 2500, ownerType: 'official' });
    const order = await h.service.createOrder(checkout([group(h, [line(p, 1)], { ownerType: 'official' })], { customerId }));
    await h.publish('warehouse', 'warehouse.fulfillment.status_changed', { fulfillmentId: newId(), orderId: order.id, sellerGroupId: order.groups[0]!.id, from: 'awaiting_pick', to: 'picking', reason: null });
    const item = (await h.service.getOrder(order.id))!.groups[0]!.items[0]!;
    expect(item.state).toBe('preparing');
    const res = await h.call('POST', `/api/store/orders/orders/${order.id}/cancellations`, tokens.customer(customerId), { items: [{ itemId: item.id, quantity: 1 }], reasonCode: 'changed_mind' }, { 'idempotency-key': newId() });
    expect(res.body.requests[0].status).toBe('requested');
  });
});

describe('returns, refunds, cases and completion', () => {
  it('mirrors a return and a refund; a line becomes Refunded only when its whole amount is sent', async () => {
    const m = await twoSellerOrder();
    const itemB = m.gB.items[0]!;
    const s = await ship(m.order.id, m.gB.id, m.sellerB, [{ orderItemId: itemB.id, quantity: 1 }]);
    await h.publish('shipping', 'shipping.shipment.delivered', { shipmentId: s, kind: 'outbound', orderId: m.order.id, groupId: m.gB.id, sellerId: m.sellerB, lines: [{ orderItemId: itemB.id, title: 'x', variantLabel: '', quantity: 1 }], deliveredAt: now() });
    const returnId = newId();
    await h.publish('returns', 'returns.return.requested', { returnId, ref: 'RT-261009-0001', orderId: m.order.id, ownerType: 'seller', sellerId: m.sellerB, orderItemIds: [itemB.id], reason: 'damaged', responseDueAt: now() });
    let o = (await h.service.getOrder(m.order.id))!;
    expect(o.groups[1]!.items[0]).toMatchObject({ state: 'return_requested', afterSales: { returnId, returnRef: 'RT-261009-0001' } });
    expect(o.progress.returns).toMatchObject({ state: 'requested', openReturns: 1 });
    expect(o.status.flags).toContain('return_open');

    await h.publish('returns', 'returns.return.received', { returnId, ownerType: 'seller', sellerId: m.sellerB, receivedAt: now() });
    const breakdown = { itemAmount: { amount: 3000, currency: 'USD' }, discountShare: { amount: 0, currency: 'USD' }, shippingRefund: { amount: 0, currency: 'USD' }, returnShippingDeduction: { amount: 0, currency: 'USD' }, deductions: [], total: { amount: 3200, currency: 'USD' }, maxRefundable: { amount: 3200, currency: 'USD' }, destination: 'Visa •••• 4417', isEstimate: false };
    const refundRequestId = newId();
    await h.publish('returns', 'returns.refund.approved', { refundRequestId, returnId, caseId: null, orderId: m.order.id, orderItemIds: [itemB.id], ownerType: 'seller', sellerId: m.sellerB, source: 'return', trustReportId: null, total: { amount: 3200, currency: 'USD' }, breakdown, fundedBy: 'seller', sellerShare: null, platformShare: null, approvedBy: { kind: 'staff', id: newId() } });
    o = (await h.service.getOrder(m.order.id))!;
    expect(o.groups[1]!.items[0]!.afterSales.refundStatus).toBe('approved');
    expect(o.totals.expectedRefunds).toEqual([{ label: 'Return refund', ref: 'RT-261009-0001', amount: { amount: 3200, currency: 'USD' }, status: 'approved' }]);
    expect(o.progress.payment.state).toBe('accepted'); // an approval is not money sent

    const refundId = newId();
    const partial = { refundId, ref: 'RF-1', orderId: m.order.id, origin: 'return', originId: refundRequestId, amount: { amount: 1000, currency: 'USD' }, items: [{ orderItemId: itemB.id, title: 'Lamp', groupId: m.gB.id, sellerId: m.sellerB, amount: { amount: 1000, currency: 'USD' } }], destination: 'Visa •••• 4417', sentAt: now() };
    await h.publish('payments', 'payments.refund.sent', partial);
    await h.publish('payments', 'payments.refund.sent', partial); // idempotent
    o = (await h.service.getOrder(m.order.id))!;
    expect(o.groups[1]!.items[0]).toMatchObject({ state: 'returned', afterSales: { refundedAmount: { amount: 1000 }, refundStatus: 'sent' } });
    expect(o.totals.refundedSoFar.amount).toBe(1000);
    expect(o.progress.payment.state).toBe('partly_refunded');
    await h.publish('payments', 'payments.refund.sent', { ...partial, refundId: newId(), amount: { amount: 2200, currency: 'USD' }, items: [{ ...partial.items[0], amount: { amount: 2200, currency: 'USD' } }] });
    o = (await h.service.getOrder(m.order.id))!;
    expect(o.groups[1]!.items[0]!.state).toBe('refunded');
    expect(o.status.value).not.toBe('refunded'); // the other seller's items are not refunded
  });

  it('adds a replacement line linked to the original, and closing a return restores Delivered', async () => {
    const m = await twoSellerOrder();
    const itemB = m.gB.items[0]!;
    const s = await ship(m.order.id, m.gB.id, m.sellerB, [{ orderItemId: itemB.id, quantity: 1 }]);
    await h.publish('shipping', 'shipping.shipment.delivered', { shipmentId: s, kind: 'outbound', orderId: m.order.id, groupId: m.gB.id, sellerId: m.sellerB, lines: [], deliveredAt: now() });
    const returnId = newId();
    await h.publish('returns', 'returns.return.requested', { returnId, ref: 'RT-2', orderId: m.order.id, ownerType: 'seller', sellerId: m.sellerB, orderItemIds: [itemB.id], reason: 'x', responseDueAt: now() });
    await h.publish('returns', 'returns.return.rejected', { returnId, ownerType: 'seller', sellerId: m.sellerB, reasonCode: 'used', platformDecision: false });
    expect((await h.service.getOrder(m.order.id))!.groups[1]!.items[0]!.state).toBe('delivered');
    const replacement = { replacementId: newId(), returnId, orderId: m.order.id, orderItemId: itemB.id, ownerType: 'seller' as const, sellerId: m.sellerB, variantId: h.products.get([...h.products.keys()].find((k) => h.products.get(k)!.title === 'Lamp')!)!.variantId, offerId: m.gB.items[0]!.offer.offerId, quantity: 1, kind: 'replacement' };
    await h.publish('returns', 'returns.replacement.created', replacement);
    await h.publish('returns', 'returns.replacement.created', replacement);
    const o = (await h.service.getOrder(m.order.id))!;
    const lines = o.groups[1]!.items;
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatchObject({ state: 'confirmed', replacementOfItemId: itemB.id, paidAmount: { amount: 0 } });
  });

  it('flags chargebacks, cases and restricted sellers for staff', async () => {
    const m = await twoSellerOrder();
    await h.publish('payments', 'payments.chargeback.opened', { disputeId: newId(), ref: 'DP-1', kind: 'fraud', orderId: m.order.id, groupId: null, sellerId: null, amount: { amount: 100, currency: 'USD' }, evidenceDueAt: null });
    await h.publish('support', 'support.case.opened', { caseId: newId(), ref: 'CS-261009-0001', kind: 'order', category: 'not_received', priority: 'normal', customerId: m.customerId, sellerId: m.sellerA, orderId: m.order.id, orderItemIds: [m.gA.items[0]!.id], handler: 'seller', nextResponseDueAt: null });
    await h.publish('sellers', 'sellers.seller.restricted', {
      sellerId: m.sellerA,
      restrictionId: newId(),
      reasonCode: 'late_dispatch',
      reason: 'Late dispatch rate above target',
      affectedActivities: ['sales'],
      scope: { categoryIds: [] },
      categoryIds: [],
      appealRoute: 'Seller Center',
      appealDeadline: now(),
      reviewDate: '2026-12-01',
      trustReportId: null,
      trustEnforcementId: null,
    });
    const staff = tokens.staff();
    const res = await h.call('GET', `/api/admin/orders/orders/${m.order.id}`, staff);
    expect(res.status).toBe(200);
    expect(res.body.flags.map((f: any) => f.kind)).toEqual(expect.arrayContaining(['chargeback', 'case_open', 'seller_restricted']));
    expect(res.body.order.cases[0]).toMatchObject({ ref: 'CS-261009-0001' });
    expect(res.body.order.groups[0].items[0].afterSales.caseRef).toBe('CS-261009-0001');
    const flagged = await h.call('GET', '/api/admin/orders/orders?flag=chargeback', staff);
    expect(flagged.body.items.map((r: any) => r.id)).toContain(m.order.id);
    // the seller keeps access and can still fulfil
    expect((await h.call('POST', `/api/seller/orders/orders/${m.gA.id}/start-preparing`, tokens.seller(m.sellerA))).status).toBe(200);
  });

  it('completes an order when every item is final and the return windows have closed', async () => {
    const customerId = newId();
    const sellerId = newId();
    const p = product(h, { title: 'Vase', price: 2000, sellerId });
    const order = await h.service.createOrder(checkout([group(h, [line(p, 1)], { sellerId })], { customerId }));
    const item = order.groups[0]!.items[0]!;
    const s = await ship(order.id, order.groups[0]!.id, sellerId, [{ orderItemId: item.id, quantity: 1 }]);
    await h.publish('shipping', 'shipping.shipment.delivered', { shipmentId: s, kind: 'outbound', orderId: order.id, groupId: order.groups[0]!.id, sellerId, lines: [], deliveredAt: now() });
    await h.app.kernel.jobs.runNow('orders.complete-orders');
    expect((await h.service.getOrder(order.id))!.lifecycle).toBe('open');
    h.clock.advance(31 * 86_400_000);
    await h.app.kernel.jobs.runNow('orders.complete-orders');
    await h.app.kernel.events.drain();
    h.clock.set(new Date());
    const after = (await h.service.getOrder(order.id))!;
    expect(after.lifecycle).toBe('completed');
    expect(after.status.value).toBe('completed');
    expect(h.named('orders.order.completed').find((e) => e.orderId === order.id)).toBeTruthy();
  });

  it('refreshes time-based flags (overdue dispatch) and saved filter counts', async () => {
    const sellerId = newId();
    const p = product(h, { title: 'Stool', price: 2000, sellerId });
    const order = await h.service.createOrder(checkout([group(h, [line(p, 1)], { sellerId, dispatchInHours: 1 })], { customerId: newId() }));
    const staff = tokens.staff();
    const saved = await h.call('POST', '/api/admin/orders/saved-filters', staff, { name: 'Overdue', query: { flag: 'overdue_dispatch' }, shared: true });
    expect(saved.status).toBe(201);
    h.clock.advance(2 * 3_600_000);
    await h.app.kernel.jobs.runNow('orders.refresh-flags');
    h.clock.set(new Date());
    const res = await h.call('GET', `/api/admin/orders/orders?savedFilterId=${saved.body.id}`, staff);
    expect(res.body.items.map((r: any) => r.id)).toContain(order.id);
    const list = await h.call('GET', '/api/admin/orders/saved-filters', staff);
    expect(list.body.find((f: any) => f.id === saved.body.id).count).toBeGreaterThanOrEqual(1);
  });
});
