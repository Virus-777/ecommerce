/**
 * Shared plumbing for the wallet services: clock, currency, settings, events after commit, audit,
 * approval limits (access) and lookups in other modules (customers, orders, support) for names and refs.
 */
import { AppError, isAppError } from '../../../kernel/errors/index.js';
import type { EventMap } from '../../../kernel/events/event-map.js';
import type { ModuleContext } from '../../../kernel/module-system/index.js';
import { format } from '../../../kernel/lib/money.js';
import type * as access from '../../../spec/access.js';
import type * as audit from '../../../spec/audit.js';
import type * as common from '../../../spec/common.js';
import type * as customers from '../../../spec/customers.js';
import type * as identity from '../../../spec/identity.js';
import { m } from '../domain/rules.js';
import type { WalletRepository } from '../ports.js';

/** Who acts: the actor for records and events, the principal for approval limits (HTTP calls carry one) */
export interface By {
  actor: common.Actor;
  requestId?: string;
  principal?: identity.Principal | null;
}

type WalletEvent = Extract<keyof EventMap, `wallet.${string}`>;

/** Events collected inside a transaction and published once it committed */
export class Outbox {
  readonly items: { name: WalletEvent; payload: unknown }[] = [];
  push<N extends WalletEvent>(name: N, payload: EventMap[N]) {
    this.items.push({ name, payload });
  }
}

export type Issue = { path: string; message: string };

export const invalid = (issues: Issue[], message = 'Check the highlighted fields') => new AppError('VALIDATION_FAILED', message, { issues });
export const notFound = (what: string) => new AppError('NOT_FOUND', `${what} not found`);
export const conflict = (message: string, details?: unknown) => new AppError('CONFLICT', message, details);

export type Decision = { decision: 'allowed' | 'approval_required'; reason: string };

export class WalletCore {
  constructor(
    readonly repo: WalletRepository,
    readonly ctx: ModuleContext<'wallet'>,
  ) {}

  now(): Date {
    return this.ctx.clock.now();
  }

  /** One service region, one currency (plan ch. 1) */
  get currency(): string {
    return this.ctx.config.market.currency;
  }

  money(amount: number, currency = this.currency): common.Money {
    return m(amount, currency);
  }

  fmt(amount: number, currency = this.currency): string {
    return format(m(amount, currency));
  }

  error(code: 'INSUFFICIENT_CREDIT' | 'GOODWILL_LIMIT_EXCEEDED' | 'CREDIT_ALREADY_USED' | 'GIFT_CARD_INVALID', message?: string, details?: unknown): AppError {
    return this.ctx.error(code, message, details);
  }

  insufficient(available: number, currency = this.currency): AppError {
    return this.error('INSUFFICIENT_CREDIT', `Only ${this.fmt(available, currency)} of store credit is available`, { available: m(available, currency) });
  }

  /** A positive whole amount in the market currency (or any sign when `signed`) */
  checkMoney(v: common.Money | null | undefined, path: string, o: { signed?: boolean } = {}): Issue[] {
    if (!v || !Number.isSafeInteger(v.amount)) return [{ path, message: 'Enter a whole amount in minor units' }];
    if (v.currency !== this.currency) return [{ path: `${path}.currency`, message: `Store credit is in ${this.currency}` }];
    if (o.signed ? v.amount === 0 : v.amount <= 0) return [{ path, message: o.signed ? 'The amount cannot be zero' : 'The amount must be more than zero' }];
    return [];
  }

  /** Publishes after the commit (subscribers never fail the publisher) */
  flush(out: Outbox, by?: By) {
    for (const e of out.items) this.ctx.events.publish(e.name, e.payload as never, by ? { actor: by.actor, requestId: by.requestId } : undefined);
    out.items.length = 0;
  }

  async audit(entry: Omit<audit.RecordInput, 'actor' | 'module' | 'requestId'>, by: By): Promise<void> {
    const a = this.ctx.tryUse('audit');
    if (!a) return;
    try {
      await a.record({ ...entry, actor: by.actor, module: this.ctx.name, requestId: by.requestId ?? null });
    } catch (err) {
      this.ctx.log.warn({ err, action: entry.action }, 'wallet: audit entry not recorded');
    }
  }

  /* ---------------------------------------------------------------- approval limits */

  /** The principal for access: the HTTP caller, else the staff member named by the actor (in-process calls) */
  principalOf(by: By): identity.Principal | null {
    if (by.principal) return by.principal;
    if (by.actor.kind === 'staff' && by.actor.id) return { kind: 'staff', accountId: by.actor.id };
    return null;
  }

  /**
   * access.check is the only source of "allowed" (granting a permission never grants financial authority).
   * Without the access module (tests that boot wallet alone) the caller's permission stands.
   */
  async authority(by: By, action: string, amount: common.Money): Promise<Decision> {
    const acc = this.ctx.tryUse('access');
    if (!acc) return { decision: 'allowed', reason: 'Approval limits are not configured' };
    const principal = this.principalOf(by);
    if (!principal) throw new AppError('FORBIDDEN', 'Only staff can do this', { action });
    const check = await acc.check(principal, action, { money: amount });
    if (check.decision === 'denied') throw new AppError('FORBIDDEN', check.reason || 'Your role has no authority for this', { action });
    return { decision: check.decision, reason: check.reason };
  }

  async requestApproval(by: By, input: Omit<access.RequestApprovalInput, 'requestedBy'>): Promise<access.ApprovalRequest> {
    const principal = this.principalOf(by);
    if (!principal) throw new AppError('FORBIDDEN', 'Only staff can ask for approval', { action: input.action });
    return this.ctx.tryUse('access')!.requestApproval({ ...input, requestedBy: principal });
  }

  approvalRequired(req: { id: string; ref?: string | null }, details: Record<string, unknown>, message: string): AppError {
    return new AppError('APPROVAL_REQUIRED', message, { approvalRequestId: req.id, ...(req.ref ? { approvalRef: req.ref } : {}), ...details });
  }

  async hasPermission(by: By, permission: string): Promise<boolean> {
    const acc = this.ctx.tryUse('access');
    const principal = this.principalOf(by);
    if (!acc || !principal) return false;
    return this.soft('access.hasPermission', () => acc.hasPermission(principal, permission)).then((x) => x ?? false);
  }

  async approvalInfos(ids: readonly (string | null | undefined)[]): Promise<Map<string, common.ApprovalInfo>> {
    const out = new Map<string, common.ApprovalInfo>();
    const acc = this.ctx.tryUse('access');
    await Promise.all(
      [...new Set(ids.filter((x): x is string => Boolean(x)))].map(async (id) => {
        const info = acc ? await this.soft('access.approvalInfo', () => acc.approvalInfo(id)) : undefined;
        out.set(id, info ?? { required: true, approvalRequestId: id, approvers: [] });
      }),
    );
    return out;
  }

  /* ---------------------------------------------------------------- other modules */

  async customer(customerId: string): Promise<customers.CustomerSnapshot | null> {
    return this.ctx.use('customers').getCustomer(customerId);
  }

  async customerNames(ids: readonly string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    await Promise.all(
      [...new Set(ids)].map(async (id) => {
        const c = await this.soft('customers.getCustomer', () => this.customer(id));
        if (c) out.set(id, c.displayName);
      }),
    );
    return out;
  }

  /** Order references (MK-…) by order id, when orders is on */
  async orderRefs(ids: readonly (string | null | undefined)[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const orders = this.ctx.tryUse('orders');
    if (!orders) return out;
    await Promise.all(
      [...new Set(ids.filter((x): x is string => Boolean(x)))].map(async (id) => {
        const o = await this.soft('orders.getOrder', () => orders.getOrder(id));
        if (o) out.set(id, o.ref);
      }),
    );
    return out;
  }

  /** Case references (CS-…) by case id; support finds them through the case's order */
  async caseRefs(pairs: readonly { caseId: string | null; orderId: string | null }[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const support = this.ctx.tryUse('support');
    if (!support) return out;
    const orderIds = [...new Set(pairs.filter((p) => p.caseId && p.orderId).map((p) => p.orderId!))];
    await Promise.all(
      orderIds.map(async (orderId) => {
        const cases = await this.soft('support.casesForOrder', () => support.casesForOrder(orderId));
        for (const c of cases ?? []) out.set(c.caseId, c.ref);
      }),
    );
    return out;
  }

  /** A lookup for display: failures (a module not answering) leave the field empty */
  async soft<R>(what: string, fn: () => Promise<R>): Promise<R | undefined> {
    try {
      return await fn();
    } catch (err) {
      if (!isAppError(err) || err.status >= 500) this.ctx.log.warn({ err, what }, 'wallet: lookup failed');
      return undefined;
    }
  }
}
