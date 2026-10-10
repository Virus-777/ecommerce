/** Deliveries, receiving records, inventory hand-off, closing short, claims, jobs and the public API. */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import type { PurchasingPublicApi } from '../../../spec/purchasing.js';
import { api, auditActions, ken, LOCATION, makeStubs, purchasingApp, recordEvents, usd } from './helpers.js';

const stubs = makeStubs();
let app: FastifyInstance;
let clock: Awaited<ReturnType<typeof purchasingApp>>['clock'];
let call: ReturnType<typeof api>;
let events: Record<string, any[]>;
const purchasing = () => app.kernel.boot.apis.get('purchasing') as PurchasingPublicApi & { suggestions: unknown };
const headphones = stubs.addStock({ sku: 'HAL-AUR-BLK', label: 'Halden Aurora ANC Headphones, Black', available: 4, threshold: 10 });
const speaker = stubs.addStock({ sku: 'HAL-PKT-TEAL', label: 'Pocket Bluetooth Speaker, Teal', available: 3, threshold: 5 });

beforeAll(async () => {
  ({ app, clock } = await purchasingApp(stubs));
  call = api(app);
  events = recordEvents(app, [
    'purchasing.delivery.rescheduled',
    'purchasing.delivery.arrived',
    'purchasing.delivery.late',
    'purchasing.receipt.recorded',
    'purchasing.purchase_order.status_changed',
    'purchasing.claim.settled',
  ]);
});
afterAll(async () => {
  await app?.close();
});
beforeEach(() => {
  for (const f of Object.values(stubs.inventory)) f.mockClear();
  stubs.audit.record.mockClear();
});

async function sentOrder(lines = [
  { stockItemId: headphones, quantity: 100, unitCost: usd(9500) },
  { stockItemId: speaker, quantity: 50, unitCost: usd(4000) },
]) {
  const s = (await call('POST', '/suppliers', { name: `Supplier ${newId().slice(-4)}`, email: 'ops@supplier.example', leadTimeDays: 5 })).json();
  const po = (await call('POST', '/purchase-orders', { supplierId: s.id, shipToLocationId: LOCATION, lines, freight: usd(15000), expectedDate: '2026-10-09' })).json();
  const sent = await call('POST', `/purchase-orders/${po.id}/send`, {});
  expect(sent.statusCode, sent.body).toBe(200);
  return { supplier: s, po: sent.json() };
}

async function arrivedDelivery(poId: string) {
  const d = await call('POST', `/purchase-orders/${poId}/deliveries`, { carrier: 'Freight · 2 pallets', trackingRef: 'BOL 77120', windowFrom: '2026-10-09T17:00:00Z', windowTo: '2026-10-09T19:00:00Z' });
  expect(d.statusCode, d.body).toBe(201);
  const a = await call('POST', `/deliveries/${d.json().id}/arrive`, { dock: '2' });
  expect(a.statusCode, a.body).toBe(200);
  return a.json();
}

describe('deliveries', () => {
  it('adds, reschedules, delays and checks in a delivery', async () => {
    const { po } = await sentOrder();
    const draftPo = (await call('POST', '/purchase-orders', { supplierId: po.supplier.id, shipToLocationId: LOCATION, lines: [{ stockItemId: headphones, quantity: 1, unitCost: usd(1) }] })).json();
    expect((await call('POST', `/purchase-orders/${draftPo.id}/deliveries`, { windowFrom: '2026-10-10T17:00:00Z', windowTo: '2026-10-10T19:00:00Z' })).json().error.code).toBe('ILLEGAL_TRANSITION');

    const d = (await call('POST', `/purchase-orders/${po.id}/deliveries`, { carrier: 'UPS Freight', windowFrom: '2026-10-12T17:00:00Z', windowTo: '2026-10-12T19:00:00Z' })).json();
    expect(d).toMatchObject({ purchaseOrderRef: po.ref, status: 'expected', units: 150, lineCount: 2, receiptId: null });

    const moved = await call('PATCH', `/deliveries/${d.id}`, { windowFrom: '2026-10-13T17:00:00Z', windowTo: '2026-10-13T19:00:00Z', reason: 'Supplier backorder' });
    expect(moved.statusCode, moved.body).toBe(200);
    expect(moved.json()).toMatchObject({ status: 'expected', windowFrom: '2026-10-13T17:00:00.000Z', delayReason: 'Supplier backorder' });
    const delayed = await call('PATCH', `/deliveries/${d.id}`, { delayed: true, reason: 'Truck broke down' });
    expect(delayed.json().status).toBe('delayed');
    await app.kernel.events.drain();
    expect(events['purchasing.delivery.rescheduled']!.at(-1)).toMatchObject({ deliveryId: d.id, purchaseOrderId: po.id, ref: po.ref, reason: 'Truck broke down' });
    expect((await call('GET', `/purchase-orders?lateOrShort=true`)).json().items.map((r: { id: string }) => r.id)).toContain(po.id);

    const arrived = await call('POST', `/deliveries/${d.id}/arrive`, { dock: '2', note: 'Two pallets' });
    expect(arrived.json()).toMatchObject({ status: 'arrived', dock: '2', arrivedAt: expect.any(String) });
    await app.kernel.events.drain();
    expect(events['purchasing.delivery.arrived']!.at(-1)).toMatchObject({ deliveryId: d.id, ref: po.ref, dock: '2' });
    expect((await call('POST', `/deliveries/${d.id}/arrive`, {})).json().error.code).toBe('ILLEGAL_TRANSITION');
    expect((await call('PATCH', `/deliveries/${d.id}`, { delayed: true, reason: 'x' })).json().error.code).toBe('ILLEGAL_TRANSITION');

    const listed = (await call('GET', `/deliveries?purchaseOrderId=${po.id}`)).json().items;
    expect(listed).toEqual([expect.objectContaining({ id: d.id, status: 'arrived' })]);
    expect((await call('GET', '/deliveries?date=2026-10-13')).json().items.some((x: { id: string }) => x.id === d.id)).toBe(true);
  });

  it('the late-delivery job delays deliveries past their window and publishes delivery.late', async () => {
    const { po } = await sentOrder();
    const d = (await call('POST', `/purchase-orders/${po.id}/deliveries`, { windowFrom: '2026-10-09T15:30:00Z', windowTo: '2026-10-09T16:30:00Z' })).json();
    await app.kernel.jobs.runNow('purchasing.flag-late-deliveries');
    expect((await call('GET', `/deliveries?purchaseOrderId=${po.id}`)).json().items[0].status).toBe('expected'); // within the 60-minute grace
    clock.advance(60 * 60_000);
    await app.kernel.jobs.runNow('purchasing.flag-late-deliveries');
    await app.kernel.events.drain();
    expect((await call('GET', `/deliveries?purchaseOrderId=${po.id}`)).json().items[0]).toMatchObject({ status: 'delayed', delayReason: expect.any(String) });
    expect(events['purchasing.delivery.late']!.filter((e) => e.deliveryId === d.id)).toEqual([{ deliveryId: d.id, purchaseOrderId: po.id, ref: po.ref, supplierName: po.supplier.name }]);
    await app.kernel.jobs.runNow('purchasing.flag-late-deliveries'); // idempotent
    await app.kernel.events.drain();
    expect(events['purchasing.delivery.late']!.filter((e) => e.deliveryId === d.id)).toHaveLength(1);
    clock.set('2026-10-09T17:00:00.000Z');
  });
});

describe('receiving', () => {
  it('counts, submits to inventory with buying cost, and updates the purchase order', async () => {
    const { po } = await sentOrder();
    const d = await arrivedDelivery(po.id);
    const started = await call('POST', `/deliveries/${d.id}/receipts`);
    expect(started.statusCode, started.body).toBe(201);
    const r = started.json();
    expect(r.ref).toMatch(/^REC-261009-\d{2}$/);
    expect(r).toMatchObject({ status: 'in_progress', purchaseOrderRef: po.ref, totals: { expected: 150, received: 0 }, receivedBy: { id: ken.id } });
    const again = await call('POST', `/deliveries/${d.id}/receipts`);
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toMatchObject({ code: 'RECEIPT_IN_PROGRESS', details: { receiptId: r.id } });

    const [hp, sp] = r.lines;
    const over = await call('PATCH', `/receipts/${r.id}`, { lines: [{ purchaseOrderLineId: hp.purchaseOrderLineId, received: 101, damaged: 0 }] });
    expect(over.statusCode).toBe(400);
    expect(over.json().error).toMatchObject({ code: 'OVER_RECEIPT', details: { lines: [{ purchaseOrderLineId: hp.purchaseOrderLineId }] } });
    const tooDamaged = await call('PATCH', `/receipts/${r.id}`, { lines: [{ purchaseOrderLineId: hp.purchaseOrderLineId, received: 1, damaged: 2 }] });
    expect(tooDamaged.json().error.code).toBe('VALIDATION_FAILED');

    const counted = await call('PATCH', `/receipts/${r.id}`, {
      lines: [
        { purchaseOrderLineId: hp.purchaseOrderLineId, received: 100, damaged: 2, binCode: 'A-03-2' },
        { purchaseOrderLineId: sp.purchaseOrderLineId, received: 30, damaged: 0 },
      ],
      note: 'Pallet 2 wrapped badly',
    });
    expect(counted.statusCode, counted.body).toBe(200);
    expect(counted.json()).toMatchObject({ totals: { received: 130, damaged: 2, shortage: 20 }, buyingCost: usd(100 * 9500 + 30 * 4000) });

    const noPhoto = await call('POST', `/receipts/${r.id}/submit`, {});
    expect(noPhoto.statusCode).toBe(400);
    expect(noPhoto.json().error).toMatchObject({ code: 'DAMAGE_PHOTOS_REQUIRED', details: { lines: [hp.purchaseOrderLineId] } });

    const photo = newId();
    const withPhoto = await call('PATCH', `/receipts/${r.id}`, { lines: [{ purchaseOrderLineId: hp.purchaseOrderLineId, received: 100, damaged: 2, photoIds: [photo] }] });
    expect(withPhoto.json().lines[0].photos).toEqual([expect.objectContaining({ id: photo })]);
    expect(stubs.media.attach).toHaveBeenCalledWith(photo, { module: 'purchasing', kind: 'inspection_photo', refId: r.id, refLabel: r.ref }, { kind: 'staff', id: 'someone' });

    const submitted = await call('POST', `/receipts/${r.id}/submit`, { raiseClaims: true });
    expect(submitted.statusCode, submitted.body).toBe(200);
    expect(submitted.json()).toMatchObject({ status: 'awaiting_confirmation', submittedAt: expect.any(String), totals: { sellable: null } });
    // freight $150.00 split by line value (950,000 : 200,000) → 12,391 and 2,609 cents; per unit 124 and 52
    expect(stubs.inventory.submitInbound).toHaveBeenCalledWith(
      expect.objectContaining({
        receiptId: r.id,
        receiptRef: r.ref,
        purchaseOrderId: po.id,
        locationId: LOCATION,
        lines: [
          { stockItemId: headphones, expected: 100, received: 100, damaged: 2, binCode: 'A-03-2', unitCost: usd(9624) },
          { stockItemId: speaker, expected: 50, received: 30, damaged: 0, unitCost: usd(4052) },
        ],
      }),
    );
    expect(stubs.inventory.expectIncoming).toHaveBeenLastCalledWith(po.id, po.ref, LOCATION, [{ stockItemId: speaker, quantity: 20, expectedDate: '2026-10-09' }]);
    await app.kernel.events.drain();
    expect(events['purchasing.receipt.recorded']!.at(-1)).toMatchObject({ receiptId: r.id, purchaseOrderId: po.id, locationId: LOCATION, hasIssues: true });
    expect(events['purchasing.purchase_order.status_changed']!.at(-1)).toMatchObject({ purchaseOrderId: po.id, from: 'sent', to: 'partly_received' });
    expect(auditActions(stubs)).toContain('purchasing.receipt.submit');

    const after = (await call('GET', `/purchase-orders/${po.id}`)).json();
    expect(after).toMatchObject({ status: 'partly_received', receivedValue: usd(1070000) });
    expect(after.lines[1]).toMatchObject({ quantityReceived: 30, quantityOpen: 20, note: 'Rest due Oct 9' });
    expect(after.claims.map((c: { kind: string; amount: unknown }) => [c.kind, c.amount])).toEqual(
      expect.arrayContaining([['shortage', usd(80000)], ['damage', usd(19000)]]),
    );
    expect(after.deliveries[0]).toMatchObject({ status: 'received_with_issues', receiptId: r.id });
    expect((await call('GET', `/receipts?withIssues=true&purchaseOrderId=${po.id}`)).json().items).toHaveLength(1);

    // the Inventory Manager confirms in inventory
    const confirm = () =>
      app.kernel.events.publish('inventory', 'inventory.receipt.confirmed', {
        inboundId: newId(), receiptId: r.id, purchaseOrderId: po.id, confirmedBy: { kind: 'staff', id: newId(), name: 'Ana Silva' },
        lines: [{ stockItemId: headphones, sku: 'HAL-AUR-BLK', label: 'Headphones', expected: 100, received: 100, damaged: 2, shortage: 0, unitCost: usd(9624), sellable: 98, outOfStockNow: false }],
      });
    confirm();
    confirm();
    await app.kernel.events.drain();
    const confirmed = (await call('GET', `/receipts/${r.id}`)).json();
    expect(confirmed).toMatchObject({ status: 'confirmed', confirmedBy: { name: 'Ana Silva' }, totals: { sellable: 128 } });
    const timeline = (await call('GET', `/purchase-orders/${po.id}`)).json().timeline.filter((t: { label: string }) => t.label.startsWith('Stock made available'));
    expect(timeline).toHaveLength(1);

    // receiving stats see the open shortages
    const stats = (await call('GET', '/deliveries/stats')).json();
    expect(stats).toMatchObject({ date: '2026-10-09', openShortages: expect.any(Number), shortageOwner: { id: ken.id } });
    expect(stats.openShortages).toBeGreaterThanOrEqual(2);
    expect(stats.receivedThisWeek).toBeGreaterThanOrEqual(1);

    // cancel is refused once units arrived; close short instead
    expect((await call('POST', `/purchase-orders/${po.id}/cancel`, { reason: 'x' })).json().error.code).toBe('ILLEGAL_TRANSITION');
    const closed = await call('POST', `/purchase-orders/${po.id}/close`, { reason: 'Supplier discontinued the teal speaker', raiseShortageClaim: true });
    expect(closed.statusCode, closed.body).toBe(200);
    expect(closed.json()).toMatchObject({ status: 'received', closedAt: expect.any(String) });
    expect(closed.json().lines[1]).toMatchObject({ quantityClosed: 20, quantityOpen: 0, note: 'Closed short' });
    expect(stubs.inventory.cancelIncoming).toHaveBeenCalledWith(po.id, [{ stockItemId: speaker, quantity: 20 }]);
    expect(closed.json().claims).toHaveLength(3);
    expect(auditActions(stubs)).toContain('purchasing.purchase_order.close_short');

    const rows = (await purchasing().exportRows('purchasing.admin.receiving', { purchaseOrderId: po.id }, { kind: 'staff', accountId: ken.id })).rows;
    expect(rows).toEqual([
      expect.objectContaining({ receiptRef: r.ref, sku: 'HAL-AUR-BLK', received: 100, damaged: 2, binCode: 'A-03-2' }),
      expect.objectContaining({ receiptRef: r.ref, sku: 'HAL-PKT-TEAL', received: 30, shortage: 20 }),
    ]);
    await expect(purchasing().exportRows('purchasing.admin.receiving', {}, { kind: 'customer', accountId: newId() })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('receives in full, refuses a cancel with receipts, and lets a mistaken receipt be discarded and restarted', async () => {
    const { po } = await sentOrder([{ stockItemId: headphones, quantity: 10, unitCost: usd(9500) }]);
    const d = await arrivedDelivery(po.id);
    const first = (await call('POST', `/deliveries/${d.id}/receipts`)).json();
    const cancelPo = await call('POST', `/purchase-orders/${po.id}/cancel`, { reason: 'Changed my mind' });
    expect(cancelPo.statusCode).toBe(409);
    expect(cancelPo.json().error.code).toBe('PO_HAS_RECEIPTS');
    const discarded = await call('POST', `/receipts/${first.id}/cancel`, { reason: 'Wrong delivery' });
    expect(discarded.statusCode, discarded.body).toBe(200);
    expect(discarded.json().status).toBe('cancelled');
    expect(auditActions(stubs)).toContain('purchasing.receipt.cancel');

    const second = (await call('POST', `/deliveries/${d.id}/receipts`)).json();
    expect(second.id).not.toBe(first.id);
    await call('PATCH', `/receipts/${second.id}`, { lines: [{ purchaseOrderLineId: second.lines[0].purchaseOrderLineId, received: 10, damaged: 0 }] });
    const done = await call('POST', `/receipts/${second.id}/submit`, {});
    expect(done.statusCode, done.body).toBe(200);
    const after = (await call('GET', `/purchase-orders/${po.id}`)).json();
    expect(after).toMatchObject({ status: 'received', lines: [expect.objectContaining({ quantityOpen: 0, note: 'Complete' })] });
    expect(after.deliveries[0]).toMatchObject({ status: 'received', receiptId: second.id });
    expect((await call('POST', `/receipts/${second.id}/submit`, {})).json().error.code).toBe('ILLEGAL_TRANSITION');
    expect((await call('PATCH', `/receipts/${second.id}`, { lines: [] })).json().error.code).toBe('ILLEGAL_TRANSITION');
  });
});

describe('supplier claims', () => {
  it('opens, submits and settles a claim; withdraws another', async () => {
    const { po } = await sentOrder([{ stockItemId: headphones, quantity: 10, unitCost: usd(9500) }]);
    const bad = await call('POST', '/claims', { purchaseOrderId: po.id, kind: 'wrong_item', lines: [{ stockItemId: speaker, sku: 'X', quantity: 1, unitCost: usd(100) }] });
    expect(bad.json().error).toMatchObject({ code: 'VALIDATION_FAILED', details: { issues: [{ path: 'lines.0.stockItemId' }] } });

    const created = await call('POST', '/claims', { purchaseOrderId: po.id, kind: 'wrong_item', lines: [{ stockItemId: headphones, sku: 'HAL-AUR-BLK', quantity: 2, unitCost: usd(9500) }], notes: 'Silver instead of black' });
    expect(created.statusCode, created.body).toBe(201);
    const c = created.json();
    expect(c).toMatchObject({ status: 'open', amount: usd(19000), owner: { id: ken.id }, purchaseOrderRef: po.ref, supplierName: po.supplier.name });
    expect(c.ref).toMatch(/^CLM-261009-\d{3}$/);

    expect((await call('POST', `/claims/${c.id}/settle`, { settlement: 'credit_note', amount: usd(19000), reason: 'x' })).json().error.code).toBe('ILLEGAL_TRANSITION');
    const submitted = await call('POST', `/claims/${c.id}/submit`, { supplierReference: 'RMA-5521' });
    expect(submitted.json()).toMatchObject({ status: 'submitted', notes: expect.stringContaining('RMA-5521') });
    const settled = await call('POST', `/claims/${c.id}/settle`, { settlement: 'credit_note', amount: usd(19000), reason: 'Credit note CN-88 received' });
    expect(settled.statusCode, settled.body).toBe(200);
    expect(settled.json()).toMatchObject({ status: 'settled', settlement: 'credit_note', settledAmount: usd(19000), decidedAt: expect.any(String) });
    await app.kernel.events.drain();
    expect(events['purchasing.claim.settled']!.at(-1)).toEqual({ claimId: c.id, supplierId: po.supplier.id, purchaseOrderId: po.id, settlement: 'credit_note', amount: usd(19000) });
    expect(auditActions(stubs)).toEqual(expect.arrayContaining(['purchasing.claim.create', 'purchasing.claim.submit', 'purchasing.claim.settle']));

    const other = (await call('POST', '/claims', { purchaseOrderId: po.id, kind: 'other', lines: [{ stockItemId: headphones, sku: 'HAL-AUR-BLK', quantity: 1, unitCost: usd(9500) }] })).json();
    expect((await call('POST', `/claims/${other.id}/close`, { outcome: 'rejected', reason: 'x' })).json().error.code).toBe('ILLEGAL_TRANSITION');
    const withdrawn = await call('POST', `/claims/${other.id}/close`, { outcome: 'withdrawn', reason: 'Found the unit' });
    expect(withdrawn.json()).toMatchObject({ status: 'withdrawn' });
    const open = (await call('GET', `/claims?supplierId=${po.supplier.id}&status=settled`)).json().items;
    expect(open.map((x: { id: string }) => x.id)).toEqual([c.id]);
  });
});

describe('reorder suggestions and public API', () => {
  it('suggests low company stock with its preferred supplier and creates drafts from suggestions', async () => {
    const s = (await call('POST', '/suppliers', { name: 'Brightline US', leadTimeDays: 4 })).json();
    const lamp = stubs.addStock({ sku: 'BRT-LAMP', label: 'Brightline desk lamp', available: 2, threshold: 8 });
    await call('PUT', `/suppliers/${s.id}/items`, { items: [{ stockItemId: lamp, unitCost: usd(2800), minOrderQuantity: 12, preferred: true }] });
    const list = await call('GET', `/reorder-suggestions?supplierId=${s.id}`);
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json().items).toEqual([
      expect.objectContaining({ stockItemId: lamp, sku: 'BRT-LAMP', available: 2, reorderPoint: 8, incoming: 0, suggestedQuantity: 14, supplier: expect.objectContaining({ id: s.id }), unitCost: usd(2800), estimatedCost: usd(39200) }),
    ]);

    // inventory.stock.low adds company items to the candidates; seller items are ignored
    const loose = stubs.addStock({ sku: 'LOOSE', label: 'Loose item', available: 0, threshold: 3 });
    app.kernel.events.publish('inventory', 'inventory.stock.low', { stockItemId: loose, ownerType: 'official', productId: newId(), variantId: newId(), sku: 'LOOSE', label: 'Loose item', available: 0, threshold: 3 });
    app.kernel.events.publish('inventory', 'inventory.stock.low', { stockItemId: newId(), ownerType: 'seller', sellerId: newId(), productId: newId(), variantId: newId(), sku: 'S', label: 'S', available: 0, threshold: 3 });
    await app.kernel.events.drain();
    const all = (await call('GET', '/reorder-suggestions?limit=100')).json().items;
    expect(all.find((x: { stockItemId: string }) => x.stockItemId === loose)).toMatchObject({ supplier: null, suggestedQuantity: 6 });
    await app.kernel.jobs.runNow('purchasing.reorder-suggestions');

    const created = await call('POST', '/purchase-orders/from-suggestions', { stockItemIds: [lamp], quantities: { [lamp]: 24 } });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json()).toEqual([expect.objectContaining({ status: 'draft', supplier: expect.objectContaining({ id: s.id }), total: usd(67200), lines: [expect.objectContaining({ stockItemId: lamp, quantityOrdered: 24, expectedDate: '2026-10-13' })] })]);
    // drafted units cover the gap: no longer suggested
    expect((await call('GET', `/reorder-suggestions?supplierId=${s.id}`)).json().items).toEqual([]);
    const noSupplier = await call('POST', '/purchase-orders/from-suggestions', { stockItemIds: [loose] });
    expect(noSupplier.json().error.code).toBe('VALIDATION_FAILED');
  });

  it('reports open purchase orders per stock item and recomputes supplier performance', async () => {
    const { po, supplier } = await sentOrder([{ stockItemId: speaker, quantity: 40, unitCost: usd(4000) }]);
    const open = await purchasing().getOpenPurchaseOrders(speaker);
    expect(open).toEqual(expect.arrayContaining([{ purchaseOrderId: po.id, ref: po.ref, quantityOpen: 40, expectedDate: '2026-10-09' }]));
    expect(await purchasing().getPreferredSupplier(newId())).toBeNull();

    const d = await arrivedDelivery(po.id);
    const r = (await call('POST', `/deliveries/${d.id}/receipts`)).json();
    await call('PATCH', `/receipts/${r.id}`, { lines: [{ purchaseOrderLineId: r.lines[0].purchaseOrderLineId, received: 36, damaged: 0 }] });
    await call('POST', `/receipts/${r.id}/submit`, {});
    clock.advance(60_000);
    await app.kernel.jobs.runNow('purchasing.supplier-performance');
    const detail = (await call('GET', `/suppliers/${supplier.id}`)).json();
    expect(detail.performance).toMatchObject({ windowDays: 90, deliveries: 1, onTimePct: 100, shortageRatePct: 10, damageRatePct: 0 });
    expect(detail.supplier.onTimePct).toBe(100);
    expect(detail.recentPurchaseOrders[0]).toMatchObject({ id: po.id, status: 'partly_received', lateOrShort: true });
  });
});
