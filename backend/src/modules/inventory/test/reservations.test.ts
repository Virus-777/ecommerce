/**
 * Checkout holds, order allocation, fulfilment on dispatch, release on cancel and expiry. Never oversell:
 * concurrent holds on the last units, idempotent retries, and the ledger always equals the quantities.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { admin, eventsNamed, harness, ledgerMismatches, officialItem, quantities, reservedMismatches, sellerItem, staffHeaders, warehouse, type Harness } from './helpers.js';

let h: Harness;
let loc: { id: string };
const sellerId = newId();

beforeAll(async () => {
  h = await harness();
  loc = await warehouse(h, 'RNO1');
});
afterAll(async () => {
  await h?.app.close();
});
beforeEach(async () => {
  await h.app.kernel.events.drain();
  h.events.length = 0;
  h.audits.length = 0;
});

const accepted = (orderId: string, ref: string, itemIds: string[]) =>
  h.app.kernel.events.publish('orders', 'orders.order.accepted', {
    orderId,
    ref,
    customerId: newId(),
    contactEmail: 'sam@example.com',
    total: { amount: 18900, currency: 'USD' },
    groups: [{ groupId: newId(), ownerType: 'official', sellerId: null, fulfilledBy: 'official_warehouse', dispatchBy: new Date().toISOString(), itemIds, total: { amount: 18900, currency: 'USD' } }],
    items: [], // these orders were attached by checkout (attachOrder); see correctness.test.ts for allocation from items
    acceptedAt: new Date().toISOString(),
  });

const cancelled = (orderId: string, itemId: string, stockItemId: string, quantity: number, cancellationId = newId()) =>
  h.app.kernel.events.publish('orders', 'orders.item.cancelled', {
    orderId,
    ref: 'MK-261009-00001',
    groupId: newId(),
    ownerType: 'official',
    sellerId: null,
    itemId,
    offerId: newId(),
    stockItemId,
    quantity,
    cancellationId,
    initiatedBy: 'customer',
    notifyCustomer: true,
    reasonCode: 'changed_mind',
    beforeDispatch: true,
    countsAgainstSeller: false,
    refund: { itemAmount: { amount: 0, currency: 'USD' }, discountShare: { amount: 0, currency: 'USD' }, shippingRefund: { amount: 0, currency: 'USD' }, taxRefund: { amount: 0, currency: 'USD' }, total: { amount: 0, currency: 'USD' } },
    paymentIntentId: newId(),
  });

const dispatched = (orderId: string, lines: { orderItemId: string; quantity: number }[], shipmentId = newId()) =>
  h.app.kernel.events.publish('shipping', 'shipping.shipment.dispatched', {
    shipmentId,
    kind: 'outbound',
    orderId,
    groupId: newId(),
    ownerType: 'official',
    sellerId: null,
    lines: lines.map((l) => ({ ...l, title: 'Aurora', variantLabel: 'Black' })),
    shippedAt: new Date().toISOString(),
    trackingValid: true,
  });

describe('checkout holds', () => {
  it('holds all lines or none, with INSUFFICIENT_STOCK details per line', async () => {
    const a = await officialItem(h, loc.id, 5);
    const b = await officialItem(h, loc.id, 1);
    await expect(h.api.hold(`chk-${newId()}`, [{ stockItemId: a.id, quantity: 2 }, { stockItemId: b.id, quantity: 2 }])).rejects.toMatchObject({
      code: 'INSUFFICIENT_STOCK',
      status: 409,
      details: { lines: [{ stockItemId: b.id, requested: 2, available: 1 }] },
    });
    expect(await quantities(h, a.id)).toMatchObject({ available: 5, reserved: 0 }); // nothing was held
    const r = await h.api.hold(`chk-${newId()}`, [{ stockItemId: a.id, quantity: 2 }, { stockItemId: b.id, quantity: 1 }]);
    expect(r).toMatchObject({ state: 'held', orderId: null, expiresAt: expect.any(String) });
    expect(r.lines.map((l) => [l.stockItemId, l.quantity, l.state])).toEqual(expect.arrayContaining([[a.id, 2, 'held'], [b.id, 1, 'held']]));
    expect(new Date(r.expiresAt!).getTime() - h.clock.now().getTime()).toBe(15 * 60_000);
    expect(await quantities(h, a.id)).toMatchObject({ available: 3, reserved: 2 });
    await h.app.kernel.events.drain();
    expect(eventsNamed(h, 'inventory.stock.changed').filter((e) => e.stockItemId === b.id).at(-1)).toMatchObject({ available: 0, reserved: 1, state: 'out_of_stock', cause: 'checkout_hold' });
    expect(await ledgerMismatches(h)).toEqual([]);
  });

  it('is idempotent by checkout key: a retry returns the same hold and never double-counts', async () => {
    const a = await officialItem(h, loc.id, 4);
    const key = `chk-${newId()}`;
    const first = await h.api.hold(key, [{ stockItemId: a.id, quantity: 3 }]);
    const again = await h.api.hold(key, [{ stockItemId: a.id, quantity: 3 }]);
    expect(again.id).toBe(first.id);
    const racing = await Promise.all(Array.from({ length: 5 }, () => h.api.hold(key, [{ stockItemId: a.id, quantity: 3 }])));
    expect(new Set(racing.map((r) => r.id))).toEqual(new Set([first.id]));
    expect(await quantities(h, a.id)).toMatchObject({ available: 1, reserved: 3 });
  });

  it('never oversells: of many parallel holds on the last units, exactly the available quantity succeeds', async () => {
    const item = await officialItem(h, loc.id, 7);
    const attempts = 30;
    const results = await Promise.allSettled(Array.from({ length: attempts }, (_, i) => h.api.hold(`race-${i}-${newId()}`, [{ stockItemId: item.id, quantity: 1 }])));
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(ok).toHaveLength(7);
    expect(failed).toHaveLength(attempts - 7);
    for (const f of failed) expect(f.reason).toMatchObject({ code: 'INSUFFICIENT_STOCK' });
    expect(await quantities(h, item.id)).toMatchObject({ available: 0, reserved: 7 });
    // mixed sizes: 5 units, parallel holds of 2 → at most 2 succeed, 1 unit stays
    const five = await officialItem(h, loc.id, 5);
    const pairs = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => h.api.hold(`pair-${i}-${newId()}`, [{ stockItemId: five.id, quantity: 2 }])));
    expect(pairs.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    expect(await quantities(h, five.id)).toMatchObject({ available: 1, reserved: 4 });
    expect(await ledgerMismatches(h)).toEqual([]);
    expect(await reservedMismatches(h)).toEqual([]);
  });

  it('competes fairly with a seller lowering the quantity at the same time', async () => {
    const item = await sellerItem(h, sellerId, 6);
    const work = [
      ...Array.from({ length: 8 }, (_, i) => h.api.hold(`mix-${i}-${newId()}`, [{ stockItemId: item.id, quantity: 1 }]).then(() => 'held')),
      h.api.applyBulkQuantities(sellerId, [{ stockItemId: item.id, newAvailable: 2 }], newId(), { kind: 'seller', id: newId() }).then(() => 'bulk'),
    ];
    await Promise.allSettled(work);
    const q = await quantities(h, item.id);
    expect(q.available).toBeGreaterThanOrEqual(0);
    expect(q.available + q.reserved).toBeLessThanOrEqual(8);
    expect(await ledgerMismatches(h)).toEqual([]);
    expect(await reservedMismatches(h)).toEqual([]);
  });

  it('extends a hold while the payment is checked, capped by pendingPaymentHoldMinutes', async () => {
    const a = await officialItem(h, loc.id, 3);
    const r = await h.api.hold(`chk-${newId()}`, [{ stockItemId: a.id, quantity: 1 }], 5);
    const far = new Date(h.clock.now().getTime() + 5 * 3_600_000).toISOString();
    const extended = await h.api.extendHold(r.id, far);
    expect(new Date(extended.expiresAt!).getTime()).toBe(h.clock.now().getTime() + 60 * 60_000);
    await expect(h.api.extendHold(newId(), far)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('releases an abandoned hold (idempotent) and expires the ones past their time', async () => {
    const a = await officialItem(h, loc.id, 4);
    const abandoned = await h.api.hold(`chk-${newId()}`, [{ stockItemId: a.id, quantity: 2 }]);
    await h.api.releaseHold(abandoned.id, 'Payment failed');
    await h.api.releaseHold(abandoned.id, 'Payment failed');
    await h.app.kernel.events.drain();
    expect(eventsNamed(h, 'inventory.reservation.released')).toEqual([expect.objectContaining({ reservationId: abandoned.id, reason: 'abandoned', orderId: null })]);
    expect(await quantities(h, a.id)).toMatchObject({ available: 4, reserved: 0 });

    const key = `chk-${newId()}`;
    const expiring = await h.api.hold(key, [{ stockItemId: a.id, quantity: 3 }]);
    await h.app.kernel.jobs.runNow('inventory.expire-holds');
    expect(await quantities(h, a.id)).toMatchObject({ reserved: 3 }); // not due yet
    h.clock.advance(16 * 60_000);
    await expect(h.api.extendHold(expiring.id, new Date(h.clock.now().getTime() + 60_000).toISOString())).rejects.toMatchObject({ code: 'RESERVATION_EXPIRED' });
    await h.app.kernel.jobs.runNow('inventory.expire-holds');
    await h.app.kernel.events.drain();
    expect(await quantities(h, a.id)).toMatchObject({ available: 4, reserved: 0 });
    expect(eventsNamed(h, 'inventory.reservation.released').at(-1)).toMatchObject({ reservationId: expiring.id, reason: 'expired', lines: [expect.objectContaining({ state: 'expired', releasedQuantity: 3 })] });
    await expect(h.api.hold(key, [{ stockItemId: a.id, quantity: 3 }])).rejects.toMatchObject({ code: 'RESERVATION_EXPIRED' });
    await expect(h.api.attachOrder(expiring.id, newId(), [])).rejects.toMatchObject({ code: 'RESERVATION_EXPIRED' });
    const res = (await admin(h, 'GET', `/reservations?stockItemId=${a.id}&state=expired`)).json();
    expect(res.items.map((r: { id: string }) => r.id)).toEqual([expiring.id]);
  });
});

describe('orders: allocation, cancellation and dispatch', () => {
  it('allocates on acceptance, releases a partial cancel once, fulfils on dispatch', async () => {
    const a = await officialItem(h, loc.id, 10);
    const b = await officialItem(h, loc.id, 10);
    const r = await h.api.hold(`chk-${newId()}`, [{ stockItemId: a.id, quantity: 3 }, { stockItemId: b.id, quantity: 1 }]);
    const orderId = newId();
    const itemA = newId();
    const itemB = newId();
    const attached = await h.api.attachOrder(r.id, orderId, [{ stockItemId: a.id, orderItemId: itemA }, { stockItemId: b.id, orderItemId: itemB }]);
    expect(attached.orderId).toBe(orderId);
    await expect(h.api.attachOrder(r.id, newId(), [])).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(h.api.attachOrder(r.id, orderId, [{ stockItemId: newId(), orderItemId: newId() }])).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    accepted(orderId, 'MK-261009-00042', [itemA, itemB]);
    await h.app.kernel.events.drain();
    accepted(orderId, 'MK-261009-00042', [itemA, itemB]); // replay
    await h.app.kernel.events.drain();
    expect(eventsNamed(h, 'inventory.reservation.allocated')).toEqual([expect.objectContaining({ reservationId: r.id, orderId, lines: expect.arrayContaining([expect.objectContaining({ orderItemId: itemA, state: 'allocated' })]) })]);
    const listed = (await admin(h, 'GET', `/reservations?orderId=${orderId}`)).json().items[0];
    expect(listed).toMatchObject({ state: 'allocated', orderRef: 'MK-261009-00042', expiresAt: null });
    await expect(h.api.releaseHold(r.id, 'late')).rejects.toMatchObject({ code: 'ILLEGAL_TRANSITION' });

    // the job never expires an allocation
    h.clock.advance(60 * 60_000);
    await h.app.kernel.jobs.runNow('inventory.expire-holds');
    expect(await quantities(h, a.id)).toMatchObject({ available: 7, reserved: 3 });

    const cancellationId = newId();
    cancelled(orderId, itemA, a.id, 1, cancellationId);
    await h.app.kernel.events.drain();
    cancelled(orderId, itemA, a.id, 1, cancellationId); // the same event again
    await h.app.kernel.events.drain();
    expect(await quantities(h, a.id)).toMatchObject({ available: 8, reserved: 2 });
    expect(eventsNamed(h, 'inventory.reservation.released').filter((e) => e.orderId === orderId)).toEqual([expect.objectContaining({ reason: 'cancelled', orderId, lines: [expect.objectContaining({ orderItemId: itemA, releasedQuantity: 1, state: 'allocated' })] })]);

    const shipmentId = newId();
    dispatched(orderId, [{ orderItemId: itemA, quantity: 2 }, { orderItemId: itemB, quantity: 1 }], shipmentId);
    await h.app.kernel.events.drain();
    dispatched(orderId, [{ orderItemId: itemA, quantity: 2 }, { orderItemId: itemB, quantity: 1 }], shipmentId); // replay
    await h.app.kernel.events.drain();
    expect(await quantities(h, a.id)).toMatchObject({ available: 8, reserved: 0 });
    expect(await quantities(h, b.id)).toMatchObject({ available: 9, reserved: 0 });
    const done = (await admin(h, 'GET', `/reservations?orderId=${orderId}`)).json().items[0];
    expect(done.state).toBe('fulfilled');
    expect(done.lines.find((l: { orderItemId: string }) => l.orderItemId === itemA)).toMatchObject({ quantity: 3, fulfilledQuantity: 2, releasedQuantity: 1, state: 'fulfilled' });
    const moves = (await admin(h, 'GET', `/movements?stockItemId=${a.id}&reasonCode=dispatched`)).json().items;
    expect(moves).toEqual([expect.objectContaining({ fromGroup: 'reserved', toGroup: 'outside', quantity: 2, reference: { kind: 'order', id: orderId, label: 'Order MK-261009-00042' } })]);

    // a cancel after dispatch has nothing left to release
    cancelled(orderId, itemA, a.id, 2);
    await h.app.kernel.events.drain();
    expect(await quantities(h, a.id)).toMatchObject({ available: 8, reserved: 0 });
    expect(await ledgerMismatches(h)).toEqual([]);
    expect(await reservedMismatches(h)).toEqual([]);
  });

  it('allocates again when the hold expired before the payment was accepted, or raises it for review', async () => {
    const a = await officialItem(h, loc.id, 2);
    const r = await h.api.hold(`chk-${newId()}`, [{ stockItemId: a.id, quantity: 2 }], 1);
    const orderId = newId();
    const itemA = newId();
    await h.api.attachOrder(r.id, orderId, [{ stockItemId: a.id, orderItemId: itemA }]);
    h.clock.advance(2 * 60_000);
    await h.app.kernel.jobs.runNow('inventory.expire-holds');
    accepted(orderId, 'MK-261009-00077', [itemA]);
    await h.app.kernel.events.drain();
    expect(await quantities(h, a.id)).toMatchObject({ available: 0, reserved: 2 });
    expect(eventsNamed(h, 'inventory.reservation.allocated').at(-1)).toMatchObject({ orderId, lines: [expect.objectContaining({ orderItemId: itemA, quantity: 2, state: 'allocated' })] });

    // second order: the units are gone in the meantime
    const b = await officialItem(h, loc.id, 1);
    const r2 = await h.api.hold(`chk-${newId()}`, [{ stockItemId: b.id, quantity: 1 }], 1);
    const order2 = newId();
    await h.api.attachOrder(r2.id, order2, [{ stockItemId: b.id, orderItemId: newId() }]);
    h.clock.advance(2 * 60_000);
    await h.app.kernel.jobs.runNow('inventory.expire-holds');
    await h.api.hold(`chk-${newId()}`, [{ stockItemId: b.id, quantity: 1 }]);
    h.raised.length = 0;
    accepted(order2, 'MK-261009-00078', []);
    await h.app.kernel.events.drain();
    expect(h.raised).toEqual([expect.objectContaining({ subject: expect.objectContaining({ type: 'order', id: order2 }), dedupeKey: `inventory.allocation_failed:${order2}` })]);
  });

  it('lets staff release a stuck allocation, line by line, audited', async () => {
    const a = await officialItem(h, loc.id, 5);
    const r = await h.api.hold(`chk-${newId()}`, [{ stockItemId: a.id, quantity: 2 }]);
    const orderId = newId();
    await h.api.attachOrder(r.id, orderId, [{ stockItemId: a.id, orderItemId: newId() }]);
    accepted(orderId, 'MK-261009-00090', []);
    await h.app.kernel.events.drain();
    expect((await admin(h, 'POST', `/reservations/${r.id}/release`, { reason: '' })).statusCode).toBe(400);
    expect((await admin(h, 'POST', `/reservations/${r.id}/release`, { reason: 'Order closed', lineIds: [newId()] })).statusCode).toBe(400);
    const res = await admin(h, 'POST', `/reservations/${r.id}/release`, { reason: 'Order closed without a cancel event' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ state: 'released', releasedReason: 'Order closed without a cancel event' });
    expect(eventsNamed(h, 'inventory.reservation.released').at(-1)).toMatchObject({ reason: 'staff', orderId });
    expect(h.audits.at(-1)).toMatchObject({ action: 'inventory.reservation.release', category: 'orders', reason: 'Order closed without a cancel event' });
    expect((await admin(h, 'POST', `/reservations/${r.id}/release`, { reason: 'again' })).statusCode).toBe(409);
    expect((await admin(h, 'POST', `/reservations/${newId()}/release`, { reason: 'x' })).statusCode).toBe(404);
    expect((await admin(h, 'POST', `/reservations/${r.id}/release`, { reason: 'x' }, staffHeaders(['inventory.stock.view']))).statusCode).toBe(403);
    expect(await quantities(h, a.id)).toMatchObject({ available: 5, reserved: 0 });
  });

  it('raises long-open allocations for review without releasing them', async () => {
    const a = await officialItem(h, loc.id, 1);
    const r = await h.api.hold(`chk-${newId()}`, [{ stockItemId: a.id, quantity: 1 }]);
    const orderId = newId();
    await h.api.attachOrder(r.id, orderId, []);
    accepted(orderId, 'MK-261009-00099', []);
    await h.app.kernel.events.drain();
    h.raised.length = 0;
    h.clock.advance(15 * 86_400_000);
    await h.app.kernel.jobs.runNow('inventory.reconcile-reservations');
    expect(h.raised).toEqual(expect.arrayContaining([expect.objectContaining({ dedupeKey: `inventory.stale_allocation:${r.id}`, subject: expect.objectContaining({ type: 'order', id: orderId, ref: 'MK-261009-00099' }) })]));
    expect(await quantities(h, a.id)).toMatchObject({ reserved: 1 });
  });
});
