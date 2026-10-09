/**
 * Test kit for finance: boots finance with its dependencies, audit, media, promotions, workqueues and
 * reports. Orders (built) is stubbed for the order details finance reads (getOrder, getOrderAdmin) so tests
 * control prices, discounts and shipping; promotions' fundingSplitFor is stubbed to control funding
 * shares; payments and returns (built in parallel) only publish events here, and payments.startRefund is
 * stubbed per src/spec/payments.ts; reports (not built) is stubbed for exports; access is stubbed where
 * tests control authority (allowed / approval_required / denied) — test/real-access.test.ts uses the real one.
 */
import type { FastifyInstance } from 'fastify';
import { expect } from 'vitest';
import type { EventEnvelope } from '../../../kernel/events/index.js';
import { newId } from '../../../kernel/lib/ids.js';
import { withDependencies } from '../../../kernel/module-system/loader.js';
import { auth, buildTestApp, callers, movingClock, tokenClock } from '../../../testing/app.js';
import type * as access from '../../../spec/access.js';
import type * as audit from '../../../spec/audit.js';
import type { DevPayoutProvider } from '../infra/provider/dev.js';
import type { FinanceService } from '../service.js';

export const SELLER = '/api/seller/finance';
export const ADMIN = '/api/admin/finance';
export const USD = (amount: number) => ({ amount, currency: 'USD' });

export type Decision = 'allowed' | 'approval_required' | 'denied';

export interface FakeItem {
  id: string;
  title: string;
  quantity: number;
  price: number;
  /** discount funding: seller / platform minor units */
  sellerDiscount?: number;
  platformDiscount?: number;
  shipping?: number;
  /** product category at purchase (category fee rates) */
  categoryId?: string | null;
  splitFromItemId?: string | null;
  /** order item state (default confirmed) and whether a refund was sent for it */
  state?: string;
  refunded?: boolean;
}

export interface FakeGroup {
  id: string;
  sellerId: string | null;
  items: FakeItem[];
}

export interface FakeOrder {
  id: string;
  ref: string;
  groups: FakeGroup[];
}

export interface Kit {
  app: FastifyInstance;
  svc: FinanceService;
  provider: DevPayoutProvider;
  clock: ReturnType<typeof movingClock>;
  orders: Map<string, FakeOrder>;
  events: EventEnvelope[];
  audits: audit.RecordInput[];
  approvals: Map<string, access.RequestApprovalInput & { status: string }>;
  authority: Map<string, Decision>;
  /** access.requestApproval: whether the requester counts as the first approver (second-reviewer cases) */
  countsAsFirst: { value: boolean };
  refunds: unknown[];
  staff: string;
  of(name: string): any[];
  call(method: string, url: string, token: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: any }>;
  emit(name: string, payload: unknown): Promise<void>;
  sellerToken(sellerId: string, o?: { permissions?: string[]; accountId?: string }): string;
  order(sellerId: string | null, items: Omit<FakeItem, 'id'>[], o?: { ref?: string }): FakeOrder;
  accept(order: FakeOrder): Promise<void>;
  deliver(order: FakeOrder, itemIds?: string[]): Promise<void>;
  decide(requestId: string, outcome: 'approved' | 'rejected' | 'cancelled', decidedBy?: string): Promise<void>;
  close(): Promise<void>;
}

let refCounter = 1000;

function orderDetail(o: FakeOrder): any {
  const groups = o.groups.map((g, gi) => {
    const items = g.items.map((i) => {
      const disc = (i.sellerDiscount ?? 0) + (i.platformDiscount ?? 0);
      const discounts = [
        ...(i.sellerDiscount ? [{ label: 'Seller sale', amount: USD(i.sellerDiscount), fundedBy: 'seller' }] : []),
        ...(i.platformDiscount ? [{ label: 'WELCOME', amount: USD(i.platformDiscount), fundedBy: 'platform' }] : []),
      ];
      const sub = i.price * i.quantity;
      return {
        id: i.id,
        groupId: g.id,
        product: { productId: newId(), variantId: newId(), productVersion: 1, title: i.title, options: {}, takenAt: new Date().toISOString() },
        title: i.title,
        variantLabel: '',
        quantity: i.quantity,
        unitPrice: USD(i.price),
        lineSubtotal: USD(sub),
        discounts,
        shippingShare: USD(i.shipping ?? 0),
        taxShare: USD(0),
        paidAmount: USD(sub - disc + (i.shipping ?? 0)),
        state: i.state ?? 'confirmed',
        afterSales: { refundStatus: i.refunded ? 'sent' : 'none', refundedAmount: USD(i.refunded ? sub - disc + (i.shipping ?? 0) : 0) },
        splitFromItemId: i.splitFromItemId ?? null,
        categoryId: i.categoryId ?? null,
      };
    });
    const total = items.reduce((s, i) => s + i.paidAmount.amount, 0);
    return { id: g.id, packageLabel: `Package ${gi + 1} of ${o.groups.length}`, seller: { ownerType: g.sellerId ? 'seller' : 'official', id: g.sellerId, name: 'Seller', slug: 's', verified: true }, items, totals: { items: USD(0), discounts: USD(0), shipping: USD(0), tax: USD(0), total: USD(total) } };
  });
  const total = groups.reduce((s, g) => s + g.totals.total.amount, 0);
  return { id: o.id, ref: o.ref, groups, totals: { total: USD(total) } };
}

export async function boot(o: { modules?: string[] } = {}): Promise<Kit> {
  const clock = movingClock();
  // tokens are signed at the app's (moved) time, so they stay valid when tests move the clock by weeks
  tokenClock.now = () => clock.now();
  tokenClock.ttlSeconds = 3600;
  const orders = new Map<string, FakeOrder>();
  const audits: audit.RecordInput[] = [];
  const approvals = new Map<string, access.RequestApprovalInput & { status: string }>();
  const authority = new Map<string, Decision>();
  const countsAsFirst = { value: false };
  const refunds: unknown[] = [];
  const itemById = () => new Map([...orders.values()].flatMap((ord) => ord.groups.flatMap((g) => g.items.map((i) => [i.id, i] as const))));
  const app = await buildTestApp({
    modules: o.modules ?? withDependencies(['finance', 'audit', 'media', 'promotions', 'workqueues', 'reports']),
    clock,
    config: { rateLimits: false, launchPhase: 4 },
    apiStubs: {
      orders: {
        getOrder: async (id: string) => (orders.has(id) ? orderDetail(orders.get(id)!) : null),
        getOrderAdmin: async (ref: string) => {
          const ord = [...orders.values()].find((x) => x.ref === ref);
          return ord ? ({ order: orderDetail(ord) } as any) : null;
        },
      },
      sellers: {
        getSellers: async (ids: string[]) => ids.map((id) => ({ id, ref: `SL-${id.slice(0, 5)}`, slug: 's', storeName: `Store ${id.slice(0, 4)}`, status: 'approved', verified: true, canSellNew: true, activeRestrictionIds: [], launchReady: true }) as any),
        searchSellers: async () => ({ items: [], nextCursor: null }) as any,
      },
      promotions: {
        fundingSplitFor: async (orderItemId: string) => {
          const i = itemById().get(orderItemId);
          return { orderItemId, allocations: [], sellerFunded: USD(i?.sellerDiscount ?? 0), platformFunded: USD(i?.platformDiscount ?? 0) } as any;
        },
      },
      access: {
        check: async (_p: any, action: string) => {
          const decision = authority.get(action) ?? 'allowed';
          return { decision, action, reason: decision === 'allowed' ? 'Within your limit' : decision === 'denied' ? 'Your role has no authority for this' : 'Above your limit: Finance Manager approval', requiresSecondReviewer: decision === 'approval_required', approvalsNeeded: decision === 'approval_required' ? 1 : 0, eligibleApproverRoles: [], eligibleApprovers: [] } as any;
        },
        requestApproval: async (input: access.RequestApprovalInput) => {
          const existing = [...approvals.entries()].find(([, a]) => a.status === 'pending' && a.action === input.action && a.target.id === input.target.id);
          const id = existing?.[0] ?? newId();
          if (!existing) approvals.set(id, { ...input, status: 'pending' });
          return { id, ref: `AP-${id.slice(0, 4)}`, status: 'pending', requesterCountsAsFirst: countsAsFirst.value, requestedBy: { kind: 'staff', id: input.requestedBy.accountId } } as any;
        },
        getApproval: async (id: string) => {
          const a = approvals.get(id);
          return a ? ({ id, ref: 'AP-1', status: a.status, details: a.details, requestedBy: { kind: 'staff', id: a.requestedBy.accountId } } as any) : null;
        },
        decide: async (id: string, principal: any) => {
          const a = approvals.get(id)!;
          a.status = 'approved';
          return { id, ref: 'AP-1', status: 'approved', requestedBy: { kind: 'staff', id: a.requestedBy.accountId }, decidedBy: principal.accountId } as any;
        },
        approvalInfo: async (id: string) => ({ required: true, approvalRequestId: id, approvers: ['Finance Manager'] }),
        cancelApproval: async (id: string) => {
          const a = approvals.get(id);
          if (a) a.status = 'cancelled';
        },
        getStaffRef: async (id: string) => ({ accountId: id, name: 'Fran Finance', away: false, roleLabel: 'Finance Specialist' }),
        resolveRecipients: async (roleKey: string) => ({ roleKey, leadAccountId: null, accountIds: [], ccAccountIds: [], viaBackup: false }),
      },
      payments: {
        startRefund: async (input: any) => {
          refunds.push(input);
          return { id: newId(), ref: 'RF-1' } as any;
        },
      },
      reports: {
        registerDataset: async () => {},
        requestExport: async (input: any) => ({ id: newId(), ref: 'EX-1', dataset: input.dataset, format: input.format, filters: input.filters, requestedBy: { kind: 'seller', id: input.principal.accountId }, sellerId: input.sellerId ?? null, state: 'queued', columnsExcluded: [], createdAt: new Date().toISOString() }) as any,
        getExport: async (id: string) => ({ id, ref: 'EX-1', dataset: 'finance.seller.ledger', format: 'csv', requestedBy: { kind: 'seller', id: null }, sellerId: null, state: 'ready', columnsExcluded: [], createdAt: new Date().toISOString() }) as any,
      },
      audit: {
        record: async (e: audit.RecordInput) => {
          audits.push(e);
          return newId();
        },
      },
    },
  });
  const events: EventEnvelope[] = [];
  for (const name of Object.keys((await import('../../../spec/finance.js')).spec.events.publishes)) app.kernel.events.subscribe('test', name, async (e) => void events.push(e));
  const svc = app.kernel.boot.apis.get('finance') as FinanceService;
  const provider = svc.core.provider as DevPayoutProvider;
  const kit: Kit = {
    app,
    svc,
    provider,
    clock,
    orders,
    events,
    audits,
    approvals,
    authority,
    countsAsFirst,
    refunds,
    get staff() {
      return callers.staff();
    },
    of: (name) => events.filter((e) => e.name === name).map((e) => e.payload),
    async call(method, url, token, body, headers = {}) {
      const res = await app.inject({ method: method as any, url, headers: { ...auth(token), ...headers }, ...(body !== undefined ? { payload: body as any } : {}) });
      await app.kernel.events.drain();
      return { status: res.statusCode, body: res.body ? res.json() : null };
    },
    async emit(name, payload) {
      app.kernel.events.publish('test', name, payload, { actor: { kind: 'system', id: null } });
      await app.kernel.events.drain();
    },
    sellerToken: (sellerId, o = {}) => callers.seller({ sellerId, ...o }),
    order(sellerId, items, o = {}) {
      const ord: FakeOrder = { id: newId(), ref: o.ref ?? `MK-261009-${refCounter++}`, groups: [{ id: newId(), sellerId, items: items.map((i) => ({ ...i, id: newId() })) }] };
      orders.set(ord.id, ord);
      return ord;
    },
    async accept(ord) {
      const detail = orderDetail(ord);
      await kit.emit('orders.order.accepted', {
        orderId: ord.id,
        ref: ord.ref,
        customerId: newId(),
        contactEmail: 'ana@example.com',
        total: detail.totals.total,
        groups: ord.groups.map((g, i) => ({ groupId: g.id, ownerType: g.sellerId ? 'seller' : 'official', sellerId: g.sellerId, fulfilledBy: g.sellerId ? 'seller' : 'official_warehouse', dispatchBy: clock.now().toISOString(), itemIds: g.items.map((x) => x.id), total: detail.groups[i].totals.total })),
        items: ord.groups.flatMap((g) => g.items.map((x) => ({ orderItemId: x.id, offerId: newId(), stockItemId: newId(), quantity: x.quantity }))),
        acceptedAt: clock.now().toISOString(),
      });
    },
    async deliver(ord, itemIds) {
      for (const g of ord.groups)
        for (const i of g.items)
          if (!itemIds || itemIds.includes(i.id))
            await kit.emit('orders.item.delivered', { orderId: ord.id, groupId: g.id, ownerType: g.sellerId ? 'seller' : 'official', sellerId: g.sellerId, itemId: i.id, quantity: i.quantity, deliveredAt: clock.now().toISOString(), returnWindowEndsAt: new Date(clock.now().getTime() + 30 * 86_400_000).toISOString() });
    },
    async decide(requestId, outcome, decidedBy = newId()) {
      const a = approvals.get(requestId)!;
      a.status = outcome;
      await kit.emit('access.approval.decided', { requestId, ref: 'AP-1', actionKey: a.action, module: 'finance', target: a.target, outcome, decidedBy: { kind: 'staff', id: decidedBy }, reason: outcome === 'approved' ? null : 'Not now', amount: a.amount ?? null, approverIds: [decidedBy], requestedById: a.requestedBy.accountId ?? 'x' });
    },
    close: () => app.close(),
  };
  return kit;
}

/**
 * The ledger proves the balances: total = Σ entries, held = Σ held-bucket entries, pending = Σ entries
 * of lots still pending, available = the rest; the running balance of the last entry equals the total.
 */
export async function expectLedgerMatches(k: Kit, sellerId: string) {
  const repo = k.svc.core.repo;
  const entries = await repo.find('ledger_entries', { seller_id: sellerId }, { orderBy: [['at', 'asc'], ['id', 'asc']] });
  const acct = await repo.findOne('seller_accounts', { seller_id: sellerId });
  const total = entries.reduce((s, e) => s + e.amount, 0);
  const held = entries.filter((e) => e.bucket === 'held').reduce((s, e) => s + e.amount, 0);
  const pending = await repo.pendingFromLedger(sellerId);
  expect({ pending: acct?.pending ?? 0, available: acct?.available ?? 0, held: acct?.held ?? 0 }).toEqual({ pending, available: total - pending - held, held });
  // running balance: each entry's balance_after continues the previous one
  let running = 0;
  const byInsert = entries.slice().sort((a, b) => (a.id < b.id ? -1 : 1));
  for (const e of byInsert) {
    running += e.amount;
    expect(e.balance_after).toBe(running);
  }
  // no fact posted twice
  const keys = entries.map((e) => e.source_event_id);
  expect(new Set(keys).size).toBe(keys.length);
  return { total, pending, held, available: total - pending - held };
}
