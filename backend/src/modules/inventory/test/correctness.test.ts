/**
 * Spec correctness pass: getStockItems (refs with main location) and allocating from the hold named on
 * orders.order.accepted (reservationId) when checkout has not attached the order yet.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
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

const accepted = async (orderId: string, ref: string, reservationId: string | null) => {
  h.app.kernel.events.publish('orders', 'orders.order.accepted', {
    orderId,
    ref,
    customerId: newId(),
    contactEmail: 'sam@example.com',
    total: { amount: 18900, currency: 'USD' },
    groups: [{ groupId: newId(), ownerType: 'official', sellerId: null, fulfilledBy: 'official_warehouse', dispatchBy: new Date().toISOString(), itemIds: [], total: { amount: 18900, currency: 'USD' } }],
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
    });
    // a seller's stock lives in the seller's virtual location
    expect(refs[1]).toMatchObject({ ownerType: 'seller', sellerId, offerId: own.offerId, locationCode: `SV-${sellerId}` });
    // company stock with no units falls back to the default company location
    expect(refs[2]).toMatchObject({ locationId: main.id, locationCode: 'DEF1' });
    expect(await h.api.getStockItems([])).toEqual([]);
  });
});

describe('allocating from the hold named on orders.order.accepted', () => {
  it('allocates before checkout attaches the order; attaching later maps the lines without allocating again', async () => {
    const a = await officialItem(h, main.id, 5);
    const r = await h.api.hold(`chk-${newId()}`, [{ stockItemId: a.id, quantity: 2 }]);
    const orderId = newId();
    await accepted(orderId, 'MK-261010-00001', r.id);
    expect(eventsNamed(h, 'inventory.reservation.allocated')).toEqual([expect.objectContaining({ reservationId: r.id, orderId })]);
    expect(await quantities(h, a.id)).toMatchObject({ available: 3, reserved: 2 });
    const allocated = (await h.api.extendHold(r.id, new Date(Date.now() + 3600_000).toISOString())) as { state: string; orderId?: string | null };
    expect(allocated).toMatchObject({ state: 'allocated', orderId });

    // replay of the event: nothing changes
    await accepted(orderId, 'MK-261010-00001', r.id);
    expect(eventsNamed(h, 'inventory.reservation.allocated')).toHaveLength(1);

    // checkout attaches the order afterwards
    const itemId = newId();
    const attached = await h.api.attachOrder(r.id, orderId, [{ stockItemId: a.id, orderItemId: itemId }]);
    expect(attached).toMatchObject({ state: 'allocated', orderId });
    expect(attached.lines.map((l) => l.orderItemId)).toEqual([itemId]);
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
