/**
 * Shared setup for the messaging behaviour tests: the app with messaging and the modules it talks to, a movable
 * clock, recorded events and audit entries, and real orders placed through orders.createOrder.
 *
 * Built modules run for real: orders (placement, getOrder, getOrdersByIds), media (attachment uploads), identity,
 * notifications and audit (record is wrapped to keep the entries). Stubbed APIs:
 *   offers.snapshotForOrder / catalog.snapshotForOrder → h.offers / h.products (as the orders tests do).
 *   customers.getCustomerByUserId → the customer id equals the account id (callers.customer({ accountId }));
 *     customers.canSendMessages → h.restricted (customer ids with a messaging restriction).
 *   identity.hasGuestOrderAccess → h.guestGrants ("sessionId:orderId").
 *   returns.returnStateForItems → h.returns (returns is not built yet).
 *   support.casesForOrder → h.cases (support is not built yet).
 *   trust.raiseSignal → recorded in h.signals (trust is not built yet).
 *   sellers.getSeller / getStorefrontCard → h.sellers (to control store names and unknown sellers).
 */
import type { FastifyInstance } from 'fastify';
import { newId } from '../../../kernel/lib/ids.js';
import type * as audit from '../../../spec/audit.js';
import type * as catalog from '../../../spec/catalog.js';
import type * as offers from '../../../spec/offers.js';
import type { OrderCreateInput, OrderDetail, OrderGroupInput, OrderItemInput, OrdersPublicApi } from '../../../spec/orders.js';
import type * as sellers from '../../../spec/sellers.js';
import type * as trust from '../../../spec/trust.js';
import { auth, buildTestApp, callers, movingClock, tokenClock } from '../../../testing/app.js';
import type { MessagingService } from '../service.js';

export const USD = (amount: number) => ({ amount, currency: 'USD' });

export interface Harness {
  app: FastifyInstance;
  clock: ReturnType<typeof movingClock>;
  service: MessagingService;
  orders: OrdersPublicApi;
  events: { name: string; payload: any }[];
  audits: audit.RecordInput[];
  offers: Map<string, offers.OfferSnapshot>;
  products: Map<string, catalog.ProductSnapshot>;
  guestGrants: Set<string>;
  restricted: Set<string>;
  returns: { orderItemId: string; returnId: string; ref: string; status: string }[];
  cases: { orderId: string; caseId: string; ref: string; status: string; orderItemIds: string[] }[];
  signals: any[];
  sellers: Map<string, { storeName: string; verified?: boolean }>;
  /** workqueues.raise inputs and resolveBySource keys */
  work: any[];
  resolved: string[];
  call(method: string, url: string, token: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: any }>;
  gql(area: 'store' | 'seller' | 'admin', token: string, query: string, variables?: Record<string, unknown>): Promise<any>;
  publish(source: string, name: string, payload: unknown): Promise<void>;
  named(name: string): any[];
  runJob(name: 'messaging.reply-deadlines' | 'messaging.archive' | 'messaging.response-stats'): Promise<void>;
}

export async function harness(): Promise<Harness> {
  const clock = movingClock();
  // tokens are signed at the app's time and outlive the clock moves of the deadline tests
  tokenClock.now = () => clock.now();
  tokenClock.ttlSeconds = 30 * 86_400;
  const h = {
    clock,
    events: [] as Harness['events'],
    audits: [] as audit.RecordInput[],
    offers: new Map<string, offers.OfferSnapshot>(),
    products: new Map<string, catalog.ProductSnapshot>(),
    guestGrants: new Set<string>(),
    restricted: new Set<string>(),
    returns: [] as Harness['returns'],
    cases: [] as Harness['cases'],
    signals: [] as any[],
    sellers: new Map<string, { storeName: string; verified?: boolean }>(),
    work: [] as any[],
    resolved: [] as string[],
  };
  const sellerSnapshot = (id: string): sellers.SellerSnapshot | null => {
    const s = h.sellers.get(id);
    return s ? { id, ref: 'SL-20714', slug: s.storeName.toLowerCase().replace(/\W+/g, '-'), storeName: s.storeName, status: 'approved', verified: s.verified ?? true, canSellNew: true, activeRestrictionIds: [], launchReady: true } : null;
  };
  const app = await buildTestApp({
    only: ['messaging', 'orders', 'customers', 'identity', 'media', 'audit', 'notifications', 'sellers', 'returns', 'support', 'trust', 'workqueues'],
    clock,
    config: { rateLimits: false, launchPhase: 4 },
    apiStubs: {
      offers: {
        snapshotForOrder: async (offerId) => structuredClone(h.offers.get(offerId)!),
      },
      catalog: {
        snapshotForOrder: async (variantId) => ({ ...structuredClone(h.products.get(variantId)!), takenAt: clock.now().toISOString() }),
      },
      customers: {
        getCustomerByUserId: async (userId) => ({ id: userId, userId, ref: 'CU-000001', displayName: 'Sam Rivera', email: 'sam@example.com', accountStatus: 'active', canOrder: true, canMessage: !h.restricted.has(userId) }) as never,
        getCustomer: async (id) => ({ id, userId: id, ref: 'CU-000001', displayName: 'Sam Rivera', email: 'sam@example.com', accountStatus: 'active', canOrder: true, canMessage: true }) as never,
        canSendMessages: async (customerId) => (h.restricted.has(customerId) ? { allowed: false, reason: 'Messaging is paused on your account until Oct 20' } : { allowed: true }),
      },
      identity: {
        hasGuestOrderAccess: async (sessionId, orderId) => h.guestGrants.has(`${sessionId}:${orderId}`),
      },
      returns: {
        returnStateForItems: async (ids) => ids.map((id) => {
          const r = h.returns.find((x) => x.orderItemId === id);
          return { orderItemId: id, returnId: r?.returnId ?? null, ref: r?.ref ?? null, status: r?.status ?? null, refundStatus: null };
        }),
      },
      support: {
        casesForOrder: async (orderId) => h.cases.filter((c) => c.orderId === orderId).map(({ caseId, ref, status, orderItemIds }) => ({ caseId, ref, status, orderItemIds })),
      },
      trust: {
        raiseSignal: async (input) => {
          h.signals.push(input);
          return { id: newId(), ref: 'TR-261009-0001' } as unknown as trust.TrustReport;
        },
      },
      sellers: {
        getSeller: async (id) => sellerSnapshot(id),
        getSellers: async (ids) => ids.map(sellerSnapshot).filter((s): s is sellers.SellerSnapshot => !!s),
        getApplicationParticipant: async (applicationId) => ({ applicationId, ref: 'SA-261009-0001', state: 'submitted', applicantAccountId: `${applicationId.slice(0, -4)}acc1`, sellerId: null, name: 'Rae Applicant', email: 'rae@example.com', storeName: 'Rae Studio' }),
        getStorefrontCard: async (ids) =>
          ids.flatMap((id) => {
            const s = sellerSnapshot(id);
            return s ? [{ id, slug: s.slug, storeName: s.storeName, verified: s.verified, location: 'Portland, OR', logo: null }] : [];
          }),
      },
      workqueues: {
        raise: async (input) => {
          h.work.push(input);
          return { id: newId() } as never;
        },
        resolveBySource: async (key) => {
          h.resolved.push(key);
          return 1;
        },
      },
      audit: {
        record: async (entry) => {
          h.audits.push(entry);
          return newId();
        },
      },
    },
  });
  const service = app.kernel.boot.apis.get('messaging') as MessagingService;
  const ordersService = app.kernel.boot.apis.get('orders') as OrdersPublicApi;
  for (const name of ['messaging.message.sent', 'messaging.conversation.started', 'messaging.reply.overdue', 'messaging.message.reported', 'messaging.conversation.locked', 'messaging.conversation.unlocked']) {
    app.kernel.events.subscribe('test', name, (e) => void h.events.push({ name: e.name, payload: e.payload }));
  }
  const call: Harness['call'] = async (method, url, token, body, headers = {}) => {
    const res = await app.inject({ method: method as never, url, headers: { ...auth(token), ...headers }, ...(body !== undefined ? { payload: body as never } : {}) });
    await app.kernel.events.drain();
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
  };
  return {
    ...h,
    app,
    service,
    orders: ordersService,
    call,
    async gql(area, token, query, variables) {
      const res = await app.inject({ method: 'POST', url: `/graphql/${area}`, headers: auth(token), payload: { query, ...(variables ? { variables } : {}) } });
      return JSON.parse(res.body);
    },
    async publish(source, name, payload) {
      app.kernel.events.publish(source, name, payload);
      await app.kernel.events.drain();
    },
    named: (name) => h.events.filter((e) => e.name === name).map((e) => e.payload),
    async runJob(name) {
      await app.kernel.jobs.runNow(name);
      await app.kernel.events.drain();
    },
  };
}

/** An offer and its product snapshot registered in the stubs */
export function product(h: Harness, o: { title: string; price: number; ownerType?: 'official' | 'seller'; sellerId?: string | null; sellerName?: string }) {
  const offerId = newId();
  const productId = newId();
  const variantId = newId();
  const stockItemId = newId();
  const ownerType = o.ownerType ?? 'seller';
  h.products.set(variantId, { productId, variantId, productVersion: 1, title: o.title, brandName: 'Halden', options: { Color: 'Teal' }, modelNumber: 'H-100', imageUrl: 'https://cdn.example/p.jpg', takenAt: new Date().toISOString() });
  h.offers.set(offerId, {
    offerId,
    termsVersion: 1,
    ownerType,
    sellerId: ownerType === 'seller' ? (o.sellerId ?? null) : null,
    sellerName: o.sellerName ?? (ownerType === 'official' ? 'Marketly Official Store' : 'Casa Verde Home'),
    condition: 'new',
    conditionNotes: null,
    missingItems: [],
    price: USD(o.price),
    compareAt: null,
    dispatch: { businessDays: 1, sameDayCutoff: null, shipsFrom: 'Reno, NV', label: 'Ships in 1 business day' },
    returnTerms: { kind: 'baseline', windowDays: 30, freeReturnShipping: false, summary: '30-day returns.' },
    warranty: { kind: 'manufacturer', months: 24, handledBy: 'manufacturer', summary: '2-year manufacturer warranty' },
    stockItemId,
    takenAt: new Date().toISOString(),
  } as unknown as offers.OfferSnapshot);
  return { offerId, productId, variantId, stockItemId, price: o.price };
}

type P = ReturnType<typeof product>;

function line(p: P, quantity: number): OrderItemInput {
  return {
    offerId: p.offerId,
    variantId: p.variantId,
    stockItemId: p.stockItemId,
    quantity,
    unitPrice: USD(p.price),
    discounts: [],
    shippingShare: USD(0),
    taxShare: USD(0),
    returnTerms: { summary: '30-day returns.', windowDays: 30, returnShippingPaidBy: 'depends_on_reason' },
    checkoutLineId: newId(),
  };
}

function group(h: Harness, items: OrderItemInput[], o: { ownerType?: 'official' | 'seller'; sellerId?: string | null }): OrderGroupInput {
  const ownerType = o.ownerType ?? 'seller';
  const total = items.reduce((s, i) => s + i.unitPrice.amount * i.quantity, 0);
  const now = h.clock.now();
  const day = (d: number) => new Date(now.getTime() + d * 86_400_000).toISOString().slice(0, 10);
  return {
    key: newId(),
    ownerType,
    sellerId: ownerType === 'seller' ? (o.sellerId ?? null) : null,
    shipsFrom: 'Reno, NV',
    fulfilledBy: ownerType === 'official' ? 'official_warehouse' : 'seller',
    delivery: { methodName: 'Standard', carrier: 'UPS', service: 'Ground', price: USD(0), free: true, fundedBy: 'seller', arrival: { from: day(4), to: day(6) }, dispatchBy: new Date(now.getTime() + 48 * 3_600_000).toISOString() },
    returnTermsSummary: '30-day returns.',
    items,
    totals: { items: USD(total), discounts: USD(0), shipping: USD(0), tax: USD(0), total: USD(total) },
  };
}

function checkout(groups: OrderGroupInput[], o: { customerId?: string | null }): OrderCreateInput {
  const sum = (k: 'items' | 'discounts' | 'shipping' | 'tax' | 'total') => USD(groups.reduce((s, g) => s + g.totals[k].amount, 0));
  return {
    checkoutSessionId: newId(),
    contact: o.customerId ? { kind: 'customer', customerId: o.customerId, name: 'Sam Rivera', email: 'sam@example.com', phone: '+15035550142' } : { kind: 'guest', name: 'Gia Guest', email: 'gia@example.com', phone: null },
    channel: 'web',
    currency: 'USD',
    deliveryAddress: { name: 'Sam Rivera', line1: '1 Main St', city: 'Portland', region: 'OR', postalCode: '97201', country: 'US', phone: '+15035550142' },
    giftNote: null,
    hidePricesOnSlip: false,
    policyVersions: [{ policyKey: 'returns', versionId: newId(), version: '3', effectiveAt: new Date('2026-01-01').toISOString() }],
    couponCodes: [],
    paymentIntentId: newId(),
    paymentState: 'accepted',
    paymentMethodLabel: 'Visa •••• 4417',
    groups,
    totals: { items: sum('items'), discounts: sum('discounts'), shipping: sum('shipping'), tax: sum('tax'), total: sum('total') },
  };
}

export interface Placed {
  order: OrderDetail;
  customerId: string | null;
  sellerA: string;
  sellerB: string;
  itemA: string;
  itemB: string;
  itemO: string;
}

/** A mixed order (two sellers and the Official Store) placed through orders, for a customer or a guest */
export async function placeOrder(h: Harness, o: { guest?: boolean } = {}): Promise<Placed> {
  const customerId = o.guest ? null : newId();
  const sellerA = newId();
  const sellerB = newId();
  h.sellers.set(sellerA, { storeName: 'Casa Verde Home' });
  h.sellers.set(sellerB, { storeName: 'Pixel & Port' });
  const pa = product(h, { title: 'Linen duvet cover', price: 8900, sellerId: sellerA, sellerName: 'Casa Verde Home' });
  const pb = product(h, { title: 'Pocket Speaker', price: 5000, sellerId: sellerB, sellerName: 'Pixel & Port' });
  const po = product(h, { title: 'Cast iron skillet', price: 4000, ownerType: 'official' });
  const order = await h.orders.createOrder(
    checkout([group(h, [line(pa, 1)], { sellerId: sellerA }), group(h, [line(pb, 1)], { sellerId: sellerB }), group(h, [line(po, 1)], { ownerType: 'official' })], { customerId }),
  );
  await h.app.kernel.events.drain();
  const items = order.groups.map((g) => g.items[0]!.id);
  return { order, customerId, sellerA, sellerB, itemA: items[0]!, itemB: items[1]!, itemO: items[2]! };
}

export const tokens = {
  customer: (accountId: string) => callers.customer({ accountId }),
  seller: (sellerId: string, permissions?: string[], name?: string) =>
    callers.seller({ sellerId, ...(permissions ? { permissions } : {}) }, name ? { dev: { isOwner: !permissions, permissions: permissions ?? [], name } } : {}),
  staff: (permissions?: string[], o: { sub?: string; name?: string } = {}) =>
    callers.staff(permissions, { ...(o.sub ? { sub: o.sub } : {}), ...(o.name ? { dev: { permissions: permissions ?? ['*'], name: o.name } } : {}) }),
  visitor: (sid?: string) => callers.visitor({}, sid ? { sid } : {}),
};

export const STORE = '/api/store/messaging';
export const SELLER = '/api/seller/messaging';
export const ADMIN = '/api/admin/messaging';
