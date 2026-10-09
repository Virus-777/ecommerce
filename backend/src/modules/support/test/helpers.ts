/**
 * Shared setup for the support behaviour tests: the app with support and the modules it talks to, a movable
 * clock, recorded events and audit entries, and real orders placed through orders.createOrder.
 *
 * Real modules: support, orders, returns (refund requests, approval, hand-over), settings (business calendar),
 * customers, identity, media, notifications, shipping and payments (booted as dependencies of returns).
 * Stubbed APIs (to control answers):
 *   offers.snapshotForOrder, catalog.snapshotForOrder → purchase snapshots for orders.createOrder (as orders' tests).
 *   customers.getCustomerByUserId → the customer id equals the account id.
 *   identity.hasGuestOrderAccess → h.guestGrants ("sessionId:orderId").
 *   payments: remainingRefundable = paid (orders.getPaidAmounts) − refunds started here; startRefund records the
 *     call and answers a requested Refund (the test then publishes payments.refund.sent / failed); methodLabel.
 *   access: check → h.authority[action] (allowed by default); requestApproval / decide / getApproval recorded;
 *     getStaffRef → a name for any id not in h.unknownStaff; membersOfRole → h.members[role];
 *     resolveRecipients → h.lead as the lead of every role.
 *   media: attach records the usage (ids in h.missingFiles → NOT_FOUND), refs answers a URL per id.
 *   finance.previewRefundImpact (returns' refund view), audit.record and notifications.notify recorded.
 *   wallet (only with harness({ wallet: true })): grantGoodwill answers a grant pending approval (h.calls.goodwill).
 */
import type { FastifyInstance } from 'fastify';
import { AppError } from '../../../kernel/errors/index.js';
import { newId } from '../../../kernel/lib/ids.js';
import type * as access from '../../../spec/access.js';
import type * as audit from '../../../spec/audit.js';
import type * as catalog from '../../../spec/catalog.js';
import type * as offers from '../../../spec/offers.js';
import type { OrderDetail, OrderGroupInput, OrderItemInput, OrdersPublicApi } from '../../../spec/orders.js';
import type * as payments from '../../../spec/payments.js';
import type * as wallet from '../../../spec/wallet.js';
import { auth, buildTestApp, callers, movingClock, tokenClock } from '../../../testing/app.js';
import type { SupportService } from '../service.js';

export const USD = (amount: number) => ({ amount, currency: 'USD' });
export const DAY = 86_400_000;

const RECORDED = [
  'support.case.opened',
  'support.case.escalated',
  'support.case.decided',
  'support.case.resolved',
  'support.case.reopened',
  'support.case.appealed',
  'support.case.appeal_decided',
  'support.case.assigned',
  'support.case.message_added',
  'support.case.overdue',
  'returns.refund.requested',
  'returns.refund.approved',
];

export interface Harness {
  app: FastifyInstance;
  clock: ReturnType<typeof movingClock>;
  service: SupportService;
  orders: OrdersPublicApi;
  events: { name: string; payload: any }[];
  audits: audit.RecordInput[];
  offers: Map<string, offers.OfferSnapshot>;
  products: Map<string, catalog.ProductSnapshot & { categoryId?: string | null }>;
  guestGrants: Set<string>;
  authority: Record<string, 'allowed' | 'approval_required' | 'denied'>;
  unknownStaff: Set<string>;
  members: Record<string, access.StaffRef[]>;
  lead: string;
  missingFiles: Set<string>;
  calls: { refunds: payments.StartRefundInput[]; approvals: access.RequestApprovalInput[]; attached: { assetId: string; kind: string; refId: string; owner: string }[]; goodwill: wallet.GoodwillGrant[] };
  call(method: string, url: string, token: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: any }>;
  gql(area: 'store' | 'seller' | 'admin', token: string, query: string, variables?: Record<string, unknown>): Promise<any>;
  publish(source: string, name: string, payload: unknown): Promise<void>;
  named(name: string): any[];
}

export async function harness(o: { wallet?: boolean } = {}): Promise<Harness> {
  const clock = movingClock();
  tokenClock.now = () => clock.now();
  tokenClock.ttlSeconds = 90 * 86_400;
  const h = {
    clock,
    events: [] as Harness['events'],
    audits: [] as audit.RecordInput[],
    offers: new Map<string, offers.OfferSnapshot>(),
    products: new Map<string, catalog.ProductSnapshot & { categoryId?: string | null }>(),
    guestGrants: new Set<string>(),
    authority: {} as Harness['authority'],
    unknownStaff: new Set<string>(),
    members: {} as Harness['members'],
    lead: newId(),
    missingFiles: new Set<string>(),
    calls: { refunds: [], approvals: [], attached: [], goodwill: [] } as Harness['calls'],
  };
  const refunded = new Map<string, number>();
  const refundsByKey = new Map<string, payments.Refund>();
  let ordersApi: OrdersPublicApi;
  const app = await buildTestApp({
    only: ['support', 'orders', 'returns', 'settings', 'customers', 'identity', 'media', 'audit', 'notifications', 'access', 'finance', ...(o.wallet ? ['wallet'] : [])],
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
        notify: async () => ({ noticeIds: [newId()], deliveryIds: [] }),
      },
      media: {
        attach: async (assetId, usage, owner) => {
          if (h.missingFiles.has(assetId)) throw new AppError('NOT_FOUND', 'File not found');
          h.calls.attached.push({ assetId, kind: usage.kind, refId: usage.refId, owner: owner.kind });
        },
        refs: async (ids) => ids.map((id) => ({ id, url: `https://files.example/${id}.jpg` })),
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
      access: {
        check: async (_p, action) => {
          const decision = h.authority[action] ?? 'allowed';
          return { decision, action, reason: decision === 'allowed' ? 'Within your limit' : decision === 'denied' ? 'Your role has no authority' : 'Above your limit: Finance approval', requiresSecondReviewer: false, approvalsNeeded: 1, eligibleApproverRoles: [], eligibleApprovers: [] };
        },
        requestApproval: async (input) => {
          h.calls.approvals.push(input);
          return { id: newId(), ref: `AP-${h.calls.approvals.length}`, status: 'pending' } as access.ApprovalRequest;
        },
        getApproval: async (id) => ({ id, status: 'pending' }) as access.ApprovalRequest,
        decide: async (id) => ({ id, status: 'approved' }) as access.ApprovalRequest,
        cancelApproval: async () => undefined,
        approvalInfo: async (id) => ({ required: true, reason: 'Waiting for approval', approvalRequestId: id, approvers: [] }),
        getStaffRef: async (id) => (h.unknownStaff.has(id) ? null : { accountId: id, name: id === h.lead ? 'Lena Lead' : 'Isabel Cruz', away: false, roleLabel: 'Support Specialist' }),
        membersOfRole: async (role) => h.members[role] ?? [],
        resolveRecipients: async (roleKey) => ({ roleKey, leadAccountId: h.lead, accountIds: [h.lead], ccAccountIds: [], viaBackup: false, escalationRoleKey: 'business_owner' }),
      },
      ...(o.wallet
        ? {
            wallet: {
              grantGoodwill: async (input: wallet.GoodwillInput, actor: Harness['calls']['goodwill'][number]['requestedBy']) => {
                const grant: wallet.GoodwillGrant = { id: newId(), customerId: input.customerId, amount: input.amount, reason: input.reason, reasonCode: input.reasonCode, chargedTo: input.chargedTo ?? 'platform', sellerId: input.sellerId ?? null, state: 'pending_approval', requestedBy: actor, createdAt: clock.now().toISOString() };
                h.calls.goodwill.push(grant);
                return grant;
              },
            },
          }
        : {}),
      finance: {
        previewRefundImpact: async (_ids, refund) => ({ sellerEarningsChange: USD(-refund.amount), feeReturned: USD(Math.round(refund.amount / 10)), afterPayout: false, note: 'Deducted from the next payout' }),
      },
    },
  });
  const service = app.kernel.boot.apis.get('support') as SupportService;
  ordersApi = app.kernel.boot.apis.get('orders') as OrdersPublicApi;
  for (const name of RECORDED) app.kernel.events.subscribe('test', name, (e) => void h.events.push({ name: e.name, payload: e.payload }));
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
export function product(h: Harness, o: { title: string; price: number; ownerType?: 'official' | 'seller'; sellerId?: string | null }) {
  const offerId = newId();
  const productId = newId();
  const variantId = newId();
  const stockItemId = newId();
  const ownerType = o.ownerType ?? 'seller';
  h.products.set(variantId, { productId, variantId, productVersion: 1, title: o.title, brandName: 'Halden', options: { Color: 'Teal' }, modelNumber: 'H-100', imageUrl: 'https://cdn.example/p.jpg', takenAt: new Date().toISOString(), categoryId: null });
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
    returnTerms: { kind: 'baseline', windowDays: 30, freeReturnShipping: false, summary: '30-day returns.' },
    warranty: { kind: 'manufacturer', months: 24, handledBy: 'manufacturer', summary: '2-year manufacturer warranty' },
    stockItemId,
    takenAt: new Date().toISOString(),
  });
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

export function group(h: Harness, items: OrderItemInput[], o: { ownerType?: 'official' | 'seller'; sellerId?: string | null } = {}): OrderGroupInput {
  const ownerType = o.ownerType ?? 'seller';
  const total = items.reduce((s, i) => s + i.unitPrice.amount * i.quantity, 0);
  const t = h.clock.now();
  const day = (d: number) => new Date(t.getTime() + d * DAY).toISOString().slice(0, 10);
  return {
    key: newId(),
    ownerType,
    sellerId: ownerType === 'seller' ? (o.sellerId ?? null) : null,
    shipsFrom: 'Reno, NV',
    fulfilledBy: ownerType === 'official' ? 'official_warehouse' : 'seller',
    delivery: { methodName: 'Standard', carrier: 'UPS', service: 'Ground', price: USD(0), free: true, fundedBy: 'seller', arrival: { from: day(4), to: day(6) }, dispatchBy: new Date(t.getTime() + 2 * DAY).toISOString() },
    returnTermsSummary: '30-day returns.',
    items,
    totals: { items: USD(total), discounts: USD(0), shipping: USD(0), tax: USD(0), total: USD(total) },
  };
}

export interface Placed {
  order: OrderDetail;
  customerId: string;
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
      const at = h.clock.now().toISOString();
      await h.publish('shipping', 'shipping.shipment.created', { shipmentId, kind: 'outbound', orderId: order.id, groupId: g.id, sellerId, packageLabel: 'Package', carrierCode: 'ups', carrierName: 'UPS', serviceName: null, trackingNumber: '1Z1', trackingUrl: null, lines, status: 'label_created' });
      await h.publish('shipping', 'shipping.shipment.dispatched', { shipmentId, kind: 'outbound', orderId: order.id, groupId: g.id, ownerType: g.seller.ownerType, sellerId, lines, shippedAt: at, dispatchDueAt: null, onTime: true, trackingValid: true, estimatedArrival: null });
      await h.publish('shipping', 'shipping.shipment.delivered', { shipmentId, kind: 'outbound', orderId: order.id, groupId: g.id, sellerId, lines, deliveredAt: at });
    }
  }
  const fresh = (await h.orders.getOrder(order.id))!;
  return { order: fresh, customerId: customerId ?? '', items: fresh.groups.map((g) => g.items.map((i) => i.id)) };
}

/** A delivered order of one seller item for a new customer */
export async function sellerOrder(h: Harness, o: { price?: number; deliver?: boolean; sellerId?: string; customerId?: string | null; quantity?: number } = {}) {
  const sellerId = o.sellerId ?? newId();
  const p = product(h, { title: 'Linen Throw', price: o.price ?? 4900, sellerId });
  const placed = await placeOrder(h, [group(h, [line(p, o.quantity ?? 1)], { sellerId })], { ...(o.customerId !== undefined ? { customerId: o.customerId } : {}), deliver: o.deliver ?? true });
  return { ...placed, sellerId, itemId: placed.items[0]![0]!, product: p };
}

export const tokens = {
  customer: (accountId: string) => callers.customer({ accountId }),
  seller: (sellerId: string, permissions?: string[]) => callers.seller({ sellerId, ...(permissions ? { permissions } : {}) }),
  staff: (permissions?: string[], sub?: string) => callers.staff(permissions, sub ? { sub } : {}),
  visitor: () => callers.visitor(),
};

export const idem = () => ({ 'idempotency-key': newId() });

/** Opens an order-problem case as the customer through the store API */
export async function reportProblem(h: Harness, o: { customerId: string; orderId: string; itemIds: string[]; category?: string; problemType?: string; message?: string }) {
  const res = await h.call('POST', '/api/store/support/cases', tokens.customer(o.customerId), { kind: 'order_problem', category: o.category ?? 'item_damaged', orderId: o.orderId, orderItemIds: o.itemIds, problemType: o.problemType ?? 'damaged', message: o.message ?? 'It arrived cracked', desiredRemedy: 'refund' }, idem());
  return res;
}
