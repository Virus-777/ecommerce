/**
 * Shared plumbing of the payments use cases: time, settings, events, audit, optional modules, provider calls
 * (every call is logged in provider_calls without card data), references and the lookups other modules answer
 * (orders, customers, staff names) memoized per operation.
 */
import type { Principal } from '../../../kernel/auth/index.js';
import { AppError, isAppError } from '../../../kernel/errors/index.js';
import { illegalTransition } from '../../../kernel/errors/index.js';
import type { EventMap } from '../../../kernel/events/index.js';
import { dateInZone } from '../../../kernel/lib/clock.js';
import { newId } from '../../../kernel/lib/ids.js';
import type { ModuleContext, PublicApiMap } from '../../../kernel/module-system/index.js';
import type * as audit from '../../../spec/audit.js';
import type * as common from '../../../spec/common.js';
import type { OrderDetail } from '../../../spec/orders.js';
import type { ProviderCall } from '../../../spec/payments.js';
import { ProviderError, type PaymentProvider } from '../ports.js';
import type { PaymentsRepository } from '../repository.js';

export interface PaymentsServiceDeps {
  repo: PaymentsRepository;
  ctx: ModuleContext<'payments'>;
  provider: PaymentProvider;
}

/** Who acts, as the HTTP layer (or an event) knows it */
export interface By {
  actor: common.Actor;
  requestId?: string;
  principal?: Principal | null;
}

export const SYSTEM: common.Actor = { kind: 'system', id: null, name: 'Marketly' };

/** Approval action of the manual money actions on the payments admin API (Core.manual) */
export const MANUAL_ACTION = 'payments.payments.correct';

/** One manual money action as access sees it */
export interface ManualOp {
  /** What is done; also the approval target type */
  kind: 'payment_capture' | 'payment_void' | 'payment_orphan_refund' | 'refund_retry' | 'refund_cancel';
  /** The payment (intent) or refund id */
  id: string;
  ref: string | null;
  label: string;
  summary: string;
  amount: common.Money;
  reason: string;
  /** What the action needs again when it runs after approval (capture amount and seller group) */
  params?: Record<string, unknown>;
}
export const PROVIDER_ACTOR: common.Actor = { kind: 'provider', id: null, name: 'Payment processor' };

/** Settings read before a transaction (settings use their own connection) */
export interface Cfg {
  captureMode: 'on_acceptance' | 'per_group_on_dispatch';
  authorizationValidDays: number;
  uncertainMaxHours: number;
  storeCheckRateLimitSeconds: number;
  refundMaxAttempts: number;
  refundArrivalNote: string;
  orphanGraceMinutes: number;
  acceptedCardBrands: string[];
  walletsEnabled: boolean;
  statementDescriptor: string;
}

type OwnEvent = keyof EventMap & `payments.${string}`;
type Optional = Parameters<ModuleContext<'payments'>['tryUse']>[0];

/** Events collected inside a transaction and published after the commit */
export class Batch {
  readonly events: { name: OwnEvent; payload: unknown }[] = [];
  push<N extends OwnEvent>(name: N, payload: EventMap[N]) {
    this.events.push({ name, payload });
  }
}

export const invalid = (issues: { path: string; message: string }[], message = 'Some details need fixing') => new AppError('VALIDATION_FAILED', message, { issues });
export const notFound = (what = 'Payment') => new AppError('NOT_FOUND', `${what} not found`);
export const illegal = illegalTransition;

/**
 * Purchase intents (software purchases, food orders, pay-in-full farm orders; spec note "Purchase intents") have no checkout session and no
 * order: the orphan sweep, captures on order events, allocations, refunds, the admin payment list and the
 * payments.payment.* events skip them. Rows written before purposes existed are checkout intents.
 */
export const isPurchase = (i: { purpose?: string | null }) => i.purpose === 'purchase';

/** Who a purchase intent's events are about */
export function purchaseOf(i: { id: string; purchase_module: string | null; purchase_ref_id: string | null; customer_id: string | null }) {
  return { intentId: i.id, module: i.purchase_module as 'software' | 'food' | 'farm', refId: i.purchase_ref_id!, customerId: i.customer_id! };
}

/** The checkout session of a checkout intent (every checkout intent has one; a purchase intent here is a bug) */
export function checkoutSessionOf(i: { id: string; checkout_session_id: string | null }): string {
  if (!i.checkout_session_id) throw new Error(`payments: intent ${i.id} is not a checkout payment`);
  return i.checkout_session_id;
}

/** What payments needs from an order (orders.getOrder), flattened */
export interface OrderInfo {
  id: string;
  ref: string;
  placedAt: string;
  customerId: string | null;
  contactName: string;
  contactEmail: string;
  paymentIntentId: string | null;
  lifecycle: string;
  groups: Map<string, { ownerType: 'official' | 'seller'; sellerId: string | null; sellerName: string; total: number; status: string }>;
  items: Map<string, { title: string; groupId: string; state: string; paid: number }>;
}

export function orderInfoOf(o: OrderDetail): OrderInfo {
  const groups: OrderInfo['groups'] = new Map();
  const items: OrderInfo['items'] = new Map();
  for (const g of o.groups) {
    groups.set(g.id, { ownerType: g.seller.ownerType, sellerId: g.seller.id ?? null, sellerName: g.seller.name, total: g.totals.total.amount, status: g.status });
    for (const i of g.items) items.set(i.id, { title: i.variantLabel ? `${i.title} (${i.variantLabel})` : i.title, groupId: g.id, state: i.state, paid: i.paidAmount.amount });
  }
  return {
    id: o.id,
    ref: o.ref,
    placedAt: o.placedAt,
    customerId: o.contact.customerId ?? null,
    contactName: o.contact.name,
    contactEmail: o.contact.email,
    paymentIntentId: o.paymentIntentId ?? null,
    lifecycle: o.lifecycle,
    groups,
    items,
  };
}

/** Lookups in other modules, memoized for one operation (lists ask once per id) */
export class Lookup {
  readonly #orders = new Map<string, Promise<OrderInfo | null>>();
  readonly #customers = new Map<string, Promise<string | null>>();
  readonly #staff = new Map<string, Promise<string | null>>();
  constructor(private readonly core: Core) {}

  order(orderId: string | null | undefined): Promise<OrderInfo | null> {
    if (!orderId) return Promise.resolve(null);
    let p = this.#orders.get(orderId);
    if (!p) {
      p = this.core.ctx
        .use('orders')
        .getOrder(orderId)
        .then((o) => (o ? orderInfoOf(o) : null))
        .catch((err) => {
          if (!isAppError(err)) this.core.ctx.log.warn({ err, orderId }, 'payments: order lookup failed');
          return null;
        });
      this.#orders.set(orderId, p);
    }
    return p;
  }

  /** Customer's profile name, else the order contact name, else the guest email */
  async customerName(i: { customer_id: string | null; guest_email: string | null; order_id?: string | null }): Promise<string> {
    if (i.customer_id) {
      let p = this.#customers.get(i.customer_id);
      if (!p) {
        p = this.core.soft('customers', 'getCustomer', (c) => c.getCustomer(i.customer_id!)).then((c) => c?.displayName ?? null);
        this.#customers.set(i.customer_id, p);
      }
      const name = await p;
      if (name) return name;
      const order = await this.order(i.order_id);
      if (order?.contactName) return order.contactName;
      return 'Customer';
    }
    return i.guest_email ?? (await this.order(i.order_id))?.contactEmail ?? 'Guest';
  }

  staffName(staffId: string | null | undefined): Promise<string | null> {
    if (!staffId) return Promise.resolve(null);
    let p = this.#staff.get(staffId);
    if (!p) {
      p = this.core.soft('access', 'getStaffRef', (a) => a.getStaffRef(staffId)).then((s) => s?.name ?? null);
      this.#staff.set(staffId, p);
    }
    return p;
  }
}

export class Core {
  readonly repo: PaymentsRepository;
  readonly ctx: ModuleContext<'payments'>;
  readonly provider: PaymentProvider;

  constructor(deps: PaymentsServiceDeps) {
    this.repo = deps.repo;
    this.ctx = deps.ctx;
    this.provider = deps.provider;
  }

  now = () => this.ctx.clock.now();
  get tz() {
    return this.ctx.config.market.timeZone;
  }
  today = (at: Date = this.now()) => dateInZone(at, this.tz);
  error = (code: string, message?: string, details?: unknown) => this.ctx.error(code, message, details);
  lookup = () => new Lookup(this);

  async cfg(): Promise<Cfg> {
    const s = this.ctx.settings;
    const [captureMode, authorizationValidDays, uncertainMaxHours, storeCheckRateLimitSeconds, refundMaxAttempts, refundArrivalNote, orphanGraceMinutes, acceptedCardBrands, walletsEnabled, statementDescriptor] = await Promise.all([
      s.get('captureMode'),
      s.get('authorizationValidDays'),
      s.get('uncertainMaxHours'),
      s.get('storeCheckRateLimitSeconds'),
      s.get('refundMaxAttempts'),
      s.get('refundArrivalNote'),
      s.get('orphanGraceMinutes'),
      s.get('acceptedCardBrands'),
      s.get('walletsEnabled'),
      s.get('statementDescriptor'),
    ]);
    return {
      captureMode: captureMode === 'per_group_on_dispatch' ? 'per_group_on_dispatch' : 'on_acceptance',
      authorizationValidDays: Number(authorizationValidDays ?? 7),
      uncertainMaxHours: Number(uncertainMaxHours ?? 24),
      storeCheckRateLimitSeconds: Number(storeCheckRateLimitSeconds ?? 15),
      refundMaxAttempts: Math.max(1, Number(refundMaxAttempts ?? 3)),
      refundArrivalNote: String(refundArrivalNote ?? 'Card refunds usually arrive 3–5 business days after we send them.'),
      orphanGraceMinutes: Number(orphanGraceMinutes ?? 15),
      acceptedCardBrands: (Array.isArray(acceptedCardBrands) ? acceptedCardBrands : ['visa', 'mastercard', 'amex', 'discover']).map((b) => String(b).toLowerCase()),
      walletsEnabled: walletsEnabled !== false,
      statementDescriptor: String(statementDescriptor ?? 'MARKETLY'),
    };
  }

  publish<N extends OwnEvent>(name: N, payload: EventMap[N], by: { actor?: common.Actor; requestId?: string } = {}) {
    this.ctx.events.publish(name as never, payload as never, { actor: by.actor ?? SYSTEM, ...(by.requestId ? { requestId: by.requestId } : {}) });
  }

  /** Publishes what a transaction collected (after the commit) */
  flush(batch: Batch, by: { actor?: common.Actor; requestId?: string } = {}) {
    for (const e of batch.events.splice(0)) this.publish(e.name, e.payload as never, by);
  }

  async audit(entry: Omit<audit.RecordInput, 'actor' | 'module' | 'requestId'>, by: By) {
    try {
      await this.ctx.tryUse('audit')?.record({ ...entry, actor: by.actor, module: this.ctx.name, requestId: by.requestId ?? null });
    } catch (err) {
      this.ctx.log.warn({ err, action: entry.action }, 'payments: audit entry not written');
    }
  }

  /* ---------------------------------------------------------------- manual money actions (limits through access) */

  /**
   * Staff moving money by hand on the payments admin API (capture, void, returning an orphan payment, retrying or
   * cancelling a refund) is held to the same rules as every other money action: access decides with approval action
   * payments.payments.correct and the amount (a permission alone never allows it).
   * - allowed: done now; above access stepUpAbove only with the caller's password again (reauthToken, purpose
   *   approval), else STEP_UP_REQUIRED. The token is given back when the action then fails.
   * - approval_required: an approval request (the action and its parameters in details) and 409 APPROVAL_REQUIRED,
   *   as for dispute concessions: these endpoints answer the payment or refund, which has no pending state to save,
   *   so nothing changes until the request is approved; then onManualApproved carries the action out by itself.
   * - denied: FORBIDDEN.
   * approvedBy: the approval request this run carries out (the decision was made in access, so no check again).
   */
  async manual<T>(op: ManualOp, by: By, o: { reauthToken?: string | null; approvedBy?: string | null }, run: () => Promise<T>): Promise<T> {
    if (o.approvedBy) return run();
    const access = this.ctx.tryUse('access');
    // without access no staff permission reaches these endpoints either; the kernel's permission check stands
    if (!access) return run();
    if (!by.principal) throw new AppError('FORBIDDEN', 'Manual money actions need a staff session');
    const check = await access.check(by.principal, MANUAL_ACTION, { money: op.amount });
    if (check.decision === 'denied') throw new AppError('FORBIDDEN', check.reason || 'Your role cannot move money on payments by hand');
    if (check.decision === 'approval_required') {
      const request = await access.requestApproval({
        action: MANUAL_ACTION,
        // the kind is the target type, so a capture and a void asked on the same payment are separate requests
        target: { type: op.kind, id: op.id, ref: op.ref, label: op.label, screen: 'admin/finance' },
        amount: op.amount,
        summary: op.summary,
        details: { kind: op.kind, reason: op.reason, ...(op.params ?? {}) },
        reason: op.reason,
        requestedBy: by.principal,
      });
      await this.audit({ action: 'payments.manual.request_approval', actionLabel: `Asked for approval: ${op.summary}`, category: 'financial', target: { type: op.kind, id: op.id, ref: op.ref, label: op.label, screen: 'admin/finance' }, reason: op.reason, approvalRequestId: request.id }, by);
      throw new AppError('APPROVAL_REQUIRED', `${check.reason || 'Above your limit'}; sent for approval. It is carried out once approved.`, {
        approvalRequestId: request.id,
        approval: { required: true, reason: check.reason, approvalRequestId: request.id, approvers: (check.eligibleApproverRoles ?? []).map((r) => r.name) },
      });
    }
    const claimed = check.stepUpRequired ? await this.claimApprovalReauth(by, o.reauthToken) : null;
    try {
      return await run();
    } catch (err) {
      // not done: the token works again for the retry (best effort)
      if (claimed) await this.soft('identity', 'release re-auth token', (i) => i.releaseReauthToken(claimed));
      throw err;
    }
  }

  /** Claims the caller's re-auth token (single use, issued for purpose approval to this session); STEP_UP_REQUIRED otherwise */
  private async claimApprovalReauth(by: By, token: string | null | undefined): Promise<string> {
    const refuse = () => new AppError('STEP_UP_REQUIRED', 'Enter your password again to move this money', { kind: 'reauth', purpose: 'approval' });
    const identity = this.ctx.tryUse('identity');
    if (!token || !identity || !by.principal) throw refuse();
    if (!(await identity.verifyReauthToken(by.principal, token, 'approval'))) throw refuse();
    if (!(await identity.consumeReauthToken(token))) throw refuse();
    return token;
  }

  /** An optional module's answer; off, not built or failing → undefined (the caller degrades) */
  async soft<M extends Optional, R>(module: M, what: string, fn: (api: PublicApiMap[M & keyof PublicApiMap]) => Promise<R>): Promise<R | undefined> {
    const api = this.ctx.tryUse(module) as PublicApiMap[M & keyof PublicApiMap] | undefined;
    if (!api) return undefined;
    try {
      return await fn(api);
    } catch (err) {
      if (!isAppError(err)) this.ctx.log.warn({ err, module, what }, 'payments: optional call failed');
      return undefined;
    }
  }

  /**
   * Who customer-facing events are about: the customers-module id (null for guests) and the contact email (the
   * guest's checkout email, else the order's contact email). Read before a transaction: orders answers on its own connection.
   */
  async contactOf(i: { customer_id: string | null; guest_email: string | null; order_id: string | null }, lookup: Lookup = this.lookup()): Promise<{ customerId: string | null; contactEmail: string | null }> {
    const contactEmail = i.guest_email ?? (i.order_id ? ((await lookup.order(i.order_id))?.contactEmail ?? null) : null);
    return { customerId: i.customer_id, contactEmail: contactEmail || null };
  }

  /** Daily reference from payments.ref_sequences: RF-261009-0001, CB-…, DP-… (outside or inside a transaction) */
  async nextRef(prefix: 'RF' | 'CB' | 'DP', repo: PaymentsRepository = this.repo): Promise<string> {
    const day = this.today();
    const n = await repo.nextSequence(prefix, day);
    return `${prefix}-${day.replace(/-/g, '').slice(2)}-${String(n).padStart(4, '0')}`;
  }

  /**
   * Calls the provider and logs the call (operation, outcome, reference, latency; never card data).
   * ProviderError (timeout or unavailable) is logged and rethrown for the caller to decide.
   */
  async call<T>(
    operation: ProviderCall['operation'],
    link: { intentId?: string | null; refundId?: string | null },
    fn: () => Promise<T>,
    describe: (r: T) => { outcome: ProviderCall['outcome']; providerRef?: string | null; message?: string | null } = () => ({ outcome: 'ok' }),
  ): Promise<T> {
    const started = Date.now();
    const log = async (outcome: ProviderCall['outcome'], providerRef?: string | null, message?: string | null) => {
      await this.repo
        .insert('provider_calls', {
          id: newId(),
          intent_id: link.intentId ?? null,
          refund_id: link.refundId ?? null,
          operation,
          outcome,
          provider_ref: providerRef ?? null,
          message: message ?? null,
          latency_ms: Date.now() - started,
          at: this.now(),
        })
        .catch((err) => this.ctx.log.warn({ err, operation }, 'payments: provider call not logged'));
    };
    try {
      const r = await fn();
      const d = describe(r);
      await log(d.outcome, d.providerRef, d.message);
      return r;
    } catch (err) {
      if (err instanceof ProviderError) await log(err.uncertain ? 'timeout' : 'error', null, err.message);
      else await log('error', null, (err as Error).message?.slice(0, 200));
      throw err;
    }
  }

  /** PROVIDER_UNAVAILABLE for a provider error on a call made on someone's behalf */
  unavailable(err: unknown): never {
    if (err instanceof ProviderError) throw this.error('PROVIDER_UNAVAILABLE', err.uncertain ? 'The payment provider did not answer. We will check the result; do not try again yet.' : undefined);
    throw err;
  }
}
