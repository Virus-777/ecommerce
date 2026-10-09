/** Fulfillment requests for orders of service offers, service returns and removal orders. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { A, ADDRESS, arrivedInbound, boot, receiveAll, S, type Kit } from './helpers.js';

let k: Kit;
beforeAll(async () => {
  k = await boot();
});
afterAll(async () => {
  await k?.app.close();
});

const USD = (amount: number) => ({ amount, currency: 'USD' });

async function stocked(units: number) {
  const s = await k.enrolledSeller();
  const id = await arrivedInbound(k, s, units);
  await receiveAll(k, id, s.skuId, units);
  return s;
}

function placed(orderId: string, groupId: string, sellerId: string, itemIds: string[]) {
  return {
    orderId,
    ref: 'MK-261010-00042',
    checkoutSessionId: newId(),
    customerId: newId(),
    guestEmail: null,
    paymentIntentId: newId(),
    paymentState: 'accepted',
    total: USD(5000),
    couponCodes: [],
    groups: [{ groupId, ownerType: 'seller', sellerId, fulfilledBy: 'seller', dispatchBy: new Date(Date.now() + 86_400_000).toISOString(), itemIds, total: USD(5000) }],
    placedAt: new Date().toISOString(),
  };
}

function dispatched(orderId: string, groupId: string, sellerId: string, lines: { orderItemId: string; quantity: number }[]) {
  return {
    shipmentId: newId(),
    kind: 'outbound',
    orderId,
    groupId,
    returnId: null,
    ownerType: 'seller',
    sellerId,
    lines: lines.map((l) => ({ ...l, title: 'Linen throw', variantLabel: 'Natural' })),
    shippedAt: new Date().toISOString(),
    dispatchDueAt: null,
    onTime: true,
    trackingValid: true,
    estimatedArrival: null,
  };
}

describe('fulfillment requests', () => {
  it('routes a placed order with service offers, reserves seller-owned units, ships them with pick-and-pack and order handling fees', async () => {
    const s = await stocked(6);
    const orderId = newId();
    const groupId = newId();
    const itemId = newId();
    k.tasks.set(groupId, { orderRef: 'MK-261010-00042', dueAt: new Date(Date.now() + 86_400_000).toISOString(), lines: [{ orderItemId: itemId, offerId: s.offerId, stockItemId: s.stockItemId, quantity: 2 }] });
    await k.publish('orders', 'orders.order.placed', placed(orderId, groupId, s.sellerId, [itemId]));
    // a redelivered event changes nothing
    await k.publish('orders', 'orders.order.placed', placed(orderId, groupId, s.sellerId, [itemId]));
    let list = await k.call('GET', A(`/fulfillment-requests?sellerId=${s.sellerId}`));
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({ orderId, orderRef: 'MK-261010-00042', sellerGroupId: groupId, sellerId: s.sellerId, state: 'open', items: [{ orderItemId: itemId, offerId: s.offerId, sku: s.sku, quantity: 2, picked: 0 }], dispatchBy: { state: 'on_time' } });
    let sku = (await k.call('GET', S('/skus'), { token: s.token })).body.items[0];
    expect(sku.stock).toMatchObject({ available: 4, reserved: 2 });

    // the public API answers the same request for the same group
    const again = await k.api.createFulfillmentRequest(orderId, groupId, [{ orderItemId: itemId, offerId: s.offerId, quantity: 2 }]);
    expect(again.id).toBe(list.body.items[0].id);

    await k.publish('shipping', 'shipping.shipment.dispatched', dispatched(orderId, groupId, s.sellerId, [{ orderItemId: itemId, quantity: 2 }]));
    list = await k.call('GET', A(`/fulfillment-requests?sellerId=${s.sellerId}&state=shipped`));
    expect(list.body.items[0]).toMatchObject({ state: 'shipped', items: [{ picked: 2 }] });
    sku = (await k.call('GET', S('/skus'), { token: s.token })).body.items[0];
    expect(sku.stock).toMatchObject({ available: 4, reserved: 0 });
    const fees = await k.call('GET', S('/fees?type=pick_pack'), { token: s.token });
    expect(fees.body.items.map((f: any) => [f.type, f.units, f.amount.amount, f.reference])).toEqual([['pick_pack', 2, 700, 'MK-261010-00042']]);
    const handling = await k.call('GET', S('/fees?type=order_handling'), { token: s.token });
    expect(handling.body.items.map((f: any) => f.amount.amount)).toEqual([100]);
    // dispatched twice: no second fee
    await k.publish('shipping', 'shipping.shipment.dispatched', dispatched(orderId, groupId, s.sellerId, [{ orderItemId: itemId, quantity: 2 }]));
    expect((await k.call('GET', S('/fees?type=pick_pack'), { token: s.token })).body.items).toHaveLength(1);
  });

  it('is short without enough stock, releases reservations of cancelled items and refuses orders without service offers', async () => {
    const s = await stocked(3);
    const orderId = newId();
    const groupId = newId();
    const [a, b] = [newId(), newId()];
    const req = await k.api.createFulfillmentRequest(orderId, groupId, [
      { orderItemId: a, offerId: s.offerId, quantity: 2 },
      { orderItemId: b, offerId: s.offerId, quantity: 2 },
    ]);
    expect(req.state).toBe('short');
    let sku = (await k.call('GET', S('/skus'), { token: s.token })).body.items[0];
    expect(sku.stock).toMatchObject({ available: 0, reserved: 3 });

    const cancelled = { orderId, ref: 'MK-261010-00077', groupId, ownerType: 'seller', sellerId: s.sellerId, itemId: b, offerId: s.offerId, stockItemId: s.stockItemId, quantity: 2, cancellationId: newId(), initiatedBy: 'customer', reasonCode: 'changed_mind', beforeDispatch: true, countsAgainstSeller: false, refund: { itemAmount: USD(2000), discountShare: USD(0), shippingRefund: USD(0), taxRefund: USD(0), total: USD(2000) }, paymentIntentId: newId(), trustReportId: null };
    await k.publish('orders', 'orders.item.cancelled', cancelled);
    await k.publish('orders', 'orders.item.cancelled', cancelled);
    sku = (await k.call('GET', S('/skus'), { token: s.token })).body.items[0];
    expect(sku.stock).toMatchObject({ available: 1, reserved: 2 });
    const list = await k.call('GET', A(`/fulfillment-requests?sellerId=${s.sellerId}`));
    expect(list.body.items[0]).toMatchObject({ state: 'open', items: [{ quantity: 2 }, { quantity: 0, cancelled: 2 }] });
    await k.publish('orders', 'orders.item.cancelled', { ...cancelled, itemId: a, cancellationId: newId() });
    expect((await k.call('GET', A(`/fulfillment-requests?sellerId=${s.sellerId}`))).body.items[0].state).toBe('cancelled');
    expect((await k.call('GET', S('/skus'), { token: s.token })).body.items[0].stock).toMatchObject({ available: 3, reserved: 0 });

    const other = await k.seller();
    const plain = await other.offer();
    await expect(k.api.createFulfillmentRequest(newId(), newId(), [{ orderItemId: newId(), offerId: plain.offerId, quantity: 1 }])).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(await k.api.isServiceOffer(plain.offerId)).toBe(false);
  });
});

describe('service returns', () => {
  it('receives returned units of a shipped service order, charges returns processing and records inspection outcomes', async () => {
    const s = await stocked(5);
    const orderId = newId();
    const groupId = newId();
    const [a, b] = [newId(), newId()];
    await k.api.createFulfillmentRequest(orderId, groupId, [
      { orderItemId: a, offerId: s.offerId, quantity: 1 },
      { orderItemId: b, offerId: s.offerId, quantity: 2 },
    ]);
    await k.publish('shipping', 'shipping.shipment.dispatched', dispatched(orderId, groupId, s.sellerId, [{ orderItemId: a, quantity: 1 }, { orderItemId: b, quantity: 2 }]));
    const returnId = newId();
    k.returns.set(returnId, { ref: 'RT-261010-0001', sellerId: s.sellerId, items: new Map([[b, 2]]) });
    const received = { returnId, ownerType: 'seller', sellerId: s.sellerId, receivedAt: new Date().toISOString() };
    await k.publish('returns', 'returns.return.received', received);
    await k.publish('returns', 'returns.return.received', received);
    const list = await k.call('GET', S('/returns'), { token: s.token });
    expect(list.body.items).toHaveLength(1);
    const ret = list.body.items[0];
    expect(ret).toMatchObject({ returnId, returnRef: 'RT-261010-0001', sellerId: s.sellerId, skuEnrollmentId: s.skuId, quantity: 2, outcome: 'pending' });
    expect((await k.call('GET', S('/skus'), { token: s.token })).body.items[0].stock).toMatchObject({ available: 2, returned: 2 });
    expect((await k.call('GET', S('/fees?type=returns_processing'), { token: s.token })).body.items.map((f: any) => [f.units, f.amount.amount, f.reference])).toEqual([[2, 500, 'RT-261010-0001']]);
    // another seller's view and an Official Store return are ignored
    expect((await k.call('GET', S('/returns'), { token: (await k.seller()).token })).body.items).toHaveLength(0);
    await k.publish('returns', 'returns.return.received', { returnId: newId(), ownerType: 'official', sellerId: null, receivedAt: new Date().toISOString() });

    const before = (await k.inventory.getAvailability([s.stockItemId]))[s.stockItemId]!.available;
    expect((await k.call('POST', A(`/returns/${ret.id}/outcome`), { body: { outcome: 'restocked', note: '' } })).status).toBe(400);
    const restocked = await k.call('POST', A(`/returns/${ret.id}/outcome`), { body: { outcome: 'restocked', note: 'Sealed, like new' } });
    expect(restocked.status, JSON.stringify(restocked.body)).toBe(200);
    expect(restocked.body).toMatchObject({ outcome: 'restocked', inspectionNote: 'Sealed, like new' });
    expect(k.events('fulfillment-service.return.inspected').at(-1)).toEqual({ serviceReturnId: ret.id, returnId, sellerId: s.sellerId, outcome: 'restocked' });
    expect((await k.inventory.getAvailability([s.stockItemId]))[s.stockItemId]!.available).toBe(before + 2);
    expect((await k.call('GET', S('/skus'), { token: s.token })).body.items[0].stock).toMatchObject({ available: 4, returned: 0 });
    expect((await k.call('POST', A(`/returns/${ret.id}/outcome`), { body: { outcome: 'disposed', note: 'again' } })).status).toBe(409);
  });
});

describe('removal orders', () => {
  it('checks the stock group, cancels before approval, then approves (inventory), processes, ships and completes with the fee', async () => {
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
    expect(first.body).toMatchObject({ state: 'requested', kind: 'return_to_seller', lines: [{ skuEnrollmentId: s.skuId, expected: 4, received: 0 }], fee: { amount: 388, currency: 'USD' } });
    expect(first.body.ref).toMatch(/^RM-\d{6}-\d{4}$/);
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
    expect((await go('approve')).body.state).toBe('approved');
    expect((await k.inventory.getAvailability([s.stockItemId]))[s.stockItemId]!.available).toBe(2);
    expect((await k.call('GET', S('/skus'), { token: s.token })).body.items[0].stock).toMatchObject({ available: 2, removalPending: 3 });
    expect((await go('startProcessing')).body.state).toBe('processing');
    expect((await go('complete')).status).toBe(409);
    expect((await go('ship')).status).toBe(400);
    expect((await go('ship', { tracking: '9400111899223' })).body).toMatchObject({ state: 'shipped', tracking: '9400111899223' });
    const done = await go('complete');
    expect(done.body).toMatchObject({ state: 'completed', fee: { amount: 291 }, lines: [{ received: 3 }] });
    expect(k.events('fulfillment-service.removal.completed').at(-1)).toEqual({ removalId: id, sellerId: s.sellerId, units: 3 });
    expect((await k.call('GET', S('/skus'), { token: s.token })).body.items[0].stock).toMatchObject({ available: 2, removalPending: 0 });
    expect((await k.call('GET', A(`/removals?sellerId=${s.sellerId}&state=completed`))).body.items.map((r: any) => r.id)).toEqual([id]);

    // disposal never ships
    const dispose = await k.call('POST', S('/removals'), { token: s.token, body: { kind: 'dispose', lines: [{ skuEnrollmentId: s.skuId, quantity: 1 }], fromGroup: 'available' }, headers: { 'idempotency-key': newId() } });
    const d = (action: string, extra: Record<string, unknown> = {}) => k.call('POST', A(`/removals/${dispose.body.id}/transition`), { body: { action, ...extra } });
    await d('approve');
    await d('startProcessing');
    expect((await d('ship', { tracking: 'x' })).status).toBe(409);
    expect((await d('complete')).body).toMatchObject({ state: 'completed', fee: { amount: 50 } });
  });
});
