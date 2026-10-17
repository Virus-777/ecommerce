/**
 * Fix round 2026-10-17 (Ops photo uploads), with real modules and real staff tokens (nothing stubbed): staff upload
 * photos as the Admin Center does (POST /api/admin/media/uploads with ownerKind platform) and attach them to their work.
 *
 *   a Warehouse Worker (seeded role: media.uploads.create, no media.assets.manage) uploads a damage photo
 *   → reports damage at pick with it: warehouse attaches it and inventory's discrepancy takes it too
 *   → another worker's photo is refused (ASSET_NOT_OWNED) and nothing moves
 *   → an Official Store order is shipped and delivered, the customer returns it
 *   → the worker receives the parcel with a photo; the Returns Manager inspects it with their own photo.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { withDependencies } from '../../../kernel/module-system/loader.js';
import type { InventoryPublicApi } from '../../../spec/inventory.js';
import type { OrderCreateInput, OrdersPublicApi } from '../../../spec/orders.js';
import { auth, buildTestApp, callers, movingClock, signWebhook } from '../../../testing/app.js';
import { flows, pngHeader, type Flows, type Listing, type Staff } from '../../../testing/flows.js';

const clock = movingClock();
let app: FastifyInstance;
let f: Flows;
let listing: Listing;
let worker: Staff;
let otherWorker: Staff;
let returnsManager: Staff;
/** Setup calls (bins, waves, packing) with a development token that holds every permission */
const setup = callers.staff();
const USD = (amount: number) => ({ amount, currency: 'USD' });
const ADDRESS = { name: 'Ben Ortiz', line1: '1120 SW 5th Ave', city: 'Portland', region: 'OR', postalCode: '97204', country: 'US', phone: '+15035550101' };
const W = (path: string) => `/api/admin/warehouse${path}`;
const SKU = 'HAL-AU-200-BK';

beforeAll(async () => {
  app = await buildTestApp({
    only: withDependencies(['identity', 'access', 'audit', 'media', 'notifications', 'settings', 'customers', 'sellers', 'catalog', 'inventory', 'offers', 'orders', 'shipping', 'warehouse', 'returns']),
    clock,
    config: { rateLimits: false },
  });
  f = flows(app, clock);
  listing = await f.liveListing({ quantity: 5 });
  worker = await f.staffWithRoles(listing.owner, 'wes@marketly.test', 'Wes Worker', ['warehouse_worker']);
  otherWorker = await f.staffWithRoles(listing.owner, 'ola@marketly.test', 'Ola Worker', ['warehouse_worker']);
  returnsManager = await f.staffWithRoles(listing.owner, 'rae@marketly.test', 'Rae Returns', ['returns_manager']);
}, 300_000);
afterAll(async () => {
  await app?.close();
});

const api = <T>(m: string) => app.kernel.boot.apis.get(m) as T;
async function call(method: string, url: string, token: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await app.inject({ method: method as never, url, headers: { ...auth(token), ...headers }, ...(body !== undefined ? { payload: body as never } : {}) });
  await app.kernel.events.drain();
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}
async function ok(method: string, url: string, token: string, body?: unknown, headers?: Record<string, string>) {
  const res = await call(method, url, token, body, headers);
  expect(res.status, `${method} ${url}: ${JSON.stringify(res.body)}`).toBeLessThan(300);
  return res.body;
}

/** What the Admin Center does (web-shared uploadMedia): start with ownerKind platform, PUT the bytes, complete */
async function adminUpload(token: string, purpose: string, seed: number): Promise<string> {
  const body = pngHeader(800 + seed, 600);
  const start = await call('POST', '/api/admin/media/uploads', token, { upload: { purpose, fileName: `photo-${seed}.png`, contentType: 'image/png', sizeBytes: body.length }, ownerKind: 'platform' });
  expect(start.status, JSON.stringify(start.body)).toBe(201);
  const url = new URL(start.body.url);
  const put = await app.inject({ method: 'PUT', url: url.pathname + url.search, headers: { ...auth(token), 'content-type': 'application/octet-stream' }, payload: body });
  expect(put.statusCode, put.body).toBe(204);
  expect((await call('POST', `/api/admin/media/uploads/${start.body.uploadId}/complete`, token)).status).toBe(202);
  await app.kernel.jobs.runNow('media.process');
  await app.kernel.events.drain();
  return start.body.assetId as string;
}

/** The world the steps build on */
const w = { locationId: '', stockItemId: '', offerId: '', boxId: '' };

/** An accepted Official Store order of `quantity` units and its fulfillment, waved and picking */
async function pickingOrder(quantity: number, contact: OrderCreateInput['contact']) {
  const inventory = api<InventoryPublicApi>('inventory');
  const orders = api<OrdersPublicApi>('orders');
  const hold = await inventory.hold(`hold-${newId()}`, [{ stockItemId: w.stockItemId, quantity }]);
  const day = (n: number) => new Date(clock.now().getTime() + n * 86_400_000).toISOString().slice(0, 10);
  const total = USD(17900 * quantity);
  const input: OrderCreateInput = {
    checkoutSessionId: newId(),
    contact,
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
        ownerType: 'official',
        sellerId: null,
        shipsFrom: 'Reno, NV',
        fulfilledBy: 'official_warehouse',
        delivery: { methodName: 'Standard', carrier: 'UPS', service: 'Ground', price: USD(0), free: true, fundedBy: 'company', arrival: { from: day(3), to: day(12) }, dispatchBy: new Date(clock.now().getTime() + 86_400_000).toISOString() },
        returnTermsSummary: '30-day returns.',
        items: [{ offerId: w.offerId, variantId: listing.variantId, stockItemId: w.stockItemId, quantity, unitPrice: USD(17900), discounts: [], shippingShare: USD(0), taxShare: USD(0), returnTerms: { summary: '30-day returns.', windowDays: 30, returnShippingPaidBy: 'depends_on_reason' }, checkoutLineId: newId() }],
        totals: { items: total, discounts: USD(0), shipping: USD(0), tax: USD(0), total },
      },
    ],
    totals: { items: total, discounts: USD(0), shipping: USD(0), tax: USD(0), total },
  };
  const order = await orders.createOrder(input);
  const item = order.groups[0]!.items[0]!;
  await inventory.attachOrder(hold.id, order.id, [{ stockItemId: w.stockItemId, orderItemId: item.id }]);
  await orders.acceptOrder(order.id, input.paymentIntentId);
  await app.kernel.events.drain();
  const list = await ok('GET', W(`/fulfillments?q=${order.ref}`), setup);
  const fulfillmentId = list.items[0].id as string;
  const wave = await ok('POST', W('/waves'), setup, { locationId: w.locationId });
  await ok('POST', W(`/waves/${wave.id}/start`), setup);
  const ful = await ok('GET', W(`/fulfillments/${fulfillmentId}`), setup);
  return { order, item, fulfillmentId, line: ful.lines[0] as { id: string } };
}

describe('Ops photos with real modules', () => {
  it('sets up the warehouse, company stock and an Official Store offer', async () => {
    const inventory = api<InventoryPublicApi>('inventory');
    const location = await ok('POST', '/api/admin/inventory/locations', setup, {
      code: 'RNO-2',
      name: 'Reno warehouse',
      address: { name: 'Marketly', line1: '100 Logistics Way', city: 'Reno', region: 'NV', postalCode: '89502', country: 'US' },
      timeZone: 'America/Los_Angeles',
      sellable: true,
      active: true,
    });
    w.locationId = location.id;
    const stock = await inventory.createStockItem({ ownerType: 'official', sku: SKU, productId: listing.productId, variantId: listing.variantId, condition: 'new', label: 'Aurora headphones, Black', initialAvailable: 30, locationId: w.locationId });
    w.stockItemId = stock.id;
    const profiles = await ok('GET', '/api/admin/shipping/profiles?ownerType=official', setup);
    const offer = await ok('POST', '/api/admin/offers/official/offers', setup, {
      productId: listing.productId,
      variantId: listing.variantId,
      condition: 'new',
      price: USD(17900),
      sku: SKU,
      stockItemId: stock.id,
      dispatchBusinessDays: 0,
      shippingProfileId: profiles.items[0].id,
      returnTerms: { kind: 'baseline' },
      warranty: { kind: 'manufacturer', months: 24 },
      publish: true,
    });
    w.offerId = offer.offer.id;
    const bins = await ok('POST', W('/bins'), setup, { locationId: w.locationId, codes: ['B-01-1'], kind: 'pick' });
    await ok('PUT', W(`/stock-items/${stock.id}/bins`), setup, { bins: [{ binId: bins[0].id, primary: true }] });
    w.boxId = newId();
    await ok('PUT', W('/box-types'), setup, { boxTypes: [{ id: w.boxId, name: 'M box', kind: 'box', dimensions: { length: 12, width: 10, height: 6, unit: 'in' }, active: true }] });
  });

  it('a Warehouse Worker uploads a damage photo and reports damage with it, through the inventory discrepancy', async () => {
    const { fulfillmentId, line } = await pickingOrder(2, { kind: 'guest', name: 'Ben Ortiz', email: 'ben@example.com', phone: null });
    const photo = await adminUpload(worker.accessToken, 'inspection_photo', 1);
    const asset = await api<any>('media').getAsset(photo);
    expect(asset).toMatchObject({ status: 'ready', owner: { kind: 'platform' } });

    // another worker's photo is not theirs to attach: refused before anything moves
    const theirs = await adminUpload(otherWorker.accessToken, 'inspection_photo', 2);
    const refused = await call('POST', W(`/fulfillments/${fulfillmentId}/report-damage`), worker.accessToken, { lineId: line.id, quantity: 1, note: 'Crushed corner', photoIds: [theirs] });
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    expect(refused.body.error.code).toBe('ASSET_NOT_OWNED');
    expect((await ok('GET', W(`/fulfillments/${fulfillmentId}`), setup)).status).not.toBe('on_hold');

    const reported = await call('POST', W(`/fulfillments/${fulfillmentId}/report-damage`), worker.accessToken, { lineId: line.id, quantity: 1, note: 'Crushed corner', photoIds: [photo] });
    expect(reported.status, JSON.stringify(reported.body)).toBe(200);
    expect(reported.body.status).toBe('on_hold');
    // warehouse and inventory both use the photo (evidence: kept by the orphan sweep)
    const detail = await call('GET', `/api/admin/media/assets/${photo}`, setup);
    const usages = (detail.body.usages as { module: string; kind: string }[]).map((u) => `${u.module}:${u.kind}`).sort();
    expect(usages).toEqual(['inventory:inspection_photo', 'warehouse:inspection_photo']);
    const discrepancies = await ok('GET', '/api/admin/inventory/discrepancies?state=open', setup);
    expect(JSON.stringify(discrepancies.items)).toContain(photo);
  });

  it('the worker receives a returned parcel with a photo and the Returns Manager inspects it with theirs', async () => {
    const signedUp = await f.customer('ben@example.com');
    const customer = signedUp.accessToken;
    const customerId = (await api<any>('customers').getCustomerByUserId(signedUp.accountId))!.id as string;
    const { order, item, line, fulfillmentId } = await pickingOrder(1, { kind: 'customer', customerId, name: 'Ben Ortiz', email: 'ben@example.com', phone: '+15035550101' });

    // picked, packed and handed to the carrier, then delivered (carrier event)
    await ok('POST', W(`/pick-lines/${line.id}/pick`), setup, { binCode: 'B-01-1', itemCode: SKU, quantity: 1 });
    const pkg = await ok('POST', W(`/fulfillments/${fulfillmentId}/packages`), setup, { station: 'Pack 1' });
    await ok('POST', W(`/packages/${pkg.id}/scan`), setup, { code: SKU, serialNumber: 'AU-SN-9' });
    await ok('PATCH', W(`/packages/${pkg.id}`), setup, { boxTypeId: w.boxId, weight: { value: 2.2, unit: 'lb', fromScale: true } });
    const label = await ok('POST', W(`/packages/${pkg.id}/label`), setup, { format: 'pdf' }, { 'idempotency-key': newId() });
    await ok('POST', W(`/packages/${pkg.id}/pack`), setup);
    const raw = JSON.stringify({ id: `evt-${label.trackingNumber}-delivered`, trackingNumber: label.trackingNumber, code: 'delivered', at: clock.now().toISOString(), location: 'Portland, OR' });
    const hook = await app.inject({ method: 'POST', url: '/webhooks/shipping/carriers/ups/events', headers: { 'content-type': 'application/json', ...signWebhook('dev-webhook-secret', raw, Math.floor(clock.now().getTime() / 1000)) }, payload: raw });
    expect(hook.statusCode, hook.body).toBeLessThan(300);
    await app.kernel.events.drain();

    const created = await ok('POST', '/api/store/returns/requests', customer, { orderId: order.id, items: [{ orderItemId: item.id, quantity: 1 }], reason: 'defective', details: 'No sound on the left', remedy: 'refund' }, { 'idempotency-key': newId() });
    const ret = created.returns[0];
    expect(ret.status).toBe('approved');

    // the dock: a dented parcel, photographed by the worker who receives it
    const parcelPhoto = await adminUpload(worker.accessToken, 'inspection_photo', 3);
    const parcel = await ok('POST', W('/return-parcels'), worker.accessToken, { code: ret.ref, parcelCondition: 'damaged', photoIds: [parcelPhoto] });
    await ok('POST', W(`/return-parcels/${parcel.id}/hand-over`), worker.accessToken, {});

    // inspection: the Returns Manager's own photo is accepted, the worker's is not theirs to attach
    const inspectionPhoto = await adminUpload(returnsManager.accessToken, 'inspection_photo', 4);
    const body = { conditionOutcome: 'as_described', grade: 'damaged', proposedStockOutcome: 'return_to_supplier', checks: [{ label: 'Left driver works', passed: false }] };
    const notTheirs = await call('POST', `/api/admin/returns/requests/${ret.id}/inspection`, returnsManager.accessToken, { ...body, mediaIds: [parcelPhoto] });
    expect(notTheirs.status, JSON.stringify(notTheirs.body)).toBe(403);
    expect(notTheirs.body.error.code).toBe('ASSET_NOT_OWNED');
    const inspected = await call('POST', `/api/admin/returns/requests/${ret.id}/inspection`, returnsManager.accessToken, { ...body, mediaIds: [inspectionPhoto] });
    expect(inspected.status, JSON.stringify(inspected.body)).toBeLessThan(300);
    const usages = async (id: string) => ((await call('GET', `/api/admin/media/assets/${id}`, setup)).body.usages as { module: string }[]).map((u) => u.module);
    expect(await usages(inspectionPhoto)).toEqual(['returns']);
    expect(await usages(parcelPhoto)).toEqual(['warehouse']);
  });
});
