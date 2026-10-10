/**
 * Gap pass 4: supplier_claims.supplier_reference (instead of a notes line), suppliers.return_authorization_required
 * (getPreferredSupplier answers it), the delivery going back to Arrived when its only receiving record is discarded,
 * and migration 0002 backfilling the reference from the notes.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import type { PurchasingPublicApi } from '../../../spec/purchasing.js';
import { m0002Pass4Columns } from '../infra/postgres/migrations/0002_pass4_columns.js';
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
  it('is kept in its own column; migration 0002 moves old notes lines into it', async () => {
    const { po } = await sentOrder();
    const c = (await call('POST', '/claims', { purchaseOrderId: po.id, kind: 'damage', lines: [{ stockItemId: lamp, sku: 'BRT-LAMP-4', quantity: 1, unitCost: usd(2800) }], notes: 'Cracked shade' })).json();
    const sent = (await call('POST', `/claims/${c.id}/submit`, { supplierReference: 'RMA-77' })).json();
    expect(sent).toMatchObject({ supplierReference: 'RMA-77', notes: 'Cracked shade' });

    // an existing install: the reference was a notes line
    const k = app.kernel.database;
    const db = k.kysely.withSchema('purchasing') as any;
    await k.exec('alter table purchasing.supplier_claims drop column supplier_reference; alter table purchasing.suppliers drop column return_authorization_required;');
    await db.updateTable('supplier_claims').set({ notes: 'Cracked shade\nSupplier reference: RMA-1\nSupplier reference: RMA-2\nCredit note CN-9 received' }).where('id', '=', c.id).execute();
    await k.exec(`begin;\n${m0002Pass4Columns.sql}\ncommit;`);
    const row = await db.selectFrom('supplier_claims').select(['supplier_reference', 'notes']).where('id', '=', c.id).executeTakeFirst();
    expect(row).toEqual({ supplier_reference: 'RMA-2', notes: 'Cracked shade\nCredit note CN-9 received' });
    const sup = await db.selectFrom('suppliers').select('return_authorization_required').limit(1).executeTakeFirst();
    expect(sup.return_authorization_required).toBe(false);
  });
});
