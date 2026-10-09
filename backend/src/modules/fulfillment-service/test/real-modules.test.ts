/**
 * With real modules (identity, access, sellers, catalog, offers, inventory, orders, finance, warehouse; the seller
 * signs in for real): a seller with a live offer enrolls in the service, enrolls the offer's SKU, sends an inbound
 * shipment that is received into its seller-owned stock (inventory's stock item of the offer), an order of the
 * offer becomes a fulfillment request reserving those units, and the fees post to the seller's finance ledger.
 *
 * Not reachable end to end without spec changes (see the module report): checkout marks the group
 * fulfilledBy 'seller', warehouse has no public API to pick a seller group, so the dispatch is the
 * shipping.shipment.dispatched event published here.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { withDependencies } from '../../../kernel/module-system/loader.js';
import type { FulfillmentServicePublicApi } from '../../../spec/fulfillment-service.js';
import type { InventoryPublicApi } from '../../../spec/inventory.js';
import type { OrderCreateInput, OrdersPublicApi } from '../../../spec/orders.js';
import { auth, buildTestApp, callers, movingClock } from '../../../testing/app.js';
import { flows, type Flows, type Listing } from '../../../testing/flows.js';
import { financeStubs, type FinanceEntry } from './helpers.js';

const clock = movingClock();
const financeLedger: FinanceEntry[] = [];
let app: FastifyInstance;
let f: Flows;
let listing: Listing;
const staff = callers.staff();
const USD = (amount: number) => ({ amount, currency: 'USD' });
const ADDRESS = { name: 'Ben Ortiz', line1: '1120 SW 5th Ave', city: 'Portland', region: 'OR', postalCode: '97204', country: 'US', phone: '+15035550101' };

beforeAll(async () => {
  app = await buildTestApp({
    only: withDependencies(['identity', 'access', 'audit', 'media', 'notifications', 'settings', 'customers', 'sellers', 'catalog', 'inventory', 'offers', 'orders', 'finance', 'warehouse', 'fulfillment-service']),
    clock,
    config: { rateLimits: false, launchPhase: 4 },
    // finance.recordServiceFee / creditSellerCharge are being built in finance: stubbed per src/spec/finance.ts
    apiStubs: { finance: financeStubs(financeLedger) as never },
  });
  f = flows(app, clock);
  listing = await f.liveListing({ quantity: 2 });
});
afterAll(async () => {
  await app?.close();
});

const api = <T>(m: string) => app.kernel.boot.apis.get(m) as T;
async function call(method: string, url: string, o: { token?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const res = await app.inject({ method: method as never, url, headers: { ...auth(o.token ?? staff), ...(o.headers ?? {}) }, ...(o.body !== undefined ? { payload: o.body as never } : {}) });
  await app.kernel.events.drain();
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}
const S = (p: string) => `/api/seller/fulfillment-service${p}`;
const A = (p: string) => `/api/admin/fulfillment-service${p}`;

describe('a seller stores and ships with Marketly (real modules)', () => {
  it('enrolls, sends stock that is received into seller-owned stock, fulfils an order and is charged on its ledger', async () => {
    const inventory = api<InventoryPublicApi>('inventory');
    const orders = api<OrdersPublicApi>('orders');
    const service = api<FulfillmentServicePublicApi>('fulfillment-service');
    const seller = listing.sellerToken;

    // enrollment under the service terms
    const schedule = await call('GET', S('/fee-schedule'), { token: seller });
    expect(schedule.status, JSON.stringify(schedule.body)).toBe(200);
    const applied = await call('POST', S('/enrollment'), { token: seller, body: { expectedSkus: 2, expectedMonthlyUnits: 50, categories: [listing.categoryId], termsVersion: 'FS-TERMS-1', feeScheduleVersion: schedule.body.current.version, acceptTerms: true } });
    expect(applied.status, JSON.stringify(applied.body)).toBe(201);
    expect(applied.body.sellerName).not.toBe('Seller');
    expect((await call('POST', A(`/enrollments/${applied.body.id}/decide`), { body: { decision: 'approve', reason: 'Welcome aboard' } })).body.state).toBe('approved');

    // the live offer's SKU: product and seller SKU from the offer's stock item in inventory
    const stockItem = (await inventory.getStockForOffers([listing.offerId], { sellerId: listing.sellerId }))[listing.offerId]!;
    const sku = await call('POST', S('/skus'), { token: seller, body: { offerId: listing.offerId, dimensionsCm: { length: 20, width: 18, height: 9 }, weightGrams: 450, hazmat: false } });
    expect(sku.status, JSON.stringify(sku.body)).toBe(201);
    expect(sku.body).toMatchObject({ productId: listing.productId, sku: stockItem.sku, title: stockItem.label, state: 'pending', sizeTier: 'standard' });
    expect((await call('POST', A(`/skus/${sku.body.id}/review`), { body: { approve: true } })).body.state).toBe('approved');
    expect(await service.isServiceOffer(listing.offerId)).toBe(false);

    // the seller's own units leave the offer's stock item (inventory keeps one item per offer and can't tell
    // units the seller holds from units at our warehouse), then the inbound shipment is received into it
    await inventory.applyBulkQuantities(listing.sellerId, [{ stockItemId: stockItem.id, newAvailable: 0 }], newId(), { kind: 'seller', id: listing.sellerId });
    const before = (await inventory.getAvailability([stockItem.id]))[stockItem.id]!.available;
    expect(before).toBe(0);
    const inbound = await call('POST', S('/inbound'), { token: seller, body: { shipFrom: ADDRESS, lines: [{ skuEnrollmentId: sku.body.id, quantity: 6 }], boxes: 1 } });
    expect(inbound.status, JSON.stringify(inbound.body)).toBe(201);
    const id = inbound.body.id;
    const submitted = await call('POST', S(`/inbound/${id}/submit`), { token: seller });
    expect(submitted.body.state).toBe('submitted');
    expect(submitted.body.labels).toHaveLength(1);
    expect((await call('POST', S(`/inbound/${id}/ship`), { token: seller, body: { carrier: 'UPS', tracking: '1Z999AA10123456784' } })).body.state).toBe('in_transit');
    expect((await call('POST', A(`/inbound/${id}/arrive`), { body: { boxesArrived: 1 } })).body.state).toBe('arrived');
    const received = await call('POST', A(`/inbound/${id}/receive`), { body: { lines: [{ skuEnrollmentId: sku.body.id, received: 6, damaged: 0 }], complete: true }, headers: { 'idempotency-key': newId() } });
    expect(received.status, JSON.stringify(received.body)).toBe(200);
    expect(received.body.state).toBe('closed');
    expect((await inventory.getAvailability([stockItem.id]))[stockItem.id]!.available).toBe(before + 6);
    expect(await service.stockOwner(stockItem.id)).toEqual({ kind: 'seller', sellerId: listing.sellerId });
    expect(await service.isServiceOffer(listing.offerId)).toBe(true);
    const overview = await call('GET', S('/overview'), { token: seller });
    expect(overview.body).toMatchObject({ enrollment: { state: 'active' }, stockTotals: { available: 6, reserved: 0 } });

    // an order of the offer: orders.order.placed routes the seller group to our warehouse
    const hold = await inventory.hold(`hold-${newId()}`, [{ stockItemId: stockItem.id, quantity: 2 }]);
    const day = (n: number) => new Date(clock.now().getTime() + n * 86_400_000).toISOString().slice(0, 10);
    const input: OrderCreateInput = {
      checkoutSessionId: newId(),
      contact: { kind: 'guest', name: 'Ben Ortiz', email: 'ben@example.com', phone: null },
      channel: 'web',
      currency: 'USD',
      deliveryAddress: ADDRESS,
      giftNote: null,
      hidePricesOnSlip: false,
      policyVersions: [],
      couponCodes: [],
      paymentIntentId: newId(),
      paymentState: 'pending_check',
      paymentMethodLabel: 'Visa •••• 4242',
      groups: [
        {
          key: newId(),
          ownerType: 'seller',
          sellerId: listing.sellerId,
          shipsFrom: 'Reno, NV',
          fulfilledBy: 'seller',
          delivery: { methodName: 'Standard', carrier: 'UPS', service: 'Ground', price: USD(0), free: true, fundedBy: 'seller', arrival: { from: day(3), to: day(8) }, dispatchBy: new Date(clock.now().getTime() + 86_400_000).toISOString() },
          returnTermsSummary: '30-day returns.',
          items: [{ offerId: listing.offerId, variantId: listing.variantId, stockItemId: stockItem.id, quantity: 2, unitPrice: USD(18900), discounts: [], shippingShare: USD(0), taxShare: USD(0), returnTerms: { summary: '30-day returns.', windowDays: 30, returnShippingPaidBy: 'depends_on_reason' }, checkoutLineId: newId() }],
          totals: { items: USD(37800), discounts: USD(0), shipping: USD(0), tax: USD(0), total: USD(37800) },
        },
      ],
      totals: { items: USD(37800), discounts: USD(0), shipping: USD(0), tax: USD(0), total: USD(37800) },
    };
    const order = await orders.createOrder(input);
    const item = order.groups[0]!.items[0]!;
    await inventory.attachOrder(hold.id, order.id, [{ stockItemId: stockItem.id, orderItemId: item.id }]);
    await orders.acceptOrder(order.id, input.paymentIntentId);
    await app.kernel.events.drain();
    const requests = await call('GET', A(`/fulfillment-requests?sellerId=${listing.sellerId}`));
    expect(requests.body.items).toHaveLength(1);
    expect(requests.body.items[0]).toMatchObject({ orderId: order.id, orderRef: order.ref, sellerGroupId: order.groups[0]!.id, state: 'open', items: [{ orderItemId: item.id, offerId: listing.offerId, quantity: 2 }], warehouseTaskId: null });
    expect((await call('GET', S('/skus'), { token: seller })).body.items[0].stock).toMatchObject({ available: 4, reserved: 2 });

    // the package leaves: shipped, reserved units gone, pick-and-pack and handling fees
    app.kernel.events.publish('shipping', 'shipping.shipment.dispatched', { shipmentId: newId(), kind: 'outbound', orderId: order.id, groupId: order.groups[0]!.id, returnId: null, ownerType: 'seller', sellerId: listing.sellerId, lines: [{ orderItemId: item.id, title: 'Item', variantLabel: '', quantity: 2 }], shippedAt: clock.now().toISOString(), dispatchDueAt: null, onTime: true, trackingValid: true, estimatedArrival: null });
    await app.kernel.events.drain();
    expect((await call('GET', A(`/fulfillment-requests?sellerId=${listing.sellerId}`))).body.items[0].state).toBe('shipped');

    // the fees reach the seller's ledger in finance and the seller sees them
    await app.kernel.jobs.runNow('fulfillment-service.post-fees');
    await app.kernel.events.drain();
    const fees = await call('GET', S('/fees'), { token: seller });
    expect(fees.status, JSON.stringify(fees.body)).toBe(200);
    expect(fees.body.items.map((x: any) => [x.type, x.state]).sort()).toEqual([
      ['labelling', 'posted'],
      ['order_handling', 'posted'],
      ['pick_pack', 'posted'],
      ['receiving', 'posted'],
    ]);
    const total = fees.body.items.reduce((n: number, x: any) => n + x.amount.amount, 0);
    const lines = financeLedger.filter((e) => e.type === 'service_fee' && e.sellerId === listing.sellerId);
    expect(lines).toHaveLength(4);
    expect(lines.every((e) => e.description?.startsWith('Fulfillment service') && e.reference?.kind === 'fulfillment_service')).toBe(true);
    expect(lines.reduce((n, e) => n + e.amount.amount, 0)).toBe(total);
    const movements = await call('GET', S(`/skus/${sku.body.id}/movements`), { token: seller });
    expect(movements.body.items.map((m: any) => m.movement)).toEqual(['shipped', 'reserved', 'received', 'arrived', 'inbound_expected']);
    // reconciled with inventory (the order's reservation is in both)
    const rec = await (api<any>('fulfillment-service').parts.stock.reconcile() as Promise<{ differences: unknown[] }>);
    expect(rec.differences).toEqual([]);
  });
});
