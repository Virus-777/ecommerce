/**
 * Shared setup for the wallet behaviour tests: the app with wallet and its dependencies on PGlite, a movable
 * clock, recorded events, audit entries and notices.
 *
 * Real modules: wallet, customers, payments, orders, access, identity and the rest booted as dependencies;
 * settings, audit and notifications (optional dependencies) booted to be stubbed.
 * Stubbed APIs (to control answers):
 *   customers.getCustomer / getCustomerByUserId → h.customers (the customer id equals the account id).
 *   orders.getOrder → { ref } for ids in h.orderRefs (other ids: null).
 *   access: check → h.authority[action] (allowed by default); requestApproval recorded (AP-n), getApproval
 *     answers the recorded request with its details; approvalInfo; hasPermission → h.finance.
 *   settings.get → h.settings['wallet.<key>'] (else the spec default).
 *   audit.record and notifications.notify recorded.
 */
import type { FastifyInstance } from 'fastify';
import { newId } from '../../../kernel/lib/ids.js';
import type * as access from '../../../spec/access.js';
import type * as audit from '../../../spec/audit.js';
import type * as notifications from '../../../spec/notifications.js';
import type { OrderDetail } from '../../../spec/orders.js';
import { auth, buildTestApp, callers, movingClock, tokenClock } from '../../../testing/app.js';
import type { WalletService } from '../service.js';

export const USD = (amount: number) => ({ amount, currency: 'USD' });
export const DAY = 86_400_000;
export const idem = () => ({ 'idempotency-key': newId() });

export const WALLET_EVENTS = ['wallet.credit.granted', 'wallet.credit.used', 'wallet.credit.expired', 'wallet.credit.expiring', 'wallet.credit.reversed', 'wallet.credit.corrected', 'wallet.goodwill.decided', 'wallet.gift_card.issued', 'wallet.gift_card.redeemed'];

export interface Harness {
  app: FastifyInstance;
  clock: ReturnType<typeof movingClock>;
  service: WalletService;
  events: { name: string; payload: any }[];
  audits: audit.RecordInput[];
  notices: notifications.NotifyInput[];
  customers: Set<string>;
  orderRefs: Map<string, string>;
  authority: Record<string, 'allowed' | 'approval_required' | 'denied'>;
  finance: { value: boolean };
  settings: Record<string, unknown>;
  approvals: (access.RequestApprovalInput & { id: string })[];
  call(method: string, url: string, token: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: any }>;
  publish(source: string, name: string, payload: unknown): Promise<void>;
  named(name: string): any[];
  /** A customer known to customers, with a store token */
  customer(): { id: string; token: string };
  /** Credit through the refund path (no approvals involved) */
  give(customerId: string, amount: number, o?: { orderId?: string }): Promise<void>;
  /** Approves (or rejects) a recorded approval request as access would */
  decide(requestId: string, outcome: 'approved' | 'rejected'): Promise<void>;
  staff(permissions?: string[]): string;
}

export async function harness(): Promise<Harness> {
  const clock = movingClock();
  tokenClock.now = () => clock.now();
  tokenClock.ttlSeconds = 400 * 86_400;
  const h = {
    clock,
    events: [] as Harness['events'],
    audits: [] as audit.RecordInput[],
    notices: [] as notifications.NotifyInput[],
    customers: new Set<string>(),
    orderRefs: new Map<string, string>(),
    authority: {} as Harness['authority'],
    finance: { value: false },
    settings: {} as Record<string, unknown>,
    approvals: [] as Harness['approvals'],
  };
  const snapshot = (id: string) => ({ id, userId: id, ref: 'CU-000001', displayName: 'Ana Lopez', email: 'ana@example.com', accountStatus: 'active' as const, canOrder: true, canMessage: true });
  const app = await buildTestApp({
    only: ['wallet', 'settings', 'audit', 'notifications'],
    clock,
    config: { rateLimits: false, launchPhase: 4 },
    apiStubs: {
      customers: {
        getCustomer: async (id) => (h.customers.has(id) ? snapshot(id) : null),
        getCustomerByUserId: async (userId) => (h.customers.has(userId) ? snapshot(userId) : null),
      },
      orders: {
        getOrder: async (id) => (h.orderRefs.has(id) ? ({ id, ref: h.orderRefs.get(id)! } as OrderDetail) : null),
      },
      settings: {
        get: async (key: string) => h.settings[key] as never,
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
      access: {
        check: async (_p, action) => {
          const decision = h.authority[action] ?? 'allowed';
          return { decision, action, reason: decision === 'allowed' ? 'Within your $50.00 limit' : decision === 'denied' ? 'Your role has no authority' : 'Above your limit: Finance Manager approval', requiresSecondReviewer: false, approvalsNeeded: decision === 'allowed' ? 0 : 1, eligibleApproverRoles: [], eligibleApprovers: [] };
        },
        hasPermission: async () => h.finance.value,
        requestApproval: async (input) => {
          const existing = h.approvals.find((a) => a.action === input.action && a.target.id === input.target.id);
          if (existing) return { id: existing.id, ref: 'AP-0', status: 'pending' } as access.ApprovalRequest;
          const id = newId();
          h.approvals.push({ ...input, id });
          return { id, ref: `AP-${h.approvals.length}`, status: 'pending' } as access.ApprovalRequest;
        },
        getApproval: async (id) => {
          const a = h.approvals.find((x) => x.id === id);
          return a ? ({ id, ref: 'AP-1', status: 'approved', details: a.details } as access.ApprovalRequest) : null;
        },
        approvalInfo: async (id) => ({ required: true, reason: 'Waiting for Finance', approvalRequestId: id, approvers: ['Finance Manager'] }),
      },
    },
  });
  const service = app.kernel.boot.apis.get('wallet') as WalletService;
  for (const name of WALLET_EVENTS) app.kernel.events.subscribe('test', name, (e) => void h.events.push({ name: e.name, payload: e.payload }));
  const call: Harness['call'] = async (method, url, token, body, headers = {}) => {
    const res = await app.inject({ method: method as never, url, headers: { ...auth(token), ...headers }, ...(body !== undefined ? { payload: body as never } : {}) });
    await app.kernel.events.drain();
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
  };
  const publish: Harness['publish'] = async (source, name, payload) => {
    app.kernel.events.publish(source, name as never, payload as never);
    await app.kernel.events.drain();
  };
  const rest: Omit<Harness, keyof typeof h> = {
    app,
    service,
    call,
    publish,
    named: (name) => h.events.filter((e) => e.name === name).map((e) => e.payload),
    customer() {
      const id = newId();
      h.customers.add(id);
      return { id, token: callers.customer({ accountId: id }) };
    },
    async give(customerId, amount, o = {}) {
      await service.creditRefund({ customerId, refundId: newId(), orderId: o.orderId ?? newId(), amount: USD(amount), reason: 'Returned item' }, newId());
      await app.kernel.events.drain();
    },
    async decide(requestId, outcome) {
      const a = h.approvals.find((x) => x.id === requestId)!;
      await publish('access', 'access.approval.decided', {
        requestId,
        ref: 'AP-1',
        actionKey: a.action,
        module: 'wallet',
        target: a.target,
        outcome,
        decidedBy: { kind: 'staff', id: newId(), name: 'Fiona Finance' },
        reason: outcome === 'approved' ? 'Agreed' : 'Not justified',
        amount: a.amount ?? null,
        approverIds: [],
        requestedById: a.requestedBy.accountId ?? newId(),
      });
    },
    staff: (permissions) => callers.staff(permissions),
  };
  // one object: tests change h.authority, h.settings… and the stubs above read them
  return Object.assign(h, rest);
}
