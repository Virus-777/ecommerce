/**
 * Fulfilled by Marketly (fulfillment-service, phase 4) end to end, with real modules and real tokens (no stubs, no
 * development tokens):
 *
 *   a seller applies to the service and is approved → enrolls a SKU → plans and submits an inbound shipment →
 *   the warehouse receives it (one unit damaged) and the Inventory Manager confirms the receipt → the stock is
 *   sellable only at the Marketly location and the seller cannot set its quantity (SERVICE_MANAGED) → a customer
 *   sees "Ships from Marketly" and buys it with a self-shipped item of the same seller (two packages, two groups)
 *   → the seller has no ship task (409 FULFILLED_BY_MARKETLY) → the warehouse picks, packs and ships it (label
 *   from the service location, billed to the seller) → the seller pays pick/pack and order handling fees in
 *   finance → the customer returns it; Marketly approves, receives and inspects it, the outcome restocks it and
 *   the refund is funded by the seller → reconciliation finds no difference → suspending the seller's
 *   enrollment takes the offer off sale and reinstating it restores the offer.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withDependencies } from '../kernel/module-system/loader.js';
import { buildTestApp, movingClock, signWebhook } from '../testing/app.js';
import { flows, pngHeader, type Flows, type Listing, type Staff } from '../testing/flows.js';

const clock = movingClock();
let app: FastifyInstance;
let f: Flows;
let listing: Listing;
/** Staff with their seeded roles */
let staff: { warehouse: Staff; inventory: Staff; returns: Staff; finance: Staff };

const PORTLAND = { name: 'Ben Ortiz', line1: '1120 SW 5th Ave', city: 'Portland', region: 'OR', postalCode: '97204', country: 'US', phone: '+15035550101' };
const RENO = { name: 'Marketly Fulfillment', line1: '1 Logistics Way', city: 'Reno', region: 'NV', postalCode: '89502', country: 'US' };
const SELLER_DOCK = { name: 'Northwind Audio', line1: '410 Pine St', city: 'Portland', region: 'OR', postalCode: '97204', country: 'US' };
const key = () => crypto.randomUUID();
const FS = { seller: (p: string) => `/api/seller/fulfillment-service${p}`, admin: (p: string) => `/api/admin/fulfillment-service${p}` };
const WH = (p: string) => `/api/admin/warehouse${p}`;

beforeAll(async () => {
  app = await buildTestApp({
    only: withDependencies([
      'identity',
      'access',
      'audit',
      'media',
      'notifications',
      'settings',
      'customers',
      'sellers',
      'catalog',
      'inventory',
      'offers',
      'cart',
      'orders',
      'promotions',
      'content',
      'payments',
      'shipping',
      'checkout',
      'returns',
      'finance',
      'warehouse',
      'workqueues',
      'reports',
      'fulfillment-service',
    ]),
    clock,
    config: { rateLimits: false, launchPhase: 4 },
  });
  f = flows(app, clock);
  listing = await f.liveListing({ quantity: 5 });
  staff = {
    warehouse: await f.staffWithRoles(listing.owner, 'wes@marketly.test', 'Wes Warehouse', ['warehouse_manager']),
    inventory: await f.staffWithRoles(listing.owner, 'ivy@marketly.test', 'Ivy Inventory', ['inventory_manager']),
    returns: await f.staffWithRoles(listing.owner, 'rae@marketly.test', 'Rae Returns', ['returns_manager']),
    finance: await f.staffWithSensitiveRoles(listing.owner, listing.deputy, 'fin@marketly.test', 'Finn Finance', ['finance_manager']),
  };
}, 300_000);
afterAll(async () => {
  await app?.close();
});

/** An HTTP call that must succeed (2xx); returns the body */
async function ok(method: string, url: string, token: string, body?: unknown, headers?: Record<string, string>) {
  const res = await f.call(method, url, { token, body, headers });
  expect(res.status, `${method} ${url}: ${JSON.stringify(res.body)}`).toBeLessThan(300);
  return res.body;
}

/** The world the steps build on */
const w = {
  locationId: '',
  ownOfferId: '',
  serviceStockItemId: '',
  enrollmentId: '',
  skuId: '',
  inboundId: '',
  orderId: '',
  orderRef: '',
  serviceGroupId: '',
  ownGroupId: '',
  serviceItemId: '',
  customer: { accessToken: '', accountId: '' },
  tracking: '',
};

describe('Fulfilled by Marketly, end to end', () => {
  it('sets up the company warehouse, its bins and a second (self-shipped) offer of the seller', async () => {
    const location = await ok('POST', '/api/admin/inventory/locations', staff.inventory.accessToken, { code: 'RNO1', name: 'Reno, NV warehouse', address: RENO, timeZone: 'America/Los_Angeles', sellable: true, active: true });
    w.locationId = location.id;
    await ok('POST', WH('/bins'), staff.warehouse.accessToken, { locationId: w.locationId, codes: ['A-01-1', 'A-01-2'], kind: 'pick' });
    await ok('POST', WH('/bins'), staff.warehouse.accessToken, { locationId: w.locationId, codes: ['Q-01-1'], kind: 'quarantine' });
    await ok('PUT', WH('/box-types'), staff.warehouse.accessToken, { boxTypes: [{ id: crypto.randomUUID(), name: 'M box', kind: 'box', dimensions: { length: 12, width: 10, height: 6, unit: 'in' }, maxWeight: { value: 20, unit: 'lb' }, active: true }] });

    // the seller's second product, which it keeps shipping itself
    const brand = await ok('POST', '/api/admin/catalog/brands', listing.catalogManager.accessToken, { name: 'Halden' });
    const imageId = await f.upload('seller', listing.sellerToken, { purpose: 'product_image', fileName: 'stand.png', contentType: 'image/png', body: pngHeader(1600, 1600) });
    const draft = await ok('POST', '/api/seller/catalog/products', listing.sellerToken, {
      title: 'Halden headphone stand',
      brandId: brand.brand.id,
      categoryId: listing.categoryId,
      description: 'A solid walnut stand that keeps over-ear headphones in shape and the cable tidy on any desk.',
      keyFeatures: ['Solid walnut', 'Cable hook'],
      specs: { Material: 'Walnut' },
      includedItems: ['Stand'],
      imageIds: [imageId],
      modelNumber: 'HS-1',
      variants: [{ options: { Color: 'Walnut' }, gtin: '9780201379624' }],
    });
    const productId = draft.product.id as string;
    await ok('POST', `/api/seller/catalog/products/${productId}/submit`, listing.sellerToken, { note: 'Second product' });
    await ok('POST', `/api/admin/catalog/products/${productId}/approve`, listing.catalogManager.accessToken, {});
    const first = await ok('GET', `/api/seller/offers/offers/${listing.offerId}`, listing.sellerToken);
    const own = await ok('POST', '/api/seller/offers/offers', listing.sellerToken, {
      productId,
      variantId: draft.product.variants[0].id,
      condition: 'new',
      price: { amount: 3900, currency: 'USD' },
      sellerSku: 'NW-HS-1',
      quantity: 20,
      dispatchBusinessDays: 1,
      shippingProfileId: first.offer?.shippingProfileId ?? first.shippingProfileId,
      returnTerms: { kind: 'baseline' },
      warranty: { kind: 'manufacturer', months: 12 },
      publish: true,
    });
    w.ownOfferId = own.offer.id;
    await app.kernel.events.drain();

    // with fulfillment-service running, the products_inventory template grants (sellers migration 0004) were applied at start
    const grants = await (app.kernel.boot.apis.get('sellers') as { core: { repo: { find(t: string, w: object): Promise<{ applied_at: Date | null }[]> } } }).core.repo.find('template_grants', {});
    expect(grants.length).toBe(2);
    expect(grants.every((g) => g.applied_at !== null)).toBe(true);
  });

  it('the seller applies to the service and the Seller Manager approves it; the seller enrolls a SKU that staff approve', async () => {
    const seller = listing.sellerToken;
    const schedule = await ok('GET', FS.seller('/fee-schedule'), seller);
    const applied = await ok('POST', FS.seller('/enrollment'), seller, { expectedSkus: 2, expectedMonthlyUnits: 60, categories: [listing.categoryId], termsVersion: 'FS-TERMS-1', feeScheduleVersion: schedule.current.version, acceptTerms: true });
    expect(applied).toMatchObject({ state: 'applied', sellerId: listing.sellerId });
    w.enrollmentId = applied.id;
    const queue = await ok('GET', FS.admin('/enrollments'), listing.sellerManager.accessToken);
    expect(queue.items.map((e: { id: string }) => e.id)).toContain(w.enrollmentId);
    const approved = await ok('POST', FS.admin(`/enrollments/${w.enrollmentId}/decide`), listing.sellerManager.accessToken, { decision: 'approve', reason: 'Welcome to Fulfilled by Marketly', capacity: { maxCubicFeet: 200, maxSkus: 10, usedCubicFeet: 0, usedSkus: 0 } });
    expect(approved.state).toBe('approved');

    const sku = await ok('POST', FS.seller('/skus'), seller, { offerId: listing.offerId, dimensionsCm: { length: 22, width: 18, height: 10 }, weightGrams: 600, hazmat: false });
    expect(sku).toMatchObject({ offerId: listing.offerId, state: 'pending' });
    w.skuId = sku.id;
    const offer = await ok('GET', `/api/seller/offers/offers/${listing.offerId}`, seller);
    w.serviceStockItemId = offer.offer?.stockItemId ?? offer.stockItemId;
    expect(w.serviceStockItemId).toBeTruthy();
    expect((await ok('POST', FS.admin(`/skus/${w.skuId}/review`), listing.sellerManager.accessToken, { approve: true })).state).toBe('approved');
  });

  it('plans and submits an inbound shipment; the warehouse receives it with one damaged unit and the Inventory Manager confirms', async () => {
    const seller = listing.sellerToken;
    const planned = await ok('POST', FS.seller('/inbound'), seller, { shipFrom: SELLER_DOCK, lines: [{ skuEnrollmentId: w.skuId, quantity: 10 }], boxes: 1 });
    w.inboundId = planned.id;
    expect(planned.destination).toMatchObject({ city: 'Reno' });
    const submitted = await ok('POST', FS.seller(`/inbound/${w.inboundId}/submit`), seller);
    expect(submitted.state).toBe('submitted');
    // inventory expects the units at the service location
    const expected = await ok('GET', `/api/admin/inventory/stock-items/${w.serviceStockItemId}`, staff.inventory.accessToken);
    expect(JSON.stringify(expected)).toContain('"incoming":10');
    await ok('POST', FS.seller(`/inbound/${w.inboundId}/ship`), seller, { carrier: 'UPS', tracking: '1Z999AA10123456784' });
    await ok('POST', FS.admin(`/inbound/${w.inboundId}/arrive`), staff.warehouse.accessToken, { boxesArrived: 1 });
    const received = await ok('POST', FS.admin(`/inbound/${w.inboundId}/receive`), staff.warehouse.accessToken, { lines: [{ skuEnrollmentId: w.skuId, received: 10, damaged: 1 }], complete: true }, { 'idempotency-key': key() });
    expect(received.state).not.toBe('submitted');

    // nothing is sellable before the Inventory Manager confirms the receipt
    w.customer = await f.customer('ben@example.com');
    const before = await ok('GET', `/api/store/offers/offers/${listing.offerId}`, w.customer.accessToken);
    expect(before).toMatchObject({ fulfilledBy: 'seller', delivery: { fulfilledByLabel: null } });
    const waiting = await ok('GET', '/api/admin/inventory/inbound?source=service_inbound&state=awaiting_confirmation', staff.inventory.accessToken);
    const receipt = waiting.items.find((r: { source?: { id: string } }) => r.source?.id === w.inboundId);
    expect(receipt, JSON.stringify(waiting)).toBeDefined();
    await ok('POST', `/api/admin/inventory/inbound/${receipt.id}/confirm`, staff.inventory.accessToken, { lines: [{ stockItemId: w.serviceStockItemId, sellable: 9, damaged: 1 }], checked: true });

    // the warehouse puts the units away (a sellable bin and quarantine)
    const tasks = await ok('GET', WH('/putaway-tasks?status=open'), staff.warehouse.accessToken);
    expect(tasks.items.length, JSON.stringify(tasks)).toBeGreaterThan(0);
    for (const t of tasks.items) await ok('POST', WH(`/putaway-tasks/${t.id}/complete`), staff.warehouse.accessToken, { binCode: t.suggestedBinCode ?? 'A-01-1', quantity: t.quantity });
  });

  it('sells the stock only from the Marketly location; the seller cannot set its quantity (SERVICE_MANAGED)', async () => {
    const seller = listing.sellerToken;
    expect((await ok('GET', FS.seller('/enrollment'), seller)).state).toBe('active');
    const skus = await ok('GET', FS.seller('/skus'), seller);
    expect(skus.items.find((s: { id: string }) => s.id === w.skuId)).toMatchObject({ state: 'active', stock: { available: 9 } });

    const rows = await ok('GET', '/api/seller/inventory/stock-items', seller);
    const row = (rows.items ?? rows).find((r: { stockItemId: string }) => r.stockItemId === w.serviceStockItemId);
    // 9 sellable units at Marketly; the seller's own 5 units are kept but not on sale
    expect(row).toMatchObject({ fulfilledByMarketly: true, available: 9, ownLocationAvailable: 5 });
    const adjusted = await f.call('POST', `/api/seller/inventory/stock-items/${w.serviceStockItemId}/adjustments`, { token: seller, body: { newAvailable: 50, reasonCode: 'received_stock' } });
    expect(adjusted.status, JSON.stringify(adjusted.body)).toBe(409);
    expect(adjusted.body.error.code).toBe('SERVICE_MANAGED');
    const atMarketly = await ok('GET', `/api/admin/inventory/stock-items/${w.serviceStockItemId}`, staff.inventory.accessToken);
    expect(JSON.stringify(atMarketly)).toContain('"damagedHeld":1');

    // the customer sees Marketly as the shipper, with the seller still named
    const view = await ok('GET', `/api/store/offers/offers/${listing.offerId}`, w.customer.accessToken);
    expect(view).toMatchObject({ fulfilledBy: 'marketly_service', delivery: { fulfilledByLabel: 'Ships from Marketly' } });
    expect(JSON.stringify(view)).toContain('Northwind Audio');
  });

  it('a customer buys it together with a self-shipped item of the same seller: two packages, two order groups', async () => {
    const token = w.customer.accessToken;
    await ok('POST', '/api/store/cart/cart/items', token, { offerId: listing.offerId, quantity: 1 });
    await ok('POST', '/api/store/cart/cart/items', token, { offerId: w.ownOfferId, quantity: 1 });
    const started = await ok('POST', '/api/store/checkout/sessions', token, { source: 'cart' });
    await ok('PUT', `/api/store/checkout/sessions/${started.id}/address`, token, { address: PORTLAND });
    const v = await ok('PUT', `/api/store/checkout/sessions/${started.id}/payment-method`, token, { kind: 'new_card', providerToken: 'tok_visa', label: 'Visa •••• 4242' });
    expect(v.readyToPlace, JSON.stringify(v.blockers)).toBe(true);
    expect(v.packages.map((p: { fulfilledBy: string }) => p.fulfilledBy).sort()).toEqual(['marketly_service', 'seller']);
    const service = v.packages.find((p: { fulfilledBy: string }) => p.fulfilledBy === 'marketly_service');
    expect(service).toMatchObject({ soldAndShippedBy: 'Sold by Northwind Audio · Shipped by Marketly' });
    expect(service.shipsFrom).toContain('Reno');

    const placed = await ok('POST', `/api/store/checkout/sessions/${started.id}/place`, token, { quoteVersion: v.quoteVersion, expectedTotal: v.totals.total, acceptTerms: true, channel: 'web', returnUrl: 'https://store.marketly.test/checkout/return' }, { 'idempotency-key': key() });
    expect(placed.outcome, JSON.stringify(placed)).toBe('accepted');
    w.orderId = placed.orderId;
    w.orderRef = (await ok('GET', `/api/store/orders/orders/${w.orderId}`, token)).ref;
    const order = await ok('GET', `/api/store/orders/orders/${w.orderId}`, token);
    expect(order.groups.map((g: { fulfilledBy: string }) => g.fulfilledBy).sort()).toEqual(['marketly_service', 'seller']);
    const serviceGroup = order.groups.find((g: { fulfilledBy: string }) => g.fulfilledBy === 'marketly_service');
    w.serviceGroupId = serviceGroup.id;
    w.serviceItemId = serviceGroup.items[0].id;
    w.ownGroupId = order.groups.find((g: { fulfilledBy: string }) => g.fulfilledBy === 'seller').id;

    // the unit is held at the Marketly location (1 reserved of the 9 there)
    const rows = await ok('GET', '/api/seller/inventory/stock-items', listing.sellerToken);
    expect((rows.items ?? rows).find((r: { stockItemId: string }) => r.stockItemId === w.serviceStockItemId)).toMatchObject({ available: 8, reserved: 1, ownLocationAvailable: 5 });
  });

  it('the seller has no ship task for the Marketly package: 409 FULFILLED_BY_MARKETLY; its own package is its to ship', async () => {
    const seller = listing.sellerToken;
    const list = await ok('GET', '/api/seller/orders/orders', seller);
    const rows = list.items as { id: string; fulfilledBy: string; nextAction: string }[];
    expect(rows.find((r) => r.id === w.serviceGroupId)).toMatchObject({ fulfilledBy: 'marketly_service', nextAction: 'marketly_fulfils' });
    expect(rows.find((r) => r.id === w.ownGroupId)?.nextAction).not.toBe('marketly_fulfils');
    const prepare = await f.call('POST', `/api/seller/orders/orders/${w.serviceGroupId}/start-preparing`, { token: seller });
    expect(prepare.status, JSON.stringify(prepare.body)).toBe(409);
    expect(prepare.body.error.code).toBe('FULFILLED_BY_MARKETLY');
    const ship = await f.call('POST', '/api/seller/shipping/shipments', { token: seller, body: { groupId: w.serviceGroupId, carrierCode: 'ups', serviceName: 'UPS Ground', trackingNumber: '1ZFBM00000000001', shippedAt: clock.now().toISOString(), items: [{ orderItemId: w.serviceItemId, quantity: 1 }] } });
    expect(ship.status, JSON.stringify(ship.body)).toBe(409);
    expect(ship.body.error.code).toBe('FULFILLED_BY_MARKETLY');
    expect((await f.call('POST', `/api/seller/orders/orders/${w.ownGroupId}/start-preparing`, { token: seller })).status).toBe(200);
  });

  it('the warehouse picks, packs and ships it from the service location, the label billed to the seller', async () => {
    const t = staff.warehouse.accessToken;
    const dispatched: any[] = [];
    app.kernel.events.subscribe('fbm-test', 'shipping.shipment.dispatched', (e) => void dispatched.push(e.payload));
    const list = await ok('GET', WH('/fulfillments?fulfilledBy=marketly_service'), t);
    const row = list.items.find((x: { orderRef: string }) => x.orderRef === w.orderRef);
    expect(row).toMatchObject({ fulfilledBy: 'marketly_service', sellerName: 'Northwind Audio' });
    // only the Marketly package: the seller ships its own
    expect(list.items.filter((x: { orderRef: string }) => x.orderRef === w.orderRef)).toHaveLength(1);
    const wave = await ok('POST', WH('/waves'), t, { locationId: w.locationId, fulfillmentIds: [row.id] });
    await ok('POST', WH(`/waves/${wave.id}/start`), t);
    const ful = await ok('GET', WH(`/fulfillments/${row.id}`), t);
    for (const l of ful.lines) for (let n = l.picked; n < l.quantity; n++) await ok('POST', WH(`/pick-lines/${l.id}/pick`), t, { binCode: l.binCode ?? 'A-01-1', itemCode: l.sku, quantity: 1 });
    const pkg = await ok('POST', WH(`/fulfillments/${row.id}/packages`), t, {});
    await ok('POST', WH(`/packages/${pkg.id}/scan`), t, { code: ful.lines[0].sku });
    const boxes = await ok('GET', WH('/box-types'), t);
    await ok('PATCH', WH(`/packages/${pkg.id}`), t, { boxTypeId: (boxes.items ?? boxes)[0].id, weight: { value: 2, unit: 'lb' } });
    const label = await ok('POST', WH(`/packages/${pkg.id}/label`), t, {}, { 'idempotency-key': key() });
    w.tracking = label.trackingNumber ?? label.label?.trackingNumber;
    expect(w.tracking, JSON.stringify(label)).toBeTruthy();
    await ok('POST', WH(`/packages/${pkg.id}/pack`), t);

    // shipping hands it over as the seller's shipment, from Marketly's dock
    const event = dispatched.find((d) => d.groupId === w.serviceGroupId);
    expect(event).toMatchObject({ ownerType: 'seller', sellerId: listing.sellerId, fulfilledBy: 'marketly_service' });
    const order = await ok('GET', `/api/store/orders/orders/${w.orderId}`, w.customer.accessToken);
    expect(order.groups.find((g: { id: string }) => g.id === w.serviceGroupId).items[0].state).toMatch(/shipped|in_transit/);
    // the reserved unit left the Marketly location
    const rows = await ok('GET', '/api/seller/inventory/stock-items', listing.sellerToken);
    expect((rows.items ?? rows).find((r: { stockItemId: string }) => r.stockItemId === w.serviceStockItemId)).toMatchObject({ available: 8, reserved: 0 });
    // the label is the seller's cost on its ledger
    const ledger = await ok('GET', '/api/seller/finance/ledger', listing.sellerToken);
    expect(JSON.stringify(ledger)).toMatch(/"type":"label_charge"/);
  });

  it('charges the seller pick/pack and order handling fees in finance', async () => {
    await app.kernel.jobs.runNow('fulfillment-service.post-fees');
    await app.kernel.events.drain();
    const fees = await ok('GET', FS.seller('/fees'), listing.sellerToken);
    const posted = (fees.items as { type: string; state: string; amount: { amount: number } }[]).filter((x) => x.state === 'posted');
    expect(posted.map((x) => x.type)).toEqual(expect.arrayContaining(['pick_pack', 'order_handling']));
    const ledger = await ok('GET', '/api/seller/finance/ledger?types=service_fee', listing.sellerToken);
    const serviceFees = (ledger.items as { type: string; amount: { amount: number } }[]).filter((e) => e.type === 'service_fee');
    expect(serviceFees.length).toBeGreaterThanOrEqual(2);
    // each posted fee is one finance entry of the same amount
    expect(serviceFees.reduce((n, e) => n - e.amount.amount, 0)).toBe(posted.reduce((n, x) => n + x.amount.amount, 0));
  });

  it('the customer returns it: Marketly approves, receives and inspects it, the outcome restocks it, the seller funds the refund', async () => {
    // delivered (carrier event): Marketly's delivery, not a seller performance fact
    const delivered: any[] = [];
    app.kernel.events.subscribe('fbm-test', 'shipping.shipment.delivered', (e) => void delivered.push(e.payload));
    const raw = JSON.stringify({ id: `evt-${w.tracking}-delivered`, trackingNumber: w.tracking, code: 'delivered', at: clock.now().toISOString(), location: 'Portland, OR' });
    const hook = await app.inject({ method: 'POST', url: '/webhooks/shipping/carriers/ups/events', headers: { 'content-type': 'application/json', ...signWebhook('dev-webhook-secret', raw, Math.floor(clock.now().getTime() / 1000)) }, payload: raw });
    expect(hook.statusCode, hook.body).toBeLessThan(300);
    await app.kernel.events.drain();
    expect(delivered.find((d) => d.groupId === w.serviceGroupId)).toMatchObject({ sellerId: listing.sellerId, fulfilledBy: 'marketly_service' });

    const created = await ok('POST', '/api/store/returns/requests', w.customer.accessToken, { orderId: w.orderId, items: [{ orderItemId: w.serviceItemId, quantity: 1 }], reason: 'changed_mind', details: 'Too tight', remedy: 'refund' }, { 'idempotency-key': key() });
    const ret = created.returns[0];
    // platform handled and approved within the seller's window, to the Marketly dock
    expect(ret).toMatchObject({ status: 'approved', handledBy: 'marketplace_support' });
    const sellerView = await ok('GET', `/api/seller/returns/requests/${ret.id}`, listing.sellerToken);
    expect(sellerView).toMatchObject({ fulfilledBy: 'marketly_service', allowedActions: ['evidence'] });

    // the dock receives the parcel and hands it to inspection
    const parcel = await ok('POST', WH('/return-parcels'), staff.warehouse.accessToken, { code: ret.ref, parcelCondition: 'intact' });
    await ok('POST', WH(`/return-parcels/${parcel.id}/hand-over`), staff.warehouse.accessToken, {});
    const serviceReturns = await ok('GET', FS.seller('/returns'), listing.sellerToken);
    const serviceReturn = serviceReturns.items.find((r: { returnRef?: string; returnId?: string }) => r.returnId === ret.id || r.returnRef === ret.ref);
    expect(serviceReturn, JSON.stringify(serviceReturns)).toBeDefined();
    const returned = await ok('GET', `/api/admin/inventory/stock-items/${w.serviceStockItemId}`, staff.inventory.accessToken);
    expect(JSON.stringify(returned)).toContain('"returned":1');

    // Marketly inspects it and the fulfillment service records the stock outcome: restocked
    await ok('POST', `/api/admin/returns/requests/${ret.id}/inspection`, staff.returns.accessToken, { conditionOutcome: 'as_described', grade: 'like_new', proposedStockOutcome: 'restock', checks: [{ label: 'Sealed', passed: true }] });
    const outcome = await ok('POST', FS.admin(`/returns/${serviceReturn.id}/outcome`), staff.returns.accessToken, { outcome: 'restocked', note: 'Sealed, back on the shelf' });
    expect(outcome).toMatchObject({ outcome: 'restocked' });
    const rows = await ok('GET', '/api/seller/inventory/stock-items', listing.sellerToken);
    expect((rows.items ?? rows).find((r: { stockItemId: string }) => r.stockItemId === w.serviceStockItemId)).toMatchObject({ available: 9, reserved: 0 });

    // the refund: decided by Marketly, approved by Finance, funded by the seller
    const remedy = await ok('POST', `/api/admin/returns/requests/${ret.id}/remedy`, staff.returns.accessToken, { kind: 'full_refund' }, { 'idempotency-key': key() });
    expect(remedy.refundRequest).toMatchObject({ fundedBy: 'seller', sellerId: listing.sellerId });
    if (remedy.refundRequest.status === 'under_review') await ok('POST', `/api/admin/returns/refunds/${remedy.refundRequest.id}/approve`, staff.finance.accessToken, {}, { 'idempotency-key': key() });
    await app.kernel.jobs.runNow('payments.process-refunds');
    await app.kernel.events.drain();
    const ledger = await ok('GET', '/api/seller/finance/ledger?type=refunds', listing.sellerToken);
    const refund = (ledger.items as { type: string; amount: { amount: number }; reference: { id: string } }[]).find((e) => /refund/.test(e.type));
    expect(refund, JSON.stringify(ledger)).toBeDefined();
    expect(refund!.amount.amount).toBeLessThan(0);
  });

  it('reconciliation finds no difference between the service ledger and inventory', async () => {
    await app.kernel.jobs.runNow('fulfillment-service.reconcile');
    await app.kernel.events.drain();
    const differences = await ok('GET', FS.admin('/stock-differences'), staff.inventory.accessToken);
    expect(differences.items).toEqual([]);
  });

  it("suspending the seller's enrollment takes the offer off sale; reinstating it restores the offer", async () => {
    const t = listing.sellerManager.accessToken;
    const suspended = await ok('POST', FS.admin(`/enrollments/${w.enrollmentId}/status`), t, { action: 'suspend', reason: 'Unpaid fees', affectedActivity: 'Sales of stored stock and new inbound shipments' });
    expect(suspended.state).toBe('suspended');
    const offSale = await ok('GET', `/api/seller/offers/offers/${listing.offerId}`, listing.sellerToken);
    expect(offSale.offer.status).toBe('ineligible');
    expect(offSale.statusLog[0]).toMatchObject({ to: 'ineligible', reasonCode: 'fulfillment_service_suspended' });
    const add = await f.call('POST', '/api/store/cart/cart/items', { token: w.customer.accessToken, body: { offerId: listing.offerId, quantity: 1 } });
    expect(add.status, JSON.stringify(add.body)).toBeGreaterThanOrEqual(400);

    const reinstated = await ok('POST', FS.admin(`/enrollments/${w.enrollmentId}/status`), t, { action: 'reinstate', reason: 'Fees paid' });
    expect(reinstated.state).toBe('active');
    const back = await ok('GET', `/api/seller/offers/offers/${listing.offerId}`, listing.sellerToken);
    expect(back.offer.status).toBe('active');
    const view = await ok('GET', `/api/store/offers/offers/${listing.offerId}`, w.customer.accessToken);
    expect(view).toMatchObject({ fulfilledBy: 'marketly_service', delivery: { fulfilledByLabel: 'Ships from Marketly' } });
    await ok('POST', '/api/store/cart/cart/items', w.customer.accessToken, { offerId: listing.offerId, quantity: 1 });
  });
});
