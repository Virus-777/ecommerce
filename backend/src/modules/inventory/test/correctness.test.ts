/**
 * Spec correctness pass: getStockItems (refs with main location) and allocating from the hold named on
 * orders.order.accepted (reservationId) when checkout has not attached the order yet.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { mapLinesToItems } from '../domain/rules.js';
import { eventsNamed, harness, ledgerMismatches, officialItem, quantities, reservedMismatches, sellerItem, warehouse, type Harness } from './helpers.js';

let h: Harness;
let main: { id: string; code: string };
let second: { id: string; code: string };

beforeAll(async () => {
  h = await harness();
  main = await warehouse(h, 'DEF1');
  second = await warehouse(h, 'SEC2');
});
afterAll(async () => {
  await h?.app.close();
});
beforeEach(async () => {
  await h.app.kernel.events.drain();
  h.events.length = 0;
});

type Item = { orderItemId: string; stockItemId: string; quantity: number };
const accepted = async (orderId: string, ref: string, reservationId: string | null, items: Item[] = []) => {
  h.app.kernel.events.publish('orders', 'orders.order.accepted', {
    orderId,
    ref,
    customerId: newId(),
    contactEmail: 'sam@example.com',
    total: { amount: 18900, currency: 'USD' },
    groups: [{ groupId: newId(), ownerType: 'official', sellerId: null, fulfilledBy: 'official_warehouse', dispatchBy: new Date().toISOString(), itemIds: items.map((i) => i.orderItemId), total: { amount: 18900, currency: 'USD' } }],
    items: items.map((i) => ({ ...i, offerId: newId() })),
    reservationId,
    acceptedAt: new Date().toISOString(),
  });
  await h.app.kernel.events.drain();
};

describe('getStockItems', () => {
  it('answers refs with owner and main location in the order asked, leaving unknown ids out', async () => {
    const sellerId = newId();
    const own = await sellerItem(h, sellerId, 4);
    const stocked = await officialItem(h, second.id, 6);
    const empty = await officialItem(h, second.id, 0);
    const refs = await h.api.getStockItems([stocked.id, newId(), own.id, 'nope', empty.id, stocked.id]);
    expect(refs.map((r) => r.id)).toEqual([stocked.id, own.id, empty.id]);
    expect(refs[0]).toEqual({
      id: stocked.id,
      sku: stocked.sku,
      label: stocked.label,
      ownerType: 'official',
      sellerId: null,
      offerId: stocked.offerId,
      productId: stocked.productId,
      variantId: stocked.variantId,
      condition: 'new',
      locationId: second.id,
      locationCode: 'SEC2',
      binCode: null,
      gtin: null, // catalog is off in these tests
    });
    // a seller's stock lives in the seller's virtual location
    expect(refs[1]).toMatchObject({ ownerType: 'seller', sellerId, offerId: own.offerId, locationCode: `SV-${sellerId}` });
    // company stock with no units falls back to the default company location
    expect(refs[2]).toMatchObject({ locationId: main.id, locationCode: 'DEF1' });
    expect(await h.api.getStockItems([])).toEqual([]);
  });
});

describe('allocating from the hold named on orders.order.accepted', () => {
  it('allocates before checkout attaches the order and maps the lines from the event; a late attachOrder changes nothing', async () => {
    const a = await officialItem(h, main.id, 5);
    const r = await h.api.hold(`chk-${newId()}`, [{ stockItemId: a.id, quantity: 2 }]);
    const orderId = newId();
    const itemId = newId();
    await accepted(orderId, 'MK-261010-00001', r.id, [{ orderItemId: itemId, stockItemId: a.id, quantity: 2 }]);
    expect(eventsNamed(h, 'inventory.reservation.allocated')).toEqual([expect.objectContaining({ reservationId: r.id, orderId, lines: [expect.objectContaining({ orderItemId: itemId, quantity: 2, state: 'allocated' })] })]);
    expect(await quantities(h, a.id)).toMatchObject({ available: 3, reserved: 2 });
    const allocated = (await h.api.extendHold(r.id, new Date(Date.now() + 3600_000).toISOString())) as { state: string; orderId?: string | null };
    expect(allocated).toMatchObject({ state: 'allocated', orderId });

    // replay of the event: nothing changes
    await accepted(orderId, 'MK-261010-00001', r.id);
    expect(eventsNamed(h, 'inventory.reservation.allocated')).toHaveLength(1);

    // checkout attaches the order afterwards: the lines keep their order item
    const attached = await h.api.attachOrder(r.id, orderId, [{ stockItemId: a.id, orderItemId: itemId }]);
    expect(attached).toMatchObject({ state: 'allocated', orderId });
    expect(attached.lines.map((l) => l.orderItemId)).toEqual([itemId]);
    const other = await h.api.attachOrder(r.id, orderId, [{ stockItemId: a.id, orderItemId: newId() }]);
    expect(other.lines.map((l) => l.orderItemId)).toEqual([itemId]);
    await h.app.kernel.events.drain();
    expect(eventsNamed(h, 'inventory.reservation.allocated')).toHaveLength(1);
    expect(await quantities(h, a.id)).toMatchObject({ available: 3, reserved: 2 });
    expect(await ledgerMismatches(h)).toEqual([]);
    expect(await reservedMismatches(h)).toEqual([]);
  });

  it('ignores an unknown hold and a hold that belongs to another order', async () => {
    await expect(accepted(newId(), 'MK-261010-00002', newId())).resolves.toBeUndefined();
    const a = await officialItem(h, main.id, 3);
    const r = await h.api.hold(`chk-${newId()}`, [{ stockItemId: a.id, quantity: 1 }]);
    const owner = newId();
    await h.api.attachOrder(r.id, owner, []);
    await accepted(newId(), 'MK-261010-00003', r.id);
    expect(eventsNamed(h, 'inventory.reservation.allocated')).toEqual([]);
    expect(await quantities(h, a.id)).toMatchObject({ available: 2, reserved: 1 });
    // its own order still allocates it
    await accepted(owner, 'MK-261010-00004', null);
    expect(eventsNamed(h, 'inventory.reservation.allocated')).toEqual([expect.objectContaining({ reservationId: r.id, orderId: owner })]);
  });
});

describe('mapping reservation lines to the accepted order items', () => {
  const cancelled = async (orderId: string, itemId: string, stockItemId: string, quantity: number) => {
    h.app.kernel.events.publish('orders', 'orders.item.cancelled', {
      orderId,
      ref: 'MK-261010-00010',
      groupId: newId(),
      ownerType: 'official',
      sellerId: null,
      itemId,
      offerId: newId(),
      stockItemId,
      quantity,
      cancellationId: newId(),
      initiatedBy: 'customer',
      notifyCustomer: true,
      reasonCode: 'changed_mind',
      beforeDispatch: true,
      countsAgainstSeller: false,
      refund: { itemAmount: { amount: 0, currency: 'USD' }, discountShare: { amount: 0, currency: 'USD' }, shippingRefund: { amount: 0, currency: 'USD' }, taxRefund: { amount: 0, currency: 'USD' }, total: { amount: 0, currency: 'USD' } },
      paymentIntentId: newId(),
    });
    await h.app.kernel.events.drain();
  };

  it('splits a hold line between two order items of the same stock item, so each item is cancelled on its own', async () => {
    const a = await officialItem(h, main.id, 5);
    const b = await officialItem(h, main.id, 5);
    const r = await h.api.hold(`chk-${newId()}`, [{ stockItemId: a.id, quantity: 1 }, { stockItemId: b.id, quantity: 1 }, { stockItemId: a.id, quantity: 2 }]);
    expect(r.lines.filter((l) => l.stockItemId === a.id)).toHaveLength(1); // one line per stock item and location
    const orderId = newId();
    const i1 = newId();
    const i2 = newId();
    const i3 = newId();
    await accepted(orderId, 'MK-261010-00010', r.id, [
      { orderItemId: i1, stockItemId: a.id, quantity: 1 },
      { orderItemId: i2, stockItemId: b.id, quantity: 1 },
      { orderItemId: i3, stockItemId: a.id, quantity: 2 },
    ]);
    const lines = eventsNamed(h, 'inventory.reservation.allocated')[0].lines as { orderItemId: string; stockItemId: string; quantity: number; state: string }[];
    const key = (x: unknown[]) => x.join('|');
    expect(lines.map((l) => key([l.orderItemId, l.stockItemId, l.quantity, l.state])).sort()).toEqual([key([i1, a.id, 1, 'allocated']), key([i2, b.id, 1, 'allocated']), key([i3, a.id, 2, 'allocated'])].sort());
    expect(await quantities(h, a.id)).toMatchObject({ available: 2, reserved: 3 });

    // a late attachOrder (checkout) leaves the mapping alone
    await h.api.attachOrder(r.id, orderId, [{ stockItemId: a.id, orderItemId: i1 }, { stockItemId: b.id, orderItemId: i2 }, { stockItemId: a.id, orderItemId: i3 }]);
    await cancelled(orderId, i3, a.id, 2);
    expect(await quantities(h, a.id)).toMatchObject({ available: 4, reserved: 1 });
    const listed = (await h.api.attachOrder(r.id, orderId, [])).lines;
    expect(listed.find((l) => l.orderItemId === i1)).toMatchObject({ releasedQuantity: 0, state: 'allocated' });
    expect(listed.find((l) => l.orderItemId === i3)).toMatchObject({ releasedQuantity: 2, state: 'released' });
    expect(await ledgerMismatches(h)).toEqual([]);
    expect(await reservedMismatches(h)).toEqual([]);
  });

  it('maps the lines of a hold reserved again after it expired', async () => {
    const a = await officialItem(h, main.id, 3);
    const r = await h.api.hold(`chk-${newId()}`, [{ stockItemId: a.id, quantity: 3 }], 1);
    h.clock.advance(2 * 60_000);
    await h.app.kernel.jobs.runNow('inventory.expire-holds');
    await h.app.kernel.events.drain();
    const orderId = newId();
    const i1 = newId();
    const i2 = newId();
    await accepted(orderId, 'MK-261010-00011', r.id, [
      { orderItemId: i1, stockItemId: a.id, quantity: 2 },
      { orderItemId: i2, stockItemId: a.id, quantity: 1 },
    ]);
    const allocated = eventsNamed(h, 'inventory.reservation.allocated').at(-1);
    expect(allocated.reservationId).not.toBe(r.id);
    expect(allocated.lines.map((l: { orderItemId: string; quantity: number }) => `${l.orderItemId}:${l.quantity}`).sort()).toEqual([`${i1}:2`, `${i2}:1`].sort());
    expect(await quantities(h, a.id)).toMatchObject({ available: 0, reserved: 3 });
    expect(await ledgerMismatches(h)).toEqual([]);
    expect(await reservedMismatches(h)).toEqual([]);
  });
});

describe('mapLinesToItems', () => {
  const line = (id: string, stockItemId: string, quantity: number, orderItemId: string | null = null, splittable = true) => ({ id, stockItemId, quantity, orderItemId, splittable });

  it('matches exact quantities first, then fills in item order, splitting lines and leaving extra units unmapped', () => {
    const plan = mapLinesToItems([line('L1', 'S', 3), line('L2', 'S', 1)], [
      { orderItemId: 'A', stockItemId: 'S', quantity: 2 },
      { orderItemId: 'B', stockItemId: 'S', quantity: 1 },
    ]);
    expect(plan).toEqual([
      { lineId: 'L2', orderItemId: 'B', quantity: 1, extra: [] },
      { lineId: 'L1', orderItemId: 'A', quantity: 2, extra: [{ orderItemId: null, quantity: 1 }] },
    ]);
  });

  it('keeps lines checkout already mapped and counts them against their item', () => {
    const plan = mapLinesToItems([line('L1', 'S', 2, 'A'), line('L2', 'S', 2), line('L3', 'T', 1)], [
      { orderItemId: 'A', stockItemId: 'S', quantity: 3 },
      { orderItemId: 'C', stockItemId: 'T', quantity: 1 },
    ]);
    expect(plan).toEqual([
      { lineId: 'L2', orderItemId: 'A', quantity: 1, extra: [{ orderItemId: null, quantity: 1 }] },
      { lineId: 'L3', orderItemId: 'C', quantity: 1, extra: [] },
    ]);
    expect(mapLinesToItems([line('L1', 'S', 2, 'A')], [{ orderItemId: 'A', stockItemId: 'S', quantity: 2 }])).toEqual([]);
  });

  it('assigns a line with released or fulfilled units whole', () => {
    expect(mapLinesToItems([line('L1', 'S', 3, null, false)], [{ orderItemId: 'A', stockItemId: 'S', quantity: 1 }, { orderItemId: 'B', stockItemId: 'S', quantity: 2 }])).toEqual([
      { lineId: 'L1', orderItemId: 'B', quantity: 3, extra: [] },
    ]);
  });
});
