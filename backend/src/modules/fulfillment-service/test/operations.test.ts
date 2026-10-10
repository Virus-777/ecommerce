/** Fulfillment requests for orders Marketly fulfils, service returns and removal orders. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { A, ADDRESS, boot, S, stocked as stockedFor, type Kit } from './helpers.js';

let k: Kit;
beforeAll(async () => {
  k = await boot();
});
afterAll(async () => {
  await k?.app.close();
});

const USD = (amount: number) => ({ amount, currency: 'USD' });
const stocked = (units: number) => stockedFor(k, units);
const stock = async (s: { token: string }) => (await k.call('GET', S('/skus'), { token: s.token })).body.items[0].stock;
const requests = async (sellerId: string, q = '') => (await k.call('GET', A(`/fulfillment-requests?sellerId=${sellerId}${q}`))).body.items;

type Line = { orderItemId: string; offerId: string; stockItemId: string; quantity: number };

function accepted(orderId: string, groups: { groupId: string; sellerId: string; fulfilledBy?: string; lines: Line[] }[], ref = 'MK-261010-00042') {
  return {
    orderId,
    ref,
    customerId: newId(),
    contactEmail: 'sam@example.com',
    total: USD(5000),
    groups: groups.map((g) => ({ groupId: g.groupId, ownerType: 'seller', sellerId: g.sellerId, fulfilledBy: g.fulfilledBy ?? 'marketly_service', dispatchBy: new Date(Date.now() + 86_400_000).toISOString(), itemIds: g.lines.map((l) => l.orderItemId), total: USD(5000) })),
    items: groups.flatMap((g) => g.lines),
    reservationId: null,
    acceptedAt: new Date().toISOString(),
  };
}

function dispatched(orderId: string, groupId: string, sellerId: string, lines: { orderItemId: string; quantity: number }[], shipmentId = newId()) {
  return {
    shipmentId,
    kind: 'outbound',
    orderId,
    customerId: null,
    contactEmail: 'sam@example.com',
    groupId,
    returnId: null,
    ownerType: 'seller',
    sellerId,
    fulfilledBy: 'marketly_service',
    lines: lines.map((l) => ({ ...l, title: 'Linen throw', variantLabel: 'Natural' })),
    shippedAt: new Date().toISOString(),
    dispatchDueAt: null,
    onTime: true,
    trackingValid: true,
    estimatedArrival: null,
  };
}

function cancelled(orderId: string, groupId: string, sellerId: string, l: Line, quantity: number) {
  return { orderId, ref: 'MK-261010-00077', customerId: null, contactEmail: 'sam@example.com', groupId, ownerType: 'seller', sellerId, fulfilledBy: 'marketly_service', itemId: l.orderItemId, offerId: l.offerId, stockItemId: l.stockItemId, quantity, cancellationId: newId(), initiatedBy: 'customer', reasonCode: 'changed_mind', beforeDispatch: true, countsAgainstSeller: false, refund: { itemAmount: USD(2000), discountShare: USD(0), shippingRefund: USD(0), taxRefund: USD(0), total: USD(2000) }, paymentIntentId: newId(), trustReportId: null, notifyCustomer: true };
}

describe('fulfillment requests', () => {
  it('routes accepted Marketly-fulfilled groups, reserves seller-owned units and ships them across two packages with one order-handling fee', async () => {
    const s = await stocked(6);
    const orderId = newId();
    const groupId = newId();
    const line: Line = { orderItemId: newId(), offerId: s.offerId, stockItemId: s.stockItemId, quantity: 3 };
    // a seller-shipped group of the same seller is not ours
    const own = { groupId: newId(), sellerId: s.sellerId, fulfilledBy: 'seller', lines: [{ orderItemId: newId(), offerId: newId(), stockItemId: newId(), quantity: 1 }] };
    const event = accepted(orderId, [{ groupId, sellerId: s.sellerId, lines: [line] }, own]);
    await k.publish('orders', 'orders.order.accepted', event);
    await k.publish('orders', 'orders.order.accepted', event); // redelivered: nothing changes
    let list = await requests(s.sellerId);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ orderId, orderRef: 'MK-261010-00042', sellerGroupId: groupId, sellerId: s.sellerId, state: 'open', items: [{ orderItemId: line.orderItemId, offerId: s.offerId, sku: s.sku, quantity: 3, picked: 0, shipped: 0 }], dispatchBy: { dueAt: event.groups[0]!.dispatchBy, state: 'on_time' } });
    expect(await stock(s)).toMatchObject({ available: 3, reserved: 3 });
    expect(k.notices.filter((n) => n.dedupeKey === `fs:order:${groupId}`)).toEqual([expect.objectContaining({ topic: 'seller.fulfillment.order_received', context: { order: { ref: 'MK-261010-00042' }, items: '3 units' } })]);

    // the public API answers the same request for the same group
    const again = await k.api.createFulfillmentRequest(orderId, groupId, [{ orderItemId: line.orderItemId, offerId: s.offerId, quantity: 3 }]);
    expect(again.id).toBe(list[0].id);

    // the warehouse works it: picking, then packed (never backwards)
    const taskId = newId();
    const status = (from: string, to: string) => k.publish('warehouse', 'warehouse.fulfillment.status_changed', { fulfillmentId: taskId, orderId, sellerGroupId: groupId, fulfilledBy: 'marketly_service', sellerId: s.sellerId, from, to, reason: null });
    await status('awaiting_pick', 'picking');
    expect((await requests(s.sellerId))[0].state).toBe('picking');
    await status('packing', 'packed');
    await status('picking', 'picked');
    expect((await requests(s.sellerId))[0]).toMatchObject({ state: 'packed', warehouseTaskId: taskId });

    // two packages: 2 units, then 1
    const first = newId();
    await k.publish('shipping', 'shipping.shipment.dispatched', dispatched(orderId, groupId, s.sellerId, [{ orderItemId: line.orderItemId, quantity: 2 }], first));
    await k.publish('shipping', 'shipping.shipment.dispatched', dispatched(orderId, groupId, s.sellerId, [{ orderItemId: line.orderItemId, quantity: 2 }], first)); // twice: once
    list = await requests(s.sellerId);
    expect(list[0]).toMatchObject({ state: 'packed', shipmentId: first, items: [{ shipped: 2 }] });
    expect(await stock(s)).toMatchObject({ available: 3, reserved: 1 });
    const second = newId();
    await k.publish('shipping', 'shipping.shipment.dispatched', dispatched(orderId, groupId, s.sellerId, [{ orderItemId: line.orderItemId, quantity: 1 }], second));
    list = await requests(s.sellerId, '&state=shipped');
    expect(list[0]).toMatchObject({ state: 'shipped', shipmentId: second, items: [{ shipped: 3, picked: 3 }] });
    expect(await stock(s)).toMatchObject({ available: 3, reserved: 0 });
    const fees = await k.call('GET', S('/fees?type=pick_pack'), { token: s.token });
    expect(fees.body.items.map((f: any) => [f.units, f.amount.amount, f.reference]).sort()).toEqual([
      [1, 350, 'MK-261010-00042'],
      [2, 700, 'MK-261010-00042'],
    ]);
    expect((await k.call('GET', S('/fees?type=order_handling'), { token: s.token })).body.items.map((f: any) => f.amount.amount)).toEqual([100]);
    // a seller-shipped package and a return are not ours
    await k.publish('shipping', 'shipping.shipment.dispatched', { ...dispatched(orderId, own.groupId, s.sellerId, [{ orderItemId: own.lines[0]!.orderItemId, quantity: 1 }]), fulfilledBy: 'seller' });
    expect((await k.call('GET', S('/fees?type=pick_pack'), { token: s.token })).body.items).toHaveLength(2);
  });

  it('is short without enough stock (work item), releases reservations of cancelled and split items, and cancels with the order', async () => {
    const s = await stocked(3);
    const orderId = newId();
    const groupId = newId();
    const a: Line = { orderItemId: newId(), offerId: s.offerId, stockItemId: s.stockItemId, quantity: 2 };
    const b: Line = { orderItemId: newId(), offerId: s.offerId, stockItemId: s.stockItemId, quantity: 2 };
    await k.publish('orders', 'orders.order.accepted', accepted(orderId, [{ groupId, sellerId: s.sellerId, lines: [a, b] }]));
    let req = (await requests(s.sellerId))[0];
    expect(req.state).toBe('short');
    expect(await stock(s)).toMatchObject({ available: 0, reserved: 3 });
    expect(k.work.find((w) => w.dedupeKey === `fs_request_short:${req.id}`)).toMatchObject({ queueKey: 'fulfillment.requests', kind: 'pick_pack', sellerId: s.sellerId, subject: { type: 'order', id: orderId } });

    // b is split: 1 unit moves to a new line, which is then cancelled (claimed once per cancellation)
    const split = { orderId, groupId, itemId: b.orderItemId, newItemId: newId(), rootItemId: b.orderItemId, offerId: s.offerId, stockItemId: s.stockItemId, quantity: 1, remainingQuantity: 1, reason: 'cancellation', at: new Date().toISOString() };
    await k.publish('orders', 'orders.item.split', split);
    await k.publish('orders', 'orders.item.split', split);
    req = (await requests(s.sellerId))[0];
    expect(req.items.map((i: any) => [i.orderItemId, i.quantity])).toEqual([
      [a.orderItemId, 2],
      [b.orderItemId, 1],
      [split.newItemId, 1],
    ]);
    const c = cancelled(orderId, groupId, s.sellerId, { ...b, orderItemId: split.newItemId }, 1);
    await k.publish('orders', 'orders.item.cancelled', c);
    await k.publish('orders', 'orders.item.cancelled', c);
    req = (await requests(s.sellerId))[0];
    expect(req).toMatchObject({ state: 'open', items: [{ quantity: 2 }, { quantity: 1 }, { quantity: 0, cancelled: 1 }] });
    expect(await stock(s)).toMatchObject({ available: 0, reserved: 3 });
    expect(k.resolved).toContain(`fs_request_short:${req.id}`);

    // the warehouse reports a pick shortage: short again, with a work item
    await k.publish('warehouse', 'warehouse.fulfillment.status_changed', { fulfillmentId: newId(), orderId, sellerGroupId: groupId, fulfilledBy: 'marketly_service', sellerId: s.sellerId, from: 'picking', to: 'on_hold', reason: 'Bin empty' });
    req = (await requests(s.sellerId))[0];
    expect(req).toMatchObject({ state: 'short', shortReportedAt: expect.any(String) });

    // the order is cancelled: every reservation goes back (once)
    const orderCancelled = { orderId, ref: 'MK-261010-00077', reason: 'all_items_cancelled', checkoutSessionId: newId() };
    await k.publish('orders', 'orders.order.cancelled', orderCancelled);
    await k.publish('orders', 'orders.order.cancelled', orderCancelled);
    expect((await requests(s.sellerId))[0].state).toBe('cancelled');
    expect(await stock(s)).toMatchObject({ available: 3, reserved: 0 });

    const other = await k.seller();
    const plain = await other.offer();
    await expect(k.api.createFulfillmentRequest(newId(), newId(), [{ orderItemId: newId(), offerId: plain.offerId, quantity: 1 }])).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(await k.api.isServiceOffer(plain.offerId)).toBe(false);
  });
});

describe('service returns', () => {
  it('receives returned items of a shipped order (inventory Returned), stores the proposed outcome and records the staff outcome', async () => {
    const s = await stocked(5);
    const orderId = newId();
    const groupId = newId();
    const a: Line = { orderItemId: newId(), offerId: s.offerId, stockItemId: s.stockItemId, quantity: 1 };
    const b: Line = { orderItemId: newId(), offerId: s.offerId, stockItemId: s.stockItemId, quantity: 2 };
    await k.publish('orders', 'orders.order.accepted', accepted(orderId, [{ groupId, sellerId: s.sellerId, lines: [a, b] }], 'MK-261010-00077'));
    await k.publish('shipping', 'shipping.shipment.dispatched', dispatched(orderId, groupId, s.sellerId, [{ orderItemId: a.orderItemId, quantity: 1 }, { orderItemId: b.orderItemId, quantity: 2 }]));
    // what inventory did for the order (outside this module): the shipped units left the service location
    k.inv.level(s.stockItemId).available -= 3;
    const returnId = newId();
    const received = { returnId, ref: 'RT-261010-0001', orderId, orderRef: 'MK-261010-00077', customerId: null, contactEmail: 'sam@example.com', ownerType: 'seller', sellerId: s.sellerId, fulfilledBy: 'marketly_service', items: [{ orderItemId: b.orderItemId, quantity: 2, variantId: newId(), stockItemId: s.stockItemId }], receivedAt: new Date().toISOString() };
    await k.publish('returns', 'returns.return.received', received);
    await k.publish('returns', 'returns.return.received', received);
    const list = await k.call('GET', S('/returns'), { token: s.token });
    expect(list.body.items).toHaveLength(1);
    const ret = list.body.items[0];
    expect(ret).toMatchObject({ returnId, returnRef: 'RT-261010-0001', sellerId: s.sellerId, skuEnrollmentId: s.skuId, orderItemId: b.orderItemId, quantity: 2, outcome: 'pending', proposedOutcome: null });
    expect(await stock(s)).toMatchObject({ available: 2, returned: 2 });
    expect(k.inv.level(s.stockItemId)).toMatchObject({ available: 2, returned: 2 });
    expect(k.inv.moves().find((m) => m.key === `fs:return-received:${ret.id}`)).toMatchObject({ from: null, to: 'returned', quantity: 2, reasonCode: 'service_return_received', ref: { kind: 'service_return', id: ret.id } });
    expect((await k.call('GET', S('/fees?type=returns_processing'), { token: s.token })).body.items.map((f: any) => [f.units, f.amount.amount, f.reference])).toEqual([[2, 500, 'RT-261010-0001']]);
    // another seller's view, a seller-shipped return and an Official Store return are ignored
    expect((await k.call('GET', S('/returns'), { token: (await k.seller()).token })).body.items).toHaveLength(0);
    await k.publish('returns', 'returns.return.received', { ...received, returnId: newId(), fulfilledBy: 'seller' });
    await k.publish('returns', 'returns.return.received', { ...received, returnId: newId(), ownerType: 'official', sellerId: null, fulfilledBy: 'official_warehouse' });
    expect((await k.call('GET', S('/returns'), { token: s.token })).body.items).toHaveLength(1);

    // returns' inspection proposes an outcome; staff confirm it here (decision D8)
    await k.publish('returns', 'returns.return.inspected', { returnId, ref: 'RT-261010-0001', orderId, orderRef: 'MK-261010-00077', customerId: null, contactEmail: 'sam@example.com', ownerType: 'seller', sellerId: s.sellerId, fulfilledBy: 'marketly_service', conditionOutcome: 'as_new', proposedStockOutcome: 'restock', orderItemId: b.orderItemId, variantId: newId(), stockItemId: s.stockItemId, quantity: 2 });
    expect((await k.call('GET', S('/returns'), { token: s.token })).body.items[0].proposedOutcome).toBe('restock');

    expect((await k.call('POST', A(`/returns/${ret.id}/outcome`), { body: { outcome: 'restocked', note: '' } })).status).toBe(400);
    const restocked = await k.call('POST', A(`/returns/${ret.id}/outcome`), { body: { outcome: 'restocked', note: 'Sealed, like new' } });
    expect(restocked.status, JSON.stringify(restocked.body)).toBe(200);
    expect(restocked.body).toMatchObject({ outcome: 'restocked', inspectionNote: 'Sealed, like new' });
    expect(k.events('fulfillment-service.return.inspected').at(-1)).toEqual({ serviceReturnId: ret.id, returnId, sellerId: s.sellerId, outcome: 'restocked' });
    expect(k.inv.level(s.stockItemId)).toMatchObject({ available: 4, returned: 0 });
    expect(await stock(s)).toMatchObject({ available: 4, returned: 0 });
    expect(k.notices.find((n) => n.dedupeKey === `fs:return:${ret.id}`)).toMatchObject({ topic: 'seller.fulfillment.return_inspected', context: { return: { ref: 'RT-261010-0001' }, outcome: 'restocked' } });
    expect(k.audits.find((x) => x.action === 'fulfillment-service.return.outcome' && x.target.id === ret.id)).toMatchObject({ category: 'returns', reason: 'Sealed, like new' });
    expect((await k.call('POST', A(`/returns/${ret.id}/outcome`), { body: { outcome: 'disposed', note: 'again' } })).status).toBe(409);
  });
});

describe('removal orders', () => {
  it('checks the stock group, cancels before approval, then approves (inventory damaged_held), processes, ships and completes with the fee', async () => {
    const s = await stocked(5);
    const body = (quantity: number, o: Record<string, unknown> = {}) => ({ kind: 'return_to_seller', lines: [{ skuEnrollmentId: s.skuId, quantity }], fromGroup: 'available', shipTo: ADDRESS, reason: 'Season over', ...o });
    const tooMany = await k.call('POST', S('/removals'), { token: s.token, body: body(6), headers: { 'idempotency-key': newId() } });
    expect(tooMany.status).toBe(409);
    expect(tooMany.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect((await k.call('POST', S('/removals'), { token: s.token, body: body(1, { shipTo: null }), headers: { 'idempotency-key': newId() } })).status).toBe(400);
    const unsellable = await k.call('POST', S('/removals'), { token: s.token, body: body(1, { fromGroup: 'unsellable' }), headers: { 'idempotency-key': newId() } });
    expect(unsellable.body.error.code).toBe('INSUFFICIENT_STOCK');

    const first = await k.call('POST', S('/removals'), { token: s.token, body: body(4), headers: { 'idempotency-key': newId() } });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body).toMatchObject({ state: 'requested', kind: 'return_to_seller', reason: 'Season over', lines: [{ skuEnrollmentId: s.skuId, expected: 4, received: 0 }], fee: { amount: 388, currency: 'USD' }, approvedAt: null });
    expect(first.body.ref).toMatch(/^RM-\d{6}-\d{4}$/);
    expect(k.audits.find((x) => x.action === 'fulfillment-service.removal.request' && x.target.id === first.body.id)).toMatchObject({ visibleToSeller: true });
    // requested units count against new removals
    expect((await k.call('POST', S('/removals'), { token: s.token, body: body(2), headers: { 'idempotency-key': newId() } })).body.error.code).toBe('INSUFFICIENT_STOCK');
    const other = await k.seller();
    expect((await k.call('POST', S(`/removals/${first.body.id}/cancel`), { token: other.token })).status).toBe(404);
    expect((await k.call('POST', S(`/removals/${first.body.id}/cancel`), { token: s.token })).body.state).toBe('cancelled');
    expect((await k.call('POST', S(`/removals/${first.body.id}/cancel`), { token: s.token })).status).toBe(409);

    const second = await k.call('POST', S('/removals'), { token: s.token, body: body(3), headers: { 'idempotency-key': newId() } });
    const id = second.body.id;
    const go = (action: string, extra: Record<string, unknown> = {}) => k.call('POST', A(`/removals/${id}/transition`), { body: { action, ...extra } });
    expect((await go('startProcessing')).status).toBe(409);
    const approved = await go('approve');
    expect(approved.body).toMatchObject({ state: 'approved', approvedAt: expect.any(String) });
    expect(k.inv.level(s.stockItemId)).toMatchObject({ available: 2, damagedHeld: 3 });
    expect(k.inv.moves().find((m) => m.key === `fs:removal-approve:${id}:${s.skuId}`)).toMatchObject({ reasonCode: 'service_removal_reserved', ref: { kind: 'service_removal', id } });
    expect(await stock(s)).toMatchObject({ available: 2, removalPending: 3 });
    expect((await go('startProcessing')).body.state).toBe('processing');
    expect((await go('complete')).status).toBe(409);
    expect((await go('ship')).status).toBe(400);
    expect((await go('ship', { tracking: '9400111899223' })).body).toMatchObject({ state: 'shipped', tracking: '9400111899223' });
    const done = await go('complete');
    expect(done.body).toMatchObject({ state: 'completed', fee: { amount: 291 }, lines: [{ received: 3 }], completedAt: expect.any(String) });
    expect(k.inv.level(s.stockItemId)).toMatchObject({ available: 2, damagedHeld: 0 });
    expect(k.events('fulfillment-service.removal.completed').at(-1)).toEqual({ removalId: id, sellerId: s.sellerId, units: 3 });
    expect(k.notices.find((n) => n.dedupeKey === `fs:removal:${id}`)).toMatchObject({ topic: 'seller.fulfillment.removal_completed', context: { removal: { ref: second.body.ref }, units: 3 } });
    expect(k.audits.filter((x) => x.target?.id === id).map((x) => x.action)).toEqual(expect.arrayContaining(['fulfillment-service.removal.approve', 'fulfillment-service.removal.complete']));
    expect(await stock(s)).toMatchObject({ available: 2, removalPending: 0 });
    expect((await k.call('GET', A(`/removals?sellerId=${s.sellerId}&state=completed`))).body.items.map((r: any) => r.id)).toEqual([id]);

    // inventory refuses (the units are not there): approval fails and nothing changes
    k.inv.level(s.stockItemId).available = 0;
    const third = await k.call('POST', S('/removals'), { token: s.token, body: body(1), headers: { 'idempotency-key': newId() } });
    const refused = await k.call('POST', A(`/removals/${third.body.id}/transition`), { body: { action: 'approve' } });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect((await k.call('GET', S('/removals'), { token: s.token })).body.items.find((r: any) => r.id === third.body.id).state).toBe('requested');
    k.inv.level(s.stockItemId).available = 2;

    // disposal never ships
    const dispose = await k.call('POST', S('/removals'), { token: s.token, body: { kind: 'dispose', lines: [{ skuEnrollmentId: s.skuId, quantity: 1 }], fromGroup: 'available' }, headers: { 'idempotency-key': newId() } });
    const d = (action: string, extra: Record<string, unknown> = {}) => k.call('POST', A(`/removals/${dispose.body.id}/transition`), { body: { action, ...extra } });
    await d('approve');
    await d('startProcessing');
    expect((await d('ship', { tracking: 'x' })).status).toBe(409);
    expect((await d('complete')).body).toMatchObject({ state: 'completed', fee: { amount: 50 } });
  });
});
