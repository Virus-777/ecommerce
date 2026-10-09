/**
 * Shared setup for the returns behaviour tests: the app with returns, orders (real) and the modules they
 * talk to, a movable clock, recorded events and audit entries, and an order whose items are delivered.
 *
 * Built modules run for real: orders, customers, identity, media, notifications, reports' callers, access
 * (only its check / requestApproval / decide answers are controlled). Stubbed APIs:
 *   offers.snapshotForOrder, catalog.snapshotForOrder → purchase snapshots for orders.createOrder (as orders' tests);
 *     product({ categoryId }) puts the category on the snapshot, so orders keeps it on the order item.
 *   customers.getCustomerByUserId → the customer id equals the account id.
 *   identity.hasGuestOrderAccess → h.guestGrants ("sessionId:orderId").
 *   shipping (not built): createLabel returns a label and a return shipment (cost $6.50, QR for prepaid_qr,
 *     drop-off in 7 days); voidLabel, registerReturnTracking and findDropOffPoints are recorded.
 *   payments (not built): remainingRefundable = paid (orders.getPaidAmounts) − refunds started here;
 *     startRefund records the call and answers a requested Refund (idempotent per key); methodLabel 'Visa •••• 4417'.
 *   inventory (built, but the test orders have no real stock items): getAvailability → h.stock, hold / attachOrder recorded.
 *   access: check → h.authority (allowed by default), requestApproval / decide / getApproval / approvalInfo recorded.
 *   support (not built): openCase → a case CS-000123. finance (not built): previewRefundImpact → −the refund, 10% fee back.
 *   reports (not built): registerDataset / requestExport / getExport recorded. audit.record and notifications.notify recorded.
 */
import type { FastifyInstance } from 'fastify';
import { AppError } from '../../../kernel/errors/index.js';
import { newId } from '../../../kernel/lib/ids.js';
import type * as access from '../../../spec/access.js';
import type * as audit from '../../../spec/audit.js';
import type * as catalog from '../../../spec/catalog.js';
import type * as notifications from '../../../spec/notifications.js';
import type * as offers from '../../../spec/offers.js';
import type { OrderDetail, OrderGroupInput, OrderItemInput } from '../../../spec/orders.js';
import type * as payments from '../../../spec/payments.js';
import type * as reports from '../../../spec/reports.js';
import type * as shipping from '../../../spec/shipping.js';
import { auth, buildTestApp, callers, movingClock, tokenClock } from '../../../testing/app.js';
import type { ReturnsService } from '../service.js';

export const USD = (amount: number) => ({ amount, currency: 'USD' });
export const now = () => new Date().toISOString();

export interface Harness {
  app: FastifyInstance;
  clock: ReturnType<typeof movingClock>;
  service: ReturnsService;
  orders: import('../../../spec/orders.js').OrdersPublicApi;
  events: { name: string; payload: any }[];
  audits: audit.RecordInput[];
  offers: Map<string, offers.OfferSnapshot>;
  products: Map<string, catalog.ProductSnapshot & { categoryId?: string | null }>;
  guestGrants: Set<string>;
  stock: Map<string, number>;
  authority: { decision: 'allowed' | 'approval_required' | 'denied'; decideStatus: access.ApprovalRequest['status'] };
  calls: {
    labels: shipping.LabelRequest[];
    voided: string[];
    tracking: unknown[];
    refunds: payments.StartRefundInput[];
    holds: { key: string; lines: unknown[] }[];
    approvals: access.RequestApprovalInput[];
    decided: string[];
    cancelledApprovals: string[];
    cases: unknown[];
    notices: notifications.NotifyInput[];
    exports: unknown[];
  };
  call(method: string, url: string, token: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: any }>;
  gql(area: 'store' | 'seller' | 'admin', token: string, query: string, variables?: Record<string, unknown>): Promise<any>;
  publish(source: string, name: string, payload: unknown): Promise<void>;
  named(name: string): any[];
}

const RETURN_EVENTS = [
  'returns.return.requested',
  'returns.return.info_requested',
  'returns.return.approved',
  'returns.return.rejected',
  'returns.return.escalated',
  'returns.return.shipped',
  'returns.return.received',
  'returns.return.inspected',
  'returns.return.completed',
  'returns.return.cancelled',
  'returns.label.created',
  'returns.refund.requested',
  'returns.refund.approved',
  'returns.refund.declined',
  'returns.exception.proposed',
  'returns.exception.approved',
  'returns.replacement.created',
  'returns.seller_terms.changed',
  'returns.policy.proposed',
  'returns.policy.changed',
  'orders.item.delivered',
];

export async function harness(o: { only?: string[] } = {}): Promise<Harness> {
  const clock = movingClock();
  // tokens are signed at the app's time, so tests can move the clock ahead (deadlines) and sign new ones
  tokenClock.now = () => clock.now();
  const h = {
    clock,
    events: [] as Harness['events'],
    audits: [] as audit.RecordInput[],
    offers: new Map<string, offers.OfferSnapshot>(),
    products: new Map<string, catalog.ProductSnapshot & { categoryId?: string | null }>(),
    guestGrants: new Set<string>(),
    stock: new Map<string, number>(),
    authority: { decision: 'allowed' as Harness['authority']['decision'], decideStatus: 'approved' as access.ApprovalRequest['status'] },
    calls: { labels: [], voided: [], tracking: [], refunds: [], holds: [], approvals: [], decided: [], cancelledApprovals: [], cases: [], notices: [], exports: [] } as Harness['calls'],
  };
  const refunded = new Map<string, number>();
  const refundsByKey = new Map<string, payments.Refund>();
  let ordersApi: Harness['orders'];
  const app = await buildTestApp({
    only: o.only ?? ['returns', 'orders', 'customers', 'identity', 'media', 'audit', 'reports', 'inventory', 'notifications', 'access', 'support', 'finance'],
    clock,
    config: { rateLimits: false, launchPhase: 4 },
    apiStubs: {
      offers: {
        snapshotForOrder: async (offerId) => {
          const s = h.offers.get(offerId);
          if (!s) throw Object.assign(new Error('offer not found'), { statusCode: 404 });
          return structuredClone(s);
        },
      },
      catalog: {
        snapshotForOrder: async (variantId) => ({ ...structuredClone(h.products.get(variantId)!), takenAt: clock.now().toISOString() }),
      },
      customers: {
        getCustomerByUserId: async (userId) => ({ id: userId, userId, ref: 'CU-000001', displayName: 'Sam Rivera', email: 'sam@example.com', accountStatus: 'active', canOrder: true, canMessage: true }),
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
          h.calls.notices.push(input);
          return { noticeIds: [newId()], deliveryIds: [] };
        },
      },
      shipping: {
        createLabel: async (input, key) => {
          h.calls.labels.push(input);
          const id = newId();
          const label: shipping.Label = {
            id,
            shipmentId: newId(),
            groupId: input.groupId,
            carrierName: 'UPS',
            serviceName: 'Ground Returns',
            cost: USD(650),
            trackingNumber: `1ZRET${key.length}${Math.floor(Math.random() * 1e6)}`,
            labelUrl: 'https://labels.example/return.pdf',
            qrCodeUrl: input.labelMethod === 'prepaid_qr' ? 'https://labels.example/return-qr.png' : null,
            dropOffBy: new Date(clock.now().getTime() + 7 * 86_400_000).toISOString(),
            format: 'pdf',
            status: 'purchased',
            purchasedBy: { kind: 'system' },
            purchasedAt: clock.now().toISOString(),
          };
          return { label, shipment: { id: label.shipmentId } as shipping.Shipment };
        },
        voidLabel: async (labelId) => {
          h.calls.voided.push(labelId);
          return { id: labelId } as shipping.Label;
        },
        registerReturnTracking: async (input) => {
          h.calls.tracking.push(input);
          return { id: newId(), carrierName: 'USPS' } as shipping.Shipment;
        },
        findDropOffPoints: async () => [{ name: 'UPS Store 1234', address: { name: 'UPS Store', line1: '10 Market St', city: 'Portland', region: 'OR', postalCode: '97201', country: 'US' }, hours: '9–6', distanceMiles: 0.4, acceptsQr: true }],
      },
      payments: {
        remainingRefundable: async (orderId, ids) => {
          const paid = await ordersApi.getPaidAmounts(orderId);
          const items = paid
            .filter((p) => !ids || ids.includes(p.orderItemId))
            .map((p) => {
              const r = refunded.get(p.orderItemId) ?? 0;
              return { orderItemId: p.orderItemId, title: 'x', groupId: p.groupId, sellerName: 'x', paid: p.paid, refunded: USD(r), inFlight: USD(0), remaining: USD(Math.max(0, p.paid.amount - r)) };
            });
          const sum = (k: 'paid' | 'refunded' | 'remaining') => USD(items.reduce((s, i) => s + i[k].amount, 0));
          return { orderId, captured: sum('paid'), refunded: sum('refunded'), inFlight: USD(0), remaining: sum('remaining'), items };
        },
        startRefund: async (input, key) => {
          const existing = refundsByKey.get(key);
          if (existing) return existing;
          h.calls.refunds.push(input);
          for (const i of input.items) refunded.set(i.orderItemId, (refunded.get(i.orderItemId) ?? 0) + i.amount.amount);
          const amount = USD(input.items.reduce((s, i) => s + i.amount.amount, 0));
          const refund = { id: newId(), ref: input.requestRef ?? 'RF-1', orderId: input.orderId, origin: input.origin, originId: input.originId ?? null, amount, status: 'requested' } as unknown as payments.Refund;
          refundsByKey.set(key, refund);
          return refund;
        },
        methodLabel: async () => 'Visa •••• 4417',
      },
      inventory: {
        getAvailability: async (ids) => Object.fromEntries(ids.map((id) => [id, { available: h.stock.get(id) ?? 0, state: 'in_stock', lowStockThreshold: null, nextIncoming: null }])),
        hold: async (key, lines) => {
          h.calls.holds.push({ key, lines });
          for (const l of lines) if ((h.stock.get(l.stockItemId) ?? 0) < l.quantity) throw new AppError('INSUFFICIENT_STOCK', 'No stock', undefined, 409);
          return { id: newId(), key, state: 'held', lines: [], createdAt: clock.now().toISOString() } as never;
        },
        attachOrder: async (id) => ({ id }) as never,
      },
      access: {
        check: async (_p, action) => ({ decision: h.authority.decision, action, reason: h.authority.decision === 'allowed' ? 'Within your limit' : 'Above your limit: Business Owner approval', requiresSecondReviewer: false, approvalsNeeded: 1, eligibleApproverRoles: [], eligibleApprovers: [{ accountId: newId(), name: 'Olivia Owner', away: false }] }),
        requestApproval: async (input) => {
          h.calls.approvals.push(input);
          return { id: newId(), ref: 'AP-1', status: 'pending' } as access.ApprovalRequest;
        },
        getApproval: async (id) => ({ id, status: 'pending' }) as access.ApprovalRequest,
        decide: async (id) => {
          h.calls.decided.push(id);
          return { id, status: h.authority.decideStatus } as access.ApprovalRequest;
        },
        cancelApproval: async (id) => {
          h.calls.cancelledApprovals.push(id);
        },
        approvalInfo: async (id) => ({ required: true, reason: 'Waiting for approval', approvalRequestId: id, approvers: ['Olivia Owner'] }),
        getStaffRef: async (id) => ({ accountId: id, name: 'Rita Returns', away: false }),
        resolveRecipients: async () => ({ roleKey: 'returns_manager', leadAccountId: newId(), accountIds: [], ccAccountIds: [], viaBackup: false, escalationRoleKey: 'business_owner' }),
      },
      support: {
        openCase: async (input) => {
          h.calls.cases.push(input);
          return { id: newId(), ref: 'CS-000123' } as never;
        },
      },
      finance: {
        previewRefundImpact: async (_ids, refund) => ({ sellerEarningsChange: USD(-refund.amount), feeReturned: USD(Math.round(refund.amount / 10)), afterPayout: false, note: 'Deducted from the next payout' }),
      },
      reports: {
        registerDataset: async () => undefined,
        requestExport: async (input) => {
          h.calls.exports.push(input);
          return { id: newId(), ref: 'EX-1', dataset: input.dataset, format: 'csv', filters: input.filters, requestedBy: { kind: 'seller' }, state: 'queued', columnsExcluded: [], createdAt: clock.now().toISOString(), sellerId: input.sellerId ?? null } as reports.ExportJob;
        },
        getExport: async (id) => ({ id, ref: 'EX-1', dataset: 'returns.seller.requests', format: 'csv', filters: {}, requestedBy: { kind: 'seller' }, state: 'ready', columnsExcluded: [], createdAt: clock.now().toISOString(), downloadUrl: 'https://files.example/returns.csv' }) as reports.ExportJob,
      },
    },
  });
  const service = app.kernel.boot.apis.get('returns') as ReturnsService;
  ordersApi = app.kernel.boot.apis.get('orders') as Harness['orders'];
  for (const name of RETURN_EVENTS) app.kernel.events.subscribe('test', name, (e) => void h.events.push({ name: e.name, payload: e.payload }));
  const call: Harness['call'] = async (method, url, token, body, headers = {}) => {
    const res = await app.inject({ method: method as never, url, headers: { ...auth(token), ...headers }, ...(body !== undefined ? { payload: body as never } : {}) });
    await app.kernel.events.drain();
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
  };
  return {
    ...h,
    app,
    service,
    orders: ordersApi,
    call,
    gql: (area, token, query, variables = {}) => app.inject({ method: 'POST', url: `/graphql/${area}`, headers: { ...auth(token), 'content-type': 'application/json' }, payload: { query, variables } }).then((r) => JSON.parse(r.body)),
    async publish(source, name, payload) {
      app.kernel.events.publish(source, name, payload);
      await app.kernel.events.drain();
    },
    named: (name) => h.events.filter((e) => e.name === name).map((e) => e.payload),
  };
}

/** An offer and its product snapshot registered in the stubs */
export function product(h: Harness, o: { title: string; price: number; ownerType?: 'official' | 'seller'; sellerId?: string | null; windowDays?: number; categoryId?: string | null }) {
  const offerId = newId();
  const productId = newId();
  const variantId = newId();
  const stockItemId = newId();
  const ownerType = o.ownerType ?? 'seller';
  h.products.set(variantId, { productId, variantId, productVersion: 1, title: o.title, brandName: 'Halden', options: { Color: 'Teal' }, modelNumber: 'H-100', imageUrl: 'https://cdn.example/p.jpg', takenAt: new Date().toISOString(), categoryId: o.categoryId ?? null });
  h.offers.set(offerId, {
    offerId,
    termsVersion: 1,
    ownerType,
    sellerId: ownerType === 'seller' ? (o.sellerId ?? null) : null,
    sellerName: ownerType === 'official' ? 'Marketly Official Store' : 'Casa Verde Home',
    condition: 'new',
    conditionNotes: null,
    missingItems: [],
    price: USD(o.price),
    compareAt: null,
    dispatch: { businessDays: 1, sameDayCutoff: null, shipsFrom: 'Reno, NV', label: 'Ships in 1 business day' },
    returnTerms: { kind: 'baseline', windowDays: o.windowDays ?? 30, freeReturnShipping: false, summary: `${o.windowDays ?? 30}-day returns.` },
    warranty: { kind: 'manufacturer', months: 24, handledBy: 'manufacturer', summary: '2-year manufacturer warranty' },
    stockItemId,
    takenAt: new Date().toISOString(),
  });
  return { offerId, productId, variantId, stockItemId, price: o.price, windowDays: o.windowDays ?? 30 };
}

type P = ReturnType<typeof product>;

export function line(p: P, quantity: number, o: { discount?: number; shipping?: number; tax?: number } = {}): OrderItemInput {
  return {
    offerId: p.offerId,
    variantId: p.variantId,
    stockItemId: p.stockItemId,
    quantity,
    unitPrice: USD(p.price),
    discounts: o.discount ? [{ code: 'WELCOME', label: 'WELCOME', amount: USD(o.discount), fundedBy: 'platform' }] : [],
    shippingShare: USD(o.shipping ?? 0),
    taxShare: USD(o.tax ?? 0),
    returnTerms: { summary: `${p.windowDays}-day returns.`, windowDays: p.windowDays, returnShippingPaidBy: 'depends_on_reason' },
    checkoutLineId: newId(),
  };
}

export function group(h: Harness, items: OrderItemInput[], o: { ownerType?: 'official' | 'seller'; sellerId?: string | null; sellerName?: string } = {}): OrderGroupInput {
  const ownerType = o.ownerType ?? 'seller';
  const sum = (f: (i: OrderItemInput) => number) => items.reduce((s, i) => s + f(i), 0);
  const itemsTotal = sum((i) => i.unitPrice.amount * i.quantity);
  const discounts = sum((i) => i.discounts.reduce((a, d) => a + d.amount.amount, 0));
  const shipping = sum((i) => i.shippingShare.amount);
  const tax = sum((i) => i.taxShare.amount);
  const t = h.clock.now();
  const day = (d: number) => new Date(t.getTime() + d * 86_400_000).toISOString().slice(0, 10);
  return {
    key: newId(),
    ownerType,
    sellerId: ownerType === 'seller' ? (o.sellerId ?? null) : null,
    shipsFrom: 'Reno, NV',
    fulfilledBy: ownerType === 'official' ? 'official_warehouse' : 'seller',
    delivery: { methodName: 'Standard', carrier: 'UPS', service: 'Ground', price: USD(shipping), free: shipping === 0, fundedBy: shipping === 0 ? 'seller' : 'customer', arrival: { from: day(4), to: day(6) }, dispatchBy: new Date(t.getTime() + 48 * 3_600_000).toISOString() },
    returnTermsSummary: '30-day returns.',
    items,
    totals: { items: USD(itemsTotal), discounts: USD(discounts), shipping: USD(shipping), tax: USD(tax), total: USD(itemsTotal - discounts + shipping + tax) },
  };
}

export interface Placed {
  order: OrderDetail;
  customerId: string;
  /** item id per group index, in order */
  items: string[][];
}

/** Places an order (orders.createOrder), and ships and delivers every item unless deliver is false */
export async function placeOrder(h: Harness, groups: OrderGroupInput[], o: { customerId?: string | null; deliver?: boolean } = {}): Promise<Placed> {
  const customerId = o.customerId === undefined ? newId() : o.customerId;
  const sum = (k: 'items' | 'discounts' | 'shipping' | 'tax' | 'total') => USD(groups.reduce((s, g) => s + g.totals[k].amount, 0));
  const order = await h.orders.createOrder({
    checkoutSessionId: newId(),
    contact: customerId ? { kind: 'customer', customerId, name: 'Sam Rivera', email: 'sam@example.com', phone: '+15035550142' } : { kind: 'guest', name: 'Gia Guest', email: 'gia@example.com', phone: null },
    channel: 'web',
    currency: 'USD',
    deliveryAddress: { name: 'Sam Rivera', line1: '1 Main St', city: 'Portland', region: 'OR', postalCode: '97201', country: 'US', phone: '+15035550142' },
    giftNote: null,
    hidePricesOnSlip: false,
    policyVersions: [],
    couponCodes: [],
    paymentIntentId: newId(),
    paymentState: 'accepted',
    paymentMethodLabel: 'Visa •••• 4417',
    groups,
    totals: { items: sum('items'), discounts: sum('discounts'), shipping: sum('shipping'), tax: sum('tax'), total: sum('total') },
  });
  await h.app.kernel.events.drain();
  if (o.deliver !== false) {
    for (const g of order.groups) {
      const shipmentId = newId();
      const lines = g.items.map((i) => ({ orderItemId: i.id, quantity: i.quantity, title: 'x', variantLabel: '' }));
      const sellerId = g.seller.id ?? null;
      await h.publish('shipping', 'shipping.shipment.created', { shipmentId, kind: 'outbound', orderId: order.id, groupId: g.id, sellerId, packageLabel: 'Package', carrierCode: 'ups', carrierName: 'UPS', serviceName: null, trackingNumber: '1Z1', trackingUrl: null, lines, status: 'label_created' });
      await h.publish('shipping', 'shipping.shipment.dispatched', { shipmentId, kind: 'outbound', orderId: order.id, groupId: g.id, ownerType: g.seller.ownerType, sellerId, lines, shippedAt: now(), dispatchDueAt: null, onTime: true, trackingValid: true, estimatedArrival: null });
      await h.publish('shipping', 'shipping.shipment.delivered', { shipmentId, kind: 'outbound', orderId: order.id, groupId: g.id, sellerId, lines, deliveredAt: now() });
    }
  }
  const fresh = (await h.orders.getOrder(order.id))!;
  return { order: fresh, customerId: customerId ?? '', items: fresh.groups.map((g) => g.items.map((i) => i.id)) };
}

export const tokens = {
  customer: (accountId: string) => callers.customer({ accountId }),
  seller: (sellerId: string, permissions?: string[]) => callers.seller({ sellerId, ...(permissions ? { permissions } : {}) }),
  staff: (permissions?: string[], over: { sub?: string } = {}) => callers.staff(permissions, over),
  visitor: () => callers.visitor(),
};

export const idem = () => ({ 'idempotency-key': newId() });
