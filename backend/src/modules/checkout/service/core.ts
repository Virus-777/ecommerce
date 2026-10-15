/**
 * Shared plumbing of the checkout service: owners and record scope, settings, optional modules,
 * the jsonb readers, the session log and events.
 */
import type { Scope } from '../../../kernel/auth/scope.js';
import { AppError, isAppError, isNotImplemented } from '../../../kernel/errors/index.js';
import type { EventMap } from '../../../kernel/events/index.js';
import { newId } from '../../../kernel/lib/ids.js';
import type { ModuleContext } from '../../../kernel/module-system/index.js';
import type * as common from '../../../spec/common.js';
import { emptyTotals, type StoredAccount, type StoredCredit, type StoredPayment, type StoredQuote } from '../domain/rules.js';
import type { Owner, SessionRow } from '../ports.js';
import type { CheckoutRepository } from '../repository.js';

export interface By {
  actor: common.Actor;
  requestId?: string;
}

export const SYSTEM: By = { actor: { kind: 'system', id: null, name: 'Checkout' } };

type CheckoutEvent = 'checkout.session.started' | 'checkout.changes.detected' | 'checkout.changes.accepted' | 'checkout.payment.retried' | 'checkout.session.completed' | 'checkout.session.abandoned';

export const invalid = (issues: { path: string; message: string }[], message = 'Check the highlighted fields') => new AppError('VALIDATION_FAILED', message, { issues });

export class Core {
  constructor(
    readonly ctx: ModuleContext<'checkout'>,
    readonly repo: CheckoutRepository,
  ) {}

  now() {
    return this.ctx.clock.now();
  }

  get currency() {
    return this.ctx.config.market.currency || 'USD';
  }

  error(code: string, message?: string, details?: unknown) {
    return this.ctx.error(code, message, details);
  }

  notFound(what = 'Checkout') {
    return new AppError('NOT_FOUND', `${what} not found`);
  }

  /** An optional module's answer; when the module is off or not built yet checkout works without it */
  async optional<T>(what: string, call: (() => Promise<T>) | undefined): Promise<T | undefined> {
    if (!call) return undefined;
    try {
      return await call();
    } catch (err) {
      if (isNotImplemented(err)) this.ctx.log.debug({ what }, 'checkout: optional module not built yet');
      else if (isAppError(err) && err.status < 500) this.ctx.log.info({ err, what }, 'checkout: optional module refused; continuing without it');
      else this.ctx.log.warn({ err, what }, 'checkout: optional module failed; continuing without it');
      return undefined;
    }
  }

  /* ================================================================ owners */

  /** The shopper behind a request: the signed-in customer or the visitor (guest) session */
  async ownerOf(scope: Scope): Promise<Owner> {
    if (scope.kind === 'visitor') return { guestSessionId: scope.visitorSessionId };
    if (scope.kind === 'customer') {
      const customerId = scope.customerId ?? (await this.ctx.use('customers').getCustomerByUserId(scope.accountId))?.id ?? null;
      if (!customerId) throw this.error('ORDERING_RESTRICTED', "We couldn't find your customer account. Sign in again or contact support.", { reason: 'no_customer_account' });
      return { customerId };
    }
    throw new AppError('UNAUTHORIZED', 'Sign in or continue as a guest to check out');
  }

  /** Owner for reads where an unknown customer simply sees nothing */
  async readerOf(scope: Scope): Promise<Owner | null> {
    if (scope.kind === 'visitor') return { guestSessionId: scope.visitorSessionId };
    if (scope.kind === 'customer') {
      const customerId = scope.customerId ?? (await this.ctx.use('customers').getCustomerByUserId(scope.accountId))?.id ?? null;
      return customerId ? { customerId } : null;
    }
    return null;
  }

  ownerOfRow(row: SessionRow): Owner {
    return row.customer_id ? { customerId: row.customer_id } : { guestSessionId: row.guest_session_id! };
  }

  async load(owner: Owner | null, id: string): Promise<SessionRow> {
    const row = owner ? await this.repo.getOwnSession(owner, id) : undefined;
    if (!row) throw this.notFound();
    return row;
  }

  /* ================================================================ jsonb readers */

  /** sessions.account (jsonb) with the email and name columns */
  account(row: SessionRow): StoredAccount {
    const a = (row.account ?? {}) as Partial<StoredAccount>;
    return {
      kind: a.kind === 'customer' ? 'customer' : 'guest',
      customerId: a.customerId ?? row.customer_id ?? null,
      name: row.contact_name ?? null,
      email: row.email ?? null,
      phone: a.phone ?? null,
      createAccountAfter: Boolean(a.createAccountAfter),
      marketingOptIn: Boolean(a.marketingOptIn),
      hidePricesOnSlip: Boolean(a.hidePricesOnSlip),
    };
  }

  /** The session columns an account is written to: email and name in their columns, the rest in sessions.account */
  accountPatch(a: StoredAccount): Pick<SessionRow, 'account' | 'email' | 'contact_name'> {
    const { email, name, ...rest } = a;
    return { account: rest as never, email: email ?? null, contact_name: name ?? null };
  }

  /** sessions.payment_selection (jsonb) with the intent columns */
  payment(row: SessionRow): StoredPayment {
    const p = (row.payment_selection ?? {}) as Partial<StoredPayment>;
    return {
      method: p.method ?? null,
      view: p.view ?? null,
      intentId: row.payment_intent_id ?? null,
      intentState: (row.payment_state as StoredPayment['intentState']) ?? null,
      methodLabel: p.methodLabel ?? null,
      decline: p.decline ?? null,
      cancelledOrders: p.cancelledOrders ?? [],
    };
  }

  /** The session columns a payment selection is written to: the intent and its state in their columns, the rest in sessions.payment_selection */
  paymentPatch(p: StoredPayment): Pick<SessionRow, 'payment_selection' | 'payment_intent_id' | 'payment_state'> {
    const { intentId, intentState, ...rest } = p;
    return { payment_selection: rest as never, payment_intent_id: intentId ?? null, payment_state: intentState ?? null };
  }

  /** The session columns a quote is written to: the whole quote in sessions.totals, its payable total in quote_total */
  quotePatch(q: StoredQuote): Pick<SessionRow, 'totals' | 'quote_total'> {
    return { totals: q as never, quote_total: q.totals.total.amount };
  }

  quote(row: SessionRow): StoredQuote {
    const q = (row.totals ?? {}) as Partial<StoredQuote>;
    return {
      fingerprint: q.fingerprint ?? '',
      lineInfo: q.lineInfo ?? {},
      shippability: q.shippability ?? {},
      lineAllocations: q.lineAllocations ?? {},
      shippingDiscounts: q.shippingDiscounts ?? {},
      coupons: q.coupons ?? [],
      discounts: q.discounts ?? [],
      tax: q.tax ?? null,
      // sessions quoted before shippingByPackage[].pending existed (2026-10) read as not pending
      totals: q.totals ? { ...q.totals, shippingByPackage: q.totals.shippingByPackage.map((s) => ({ ...s, pending: s.pending ?? false })) } : emptyTotals(row.currency),
      excluded: q.excluded ?? [],
      evaluation: q.evaluation ?? null,
      addressBookNote: q.addressBookNote ?? null,
      cartItemIds: q.cartItemIds ?? [],
    };
  }

  credit(row: SessionRow): StoredCredit | null {
    const c = row.credit as Partial<StoredCredit> | null;
    return c ? { use: Boolean(c.use), amount: typeof c.amount === 'number' ? c.amount : null, available: Number(c.available ?? 0), sourceNote: c.sourceNote ?? '' } : null;
  }

  address(row: SessionRow): common.Address | null {
    return (row.address as common.Address | null) ?? null;
  }

  couponCodes(row: SessionRow): string[] {
    return Array.isArray(row.coupon_codes) ? (row.coupon_codes as string[]) : [];
  }

  /* ================================================================ settings */

  async ttlMinutes() {
    return Number(await this.ctx.settings.get('sessionTtlMinutes')) || 60;
  }

  async idleExpiry() {
    return new Date(this.now().getTime() + (await this.ttlMinutes()) * 60_000);
  }

  /* ================================================================ log and events */

  async log(sessionId: string, label: string, detail?: string | null) {
    await this.repo.log({ id: newId(), session_id: sessionId, label, detail: detail ?? null, at: this.now() });
  }

  publish<N extends CheckoutEvent>(name: N, payload: EventMap[N], by: By = SYSTEM) {
    this.ctx.events.publish(name, payload, { actor: by.actor, requestId: by.requestId });
  }
}
