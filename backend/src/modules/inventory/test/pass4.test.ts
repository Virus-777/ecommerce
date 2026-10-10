/**
 * Gap pass 4: reservations.source (instead of the order-allocation key prefix), transfers.note, StockItem.image from
 * catalog, cancellation and dispatch dedupe through the kernel inbox (not movement notes), valuation_snapshots, and
 * migration 0002 backfilling the source, the inbox keys and the new columns on an existing install.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { m0002Pass4Columns } from '../infra/postgres/migrations/0002_pass4_columns.js';
import { admin, harness, ledgerMismatches, officialItem, quantities, reservedMismatches, warehouse, type Harness } from './helpers.js';

let h: Harness;
let main: { id: string; code: string };

beforeAll(async () => {
  h = await harness({ withCatalog: true });
  main = await warehouse(h, 'P4W1');
});
afterAll(async () => {
  await h?.app.close();
});
beforeEach(async () => {
  await h.app.kernel.events.drain();
  h.events.length = 0;
});

const db = () => h.app.kernel.database.kysely.withSchema('inventory') as any;
const consistent = async () => {
  expect(await ledgerMismatches(h)).toEqual([]);
  expect(await reservedMismatches(h)).toEqual([]);
};
const usd = (amount: number) => ({ amount, currency: 'USD' });

async function acceptedOrder(stockItemId: string, quantity: number) {
  const r = await h.api.hold(`chk-${newId()}`, [{ stockItemId, quantity }]);
  const orderId = newId();
  const orderItemId = newId();
  h.app.kernel.events.publish('orders', 'orders.order.accepted', {
    orderId,
    ref: 'MK-261010-00400',
    customerId: newId(),
    contactEmail: 'sam@example.com',
    total: usd(18900),
    groups: [{ groupId: newId(), ownerType: 'official', sellerId: null, fulfilledBy: 'official_warehouse', dispatchBy: new Date().toISOString(), itemIds: [orderItemId], total: usd(18900) }],
    items: [{ orderItemId, stockItemId, quantity, offerId: newId() }],
    reservationId: r.id,
    acceptedAt: new Date().toISOString(),
  });
  await h.app.kernel.events.drain();
  return { orderId, orderItemId, reservationId: r.id };
}

const cancelledEvent = (orderId: string, itemId: string, stockItemId: string, quantity: number, cancellationId: string) => ({
  orderId,
  ref: 'MK-261010-00400',
  groupId: newId(),
  ownerType: 'official' as const,
  sellerId: null,
  itemId,
  offerId: newId(),
  stockItemId,
  quantity,
  cancellationId,
  initiatedBy: 'customer' as const,
  notifyCustomer: true,
  reasonCode: 'changed_mind',
  beforeDispatch: true,
  countsAgainstSeller: false,
  fulfilledBy: 'official_warehouse' as const,
  refund: { itemAmount: usd(0), discountShare: usd(0), shippingRefund: usd(0), taxRefund: usd(0), total: usd(0) },
  paymentIntentId: newId(),
});

const dispatchedEvent = (shipmentId: string, orderId: string, orderItemId: string, quantity: number) => ({
  shipmentId,
  kind: 'outbound' as const,
  orderId,
  groupId: newId(),
  ownerType: 'official' as const,
  sellerId: null,
  lines: [{ orderItemId, quantity, title: 'Aurora', variantLabel: 'Black' }],
  shippedAt: new Date().toISOString(),
  trackingValid: true,
  fulfilledBy: 'official_warehouse' as const,
});

describe('reservations.source', () => {
  it('checkout holds and allocateForOrder allocations carry their source; keys are unique per source', async () => {
    const a = await officialItem(h, main.id, 5);
    const key = `same-${newId()}`;
    const hold = await h.api.hold(key, [{ stockItemId: a.id, quantity: 1 }]);
    expect(hold).toMatchObject({ key, source: 'checkout' });
    const rep = await h.api.allocateForOrder({ key, orderId: newId(), source: { kind: 'replacement', id: newId() }, lines: [{ stockItemId: a.id, quantity: 1 }], actor: { kind: 'system' } });
    expect(rep).toMatchObject({ key, source: 'replacement', state: 'allocated' });
    expect(rep.id).not.toBe(hold.id);
    const ex = await h.api.allocateForOrder({ key, orderId: newId(), source: { kind: 'exchange', id: newId() }, lines: [{ stockItemId: a.id, quantity: 1 }], actor: { kind: 'system' } });
    expect(ex).toMatchObject({ key, source: 'exchange' });
    // the same source and key is the same reservation
    expect((await h.api.allocateForOrder({ key, orderId: newId(), source: { kind: 'exchange', id: newId() }, lines: [{ stockItemId: a.id, quantity: 1 }], actor: { kind: 'system' } })).id).toBe(ex.id);
    const rows = await db().selectFrom('reservations').select(['id', 'source', 'key']).where('key', '=', key).execute();
    expect(rows.map((r: { source: string }) => r.source).sort()).toEqual(['checkout', 'exchange', 'replacement']);
    // releaseHold releases an allocation by its source
    await h.api.releaseHold(rep.id, 'Replacement cancelled');
    expect(await quantities(h, a.id)).toMatchObject({ available: 3, reserved: 2 });
    await consistent();
  });
});

describe('consumers dedupe through the inbox', () => {
  it('a redelivered cancellation or dispatch changes nothing; the claim keys are in the inbox', async () => {
    const a = await officialItem(h, main.id, 6);
    const o = await acceptedOrder(a.id, 3);
    const cancellationId = newId();
    const event = cancelledEvent(o.orderId, o.orderItemId, a.id, 1, cancellationId);
    h.app.kernel.events.publish('orders', 'orders.item.cancelled', event);
    await h.app.kernel.events.drain();
    h.app.kernel.events.publish('orders', 'orders.item.cancelled', event);
    await h.app.kernel.events.drain();
    expect(await quantities(h, a.id)).toMatchObject({ available: 4, reserved: 2 });

    const shipmentId = newId();
    h.app.kernel.events.publish('shipping', 'shipping.shipment.dispatched', dispatchedEvent(shipmentId, o.orderId, o.orderItemId, 1));
    await h.app.kernel.events.drain();
    h.app.kernel.events.publish('shipping', 'shipping.shipment.dispatched', dispatchedEvent(shipmentId, o.orderId, o.orderItemId, 1));
    await h.app.kernel.events.drain();
    expect(await quantities(h, a.id)).toMatchObject({ available: 4, reserved: 1 });

    const keys = (await h.app.kernel.database.kysely.selectFrom('kernel.processed_events' as never).select('key' as never).where('module' as never, '=', 'inventory' as never).execute()).map((r: any) => r.key);
    expect(keys).toEqual(expect.arrayContaining([`item-cancelled:${cancellationId}:${o.orderItemId}:${o.reservationId}`, `shipment-dispatched:${shipmentId}`]));
    await consistent();
  });
});

describe('transfers.note', () => {
  it('keeps the planner note on the transfer', async () => {
    const other = await warehouse(h, 'P4W2');
    const a = await officialItem(h, main.id, 4);
    const created = await admin(h, 'POST', '/transfers', { fromLocationId: main.id, toLocationId: other.id, lines: [{ stockItemId: a.id, sku: a.sku, quantity: 2 }], note: 'Rebalance before the holiday peak' });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json()).toMatchObject({ note: 'Rebalance before the holiday peak', ref: expect.stringMatching(/^TRF-\d{6}-\d{4}$/) });
    expect((await admin(h, 'GET', '/transfers?limit=50')).json().items.find((t: { id: string }) => t.id === created.json().id)).toMatchObject({ note: 'Rebalance before the holiday peak' });
  });
});

describe('StockItem.image', () => {
  it('is the variant image from catalog, else the product image', async () => {
    const productId = newId();
    const [v1, v2] = [newId(), newId()];
    h.products.set(productId, {
      id: productId,
      title: 'Halden Aurora',
      images: [{ id: newId(), url: 'https://cdn.example/aurora.jpg' }],
      variants: [
        { id: v1, options: { Color: 'Black' }, images: [{ id: newId(), url: 'https://cdn.example/aurora-black.jpg' }] },
        { id: v2, options: { Color: 'Silver' }, images: [] },
      ],
    });
    const black = await officialItem(h, main.id, 1, { productId, variantId: v1 });
    const silver = await officialItem(h, main.id, 1, { productId, variantId: v2 });
    const get = async (id: string) => (await admin(h, 'GET', `/stock-items/${id}`)).json().item;
    expect((await get(black.id)).image).toMatchObject({ url: 'https://cdn.example/aurora-black.jpg' });
    expect((await get(silver.id)).image).toMatchObject({ url: 'https://cdn.example/aurora.jpg' });
    expect((await officialItem(h, main.id, 1)).image).toBeNull();
  });
});

describe('valuation snapshots', () => {
  it('the daily job writes one row per group for the market day; a second run replaces it', async () => {
    await officialItem(h, main.id, 3, { unitCost: usd(2500) } as never);
    await h.app.kernel.jobs.runNow('inventory.valuation-snapshot');
    const first = await db().selectFrom('valuation_snapshots').selectAll().execute();
    expect(first.map((r: { stock_group: string }) => r.stock_group).sort()).toEqual(['available', 'damaged_held', 'incoming', 'reserved', 'returned']);
    const available = first.find((r: { stock_group: string }) => r.stock_group === 'available');
    expect(available).toMatchObject({ currency: 'USD', units: expect.any(Number), sku_count: expect.any(Number) });
    await officialItem(h, main.id, 2);
    await h.app.kernel.jobs.runNow('inventory.valuation-snapshot');
    const second = await db().selectFrom('valuation_snapshots').selectAll().execute();
    expect(second).toHaveLength(5);
    expect(second.find((r: { stock_group: string }) => r.stock_group === 'available').units).toBe(available.units + 2);
  });
});

describe('migration 0002', () => {
  it('backfills source from the key prefix and claims the cancellations and shipments already applied', async () => {
    const a = await officialItem(h, main.id, 4);
    const o = await acceptedOrder(a.id, 2);
    const k = h.app.kernel.database;
    // back to the schema before 0002
    // (keys of other sources made unique again first: one key per source is what 0002 allows)
    await k.exec(`update inventory.reservations set key = key || ':' || source where source <> 'checkout';
drop index inventory.reservations_source_key_idx;
alter table inventory.reservations drop column source;
alter table inventory.reservations add constraint reservations_key_key unique (key);
alter table inventory.transfers drop column note;
drop table inventory.valuation_snapshots;`);
    const legacyId = newId();
    const now = new Date();
    await db().insertInto('reservations').values({ id: legacyId, key: 'order-allocation:exchange:EX-1', order_id: o.orderId, order_ref: 'MK-261010-00400', state: 'allocated', expires_at: null, released_reason: null, created_at: now, updated_at: now }).execute();
    await db().insertInto('reservations').values({ id: newId(), key: 'order-allocation:replacement:RP-1', order_id: o.orderId, order_ref: null, state: 'released', expires_at: null, released_reason: 'x', created_at: now, updated_at: now }).execute();
    // what the old consumers left: released units with the cancellation in the note, a dispatch with the shipment
    const cancellationId = newId();
    const shipmentId = newId();
    await db().updateTable('reservation_lines').set({ released_qty: 1 }).where('reservation_id', '=', o.reservationId).execute();
    const movement = (reason: string, note: string) => ({ id: newId(), stock_item_id: a.id, location_id: main.id, from_group: 'reserved', to_group: reason === 'dispatched' ? 'outside' : 'available', quantity: 1, reason_code: reason, note, ref_kind: 'order', ref_id: o.orderId, ref_label: 'Order MK-261010-00400', actor_kind: 'system', actor_id: null, actor_name: null, approved_by: null, after: JSON.stringify({}), at: now });
    await db().insertInto('stock_movements').values([movement('order_cancelled', `Cancellation ${cancellationId}`), movement('dispatched', `Shipment ${shipmentId}`)]).execute();

    await k.exec(`begin;\n${m0002Pass4Columns.sql}\ncommit;`);

    const rows = await db().selectFrom('reservations').select(['id', 'source', 'key']).where('order_id', '=', o.orderId).execute();
    expect(rows).toEqual(
      expect.arrayContaining([
        { id: legacyId, source: 'exchange', key: 'EX-1' },
        expect.objectContaining({ source: 'replacement', key: 'RP-1' }),
        { id: o.reservationId, source: 'checkout', key: expect.not.stringMatching(/^order-allocation:/) },
      ]),
    );
    const keys = (await k.kysely.selectFrom('kernel.processed_events' as never).select('key' as never).where('module' as never, '=', 'inventory' as never).execute()).map((r: any) => r.key);
    expect(keys).toEqual(expect.arrayContaining([`shipment-dispatched:${shipmentId}`, `item-cancelled:${cancellationId}:${o.orderItemId}:${o.reservationId}`]));
    expect(await db().selectFrom('valuation_snapshots').selectAll().execute()).toEqual([]);
    // the same key now lives once per source
    const dup = await db().insertInto('reservations').values({ id: newId(), source: 'exchange', key: 'EX-1', order_id: null, order_ref: null, state: 'held', expires_at: null, released_reason: null, created_at: now, updated_at: now }).execute().catch((e: unknown) => e);
    expect((dup as { code?: string }).code).toBe('23505');
  });
});
