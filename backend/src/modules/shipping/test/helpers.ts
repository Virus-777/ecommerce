/**
 * Shared setup for the shipping behaviour tests: the app with shipping, orders and the modules they talk to on a
 * movable clock, recorded events and audit entries, and builders for real orders (orders is built: orders are
 * created through orders.createOrder, so dispatch watches, shipments and item states run for real).
 *
 * Stubbed APIs (and why):
 *   offers.snapshotForOrder / getOffer / getOwnOffer / listOffersAdmin → h.offers (tests control offers that
 *     point at shipping profiles; creating real offers needs approved catalog products and sellers).
 *   catalog.snapshotForOrder → h.products (purchase snapshots for orders).
 *   customers.getCustomerByUserId → the customer id equals the account id.
 *   identity.hasGuestOrderAccess → h.guestGrants ("sessionId:orderId").
 *   access.check / requestApproval / getApproval / getStaffRef / membersOfRole → h.access (claims above the limit,
 *     staff names; dev staff tokens carry no access roles).
 *   audit.record → h.audits. notifications.notify → h.notices. reports.registerDataset → recorded (not built).
 *   sellers.getSellers → store names from h.sellerNames.
 *   fulfillment-service.getServiceLocation → h.serviceLocation (Fulfilled by Marketly, built in parallel).
 */
import type { FastifyInstance } from 'fastify';
import { newId } from '../../../kernel/lib/ids.js';
import { OFFICIAL_STORE_NAME } from '../../../spec/common.js';
import type * as common from '../../../spec/common.js';
import type * as access from '../../../spec/access.js';
import type * as audit from '../../../spec/audit.js';
import type * as catalog from '../../../spec/catalog.js';
import type * as notifications from '../../../spec/notifications.js';
import type * as offers from '../../../spec/offers.js';
import type { OrderCreateInput, OrderDetail, OrderGroupInput, OrderItemInput } from '../../../spec/orders.js';
import { auth, buildTestApp, callers, movingClock, signWebhook, tokenClock } from '../../../testing/app.js';
import type { ShippingService } from '../service.js';

export const USD = (amount: number) => ({ amount, currency: 'USD' });

export interface Harness {
  app: FastifyInstance;
  clock: ReturnType<typeof movingClock>;
  service: ShippingService;
  orders: { createOrder(input: OrderCreateInput): Promise<OrderDetail>; getOrder(id: string): Promise<OrderDetail | null>; acceptOrder(orderId: string, paymentIntentId: string): Promise<OrderDetail> };
  events: { name: string; payload: any }[];
  audits: audit.RecordInput[];
  notices: notifications.NotifyInput[];
  offers: Map<string, offers.Offer>;
  /** offers.countActiveOffersByProfile answers per profile id (else counted from offers) */
  offerCounts: Map<string, number>;
  snapshots: Map<string, offers.OfferSnapshot>;
  products: Map<string, catalog.ProductSnapshot>;
  guestGrants: Set<string>;
  sellerNames: Map<string, string>;
  access: { decision: 'allowed' | 'approval_required' | 'denied'; approvals: Map<string, access.ApprovalRequest['status']>; requested: any[] };
  /** fulfillment-service.getServiceLocation (Fulfilled by Marketly is built in parallel) */
  serviceLocation: { locationId: string; address: common.Address; shipsFrom: string } | null;
  call(method: string, url: string, token: string | null, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: any }>;
  webhook(carrier: string, body: unknown, o?: { eventId?: string; secret?: string }): Promise<{ status: number; body: any }>;
  publish(source: string, name: string, payload: unknown): Promise<void>;
  named(name: string): any[];
  runJob(name: string): Promise<void>;
}

const EVENTS = [
  'shipping.shipment.created',
  'shipping.shipment.dispatched',
  'shipping.shipment.status_changed',
  'shipping.shipment.delivered',
  'shipping.shipment.exception',
  'shipping.exception.updated',
  'shipping.exception.resolved',
  'shipping.dispatch.overdue',
  'shipping.tracking.corrected',
  'shipping.label.purchased',
  'shipping.label.voided',
  'shipping.delivery_choice.made',
  'shipping.claim.status_changed',
  'shipping.notice.published',
  'shipping.profile.changed',
  'shipping.coverage.changed',
  'orders.order.accepted',
  'orders.item.delayed',
  'orders.item.state_changed',
  'orders.dispatch_deadline.changed',
];

export async function harness(): Promise<Harness> {
  const clock = movingClock();
  // tokens are signed at the app's time, so jobs can move the clock days ahead
  tokenClock.now = () => clock.now();
  tokenClock.ttlSeconds = 90 * 86_400;
  const h = {
    clock,
    events: [] as Harness['events'],
    audits: [] as audit.RecordInput[],
    notices: [] as notifications.NotifyInput[],
    offers: new Map<string, offers.Offer>(),
    offerCounts: new Map<string, number>(),
    snapshots: new Map<string, offers.OfferSnapshot>(),
    products: new Map<string, catalog.ProductSnapshot>(),
    guestGrants: new Set<string>(),
    sellerNames: new Map<string, string>(),
    access: { decision: 'allowed' as Harness['access']['decision'], approvals: new Map<string, access.ApprovalRequest['status']>(), requested: [] as any[] },
    serviceLocation: { locationId: newId(), address: { name: 'Marketly Fulfillment', line1: '400 Dock St', city: 'Reno', region: 'NV', postalCode: '89502', country: 'US' }, shipsFrom: 'Reno, NV (Marketly warehouse)' } as Harness['serviceLocation'],
  };
  let out: Harness | undefined;
  // read from the harness the test holds, so a test can set h.serviceLocation (null: no service location)
  const serviceLocation = () => {
    const loc = (out ?? h).serviceLocation;
    return loc ? structuredClone(loc) : null;
  };
  const app = await buildTestApp({
    only: ['shipping', 'orders', 'customers', 'identity', 'media', 'audit', 'notifications', 'settings', 'access', 'sellers'],
    clock,
    config: { rateLimits: false, launchPhase: 4 },
    apiStubs: {
      offers: {
        snapshotForOrder: async (offerId) => {
          const o = h.snapshots.get(offerId);
          if (!o) throw Object.assign(new Error('offer not found'), { statusCode: 404 });
          return structuredClone(o);
        },
        getOffer: async (offerId) => h.offers.get(offerId) ?? null,
        getOwnOffer: async (sellerId, offerId) => {
          const o = h.offers.get(offerId);
          return o && o.sellerId === sellerId ? o : null;
        },
        listOffersAdmin: async (filter) => {
          const items = [...h.offers.values()].filter((o) => (filter.official ? o.ownerType === 'official' : o.sellerId === filter.sellerId) && (!filter.status?.length || filter.status.includes(o.status)));
          return { items, nextCursor: null };
        },
        // exact count of active offers per profile (h.offerCounts overrides it, e.g. more offers than any page holds)
        countActiveOffersByProfile: async (profileId) => h.offerCounts.get(profileId) ?? [...h.offers.values()].filter((o) => o.shippingProfileId === profileId && o.status === 'active').length,
      },
      catalog: {
        snapshotForOrder: async (variantId) => ({ ...structuredClone(h.products.get(variantId)!), takenAt: clock.now().toISOString() }),
      },
      customers: {
        getCustomerByUserId: async (userId) => ({ id: userId, userId, ref: 'CU-000001', displayName: 'Jordan Lee', email: 'jordan@example.com', accountStatus: 'active', canOrder: true, canMessage: true }),
      },
      identity: {
        hasGuestOrderAccess: async (sessionId, orderId) => h.guestGrants.has(`${sessionId}:${orderId}`),
      },
      audit: {
        record: async (entry) => {
          h.audits.push(entry);
          return newId();
        },
      },
      notifications: {
        notify: async (input) => {
          h.notices.push(input);
          return { noticeIds: [newId()], deliveryIds: [] };
        },
      },
      'fulfillment-service': {
        getServiceLocation: async () => serviceLocation(),
      },
      sellers: {
        getSellers: async (ids) =>
          ids.map((id) => ({ id, ref: 'SL-1', slug: 'seller', storeName: h.sellerNames.get(id) ?? 'Casa Verde Home', status: 'approved', verified: true, canSellNew: true, activeRestrictionIds: [], launchReady: true })),
      },
      access: {
        check: async (_p, action) => ({ decision: h.access.decision, action, reason: h.access.decision === 'denied' ? 'Your role has no authority' : 'Above your limit: Finance Manager approval', requiresSecondReviewer: false, approvalsNeeded: h.access.decision === 'approval_required' ? 1 : 0, eligibleApproverRoles: [], eligibleApprovers: [], stepUpRequired: false }),
        requestApproval: async (input) => {
          const id = newId();
          h.access.requested.push(input);
          h.access.approvals.set(id, 'pending');
          return { id, ref: 'AP-1', status: 'pending' } as unknown as access.ApprovalRequest;
        },
        getApproval: async (id) => (h.access.approvals.has(id) ? ({ id, status: h.access.approvals.get(id) } as unknown as access.ApprovalRequest) : null),
        approvalInfo: async (id) => ({ required: true, reason: `Finance approval ${h.access.approvals.get(id) ?? 'pending'}`, approvalRequestId: id, approvers: ['Finance Manager'] }),
        getStaffRef: async (staffId) => ({ accountId: staffId, name: 'Theo Grant', away: false, roleLabel: 'Shipping Manager' }),
        membersOfRole: async () => [{ accountId: newId(), name: 'Theo Grant', away: false, roleLabel: 'Shipping Manager' }],
      },
    },
  });
  const service = app.kernel.boot.apis.get('shipping') as ShippingService;
  // fulfillment-service (phase 4, rebuilt in parallel) cannot boot here yet, and tryUse only reaches enabled modules:
  // its getServiceLocation answer is fed straight to shipping's lookup until it can
  if (!app.kernel.modules.includes('fulfillment-service')) service.core.serviceLocation = async () => serviceLocation();
  const ordersApi = app.kernel.boot.apis.get('orders') as Harness['orders'];
  for (const name of EVENTS) app.kernel.events.subscribe('test', name, (e) => void h.events.push({ name: e.name, payload: e.payload }));
  const call: Harness['call'] = async (method, url, token, body, headers = {}) => {
    const res = await app.inject({ method: method as never, url, headers: { ...(token ? auth(token) : {}), ...headers }, ...(body !== undefined ? { payload: body as never } : {}) });
    await app.kernel.events.drain();
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
  };
  out = {
    ...h,
    app,
    service,
    orders: ordersApi,
    call,
    async webhook(carrier, body, o = {}) {
      const raw = JSON.stringify(body);
      const res = await app.inject({
        method: 'POST',
        url: `/webhooks/shipping/carriers/${carrier}/events`,
        headers: { 'content-type': 'application/json', ...signWebhook(o.secret ?? 'dev-webhook-secret', raw, Math.floor(clock.now().getTime() / 1000)), ...(o.eventId ? { 'x-event-id': o.eventId } : {}) },
        payload: raw,
      });
      await app.kernel.events.drain();
      return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
    },
    async publish(source, name, payload) {
      app.kernel.events.publish(source, name, payload);
      await app.kernel.events.drain();
    },
    named: (name) => h.events.filter((e) => e.name === name).map((e) => e.payload),
    async runJob(name) {
      await app.kernel.jobs.runNow(name as never);
      await app.kernel.events.drain();
    },
  };
  return out;
}

/* ---------------------------------------------------------------- orders */

export function product(h: Harness, o: { title: string; price: number; ownerType?: 'official' | 'seller'; sellerId?: string | null; variant?: string }) {
  const offerId = newId();
  const productId = newId();
  const variantId = newId();
  const stockItemId = newId();
  const ownerType = o.ownerType ?? 'seller';
  h.products.set(variantId, { productId, variantId, productVersion: 1, title: o.title, brandName: 'Halden', options: { Color: o.variant ?? 'Teal' }, modelNumber: 'H-1', imageUrl: 'https://cdn.example/p.jpg', takenAt: new Date().toISOString() } as catalog.ProductSnapshot);
  h.snapshots.set(offerId, {
    offerId,
    termsVersion: 1,
    ownerType,
    sellerId: ownerType === 'seller' ? (o.sellerId ?? null) : null,
    sellerName: ownerType === 'official' ? OFFICIAL_STORE_NAME : 'Casa Verde Home',
    sellerSku: 'SKU-1',
    title: o.title,
    condition: 'new',
    conditionNotes: null,
    missingItems: [],
    price: USD(o.price),
    compareAt: null,
    dispatch: { businessDays: 1, sameDayCutoff: null, shipsFrom: 'Reno, NV', label: 'Ships in 1 business day' },
    returnTerms: { kind: 'baseline', windowDays: 30, freeReturnShipping: false, summary: '30-day returns.' },
    warranty: { kind: 'manufacturer', months: 24, handledBy: 'manufacturer', summary: '2-year warranty' },
    stockItemId,
    takenAt: new Date().toISOString(),
  } as offers.OfferSnapshot);
  return { offerId, productId, variantId, stockItemId, price: o.price };
}

type P = ReturnType<typeof product>;

export function line(p: P, quantity: number): OrderItemInput {
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

export function group(h: Harness, items: OrderItemInput[], o: { ownerType?: 'official' | 'seller'; sellerId?: string | null; dispatchInHours?: number; fulfilledBy?: OrderGroupInput['fulfilledBy'] } = {}): OrderGroupInput {
  const ownerType = o.ownerType ?? 'seller';
  const total = items.reduce((s, i) => s + i.unitPrice.amount * i.quantity, 0);
  const now = h.clock.now();
  const day = (d: number) => new Date(now.getTime() + d * 86_400_000).toISOString().slice(0, 10);
  return {
    key: newId(),
    ownerType,
    sellerId: ownerType === 'seller' ? (o.sellerId ?? null) : null,
    shipsFrom: 'Reno, NV',
    fulfilledBy: o.fulfilledBy ?? (ownerType === 'official' ? 'official_warehouse' : 'seller'),
    delivery: { methodName: 'Standard', carrier: 'UPS', service: 'Ground', price: USD(0), free: true, fundedBy: 'seller', arrival: { from: day(4), to: day(9) }, dispatchBy: new Date(now.getTime() + (o.dispatchInHours ?? 48) * 3_600_000).toISOString() },
    returnTermsSummary: '30-day returns.',
    items,
    totals: { items: USD(total), discounts: USD(0), shipping: USD(0), tax: USD(0), total: USD(total) },
  };
}

export function checkout(groups: OrderGroupInput[], o: { customerId?: string | null; email?: string; pending?: boolean } = {}): OrderCreateInput {
  const sum = (k: 'items' | 'discounts' | 'shipping' | 'tax' | 'total') => USD(groups.reduce((s, g) => s + g.totals[k].amount, 0));
  return {
    checkoutSessionId: newId(),
    contact: o.customerId ? { kind: 'customer', customerId: o.customerId, name: 'Jordan Lee', email: o.email ?? 'jordan@example.com', phone: null } : { kind: 'guest', name: 'Gia Guest', email: o.email ?? 'gia@example.com', phone: null },
    channel: 'web',
    currency: 'USD',
    deliveryAddress: { name: 'Jordan Lee', line1: '1 Main St', city: 'Portland', region: 'OR', postalCode: '97205', country: 'US', phone: null },
    giftNote: null,
    hidePricesOnSlip: false,
    policyVersions: [],
    couponCodes: [],
    paymentIntentId: newId(),
    paymentState: o.pending ? 'pending_check' : 'accepted',
    paymentMethodLabel: 'Visa •••• 4417',
    groups,
    totals: { items: sum('items'), discounts: sum('discounts'), shipping: sum('shipping'), tax: sum('tax'), total: sum('total') },
  };
}

/** A seller order with two lines (2 speakers, 1 lamp), accepted (the dispatch watch is fed) */
export async function sellerOrder(h: Harness, o: { sellerId?: string; customerId?: string; dispatchInHours?: number; ownerType?: 'official' | 'seller'; fulfilledBy?: OrderGroupInput['fulfilledBy'] } = {}) {
  const sellerId = o.sellerId ?? newId();
  const customerId = o.customerId ?? newId();
  const ownerType = o.ownerType ?? 'seller';
  const a = product(h, { title: 'Pocket Speaker', price: 5000, sellerId, ownerType });
  const b = product(h, { title: 'Desk Lamp', price: 3000, sellerId, ownerType, variant: 'Black' });
  const order = await h.orders.createOrder(checkout([group(h, [line(a, 2), line(b, 1)], { sellerId, ownerType, ...(o.fulfilledBy ? { fulfilledBy: o.fulfilledBy } : {}), ...(o.dispatchInHours !== undefined ? { dispatchInHours: o.dispatchInHours } : {}) })], { customerId }));
  await h.app.kernel.events.drain();
  const g = order.groups[0]!;
  const speaker = g.items.find((i) => i.title.startsWith('Pocket'))!;
  const lamp = g.items.find((i) => i.title.startsWith('Desk'))!;
  return { order, sellerId, customerId, groupId: g.id, speaker, lamp };
}

export const tokens = {
  customer: (accountId: string) => callers.customer({ accountId }),
  seller: (sellerId: string, permissions?: string[]) => callers.seller({ sellerId, ...(permissions ? { permissions } : {}) }),
  staff: (permissions?: string[], over: { sub?: string } = {}) => callers.staff(permissions, over),
  visitor: () => callers.visitor(),
};

export const idem = () => ({ 'idempotency-key': newId() });

/** An offer (for estimates and profile use) pointing at a shipping profile */
export function offer(h: Harness, o: { profileId: string; sellerId?: string | null; businessDays?: number; status?: offers.Offer['status']; shipping?: offers.OfferShipping }): offers.Offer {
  const id = newId();
  const x = {
    id,
    ownerType: o.sellerId ? 'seller' : 'official',
    sellerId: o.sellerId ?? null,
    sellerName: 'Casa Verde Home',
    productId: newId(),
    variantId: newId(),
    condition: 'new',
    includedItems: [],
    missingItems: [],
    complete: true,
    sellerSku: 'SKU-1',
    stockItemId: newId(),
    price: USD(4000),
    dispatch: { businessDays: o.businessDays ?? 1, sameDayCutoff: null, shipsFrom: 'Reno, NV', label: 'Ships in 1 business day' },
    shippingProfileId: o.profileId,
    ...(o.shipping ? { shipping: o.shipping } : {}),
    status: o.status ?? 'active',
  } as unknown as offers.Offer;
  h.offers.set(id, x);
  return x;
}

/** UPS-format and USPS-format numbers (pass the seeded tracking patterns) */
export const ups = () => `1Z${Math.random().toString(36).slice(2, 8).toUpperCase().padEnd(6, 'X')}${String(Math.floor(Math.random() * 1e10)).padStart(10, '0')}`;
export const usps = () => `9400${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;
