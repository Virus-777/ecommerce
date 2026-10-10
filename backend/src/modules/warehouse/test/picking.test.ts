import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { callers } from '../../../testing/app.js';
import { harness, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await harness();
  await h.bins(['A-01-1', 'A-02-1', 'A-10-1', 'B-01-1']);
});
afterAll(async () => {
  await h?.app.close();
});

async function assign(item: { id: string }, code: string) {
  const bins = (await h.call('GET', `/bins?q=${code}&locationId=${h.locationId}`)).body.items;
  const r = await h.call('PUT', `/stock-items/${item.id}/bins`, { bins: [{ binId: bins[0].id, primary: true }] });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}

describe('fulfillments from accepted orders', () => {
  it('creates one fulfillment for the Official Store group with SKUs, labels, primary bins and the ship-by', async () => {
    const head = h.item('HAL-AU-100-WH', 'Aurora headphones, White');
    await assign(head, 'A-10-1');
    const before = h.events.length;
    const o = await h.order([{ item: head, quantity: 2 }], { sellerGroup: true, dispatchInHours: 30 });
    const f = o.fulfillment;
    expect(f).toMatchObject({ orderId: o.orderId, orderRef: o.ref, sellerGroupId: o.groupId, locationId: h.locationId, status: 'awaiting_pick', totalPackagesInOrder: 2, waveId: null });
    expect(f.lines).toEqual([expect.objectContaining({ orderItemId: o.itemIds[0], stockItemId: head.id, sku: 'HAL-AU-100-WH', label: 'Aurora headphones, White', quantity: 2, binCode: 'A-10-1', picked: 0, short: 0, state: 'pending' })]);
    expect(f.deliveryChoice).toMatch(/^UPS Ground · arrives /);
    expect(f.mixedOrderNote).toMatch(/1 other package/);
    expect(h.events.slice(before).filter((e) => e.name === 'warehouse.fulfillment.created')).toEqual([{ name: 'warehouse.fulfillment.created', payload: { fulfillmentId: f.id, orderId: o.orderId, sellerGroupId: o.groupId, fulfilledBy: 'official_warehouse', sellerId: null, shipBy: f.shipBy } }]);
    // the detail names the other seller of a mixed order
    const detail = await h.call('GET', `/fulfillments/${f.id}`);
    expect(detail.body.mixedOrderNote).toBe('This order also has 1 other package from Pixel & Port. They ship it separately.');
    // the same event twice changes nothing
    await h.publish('orders', 'orders.order.accepted', { orderId: o.orderId, ref: o.ref, customerId: null, contactEmail: 'ana@example.com', total: { amount: 100, currency: 'USD' }, groups: [{ groupId: o.groupId, ownerType: 'official', sellerId: null, fulfilledBy: 'official_warehouse', dispatchBy: f.shipBy, itemIds: o.itemIds, total: { amount: 100, currency: 'USD' } }], items: [], acceptedAt: f.createdAt });
    expect((await h.call('GET', `/fulfillments?q=${o.ref}`)).body.items).toHaveLength(1);
  });

  it('lists the most urgent first and resolves orders for the public API and GraphQL', async () => {
    const item = h.item('LIST-1', 'Lamp, Brass');
    const late = await h.order([{ item, quantity: 1 }], { dispatchInHours: 2 });
    const later = await h.order([{ item, quantity: 1 }], { dispatchInHours: 50 });
    const list = await h.call('GET', '/fulfillments?status=awaiting_pick');
    const ids = list.body.items.map((r: any) => r.id);
    expect(ids.indexOf(late.fulfillment.id)).toBeLessThan(ids.indexOf(later.fulfillment.id));
    expect(list.body.items.find((r: any) => r.id === late.fulfillment.id)).toMatchObject({ orderRef: late.ref, itemCount: 1, pickedCount: 0, waveRef: null, deadline: { state: 'on_time' } });
    const outside = newId();
    expect(await h.service.getTasksForOrderGroups([late.groupId, outside])).toEqual({ [late.groupId]: expect.objectContaining({ id: late.fulfillment.id }), [outside]: null });
    expect((await h.service.getFulfillmentForOrder(later.orderId))?.id).toBe(later.fulfillment.id);
    expect(await h.service.getFulfillmentForOrder(newId())).toBeNull();
  });
});

describe('waves and picking', () => {
  it('builds a wave, starts picking (orders learns picking started) and shows the pick list in walking order', async () => {
    const a = h.item('PICK-A', 'Mug, Blue');
    const b = h.item('PICK-B', 'Plate, White');
    await assign(a, 'A-10-1');
    await assign(b, 'A-02-1');
    const o = await h.order([{ item: a, quantity: 1 }, { item: b, quantity: 2 }]);
    const wave = await h.call('POST', '/waves', { locationId: h.locationId, fulfillmentIds: [o.fulfillment.id] });
    expect(wave.status, JSON.stringify(wave.body)).toBe(201);
    expect(wave.body).toMatchObject({ ref: expect.stringMatching(/^Wave \d+$/), status: 'open', orderCount: 1, progressPct: 0, nextBinCode: 'A-02-1' });
    expect(wave.body.orders[0].lines.map((l: any) => l.binCode)).toEqual(['A-02-1', 'A-10-1']);
    // an order in an open wave cannot join another
    const again = await h.call('POST', '/waves', { locationId: h.locationId, fulfillmentIds: [o.fulfillment.id] });
    expect(again.status).toBe(400);
    // not started yet: nothing can be picked
    const early = await h.call('POST', `/pick-lines/${o.fulfillment.lines[0].id}/pick`, { binCode: 'A-02-1', itemCode: 'PICK-B', quantity: 1 });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('ILLEGAL_TRANSITION');
    const before = h.events.length;
    const started = await h.call('POST', `/waves/${wave.body.id}/start`);
    expect(started.status).toBe(200);
    expect(started.body.status).toBe('picking');
    expect(h.events.slice(before).filter((e) => e.name === 'warehouse.fulfillment.status_changed').map((e) => e.payload)).toEqual([{ fulfillmentId: o.fulfillment.id, orderId: o.orderId, sellerGroupId: o.groupId, fulfilledBy: 'official_warehouse', sellerId: null, from: 'awaiting_pick', to: 'picking', reason: `${wave.body.ref} started` }]);
    expect((await h.call('POST', `/waves/${wave.body.id}/start`)).status).toBe(409);
  });

  it('refuses the wrong bin and the wrong item, counts each unit and never more than ordered', async () => {
    const a = h.item('SCAN-A', 'Kettle, Steel');
    const b = h.item('SCAN-B', 'Toaster, Red');
    await assign(a, 'B-01-1');
    await assign(b, 'A-01-1');
    const o = await h.picking([{ item: a, quantity: 2 }, { item: b, quantity: 1 }]);
    const line = o.fulfillment.lines.find((l: any) => l.sku === 'SCAN-A');
    const wrongBin = await h.call('POST', `/pick-lines/${line.id}/pick`, { binCode: 'A-01-1', itemCode: 'SCAN-A', quantity: 1 });
    expect(wrongBin.status).toBe(409);
    expect(wrongBin.body.error).toMatchObject({ code: 'SCAN_MISMATCH', details: { expected: 'B-01-1', scanned: 'A-01-1' } });
    const otherLine = await h.call('POST', `/pick-lines/${line.id}/pick`, { binCode: 'B-01-1', itemCode: 'SCAN-B', quantity: 1 });
    expect(otherLine.body.error).toMatchObject({ code: 'SCAN_MISMATCH', details: { expected: 'SCAN-A', scanned: 'SCAN-B' } });
    expect(otherLine.body.error.message).toMatch(/another line/);
    const notOnList = await h.call('POST', `/pick-lines/${line.id}/pick`, { binCode: 'B-01-1', itemCode: 'NOPE-1', quantity: 1 });
    expect(notOnList.body.error.message).toMatch(/not on this pick list/);
    // requireItemScan: one unit per scan
    const bulk = await h.call('POST', `/pick-lines/${line.id}/pick`, { binCode: 'B-01-1', itemCode: 'SCAN-A', quantity: 2 });
    expect(bulk.status).toBe(400);
    // the bin barcode works as well as the code, the SKU in any case
    const binBarcode = (await h.call('GET', `/bins?q=B-01-1&locationId=${h.locationId}`)).body.items[0].barcode;
    const first = await h.call('POST', `/pick-lines/${line.id}/pick`, { binCode: binBarcode, itemCode: 'scan-a', quantity: 1 });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.lines.find((l: any) => l.id === line.id)).toMatchObject({ picked: 1, state: 'pending', pickedBy: expect.objectContaining({ kind: 'staff' }) });
    // a second worker cannot take over the line
    const other = await h.call('POST', `/pick-lines/${line.id}/pick`, { binCode: 'B-01-1', itemCode: 'SCAN-A', quantity: 1 }, { token: callers.staff(undefined, { sub: newId() }) });
    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe('CONFLICT');
    await h.call('POST', `/pick-lines/${line.id}/pick`, { binCode: 'B-01-1', itemCode: 'SCAN-A', quantity: 1 });
    const extra = await h.call('POST', `/pick-lines/${line.id}/pick`, { binCode: 'B-01-1', itemCode: 'SCAN-A', quantity: 1 });
    expect(extra.status).toBe(409);
    const before = h.events.length;
    const done = await h.pickAll(o.fulfillment.id);
    expect(done.status).toBe('picked');
    expect(h.named('warehouse.fulfillment.status_changed').slice(-1)[0]).toMatchObject({ from: 'picking', to: 'picked' });
    expect(h.events.length).toBeGreaterThan(before);
    const wave = await h.call('GET', `/waves/${o.waveId}`);
    expect(wave.body).toMatchObject({ progressPct: 100, pickedOrderCount: 1, nextBinCode: null });
  });

  it('a shortage holds the order, asks inventory, and a reallocation resumes it', async () => {
    const a = h.item('SHORT-A', 'Pan, Cast iron');
    await assign(a, 'A-01-1');
    const o = await h.picking([{ item: a, quantity: 3 }]);
    const line = o.fulfillment.lines[0];
    expect((await h.call('POST', `/pick-lines/${line.id}/report-shortage`, { quantityFound: 3 })).status).toBe(400);
    const r = await h.call('POST', `/pick-lines/${line.id}/report-shortage`, { quantityFound: 1, note: 'Only one left on the shelf' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ status: 'on_hold', holdReason: 'Shortage reported: bin A-01-1 had 1 of 3. Inventory is checking.' });
    expect(r.body.lines[0]).toMatchObject({ picked: 1, short: 2, state: 'short' });
    const d = h.discrepancies.at(-1);
    expect(d).toMatchObject({ kind: 'pick_shortage', stockItemId: a.id, locationId: h.locationId, binCode: 'A-01-1', quantity: 2, orderId: o.orderId, orderRef: o.ref, note: 'Only one left on the shelf' });
    expect(h.named('warehouse.shortage.reported').at(-1)).toEqual({ fulfillmentId: o.fulfillment.id, orderId: o.orderId, stockItemId: a.id, binCode: 'A-01-1', quantityShort: 2, discrepancyId: d.id });
    // held: not picked, not packed partly, not resumed while inventory checks
    expect((await h.call('POST', `/pick-lines/${line.id}/pick`, { binCode: 'A-01-1', itemCode: 'SHORT-A', quantity: 1 })).body.error.code).toBe('FULFILLMENT_ON_HOLD');
    expect((await h.call('POST', `/fulfillments/${o.fulfillment.id}/packages`, {})).body.error.code).toBe('FULFILLMENT_ON_HOLD');
    expect((await h.call('POST', `/fulfillments/${o.fulfillment.id}/resume`, {})).body.error.code).toBe('DISCREPANCY_OPEN');
    const summary = await h.call('GET', '/summary');
    expect(summary.body.onHold).toBeGreaterThanOrEqual(1);
    expect(summary.body.openShortages).toBeGreaterThanOrEqual(1);
    // the wave completes with the order on hold; the order moves to the next wave
    const wave = await h.call('GET', `/waves/${o.waveId}`);
    expect(wave.body.status).toBe('completed');
    // inventory reallocates: the order resumes and the short units are picked again
    await h.publish('inventory', 'inventory.discrepancy.resolved', { discrepancyId: d.id, resolution: 'reallocated', orderId: o.orderId });
    const resumed = (await h.call('GET', `/fulfillments/${o.fulfillment.id}`)).body;
    expect(resumed).toMatchObject({ status: 'picking', holdReason: null, waveId: null });
    expect(resumed.lines[0]).toMatchObject({ picked: 1, short: 0, state: 'pending' });
    // twice is the same
    await h.publish('inventory', 'inventory.discrepancy.resolved', { discrepancyId: d.id, resolution: 'reallocated', orderId: o.orderId });
    expect((await h.call('GET', `/fulfillments/${o.fulfillment.id}`)).body.status).toBe('picking');
    expect((await h.pickAll(o.fulfillment.id)).status).toBe('picked');
  });

  it('damage needs photos; an adjusted report waits for staff to resume', async () => {
    const a = h.item('DMG-A', 'Vase, Glass');
    await assign(a, 'A-02-1');
    const o = await h.picking([{ item: a, quantity: 1 }]);
    const line = o.fulfillment.lines[0];
    await h.pickAll(o.fulfillment.id);
    // damage found once every line is picked (before packing) is covered in test/pass3.test.ts
    const pkg = await h.call('POST', `/fulfillments/${o.fulfillment.id}/packages`, { station: 'Pack 2' });
    expect(pkg.status, JSON.stringify(pkg.body)).toBe(201);
    expect((await h.call('POST', `/packages/${pkg.body.id}/scan`, { code: 'DMG-A' })).status).toBe(200);
    const noPhoto = await h.call('POST', `/fulfillments/${o.fulfillment.id}/report-damage`, { lineId: line.id, quantity: 1, note: 'Cracked', photoIds: [] });
    expect(noPhoto.status).toBe(400);
    expect(noPhoto.body.error.details.issues[0].path).toBe('photoIds');
    const photo = newId();
    const r = await h.call('POST', `/fulfillments/${o.fulfillment.id}/report-damage`, { lineId: line.id, quantity: 1, note: 'Cracked rim', photoIds: [photo] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ status: 'on_hold', holdReason: 'Damage reported: 1 × Vase, Glass. Inventory is checking.' });
    expect(r.body.lines[0]).toMatchObject({ picked: 0, state: 'pending' });
    expect(r.body.packages[0]).toMatchObject({ status: 'open', allScanned: false });
    const d = h.discrepancies.at(-1);
    expect(d).toMatchObject({ kind: 'damage_found', quantity: 1, photoIds: [photo], note: 'Cracked rim' });
    expect(h.named('warehouse.damage.reported').at(-1)).toEqual({ fulfillmentId: o.fulfillment.id, orderId: o.orderId, stockItemId: a.id, quantity: 1, discrepancyId: d.id });
    expect(h.named('warehouse.fulfillment.status_changed').at(-1)).toMatchObject({ from: 'packing', to: 'on_hold' });
    // written off instead of reallocated: the order stays held until staff resume it
    await h.publish('inventory', 'inventory.discrepancy.resolved', { discrepancyId: d.id, resolution: 'adjusted', orderId: o.orderId });
    const held = (await h.call('GET', `/fulfillments/${o.fulfillment.id}`)).body;
    expect(held).toMatchObject({ status: 'on_hold', holdReason: expect.stringMatching(/Resume when ready/) });
    const resumed = await h.call('POST', `/fulfillments/${o.fulfillment.id}/resume`, { note: 'Replacement unit found in B zone' });
    expect(resumed.status).toBe(200);
    expect(resumed.body.status).toBe('picking');
    expect(h.named('warehouse.fulfillment.status_changed').at(-1)).toMatchObject({ from: 'on_hold', to: 'picking', reason: 'Replacement unit found in B zone' });
    expect((await h.call('POST', `/fulfillments/${o.fulfillment.id}/resume`, {})).body.error.code).toBe('ILLEGAL_TRANSITION');
    await h.pickAll(o.fulfillment.id);
    // back to packing on the same open box, then the replacement unit is scanned in
    const again = await h.call('POST', `/fulfillments/${o.fulfillment.id}/packages`, {});
    expect(again.body.id).toBe(pkg.body.id);
    expect((await h.call('POST', `/packages/${pkg.body.id}/scan`, { code: 'DMG-A' })).body.allScanned).toBe(true);
  });

  it('cancelled items leave the pick list; picked units go back; all cancelled cancels the fulfillment', async () => {
    const a = h.item('CXL-A', 'Chair, Oak');
    const b = h.item('CXL-B', 'Table, Oak');
    await assign(a, 'A-01-1');
    await assign(b, 'A-02-1');
    const o = await h.picking([{ item: a, quantity: 2 }, { item: b, quantity: 1 }]);
    const la = o.fulfillment.lines.find((l: any) => l.sku === 'CXL-A');
    await h.call('POST', `/pick-lines/${la.id}/pick`, { binCode: 'A-01-1', itemCode: 'CXL-A', quantity: 1 });
    const cancel = (itemId: string, stockItemId: string, quantity: number, cancellationId = newId()) =>
      h.publish('orders', 'orders.item.cancelled', {
        orderId: o.orderId,
        ref: o.ref,
        groupId: o.groupId,
        ownerType: 'official',
        sellerId: null,
        fulfilledBy: 'official_warehouse',
        itemId,
        offerId: newId(),
        stockItemId,
        quantity,
        cancellationId,
        initiatedBy: 'customer',
        reasonCode: 'changed_mind',
        beforeDispatch: true,
        countsAgainstSeller: false,
        refund: { itemAmount: { amount: 0, currency: 'USD' }, discountShare: { amount: 0, currency: 'USD' }, shippingRefund: { amount: 0, currency: 'USD' }, taxRefund: { amount: 0, currency: 'USD' }, total: { amount: 0, currency: 'USD' } },
        paymentIntentId: newId(),
        notifyCustomer: true,
      });
    const partial = newId();
    await cancel(newId(), a.id, 1, partial); // a split part of the line (another order item id), matched by stock item
    await cancel(newId(), a.id, 1, partial); // the same cancellation twice changes nothing
    let f = (await h.call('GET', `/fulfillments/${o.fulfillment.id}`)).body;
    expect(f.lines.find((l: any) => l.sku === 'CXL-A')).toMatchObject({ quantity: 1, picked: 1, state: 'picked' });
    await cancel(o.itemIds[1]!, b.id, 1);
    f = (await h.call('GET', `/fulfillments/${o.fulfillment.id}`)).body;
    expect(f.lines.find((l: any) => l.sku === 'CXL-B').state).toBe('cancelled');
    expect(f.status).toBe('picked');
    await cancel(o.itemIds[0]!, a.id, 1);
    f = (await h.call('GET', `/fulfillments/${o.fulfillment.id}`)).body;
    expect(f.status).toBe('cancelled');
    expect(h.named('warehouse.fulfillment.status_changed').at(-1)).toMatchObject({ fulfillmentId: o.fulfillment.id, from: 'picked', to: 'cancelled' });
    expect((await h.call('GET', `/waves/${o.waveId}`)).body.status).toBe('completed');
  });

  it('a dispatch overdue moves the order to the top of the list', async () => {
    const a = h.item('LATE-A', 'Rug, Wool');
    const o = await h.order([{ item: a, quantity: 1 }], { dispatchInHours: 72 });
    const dueAt = new Date(h.clock.now().getTime() - 3_600_000).toISOString();
    await h.publish('shipping', 'shipping.dispatch.overdue', { orderId: o.orderId, orderRef: o.ref, groupId: o.groupId, ownerType: 'official', sellerId: null, fulfilledBy: 'official_warehouse', orderItemIds: o.itemIds, dueAt, exceptionId: newId() });
    const list = await h.call('GET', '/fulfillments?status=awaiting_pick');
    expect(list.body.items[0]).toMatchObject({ id: o.fulfillment.id, shipBy: dueAt, deadline: { state: 'overdue' } });
  });
});

describe('jobs', () => {
  it('flags orders not packed near ship-by once, with a pick-and-pack work item', async () => {
    const a = h.item('RISK-A', 'Clock, Wall');
    const o = await h.order([{ item: a, quantity: 1 }], { dispatchInHours: 0.5 });
    await h.app.kernel.jobs.runNow('warehouse.flag-at-risk');
    await h.app.kernel.events.drain();
    expect(h.named('warehouse.fulfillment.at_risk').filter((e) => e.fulfillmentId === o.fulfillment.id)).toEqual([{ fulfillmentId: o.fulfillment.id, orderId: o.orderId, shipBy: o.fulfillment.shipBy, status: 'awaiting_pick' }]);
    expect(h.raised.find((r) => r.dedupeKey === `pick_pack:${o.fulfillment.id}`)).toMatchObject({ queueKey: 'warehouse.pick_pack', subject: { type: 'order', id: o.orderId, ref: o.ref } });
    await h.app.kernel.jobs.runNow('warehouse.flag-at-risk');
    await h.app.kernel.events.drain();
    expect(h.named('warehouse.fulfillment.at_risk').filter((e) => e.fulfillmentId === o.fulfillment.id)).toHaveLength(1);
    const today = await h.service.getTodaySummary(h.locationId);
    expect(today.atRisk).toBeGreaterThanOrEqual(1);
    expect(today.urgent.length).toBeGreaterThan(0);
  });

  it('auto-wave does nothing while disabled', async () => {
    const waves = (await h.call('GET', '/waves')).body.items.length;
    await h.app.kernel.jobs.runNow('warehouse.auto-wave');
    expect((await h.call('GET', '/waves')).body.items.length).toBe(waves);
  });
});
