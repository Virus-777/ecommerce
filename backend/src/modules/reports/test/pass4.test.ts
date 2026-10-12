/**
 * Pass 4: metric change notes and owner history in columns/tables, open stock-outs and campaign references in their
 * own tables (not read_model_checkpoints), order item facts with accepted_at and group_id (captures match the group),
 * EXPORT_TOO_LARGE with matchedRows.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { spec } from '../../../spec/reports.js';
import { schemas } from '../infra/mongo/schema.js';
import { harness, usd, type Harness } from './harness.js';

let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h.app.close();
});

const table = (name: string) => h.app.kernel.mongo.module('reports', spec.collections, schemas).table<any>(name);

describe('metric definitions', () => {
  it('keep the draft or published change note and the owner history', async () => {
    const owner = newId();
    const next = newId();
    h.staff.set(owner, { name: 'Ola Owner', roleLabel: 'Order Manager' });
    h.staff.set(next, { name: 'Nils Next', roleLabel: 'Finance Manager' });
    const key = `commerce.pass4_${newId().slice(0, 8)}`;
    const body = { name: 'Pass 4 sales', group: 'commerce', definition: 'Item sales.', formula: 'Sum of item_minor', unit: 'money', dateBasisOptions: ['placement'], defaultDateBasis: 'placement', audience: 'staff', ownerId: owner, changeNote: 'New metric' };
    const created = await h.call('POST', '/api/admin/reports/metrics', h.tokens.staff(), { key, metric: body });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({ status: 'draft', changeNote: 'New metric' });
    const published = await h.call('POST', `/api/admin/reports/metrics/${key}/publish`, h.tokens.staff(), { effectiveFrom: '2026-01-01', changeNote: 'First version' });
    expect(published.body.changeNote).toBe('First version');
    expect((await table('metric_definitions').get(key))?.change_note).toBe('First version');
    const revised = await h.call('PATCH', `/api/admin/reports/metrics/${key}`, h.tokens.staff(), { ...body, changeNote: 'Returns deducted' });
    expect(revised.body).toMatchObject({ status: 'draft', version: 2, changeNote: 'Returns deducted' });

    expect((await h.call('PUT', `/api/admin/reports/metrics/${key}/owner`, h.tokens.staff(), { ownerId: next, reason: 'Finance takes it over' })).status).toBe(200);
    const one = await h.call('GET', `/api/admin/reports/metrics/${key}`, h.tokens.staff());
    expect(one.body.ownerChanges).toEqual([expect.objectContaining({ from: expect.objectContaining({ staffId: owner }), to: expect.objectContaining({ staffId: next, name: 'Nils Next' }), reason: 'Finance takes it over', changedBy: expect.objectContaining({ kind: 'staff' }) })]);
  });
});

describe('read model lookups in their own tables', () => {
  it('an out-of-stock interval is an open_stockouts row until stock comes back', async () => {
    const productId = newId();
    const offerId = newId();
    h.offerProducts.set(offerId, productId);
    const stockItemId = newId();
    const stock = { stockItemId, offerId, ownerType: 'seller', productId, variantId: newId(), available: 0, reserved: 0, previousAvailable: 2, archived: false, cause: 'order' };
    h.publish('inventory', 'inventory.stock.changed', { ...stock, state: 'out_of_stock' });
    await h.drain();
    expect(await table('open_stockouts').get(stockItemId)).toMatchObject({ product_id: productId });
    h.clock.advance(30 * 60_000);
    h.publish('inventory', 'inventory.stock.changed', { ...stock, available: 5, previousAvailable: 0, state: 'in_stock', cause: 'restock' });
    await h.drain();
    expect(await table('open_stockouts').find({ stock_item_id: stockItemId })).toEqual([]);
    expect(await table('read_model_checkpoints').find({ key: { $regex: '^lookup:' } })).toEqual([]);
  });

  it('the campaign of a redemption is a campaign_refs row the reversal reads', async () => {
    const campaignId = newId();
    const redemptionId = newId();
    const o = h.order({ sellerId: null, items: [{ unit: 8000 }] });
    h.placed(o);
    await h.drain();
    h.publish('promotions', 'promotions.coupon.redeemed', { redemptionId, campaignId, orderId: o.id, amount: usd(800), platformPart: usd(500), sellerPart: usd(300) });
    await h.drain();
    expect(await table('campaign_refs').findOne({ ref_id: redemptionId })).toMatchObject({ kind: 'redemption', campaign_id: campaignId });
  });
});

describe('order item facts', () => {
  it('keep accepted_at and group_id; a per-group capture pays only that group', async () => {
    const sellerId = newId();
    const o = h.order({ sellerId, items: [{ unit: 1000 }] });
    // a second group of the same seller in the same order
    const second = { ...o.groups[0]!, id: newId(), items: o.groups[0]!.items.map((i) => ({ ...i, id: newId() })) };
    (o as { groups: unknown[] }).groups = [...o.groups, second];
    h.ordersById.set(o.id, o);
    h.placed(o);
    await h.drain();
    const rows = await table('fact_order_items').find({ order_id: o.id });
    expect(rows.map((r: any) => r.group_id).sort()).toEqual([o.groups[0]!.id, second.id].sort());
    expect(rows.every((r: any) => r.accepted_at instanceof Date)).toBe(true);
    const groupId = second.id;
    h.publish('payments', 'payments.payment.captured', { intentId: newId(), captureId: newId(), orderId: o.id, groupId, amount: usd(1900), allocations: [{ groupId, ownerType: 'seller', sellerId, amount: usd(1900) }], capturedAt: h.clock.now().toISOString() });
    await h.drain();
    const after = await table('fact_order_items').find({ order_id: o.id });
    expect(after.find((r: any) => r.group_id === groupId).paid_at).toBeInstanceOf(Date);
    expect(after.find((r: any) => r.group_id === o.groups[0]!.id).paid_at).toBeNull();
  });
});
