/**
 * With real modules (identity, catalog, offers, inventory, orders, shipping, media, warehouse; nothing stubbed):
 * an Official Store order is picked in a wave, packed with a label bought through shipping and handed to the carrier.
 *
 *   company stock (inventory.createStockItem) + an Official Store offer → bins and the primary bin (inventory learns it)
 *   → the order is accepted (stock held and allocated) → warehouse creates the fulfillment
 *   → wave → picking (orders: Preparing) → scans → package, box, weight, label (shipping) → packed
 *   → shipping hands it to the carrier → warehouse: dispatched; orders: shipped; inventory: reserved units leave.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { withDependencies } from '../../../kernel/module-system/loader.js';
import type { InventoryPublicApi } from '../../../spec/inventory.js';
import type { OrderCreateInput, OrdersPublicApi } from '../../../spec/orders.js';
import { auth, buildTestApp, callers, movingClock } from '../../../testing/app.js';
import { flows, type Flows, type Listing } from '../../../testing/flows.js';

const clock = movingClock();
let app: FastifyInstance;
let f: Flows;
let listing: Listing;
const staff = callers.staff();
const USD = (amount: number) => ({ amount, currency: 'USD' });
const ADDRESS = { name: 'Ben Ortiz', line1: '1120 SW 5th Ave', city: 'Portland', region: 'OR', postalCode: '97204', country: 'US', phone: '+15035550101' };

beforeAll(async () => {
  app = await buildTestApp({
    only: withDependencies(['identity', 'access', 'audit', 'media', 'notifications', 'settings', 'customers', 'sellers', 'catalog', 'inventory', 'offers', 'orders', 'shipping', 'warehouse']),
    clock,
    config: { rateLimits: false },
  });
  f = flows(app, clock);
  listing = await f.liveListing({ quantity: 5 });
});
afterAll(async () => {
  await app?.close();
});

const api = <T>(m: string) => app.kernel.boot.apis.get(m) as T;
async function call(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await app.inject({ method: method as never, url, headers: { ...auth(staff), ...headers }, ...(body !== undefined ? { payload: body as never } : {}) });
  await app.kernel.events.drain();
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}
const W = (path: string) => `/api/admin/warehouse${path}`;

describe('an Official Store order through the warehouse (real modules)', () => {
  it('is picked, packed and handed to shipping', async () => {
    const inventory = api<InventoryPublicApi>('inventory');
    const orders = api<OrdersPublicApi>('orders');

    // the warehouse site, company stock and the Official Store offer (as checkout's tests set them up)
    const location = await call('POST', '/api/admin/inventory/locations', {
      code: 'RNO-1',
      name: 'Reno warehouse',
      address: { name: 'Marketly', line1: '100 Logistics Way', city: 'Reno', region: 'NV', postalCode: '89502', country: 'US' },
      timeZone: 'America/Los_Angeles',
      sellable: true,
      active: true,
    });
    expect(location.status, JSON.stringify(location.body)).toBe(201);
    const locationId = location.body.id as string;
    const stock = await inventory.createStockItem({ ownerType: 'official', sku: 'HAL-AU-100-BK', productId: listing.productId, variantId: listing.variantId, condition: 'new', label: 'Aurora headphones, Black', initialAvailable: 30, locationId });
    const profiles = await call('GET', '/api/admin/shipping/profiles?ownerType=official');
    expect(profiles.status, JSON.stringify(profiles.body)).toBe(200);
    const offer = await call('POST', '/api/admin/offers/official/offers', {
      productId: listing.productId,
      variantId: listing.variantId,
      condition: 'new',
      price: USD(17900),
      sku: 'HAL-AU-100-BK',
      stockItemId: stock.id,
      dispatchBusinessDays: 0,
      shippingProfileId: profiles.body.items[0].id,
      returnTerms: { kind: 'baseline' },
      warranty: { kind: 'manufacturer', months: 24 },
      publish: true,
    });
    expect(offer.status, JSON.stringify(offer.body)).toBe(201);
    const offerId = offer.body.offer.id as string;

    // bins: the stock item's primary bin, which inventory shows on the stock item
    const bins = await call('POST', W('/bins'), { locationId, codes: ['A-03-2', 'A-03-3'], kind: 'pick' });
    expect(bins.status, JSON.stringify(bins.body)).toBe(201);
    const assigned = await call('PUT', W(`/stock-items/${stock.id}/bins`), { bins: [{ binId: bins.body[0].id, primary: true }, { binId: bins.body[1].id, primary: false }] });
    expect(assigned.status, JSON.stringify(assigned.body)).toBe(200);
    expect(assigned.body[0]).toMatchObject({ sku: 'HAL-AU-100-BK', label: 'Aurora headphones, Black', binCode: 'A-03-2', primary: true });
    expect((await inventory.findBySku('official', ['HAL-AU-100-BK']))[0]?.binCode).toBe('A-03-2');
    const boxId = newId();
    expect((await call('PUT', W('/box-types'), { boxTypes: [{ id: boxId, name: 'M box', kind: 'box', dimensions: { length: 12, width: 10, height: 6, unit: 'in' }, active: true }] })).status).toBe(200);

    // the order: stock held at checkout, the order created, the hold attached, the payment accepted
    const hold = await inventory.hold(`hold-${newId()}`, [{ stockItemId: stock.id, quantity: 2 }]);
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
          ownerType: 'official',
          sellerId: null,
          shipsFrom: 'Reno, NV',
          fulfilledBy: 'official_warehouse',
          delivery: { methodName: 'Standard', carrier: 'UPS', service: 'Ground', price: USD(0), free: true, fundedBy: 'company', arrival: { from: day(3), to: day(12) }, dispatchBy: new Date(clock.now().getTime() + 86_400_000).toISOString() },
          returnTermsSummary: '30-day returns.',
          items: [{ offerId, variantId: listing.variantId, stockItemId: stock.id, quantity: 2, unitPrice: USD(17900), discounts: [], shippingShare: USD(0), taxShare: USD(0), returnTerms: { summary: '30-day returns.', windowDays: 30, returnShippingPaidBy: 'depends_on_reason' }, checkoutLineId: newId() }],
          totals: { items: USD(35800), discounts: USD(0), shipping: USD(0), tax: USD(0), total: USD(35800) },
        },
      ],
      totals: { items: USD(35800), discounts: USD(0), shipping: USD(0), tax: USD(0), total: USD(35800) },
    };
    const order = await orders.createOrder(input);
    const item = order.groups[0]!.items[0]!;
    await inventory.attachOrder(hold.id, order.id, [{ stockItemId: stock.id, orderItemId: item.id }]);
    await orders.acceptOrder(order.id, input.paymentIntentId);
    await app.kernel.events.drain();

    // the fulfillment: one per Official Store group, the line at its primary bin
    const list = await call('GET', W(`/fulfillments?q=${order.ref}`));
    expect(list.body.items).toHaveLength(1);
    const fulfillmentId = list.body.items[0].id as string;
    let ful = (await call('GET', W(`/fulfillments/${fulfillmentId}`))).body;
    expect(ful).toMatchObject({ orderId: order.id, orderRef: order.ref, sellerGroupId: order.groups[0]!.id, locationId, status: 'awaiting_pick', totalPackagesInOrder: 1, mixedOrderNote: null });
    expect(ful.lines).toEqual([expect.objectContaining({ orderItemId: item.id, stockItemId: stock.id, sku: 'HAL-AU-100-BK', quantity: 2, binCode: 'A-03-2', state: 'pending' })]);
    expect(ful.deliveryChoice).toMatch(/^UPS Ground · arrives /);
    expect((await api<any>('warehouse').getTasksForOrderGroups([order.groups[0]!.id]))[order.groups[0]!.id]?.id).toBe(fulfillmentId);

    // wave → picking: orders moves the items to Preparing (no more instant cancellation)
    const wave = await call('POST', W('/waves'), { locationId });
    expect(wave.status, JSON.stringify(wave.body)).toBe(201);
    expect(wave.body.orders.map((o: any) => o.fulfillmentId)).toContain(fulfillmentId);
    expect((await call('POST', W(`/waves/${wave.body.id}/start`))).body.status).toBe('picking');
    expect((await orders.getOrder(order.id))!.groups[0]!.items[0]!.state).toBe('preparing');

    const line = ful.lines[0];
    const wrong = await call('POST', W(`/pick-lines/${line.id}/pick`), { binCode: 'A-03-3', itemCode: 'HAL-AU-100-BK', quantity: 1 });
    expect(wrong.body.error).toMatchObject({ code: 'SCAN_MISMATCH', details: { expected: 'A-03-2', scanned: 'A-03-3' } });
    for (let n = 0; n < 2; n++) expect((await call('POST', W(`/pick-lines/${line.id}/pick`), { binCode: 'A-03-2', itemCode: 'HAL-AU-100-BK', quantity: 1 })).status).toBe(200);
    expect((await call('POST', W(`/pick-lines/${line.id}/pick`), { binCode: 'A-03-2', itemCode: 'HAL-AU-100-BK', quantity: 1 })).status).toBe(409);
    ful = (await call('GET', W(`/fulfillments/${fulfillmentId}`))).body;
    expect(ful.status).toBe('picked');

    // packing: checklist, box, weight, services from shipping, the label, the slip
    const pkg = await call('POST', W(`/fulfillments/${fulfillmentId}/packages`), { station: 'Pack 1' });
    expect(pkg.status, JSON.stringify(pkg.body)).toBe(201);
    expect(pkg.body).toMatchObject({ index: 1, of: 1, status: 'open' });
    for (let n = 0; n < 2; n++) expect((await call('POST', W(`/packages/${pkg.body.id}/scan`), { code: 'HAL-AU-100-BK', serialNumber: `AU-SN-${n}` })).status).toBe(200);
    expect((await call('PATCH', W(`/packages/${pkg.body.id}`), { boxTypeId: boxId, weight: { value: 2.2, unit: 'lb', fromScale: true } })).status).toBe(200);
    const options = await call('GET', W(`/packages/${pkg.body.id}/service-options`));
    expect(options.status, JSON.stringify(options.body)).toBe(200);
    expect(options.body[0]).toMatchObject({ carrier: 'UPS', service: 'UPS Ground', matchesCustomerChoice: true, keepsPromise: true, selected: true, rate: { currency: 'USD' } });
    const label = await call('POST', W(`/packages/${pkg.body.id}/label`), { format: 'pdf' }, { 'idempotency-key': newId() });
    expect(label.status, JSON.stringify(label.body)).toBe(200);
    expect(label.body).toMatchObject({ carrier: 'UPS', service: 'UPS Ground', format: 'pdf', trackingNumber: expect.any(String), package: { status: 'labelled', shipmentId: expect.any(String) } });
    const reprint = await call('GET', W(`/packages/${pkg.body.id}/label`));
    expect(reprint.status, JSON.stringify(reprint.body)).toBe(200);
    const slip = await call('GET', W(`/packages/${pkg.body.id}/packing-slip`));
    expect(slip.status, JSON.stringify(slip.body)).toBe(200);
    expect(slip.body.fileName).toBe(`packing-slip-${order.ref}-1.pdf`);

    // packed: shipping takes it to the carrier; the order ships and the reserved stock leaves
    const reservedBefore = (await inventory.findBySku('official', ['HAL-AU-100-BK']))[0]!.quantities.reserved;
    const packed = await call('POST', W(`/packages/${pkg.body.id}/pack`));
    expect(packed.status, JSON.stringify(packed.body)).toBe(200);
    await app.kernel.events.drain();
    ful = (await call('GET', W(`/fulfillments/${fulfillmentId}`))).body;
    expect(ful.status).toBe('dispatched');
    expect(ful.packages[0]).toMatchObject({ status: 'dispatched', trackingNumber: label.body.trackingNumber, shipmentId: label.body.package.shipmentId });
    const shipped = await orders.getOrder(order.id);
    expect(shipped!.groups[0]!.items.every((i) => i.state === 'shipped')).toBe(true);
    expect((await inventory.findBySku('official', ['HAL-AU-100-BK']))[0]!.quantities.reserved).toBe(reservedBefore - 2);
    expect((await call('GET', W(`/waves/${wave.body.id}`))).body.status).toBe('completed');
    expect(await api<any>('warehouse').getShippedSerials([item.id])).toEqual({ [item.id]: ['AU-SN-0', 'AU-SN-1'] });
  });
});
