/** Wave 2 (BACKEND-REQUESTS.md): the default low-stock threshold for every item (G74) and the bulk_update reason (G53b). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { admin, harness, officialItem, seller, sellerItem, warehouse, type Harness } from './helpers.js';

let h: Harness;
let reno: { id: string };
const avery = newId();

beforeAll(async () => {
  h = await harness();
  reno = await warehouse(h, 'RNO2');
});
afterAll(async () => {
  await h?.app.close();
});

describe('low stock without an own threshold (G74)', () => {
  it('uses the defaultLowStockThreshold setting for company SKUs too, in item states, filters and the low-stock list', async () => {
    const low = await officialItem(h, reno.id, 2);
    const fine = await officialItem(h, reno.id, 40);
    expect(low).toMatchObject({ lowStockThreshold: 3, state: 'low_stock' });
    expect(fine).toMatchObject({ lowStockThreshold: 3, state: 'in_stock' });
    const lows = (await admin(h, 'GET', '/low-stock?ownerType=official&limit=100')).json().items.map((r: { item: { id: string } }) => r.item.id);
    expect(lows).toContain(low.id);
    expect(lows).not.toContain(fine.id);
    // an own threshold still wins
    const own = await admin(h, 'PATCH', `/stock-items/${fine.id}`, { lowStockThreshold: 50 });
    expect(own.json()).toMatchObject({ lowStockThreshold: 50, state: 'low_stock' });
  });
});

describe('bulk stock edits (G53b)', () => {
  it('lets a seller record the bulk_update reason on batch rows', async () => {
    const item = await sellerItem(h, avery, 4);
    const res = await seller(h, avery, 'POST', '/adjustments/batch', { items: [{ stockItemId: item.id, newAvailable: 9, reasonCode: 'bulk_update' }] });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().results[0]).toMatchObject({ ok: true, movement: { reasonCode: 'bulk_update', reasonLabel: 'Bulk update', quantity: 5 } });
    expect((await seller(h, avery, 'GET', `/movements?stockItemId=${item.id}&reasonCode=bulk_update`)).json().items).toHaveLength(1);
  });
});
