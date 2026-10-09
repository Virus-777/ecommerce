import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { auth, callers } from '../../../testing/app.js';
import type * as returns from '../../../spec/returns.js';
import { harness, USD, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h?.app.close();
});

describe('bins', () => {
  it('creates bins with zones and barcodes, refuses taken codes, and audits', async () => {
    const r = await h.call('POST', '/bins', { locationId: h.locationId, codes: ['d-03-2', 'D-10-1'], kind: 'pick' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toEqual([
      expect.objectContaining({ locationId: h.locationId, code: 'D-03-2', zone: 'D', kind: 'pick', active: true, assignedItems: 0, barcode: expect.stringMatching(/^BIN-.*-D-03-2$/) }),
      expect.objectContaining({ code: 'D-10-1', zone: 'D' }),
    ]);
    expect(h.audits.at(-1)).toMatchObject({ action: 'warehouse.bins.create', category: 'other', after: { codes: ['D-03-2', 'D-10-1'] } });
    const taken = await h.call('POST', '/bins', { locationId: h.locationId, codes: ['D-03-2', 'D-04-1'], kind: 'bulk' });
    expect(taken.status).toBe(409);
    expect(taken.body.error).toMatchObject({ code: 'BIN_CODE_TAKEN', details: { codes: ['D-03-2'] } });
    // the same code at another site is fine
    expect((await h.call('POST', '/bins', { locationId: newId(), codes: ['D-03-2'], kind: 'pick' })).status).toBe(201);
    expect((await h.call('POST', '/bins', { locationId: h.locationId, codes: ['D 1', 'D 1'], kind: 'pick' })).status).toBe(400);
    const list = await h.call('GET', `/bins?locationId=${h.locationId}&zone=d`);
    expect(list.body.items.map((b: any) => b.code)).toEqual(['D-03-2', 'D-10-1']);
    expect((await h.call('GET', '/bins', undefined, { token: callers.customer() })).status).toBe(403);
    expect((await h.call('POST', '/bins', { locationId: h.locationId, codes: ['X-1'], kind: 'pick' }, { token: callers.staff(['warehouse.view']) })).status).toBe(403);
  });

  it('assigns bins to a stock item (one primary), tells inventory, and keeps assigned bins active', async () => {
    const bins = await h.bins(['E-01-1', 'E-01-2', 'E-QA-1']);
    await h.call('PATCH', `/bins/${bins['E-QA-1'].id}`, { kind: 'quarantine' });
    const item = h.item('BIN-ITEM-1', 'Speaker, Walnut');
    expect((await h.call('PUT', `/stock-items/${newId()}/bins`, { bins: [{ binId: bins['E-01-1'].id, primary: true }] })).status).toBe(404);
    const two = await h.call('PUT', `/stock-items/${item.id}/bins`, { bins: [{ binId: bins['E-01-1'].id, primary: true }, { binId: bins['E-01-2'].id, primary: true }] });
    expect(two.status).toBe(400);
    expect((await h.call('PUT', `/stock-items/${item.id}/bins`, { bins: [{ binId: bins['E-QA-1'].id, primary: true }] })).status).toBe(400);
    const before = h.events.length;
    const r = await h.call('PUT', `/stock-items/${item.id}/bins`, { bins: [{ binId: bins['E-01-2'].id, primary: false }, { binId: bins['E-01-1'].id, primary: true }] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toEqual([
      { stockItemId: item.id, sku: 'BIN-ITEM-1', label: 'Speaker, Walnut', binId: bins['E-01-1'].id, binCode: 'E-01-1', primary: true },
      { stockItemId: item.id, sku: 'BIN-ITEM-1', label: 'Speaker, Walnut', binId: bins['E-01-2'].id, binCode: 'E-01-2', primary: false },
    ]);
    expect(h.events.slice(before).filter((e) => e.name === 'warehouse.bin.assigned').map((e) => e.payload)).toEqual([
      { stockItemId: item.id, binId: bins['E-01-2'].id, binCode: 'E-01-2', primary: false },
      { stockItemId: item.id, binId: bins['E-01-1'].id, binCode: 'E-01-1', primary: true },
    ]);
    expect(h.audits.at(-1)).toMatchObject({ action: 'warehouse.bins.assign', target: { type: 'stock_item', id: item.id, ref: 'BIN-ITEM-1' } });
    const busy = await h.call('PATCH', `/bins/${bins['E-01-1'].id}`, { active: false });
    expect(busy.status).toBe(409);
    expect(busy.body.error.code).toBe('BIN_NOT_EMPTY');
    expect((await h.call('PATCH', `/bins/${bins['E-01-1'].id}`, { kind: 'bulk' })).body).toMatchObject({ kind: 'bulk', assignedItems: 1 });
    expect(h.audits.at(-1)).toMatchObject({ action: 'warehouse.bins.update', before: { kind: 'pick' }, after: { kind: 'bulk' } });
    // suggestions: the primary bin, else a free bin in the item's zone
    expect((await h.service.suggestBin(item.id, h.locationId))?.code).toBe('E-01-1');
    const other = h.item('BIN-ITEM-2', 'Speaker, Oak');
    expect((await h.service.suggestBin(other.id, h.locationId))?.code).toMatch(/^D-|^E-/);
    expect(await h.service.suggestBin(other.id, newId())).toBeNull();
  });

  it('replaces box types and retires the ones left out', async () => {
    const keep = newId();
    const drop = newId();
    await h.call('PUT', '/box-types', { boxTypes: [{ id: keep, name: 'S box', kind: 'box', dimensions: { length: 8, width: 6, height: 4, unit: 'in' }, active: true }, { id: drop, name: 'L box', kind: 'box', dimensions: { length: 20, width: 16, height: 12, unit: 'in' }, active: true }] });
    const r = await h.call('PUT', '/box-types', { boxTypes: [{ id: keep, name: 'S box', kind: 'box', dimensions: { length: 8, width: 6, height: 5, unit: 'in' }, maxWeight: { value: 10, unit: 'lb' }, active: true }] });
    expect(r.status).toBe(200);
    expect(r.body).toEqual([{ id: keep, name: 'S box', kind: 'box', dimensions: { length: 8, width: 6, height: 5, unit: 'in' }, maxWeight: { value: 10, unit: 'lb' }, active: true }]);
    expect((await h.call('GET', '/box-types')).body.map((b: any) => b.id)).toEqual([keep]);
    expect(h.audits.at(-1)).toMatchObject({ action: 'warehouse.box_types.replace', category: 'settings' });
    expect((await h.call('PUT', '/box-types', { boxTypes: [{ id: newId(), name: '', kind: 'box', dimensions: { length: 0, width: 1, height: 1, unit: 'in' }, active: true }] })).status).toBe(400);
    expect((await h.call('PUT', '/box-types', { boxTypes: [] }, { token: callers.staff(['warehouse.view', 'warehouse.packing.perform']) })).status).toBe(403);
  });
});

describe('put-away', () => {
  it('creates tasks from a purchasing receipt (damaged units to quarantine), labels them and confirms by bin scan', async () => {
    const bins = await h.bins(['F-01-1', 'F-02-1', 'F-QA-1']);
    await h.call('PATCH', `/bins/${bins['F-QA-1'].id}`, { kind: 'quarantine' });
    const item = h.item('PUT-1', 'Blender, Silver');
    await h.call('PUT', `/stock-items/${item.id}/bins`, { bins: [{ binId: bins['F-01-1'].id, primary: true }] });
    const receiptId = newId();
    const line = { purchaseOrderLineId: newId(), stockItemId: item.id, sku: 'PUT-1', label: 'Blender, Silver', expected: 10, received: 10, damaged: 2, shortage: 0, over: 0, binCode: null, photos: [], note: null };
    const event = { receiptId, ref: 'RCV-261009-0001', purchaseOrderId: newId(), locationId: h.locationId, lines: [line], hasIssues: true };
    await h.publish('purchasing', 'purchasing.receipt.recorded', event);
    await h.publish('purchasing', 'purchasing.receipt.recorded', event);
    const tasks = (await h.call('GET', `/putaway-tasks?receiptId=${receiptId}`)).body.items;
    expect(tasks).toHaveLength(2);
    const sellable = tasks.find((t: any) => t.quantity === 8);
    const damaged = tasks.find((t: any) => t.quantity === 2);
    expect(sellable).toMatchObject({ receiptRef: 'RCV-261009-0001', sku: 'PUT-1', label: 'Blender, Silver', suggestedBinCode: 'F-01-1', status: 'open', binCode: null });
    expect(damaged.suggestedBinCode).toBe('F-QA-1');
    const labels = await h.call('GET', `/putaway-tasks/labels?receiptId=${receiptId}&perUnit=true&format=zpl`);
    expect(labels.status, JSON.stringify(labels.body)).toBe(200);
    expect(labels.body.fileName).toBe('putaway-RCV-261009-0001.zpl');
    expect(h.files.at(-1)!.text.match(/\^XA/g)).toHaveLength(10);
    expect(h.files.at(-1)!.text).toContain('^FDPUT-1^FS');
    expect((await h.call('GET', `/putaway-tasks/labels?receiptId=${receiptId}&taskIds=${sellable.id}`)).body.fileName).toBe('putaway-RCV-261009-0001.pdf');
    expect((await h.call('GET', `/putaway-tasks/labels?receiptId=${newId()}`)).status).toBe(404);
    // damaged units only into quarantine; sellable ones not into quarantine
    expect((await h.call('POST', `/putaway-tasks/${damaged.id}/complete`, { binCode: 'F-02-1', quantity: 2 })).body.error.code).toBe('SCAN_MISMATCH');
    expect((await h.call('POST', `/putaway-tasks/${sellable.id}/complete`, { binCode: 'F-QA-1', quantity: 8 })).body.error.code).toBe('SCAN_MISMATCH');
    expect((await h.call('POST', `/putaway-tasks/${sellable.id}/complete`, { binCode: 'NOPE', quantity: 8 })).body.error).toMatchObject({ code: 'SCAN_MISMATCH', details: { expected: 'F-01-1', scanned: 'NOPE' } });
    // 5 into a second bin: the task splits, the bin is added to the item (not primary)
    const before = h.events.length;
    const part = await h.call('POST', `/putaway-tasks/${sellable.id}/complete`, { binCode: 'F-02-1', quantity: 5 });
    expect(part.status, JSON.stringify(part.body)).toBe(200);
    expect(part.body).toMatchObject({ status: 'done', quantity: 5, binCode: 'F-02-1', doneBy: expect.objectContaining({ kind: 'staff' }) });
    expect(h.events.slice(before).map((e) => e.payload)).toEqual([{ stockItemId: item.id, binId: bins['F-02-1'].id, binCode: 'F-02-1', primary: false }]);
    expect((await h.call('POST', `/putaway-tasks/${sellable.id}/complete`, { binCode: 'F-02-1', quantity: 1 })).body.error.code).toBe('ILLEGAL_TRANSITION');
    const open = (await h.call('GET', `/putaway-tasks?receiptId=${receiptId}&status=open`)).body.items;
    const rest = open.find((t: any) => t.quantity === 3);
    expect((await h.call('POST', `/putaway-tasks/${rest.id}/complete`, { binCode: bins['F-01-1'].barcode, quantity: 3 })).body).toMatchObject({ status: 'done', binCode: 'F-01-1' });
    expect(h.named('warehouse.bin.assigned').at(-1)).toMatchObject({ binCode: 'F-01-1', primary: true });
    expect((await h.call('POST', `/putaway-tasks/${damaged.id}/complete`, { binCode: 'F-QA-1', quantity: 2 })).status).toBe(200);
    expect((await h.call('GET', '/summary')).body.putawayOpen).toBe(0);
  });
});

describe('return parcels', () => {
  const detail = (id: string, ref: string): returns.ReturnDetail =>
    ({
      id,
      ref,
      orderId: newId(),
      orderRef: 'MK-261001-11111',
      seller: { ownerType: 'official', id: null, name: 'Marketly Official Store' },
      status: 'in_transit',
      items: [{ orderItemId: newId(), productId: newId(), variantId: newId(), title: 'Halden Aurora ANC Headphones', options: { Color: 'Black' }, quantity: 1, unitPrice: USD(18900) }],
      shipment: { trackingNumber: '9400100000000000000001' },
    }) as unknown as returns.ReturnDetail;

  it('expects approved Official Store returns, receives by reference through returns and hands over to inspection', async () => {
    const returnId = newId();
    h.returns.set(returnId, detail(returnId, 'RT-261005-0212'));
    await h.publish('returns', 'returns.return.approved', { returnId, ownerType: 'official', sellerId: null, withoutReturn: false, platformDecision: false, dropOffBy: new Date(h.clock.now().getTime() + 7 * 86_400_000).toISOString() });
    await h.publish('returns', 'returns.return.approved', { returnId, ownerType: 'official', sellerId: null, withoutReturn: false, platformDecision: false, dropOffBy: null });
    await h.publish('returns', 'returns.return.approved', { returnId: newId(), ownerType: 'seller', sellerId: newId(), withoutReturn: false, platformDecision: false, dropOffBy: null });
    const expected = (await h.call('GET', '/return-parcels?status=expected')).body.items;
    expect(expected).toEqual([expect.objectContaining({ returnId, status: 'expected', unexpected: false, expectedBy: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) })]);
    expect((await h.call('GET', '/summary')).body.returnParcelsExpected).toBe(1);
    const scan = await h.call('GET', '/scan?code=rt-261005-0212&context=returns');
    expect(scan.body).toMatchObject({ kind: 'return_label' });
    const photo = newId();
    const r = await h.call('POST', '/return-parcels', { code: 'rt-261005-0212', parcelCondition: 'intact', photoIds: [photo], note: 'Box dented' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ id: expected[0].id, returnId, returnRef: 'RT-261005-0212', orderRef: 'MK-261001-11111', trackingNumber: '9400100000000000000001', status: 'received', unexpected: false, parcelCondition: 'intact', expectedItems: ['Halden Aurora ANC Headphones, Black × 1'], photos: [{ id: photo, url: `https://media.test/${photo}.jpg` }], note: 'Box dented', receivedBy: expect.objectContaining({ kind: 'staff' }) });
    expect(h.receipts).toEqual([{ returnId, trackingNumber: null }]);
    expect(h.named('warehouse.return_parcel.received').at(-1)).toEqual({ parcelId: r.body.id, returnId, unexpected: false, parcelCondition: 'intact', receivedAt: r.body.receivedAt });
    const twice = await h.call('POST', '/return-parcels', { code: '9400100000000000000001', parcelCondition: 'intact' });
    expect(twice.status).toBe(409);
    expect(twice.body.error).toMatchObject({ code: 'PARCEL_ALREADY_RECEIVED', details: { parcelId: r.body.id } });
    const inspector = newId();
    const handed = await h.call('POST', `/return-parcels/${r.body.id}/hand-over`, { inspectorId: inspector, note: 'Bench 2' });
    expect(handed.body).toMatchObject({ status: 'handed_over', handedOverTo: { kind: 'staff', id: inspector }, note: 'Box dented\nBench 2' });
    expect(h.named('warehouse.return_parcel.handed_over').at(-1)).toEqual({ parcelId: r.body.id, returnId, inspectorId: inspector });
    expect((await h.call('POST', `/return-parcels/${r.body.id}/hand-over`, {})).body.error.code).toBe('ILLEGAL_TRANSITION');
    expect((await h.call('GET', '/return-parcels?q=261005')).body.items.map((p: any) => p.id)).toEqual([r.body.id]);
  });

  it('records a parcel with no approved return as unexpected and tells support', async () => {
    const r = await h.call('POST', '/return-parcels', { code: '1Z999AA10123456784', parcelCondition: 'opened' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: 'received', unexpected: true, returnId: null, trackingNumber: '1Z999AA10123456784', parcelCondition: 'opened' });
    expect(h.raised.at(-1)).toMatchObject({ queueKey: 'returns.decisions', kind: 'unexpected_return_parcel', priority: 'high', dedupeKey: `return_parcel:${r.body.id}` });
    expect(h.named('warehouse.return_parcel.received').at(-1)).toMatchObject({ parcelId: r.body.id, returnId: null, unexpected: true });
    expect((await h.call('POST', '/return-parcels', { code: ' ', parcelCondition: 'intact' })).status).toBe(400);
  });

  it('flags expected parcels past their date for follow-up', async () => {
    const returnId = newId();
    await h.publish('returns', 'returns.return.approved', { returnId, ownerType: 'official', sellerId: null, withoutReturn: false, platformDecision: false, dropOffBy: null });
    h.clock.advance(30 * 86_400_000);
    try {
      await h.app.kernel.jobs.runNow('warehouse.overdue-return-parcels');
      expect(h.raised.at(-1)).toMatchObject({ queueKey: 'returns.decisions', kind: 'return_parcel_overdue', subject: { type: 'return', id: returnId } });
    } finally {
      h.clock.advance(-30 * 86_400_000);
    }
  });
});

describe('scans, summary and GraphQL', () => {
  it('resolves bins, items, orders and packages, checked against the pick list', async () => {
    const bins = await h.bins(['G-01-1', 'G-01-2']);
    const item = h.item('SCN-1', 'Tray, Bamboo');
    const stranger = h.item('SCN-2', 'Bowl, Bamboo');
    await h.call('PUT', `/stock-items/${item.id}/bins`, { bins: [{ binId: bins['G-01-1'].id, primary: true }] });
    const o = await h.picking([{ item, quantity: 1 }]);
    const f = o.fulfillment;
    expect((await h.call('GET', `/scan?code=${bins['G-01-1'].barcode}`)).body).toMatchObject({ kind: 'bin', bin: { code: 'G-01-1' }, message: null });
    expect((await h.call('GET', `/scan?code=G-01-2&context=pick&contextId=${f.id}`)).body).toMatchObject({ kind: 'bin', message: 'Not on this pick list: go to G-01-1' });
    expect((await h.call('GET', `/scan?code=scn-1&context=pick&contextId=${f.id}`)).body).toMatchObject({ kind: 'item', stockItemId: item.id, sku: 'SCN-1', fulfillmentId: f.id, message: null });
    expect((await h.call('GET', `/scan?code=SCN-2&context=pick&contextId=${o.waveId}`)).body).toMatchObject({ kind: 'item', stockItemId: stranger.id, message: 'Not on this pick list' });
    expect((await h.call('GET', `/scan?code=${o.ref}`)).body).toMatchObject({ kind: 'order', fulfillmentId: f.id });
    expect((await h.call('GET', '/scan?code=WHAT-IS-THIS')).body).toMatchObject({ kind: 'unknown', message: 'Unknown code' });
  });

  it('summarises today and answers warehouseToday in GraphQL', async () => {
    const item = h.item('SUM-1', 'Candle, Fig');
    await h.order([{ item, quantity: 1 }], { dispatchInHours: 0.25 });
    const s = await h.call('GET', `/summary?locationId=${h.locationId}`);
    expect(s.status).toBe(200);
    expect(s.body).toMatchObject({ locationId: h.locationId, toPick: expect.any(Number), atRisk: expect.any(Number), shipToday: expect.any(Number) });
    expect(s.body.toPick).toBeGreaterThanOrEqual(1);
    expect(s.body).not.toHaveProperty('urgent');
    const query = `{ warehouseToday { locationId date toPick toShip late atRisk pickupsToday shipByCutoff urgentTasks(limit: 2) { orderRef status deadline { state } lines { sku state binCode } } } }`;
    const res = await h.app.inject({ method: 'POST', url: '/graphql/admin', headers: auth(h.staff), payload: { query } });
    const body = JSON.parse(res.body);
    expect(body.errors).toBeUndefined();
    expect(body.data.warehouseToday).toMatchObject({ locationId: h.locationId, toPick: s.body.toPick, date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
    expect(body.data.warehouseToday.urgentTasks.length).toBeLessThanOrEqual(2);
    expect(body.data.warehouseToday.urgentTasks[0]).toMatchObject({ status: expect.stringMatching(/^[A-Z_]+$/), deadline: { state: expect.stringMatching(/^(ON_TIME|DUE_SOON|OVERDUE)$/) } });
    const denied = await h.app.inject({ method: 'POST', url: '/graphql/admin', headers: auth(callers.staff(['orders.view'])), payload: { query: '{ warehouseToday { toPick } }' } });
    expect(JSON.parse(denied.body).errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
  });
});
