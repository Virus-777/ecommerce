/**
 * Fulfilled by Marketly (batch B): seller stock held and sold from a Marketly warehouse.
 * The sellable rule (a service item sells only at its service location; own-location units kept but not on sale),
 * setServiceLocation, moveServiceStock, service inbound Incoming and receipts confirmed in the same queue,
 * getLevels, SERVICE_MANAGED on seller edits, adjustment.recorded/stock.low/receipt.confirmed fields, the seller
 * views, and migration 0003 on an existing install.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { m0003FulfilledByMarketly } from '../infra/postgres/migrations/0003_fulfilled_by_marketly.js';
import { admin, eventsNamed, harness, ledgerMismatches, officialItem, quantities, reservedMismatches, seller, sellerItem, warehouse, type Harness } from './helpers.js';

let h: Harness;
let dock: { id: string; code: string };

beforeAll(async () => {
  h = await harness();
  dock = await warehouse(h, 'FBM1');
});
afterAll(async () => {
  await h?.app.close();
});
beforeEach(async () => {
  await h.app.kernel.events.drain();
  h.events.length = 0;
});

const db = () => h.app.kernel.database.kysely.withSchema('inventory') as any;
const staff = { kind: 'staff' as const, id: newId(), name: 'Rina Okafor' };
const consistent = async () => {
  expect(await ledgerMismatches(h)).toEqual([]);
  expect(await reservedMismatches(h)).toEqual([]);
};
const drain = () => h.app.kernel.events.drain();
const available = async (id: string) => (await h.api.getAvailability([id]))[id]!.available;
const levelAt = async (id: string, locationId: string) => (await h.api.getLevels([id], locationId))[id]!;

/** A seller item with own-location units and `units` confirmed and sellable at the dock */
async function serviceItem(own: number, units: number, opts: { sellerId?: string; activate?: boolean } = {}) {
  const sellerId = opts.sellerId ?? newId();
  const item = await sellerItem(h, sellerId, own);
  const inboundId = newId();
  await h.api.expectServiceInbound({ inboundId, ref: 'IB-261011-0001', locationId: dock.id, lines: [{ stockItemId: item.id, quantity: units }] });
  const receipt = await h.api.submitServiceReceipt({
    receiptId: newId(),
    receiptRef: 'FR-261011-01',
    inboundId,
    inboundRef: 'IB-261011-0001',
    sellerId,
    sellerName: 'Avery Audio',
    locationId: dock.id,
    receivedBy: staff,
    receivedAt: new Date().toISOString(),
    lines: [{ stockItemId: item.id, expected: units, received: units, damaged: 0 }],
  });
  expect((await admin(h, 'POST', `/inbound/${receipt.id}/confirm`, { lines: [], checked: true })).statusCode).toBe(200);
  if (opts.activate !== false) await h.api.setServiceLocation(item.id, dock.id, staff);
  await drain();
  return { item, sellerId, inboundId };
}

describe('service inbound and receipts (decision D3)', () => {
  it('Incoming at the dock, a receipt waiting in the same queue, confirmed without cost: extras added, damaged held', async () => {
    const sellerId = newId();
    const item = await sellerItem(h, sellerId, 5);
    const inboundId = newId();
    await h.api.expectServiceInbound({ inboundId, ref: 'IB-261011-0002', locationId: dock.id, lines: [{ stockItemId: item.id, quantity: 10, expectedDate: '2026-10-20' }] });
    expect(await levelAt(item.id, dock.id)).toMatchObject({ incoming: 10, available: 0 });
    // repeated calls replace the open quantity
    await h.api.expectServiceInbound({ inboundId, ref: 'IB-261011-0002', locationId: dock.id, lines: [{ stockItemId: item.id, quantity: 8 }] });
    expect(await levelAt(item.id, dock.id)).toMatchObject({ incoming: 8 });
    expect(await available(item.id)).toBe(5); // incoming never sells

    const receiptId = newId();
    const input = {
      receiptId,
      receiptRef: 'FR-261011-02',
      inboundId,
      inboundRef: 'IB-261011-0002',
      sellerId,
      sellerName: 'Avery Audio',
      locationId: dock.id,
      receivedBy: staff,
      receivedAt: new Date().toISOString(),
      lines: [{ stockItemId: item.id, expected: 8, received: 10, damaged: 1, binCode: 'A-01-1' }],
    };
    const receipt = await h.api.submitServiceReceipt(input);
    expect(receipt).toMatchObject({
      source: { kind: 'service_inbound', id: inboundId, ref: 'IB-261011-0002' },
      ownerType: 'seller',
      sellerId,
      purchaseOrderId: null,
      supplierName: 'Avery Audio',
      state: 'awaiting_confirmation',
      lines: [{ stockItemId: item.id, received: 10, damaged: 1, unitCost: null, sellable: 9 }],
    });
    expect((await h.api.submitServiceReceipt(input)).id).toBe(receipt.id); // same receiptId: the first receipt
    expect(await levelAt(item.id, dock.id)).toMatchObject({ incoming: 8 }); // extras are added at confirmation

    const listed = (await admin(h, 'GET', '/inbound?source=service_inbound&limit=100')).json().items.map((r: { id: string }) => r.id);
    expect(listed).toContain(receipt.id);
    expect((await admin(h, 'GET', '/inbound?source=purchase_order&limit=100')).json().items.map((r: { id: string }) => r.id)).not.toContain(receipt.id);

    const res = await admin(h, 'POST', `/inbound/${receipt.id}/confirm`, { lines: [], checked: true });
    expect(res.statusCode, res.body).toBe(200);
    expect(await levelAt(item.id, dock.id)).toEqual({ available: 9, reserved: 0, incoming: 0, damagedHeld: 1, returned: 0 });
    const row = await db().selectFrom('stock_items').select(['unit_cost_amount', 'primary_bin_code']).where('id', '=', item.id).executeTakeFirst();
    expect(row).toEqual({ unit_cost_amount: null, primary_bin_code: 'A-01-1' }); // no valuation for seller stock
    const [confirmed] = eventsNamed(h, 'inventory.receipt.confirmed');
    expect(confirmed).toMatchObject({
      inboundId: receipt.id,
      receiptId,
      source: { kind: 'service_inbound', id: inboundId, ref: 'IB-261011-0002' },
      ownerType: 'seller',
      sellerId,
      purchaseOrderId: null,
      locationId: dock.id,
      lines: [{ stockItemId: item.id, sellable: 9, damaged: 1, unitCost: null }],
    });
    // not yet designated: the dock units are not on sale, the seller's own are
    expect(await available(item.id)).toBe(5);
    await consistent();
  });

  it('cancelServiceInbound removes the open Incoming but keeps units counted on a receipt waiting for confirmation', async () => {
    const sellerId = newId();
    const item = await sellerItem(h, sellerId, 0);
    const other = await sellerItem(h, sellerId, 0);
    const inboundId = newId();
    await h.api.expectServiceInbound({ inboundId, ref: 'IB-261011-0003', locationId: dock.id, lines: [{ stockItemId: item.id, quantity: 10 }, { stockItemId: other.id, quantity: 3 }] });
    const receipt = await h.api.submitServiceReceipt({ receiptId: newId(), receiptRef: 'FR-261011-03', inboundId, inboundRef: 'IB-261011-0003', sellerId, sellerName: 'Avery Audio', locationId: dock.id, receivedBy: staff, receivedAt: new Date().toISOString(), lines: [{ stockItemId: item.id, expected: 10, received: 4, damaged: 0 }] });
    await h.api.cancelServiceInbound(inboundId);
    expect(await levelAt(item.id, dock.id)).toMatchObject({ incoming: 4 });
    expect(await levelAt(other.id, dock.id)).toMatchObject({ incoming: 0 });
    await h.api.cancelServiceInbound(inboundId); // no-op
    expect(await levelAt(item.id, dock.id)).toMatchObject({ incoming: 4 });
    await admin(h, 'POST', `/inbound/${receipt.id}/confirm`, { lines: [{ stockItemId: item.id, sellable: 3, damaged: 0, reason: 'One unit kept for QA' }], checked: true });
    expect(await levelAt(item.id, dock.id)).toMatchObject({ incoming: 0, available: 3 }); // the unit not accepted left Incoming
    await consistent();
  });

  it('refuses company stock and unknown locations', async () => {
    const company = await officialItem(h, dock.id, 1);
    await expect(h.api.expectServiceInbound({ inboundId: newId(), ref: 'IB-1', locationId: dock.id, lines: [{ stockItemId: company.id, quantity: 1 }] })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const s = await sellerItem(h, newId(), 0);
    await expect(h.api.expectServiceInbound({ inboundId: newId(), ref: 'IB-1', locationId: newId(), lines: [{ stockItemId: s.id, quantity: 1 }] })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      h.api.submitServiceReceipt({ receiptId: newId(), receiptRef: 'FR-1', inboundId: newId(), inboundRef: 'IB-1', sellerId: newId(), sellerName: 'Other', locationId: dock.id, receivedBy: staff, receivedAt: new Date().toISOString(), lines: [{ stockItemId: s.id, expected: 1, received: 1, damaged: 0 }] }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' }); // another seller's item
  });

  it('purchase receipts are unaffected: they carry source purchase_order and ownerType official', async () => {
    const a = await officialItem(h, dock.id, 0);
    const po = newId();
    await h.api.expectIncoming(po, 'PUR-2610-0099', dock.id, [{ stockItemId: a.id, quantity: 4, expectedDate: '2026-10-20' }]);
    const r = await h.api.submitInbound({ receiptId: newId(), receiptRef: 'REC-1', purchaseOrderId: po, purchaseOrderRef: 'PUR-2610-0099', supplierName: 'Halden', locationId: dock.id, receivedBy: staff, receivedAt: new Date().toISOString(), lines: [{ stockItemId: a.id, expected: 4, received: 4, damaged: 0, unitCost: { amount: 1000, currency: 'USD' } }] });
    expect(r).toMatchObject({ source: { kind: 'purchase_order', id: po, ref: 'PUR-2610-0099' }, ownerType: 'official', sellerId: null, purchaseOrderId: po, lines: [{ unitCost: { amount: 1000, currency: 'USD' } }] });
    await admin(h, 'POST', `/inbound/${r.id}/confirm`, { lines: [], checked: true });
    expect(eventsNamed(h, 'inventory.receipt.confirmed')).toEqual([expect.objectContaining({ source: { kind: 'purchase_order', id: po, ref: 'PUR-2610-0099' }, ownerType: 'official', purchaseOrderId: po, locationId: dock.id })]);
    expect(await quantities(h, a.id)).toMatchObject({ available: 4 });
  });
});

describe('the sellable rule and setServiceLocation (decision D4)', () => {
  it('a service item sells only at its service location; own units are kept but not on sale; clearing it restores them', async () => {
    const sellerId = newId();
    const lone = await sellerItem(h, sellerId, 5);
    // not designated: no service stock movements
    await expect(
      h.api.moveServiceStock({ key: `fs:found:${lone.id}`, stockItemId: lone.id, locationId: dock.id, from: null, to: 'available', quantity: 1, reasonCode: 'service_found', ref: { kind: 'service_reconcile', id: newId(), label: 'Found' }, actor: staff }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(await levelAt(lone.id, dock.id)).toMatchObject({ available: 0 });

    const prep = await serviceItem(0, 7, { sellerId, activate: false });
    expect(await available(prep.item.id)).toBe(0); // dock units of an undesignated item never sell
    h.events.length = 0;
    const set = await h.api.setServiceLocation(prep.item.id, dock.id, staff);
    await drain();
    expect(set).toMatchObject({ serviceLocationId: dock.id, quantities: { available: 7 }, ownLocationQuantities: { available: 0 } });
    expect(eventsNamed(h, 'inventory.stock.changed')).toEqual([expect.objectContaining({ stockItemId: prep.item.id, available: 7, previousAvailable: 0, cause: 'service_location' })]);
    // the same value again is a no-op
    h.events.length = 0;
    await h.api.setServiceLocation(prep.item.id, dock.id, staff);
    await drain();
    expect(eventsNamed(h, 'inventory.stock.changed')).toEqual([]);

    // an item with own units and units at the dock
    const both = await serviceItem(5, 4, { sellerId });
    expect(await available(both.item.id)).toBe(4);
    expect((await h.api.getOfferAvailability([{ offerId: both.item.offerId!, stockItemId: both.item.id }]))[both.item.offerId!]).toMatchObject({ maxPerOrder: 4 });
    // holds take only service-location units
    await expect(h.api.hold(`chk-${newId()}`, [{ stockItemId: both.item.id, quantity: 5 }])).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK', details: { lines: [{ stockItemId: both.item.id, requested: 5, available: 4 }] } });
    const hold = await h.api.hold(`chk-${newId()}`, [{ stockItemId: both.item.id, quantity: 3 }]);
    expect(hold.lines).toEqual([expect.objectContaining({ locationId: dock.id, quantity: 3 })]);
    expect(await levelAt(both.item.id, dock.id)).toMatchObject({ available: 1, reserved: 3 });
    await h.api.releaseHold(hold.id, 'abandoned');

    // seller lists: 'At Marketly' and 'At your location (not on sale)'
    const rows = (await seller(h, sellerId, 'GET', '/stock-items?limit=100')).json().items;
    expect(rows.find((r: { stockItemId: string }) => r.stockItemId === both.item.id)).toMatchObject({ available: 4, fulfilledByMarketly: true, ownLocationAvailable: 5 });
    const plain = await sellerItem(h, sellerId, 2);
    expect((await seller(h, sellerId, 'GET', '/stock-items?limit=100')).json().items.find((r: { stockItemId: string }) => r.stockItemId === plain.id)).toMatchObject({ fulfilledByMarketly: false, ownLocationAvailable: null });
    const detail = (await seller(h, sellerId, 'GET', `/stock-items/${both.item.id}`)).json();
    expect(detail.item).toMatchObject({ serviceLocationId: dock.id, quantities: { available: 4 }, ownLocationQuantities: { available: 5 } });
    expect((await h.api.getStockItems([both.item.id]))[0]).toMatchObject({ locationId: dock.id, locationCode: 'FBM1' });

    // clearing it makes the own-location units sellable again
    h.events.length = 0;
    const cleared = await h.api.setServiceLocation(both.item.id, null, staff);
    await drain();
    expect(cleared).toMatchObject({ serviceLocationId: null, ownLocationQuantities: null });
    expect(await available(both.item.id)).toBe(5);
    expect(eventsNamed(h, 'inventory.stock.changed')).toEqual([expect.objectContaining({ stockItemId: both.item.id, available: 5, previousAvailable: 4, cause: 'service_location' })]);
    await consistent();
  });

  it('is refused for company stock, non-warehouse or inactive locations, and without an actor', async () => {
    const company = await officialItem(h, dock.id, 1);
    await expect(h.api.setServiceLocation(company.id, dock.id, staff)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const s = await sellerItem(h, newId(), 1);
    await expect(h.api.setServiceLocation(s.id, newId(), staff)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const own = (await db().selectFrom('locations').select('id').where('seller_id', '=', s.sellerId).executeTakeFirst()).id;
    await expect(h.api.setServiceLocation(s.id, own, staff)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const closed = await warehouse(h, 'FBM-OFF', { sellable: false, active: false });
    await expect(h.api.setServiceLocation(s.id, closed.id, staff)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(h.api.setServiceLocation(s.id, dock.id, undefined as never)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(h.api.setServiceLocation(newId(), dock.id, staff)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('lists and low stock follow the rule: state and the low-stock filter use the service-location units', async () => {
    const sellerId = newId();
    const { item } = await serviceItem(20, 2, { sellerId });
    const row = (await seller(h, sellerId, 'GET', '/stock-items?state=low_stock&limit=100')).json().items.find((r: { stockItemId: string }) => r.stockItemId === item.id);
    expect(row).toMatchObject({ state: 'low_stock', available: 2 });
  });
});

describe('moveServiceStock', () => {
  it('moves atomically, is idempotent per key, refuses negative groups and never publishes adjustment.recorded', async () => {
    const { item } = await serviceItem(0, 6);
    const ref = { kind: 'service_return' as const, id: newId(), label: 'Return RT-261011-0001' };
    h.events.length = 0;
    const first = await h.api.moveServiceStock({ key: `fs:return:${ref.id}`, stockItemId: item.id, locationId: dock.id, from: null, to: 'returned', quantity: 1, reasonCode: 'service_return_received', ref, actor: staff });
    expect(first.levels).toEqual({ available: 6, reserved: 0, incoming: 0, damagedHeld: 0, returned: 1 });
    const again = await h.api.moveServiceStock({ key: `fs:return:${ref.id}`, stockItemId: item.id, locationId: dock.id, from: null, to: 'returned', quantity: 1, reasonCode: 'service_return_received', ref, actor: staff });
    expect(again).toEqual(first);
    expect(await levelAt(item.id, dock.id)).toMatchObject({ returned: 1 });
    const movement = (await admin(h, 'GET', `/movements?stockItemId=${item.id}&limit=50`)).json().items.find((m: { id: string }) => m.id === first.movementId);
    expect(movement).toMatchObject({ fromGroup: 'outside', toGroup: 'returned', reasonCode: 'service_return_received', reasonLabel: 'Return received at Marketly', reference: ref });

    // into damaged_held writes a held_stock row; out of it releases it
    await h.api.moveServiceStock({ key: `fs:removal:${ref.id}`, stockItemId: item.id, locationId: dock.id, from: 'available', to: 'damaged_held', quantity: 2, reasonCode: 'service_removal_reserved', ref: { kind: 'service_removal', id: ref.id, label: 'Removal RM-1' }, actor: staff });
    const held = await db().selectFrom('held_stock').selectAll().where('stock_item_id', '=', item.id).execute();
    expect(held).toEqual([expect.objectContaining({ quantity: 2, reason_code: 'service_removal_reserved', location_id: dock.id })]);
    await h.api.moveServiceStock({ key: `fs:removal-done:${ref.id}`, stockItemId: item.id, locationId: dock.id, from: 'damaged_held', to: null, quantity: 2, reasonCode: 'service_removal_completed', ref: { kind: 'service_removal', id: ref.id, label: 'Removal RM-1' }, actor: staff });
    expect(await levelAt(item.id, dock.id)).toMatchObject({ available: 4, damagedHeld: 0, returned: 1 });

    await expect(h.api.moveServiceStock({ key: `fs:x:${newId()}`, stockItemId: item.id, locationId: dock.id, from: 'returned', to: 'available', quantity: 5, reasonCode: 'service_return_restocked', ref, actor: staff })).rejects.toMatchObject({
      code: 'INSUFFICIENT_STOCK',
      status: 409,
      details: { lines: [{ stockItemId: item.id, requested: 5, available: 1 }] },
    });
    await expect(h.api.moveServiceStock({ key: `fs:x:${newId()}`, stockItemId: item.id, locationId: dock.id, from: 'available', to: 'reserved', quantity: 1, reasonCode: 'service_reconcile', ref, actor: staff })).rejects.toMatchObject({ code: 'RESERVED_NOT_ADJUSTABLE' });
    await expect(h.api.moveServiceStock({ key: `fs:x:${newId()}`, stockItemId: item.id, locationId: dock.id, from: null, to: null, quantity: 1, reasonCode: 'service_found', ref, actor: staff })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(h.api.moveServiceStock({ key: `fs:x:${newId()}`, stockItemId: item.id, locationId: dock.id, from: null, to: 'available', quantity: 1, reasonCode: 'count_correction' as never, ref, actor: staff })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const other = await warehouse(h, 'FBM2');
    await expect(h.api.moveServiceStock({ key: `fs:x:${newId()}`, stockItemId: item.id, locationId: other.id, from: null, to: 'available', quantity: 1, reasonCode: 'service_found', ref, actor: staff })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const company = await officialItem(h, dock.id, 1);
    await expect(h.api.moveServiceStock({ key: `fs:x:${newId()}`, stockItemId: company.id, locationId: dock.id, from: null, to: 'available', quantity: 1, reasonCode: 'service_found', ref, actor: staff })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    await drain();
    expect(eventsNamed(h, 'inventory.adjustment.recorded')).toEqual([]);
    expect(eventsNamed(h, 'inventory.stock.changed').filter((e) => e.stockItemId === item.id).map((e) => e.cause)).toEqual(['service_stock']); // when Available changed (into the removal hold)
    await consistent();
  });

  it('stock.low of a service item says serviceManaged', async () => {
    const { item, sellerId } = await serviceItem(0, 8);
    await seller(h, sellerId, 'PATCH', `/stock-items/${item.id}`, { lowStockThreshold: 3 });
    h.events.length = 0;
    await h.api.moveServiceStock({ key: `fs:low:${item.id}`, stockItemId: item.id, locationId: dock.id, from: 'available', to: null, quantity: 6, reasonCode: 'service_reconcile', ref: { kind: 'service_reconcile', id: newId(), label: 'Reconcile' }, actor: staff });
    await drain();
    expect(eventsNamed(h, 'inventory.stock.low')).toEqual([expect.objectContaining({ stockItemId: item.id, available: 2, threshold: 3, serviceManaged: true })]);
  });
});

describe('seller edits are refused with SERVICE_MANAGED (B7)', () => {
  it('single adjustment, batch rows and bulk rows', async () => {
    const { item, sellerId } = await serviceItem(5, 3);
    const plain = await sellerItem(h, sellerId, 2);
    const single = await seller(h, sellerId, 'POST', `/stock-items/${item.id}/adjustments`, { newAvailable: 9, reasonCode: 'count_correction' });
    expect(single.statusCode).toBe(409);
    expect(single.json().error.code).toBe('SERVICE_MANAGED');
    const batch = await seller(h, sellerId, 'POST', '/adjustments/batch', { items: [{ stockItemId: item.id, newAvailable: 9, reasonCode: 'count_correction' }, { stockItemId: plain.id, newAvailable: 3, reasonCode: 'count_correction' }] });
    expect(batch.statusCode, batch.body).toBe(200);
    expect(batch.json().results).toEqual([expect.objectContaining({ stockItemId: item.id, ok: false, error: expect.objectContaining({ code: 'SERVICE_MANAGED' }) }), expect.objectContaining({ stockItemId: plain.id, ok: true })]);
    const bulk = await h.api.applyBulkQuantities(sellerId, [{ stockItemId: item.id, newAvailable: 1 }, { stockItemId: plain.id, newAvailable: 4 }], newId(), { kind: 'seller', id: sellerId });
    expect(bulk).toEqual([{ stockItemId: item.id, ok: false, error: expect.stringContaining('Marketly') }, { stockItemId: plain.id, ok: true }]);
    expect(await levelAt(item.id, dock.id)).toMatchObject({ available: 3 });
    expect((await seller(h, sellerId, 'GET', `/stock-items/${item.id}`)).json().item.ownLocationQuantities.available).toBe(5);
    // the low-stock threshold is not a quantity: still the seller's
    expect((await seller(h, sellerId, 'PATCH', `/stock-items/${item.id}`, { lowStockThreshold: 2 })).statusCode).toBe(200);
  });

  it('after the service location is cleared the seller edits their own location again', async () => {
    const { item, sellerId } = await serviceItem(5, 3);
    await h.api.setServiceLocation(item.id, null, staff);
    const res = await seller(h, sellerId, 'POST', `/stock-items/${item.id}/adjustments`, { newAvailable: 7, reasonCode: 'received_stock' });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ fromGroup: 'outside', toGroup: 'available', quantity: 2 });
    expect(await levelAt(item.id, dock.id)).toMatchObject({ available: 3 }); // the dock units are untouched
    expect(eventsNamed(h, 'inventory.adjustment.recorded').at(-1)).toMatchObject({ stockItemId: item.id, serviceManaged: false, locationId: expect.not.stringMatching(dock.id) });
    await consistent();
  });
});

describe('staff changes at the service location publish adjustment.recorded with serviceManaged (B8)', () => {
  it('a staff adjustment of a service item', async () => {
    const { item, sellerId } = await serviceItem(2, 5);
    const costs = h.costs.length;
    const res = await admin(h, 'POST', '/adjustments', { stockItemId: item.id, fromGroup: 'available', toGroup: 'outside', quantity: 1, reasonCode: 'theft_or_loss', note: 'Missing from bin' });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ locationId: dock.id, state: 'applied' });
    expect(eventsNamed(h, 'inventory.adjustment.recorded')).toEqual([expect.objectContaining({ stockItemId: item.id, locationId: dock.id, ownerType: 'seller', sellerId, serviceManaged: true, fromGroup: 'available', toGroup: 'outside', quantity: 1, reasonCode: 'theft_or_loss' })]);
    expect(h.costs).toHaveLength(costs); // seller stock has no company cost to write off
    // the seller's own-location units are not staff's to adjust
    const own = (await db().selectFrom('locations').select('id').where('seller_id', '=', sellerId).executeTakeFirst()).id;
    expect((await admin(h, 'POST', '/adjustments', { stockItemId: item.id, locationId: own, fromGroup: 'available', toGroup: 'outside', quantity: 1, reasonCode: 'theft_or_loss' })).statusCode).toBe(400);
    const plain = await sellerItem(h, sellerId, 2);
    expect((await admin(h, 'POST', '/adjustments', { stockItemId: plain.id, fromGroup: 'available', toGroup: 'outside', quantity: 1, reasonCode: 'theft_or_loss' })).statusCode).toBe(400);
  });

  it('a stock count at the dock includes service items; its correction is serviceManaged', async () => {
    const { item } = await serviceItem(0, 4);
    const count = await admin(h, 'POST', '/counts', { locationId: dock.id, scope: item.sku });
    expect(count.statusCode, count.body).toBe(201);
    expect(count.json().lines).toEqual([expect.objectContaining({ stockItemId: item.id, expected: 4 })]);
    await admin(h, 'PUT', `/counts/${count.json().id}/lines`, { lines: [{ stockItemId: item.id, sku: item.sku, expected: 4, counted: 5 }] });
    h.events.length = 0;
    expect((await admin(h, 'POST', `/counts/${count.json().id}/submit`)).statusCode).toBe(200);
    expect(eventsNamed(h, 'inventory.adjustment.recorded')).toEqual([expect.objectContaining({ stockItemId: item.id, serviceManaged: true, reasonCode: 'count_correction', toGroup: 'available', quantity: 1 })]);
    expect(await levelAt(item.id, dock.id)).toMatchObject({ available: 5 });
  });

  it('discrepancy reports and resolutions that move units publish adjustment.recorded', async () => {
    const { item } = await serviceItem(0, 4);
    const d = await h.api.reportDiscrepancy({ kind: 'damage_found', stockItemId: item.id, locationId: dock.id, quantity: 1, reportedBy: staff });
    await drain();
    expect(eventsNamed(h, 'inventory.adjustment.recorded')).toEqual([expect.objectContaining({ adjustmentId: null, stockItemId: item.id, serviceManaged: true, fromGroup: 'available', toGroup: 'damaged_held', reasonCode: 'damage_found' })]);
    h.events.length = 0;
    const res = await admin(h, 'POST', `/discrepancies/${d.id}/resolve`, { resolution: 'adjusted', note: 'Disposed' });
    expect(res.statusCode, res.body).toBe(200);
    expect(eventsNamed(h, 'inventory.adjustment.recorded')).toEqual([expect.objectContaining({ stockItemId: item.id, locationId: dock.id, serviceManaged: true, fromGroup: 'damaged_held', toGroup: 'outside', quantity: 1 })]);
    // company stock: published too, serviceManaged false
    const company = await officialItem(h, dock.id, 3);
    const s = await h.api.reportDiscrepancy({ kind: 'pick_shortage', stockItemId: company.id, locationId: dock.id, quantity: 1, reportedBy: staff });
    h.events.length = 0;
    await admin(h, 'POST', `/discrepancies/${s.id}/resolve`, { resolution: 'adjusted', note: 'Not found' });
    expect(eventsNamed(h, 'inventory.adjustment.recorded')).toEqual([expect.objectContaining({ stockItemId: company.id, ownerType: 'official', serviceManaged: false, fromGroup: 'available', toGroup: 'outside' })]);
    await consistent();
  });
});

describe('getLevels', () => {
  it('quantities at one location, zeros where the item has none', async () => {
    const { item } = await serviceItem(3, 2);
    const fresh = await sellerItem(h, newId(), 1);
    const levels = await h.api.getLevels([item.id, fresh.id, 'not-an-id'], dock.id);
    expect(levels).toEqual({ [item.id]: { available: 2, reserved: 0, incoming: 0, damagedHeld: 0, returned: 0 }, [fresh.id]: { available: 0, reserved: 0, incoming: 0, damagedHeld: 0, returned: 0 } });
  });
});

describe('migration 0003', () => {
  it('backfills existing purchase receipts and lets old rows keep working', async () => {
    const k = h.app.kernel.database;
    // a purchase receipt from before 0003
    const a = await officialItem(h, dock.id, 0);
    const po = newId();
    const receiptRowId = newId();
    await h.api.expectIncoming(po, 'PUR-2610-0100', dock.id, [{ stockItemId: a.id, quantity: 2, expectedDate: '2026-10-20' }]);
    // back to the schema before 0003
    await k.exec(`delete from inventory.inbound_lines where inbound_id in (select id from inventory.inbound_receipts where source_kind = 'service_inbound');
delete from inventory.inbound_receipts where source_kind = 'service_inbound';
update inventory.incoming_expectations set source_kind = 'transfer' where source_kind = 'service_inbound';
update inventory.inbound_lines set unit_cost_amount = 0 where unit_cost_amount is null;
drop index inventory.stock_items_service_location_idx;
alter table inventory.stock_items drop column service_location_id;
drop index inventory.inbound_receipts_source_idx;
alter table inventory.inbound_receipts drop column source_kind, drop column source_id, drop column source_ref, drop column owner_type, drop column seller_id;
alter table inventory.inbound_receipts alter column purchase_order_id set not null, alter column purchase_order_ref set not null;
alter table inventory.inbound_lines alter column unit_cost_amount set not null;
alter table inventory.incoming_expectations drop constraint incoming_expectations_source_kind_check;
alter table inventory.incoming_expectations add constraint incoming_expectations_source_kind_check check (source_kind in ('purchase_order', 'transfer'));`);
    const now = new Date();
    await db()
      .insertInto('inbound_receipts')
      .values({ id: receiptRowId, receipt_id: newId(), receipt_ref: 'REC-OLD', purchase_order_id: po, purchase_order_ref: 'PUR-2610-0100', supplier_name: 'Halden', location_id: dock.id, received_by: 'Old', received_at: now, state: 'awaiting_confirmation', confirmed_by: null, confirmed_at: null, note: null })
      .execute();
    await db().insertInto('inbound_lines').values({ inbound_id: receiptRowId, stock_item_id: a.id, expected: 2, received: 2, damaged: 0, bin_code: null, unit_cost_amount: 900, sellable: null, reason: null }).execute();

    await k.exec(`begin;\n${m0003FulfilledByMarketly.sql}\ncommit;`);

    const row = await db().selectFrom('inbound_receipts').selectAll().where('id', '=', receiptRowId).executeTakeFirst();
    expect(row).toMatchObject({ source_kind: 'purchase_order', source_id: po, source_ref: 'PUR-2610-0100', owner_type: 'official', seller_id: null });
    expect((await db().selectFrom('stock_items').select('service_location_id').where('id', '=', a.id).executeTakeFirst()).service_location_id).toBeNull();
    // the old receipt confirms as before
    const res = await admin(h, 'POST', `/inbound/${receiptRowId}/confirm`, { lines: [], checked: true });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ source: { kind: 'purchase_order', id: po, ref: 'PUR-2610-0100' }, ownerType: 'official' });
    expect(await quantities(h, a.id)).toMatchObject({ available: 2, incoming: 0 });
    // the new kinds are accepted
    const { item } = await serviceItem(0, 1);
    expect((await h.api.getLevels([item.id], dock.id))[item.id]).toMatchObject({ available: 1 });
    await expect(db().insertInto('inbound_receipts').values({ id: newId(), receipt_id: newId(), receipt_ref: 'X', source_kind: 'other', supplier_name: 'x', location_id: dock.id, received_by: 'x', received_at: now, state: 'awaiting_confirmation' }).execute()).rejects.toMatchObject({ code: '23514' });
  });
});
