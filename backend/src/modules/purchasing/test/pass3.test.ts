/**
 * Gap pass 3: drafts from suggestions ship to a chosen company warehouse or inventory's default one
 * (bug: copied the last PO's location and failed on a fresh install), purchasing.purchase_order.sent
 * carries shipTo, avgDailySales comes from inventory.getSalesRate, and PO attachments are attached in
 * media as supplier documents (bug: never attached, so the orphan sweep deleted them).
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { api, INACTIVE_LOCATION, LOCATION, makeStubs, OTHER_LOCATION, purchasingApp, recordEvents, SELLER_LOCATION, usd } from './helpers.js';

const stubs = makeStubs();
let app: FastifyInstance;
let call: ReturnType<typeof api>;
let events: Record<string, any[]>;
const lamp = stubs.addStock({ sku: 'BRT-LAMP', label: 'Brightline desk lamp', available: 2, threshold: 8 });
const kettle = stubs.addStock({ sku: 'KET-1', label: 'Kettle', available: 1, threshold: 5 });

beforeAll(async () => {
  ({ app } = await purchasingApp(stubs));
  call = api(app);
  events = recordEvents(app, ['purchasing.purchase_order.sent']);
});
afterAll(async () => {
  await app?.close();
});

async function supplierWith(items: string[]) {
  const s = (await call('POST', '/suppliers', { name: `Brightline ${newId().slice(-4)}`, email: 'orders@brightline.example', leadTimeDays: 4 })).json();
  const put = await call('PUT', `/suppliers/${s.id}/items`, { items: items.map((stockItemId) => ({ stockItemId, unitCost: usd(2800), minOrderQuantity: 1, preferred: true })) });
  expect(put.statusCode, put.body).toBe(200);
  return s;
}

describe('drafts from suggestions: ship-to location', () => {
  it('works before any purchase order exists: the default company location; a chosen warehouse otherwise', async () => {
    await supplierWith([lamp, kettle]);
    // fresh install: no purchase order yet (before pass 3: VALIDATION_FAILED "create the first purchase order by hand")
    const first = await call('POST', '/purchase-orders/from-suggestions', { stockItemIds: [lamp] });
    expect(first.statusCode, first.body).toBe(201);
    expect(first.json()[0].shipToLocationId).toBe(LOCATION);
    expect(stubs.inventory.getDefaultLocation).toHaveBeenCalled();

    const chosen = await call('POST', '/purchase-orders/from-suggestions', { stockItemIds: [kettle], shipToLocationId: OTHER_LOCATION });
    expect(chosen.statusCode, chosen.body).toBe(201);
    expect(chosen.json()[0].shipToLocationId).toBe(OTHER_LOCATION);
    // never copied from the last PO: the next draft without a location goes to the default again
    const again = await call('POST', '/purchase-orders/from-suggestions', { stockItemIds: [kettle] });
    expect(again.json()[0].shipToLocationId).toBe(LOCATION);
  });

  it('refuses unknown, inactive and non-warehouse locations, and an install without a default location', async () => {
    for (const loc of [newId(), INACTIVE_LOCATION, SELLER_LOCATION]) {
      const res = await call('POST', '/purchase-orders/from-suggestions', { stockItemIds: [lamp], shipToLocationId: loc });
      expect(res.statusCode, `${loc}: ${res.body}`).toBe(400);
      expect(res.json().error).toMatchObject({ code: 'VALIDATION_FAILED', details: { issues: [{ path: 'shipToLocationId' }] } });
    }
    stubs.locations.defaultId = null;
    try {
      const res = await call('POST', '/purchase-orders/from-suggestions', { stockItemIds: [lamp] });
      expect(res.json().error.code).toBe('VALIDATION_FAILED');
    } finally {
      stubs.locations.defaultId = LOCATION;
    }
  });
});

describe('sending', () => {
  it('purchasing.purchase_order.sent names and addresses the warehouse (shipTo from inventory.getLocations)', async () => {
    const s = await supplierWith([lamp]);
    const po = (await call('POST', '/purchase-orders', { supplierId: s.id, shipToLocationId: OTHER_LOCATION, lines: [{ stockItemId: lamp, quantity: 10, unitCost: usd(2800) }] })).json();
    const sent = await call('POST', `/purchase-orders/${po.id}/send`, { emailSupplier: true });
    expect(sent.statusCode, sent.body).toBe(200);
    await app.kernel.events.drain();
    expect(events['purchasing.purchase_order.sent']!.find((e) => e.purchaseOrderId === po.id)).toMatchObject({
      locationId: OTHER_LOCATION,
      shipTo: { locationId: OTHER_LOCATION, code: 'SPK1', name: 'Sparks, NV overflow', address: { line1: '7 Spur Way', city: 'Sparks' }, timeZone: 'America/Los_Angeles' },
    });
  });
});

describe('reorder suggestions: sales velocity', () => {
  it('avgDailySales comes from inventory.getSalesRate over 30 days and raises the suggested quantity', async () => {
    const fan = stubs.addStock({ sku: 'FAN-1', label: 'Desk fan', available: 3, threshold: 6 });
    const s = await supplierWith([fan]);
    const before = (await call('GET', `/reorder-suggestions?supplierId=${s.id}`)).json().items[0];
    expect(before).toMatchObject({ stockItemId: fan, avgDailySales: null });
    stubs.sales.set(fan, 2.5);
    const after = (await call('GET', `/reorder-suggestions?supplierId=${s.id}`)).json().items[0];
    expect(after.avgDailySales).toBe(2.5);
    expect(after.suggestedQuantity).toBeGreaterThan(before.suggestedQuantity);
    expect(stubs.inventory.getSalesRate).toHaveBeenCalledWith(expect.arrayContaining([fan]), 30);
  });
});

describe('attachments are supplier documents in media', () => {
  it('attached on create and update, detached when removed', async () => {
    const s = await supplierWith([lamp]);
    const [a, b, c] = [newId(), newId(), newId()];
    const po = (await call('POST', '/purchase-orders', { supplierId: s.id, shipToLocationId: LOCATION, lines: [{ stockItemId: lamp, quantity: 5, unitCost: usd(2800) }], attachmentIds: [a, b] })).json();
    const attached = () => stubs.media.attach.mock.calls.map((x) => x as unknown as [string, { kind: string; refId: string }]).filter(([, u]) => u.refId === po.id);
    expect(attached().map(([id, u]) => [id, u.kind])).toEqual([
      [a, 'supplier_document'],
      [b, 'supplier_document'],
    ]);
    const upd = await call('PATCH', `/purchase-orders/${po.id}`, { attachmentIds: [b, c] });
    expect(upd.statusCode, upd.body).toBe(200);
    expect(attached().map(([id]) => id)).toEqual([a, b, c]);
    const detached = stubs.media.detach.mock.calls.map((x) => x as unknown as [string, { kind: string; refId: string }]).filter(([, u]) => u.refId === po.id);
    expect(detached).toEqual([[a, { module: 'purchasing', kind: 'supplier_document', refId: po.id }]]);
  });
});
