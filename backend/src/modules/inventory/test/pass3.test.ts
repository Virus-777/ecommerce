/**
 * Gap pass 3: split order items keep their own reserved units (cancel 1 of 3, ship 2: nothing stays reserved),
 * hold units no accepted item asks for are released, allocations for replacements and exchanges, locations,
 * re-keying, archiving and merging stock items, sales rate, catalog merges, GTIN on refs and the new event fields.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../../../kernel/errors/index.js';
import { newId } from '../../../kernel/lib/ids.js';
import { admin, eventsNamed, harness, ledgerMismatches, officialItem, quantities, reservedMismatches, sellerItem, staffHeaders, warehouse, type Harness } from './helpers.js';

let h: Harness;
let main: { id: string; code: string };

beforeAll(async () => {
  h = await harness();
  main = await warehouse(h, 'P3W1');
});
afterAll(async () => {
  await h?.app.close();
});
beforeEach(async () => {
  await h.app.kernel.events.drain();
  h.events.length = 0;
  h.audits.length = 0;
  h.raised.length = 0;
});

const usd = (amount: number) => ({ amount, currency: 'USD' });
const zero = usd(0);
type Item = { orderItemId: string; stockItemId: string; quantity: number };

const accepted = async (orderId: string, reservationId: string | null, items: Item[], ref = 'MK-261010-00100') => {
  h.app.kernel.events.publish('orders', 'orders.order.accepted', {
    orderId,
    ref,
    customerId: newId(),
    contactEmail: 'sam@example.com',
    total: usd(18900),
    groups: [{ groupId: newId(), ownerType: 'official', sellerId: null, fulfilledBy: 'official_warehouse', dispatchBy: new Date().toISOString(), itemIds: items.map((i) => i.orderItemId), total: usd(18900) }],
    items: items.map((i) => ({ ...i, offerId: newId() })),
    reservationId,
    acceptedAt: new Date().toISOString(),
  });
  await h.app.kernel.events.drain();
};

const split = async (o: { orderId: string; itemId: string; newItemId: string; stockItemId: string; quantity: number; remaining: number; reason?: 'cancellation' | 'shipment' }) => {
  h.app.kernel.events.publish('orders', 'orders.item.split', {
    orderId: o.orderId,
    groupId: newId(),
    itemId: o.itemId,
    newItemId: o.newItemId,
    rootItemId: o.itemId,
    offerId: newId(),
    stockItemId: o.stockItemId,
    quantity: o.quantity,
    remainingQuantity: o.remaining,
    reason: o.reason ?? 'cancellation',
    at: new Date().toISOString(),
  });
  await h.app.kernel.events.drain();
};

const cancelled = async (orderId: string, itemId: string, stockItemId: string, quantity: number) => {
  h.app.kernel.events.publish('orders', 'orders.item.cancelled', {
    orderId,
    ref: 'MK-261010-00100',
    groupId: newId(),
    ownerType: 'official',
    sellerId: null,
    itemId,
    offerId: newId(),
    stockItemId,
    quantity,
    cancellationId: newId(),
    initiatedBy: 'customer',
    notifyCustomer: true,
    reasonCode: 'changed_mind',
    beforeDispatch: true,
    countsAgainstSeller: false,
    refund: { itemAmount: zero, discountShare: zero, shippingRefund: zero, taxRefund: zero, total: zero },
    paymentIntentId: newId(),
  });
  await h.app.kernel.events.drain();
};

const dispatched = async (orderId: string, lines: { orderItemId: string; quantity: number }[], kind: 'outbound' | 'replacement' = 'outbound') => {
  h.app.kernel.events.publish('shipping', 'shipping.shipment.dispatched', {
    shipmentId: newId(),
    kind,
    orderId,
    groupId: newId(),
    ownerType: 'official',
    sellerId: null,
    lines: lines.map((l) => ({ ...l, title: 'Aurora', variantLabel: 'Black' })),
    shippedAt: new Date().toISOString(),
    trackingValid: true,
  });
  await h.app.kernel.events.drain();
};

const consistent = async () => {
  expect(await ledgerMismatches(h)).toEqual([]);
  expect(await reservedMismatches(h)).toEqual([]);
};

describe('split order items (orders.item.split)', () => {
  it('cancel 1 of 3 (split), then dispatch the other 2: no units stay Reserved', async () => {
    const a = await officialItem(h, main.id, 10);
    const r = await h.api.hold(`chk-${newId()}`, [{ stockItemId: a.id, quantity: 3 }]);
    const orderId = newId();
    const itemId = newId();
    await accepted(orderId, r.id, [{ orderItemId: itemId, stockItemId: a.id, quantity: 3 }]);
    expect(await quantities(h, a.id)).toMatchObject({ available: 7, reserved: 3 });

    // orders splits the cancelled unit off to a new item, then cancels that item
    const newItemId = newId();
    await split({ orderId, itemId, newItemId, stockItemId: a.id, quantity: 1, remaining: 2 });
    await split({ orderId, itemId, newItemId, stockItemId: a.id, quantity: 1, remaining: 2 }); // redelivered: nothing more moves
    const lines = (await h.api.attachOrder(r.id, orderId, [])).lines;
    expect(lines.map((l) => [l.orderItemId, l.quantity, l.state]).sort()).toEqual(
      [
        [itemId, 2, 'allocated'],
        [newItemId, 1, 'allocated'],
      ].sort(),
    );
    await cancelled(orderId, newItemId, a.id, 1);
    expect(await quantities(h, a.id)).toMatchObject({ available: 8, reserved: 2 });

    await dispatched(orderId, [{ orderItemId: itemId, quantity: 2 }]);
    expect(await quantities(h, a.id)).toMatchObject({ available: 8, reserved: 0 });
    const after = (await h.api.attachOrder(r.id, orderId, [])) as { state: string; lines: { orderItemId?: string | null; state: string }[] };
    expect(after.state).toBe('fulfilled');
    expect(after.lines.find((l) => l.orderItemId === newItemId)?.state).toBe('released');
    await consistent();
  });

  it('a split of units that already left stock moves nothing (the original keeps fulfilled and released counts)', async () => {
    const a = await officialItem(h, main.id, 4);
    const r = await h.api.hold(`chk-${newId()}`, [{ stockItemId: a.id, quantity: 2 }]);
    const orderId = newId();
    const itemId = newId();
    await accepted(orderId, r.id, [{ orderItemId: itemId, stockItemId: a.id, quantity: 2 }]);
    await dispatched(orderId, [{ orderItemId: itemId, quantity: 2 }]);
    await split({ orderId, itemId, newItemId: newId(), stockItemId: a.id, quantity: 1, remaining: 1, reason: 'shipment' });
    const lines = (await h.api.attachOrder(r.id, orderId, [])).lines;
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ orderItemId: itemId, quantity: 2, state: 'fulfilled' });
    await consistent();
  });
});

describe('acceptance releases hold units no accepted item asks for', () => {
  it('releases the excess at once (reason unmatched) and allocates the rest', async () => {
    const a = await officialItem(h, main.id, 6);
    const b = await officialItem(h, main.id, 6);
    const r = await h.api.hold(`chk-${newId()}`, [
      { stockItemId: a.id, quantity: 3 },
      { stockItemId: b.id, quantity: 1 },
    ]);
    const orderId = newId();
    const itemId = newId();
    // quantity reduced to 2 at placement, and the line of b dropped
    await accepted(orderId, r.id, [{ orderItemId: itemId, stockItemId: a.id, quantity: 2 }]);
    expect(await quantities(h, a.id)).toMatchObject({ available: 4, reserved: 2 });
    expect(await quantities(h, b.id)).toMatchObject({ available: 6, reserved: 0 });
    const released = eventsNamed(h, 'inventory.reservation.released');
    expect(released).toEqual([expect.objectContaining({ reservationId: r.id, orderId, reason: 'unmatched' })]);
    expect((released[0].lines as { stockItemId: string; releasedQuantity: number }[]).map((l) => [l.stockItemId, l.releasedQuantity]).sort()).toEqual([[a.id, 1], [b.id, 1]].sort());
    expect(eventsNamed(h, 'inventory.reservation.allocated')).toEqual([expect.objectContaining({ reservationId: r.id, source: 'checkout', lines: [expect.objectContaining({ orderItemId: itemId, state: 'allocated' })] })]);
    await consistent();
  });
});

describe('allocateForOrder (replacements and exchanges)', () => {
  it('allocates with no expiry, idempotent by key; a replacement shipment fulfils it, a normal one never does', async () => {
    const a = await officialItem(h, main.id, 3);
    const orderId = newId();
    const orderItemId = newId();
    const input = { key: `rep-${newId()}`, orderId, orderRef: 'MK-261010-00200', source: { kind: 'replacement' as const, id: newId(), ref: 'RT-261010-0009' }, lines: [{ stockItemId: a.id, quantity: 2, orderItemId }], actor: { kind: 'staff' as const, id: newId() } };
    const res = await h.api.allocateForOrder(input);
    expect(res).toMatchObject({ state: 'allocated', orderId, expiresAt: null, lines: [expect.objectContaining({ orderItemId, quantity: 2, state: 'allocated' })] });
    expect(await h.api.allocateForOrder(input)).toMatchObject({ id: res.id });
    await h.app.kernel.events.drain();
    expect(eventsNamed(h, 'inventory.reservation.allocated')).toEqual([expect.objectContaining({ reservationId: res.id, orderId, source: 'replacement' })]);
    expect(await quantities(h, a.id)).toMatchObject({ available: 1, reserved: 2 });
    await expect(h.api.allocateForOrder({ ...input, key: `rep-${newId()}` })).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK', details: { lines: [{ stockItemId: a.id, requested: 2, available: 1 }] } });

    // the hold-expiry job never touches it
    h.clock.advance(3 * 3_600_000);
    await h.app.kernel.jobs.runNow('inventory.expire-holds');
    expect(await quantities(h, a.id)).toMatchObject({ reserved: 2 });

    await dispatched(orderId, [{ orderItemId, quantity: 2 }], 'outbound');
    expect(await quantities(h, a.id)).toMatchObject({ reserved: 2 });
    await dispatched(orderId, [{ orderItemId, quantity: 2 }], 'replacement');
    expect(await quantities(h, a.id)).toMatchObject({ available: 1, reserved: 0 });
    await consistent();
  });

  it('releaseHold releases an allocation that is no longer needed (cancelled exchange); a normal allocation still refuses', async () => {
    const a = await officialItem(h, main.id, 2);
    const ex = await h.api.allocateForOrder({ key: `ex-${newId()}`, orderId: newId(), source: { kind: 'exchange', id: newId() }, lines: [{ stockItemId: a.id, quantity: 2 }], actor: { kind: 'system' } });
    await h.app.kernel.events.drain();
    expect(eventsNamed(h, 'inventory.reservation.allocated')[0]).toMatchObject({ source: 'exchange' });
    await h.api.releaseHold(ex.id, 'Exchange cancelled');
    await h.app.kernel.events.drain();
    expect(await quantities(h, a.id)).toMatchObject({ available: 2, reserved: 0 });
    expect(eventsNamed(h, 'inventory.reservation.released')).toEqual([expect.objectContaining({ reservationId: ex.id, reason: 'cancelled' })]);
    await h.api.releaseHold(ex.id, 'again'); // idempotent

    const r = await h.api.hold(`chk-${newId()}`, [{ stockItemId: a.id, quantity: 1 }]);
    const orderId = newId();
    await accepted(orderId, r.id, [{ orderItemId: newId(), stockItemId: a.id, quantity: 1 }]);
    await expect(h.api.releaseHold(r.id, 'x')).rejects.toMatchObject({ code: 'ILLEGAL_TRANSITION' });
    await consistent();
  });
});

describe('locations', () => {
  it('getLocations lists company locations (default first) and getDefaultLocation names the ships-from location', async () => {
    const other = await warehouse(h, 'P3W2');
    const all = await h.api.getLocations();
    expect(all[0]).toMatchObject({ isDefault: true, ownerType: 'official' });
    expect(all.map((l) => l.id)).toEqual(expect.arrayContaining([main.id, other.id]));
    expect(all[0]).toHaveProperty('timeZone');
    const def = await h.api.getDefaultLocation();
    expect(def).toMatchObject({ id: all[0]!.id, isDefault: true, address: expect.objectContaining({ city: 'Reno' }) });
    await admin(h, 'PATCH', `/locations/${other.id}`, { active: false });
    expect((await h.api.getLocations({ activeOnly: true })).map((l) => l.id)).not.toContain(other.id);
  });
});

describe('stock items follow their offers and catalog records', () => {
  it('updateStockItem re-keys an item (stock.changed cause item_updated with productId); SKU_TAKEN within the owner', async () => {
    const sellerId = newId();
    const a = await sellerItem(h, sellerId, 4);
    const b = await sellerItem(h, sellerId, 1);
    const productId = newId();
    const variantId = newId();
    h.events.length = 0;
    const updated = await h.api.updateStockItem(a.id, { productId, variantId, condition: 'used_like_new', sku: 'AV-NEW-1' }, { kind: 'system', id: 'offers' });
    expect(updated).toMatchObject({ id: a.id, productId, variantId, condition: 'used_like_new', sku: 'AV-NEW-1', quantities: expect.objectContaining({ available: 4 }) });
    await h.app.kernel.events.drain();
    expect(eventsNamed(h, 'inventory.stock.changed')).toEqual([expect.objectContaining({ stockItemId: a.id, productId, variantId, cause: 'item_updated', available: 4, previousAvailable: 4, archived: false })]);
    await expect(h.api.updateStockItem(b.id, { sku: 'AV-NEW-1' }, { kind: 'system' })).rejects.toMatchObject({ code: 'SKU_TAKEN' });
    // another owner may use the same SKU
    await expect(h.api.updateStockItem((await sellerItem(h, newId(), 1)).id, { sku: 'AV-NEW-1' }, { kind: 'system' })).resolves.toMatchObject({ sku: 'AV-NEW-1' });
  });

  it('archives on offer removal and unarchives when the offer is reinstated (quantities kept, events published)', async () => {
    const sellerId = newId();
    const a = await sellerItem(h, sellerId, 3);
    const base = { offerId: a.offerId!, productId: a.productId, variantId: a.variantId, sellerId, ownerType: 'seller', stockItemId: a.id };
    h.app.kernel.events.publish('offers', 'offers.offer.status_changed', { ...base, from: 'active', to: 'removed', reasonCode: 'seller_removed' });
    await h.app.kernel.events.drain();
    expect((await h.api.getOfferAvailability([{ offerId: a.offerId!, stockItemId: a.id }]))[a.offerId!]).toMatchObject({ state: 'out_of_stock' });
    expect(eventsNamed(h, 'inventory.stock.changed').at(-1)).toMatchObject({ stockItemId: a.id, archived: true, cause: 'archived', state: 'out_of_stock' });

    h.app.kernel.events.publish('offers', 'offers.offer.status_changed', { ...base, from: 'removed', to: 'active', reasonCode: 'reinstated' });
    await h.app.kernel.events.drain();
    expect((await h.api.getOfferAvailability([{ offerId: a.offerId!, stockItemId: a.id }]))[a.offerId!]).toMatchObject({ state: expect.not.stringMatching('out_of_stock'), maxPerOrder: 3 });
    expect(eventsNamed(h, 'inventory.stock.changed').at(-1)).toMatchObject({ stockItemId: a.id, archived: false, cause: 'unarchived', available: 3 });
  });

  it('PATCH archived false unarchives a company SKU (audited); unarchiveStockItem does the same in-process', async () => {
    const a = await officialItem(h, main.id, 2);
    h.events.length = 0;
    expect((await admin(h, 'PATCH', `/stock-items/${a.id}`, { archived: true })).json()).toMatchObject({ archived: true });
    const back = await admin(h, 'PATCH', `/stock-items/${a.id}`, { archived: false });
    expect(back.statusCode, back.body).toBe(200);
    expect(back.json()).toMatchObject({ archived: false, quantities: expect.objectContaining({ available: 2 }) });
    expect(h.audits.map((x) => x.action)).toEqual(['inventory.stock_item.archive', 'inventory.stock_item.unarchive']);
    expect(eventsNamed(h, 'inventory.stock.changed').map((e) => e.cause)).toEqual(['archived', 'unarchived']);
    await admin(h, 'PATCH', `/stock-items/${a.id}`, { archived: true });
    expect(await h.api.unarchiveStockItem(a.id, { kind: 'system' })).toMatchObject({ archived: false });
  });

  it('merges a company SKU into another: every group, open reservation lines and incoming move; the source is archived', async () => {
    const from = await officialItem(h, main.id, 5);
    const into = await officialItem(h, main.id, 1);
    const r = await h.api.hold(`chk-${newId()}`, [{ stockItemId: from.id, quantity: 2 }]);
    const orderId = newId();
    const itemId = newId();
    await accepted(orderId, r.id, [{ orderItemId: itemId, stockItemId: from.id, quantity: 2 }]);
    await h.api.expectIncoming(newId(), 'PUR-2610-0300', main.id, [{ stockItemId: from.id, quantity: 4, expectedDate: '2026-10-30' }]);

    expect((await admin(h, 'POST', `/stock-items/${from.id}/merge`, { intoStockItemId: from.id, reason: 'x' })).statusCode).toBe(400);
    expect((await admin(h, 'POST', `/stock-items/${from.id}/merge`, { intoStockItemId: (await sellerItem(h, newId(), 1)).id, reason: 'x' })).statusCode).toBe(400);
    const archived = await officialItem(h, main.id, 0);
    await admin(h, 'PATCH', `/stock-items/${archived.id}`, { archived: true });
    const refused = await admin(h, 'POST', `/stock-items/${from.id}/merge`, { intoStockItemId: archived.id, reason: 'x' });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('STOCK_ITEM_ARCHIVED');

    h.events.length = 0;
    h.audits.length = 0;
    const res = await admin(h, 'POST', `/stock-items/${from.id}/merge`, { intoStockItemId: into.id, reason: 'Catalog variant merge' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ id: into.id, quantities: { available: 4, reserved: 2, incoming: 4, damagedHeld: 0, returned: 0 } });
    expect(await quantities(h, from.id)).toEqual({ available: 0, reserved: 0, incoming: 0, damagedHeld: 0, returned: 0 });
    expect((await admin(h, 'GET', `/stock-items/${from.id}`)).json().item.archived).toBe(true);
    expect(h.audits).toEqual([expect.objectContaining({ action: 'inventory.stock_item.merge', reason: 'Catalog variant merge' })]);
    const merged = (await admin(h, 'GET', `/movements?stockItemId=${into.id}`)).json().items as { reasonCode: string; reference?: { kind: string } }[];
    expect(merged.filter((m) => m.reasonCode === 'merged_in').every((m) => m.reference?.kind === 'merge')).toBe(true);
    expect(eventsNamed(h, 'inventory.stock.changed').map((e) => [e.stockItemId, e.cause]).sort()).toEqual([[from.id, 'merge'], [into.id, 'merge']].sort());

    // the moved reservation line is still matched by its order item
    await dispatched(orderId, [{ orderItemId: itemId, quantity: 2 }]);
    expect(await quantities(h, into.id)).toMatchObject({ available: 4, reserved: 0 });
    await consistent();
  });

  it('catalog.product.merged re-points company items to the kept product and variant, and raises a merge when the kept variant has a twin', async () => {
    const dup = newId();
    const kept = newId();
    const keptVariant = newId();
    const a = await officialItem(h, main.id, 2, { productId: dup });
    const twin = await officialItem(h, main.id, 1, { productId: kept, variantId: keptVariant });
    const merged = { keptProductId: kept, duplicateProductId: dup, newVariantId: null, intoVariantId: keptVariant, reason: 'Duplicate listing' };
    h.app.kernel.events.publish('catalog', 'catalog.product.merged', merged);
    await h.app.kernel.events.drain();
    const refs = await h.api.getStockItems([a.id]);
    expect(refs[0]).toMatchObject({ productId: kept, variantId: keptVariant });
    expect(h.raised).toEqual([expect.objectContaining({ queueKey: 'inventory.low_stock', kind: 'manual_task', sourceModule: 'inventory', subject: expect.objectContaining({ type: 'stock_item', id: a.id }), dedupeKey: `inventory.merge_candidate:${a.id}:${twin.id}` })]);
    h.app.kernel.events.publish('catalog', 'catalog.product.merged', merged); // redelivered: nothing left on the duplicate
    await h.app.kernel.events.drain();
    expect(h.raised).toHaveLength(1);
  });
});

describe('discrepancy photos', () => {
  it('attaches photos as inspection_photo (so the orphan sweep keeps them); an unknown photo is a validation error', async () => {
    expect(h.app.kernel.modules).toContain('media');
    const media = h.app.kernel.boot.apis.get('media') as { attach: (...a: unknown[]) => Promise<void>; detach: (...a: unknown[]) => Promise<void> };
    const attach = vi.spyOn(media, 'attach').mockResolvedValue(undefined);
    const detach = vi.spyOn(media, 'detach').mockResolvedValue(undefined);
    try {
      const a = await officialItem(h, main.id, 3);
      const photo = newId();
      const d = await h.api.reportDiscrepancy({ kind: 'damage_found', stockItemId: a.id, locationId: main.id, quantity: 1, note: 'Crushed box', photoIds: [photo], reportedBy: { kind: 'staff', id: newId() } });
      expect(attach).toHaveBeenCalledWith(photo, expect.objectContaining({ module: 'inventory', kind: 'inspection_photo', refId: d.id }), { kind: 'platform' });

      const bad = newId();
      attach.mockImplementation(async (id) => {
        if (id === bad) throw new AppError('NOT_FOUND', 'File not found');
      });
      await expect(h.api.reportDiscrepancy({ kind: 'damage_found', stockItemId: a.id, locationId: main.id, quantity: 1, photoIds: [photo, bad], reportedBy: { kind: 'staff' } })).rejects.toMatchObject({ code: 'VALIDATION_FAILED', details: { issues: [{ path: 'photoIds[1]' }] } });
      expect(detach).toHaveBeenCalledWith(photo, expect.objectContaining({ kind: 'inspection_photo' }));
      expect(await quantities(h, a.id)).toMatchObject({ available: 2, damagedHeld: 1 }); // the refused report moved nothing
    } finally {
      attach.mockRestore();
      detach.mockRestore();
    }
  });
});

describe('reads for other modules', () => {
  it('getSalesRate: units dispatched to orders over the window, net of restocked returns', async () => {
    const a = await officialItem(h, main.id, 20);
    const r = await h.api.hold(`chk-${newId()}`, [{ stockItemId: a.id, quantity: 6 }]);
    const orderId = newId();
    const itemId = newId();
    await accepted(orderId, r.id, [{ orderItemId: itemId, stockItemId: a.id, quantity: 6 }]);
    await dispatched(orderId, [{ orderItemId: itemId, quantity: 6 }]);
    const unknown = newId();
    expect(await h.api.getSalesRate([a.id, unknown], 30)).toEqual({ [a.id]: { unitsSold: 6, days: 30, avgDailySales: 0.2 }, [unknown]: { unitsSold: 0, days: 30, avgDailySales: 0 } });
    expect((await h.api.getSalesRate([a.id]))[a.id]).toMatchObject({ days: 30, unitsSold: 6 });
  });

  it('StockItemRef carries the variant GTIN from catalog', async () => {
    const productId = newId();
    const variantId = newId();
    h.products.set(productId, { id: productId, title: 'Aurora', variants: [{ id: variantId, options: { Color: 'Black' }, images: [], gtin: '4006381333931' }] });
    const a = await officialItem(h, main.id, 1, { productId, variantId });
    expect((await h.api.getStockItems([a.id]))[0]).toMatchObject({ gtin: '4006381333931' });
  });

  it('stock.low carries productId and variantId', async () => {
    const sellerId = newId();
    const a = await sellerItem(h, sellerId, 10, { lowStockThreshold: 5 });
    h.events.length = 0;
    const res = await admin(h, 'GET', `/stock-items/${a.id}`, undefined, staffHeaders());
    expect(res.statusCode).toBe(200);
    await h.api.applyBulkQuantities(sellerId, [{ stockItemId: a.id, newAvailable: 2 }], newId(), { kind: 'seller', id: sellerId });
    await h.app.kernel.events.drain();
    expect(eventsNamed(h, 'inventory.stock.low')).toEqual([expect.objectContaining({ stockItemId: a.id, productId: a.productId, variantId: a.variantId, available: 2, threshold: 5 })]);
  });
});
