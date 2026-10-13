/**
 * Gap pass 4: supplier_claims.supplier_reference (instead of a notes line), suppliers.return_authorization_required
 * (getPreferredSupplier answers it), and the delivery going back to Arrived when its only receiving record is
 * discarded.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { spec, type PurchasingPublicApi } from '../../../spec/purchasing.js';
import { schemas } from '../schema.js';
import { api, LOCATION, makeStubs, purchasingApp, usd } from './helpers.js';

const stubs = makeStubs();
let app: FastifyInstance;
let call: ReturnType<typeof api>;
const purchasing = () => app.kernel.boot.apis.get('purchasing') as PurchasingPublicApi;
const lamp = stubs.addStock({ sku: 'BRT-LAMP-4', label: 'Brightline desk lamp', available: 2, threshold: 8 });

beforeAll(async () => {
  ({ app } = await purchasingApp(stubs));
  call = api(app);
});
afterAll(async () => {
  await app?.close();
});

async function sentOrder(supplier?: { returnAuthorizationRequired?: boolean }) {
  const s = (await call('POST', '/suppliers', { name: `Brightline ${newId().slice(-4)}`, email: 'ops@brightline.example', leadTimeDays: 5, ...supplier })).json();
  const po = (await call('POST', '/purchase-orders', { supplierId: s.id, shipToLocationId: LOCATION, lines: [{ stockItemId: lamp, quantity: 10, unitCost: usd(2800) }], expectedDate: '2026-10-09' })).json();
  expect((await call('POST', `/purchase-orders/${po.id}/send`, {})).statusCode).toBe(200);
  return { supplier: s, po };
}

describe('suppliers.return_authorization_required', () => {
  it('is set on the supplier and answered by getPreferredSupplier', async () => {
    const created = (await call('POST', '/suppliers', { name: `Halden ${newId().slice(-4)}`, returnAuthorizationRequired: true })).json();
    expect(created.returnAuthorizationRequired).toBe(true);
    expect((await call('PUT', `/suppliers/${created.id}/items`, { items: [{ stockItemId: lamp, unitCost: usd(2500), preferred: true }] })).statusCode).toBe(200);
    expect(await purchasing().getPreferredSupplier(lamp)).toMatchObject({ supplierId: created.id, returnAuthorizationRequired: true });
    const edited = await call('PATCH', `/suppliers/${created.id}`, { name: created.name, returnAuthorizationRequired: false });
    expect(edited.json().returnAuthorizationRequired).toBe(false);
    expect((await call('POST', '/suppliers', { name: `Plain ${newId().slice(-4)}` })).json().returnAuthorizationRequired).toBe(false);
  });
});

describe('delivery reopen', () => {
  it('discarding the only receiving record puts the delivery back to Arrived', async () => {
    const { po } = await sentOrder();
    const d = await call('POST', `/purchase-orders/${po.id}/deliveries`, { carrier: 'Freight', windowFrom: '2026-10-09T17:00:00Z', windowTo: '2026-10-09T19:00:00Z' });
    await call('POST', `/deliveries/${d.json().id}/arrive`, { dock: '1' });
    const receipt = (await call('POST', `/deliveries/${d.json().id}/receipts`)).json();
    const deliveryOf = async () => (await call('GET', `/purchase-orders/${po.id}`)).json().deliveries.find((x: { id: string }) => x.id === d.json().id);
    expect((await deliveryOf()).status).toBe('receiving');
    expect((await call('POST', `/receipts/${receipt.id}/cancel`, { reason: 'Wrong pallet' })).statusCode).toBe(200);
    expect((await deliveryOf()).status).toBe('arrived');
    expect((await call('POST', `/deliveries/${d.json().id}/receipts`)).statusCode).toBe(201);
    expect((await deliveryOf()).status).toBe('receiving');
  });
});

describe('supplier_claims.supplier_reference', () => {
  it('is kept in its own column', async () => {
    const { po } = await sentOrder();
    const c = (await call('POST', '/claims', { purchaseOrderId: po.id, kind: 'damage', lines: [{ stockItemId: lamp, sku: 'BRT-LAMP-4', quantity: 1, unitCost: usd(2800) }], notes: 'Cracked shade' })).json();
    const sent = (await call('POST', `/claims/${c.id}/submit`, { supplierReference: 'RMA-77' })).json();
    expect(sent).toMatchObject({ supplierReference: 'RMA-77', notes: 'Cracked shade' });
    const row = await app.kernel.mongo.module('purchasing', spec.collections, schemas).table<any>('supplier_claims').get(c.id);
    expect(row).toMatchObject({ supplier_reference: 'RMA-77', notes: 'Cracked shade' });
  });
});
