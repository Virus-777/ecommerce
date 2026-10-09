/**
 * Shared setup for the payments behaviour tests: the app with payments and the modules it talks to, a movable
 * clock, recorded events, audit entries and provider calls, and builders for orders placed through the real
 * orders module (checkout's part is played by the tests: authorize, then orders.createOrder).
 *
 * Built modules run for real: orders (placement, acceptance, paid amounts, refund mirrors), identity, customers,
 * access (only the functions below are stubbed), audit (record is wrapped to keep the entries).
 * Stubbed APIs:
 *   offers.snapshotForOrder / catalog.snapshotForOrder → h.offers / h.products (purchase snapshots for orders).
 *   customers.getCustomerByUserId → the customer id equals the account id; getCustomer → 'Sam Rivera'.
 *   access.check / requestApproval / getStaffRef → h.access (decision per test; approval requests recorded).
 *   checkout.getSessionForOrder / getSessionView (checkout is built in parallel) → h.sessions by session id.
 *   media.refs → MediaRefs for any id in h.files.
 *   settings.get → h.settings ('payments.captureMode' …), else the spec defaults.
 */
import type { FastifyInstance } from 'fastify';
import { newId } from '../../../kernel/lib/ids.js';
import type * as access from '../../../spec/access.js';
import type * as audit from '../../../spec/audit.js';
import type * as catalog from '../../../spec/catalog.js';
import type * as common from '../../../spec/common.js';
import type * as offers from '../../../spec/offers.js';
import type { OrderCreateInput, OrderDetail, OrderGroupInput, OrderItemInput, OrdersPublicApi } from '../../../spec/orders.js';
import type { AuthorizeInput } from '../../../spec/payments.js';
import { auth, buildTestApp, callers, movingClock, signWebhook, tokenClock } from '../../../testing/app.js';
import type { PaymentsService } from '../service.js';

export const USD = (amount: number): common.Money => ({ amount, currency: 'USD' });

export interface Harness {
  app: FastifyInstance;
  clock: ReturnType<typeof movingClock>;
  service: PaymentsService;
  orders: OrdersPublicApi;
  events: { name: string; payload: any }[];
  audits: audit.RecordInput[];
  settings: Record<string, unknown>;
  offers: Map<string, offers.OfferSnapshot>;
  products: Map<string, catalog.ProductSnapshot>;
  sessions: Map<string, { orderId: string | null; status: string; customerId: string | null; guestSessionId?: string | null }>;
  access: { decision: access.AuthorityCheck['decision']; requests: access.RequestApprovalInput[]; staff: Map<string, string> };
  files: Set<string>;
  call(method: string, url: string, token: string | null, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: any; headers: Record<string, unknown> }>;
  publish(source: string, name: string, payload: unknown): Promise<void>;
  named(name: string): any[];
  calls(intentId: string, operation?: string): Promise<{ operation: string; outcome: string }[]>;
  run(job: string): Promise<void>;
  webhook(body: unknown, o?: { eventId?: string; provider?: string; sign?: boolean }): Promise<{ status: number; body: any; headers: Record<string, unknown> }>;
}

export async function harness(o: { modules?: string[] } = {}): Promise<Harness> {
  const clock = movingClock();
  // jobs move the clock days ahead: tokens are signed at the app's time so they stay valid
  tokenClock.now = () => clock.now();
  tokenClock.ttlSeconds = 3_600;
  const h = {
    clock,
    events: [] as Harness['events'],
    audits: [] as audit.RecordInput[],
    settings: {} as Record<string, unknown>,
    offers: new Map<string, offers.OfferSnapshot>(),
    products: new Map<string, catalog.ProductSnapshot>(),
    sessions: new Map() as Harness['sessions'],
    access: { decision: 'allowed' as access.AuthorityCheck['decision'], requests: [] as access.RequestApprovalInput[], staff: new Map<string, string>() },
    files: new Set<string>(),
  };
  const app = await buildTestApp({
    only: ['payments', 'orders', 'customers', 'identity', 'audit', 'access', 'checkout', 'media', ...(o.modules ?? [])],
    clock,
    config: { rateLimits: false, launchPhase: 4 },
    apiStubs: {
      offers: {
        snapshotForOrder: async (offerId) => {
          const o = h.offers.get(offerId);
          if (!o) throw Object.assign(new Error('offer not found'), { statusCode: 404 });
          return structuredClone(o);
        },
      },
      catalog: {
        snapshotForOrder: async (variantId) => ({ ...structuredClone(h.products.get(variantId)!), takenAt: clock.now().toISOString() }),
      },
      customers: {
        getCustomerByUserId: async (userId) => ({ id: userId, userId, ref: 'CU-000001', displayName: 'Sam Rivera', email: 'sam@example.com', accountStatus: 'active', canOrder: true, canMessage: true }),
        getCustomer: async (id) => ({ id, userId: id, ref: 'CU-000001', displayName: 'Sam Rivera', email: 'sam@example.com', accountStatus: 'active', canOrder: true, canMessage: true }),
      },
      access: {
        check: async (_p, action, amount) =>
          ({
            decision: h.access.decision,
            action,
            reason: h.access.decision === 'allowed' ? 'Within your dispute limit' : h.access.decision === 'denied' ? 'Your role cannot concede disputes' : `Above your limit (${amount?.money?.amount ?? 0})`,
            requiresSecondReviewer: false,
            approvalsNeeded: h.access.decision === 'approval_required' ? 1 : 0,
            eligibleApproverRoles: [],
            eligibleApprovers: [],
          }) as access.AuthorityCheck,
        requestApproval: async (input) => {
          h.access.requests.push(input);
          return { id: newId(), ref: 'AP-261009-0001', status: 'pending', target: input.target } as unknown as access.ApprovalRequest;
        },
        getStaffRef: async (id) => (h.access.staff.has(id) ? { accountId: id, name: h.access.staff.get(id)!, away: false } : null),
      },
      checkout: {
        getSessionForOrder: async (id) => {
          const s = h.sessions.get(id);
          return s ? { orderId: s.orderId, status: s.status, customerId: s.customerId } : null;
        },
        getSessionView: async (owner, id) => {
          const s = h.sessions.get(id);
          return s && ((owner.guestSessionId && s.guestSessionId === owner.guestSessionId) || (owner.customerId && s.customerId === owner.customerId)) ? ({ id } as never) : null;
        },
      },
      media: {
        refs: async (ids) => ids.filter((id) => h.files.has(id)).map((id) => ({ id, url: `https://files.example/${id}.jpg`, alt: null })),
      },
      settings: {
        get: (async (key: string) => h.settings[key] ?? null) as never,
      },
      audit: {
        record: async (entry) => {
          h.audits.push(entry);
          return newId();
        },
      },
    },
  });
  const real = app.kernel.boot.apis.get('payments') as PaymentsService;
  // public API calls in tests wait for the event consumers they trigger, like h.call does for HTTP
  const service = new Proxy(real, {
    get(target, key, receiver) {
      const v = Reflect.get(target, key, receiver);
      if (typeof v !== 'function') return v;
      return async (...args: unknown[]) => {
        try {
          return await v.apply(target, args);
        } finally {
          await app.kernel.events.drain();
        }
      };
    },
  });
  const orders = app.kernel.boot.apis.get('orders') as OrdersPublicApi;
  const events = h.events;
  for (const name of [
    'payments.payment.authorized',
    'payments.payment.captured',
    'payments.payment.failed',
    'payments.payment.pending_check',
    'payments.payment.voided',
    'payments.payment.orphaned',
    'payments.refund.status_changed',
    'payments.refund.sent',
    'payments.refund.failed',
    'payments.refund.destination_requested',
    'payments.chargeback.opened',
    'payments.chargeback.status_changed',
    'payments.chargeback.decided',
    'payments.method.saved',
    'payments.method.removed',
    'orders.order.accepted',
  ]) {
    app.kernel.events.subscribe('test', name, (e) => void events.push({ name: e.name, payload: e.payload }));
  }
  const call: Harness['call'] = async (method, url, token, body, headers = {}) => {
    const res = await app.inject({ method: method as never, url, headers: { ...(token ? auth(token) : {}), ...headers }, ...(body !== undefined ? { payload: body as never } : {}) });
    await app.kernel.events.drain();
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null, headers: res.headers };
  };
  return {
    ...h,
    app,
    service,
    orders,
    call,
    async publish(source, name, payload) {
      app.kernel.events.publish(source, name, payload);
      await app.kernel.events.drain();
    },
    named: (name) => events.filter((e) => e.name === name).map((e) => e.payload),
    async calls(intentId, operation) {
      const rows = await service.core.repo.find('provider_calls', { intent_id: intentId, ...(operation ? { operation } : {}) }, { orderBy: [['at', 'asc']] });
      return rows.map((r) => ({ operation: r.operation, outcome: r.outcome }));
    },
    async run(job) {
      await app.kernel.jobs.runNow(job);
      await app.kernel.events.drain();
    },
    async webhook(body, o = {}) {
      const raw = JSON.stringify(body);
      const headers: Record<string, string> = { 'content-type': 'application/json', 'x-event-id': o.eventId ?? newId() };
      if (o.sign !== false) Object.assign(headers, signWebhook('dev-webhook-secret', raw, Math.floor(clock.now().getTime() / 1000)));
      const res = await app.inject({ method: 'POST', url: `/webhooks/payments/providers/${o.provider ?? 'card-processor'}/events`, headers, payload: raw });
      await app.kernel.events.drain();
      return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null, headers: res.headers };
    },
  };
}

/* ---------------------------------------------------------------- order builders */

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
    sellerId: ownerType === 'seller' ? (o.sellerId ?? newId()) : null,
    sellerName: o.sellerName ?? (ownerType === 'official' ? 'Marketly Official Store' : 'Casa Verde Home'),
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
  return { offerId, productId, variantId, stockItemId, price: o.price, sellerId: h.offers.get(offerId)!.sellerId ?? null, ownerType };
}

type P = ReturnType<typeof product>;

export function line(p: P, quantity = 1, o: { shipping?: number; tax?: number } = {}): OrderItemInput {
  return {
    offerId: p.offerId,
    variantId: p.variantId,
    stockItemId: p.stockItemId,
    quantity,
    unitPrice: USD(p.price),
    discounts: [],
    shippingShare: USD(o.shipping ?? 0),
    taxShare: USD(o.tax ?? 0),
    returnTerms: { summary: '30-day returns.', windowDays: 30, returnShippingPaidBy: 'depends_on_reason' },
    checkoutLineId: newId(),
  };
}

export function group(h: Harness, p: P, items: OrderItemInput[]): OrderGroupInput {
  const itemsTotal = items.reduce((s, i) => s + i.unitPrice.amount * i.quantity, 0);
  const shipping = items.reduce((s, i) => s + i.shippingShare.amount, 0);
  const tax = items.reduce((s, i) => s + i.taxShare.amount, 0);
  const now = h.clock.now();
  const day = (d: number) => new Date(now.getTime() + d * 86_400_000).toISOString().slice(0, 10);
  return {
    key: newId(),
    ownerType: p.ownerType,
    sellerId: p.sellerId,
    shipsFrom: 'Reno, NV',
    fulfilledBy: p.ownerType === 'official' ? 'official_warehouse' : 'seller',
    delivery: { methodName: 'Standard', carrier: 'UPS', service: 'Ground', price: USD(shipping), free: shipping === 0, fundedBy: shipping === 0 ? 'seller' : 'customer', arrival: { from: day(4), to: day(6) }, dispatchBy: new Date(now.getTime() + 48 * 3_600_000).toISOString() },
    returnTermsSummary: '30-day returns.',
    items,
    totals: { items: USD(itemsTotal), discounts: USD(0), shipping: USD(shipping), tax: USD(tax), total: USD(itemsTotal + shipping + tax) },
  };
}

export const totalOf = (groups: OrderGroupInput[]) => groups.reduce((s, g) => s + g.totals.total.amount, 0);

export function orderInput(groups: OrderGroupInput[], o: { checkoutSessionId: string; paymentIntentId: string; customerId?: string | null; paymentState?: 'accepted' | 'pending_check'; methodLabel?: string }): OrderCreateInput {
  const sum = (k: 'items' | 'discounts' | 'shipping' | 'tax' | 'total') => USD(groups.reduce((s, g) => s + g.totals[k].amount, 0));
  return {
    checkoutSessionId: o.checkoutSessionId,
    contact: o.customerId ? { kind: 'customer', customerId: o.customerId, name: 'Sam Rivera', email: 'sam@example.com', phone: null } : { kind: 'guest', name: 'Gia Guest', email: 'gia@example.com', phone: null },
    channel: 'web',
    currency: 'USD',
    deliveryAddress: { name: 'Sam Rivera', line1: '1 Main St', city: 'Portland', region: 'OR', postalCode: '97201', country: 'US' },
    giftNote: null,
    hidePricesOnSlip: false,
    policyVersions: [],
    couponCodes: [],
    paymentIntentId: o.paymentIntentId,
    paymentState: o.paymentState ?? 'accepted',
    paymentMethodLabel: o.methodLabel ?? 'Visa •••• 4242',
    groups,
    totals: { items: sum('items'), discounts: sum('discounts'), shipping: sum('shipping'), tax: sum('tax'), total: sum('total') },
  };
}

export function authorizeInput(o: { checkoutSessionId?: string; customerId?: string | null; guestEmail?: string; amount: number; token?: string; savedMethodId?: string; attemptNo?: number; saveForLater?: boolean }): AuthorizeInput {
  return {
    checkoutSessionId: o.checkoutSessionId ?? newId(),
    attemptNo: o.attemptNo ?? 1,
    customerId: o.customerId ?? null,
    guestEmail: o.customerId ? null : (o.guestEmail ?? 'gia@example.com'),
    amount: USD(o.amount),
    method: o.savedMethodId ? { kind: 'saved_card', savedMethodId: o.savedMethodId } : { kind: o.token?.startsWith('tok_applepay') || o.token?.startsWith('tok_googlepay') ? 'digital_wallet' : 'new_card', providerToken: o.token ?? 'tok_visa', saveForLater: o.saveForLater ?? null },
    description: 'Marketly order',
    returnUrl: 'https://store.example/checkout/return',
  };
}

/**
 * The checkout path: authorize, create the order through orders (accepted when the payment was), let the
 * events run (orders.order.placed / accepted → payments links and captures).
 */
export async function placeOrder(
  h: Harness,
  o: { customerId?: string | null; products?: { price: number; quantity?: number; ownerType?: 'official' | 'seller' }[][]; token?: string; checkoutSessionId?: string } = {},
): Promise<{ order: OrderDetail; intentId: string; checkoutSessionId: string; items: string[]; groups: string[]; total: number; state: string }> {
  const checkoutSessionId = o.checkoutSessionId ?? newId();
  const specGroups = o.products ?? [[{ price: 12000 }, { price: 8000 }]];
  const groups = specGroups.map((list, n) => {
    const ownerType = list[0]?.ownerType ?? (n === 0 ? 'official' : 'seller');
    const sellerId = ownerType === 'seller' ? newId() : null;
    const ps = list.map((x) => product(h, { title: `Item ${n}-${x.price}`, price: x.price, ownerType, sellerId }));
    return group(
      h,
      ps[0]!,
      ps.map((p, k) => line(p, list[k]!.quantity ?? 1)),
    );
  });
  const total = totalOf(groups);
  const auth = await h.service.authorize(authorizeInput({ checkoutSessionId, customerId: o.customerId ?? null, amount: total, token: o.token }), newId());
  const paymentState = auth.state === 'accepted' ? 'accepted' : 'pending_check';
  h.sessions.set(checkoutSessionId, { orderId: null, status: 'placing', customerId: o.customerId ?? null });
  const order = await h.orders.createOrder(orderInput(groups, { checkoutSessionId, paymentIntentId: auth.intentId, customerId: o.customerId, paymentState }));
  h.sessions.set(checkoutSessionId, { orderId: order.id, status: 'completed', customerId: o.customerId ?? null });
  await h.app.kernel.events.drain();
  return { order, intentId: auth.intentId, checkoutSessionId, items: order.groups.flatMap((g) => g.items.map((i) => i.id)), groups: order.groups.map((g) => g.id), total, state: auth.state };
}

export const tokens = {
  customer: (accountId: string) => callers.customer({ accountId }),
  visitor: (sessionId?: string) => (sessionId ? callers.visitor({}, { sid: sessionId } as never) : callers.visitor()),
  staff: (permissions?: string[], over: { sub?: string } = {}) => callers.staff(permissions, over),
};

export const idem = () => ({ 'idempotency-key': newId() });
