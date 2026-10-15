/**
 * Shared setup for the orders behaviour tests: the app with orders and the modules it talks to, a movable
 * clock, recorded events and audit entries, and builders for checkout input.
 *
 * Built modules run for real: customers, identity, media (generated documents and signed links), inventory,
 * notifications and audit (record is wrapped to keep the entries). Stubbed APIs:
 *   offers.snapshotForOrder (offers is not built yet) → h.offers by offer id.
 *   catalog.snapshotForOrder / getProduct / listCategories → h.products, so the tests control purchase
 *     snapshots and can change a product after purchase (catalog is built, but creating approved products
 *     needs the whole seller submission flow).
 *   customers.getCustomerByUserId → the customer id equals the account id (callers.customer({ accountId })).
 *   identity.hasGuestOrderAccess → h.guestGrants ("sessionId:orderId").
 *   reports.registerDataset / requestExport / getExport → recorded calls and ExportJobs (reports is not built).
 */
import type { FastifyInstance } from 'fastify';
import { newId } from '../../../kernel/lib/ids.js';
import type * as audit from '../../../spec/audit.js';
import type * as catalog from '../../../spec/catalog.js';
import type * as media from '../../../spec/media.js';
import type * as offers from '../../../spec/offers.js';
import type { OrderCreateInput, OrderGroupInput, OrderItemInput } from '../../../spec/orders.js';
import type * as reports from '../../../spec/reports.js';
import { auth, buildTestApp, callers, movingClock } from '../../../testing/app.js';
import type { OrdersService } from '../service.js';

export const USD = (amount: number) => ({ amount, currency: 'USD' });

export interface Harness {
  app: FastifyInstance;
  clock: ReturnType<typeof movingClock>;
  service: OrdersService;
  events: { name: string; payload: any }[];
  audits: audit.RecordInput[];
  offers: Map<string, offers.OfferSnapshot>;
  products: Map<string, catalog.ProductSnapshot & { categoryId?: string | null }>;
  guestGrants: Set<string>;
  /** catalog.getProduct category by product id (overrides the snapshot's, for snapshots without one) */
  productCategories: Map<string, string>;
  exports: { requested: any[]; registered: string[] };
  /** media.attach calls (snapshot images kept for the order), with the owner orders expected */
  attached: { assetId: string; usage: any; owner: media.MediaOwner }[];
  /** media.getAsset answers: who uploaded each test image (unknown ids: no asset) */
  assetOwners: Map<string, media.MediaOwner>;
  /** fulfillment-service.isServiceOffer answers (harness({ fulfillmentService: true })): offers Marketly fulfils */
  serviceOffers: Set<string>;
  call(method: string, url: string, token: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: any }>;
  publish(source: string, name: string, payload: unknown): Promise<void>;
  named(name: string): any[];
}

export const CATEGORY = { root: newId(), child: newId() };

/**
 * fulfillmentService: orders sees fulfillment-service as on (an apiStubs entry answers its optional lookup without
 * booting it), with isServiceOffer answered from h.serviceOffers.
 */
export async function harness(o: { fulfillmentService?: boolean } = {}): Promise<Harness> {
  const clock = movingClock();
  const h = {
    clock,
    events: [] as Harness['events'],
    audits: [] as audit.RecordInput[],
    offers: new Map<string, offers.OfferSnapshot>(),
    products: new Map<string, catalog.ProductSnapshot & { categoryId?: string | null }>(),
    guestGrants: new Set<string>(),
    productCategories: new Map<string, string>(),
    exports: { requested: [] as any[], registered: [] as string[] },
    attached: [] as { assetId: string; usage: any; owner: media.MediaOwner }[],
    assetOwners: new Map<string, media.MediaOwner>(),
    serviceOffers: new Set<string>(),
  };
  const job = (over: Partial<reports.ExportJob> = {}): reports.ExportJob => ({
    id: newId(),
    ref: 'EX-261009-0001',
    dataset: 'orders.admin.orders',
    format: 'csv',
    filters: {},
    requestedBy: { kind: 'staff', id: newId() },
    state: 'queued',
    columnsExcluded: [],
    createdAt: clock.now().toISOString(),
    ...over,
  });
  const jobs = new Map<string, reports.ExportJob>();
  const app = await buildTestApp({
    only: ['orders', 'customers', 'identity', 'media', 'audit', 'reports', 'inventory', 'notifications'],
    clock,
    config: { rateLimits: false, launchPhase: 4 },
    apiStubs: {
      ...(o.fulfillmentService ? { 'fulfillment-service': { isServiceOffer: async (offerId: string) => h.serviceOffers.has(offerId) } } : {}),
      offers: {
        snapshotForOrder: async (offerId) => {
          const o = h.offers.get(offerId);
          if (!o) throw Object.assign(new Error('offer not found'), { statusCode: 404 });
          return structuredClone(o);
        },
      },
      catalog: {
        snapshotForOrder: async (variantId) => ({ ...structuredClone(h.products.get(variantId)!), takenAt: clock.now().toISOString() }),
        getProduct: async (productId) => {
          const p = [...h.products.values()].find((x) => x.productId === productId);
          return p ? ({ id: productId, categoryId: h.productCategories.get(productId) ?? p.categoryId ?? null } as unknown as catalog.Product) : null;
        },
        // product links: the slug is the title in lower case with dashes
        getProducts: async (ids) =>
          ids.flatMap((id) => {
            const p = [...h.products.values()].find((x) => x.productId === id);
            return p ? [{ product: { id, slug: p.title.toLowerCase().replace(/\W+/g, '-') } } as unknown as catalog.ProductRecord] : [];
          }),
        listCategories: async () =>
          [
            { id: CATEGORY.root, parentId: null, name: 'Home', slug: 'home', position: 1, visible: true, comingSoon: false, productCount: 0, children: [{ id: CATEGORY.child, parentId: CATEGORY.root, name: 'Kitchen', slug: 'kitchen', position: 1, visible: true, comingSoon: false, productCount: 0, children: [] }] },
          ] as catalog.Category[],
      },
      customers: {
        getCustomerByUserId: async (userId) => ({ id: userId, userId, ref: 'CU-000001', displayName: 'Sam Rivera', email: 'sam@example.com', accountStatus: 'active', canOrder: true, canMessage: true }),
      },
      identity: {
        hasGuestOrderAccess: async (sessionId, orderId) => h.guestGrants.has(`${sessionId}:${orderId}`),
      },
      media: {
        getAsset: async (assetId) => {
          const owner = h.assetOwners.get(assetId);
          return owner ? ({ id: assetId, owner } as media.MediaAsset) : null;
        },
        attach: async (assetId, usage, owner) => {
          h.attached.push({ assetId, usage, owner });
        },
      },
      audit: {
        record: async (entry) => {
          h.audits.push(entry);
          return newId();
        },
      },
      reports: {
        registerDataset: async (d) => {
          h.exports.registered.push(d.key);
        },
        requestExport: async (input) => {
          h.exports.requested.push(input);
          const j = job({ dataset: input.dataset, filters: input.filters, sellerId: input.sellerId ?? null });
          jobs.set(j.id, j);
          return j;
        },
        getExport: async (id) => {
          const j = jobs.get(id);
          if (!j) throw Object.assign(new Error('nope'), { statusCode: 404 });
          return { ...j, state: 'ready', downloadUrl: 'https://files.example/orders.csv?sig=1' };
        },
      },
    },
  });
  const events: Harness['events'] = h.events;
  for (const name of [
    'orders.order.placed',
    'orders.order.accepted',
    'orders.order.cancelled',
    'orders.order.completed',
    'orders.item.state_changed',
    'orders.item.cancelled',
    'orders.item.split',
    'orders.item.delayed',
    'orders.item.delivered',
    'orders.cancellation.requested',
    'orders.cancellation.decided',
    'orders.dispatch_deadline.changed',
    'orders.confirmation.requested',
    'inventory.reservation.released',
    'inventory.reservation.allocated',
  ]) {
    app.kernel.events.subscribe('test', name, (e) => void events.push({ name: e.name, payload: e.payload }));
  }
  const call: Harness['call'] = async (method, url, token, body, headers = {}) => {
    const res = await app.inject({ method: method as never, url, headers: { ...auth(token), ...headers }, ...(body !== undefined ? { payload: body as never } : {}) });
    await app.kernel.events.drain();
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
  };
  return {
    ...h,
    app,
    service: app.kernel.boot.apis.get('orders') as OrdersService,
    call,
    async publish(source, name, payload) {
      app.kernel.events.publish(source, name, payload);
      await app.kernel.events.drain();
    },
    named: (name) => events.filter((e) => e.name === name).map((e) => e.payload),
  };
}

/** An offer and its product snapshot registered in the stubs */
export function product(h: Harness, o: { title: string; price: number; ownerType?: 'official' | 'seller'; sellerId?: string | null; sellerName?: string; options?: Record<string, string>; categoryId?: string | null; condition?: string; imageId?: string | null }) {
  const offerId = newId();
  const productId = newId();
  const variantId = newId();
  const stockItemId = newId();
  const ownerType = o.ownerType ?? 'seller';
  h.products.set(variantId, {
    productId,
    variantId,
    productVersion: 3,
    title: o.title,
    brandName: 'Halden',
    options: o.options ?? { Color: 'Teal' },
    modelNumber: 'H-100',
    imageUrl: 'https://cdn.example/p.jpg',
    imageId: o.imageId ?? null,
    takenAt: new Date().toISOString(),
    categoryId: o.categoryId === undefined ? CATEGORY.child : o.categoryId,
  });
  h.offers.set(offerId, {
    offerId,
    termsVersion: 2,
    ownerType,
    sellerId: ownerType === 'seller' ? (o.sellerId ?? null) : null,
    sellerName: o.sellerName ?? (ownerType === 'official' ? 'Marketly Official Store' : 'Casa Verde Home'),
    condition: o.condition ?? 'new',
    conditionNotes: null,
    missingItems: [],
    price: USD(o.price),
    compareAt: null,
    dispatch: { businessDays: 1, sameDayCutoff: null, shipsFrom: 'Reno, NV', label: 'Ships in 1 business day' },
    returnTerms: { kind: 'baseline', windowDays: 30, freeReturnShipping: false, summary: '30-day returns.' },
    warranty: { kind: 'manufacturer', months: 24, handledBy: 'manufacturer', summary: '2-year manufacturer warranty' },
    stockItemId,
    takenAt: new Date().toISOString(),
    sellerSku: `SKU-${offerId.slice(0, 6)}`,
    title: o.title,
  });
  return { offerId, productId, variantId, stockItemId, price: o.price };
}

type P = ReturnType<typeof product>;

export function line(p: P, quantity: number, o: { discount?: number; shipping?: number; tax?: number; code?: string } = {}): OrderItemInput {
  return {
    offerId: p.offerId,
    variantId: p.variantId,
    stockItemId: p.stockItemId,
    quantity,
    unitPrice: USD(p.price),
    discounts: o.discount ? [{ code: o.code ?? 'WELCOME20', label: o.code ?? 'WELCOME20', amount: USD(o.discount), fundedBy: 'platform' }] : [],
    shippingShare: USD(o.shipping ?? 0),
    taxShare: USD(o.tax ?? 0),
    returnTerms: { summary: '30-day returns. Buyer pays return shipping for change of mind.', windowDays: 30, returnShippingPaidBy: 'depends_on_reason' },
    checkoutLineId: newId(),
  };
}

export function group(
  h: Harness,
  items: OrderItemInput[],
  o: { ownerType?: 'official' | 'seller'; sellerId?: string | null; dispatchInHours?: number; shipping?: number; fulfilledBy?: OrderGroupInput['fulfilledBy'] } = {},
): OrderGroupInput {
  const ownerType = o.ownerType ?? 'seller';
  const itemsTotal = items.reduce((s, i) => s + i.unitPrice.amount * i.quantity, 0);
  const discounts = items.reduce((s, i) => s + i.discounts.reduce((a, d) => a + d.amount.amount, 0), 0);
  const shipping = items.reduce((s, i) => s + i.shippingShare.amount, 0);
  const tax = items.reduce((s, i) => s + i.taxShare.amount, 0);
  const now = h.clock.now();
  const day = (d: number) => new Date(now.getTime() + d * 86_400_000).toISOString().slice(0, 10);
  return {
    key: newId(),
    ownerType,
    sellerId: ownerType === 'seller' ? (o.sellerId ?? null) : null,
    shipsFrom: 'Reno, NV',
    fulfilledBy: o.fulfilledBy ?? (ownerType === 'official' ? 'official_warehouse' : 'seller'),
    delivery: {
      methodName: 'Standard',
      carrier: 'UPS',
      service: 'Ground',
      price: USD(shipping),
      free: shipping === 0,
      fundedBy: shipping === 0 ? 'seller' : 'customer',
      arrival: { from: day(4), to: day(6) },
      dispatchBy: new Date(now.getTime() + (o.dispatchInHours ?? 48) * 3_600_000).toISOString(),
    },
    returnTermsSummary: '30-day returns.',
    items,
    totals: { items: USD(itemsTotal), discounts: USD(discounts), shipping: USD(shipping), tax: USD(tax), total: USD(itemsTotal - discounts + shipping + tax) },
  };
}

export function checkout(groups: OrderGroupInput[], o: { customerId?: string | null; email?: string; paymentState?: 'accepted' | 'pending_check'; checkoutSessionId?: string; attemptNo?: number; deliveryAddressId?: string | null; visitorId?: string | null } = {}): OrderCreateInput {
  const sum = (k: 'items' | 'discounts' | 'shipping' | 'tax' | 'total') => USD(groups.reduce((s, g) => s + g.totals[k].amount, 0));
  return {
    checkoutSessionId: o.checkoutSessionId ?? newId(),
    ...(o.attemptNo !== undefined ? { attemptNo: o.attemptNo } : {}),
    ...(o.deliveryAddressId !== undefined ? { deliveryAddressId: o.deliveryAddressId } : {}),
    ...(o.visitorId !== undefined ? { visitorId: o.visitorId } : {}),
    contact: o.customerId ? { kind: 'customer', customerId: o.customerId, name: 'Sam Rivera', email: o.email ?? 'sam@example.com', phone: '+15035550142' } : { kind: 'guest', name: 'Gia Guest', email: o.email ?? 'gia@example.com', phone: null },
    channel: 'web',
    currency: 'USD',
    deliveryAddress: { name: 'Sam Rivera', line1: '1 Main St', city: 'Portland', region: 'OR', postalCode: '97201', country: 'US', phone: '+15035550142' },
    giftNote: null,
    hidePricesOnSlip: false,
    policyVersions: [{ policyKey: 'returns', versionId: newId(), version: '3', effectiveAt: new Date('2026-01-01').toISOString() }],
    couponCodes: [],
    paymentIntentId: newId(),
    paymentState: o.paymentState ?? 'accepted',
    paymentMethodLabel: 'Visa •••• 4417',
    groups,
    totals: { items: sum('items'), discounts: sum('discounts'), shipping: sum('shipping'), tax: sum('tax'), total: sum('total') },
  };
}

export const tokens = {
  customer: (accountId: string) => callers.customer({ accountId }),
  seller: (sellerId: string, permissions?: string[]) => callers.seller({ sellerId, ...(permissions ? { permissions } : {}) }),
  staff: (permissions?: string[], over: { sub?: string } = {}) => callers.staff(permissions, over),
  visitor: () => callers.visitor(),
};

export const idem = () => ({ 'idempotency-key': newId() });
