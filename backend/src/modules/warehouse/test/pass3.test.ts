/**
 * Gap pass 3: damage found once every line is picked (picked → on_hold), damage photos attached as
 * inspection evidence, the label format passed to shipping, orders.item.split, GTIN scans and the
 * sourceModule on raised work items.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { harness, type Harness, type StockRec } from './helpers.js';

let h: Harness;
let box: { id: string };
beforeAll(async () => {
  h = await harness();
  await h.bins(['D-01-1', 'D-01-2']);
  box = { id: newId() };
  const r = await h.call('PUT', '/box-types', { boxTypes: [{ id: box.id, name: 'M box', kind: 'box', dimensions: { length: 12, width: 10, height: 6, unit: 'in' }, maxWeight: { value: 20, unit: 'lb' }, active: true }] });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
});
afterAll(async () => {
  await h?.app.close();
});

const idem = () => ({ 'idempotency-key': newId() });

async function stocked(sku: string, label: string, gtin?: string): Promise<StockRec> {
  const item = h.item(sku, label, gtin);
  const bin = (await h.call('GET', `/bins?q=D-01-1&locationId=${h.locationId}`)).body.items[0];
  expect((await h.call('PUT', `/stock-items/${item.id}/bins`, { bins: [{ binId: bin.id, primary: true }] })).status).toBe(200);
  return item;
}

describe('damage found after picking', () => {
  it('a picked order can be held for damage (bug: 409 before packing started); resume goes back to picking and photos are attached', async () => {
    const a = await stocked('P3-VASE', 'Vase, Glass');
    const o = await h.picking([{ item: a, quantity: 2 }]);
    await h.pickAll(o.fulfillment.id);
    expect((await h.call('GET', `/fulfillments/${o.fulfillment.id}`)).body.status).toBe('picked');
    const photo = newId();
    const line = o.fulfillment.lines[0];
    const r = await h.call('POST', `/fulfillments/${o.fulfillment.id}/report-damage`, { lineId: line.id, quantity: 1, note: 'Chipped rim', photoIds: [photo] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ status: 'on_hold' });
    expect(r.body.lines[0]).toMatchObject({ picked: 1, state: 'pending' });
    expect(h.named('warehouse.fulfillment.status_changed').at(-1)).toMatchObject({ from: 'picked', to: 'on_hold' });
    // the photo is inspection evidence of the fulfillment before inventory gets it
    expect(h.attached.find((c) => c[0] === photo)).toEqual([photo, { module: 'warehouse', kind: 'inspection_photo', refId: o.fulfillment.id, refLabel: `Damage on ${o.ref}` }, { kind: 'staff', id: expect.any(String) }]);
    const d = h.discrepancies.at(-1);
    await h.publish('inventory', 'inventory.discrepancy.resolved', { discrepancyId: d.id, resolution: 'reallocated', orderId: o.orderId });
    // lines already picked stay picked: only the replacement unit is picked again
    const back = (await h.call('GET', `/fulfillments/${o.fulfillment.id}`)).body;
    expect(back).toMatchObject({ status: 'picking' });
    expect(back.lines[0]).toMatchObject({ picked: 1 });
    expect((await h.pickAll(o.fulfillment.id)).status).toBe('picked');
  });
});

describe('labels', () => {
  it('passes the requested format to shipping.createLabel (default pdf)', async () => {
    for (const format of ['zpl', undefined] as const) {
      const a = await stocked(`P3-LBL-${format ?? 'x'}`, 'Lamp, Brass');
      const o = await h.picking([{ item: a, quantity: 1 }]);
      await h.pickAll(o.fulfillment.id);
      const pkg = (await h.call('POST', `/fulfillments/${o.fulfillment.id}/packages`, {})).body;
      await h.call('POST', `/packages/${pkg.id}/scan`, { code: a.sku });
      await h.call('PATCH', `/packages/${pkg.id}`, { boxTypeId: box.id, weight: { value: 2, unit: 'lb' } });
      const label = await h.call('POST', `/packages/${pkg.id}/label`, format ? { format } : {}, { headers: idem() });
      expect(label.status, JSON.stringify(label.body)).toBe(200);
      expect(h.labels.at(-1)!.input.format).toBe(format ?? 'pdf');
      expect(label.body.format).toBe(format ?? 'pdf');
    }
  });
});

describe('GTIN scans', () => {
  it('pick, pack and the scan lookup accept the variant GTIN as well as the SKU label', async () => {
    const a = await stocked('P3-GTIN', 'Speaker, Teal', '0012345678905');
    const o = await h.picking([{ item: a, quantity: 2 }]);
    const line = o.fulfillment.lines[0];
    const pick = await h.call('POST', `/pick-lines/${line.id}/pick`, { binCode: line.binCode, itemCode: '0012345678905', quantity: 1 });
    expect(pick.status, JSON.stringify(pick.body)).toBe(200);
    expect((await h.call('POST', `/pick-lines/${line.id}/pick`, { binCode: line.binCode, itemCode: '9999999999999', quantity: 1 })).body.error.code).toBe('SCAN_MISMATCH');
    const look = await h.call('GET', `/scan?code=0012345678905&context=pick&contextId=${o.fulfillment.id}`);
    expect(look.body).toMatchObject({ kind: 'item', stockItemId: a.id, sku: 'P3-GTIN' });
    await h.pickAll(o.fulfillment.id);
    const pkg = (await h.call('POST', `/fulfillments/${o.fulfillment.id}/packages`, {})).body;
    expect((await h.call('POST', `/packages/${pkg.id}/scan`, { code: '0012345678905' })).body.items[0]).toMatchObject({ scanned: 1 });
  });
});

describe('orders.item.split', () => {
  it('splits the line (picked units stay on the original), idempotent per newItemId; a later cancel of the new item finds its line', async () => {
    const a = await stocked('P3-SPLIT', 'Mug, Blue');
    const o = await h.picking([{ item: a, quantity: 3 }]);
    const line = o.fulfillment.lines[0];
    await h.call('POST', `/pick-lines/${line.id}/pick`, { binCode: line.binCode, itemCode: a.sku, quantity: 1 });
    const newItemId = newId();
    const split = { orderId: o.orderId, groupId: o.groupId, itemId: o.itemIds[0], newItemId, rootItemId: o.itemIds[0], offerId: newId(), stockItemId: a.id, quantity: 2, remainingQuantity: 1, reason: 'cancellation', at: new Date().toISOString() };
    await h.publish('orders', 'orders.item.split', split);
    await h.publish('orders', 'orders.item.split', split);
    const f = (await h.call('GET', `/fulfillments/${o.fulfillment.id}`)).body;
    expect(f.lines).toHaveLength(2);
    expect(f.lines.find((l: any) => l.orderItemId === o.itemIds[0])).toMatchObject({ quantity: 1, picked: 1, state: 'picked' });
    expect(f.lines.find((l: any) => l.orderItemId === newItemId)).toMatchObject({ quantity: 2, picked: 0, state: 'pending', sku: 'P3-SPLIT' });

    const zero = { amount: 0, currency: 'USD' };
    await h.publish('orders', 'orders.item.cancelled', { orderId: o.orderId, ref: o.ref, groupId: o.groupId, ownerType: 'official', sellerId: null, fulfilledBy: 'official_warehouse', itemId: newItemId, offerId: newId(), stockItemId: a.id, quantity: 2, cancellationId: newId(), initiatedBy: 'customer', reasonCode: 'changed_mind', beforeDispatch: true, countsAgainstSeller: false, refund: { itemAmount: zero, discountShare: zero, shippingRefund: zero, taxRefund: zero, total: zero }, paymentIntentId: newId(), notifyCustomer: true });
    const after = (await h.call('GET', `/fulfillments/${o.fulfillment.id}`)).body;
    expect(after.lines.find((l: any) => l.orderItemId === newItemId)).toMatchObject({ state: 'cancelled' });
    expect(after.lines.find((l: any) => l.orderItemId === o.itemIds[0])).toMatchObject({ quantity: 1, state: 'picked' });
    expect(after.status).toBe('picked');
    // a split for another group or an unknown item changes nothing
    await h.publish('orders', 'orders.item.split', { ...split, groupId: newId(), newItemId: newId() });
    await h.publish('orders', 'orders.item.split', { ...split, itemId: newId(), newItemId: newId() });
    expect((await h.call('GET', `/fulfillments/${o.fulfillment.id}`)).body.lines).toHaveLength(2);
  });
});

describe('work items', () => {
  it('raised items name warehouse as their source module', async () => {
    const a = await stocked('P3-RISK', 'Clock, Oak');
    await h.order([{ item: a, quantity: 1 }], { dispatchInHours: 1 });
    await h.app.kernel.jobs.runNow('warehouse.flag-at-risk');
    expect(h.raised.filter((r) => r.kind === 'pick_pack').at(-1)).toMatchObject({ sourceModule: 'warehouse', queueKey: 'warehouse.pick_pack' });
  });
});
