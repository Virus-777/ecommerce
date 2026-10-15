/** Stock items, seller stock management (own items only), company SKUs, locations and low-stock alerts. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { admin, eventsNamed, harness, ledgerMismatches, officialItem, seller, sellerItem, sku, staffHeaders, warehouse, type Harness } from './helpers.js';

let h: Harness;
let reno: { id: string };
const avery = newId();
const other = newId();

beforeAll(async () => {
  h = await harness();
  reno = await warehouse(h, 'RNO1');
});
afterAll(async () => {
  await h?.app.close();
});
beforeEach(() => {
  h.events.length = 0;
  h.audits.length = 0;
  h.access.decision = 'allowed';
});

describe('stock items through the public API', () => {
  it('creates a seller item at the seller virtual location with opening stock in the ledger', async () => {
    const item = await sellerItem(h, avery, 12);
    expect(item).toMatchObject({ ownerType: 'seller', sellerId: avery, quantities: { available: 12, reserved: 0 }, state: 'in_stock', lowStockThreshold: 3, archived: false });
    const changed = eventsNamed(h, 'inventory.stock.changed');
    expect(changed).toEqual([expect.objectContaining({ stockItemId: item.id, available: 12, previousAvailable: 0, cause: 'initial', ownerType: 'seller' })]);
    const detail = (await seller(h, avery, 'GET', `/stock-items/${item.id}`)).json();
    expect(detail.levels).toHaveLength(1);
    expect(detail.recentMovements[0]).toMatchObject({ fromGroup: 'outside', toGroup: 'available', quantity: 12, reasonCode: 'initial', reasonLabel: 'Opening stock' });
  });

  it('is idempotent for the same offer and refuses a taken SKU', async () => {
    const offerId = newId();
    const code = sku();
    const a = await h.api.createStockItem({ ownerType: 'seller', sellerId: avery, offerId, sku: code, productId: newId(), variantId: newId(), condition: 'new', label: 'Pellar Skillet, 10 in', initialAvailable: 2 });
    const b = await h.api.createStockItem({ ownerType: 'seller', sellerId: avery, offerId, sku: code, productId: newId(), variantId: newId(), condition: 'new', label: 'Pellar Skillet, 10 in', initialAvailable: 2 });
    expect(b.id).toBe(a.id);
    await expect(h.api.createStockItem({ ownerType: 'seller', sellerId: avery, offerId: newId(), sku: code, productId: newId(), variantId: newId(), condition: 'new', label: 'x', initialAvailable: 0 })).rejects.toMatchObject({ code: 'SKU_TAKEN' });
    // another seller may use the same SKU: seller stock is never mixed
    const c = await h.api.createStockItem({ ownerType: 'seller', sellerId: other, offerId: newId(), sku: code, productId: newId(), variantId: newId(), condition: 'new', label: 'x', initialAvailable: 0 });
    expect(c.id).not.toBe(a.id);
  });

  it('answers availability, offer availability and SKU lookups', async () => {
    const item = await sellerItem(h, avery, 2, { lowStockThreshold: 3 });
    const a = await h.api.getAvailability([item.id, newId()]);
    expect(Object.keys(a)).toEqual([item.id]);
    expect(a[item.id]).toMatchObject({ available: 2, state: 'low_stock', lowStockThreshold: 3 });
    const offerId = newId();
    const o = await h.api.getOfferAvailability([{ offerId, stockItemId: item.id, purchaseLimit: 1 }]);
    expect(o[offerId]).toEqual({ state: 'low_stock', quantity: 2, maxPerOrder: 1, purchaseLimit: 1, label: '2 left', expectedRestockDate: null });
    expect((await h.api.findBySku('seller', [item.sku], avery)).map((i) => i.id)).toEqual([item.id]);
    expect(await h.api.findBySku('seller', [item.sku], other)).toEqual([]);
    expect(await h.api.getUnitCost(item.id)).toBeNull();
  });
});

describe('seller stock (own items only)', () => {
  it('lists, filters and summarizes only the seller own stock', async () => {
    const sellerId = newId();
    const inStock = await sellerItem(h, sellerId, 20, { label: 'Aurora Speaker, Blue' });
    const low = await sellerItem(h, sellerId, 2, { label: 'Aurora Speaker, Red' });
    const out = await sellerItem(h, sellerId, 0, { label: 'Aurora Speaker, Silver' });
    await sellerItem(h, newId(), 5);
    const list = (await seller(h, sellerId, 'GET', '/stock-items')).json();
    expect(list.items.map((r: { stockItemId: string }) => r.stockItemId).sort()).toEqual([inStock.id, low.id, out.id].sort());
    const row = list.items.find((r: { stockItemId: string }) => r.stockItemId === inStock.id);
    expect(row).toMatchObject({ productTitle: 'Aurora Speaker', variantLabel: 'Blue', available: 20, reserved: 0, state: 'in_stock', lowStockThreshold: 3 });
    expect(row.lastChange).toMatch(/· Inventory$/);
    const lowOnly = (await seller(h, sellerId, 'GET', '/stock-items?state=low_stock')).json();
    expect(lowOnly.items.map((r: { stockItemId: string }) => r.stockItemId)).toEqual([low.id]);
    const q = (await seller(h, sellerId, 'GET', '/stock-items?q=silver')).json();
    expect(q.items.map((r: { stockItemId: string }) => r.stockItemId)).toEqual([out.id]);
    const summary = (await seller(h, sellerId, 'GET', '/summary')).json();
    expect(summary).toEqual({ inStockSkus: 1, inStockUnits: 22, lowStockSkus: 1, outOfStockSkus: 1, reservedUnits: 0, outOfStockLabels: ['Aurora Speaker, Silver'] });
  });

  it("answers 404 for another seller's item on every route", async () => {
    const item = await sellerItem(h, other, 5);
    expect((await seller(h, avery, 'GET', `/stock-items/${item.id}`)).statusCode).toBe(404);
    expect((await seller(h, avery, 'POST', `/stock-items/${item.id}/adjustments`, { newAvailable: 1, reasonCode: 'count_correction' })).statusCode).toBe(404);
    expect((await seller(h, avery, 'PATCH', `/stock-items/${item.id}`, { lowStockThreshold: 1 })).statusCode).toBe(404);
    const batch = (await seller(h, avery, 'POST', '/adjustments/batch', { items: [{ stockItemId: item.id, newAvailable: 1, reasonCode: 'other' }] })).json();
    expect(batch.results[0]).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect((await h.api.getAvailability([item.id]))[item.id]!.available).toBe(5);
  });

  it('sets a new available quantity with a reason; reserved units are not affected', async () => {
    const item = await sellerItem(h, avery, 10);
    await h.api.hold(`chk-${newId()}`, [{ stockItemId: item.id, quantity: 3 }]);
    await h.app.kernel.events.drain();
    h.events.length = 0;
    const res = await seller(h, avery, 'POST', `/stock-items/${item.id}/adjustments`, { newAvailable: 4, reasonCode: 'damaged_or_defective', note: 'Two boxes crushed' }, { name: 'Avery Stone' } as never);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ fromGroup: 'available', toGroup: 'outside', quantity: 3, reasonCode: 'damaged_or_defective', reasonLabel: 'Damaged or defective', note: 'Two boxes crushed', after: { available: 4, reserved: 3 }, actor: { kind: 'seller' } });
    expect(eventsNamed(h, 'inventory.adjustment.recorded')).toEqual([expect.objectContaining({ adjustmentId: null, stockItemId: item.id, fromGroup: 'available', toGroup: 'outside', quantity: 3, sellerId: avery })]);
    expect(eventsNamed(h, 'inventory.stock.changed')).toEqual([expect.objectContaining({ available: 4, previousAvailable: 7, reserved: 3, state: 'in_stock', cause: 'adjustment' })]);

    const up = await seller(h, avery, 'POST', `/stock-items/${item.id}/adjustments`, { newAvailable: 9, reasonCode: 'received_stock' });
    expect(up.json()).toMatchObject({ fromGroup: 'outside', toGroup: 'available', quantity: 5 });
    const same = await seller(h, avery, 'POST', `/stock-items/${item.id}/adjustments`, { newAvailable: 9, reasonCode: 'count_correction' });
    expect(same.statusCode).toBe(400);
    const negative = await seller(h, avery, 'POST', `/stock-items/${item.id}/adjustments`, { newAvailable: -1, reasonCode: 'count_correction' });
    expect(negative.statusCode).toBe(400);
    const zero = await seller(h, avery, 'POST', `/stock-items/${item.id}/adjustments`, { newAvailable: 0, reasonCode: 'lost_or_missing' });
    expect(zero.json().after).toMatchObject({ available: 0, reserved: 3 });
    expect(eventsNamed(h, 'inventory.stock.changed').at(-1)).toMatchObject({ state: 'out_of_stock', available: 0 });

    const history = (await seller(h, avery, 'GET', `/movements?stockItemId=${item.id}&reasonCode=lost_or_missing`)).json();
    expect(history.items).toHaveLength(1);
    expect(await ledgerMismatches(h)).toEqual([]);
  });

  it('saves several inline edits at once, each with its own result', async () => {
    const a = await sellerItem(h, avery, 5);
    const b = await sellerItem(h, avery, 5);
    const res = await seller(h, avery, 'POST', '/adjustments/batch', {
      items: [
        { stockItemId: a.id, newAvailable: 8, reasonCode: 'received_stock' },
        { stockItemId: b.id, newAvailable: 5, reasonCode: 'count_correction' },
        { stockItemId: newId(), newAvailable: 1, reasonCode: 'other' },
        { stockItemId: b.id, newAvailable: -2, reasonCode: 'other' },
      ],
      note: 'Weekly count',
    });
    expect(res.statusCode, res.body).toBe(200);
    const [r1, r2, r3, r4] = res.json().results;
    expect(r1).toMatchObject({ ok: true, movement: { quantity: 3, note: 'Weekly count' } });
    expect(r2).toMatchObject({ ok: true, movement: null });
    expect(r3).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(r4).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
    expect((await seller(h, avery, 'POST', '/adjustments/batch', { items: [] })).statusCode).toBe(400);
  });

  it('applies the bulk file quantities as Bulk update movements', async () => {
    const a = await sellerItem(h, avery, 5);
    const jobId = newId();
    const res = await h.api.applyBulkQuantities(avery, [{ stockItemId: a.id, newAvailable: 7 }, { stockItemId: a.id, newAvailable: 7 }, { stockItemId: newId(), newAvailable: 1 }], jobId, { kind: 'seller', id: newId(), name: 'Avery Stone' });
    expect(res).toEqual([{ stockItemId: a.id, ok: true }, { stockItemId: a.id, ok: true }, expect.objectContaining({ ok: false, error: expect.any(String) })]);
    const moves = (await seller(h, avery, 'GET', `/movements?stockItemId=${a.id}&reasonCode=bulk_update`)).json().items;
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ reasonLabel: 'Bulk update', quantity: 2, reference: { kind: 'bulk_update', id: jobId } });
  });

  it('changes the low-stock threshold and alerts once per cooldown', async () => {
    const item = await sellerItem(h, avery, 10);
    const patched = await seller(h, avery, 'PATCH', `/stock-items/${item.id}`, { lowStockThreshold: 6 });
    expect(patched.json()).toMatchObject({ lowStockThreshold: 6, state: 'in_stock' });
    expect((await seller(h, avery, 'PATCH', `/stock-items/${item.id}`, { lowStockThreshold: -1 })).statusCode).toBe(400);
    h.events.length = 0;
    await seller(h, avery, 'POST', `/stock-items/${item.id}/adjustments`, { newAvailable: 5, reasonCode: 'count_correction' });
    expect(eventsNamed(h, 'inventory.stock.low')).toEqual([{ stockItemId: item.id, offerId: item.offerId, ownerType: 'seller', sellerId: avery, productId: item.productId, variantId: item.variantId, sku: item.sku, label: item.label, available: 5, threshold: 6, serviceManaged: false }]);
    await seller(h, avery, 'POST', `/stock-items/${item.id}/adjustments`, { newAvailable: 4, reasonCode: 'count_correction' });
    expect(eventsNamed(h, 'inventory.stock.low')).toHaveLength(1); // within the cooldown
    h.clock.advance(25 * 3_600_000);
    await seller(h, avery, 'POST', `/stock-items/${item.id}/adjustments`, { newAvailable: 3, reasonCode: 'count_correction' });
    expect(eventsNamed(h, 'inventory.stock.low')).toHaveLength(2);
    await seller(h, avery, 'POST', `/stock-items/${item.id}/adjustments`, { newAvailable: 30, reasonCode: 'received_stock' });
    expect(eventsNamed(h, 'inventory.stock.low')).toHaveLength(2); // going up never alerts
  });

  it('archives items when the offer is removed or the seller closes; archived items cannot be adjusted or held', async () => {
    const sellerId = newId();
    const a = await sellerItem(h, sellerId, 5);
    const b = await sellerItem(h, sellerId, 5);
    h.app.kernel.events.publish('offers', 'offers.offer.status_changed', { offerId: a.offerId!, productId: a.productId, variantId: a.variantId, sellerId, ownerType: 'seller', from: 'active', to: 'removed', reasonCode: 'seller_removed', stockItemId: a.id });
    await h.app.kernel.events.drain();
    expect((await seller(h, sellerId, 'POST', `/stock-items/${a.id}/adjustments`, { newAvailable: 1, reasonCode: 'other' })).json().error.code).toBe('STOCK_ITEM_ARCHIVED');
    await expect(h.api.hold(`chk-${newId()}`, [{ stockItemId: a.id, quantity: 1 }])).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });
    expect((await seller(h, sellerId, 'GET', '/stock-items')).json().items.map((r: { stockItemId: string }) => r.stockItemId)).toEqual([b.id]);
    h.app.kernel.events.publish('sellers', 'sellers.seller.closed', { sellerId, reasonCode: 'seller_request', closedBy: { kind: 'staff', id: newId() } });
    await h.app.kernel.events.drain();
    expect((await seller(h, sellerId, 'GET', '/stock-items')).json().items).toEqual([]);
  });

  it('exports own rows through reports (sellerId from the session) and shows only the requester the link', async () => {
    const item = await sellerItem(h, avery, 3);
    const foreign = await sellerItem(h, other, 3);
    const member = newId();
    const res = await seller(h, avery, 'POST', '/stock-items/exports', { filters: { state: 'in_stock' }, stockItemIds: [item.id] }, { accountId: member });
    expect(res.statusCode, res.body).toBe(202);
    expect(h.exports.requested.at(-1)).toMatchObject({ dataset: 'inventory.seller.stock', sellerId: avery, format: 'csv', filters: { state: 'in_stock', stockItemIds: [item.id] } });
    expect(h.exports.registered).toEqual(expect.arrayContaining(['inventory.seller.stock', 'inventory.admin.stock']));
    expect(h.audits.at(-1)).toMatchObject({ action: 'inventory.stock.export', module: 'inventory' });
    expect((await seller(h, avery, 'POST', '/stock-items/exports', { stockItemIds: [foreign.id] })).statusCode).toBe(400);
    expect((await seller(h, avery, 'POST', '/stock-items/exports', { filters: { state: 'sold' } })).statusCode).toBe(400);

    const { lastSeller } = await import('./helpers.js');
    lastSeller.sellerId = avery;
    lastSeller.accountId = member;
    expect((await seller(h, avery, 'GET', `/stock-items/exports/${newId()}`, undefined, { accountId: member })).json()).toMatchObject({ state: 'ready', downloadUrl: expect.any(String) });
    expect((await seller(h, avery, 'GET', `/stock-items/exports/${newId()}`, undefined, { accountId: newId() })).statusCode).toBe(403);
    expect((await seller(h, other, 'GET', `/stock-items/exports/${newId()}`, undefined, { accountId: member })).statusCode).toBe(404);

    const rows = await h.api.exportRows('inventory.seller.stock', { stockItemIds: [item.id] }, { kind: 'seller', sellerId: avery });
    expect(rows.rows).toEqual([expect.objectContaining({ product: 'Halden Aurora ANC Headphones', variant: 'Black', sellerSku: item.sku, available: 3 })]);
    await expect(h.api.exportRows('inventory.seller.stock', {}, { kind: 'staff' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const adminRows = await h.api.exportRows('inventory.admin.stock', { ownerType: 'seller', sellerId: other }, { kind: 'staff' });
    expect(adminRows.rows.map((r) => (r as { sku: string }).sku)).toContain(foreign.sku);
  });
});

describe('company stock items and locations', () => {
  it('creates a company SKU at a location, audited; refuses a taken SKU', async () => {
    const code = sku('HAL-AUR');
    const productId = newId();
    const variantId = newId();
    h.products.set(productId, { id: productId, title: 'Halden Aurora ANC Headphones', categoryId: null, variants: [{ id: variantId, options: { color: 'Black' }, images: [] }] });
    const res = await admin(h, 'POST', '/stock-items', { sku: code, productId, variantId, condition: 'new', locationId: reno.id, lowStockThreshold: 4, reorderQuantity: 24 });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ ownerType: 'official', sku: code, label: 'Halden Aurora ANC Headphones, Black', lowStockThreshold: 4, reorderQuantity: 24, state: 'out_of_stock', quantities: { available: 0 } });
    expect(h.audits.at(-1)).toMatchObject({ action: 'inventory.stock_item.create', target: { type: 'stock_item', ref: code } });
    const again = await admin(h, 'POST', '/stock-items', { sku: code, productId, variantId, condition: 'new', locationId: reno.id });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('SKU_TAKEN');
    expect((await admin(h, 'POST', '/stock-items', { sku: sku(), productId, variantId, condition: 'new', locationId: newId() })).statusCode).toBe(400);
    expect((await admin(h, 'POST', '/stock-items', { sku: sku(), productId: newId(), variantId, condition: 'new', locationId: reno.id })).statusCode).toBe(400); // unknown product
    // the Official Store offer that starts selling the SKU is linked to it
    const offerId = newId();
    const linked = await h.api.createStockItem({ ownerType: 'official', offerId, sku: code, productId, variantId, condition: 'new', label: 'x', initialAvailable: 0 });
    expect(linked).toMatchObject({ id: res.json().id, offerId });
    expect((await h.api.getStockForOffers([offerId], {}))[offerId]?.id).toBe(res.json().id);
  });

  it('changes reorder point and archives a company SKU (audited); seller items are read-only', async () => {
    const item = await officialItem(h, reno.id, 5);
    const res = await admin(h, 'PATCH', `/stock-items/${item.id}`, { lowStockThreshold: 5, reorderQuantity: 12 });
    expect(res.json()).toMatchObject({ lowStockThreshold: 5, reorderQuantity: 12, state: 'low_stock' });
    expect(h.audits.at(-1)).toMatchObject({ action: 'inventory.stock_item.update', before: expect.objectContaining({ lowStockThreshold: 3 }) /* the default (G74) */, after: expect.objectContaining({ lowStockThreshold: 5 }) });
    const archived = await admin(h, 'PATCH', `/stock-items/${item.id}`, { archived: true });
    expect(archived.json()).toMatchObject({ archived: true });
    const sellers = await sellerItem(h, avery, 1);
    expect((await admin(h, 'PATCH', `/stock-items/${sellers.id}`, { lowStockThreshold: 1 })).statusCode).toBe(400);
    expect((await admin(h, 'PATCH', `/stock-items/${newId()}`, { lowStockThreshold: 1 })).statusCode).toBe(404);
  });

  it('lists company stock by default, seller stock read-only with sellerId, never totalled together', async () => {
    const item = await officialItem(h, reno.id, 7, { label: 'Zephyr Lamp, Oak' });
    const sellers = await sellerItem(h, avery, 4);
    const list = (await admin(h, 'GET', '/stock-items?limit=100')).json();
    expect(list.items.every((i: { ownerType: string }) => i.ownerType === 'official')).toBe(true);
    expect(list.items.map((i: { id: string }) => i.id)).toContain(item.id);
    const bySeller = (await admin(h, 'GET', `/stock-items?sellerId=${avery}&limit=100`)).json();
    expect(bySeller.items.map((i: { id: string }) => i.id)).toContain(sellers.id);
    expect(bySeller.items.every((i: { sellerId: string }) => i.sellerId === avery)).toBe(true);
    const q = (await admin(h, 'GET', '/stock-items?q=zephyr')).json();
    expect(q.items.map((i: { id: string }) => i.id)).toEqual([item.id]);
    const summary = (await admin(h, 'GET', '/summary')).json();
    expect(summary.ownerType).toBe('official');
    expect(summary.groups.map((g: { group: string }) => g.group)).toEqual(['available', 'reserved', 'incoming', 'damaged_held', 'returned']);
    expect(summary.groups[0]).toMatchObject({ label: 'Available', meaning: 'Sellable to new customers' });
    const detail = (await admin(h, 'GET', `/stock-items/${item.id}`)).json();
    expect(detail.levels).toEqual([expect.objectContaining({ locationId: reno.id, locationName: 'RNO1 warehouse', quantities: expect.objectContaining({ available: 7 }) })]);
  });

  it('manages locations: unique codes, one default, one sellable warehouse before phase 4, no deactivation with stock', async () => {
    const list = (await admin(h, 'GET', '/locations')).json();
    expect(list.find((l: { id: string }) => l.id === reno.id)).toMatchObject({ kind: 'warehouse', ownerType: 'official', isDefault: true, sellable: true, active: true });
    expect(list.every((l: { ownerType: string }) => l.ownerType === 'official')).toBe(true); // seller virtual locations are not listed
    expect((await admin(h, 'POST', '/locations', { code: 'RNO1', name: 'Dup', address: { name: 'x', line1: 'x', city: 'x', region: 'NV', postalCode: '1', country: 'US' }, timeZone: 'America/Los_Angeles' })).statusCode).toBe(409);
    expect((await admin(h, 'POST', '/locations', { code: 'BAD', name: 'Bad', address: { name: 'x', line1: 'x', city: 'x', region: 'NV', postalCode: '1', country: 'US' }, timeZone: 'Mars/Olympus' })).statusCode).toBe(400);
    const second = await warehouse(h, 'SLC1');
    expect(second.isDefault).toBe(false);
    expect(h.audits.at(-1)).toMatchObject({ action: 'inventory.location.create' });
    const renamed = await admin(h, 'PATCH', `/locations/${second.id}`, { name: 'Salt Lake City', sellable: false });
    expect(renamed.json()).toMatchObject({ name: 'Salt Lake City', sellable: false });
    const item = await officialItem(h, second.id, 1);
    const off = await admin(h, 'PATCH', `/locations/${second.id}`, { active: false });
    expect(off.statusCode).toBe(400);
    await admin(h, 'POST', '/adjustments', { stockItemId: item.id, locationId: second.id, fromGroup: 'available', toGroup: 'outside', quantity: 1, reasonCode: 'write_off' });
    expect((await admin(h, 'PATCH', `/locations/${second.id}`, { active: false })).json()).toMatchObject({ active: false });
    expect((await admin(h, 'PATCH', `/locations/${newId()}`, { name: 'x' })).statusCode).toBe(404);
  });

  it('refuses a second sellable warehouse before launch phase 4', async () => {
    const early = await harness({ launchPhase: 1 });
    try {
      await warehouse(early, 'ONE1');
      const res = await admin(early, 'POST', '/locations', { code: 'TWO1', name: 'Two', address: { name: 'x', line1: 'x', city: 'x', region: 'NV', postalCode: '1', country: 'US' }, timeZone: 'America/Los_Angeles' });
      expect(res.statusCode).toBe(400);
      const unsellable = await admin(early, 'POST', '/locations', { code: 'TWO1', name: 'Two', address: { name: 'x', line1: 'x', city: 'x', region: 'NV', postalCode: '1', country: 'US' }, timeZone: 'America/Los_Angeles', sellable: false });
      expect(unsellable.statusCode).toBe(201);
    } finally {
      await early.app.close();
    }
  });

  it('needs inventory.stock.view to read company stock', async () => {
    const res = await admin(h, 'GET', '/stock-items', undefined, staffHeaders(['inventory.items.manage']));
    expect(res.statusCode).toBe(403);
  });
});
