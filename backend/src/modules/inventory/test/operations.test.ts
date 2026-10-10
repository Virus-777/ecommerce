/**
 * Receiving (incoming → confirmed), return stock outcomes, warehouse discrepancies, low stock,
 * daily jobs, bins, transfers and counts (phase 4) and the GraphQL read layer.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { GraphQLContext } from '../../../kernel/graphql/index.js';
import { newId } from '../../../kernel/lib/ids.js';
import { resolvers } from '../graphql/resolvers.js';
import type { InventoryService } from '../service.js';
import { admin, call, eventsNamed, harness, ledgerMismatches, officialItem, quantities, reservedMismatches, sellerHeaders, sellerItem, staffHeaders, warehouse, type Harness } from './helpers.js';

let h: Harness;
let loc: { id: string };

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
  h.costs.length = 0;
  h.raised.length = 0;
});

const staffActor = { kind: 'staff' as const, id: newId(), name: 'Jordan Lee' };
const usd = (amount: number) => ({ amount, currency: 'USD' });

const accept = async (orderId: string, ref: string, reservationId: string, items: { orderItemId: string; stockItemId: string; quantity: number }[]) => {
  h.app.kernel.events.publish('orders', 'orders.order.accepted', {
    orderId,
    ref,
    customerId: null,
    contactEmail: 'sam@example.com',
    total: usd(100),
    groups: [],
    items: items.map((i) => ({ ...i, offerId: newId() })),
    reservationId,
    acceptedAt: new Date().toISOString(),
  });
  await h.app.kernel.events.drain();
};

/** An accepted order holding `quantity` units of an item (allocated from the hold named on the event, no attachOrder) */
async function order(itemId: string, quantity: number) {
  const r = await h.api.hold(`chk-${newId()}`, [{ stockItemId: itemId, quantity }]);
  const orderId = newId();
  const orderItemId = newId();
  await accept(orderId, `MK-261009-${String(Math.floor(Math.random() * 1e5)).padStart(5, '0')}`, r.id, [{ orderItemId, stockItemId: itemId, quantity }]);
  return { reservationId: r.id, orderId, orderItemId };
}

describe('receiving', () => {
  it('adds Incoming per purchase order, replaces it on repeat calls and cancels it', async () => {
    const a = await officialItem(h, loc.id, 0);
    const b = await officialItem(h, loc.id, 0);
    const po = newId();
    await h.api.expectIncoming(po, 'PUR-2610-0031', loc.id, [{ stockItemId: a.id, quantity: 10, expectedDate: '2026-10-20' }, { stockItemId: b.id, quantity: 5, expectedDate: '2026-10-22' }]);
    expect(await quantities(h, a.id)).toMatchObject({ incoming: 10 });
    expect((await admin(h, 'GET', `/stock-items/${a.id}`)).json().item.nextIncoming).toEqual({ quantity: 10, expectedDate: '2026-10-20', purchaseOrderRef: 'PUR-2610-0031' });
    await h.api.expectIncoming(po, 'PUR-2610-0031', loc.id, [{ stockItemId: a.id, quantity: 12, expectedDate: '2026-10-21' }]);
    expect(await quantities(h, a.id)).toMatchObject({ incoming: 12 });
    expect(await quantities(h, b.id)).toMatchObject({ incoming: 0 }); // no longer on the order
    await h.api.cancelIncoming(po, [{ stockItemId: a.id, quantity: 2 }]);
    expect(await quantities(h, a.id)).toMatchObject({ incoming: 10 });
    const offerId = newId();
    expect((await h.api.getOfferAvailability([{ offerId, stockItemId: a.id }]))[offerId]).toMatchObject({ state: 'out_of_stock', maxPerOrder: 0, label: 'Out of stock', expectedRestockDate: '2026-10-21' });
    await h.api.cancelIncoming(po);
    expect(await quantities(h, a.id)).toMatchObject({ incoming: 0 });
    await expect(h.api.expectIncoming(po, 'PUR', newId(), [])).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(await ledgerMismatches(h)).toEqual([]);
  });

  it('keeps counted units in Incoming until the Inventory Manager confirms them; weighted average cost', async () => {
    const a = await officialItem(h, loc.id, 0);
    const b = await officialItem(h, loc.id, 0);
    await h.app.kernel.database.kysely.updateTable('inventory.stock_items').set({ unit_cost_amount: 10000 }).where('id', '=', a.id).execute();
    await admin(h, 'POST', '/adjustments', { stockItemId: a.id, fromGroup: 'outside', toGroup: 'available', quantity: 10, reasonCode: 'found_stock' });
    const po = newId();
    await h.api.expectIncoming(po, 'PUR-2610-0042', loc.id, [{ stockItemId: a.id, quantity: 10, expectedDate: '2026-10-20' }, { stockItemId: b.id, quantity: 4, expectedDate: '2026-10-20' }]);
    const receiptId = newId();
    const submitted = await h.api.submitInbound({
      receiptId,
      receiptRef: 'REC-261006-03',
      purchaseOrderId: po,
      purchaseOrderRef: 'PUR-2610-0042',
      supplierName: 'Halden Audio',
      locationId: loc.id,
      receivedBy: staffActor,
      receivedAt: h.clock.now().toISOString(),
      lines: [
        { stockItemId: a.id, expected: 10, received: 10, damaged: 1, binCode: 'A-03-2', unitCost: usd(13000) },
        { stockItemId: b.id, expected: 4, received: 5, damaged: 0, unitCost: usd(2000) },
      ],
    });
    expect(submitted).toMatchObject({ state: 'awaiting_confirmation', totals: { received: 15, damaged: 1, shortage: 0, sellable: 14 }, openPickShortages: 0, receivedBy: { name: 'Jordan Lee' } });
    expect(submitted.lines.find((l) => l.stockItemId === b.id)).toMatchObject({ outOfStockNow: true, sellable: 5 });
    const again = await h.api.submitInbound({ receiptId, receiptRef: 'REC-261006-03', purchaseOrderId: po, purchaseOrderRef: 'PUR-2610-0042', supplierName: 'x', locationId: loc.id, receivedBy: staffActor, receivedAt: h.clock.now().toISOString(), lines: [] });
    expect(again.id).toBe(submitted.id); // same receipt: no double Incoming
    expect(await quantities(h, a.id)).toMatchObject({ available: 10, incoming: 10 });
    expect(await quantities(h, b.id)).toMatchObject({ incoming: 5 }); // one more than ordered
    expect((await admin(h, 'GET', '/inbound?state=awaiting_confirmation')).json().items.map((r: { id: string }) => r.id)).toContain(submitted.id);

    expect((await admin(h, 'POST', `/inbound/${submitted.id}/confirm`, { lines: [], checked: false })).statusCode).toBe(400);
    const tooMany = await admin(h, 'POST', `/inbound/${submitted.id}/confirm`, { lines: [{ stockItemId: a.id, sellable: 10, damaged: 1 }], checked: true });
    expect(tooMany.json().error.code).toBe('SELLABLE_EXCEEDS_RECEIVED');
    expect((await admin(h, 'POST', `/inbound/${submitted.id}/confirm`, { lines: [{ stockItemId: a.id, sellable: 8, damaged: 1 }], checked: true })).statusCode).toBe(400); // differs: reason needed

    const res = await admin(h, 'POST', `/inbound/${submitted.id}/confirm`, { lines: [{ stockItemId: a.id, sellable: 8, damaged: 1, reason: 'One unit kept for QA' }], checked: true, note: 'Counted twice' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ state: 'confirmed', confirmedBy: { name: 'Priya Nair' }, totals: { sellable: 13, damaged: 1 } });
    expect(await quantities(h, a.id)).toMatchObject({ available: 18, incoming: 0, damagedHeld: 1 });
    expect(await quantities(h, b.id)).toMatchObject({ available: 5, incoming: 0 });
    // (10 × 100.00 + 9 × 130.00) / 19 = 114.21
    expect(await h.api.getUnitCost(a.id)).toEqual(usd(11421));
    expect((await admin(h, 'GET', `/stock-items/${a.id}`)).json().item).toMatchObject({ binCode: 'A-03-2', unitCost: usd(11421), valueAtCost: usd(11421 * 19) });
    expect(eventsNamed(h, 'inventory.receipt.confirmed')).toEqual([expect.objectContaining({ inboundId: submitted.id, receiptId, purchaseOrderId: po, confirmedBy: expect.objectContaining({ name: 'Priya Nair' }) })]);
    expect(h.audits.at(-1)).toMatchObject({ action: 'inventory.inbound.confirm', target: expect.objectContaining({ ref: 'REC-261006-03' }) });
    expect((await admin(h, 'POST', `/inbound/${submitted.id}/confirm`, { lines: [], checked: true })).statusCode).toBe(409);
    expect((await admin(h, 'GET', `/inbound/${newId()}`)).statusCode).toBe(404);
    expect(await ledgerMismatches(h)).toEqual([]);
  });

  it('lists open pick shortages on a receipt; nothing is allocated automatically (no backorders), staff reallocate', async () => {
    const a = await officialItem(h, loc.id, 1);
    const o = await order(a.id, 1);
    const reported = await h.api.reportDiscrepancy({ kind: 'pick_shortage', stockItemId: a.id, locationId: loc.id, quantity: 1, orderId: o.orderId, orderRef: 'MK-1', reportedBy: staffActor });
    const po = newId();
    await h.api.expectIncoming(po, 'PUR-2610-0050', loc.id, [{ stockItemId: a.id, quantity: 3, expectedDate: '2026-10-20' }]);
    const r = await h.api.submitInbound({ receiptId: newId(), receiptRef: 'REC-1', purchaseOrderId: po, purchaseOrderRef: 'PUR-2610-0050', supplierName: 'Halden', locationId: loc.id, receivedBy: staffActor, receivedAt: h.clock.now().toISOString(), lines: [{ stockItemId: a.id, expected: 3, received: 3, damaged: 0, unitCost: usd(500) }] });
    expect(r.openPickShortages).toBe(1);
    await admin(h, 'POST', `/inbound/${r.id}/confirm`, { lines: [], checked: true });
    expect(eventsNamed(h, 'inventory.discrepancy.resolved')).toEqual([]);
    expect((await admin(h, 'GET', `/inbound/${r.id}`)).json().openPickShortages).toBe(1);
    const resolved = await admin(h, 'POST', `/discrepancies/${reported.id}/resolve`, { resolution: 'reallocated', sourceGroup: 'available', note: 'Served from the new delivery' });
    expect(resolved.statusCode, resolved.body).toBe(200);
    expect(eventsNamed(h, 'inventory.discrepancy.resolved')).toEqual([{ discrepancyId: reported.id, resolution: 'reallocated', orderId: o.orderId }]);
    expect(await quantities(h, a.id)).toMatchObject({ available: 2, reserved: 1 });
    expect(await reservedMismatches(h)).toEqual([]);
  });
});

describe('returns', () => {
  const inspected = async (returnId: string, variantId: string, quantity: number, proposed = 'restock', o: { orderItemId?: string; stockItemId?: string | null } = {}) => {
    h.app.kernel.events.publish('returns', 'returns.return.inspected', { returnId, ref: 'RT-261010-0001', orderId: newId(), orderRef: 'MK-261010-0001', ownerType: 'official', sellerId: null, conditionOutcome: 'Like new, opened', proposedStockOutcome: proposed, orderItemId: o.orderItemId ?? newId(), variantId, stockItemId: o.stockItemId ?? null, quantity });
    await h.app.kernel.events.drain();
  };
  const received = async (returnId: string, items: { orderItemId: string; quantity: number; variantId: string; stockItemId?: string | null }[], ownerType: 'official' | 'seller' = 'official') => {
    h.app.kernel.events.publish('returns', 'returns.return.received', { returnId, ref: 'RT-261010-0001', orderId: newId(), orderRef: 'MK-261010-0001', ownerType, sellerId: ownerType === 'seller' ? newId() : null, items, receivedAt: new Date().toISOString() });
    await h.app.kernel.events.drain();
  };

  it('adds received Official Store units to Returned once per return item; inspection only creates the pending outcome', async () => {
    const a = await officialItem(h, loc.id, 0);
    const b = await officialItem(h, loc.id, 0);
    const returnId = newId();
    const itemA = newId();
    const itemB = newId();
    await received(returnId, [{ orderItemId: itemA, quantity: 2, variantId: a.variantId, stockItemId: a.id }, { orderItemId: itemB, quantity: 1, variantId: b.variantId }]);
    await received(returnId, [{ orderItemId: itemA, quantity: 2, variantId: a.variantId, stockItemId: a.id }, { orderItemId: itemB, quantity: 1, variantId: b.variantId }]); // replay
    await received(newId(), [{ orderItemId: newId(), quantity: 1, variantId: a.variantId, stockItemId: a.id }], 'seller'); // seller returns: adjustments
    expect(await quantities(h, a.id)).toMatchObject({ returned: 2, available: 0 });
    expect(await quantities(h, b.id)).toMatchObject({ returned: 1 }); // found through the variant
    expect((await admin(h, 'GET', `/movements?stockItemId=${a.id}&reasonCode=return_received`)).json().items).toEqual([expect.objectContaining({ fromGroup: 'outside', toGroup: 'returned', quantity: 2, reference: expect.objectContaining({ kind: 'return', id: returnId }) })]);

    await inspected(returnId, a.variantId, 2, 'restock', { orderItemId: itemA, stockItemId: a.id });
    await inspected(returnId, a.variantId, 2, 'restock', { orderItemId: itemA, stockItemId: a.id }); // replay
    h.app.kernel.events.publish('returns', 'returns.return.inspected', { returnId: newId(), ref: 'RT-261010-0002', orderId: newId(), orderRef: 'MK-261010-0002', ownerType: 'seller', sellerId: newId(), conditionOutcome: 'x', proposedStockOutcome: 'restock', orderItemId: newId(), variantId: a.variantId, quantity: 1 });
    await h.app.kernel.events.drain();
    expect(await quantities(h, a.id)).toMatchObject({ returned: 2, available: 0 }); // inspection moves nothing
    const pending = (await admin(h, 'GET', '/return-outcomes?state=pending')).json().items.filter((o: { returnId: string }) => o.returnId === returnId);
    expect(pending).toEqual([expect.objectContaining({ stockItemId: a.id, quantity: 2, inspectedCondition: 'Like new, opened', proposedOutcome: 'restock', state: 'pending', movements: [expect.objectContaining({ toGroup: 'returned', quantity: 2 })] })]);

    const res = await admin(h, 'POST', `/return-outcomes/${pending[0].id}/record`, { outcome: 'restock', binCode: 'R-01-1' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ state: 'recorded', recordedOutcome: 'restock', recordedBy: { name: 'Priya Nair' } });
    expect(await quantities(h, a.id)).toMatchObject({ returned: 0, available: 2 });
    expect(eventsNamed(h, 'inventory.return_outcome.recorded')).toEqual([{ returnId, stockItemId: a.id, outcome: 'restock', targetStockItemId: null, quantity: 2, valueAtCost: null }]);
    expect((await admin(h, 'POST', `/return-outcomes/${pending[0].id}/record`, { outcome: 'restock' })).statusCode).toBe(409);

    // a received event arriving again after the outcome was recorded adds nothing
    await received(returnId, [{ orderItemId: itemA, quantity: 2, variantId: a.variantId, stockItemId: a.id }]);
    expect(await quantities(h, a.id)).toMatchObject({ returned: 0, available: 2 });
    expect(await ledgerMismatches(h)).toEqual([]);
  });

  it('adds the units to Returned on inspection when no received event came, and a late received event adds nothing', async () => {
    const a = await officialItem(h, loc.id, 0);
    const returnId = newId();
    const item1 = newId();
    const item2 = newId();
    // two return items of the same stock item: one pending outcome with both items' units
    await inspected(returnId, a.variantId, 1, 'damaged_stock', { orderItemId: item1, stockItemId: a.id });
    await inspected(returnId, a.variantId, 2, 'damaged_stock', { orderItemId: item2, stockItemId: a.id });
    await inspected(returnId, a.variantId, 2, 'damaged_stock', { orderItemId: item2, stockItemId: a.id }); // replay
    expect(await quantities(h, a.id)).toMatchObject({ returned: 3, damagedHeld: 0 });
    await received(returnId, [{ orderItemId: item1, quantity: 1, variantId: a.variantId, stockItemId: a.id }, { orderItemId: item2, quantity: 2, variantId: a.variantId, stockItemId: a.id }]);
    expect(await quantities(h, a.id)).toMatchObject({ returned: 3 });
    const pending = (await admin(h, 'GET', '/return-outcomes?state=pending&limit=100')).json().items.filter((o: { returnId: string }) => o.returnId === returnId);
    expect(pending).toEqual([expect.objectContaining({ stockItemId: a.id, quantity: 3, proposedOutcome: 'damaged_stock', state: 'pending' })]);

    // the stock moves when the outcome is recorded: damaged → Damaged or held
    const res = await admin(h, 'POST', `/return-outcomes/${pending[0].id}/record`, { outcome: 'damaged_stock', reviewDate: '2026-12-01', note: 'Cracked housing' });
    expect(res.statusCode, res.body).toBe(200);
    expect(await quantities(h, a.id)).toMatchObject({ returned: 0, damagedHeld: 3, available: 0 });
    expect(await ledgerMismatches(h)).toEqual([]);
  });

  it('records a different condition at the original cost, holds for repair, writes off at cost', async () => {
    const a = await officialItem(h, loc.id, 0);
    const likeNew = await officialItem(h, loc.id, 0, { condition: 'used_like_new' });
    await h.app.kernel.database.kysely.updateTable('inventory.stock_items').set({ unit_cost_amount: 9000 }).where('id', '=', a.id).execute();
    const r1 = newId();
    const r2 = newId();
    const r3 = newId();
    await inspected(r1, a.variantId, 1, 'different_condition');
    await inspected(r2, a.variantId, 1, 'repair');
    await inspected(r3, a.variantId, 1, 'write_off');
    const outcomes = (await admin(h, 'GET', '/return-outcomes?state=pending&limit=100')).json().items;
    const of = (id: string) => outcomes.find((o: { returnId: string }) => o.returnId === id).id;
    expect((await admin(h, 'POST', `/return-outcomes/${of(r1)}/record`, { outcome: 'different_condition' })).statusCode).toBe(400);
    const moved = await admin(h, 'POST', `/return-outcomes/${of(r1)}/record`, { outcome: 'different_condition', targetStockItemId: likeNew.id });
    expect(moved.json().movements.map((m: { stockItemId: string; fromGroup: string; toGroup: string }) => [m.stockItemId, m.fromGroup, m.toGroup])).toEqual(
      expect.arrayContaining([[a.id, 'outside', 'returned'], [a.id, 'returned', 'outside'], [likeNew.id, 'outside', 'available']]),
    );
    expect(await quantities(h, likeNew.id)).toMatchObject({ available: 1 });
    expect(await h.api.getUnitCost(likeNew.id)).toEqual(usd(9000));

    const noDate = await admin(h, 'POST', `/return-outcomes/${of(r2)}/record`, { outcome: 'repair' });
    expect(noDate.json().error.code).toBe('REVIEW_DATE_REQUIRED');
    await admin(h, 'POST', `/return-outcomes/${of(r2)}/record`, { outcome: 'repair', reviewDate: '2026-10-01', note: 'Sent to Halden repair' });
    expect(await quantities(h, a.id)).toMatchObject({ damagedHeld: 1 });

    await admin(h, 'POST', `/return-outcomes/${of(r3)}/record`, { outcome: 'write_off' });
    expect(eventsNamed(h, 'inventory.return_outcome.recorded').at(-1)).toMatchObject({ outcome: 'write_off', valueAtCost: usd(9000) });
    expect(h.costs).toEqual([expect.objectContaining({ kind: 'write_off', amount: usd(9000), reference: expect.objectContaining({ kind: 'return', id: r3 }) })]);
    expect(await quantities(h, a.id)).toMatchObject({ returned: 0, damagedHeld: 1 });

    // the repair hold is past its review date
    await h.app.kernel.jobs.runNow('inventory.held-stock-review');
    await h.app.kernel.events.drain();
    expect(eventsNamed(h, 'inventory.hold.review_due')).toEqual(expect.arrayContaining([{ stockItemId: a.id, quantity: 1, reasonCode: 'return_repair', reviewDate: '2026-10-01' }]));
    expect(await ledgerMismatches(h)).toEqual([]);
  });
});

describe('discrepancies', () => {
  it('moves damaged reserved units to Damaged or held at once and reallocates a replacement', async () => {
    const a = await officialItem(h, loc.id, 5);
    const o = await order(a.id, 2);
    const d = await h.api.reportDiscrepancy({ kind: 'damage_found', stockItemId: a.id, locationId: loc.id, binCode: 'A-03-2', quantity: 1, orderId: o.orderId, orderRef: 'MK-261009-00001', note: 'Cracked case', photoIds: [], reportedBy: staffActor });
    await h.app.kernel.events.drain();
    expect(d).toMatchObject({ kind: 'damage_found', state: 'open', sku: a.sku, reportedBy: { name: 'Jordan Lee' }, photos: [] });
    expect(eventsNamed(h, 'inventory.discrepancy.reported')).toEqual([{ discrepancyId: d.id, kind: 'damage_found', stockItemId: a.id, orderId: o.orderId, quantity: 1 }]);
    expect(await quantities(h, a.id)).toMatchObject({ available: 3, reserved: 1, damagedHeld: 1 });
    expect(await reservedMismatches(h)).toEqual([]);
    expect((await admin(h, 'GET', '/discrepancies?state=open&kind=damage_found')).json().items.map((x: { id: string }) => x.id)).toContain(d.id);
    expect((await admin(h, 'POST', `/discrepancies/${d.id}/resolve`, { resolution: 'reallocated', note: '' })).statusCode).toBe(400);
    const res = await admin(h, 'POST', `/discrepancies/${d.id}/resolve`, { resolution: 'reallocated', sourceGroup: 'available', note: 'Took the next unit from A-03-2' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ state: 'resolved', resolution: 'reallocated', resolvedBy: { name: 'Priya Nair' } });
    expect(eventsNamed(h, 'inventory.discrepancy.resolved')).toEqual([{ discrepancyId: d.id, resolution: 'reallocated', orderId: o.orderId }]);
    expect(await quantities(h, a.id)).toMatchObject({ available: 2, reserved: 2, damagedHeld: 1 });
    expect(await reservedMismatches(h)).toEqual([]);
    expect((await admin(h, 'POST', `/discrepancies/${d.id}/resolve`, { resolution: 'no_change', note: 'again' })).statusCode).toBe(409);
  });

  it('writes off a pick shortage from the order allocation, or reallocates it from Returned', async () => {
    const a = await officialItem(h, loc.id, 3);
    const o = await order(a.id, 2);
    const short = await h.api.reportDiscrepancy({ kind: 'pick_shortage', stockItemId: a.id, locationId: loc.id, quantity: 1, orderId: o.orderId, reportedBy: staffActor });
    expect(await quantities(h, a.id)).toMatchObject({ available: 1, reserved: 2 }); // nothing moves until resolved
    const none = await admin(h, 'POST', `/discrepancies/${short.id}/resolve`, { resolution: 'reallocated', sourceGroup: 'returned', note: 'From returns shelf' });
    expect(none.json().error).toMatchObject({ code: 'GROUP_QUANTITY_EXCEEDED', details: { group: 'returned' } });
    const res = await admin(h, 'POST', `/discrepancies/${short.id}/resolve`, { resolution: 'adjusted', note: 'Unit missing from the bin' });
    expect(res.json()).toMatchObject({ resolution: 'adjusted' });
    expect(await quantities(h, a.id)).toMatchObject({ available: 1, reserved: 1 });
    expect(await reservedMismatches(h)).toEqual([]);

    const b = await officialItem(h, loc.id, 0);
    h.app.kernel.events.publish('returns', 'returns.return.inspected', { returnId: newId(), ref: 'RT-261010-0002', orderId: newId(), orderRef: 'MK-261010-0002', ownerType: 'official', sellerId: null, conditionOutcome: 'New', proposedStockOutcome: 'restock', orderItemId: newId(), variantId: b.variantId, quantity: 1 });
    await h.app.kernel.events.drain();
    await admin(h, 'POST', '/adjustments', { stockItemId: b.id, fromGroup: 'outside', toGroup: 'available', quantity: 1, reasonCode: 'found_stock' });
    const ob = await order(b.id, 1);
    const s2 = await h.api.reportDiscrepancy({ kind: 'pick_shortage', stockItemId: b.id, locationId: loc.id, quantity: 1, orderId: ob.orderId, reportedBy: staffActor });
    await admin(h, 'POST', `/discrepancies/${s2.id}/resolve`, { resolution: 'reallocated', sourceGroup: 'returned', note: 'Returned unit is like new' });
    expect(await quantities(h, b.id)).toMatchObject({ returned: 0, reserved: 1 });
    expect(await ledgerMismatches(h)).toEqual([]);
  });
});

describe('low stock and jobs', () => {
  it('lists SKUs at or below the reorder point with cover and a suggested quantity', async () => {
    const a = await officialItem(h, loc.id, 2, { lowStockThreshold: 5 });
    await admin(h, 'PATCH', `/stock-items/${a.id}`, { reorderQuantity: 40 });
    const b = await officialItem(h, loc.id, 1, { lowStockThreshold: 4 });
    const o = await order(b.id, 1);
    h.app.kernel.events.publish('shipping', 'shipping.shipment.dispatched', { shipmentId: newId(), kind: 'outbound', orderId: o.orderId, groupId: newId(), ownerType: 'official', sellerId: null, lines: [{ orderItemId: o.orderItemId, title: 'x', variantLabel: 'y', quantity: 1 }], shippedAt: new Date().toISOString(), trackingValid: true });
    await h.app.kernel.events.drain();
    const rows = (await admin(h, 'GET', '/low-stock?limit=100')).json().items;
    expect(rows.find((r: { item: { id: string } }) => r.item.id === a.id)).toMatchObject({ suggestedReorderQuantity: 40, daysOfCover: null });
    expect(rows.find((r: { item: { id: string } }) => r.item.id === b.id)).toMatchObject({ item: { state: 'out_of_stock' }, suggestedReorderQuantity: 8, daysOfCover: 0 });
    const summary = (await admin(h, 'GET', `/summary?locationId=${loc.id}`)).json();
    expect(summary.lowStockHeadline).toMatch(/SKUs? at or below reorder point/);
  });

  it('publishes one low-stock digest per owner (worst first), and nothing for an owner with nothing to report', async () => {
    const sellerId = newId();
    const low = await sellerItem(h, sellerId, 1);
    const out = await sellerItem(h, sellerId, 0);
    await sellerItem(h, sellerId, 40); // well stocked
    const quiet = newId();
    await sellerItem(h, quiet, 40);
    h.events.length = 0;
    await h.app.kernel.jobs.runNow('inventory.low-stock-digest');
    await h.app.kernel.events.drain();
    const digests = eventsNamed(h, 'inventory.stock.low_digest');
    const mine = digests.filter((d) => d.sellerId === sellerId);
    expect(mine).toEqual([
      {
        ownerType: 'seller',
        sellerId,
        date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        lowCount: 1,
        outOfStockCount: 1,
        items: [
          expect.objectContaining({ stockItemId: out.id, state: 'out_of_stock', available: 0 }),
          expect.objectContaining({ stockItemId: low.id, offerId: low.offerId, sku: low.sku, state: 'low_stock', available: 1, threshold: expect.any(Number) }),
        ],
      },
    ]);
    expect(digests.filter((d) => d.sellerId === quiet)).toEqual([]);
    expect(eventsNamed(h, 'inventory.stock.low')).toEqual([]); // the digest is one summary, not a reminder per item
  });

  it('takes a valuation snapshot', async () => {
    await expect(h.app.kernel.jobs.runNow('inventory.valuation-snapshot')).resolves.toBeUndefined();
  });

  it('shows the primary bin the warehouse assigns', async () => {
    const a = await officialItem(h, loc.id, 1);
    h.app.kernel.events.publish('warehouse', 'warehouse.bin.assigned', { stockItemId: a.id, binId: newId(), binCode: 'B-07-1', primary: true });
    h.app.kernel.events.publish('warehouse', 'warehouse.bin.assigned', { stockItemId: newId(), binId: newId(), binCode: 'B-07-2', primary: true });
    await h.app.kernel.events.drain();
    expect((await admin(h, 'GET', `/stock-items/${a.id}`)).json().item.binCode).toBe('B-07-1');
    expect((await admin(h, 'GET', '/stock-items?zone=B-07')).json().items.map((i: { id: string }) => i.id)).toContain(a.id);
  });
});

describe('transfers and counts (phase 4)', () => {
  it('ships Available at the source to Incoming at the destination and receives it', async () => {
    const slc = await warehouse(h, 'SLC1');
    const a = await officialItem(h, loc.id, 10);
    const created = await admin(h, 'POST', '/transfers', { fromLocationId: loc.id, toLocationId: slc.id, lines: [{ stockItemId: a.id, sku: a.sku, quantity: 4 }] });
    expect(created.statusCode, created.body).toBe(201);
    const t = created.json();
    expect(t).toMatchObject({ state: 'draft', ref: expect.stringMatching(/^TRF-/), lines: [{ stockItemId: a.id, sku: a.sku, quantity: 4 }] });
    const shipped = await admin(h, 'POST', `/transfers/${t.id}/ship`);
    expect(shipped.json()).toMatchObject({ state: 'in_transit', shippedAt: expect.any(String) });
    const detail = (await admin(h, 'GET', `/stock-items/${a.id}`)).json();
    expect(detail.levels.find((l: { locationId: string }) => l.locationId === slc.id).quantities).toMatchObject({ incoming: 4 });
    expect(detail.levels.find((l: { locationId: string }) => l.locationId === loc.id).quantities).toMatchObject({ available: 6 });
    expect((await admin(h, 'POST', `/transfers/${t.id}/cancel`, { reason: 'x' })).statusCode).toBe(409);
    const received = await admin(h, 'POST', `/transfers/${t.id}/receive`, { lines: [{ stockItemId: a.id, sku: a.sku, quantity: 4, receivedQuantity: 3 }], note: 'One missing' });
    expect(received.json()).toMatchObject({ state: 'received', lines: [{ receivedQuantity: 3 }] });
    expect(eventsNamed(h, 'inventory.transfer.received')).toEqual([{ transferId: t.id, toLocationId: slc.id }]);
    expect(await quantities(h, a.id)).toMatchObject({ available: 9, incoming: 0 });
    const draft = (await admin(h, 'POST', '/transfers', { fromLocationId: loc.id, toLocationId: slc.id, lines: [{ stockItemId: a.id, sku: a.sku, quantity: 1 }] })).json();
    expect((await admin(h, 'POST', `/transfers/${draft.id}/cancel`, { reason: 'Not needed' })).json().state).toBe('cancelled');
    expect((await admin(h, 'GET', '/transfers?state=received')).json().items.map((x: { id: string }) => x.id)).toContain(t.id);
    expect((await admin(h, 'POST', '/transfers', { fromLocationId: loc.id, toLocationId: loc.id, lines: [] })).statusCode).toBe(400);
    expect(await ledgerMismatches(h)).toEqual([]);
  });

  it('counts a SKU list; differences become count-correction adjustments', async () => {
    const a = await officialItem(h, loc.id, 10);
    const b = await officialItem(h, loc.id, 4);
    const created = await admin(h, 'POST', '/counts', { locationId: loc.id, scope: `${a.sku}, ${b.sku}` });
    expect(created.statusCode, created.body).toBe(201);
    const c = created.json();
    expect(c.lines.map((l: { sku: string; expected: number }) => [l.sku, l.expected]).sort()).toEqual([[a.sku, 10], [b.sku, 4]].sort());
    const recorded = await admin(h, 'PUT', `/counts/${c.id}/lines`, { lines: [{ stockItemId: a.id, sku: a.sku, expected: 10, counted: 8 }, { stockItemId: b.id, sku: b.sku, expected: 4, counted: 5 }] });
    expect(recorded.statusCode, recorded.body).toBe(200);
    const submitted = await admin(h, 'POST', `/counts/${c.id}/submit`);
    expect(submitted.json()).toMatchObject({ state: 'applied', submittedAt: expect.any(String) });
    expect(await quantities(h, a.id)).toMatchObject({ available: 8 });
    expect(await quantities(h, b.id)).toMatchObject({ available: 5 });
    expect((await admin(h, 'GET', `/adjustments?stockItemId=${a.id}`)).json().items[0]).toMatchObject({ reasonCode: 'count_correction', state: 'applied', quantity: 2, fromGroup: 'available', toGroup: 'outside' });
    expect((await admin(h, 'PUT', `/counts/${c.id}/lines`, { lines: [] })).statusCode).toBe(409);

    // a count short of the reserved units cannot be adjusted here
    const r = await officialItem(h, loc.id, 2);
    await h.api.hold(`chk-${newId()}`, [{ stockItemId: r.id, quantity: 2 }]);
    const c2 = (await admin(h, 'POST', '/counts', { locationId: loc.id, scope: r.sku })).json();
    await admin(h, 'PUT', `/counts/${c2.id}/lines`, { lines: [{ stockItemId: r.id, sku: r.sku, expected: 2, counted: 0 }] });
    const refused = await admin(h, 'POST', `/counts/${c2.id}/submit`);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('RESERVED_NOT_ADJUSTABLE');
  });
});

describe('GraphQL read layer', () => {
  it('answers the admin stock summary and the seller tile', async () => {
    await officialItem(h, loc.id, 3);
    const res = await call(h, 'POST', '/graphql/admin', staffHeaders(), { query: '{ stockSummary { skuCount lowStockCount groups { group label units valueAtCost { formatted } } } }' });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.errors).toBeUndefined();
    expect(body.data.stockSummary.groups[0]).toMatchObject({ group: 'AVAILABLE', label: 'Available', valueAtCost: { formatted: expect.stringMatching(/^\$/) } });
    const sellerId = newId();
    await sellerItem(h, sellerId, 0, { label: 'Aurora, Silver' });
    const tile = await call(h, 'POST', '/graphql/seller', sellerHeaders({ sellerId }), { query: '{ myStockSummary { outOfStockSkus outOfStockLabels } }' });
    expect(tile.json().data.myStockSummary).toEqual({ outOfStockSkus: 1, outOfStockLabels: ['Aurora, Silver'] });
  });

  it('resolves Offer.availability, Offer.stock and Variant.stock in batches, own items only in the Seller Center', async () => {
    const service = h.app.kernel.boot.apis.get('inventory') as unknown as InventoryService;
    const r = resolvers(service);
    const sellerId = newId();
    const mine = await sellerItem(h, sellerId, 2, { lowStockThreshold: 5 });
    const theirs = await sellerItem(h, newId(), 9, { variantId: mine.variantId });
    const sellerCtx = { area: 'seller', principal: { kind: 'seller', sellerId }, permissions: new Map(), can: async () => false } as unknown as GraphQLContext;
    const staffCtx = { area: 'admin', principal: { kind: 'staff' }, permissions: new Map(), can: async (p: string) => p === 'inventory.stock.view' } as unknown as GraphQLContext;
    const field = (type: string, name: string) => r[type]![name] as (root: unknown, args: unknown, ctx: GraphQLContext, info?: unknown) => Promise<any>;
    const [avail, other] = await Promise.all([
      field('Offer', 'availability')({ id: mine.offerId, stockItemId: mine.id, purchaseLimit: 1 }, {}, staffCtx),
      field('Offer', 'availability')({ id: theirs.offerId }, {}, staffCtx),
    ]);
    expect(avail).toMatchObject({ state: 'LOW_STOCK', quantity: 2, maxPerOrder: 1, label: '2 left' });
    expect(other).toMatchObject({ state: 'IN_STOCK', maxPerOrder: 9 });
    expect(await field('Offer', 'stock')({ id: theirs.offerId }, {}, sellerCtx)).toBeNull();
    const own = await field('Offer', 'stock')({ id: mine.offerId }, {}, sellerCtx);
    expect(own).toMatchObject({ id: mine.id, ownerType: 'SELLER', state: 'LOW_STOCK' });
    expect(await own.lastChange({}, sellerCtx)).toMatch(/Inventory$/);
    expect((await own.recentMovements({ limit: 5 }, sellerCtx))[0]).toMatchObject({ fromGroup: 'OUTSIDE', toGroup: 'AVAILABLE', quantity: 2, referenceLabel: 'Opening stock', actor: { kind: 'SYSTEM' } });
    expect((await field('Variant', 'stock')({ id: mine.variantId }, {}, sellerCtx)).map((s: { id: string }) => s.id)).toEqual([mine.id]);
    expect((await field('Variant', 'stock')({ id: mine.variantId }, {}, staffCtx)).map((s: { id: string }) => s.id).sort()).toEqual([mine.id, theirs.id].sort());
  });
});
