/**
 * Place order, payment retries and bank challenges (plan scenario 3): one order and one charge per
 * checkout whatever the number of taps, refreshes or retries.
 *
 *   claim (open → placing, row lock) → revalidate (changes → changes_pending, nothing charged)
 *   → inventory.hold → promotions.reserveRedemption (key: the session id) → wallet.holdCredit
 *   → payments.authorize (key: session id + attempt number)
 *   → accepted / pending: orders.createOrder (payment pending) → promotions.commitRedemption
 *     → inventory.attachOrder → payments.linkOrder → orders.acceptOrder (accepted only)
 *     → cart.removePurchasedItems → identity.grantGuestOrderAccess → completed / payment_pending
 *   → failed: no order, holds kept until holdUntil → payment_failed
 *   → requires_action: awaiting_action until POST /complete-action or the payments event
 */
import { createHash } from 'node:crypto';
import { AppError, isAppError } from '../../../kernel/errors/index.js';
import type { EventPayload } from '../../../kernel/events/index.js';
import { hashRequest } from '../../../kernel/http/idempotency.js';
import { newId } from '../../../kernel/lib/ids.js';
import { allocate } from '../../../kernel/lib/money.js';
import type * as orders from '../../../spec/orders.js';
import type * as payments from '../../../spec/payments.js';
import type * as shipping from '../../../spec/shipping.js';
import type { CheckoutView, PlaceOrderInput, PlaceOrderResult, RetryPaymentInput } from '../../../spec/checkout.js';
import { cardLabel, m, missingSteps, plural, type StoredChange, type StoredPayment } from '../domain/rules.js';
import { checkoutSessionMachine } from '../domain/state-machines.js';
import type { LineRow, Owner, PackageRow, PlaceRequestRow, SessionRow } from '../ports.js';
import { SYSTEM, type By, type Core } from './core.js';
import { byLineOrder, included } from './quote.js';
import { isStockError, type Revalidator } from './revalidation.js';
import type { Views } from './views.js';

type Kind = PlaceRequestRow['kind'];
type Status = Parameters<typeof checkoutSessionMachine.next>[0];
type Event = Parameters<typeof checkoutSessionMachine.next>[1];

const IN_FLIGHT = ['placing', 'awaiting_action', 'payment_pending', 'completed'];

/** A uuid derived from a name (a new order key after an order of this checkout was cancelled) */
export function stableUuid(name: string): string {
  const h = createHash('sha256').update(name).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16)}${h.slice(18, 20)}-${h.slice(20, 32)}`;
}

export class Placement {
  constructor(
    private readonly core: Core,
    private readonly views: Views,
    private readonly reval: Revalidator,
    private readonly view: (s: SessionRow) => Promise<CheckoutView>,
  ) {}

  private get ctx() {
    return this.core.ctx;
  }

  private now() {
    return this.core.now();
  }

  /* ================================================================ results */

  /** The result a session's status stands for (replays, a second Place order, polling) */
  async currentResult(session: SessionRow): Promise<PlaceOrderResult> {
    const base = { orderId: session.order_id, orderRef: session.order_ref };
    const payment = await this.views.lastPayment(session);
    const checkout = await this.view(session);
    switch (session.status) {
      case 'completed':
        return { outcome: 'accepted', next: 'confirmation', ...base, payment, changeSet: null, retryUntil: null, checkout };
      case 'payment_pending':
      case 'placing':
        return { outcome: 'payment_pending', next: 'payment_result', ...base, payment, changeSet: null, retryUntil: null, checkout };
      case 'awaiting_action':
        return { outcome: 'requires_action', next: 'complete_action', ...base, payment, changeSet: null, retryUntil: null, checkout };
      case 'payment_failed':
        return { outcome: 'payment_failed', next: 'payment_result', ...base, payment, changeSet: null, retryUntil: session.hold_until?.toISOString() ?? null, checkout };
      case 'changes_pending':
      case 'open': {
        const open = await this.core.repo.openChangeSet(session.id);
        return { outcome: 'changes_required', next: 'review_changes', ...base, payment, changeSet: open ? this.views.changeSet(open) : null, retryUntil: null, checkout };
      }
      case 'expired':
        throw this.core.error('SESSION_EXPIRED', 'This checkout expired. Start again from your cart; nothing was charged.');
      default:
        throw new AppError('ILLEGAL_TRANSITION', 'This checkout was cancelled. Start again from your cart.', { machine: 'Checkout session', from: session.status });
    }
  }

  private async transition(id: string, from: string[], event: Event, patch: Partial<SessionRow> = {}): Promise<{ session: SessionRow; won: boolean }> {
    return this.core.repo.transaction(async (tx) => {
      const s = (await tx.getSession(id, { forUpdate: true }))!;
      if (!from.includes(s.status)) return { session: s, won: false };
      const status = checkoutSessionMachine.next(s.status as Status, event);
      return { session: await tx.updateSession(id, { ...patch, status, updated_at: this.now() }), won: true };
    });
  }

  private async savePayment(id: string, patch: Partial<StoredPayment>): Promise<SessionRow> {
    return this.core.repo.transaction(async (tx) => {
      const s = (await tx.getSession(id, { forUpdate: true }))!;
      return tx.updateSession(id, { payment_selection: { ...this.core.payment(s), ...patch } as never });
    });
  }

  /* ================================================================ idempotency */

  /** Same key + same body → the stored result refreshed with the current status; same key + another body → IDEMPOTENCY_KEY_REUSED */
  private async replayed(session: SessionRow, kind: Kind, key: string, body: unknown): Promise<{ hash: string; replay?: PlaceOrderResult }> {
    const hash = hashRequest({ kind, body });
    const existing = await this.core.repo.getPlaceRequest(session.id, key);
    if (!existing) return { hash };
    if (existing.request_hash !== hash) throw new AppError('IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was used for a different request');
    return { hash, replay: await this.currentResult(session) };
  }

  /** Records a request answered with the current result (no new attempt) */
  private async answered(session: SessionRow, kind: Kind, key: string, hash: string, result: PlaceOrderResult) {
    const now = this.now();
    await this.core.repo.insertPlaceRequest({
      id: newId(),
      session_id: session.id,
      idempotency_key: key,
      request_hash: hash,
      kind,
      outcome: result.outcome,
      response: { quoteVersion: session.quote_version, total: this.core.quote(session).totals.total.amount, replayOf: 'current_status', result: { outcome: result.outcome, orderId: result.orderId ?? null } } as never,
      payment_intent_id: this.core.payment(session).intentId,
      created_at: now,
      completed_at: now,
    });
    return result;
  }

  private async finishRequest(req: PlaceRequestRow, session: SessionRow, result: PlaceOrderResult) {
    await this.core.repo.updatePlaceRequest(req.id, {
      outcome: result.outcome,
      response: { ...((req.response ?? {}) as object), result: { outcome: result.outcome, next: result.next, orderId: result.orderId ?? null, orderRef: result.orderRef ?? null, changeSetId: result.changeSet?.id ?? null } } as never,
      payment_intent_id: this.core.payment(session).intentId ?? req.payment_intent_id,
      completed_at: this.now(),
    });
  }

  /* ================================================================ checks */

  private async checkReady(session: SessionRow, quoteVersion: number, expectedTotal: { amount: number; currency: string }) {
    if (session.expires_at.getTime() <= this.now().getTime() && session.status === 'open') throw this.core.error('SESSION_EXPIRED', 'This checkout expired. Start again from your cart; nothing was charged.');
    const [lines, packages] = await Promise.all([this.core.repo.listLines(session.id), this.core.repo.listPackages(session.id)]);
    const missing = missingSteps(this.views.stepFacts(session, lines, packages));
    if (missing.length) throw this.core.error('CHECKOUT_INCOMPLETE', `Finish these steps first: ${missing.join(', ')}`, { missingSteps: missing });
    const total = this.core.quote(session).totals.total;
    if (quoteVersion !== session.quote_version || expectedTotal.amount !== total.amount || expectedTotal.currency !== total.currency) {
      throw this.core.error('QUOTE_OUTDATED', 'Your order total changed. Check the new total before placing your order.', { quoteVersion: session.quote_version, total });
    }
    if (session.customer_id) {
      const can = await this.ctx.use('customers').canPlaceOrders(session.customer_id);
      if (!can.allowed) throw this.core.error('ORDERING_RESTRICTED', can.reason ?? 'This account cannot place orders right now', { reason: can.reason ?? null });
    }
  }

  /** A saved card must still be on file; a new card or wallet needs the provider's single-use token */
  async validateMethod(session: SessionRow, method: payments.MethodSelection): Promise<Pick<StoredPayment, 'method' | 'view'>> {
    const invalid = (message: string) => this.core.error('PAYMENT_METHOD_INVALID', message, { kind: method.kind });
    const billing = method.billingAddress ? `${method.billingAddress.name}, ${method.billingAddress.city} ${method.billingAddress.postalCode}` : null;
    if (method.kind === 'saved_card') {
      if (!session.customer_id) throw invalid('Sign in to use a saved card');
      if (!method.savedMethodId) throw invalid('Choose one of your saved cards');
      const options = await this.views.paymentOptions(session, this.core.quote(session).totals.total);
      const saved = options.savedMethods.find((s) => s.id === method.savedMethodId);
      if (!saved) throw invalid('This card is no longer saved to your account');
      if (saved.expired) throw invalid(`${cardLabel(saved.brand, saved.last4)} has expired. Choose another card.`);
      return { method: { ...method, providerToken: null }, view: { kind: 'saved_card', label: cardLabel(saved.brand, saved.last4), savedMethodId: saved.id, billingSummary: saved.billingSummary } };
    }
    if (!method.providerToken?.trim()) throw invalid(method.kind === 'new_card' ? 'Enter your card details again' : 'Confirm the payment in your wallet again');
    if (method.kind === 'digital_wallet') {
      const options = await this.views.paymentOptions(session, this.core.quote(session).totals.total);
      if (!options.walletAvailable) throw invalid('Digital wallets are not available for this order');
    }
    if (method.kind === 'new_card' && !session.customer_id && method.saveForLater) throw invalid('Sign in to save a card for later');
    return { method, view: { kind: method.kind, label: method.label?.trim() || (method.kind === 'new_card' ? 'New card' : 'Digital wallet'), savedMethodId: null, billingSummary: billing } };
  }

  /* ================================================================ Place order */

  async place(owner: Owner | null, id: string, input: PlaceOrderInput, key: string, by: By): Promise<PlaceOrderResult> {
    let session = await this.core.load(owner, id);
    const { hash, replay } = await this.replayed(session, 'place', key, input);
    if (replay) return replay;
    if (IN_FLIGHT.includes(session.status) || session.status === 'changes_pending') return this.answered(session, 'place', key, hash, await this.currentResult(session));
    if (session.status === 'expired') throw this.core.error('SESSION_EXPIRED', 'This checkout expired. Start again from your cart; nothing was charged.');
    if (session.status === 'payment_failed') throw new AppError('ILLEGAL_TRANSITION', 'The payment was declined. Pay again with Retry payment or go back to checkout.', { machine: 'Checkout session', from: session.status, event: 'place', allowed: checkoutSessionMachine.eventsFrom('payment_failed') });
    if (session.status !== 'open') checkoutSessionMachine.next(session.status as Status, 'place');
    if (!input.acceptTerms) throw this.core.error('TERMS_NOT_ACCEPTED', 'Accept the purchase terms to place your order');
    await this.checkReady(session, input.quoteVersion, input.expectedTotal);
    const pay = this.core.payment(session);
    await this.validateMethod(session, pay.method!);

    // claim: open → placing under the row lock; any later Place order answers with the current result
    const claimed = await this.core.repo.transaction(async (tx) => {
      const s = (await tx.getSession(id, { forUpdate: true }))!;
      if (s.status !== 'open' || s.quote_version !== input.quoteVersion) return { session: s, req: undefined };
      const req = await tx.insertPlaceRequest({ id: newId(), session_id: id, idempotency_key: key, request_hash: hash, kind: 'place', outcome: null, response: { quoteVersion: s.quote_version, total: this.core.quote(s).totals.total.amount } as never, payment_intent_id: null, created_at: this.now(), completed_at: null });
      if (!req) return { session: s, req: undefined };
      return { session: await tx.updateSession(id, { status: checkoutSessionMachine.next('open', 'place'), channel: input.channel, updated_at: this.now() }), req };
    });
    session = claimed.session;
    if (!claimed.req) {
      const again = await this.replayed(session, 'place', key, input);
      if (again.replay) return again.replay;
      if (session.status === 'open') throw this.core.error('QUOTE_OUTDATED', 'Your order total changed. Check the new total before placing your order.', { quoteVersion: session.quote_version, total: this.core.quote(session).totals.total });
      return this.currentResult(session);
    }
    await this.core.log(id, 'Place order', `Key ${key}, total ${this.core.quote(session).totals.total.amount}`);
    return this.run(session, claimed.req, { from: 'open', returnUrl: input.returnUrl, method: pay.method! }, by);
  }

  /* ================================================================ retry after a decline */

  async retry(owner: Owner | null, id: string, input: RetryPaymentInput, key: string, by: By): Promise<PlaceOrderResult> {
    let session = await this.core.load(owner, id);
    const { hash, replay } = await this.replayed(session, 'retry', key, input);
    if (replay) return replay;
    if (IN_FLIGHT.includes(session.status) || session.status === 'changes_pending') return this.answered(session, 'retry', key, hash, await this.currentResult(session));
    if (session.status === 'expired') throw this.core.error('RETRY_WINDOW_EXPIRED', 'The hold after your declined payment ended. Start checkout again from your cart.');
    if (session.status !== 'payment_failed') checkoutSessionMachine.next(session.status as Status, 'retry_payment');
    if (session.hold_until && session.hold_until.getTime() <= this.now().getTime()) throw this.core.error('RETRY_WINDOW_EXPIRED', 'The hold after your declined payment ended. Start checkout again from your cart.', { holdUntil: session.hold_until.toISOString() });
    const max = Number(await this.ctx.settings.get('maxPaymentAttempts')) || 5;
    if (session.attempt_count >= max) throw this.core.error('RETRY_WINDOW_EXPIRED', `You've reached the limit of ${max} payment attempts for this checkout. Start again from your cart.`, { attempts: session.attempt_count, max });
    const total = this.core.quote(session).totals.total;
    if (input.quoteVersion !== session.quote_version || input.expectedTotal.amount !== total.amount || input.expectedTotal.currency !== total.currency) {
      throw this.core.error('QUOTE_OUTDATED', 'Your order total changed. Check the new total before paying.', { quoteVersion: session.quote_version, total });
    }
    const chosen = await this.validateMethod(session, input.method);

    const claimed = await this.core.repo.transaction(async (tx) => {
      const s = (await tx.getSession(id, { forUpdate: true }))!;
      if (s.status !== 'payment_failed') return { session: s, req: undefined };
      const req = await tx.insertPlaceRequest({ id: newId(), session_id: id, idempotency_key: key, request_hash: hash, kind: 'retry', outcome: null, response: { quoteVersion: s.quote_version, total: total.amount } as never, payment_intent_id: null, created_at: this.now(), completed_at: null });
      if (!req) return { session: s, req: undefined };
      const payment = { ...this.core.payment(s), method: chosen.method, view: chosen.view };
      return { session: await tx.updateSession(id, { status: checkoutSessionMachine.next('payment_failed', 'retry_payment'), payment_selection: payment as never, updated_at: this.now() }), req };
    });
    session = claimed.session;
    if (!claimed.req) {
      const again = await this.replayed(session, 'retry', key, input);
      return again.replay ?? this.currentResult(session);
    }
    this.core.publish('checkout.payment.retried', { sessionId: id, attemptNo: session.attempt_count + 1, methodKind: input.method.kind }, by);
    await this.core.log(id, 'Payment retried', `${chosen.view?.label ?? input.method.kind}`);
    return this.run(session, claimed.req, { from: 'payment_failed', returnUrl: input.returnUrl, method: chosen.method! }, by);
  }

  /* ================================================================ the attempt */

  private async run(session: SessionRow, req: PlaceRequestRow, o: { from: 'open' | 'payment_failed'; returnUrl: string; method: payments.MethodSelection }, by: By): Promise<PlaceOrderResult> {
    const id = session.id;
    const created: { hold?: string; redemption?: string; credit?: string } = {};
    let authorized: payments.AuthorizeResult | undefined;
    try {
      // 1. check everything again: changes are shown before anything is charged
      const det = await this.reval.detect(session);
      if (det.items.length) {
        if (o.from === 'payment_failed') session = await this.releaseHolds(session, 'Checkout changed before paying again');
        const r = await this.reval.record(session, det, by);
        const result = await this.currentResult(r.session);
        await this.finishRequest(req, r.session, result);
        return result;
      }
      session = await this.reval.refresh(det, ['placing']);
      const quote = this.core.quote(session);
      const lines = (await this.core.repo.listLines(id)).filter(included).sort(byLineOrder);

      // 2. stock (all or nothing), kept from a declined attempt within the retry window
      if (!session.stock_reservation_id) {
        const wanted = new Map<string, number>();
        for (const l of lines) wanted.set(l.stock_item_id, (wanted.get(l.stock_item_id) ?? 0) + l.quantity);
        try {
          const minutes = Number(await this.ctx.settings.get('stockHoldMinutes')) || 15;
          const hold = await this.ctx.use('inventory').hold(`checkout:${id}:${req.id}`, [...wanted].map(([stockItemId, quantity]) => ({ stockItemId, quantity })), minutes);
          created.hold = hold.id;
          session = await this.core.repo.updateSession(id, { stock_reservation_id: hold.id });
        } catch (err) {
          if (!isStockError(err)) throw err;
          return this.stockChanged(session, req, err as AppError, by);
        }
      }

      // 3. discounts: budgets, usage and deal stock held while the payment runs
      const hasDiscounts = Object.values(quote.lineAllocations).some((a) => a.length) || Object.values(quote.shippingDiscounts).some((v) => v > 0);
      const promo = this.ctx.tryUse('promotions');
      if (promo && quote.evaluation && hasDiscounts) {
        try {
          const r = await promo.reserveRedemption(quote.evaluation.id, id);
          if (r.reservationId !== session.redemption_reservation_id) created.redemption = r.reservationId;
          session = await this.core.repo.updateSession(id, { redemption_reservation_id: r.reservationId });
        } catch (err) {
          if (!isAppError(err) || err.status >= 500) throw err;
          return this.discountRefused(session, req, err, by, created);
        }
      }

      // 4. store credit (phase 3)
      const credit = quote.totals.creditApplied.amount;
      if (credit > 0 && session.customer_id && !session.credit_hold_id) {
        const wallet = this.ctx.tryUse('wallet');
        if (wallet) {
          try {
            const h = await wallet.holdCredit(session.customer_id, id, quote.totals.creditApplied, `${id}:${req.id}`);
            created.credit = h.id;
            session = await this.core.repo.updateSession(id, { credit_hold_id: h.id });
          } catch (err) {
            if (isAppError(err) && err.code === 'INSUFFICIENT_CREDIT') throw this.core.error('INSUFFICIENT_CREDIT', 'Your store credit is lower than the amount applied. Update the credit step.');
            throw err;
          }
        }
      }

      // 5. authorize (one attempt number per try; the same key returns the first result)
      session = await this.core.repo.updateSession(id, { attempt_count: session.attempt_count + 1 });
      const attemptNo = session.attempt_count;
      const account = this.core.account(session);
      try {
        authorized = await this.ctx.use('payments').authorize(
          {
            checkoutSessionId: id,
            attemptNo,
            customerId: session.customer_id,
            guestEmail: session.customer_id ? null : account.email,
            amount: quote.totals.total,
            method: o.method,
            creditHoldId: session.credit_hold_id,
            creditAmount: credit > 0 ? quote.totals.creditApplied : null,
            description: `Marketly order, ${plural(quote.totals.itemCount, 'item')}`,
            returnUrl: o.returnUrl,
          },
          `${id}:${attemptNo}`,
        );
      } catch (err) {
        if (isAppError(err) && err.code === 'PAYMENT_METHOD_INVALID') throw this.core.error('PAYMENT_METHOD_INVALID', err.message, err.details);
        throw err;
      }
      await this.core.repo.updatePlaceRequest(req.id, { payment_intent_id: authorized.intentId });
      session = await this.savePayment(id, { intentId: authorized.intentId, intentState: authorized.state, methodLabel: authorized.methodLabel, decline: authorized.decline ?? null });
      await this.core.log(id, `Payment ${authorized.state.replace('_', ' ')}`, `Attempt ${attemptNo}, ${authorized.methodLabel}`);

      // 6. the outcome
      session = await this.outcome(session, authorized, by);
      const result = await this.currentResult(session);
      await this.finishRequest(req, session, result);
      return result;
    } catch (err) {
      await this.undo(session, req, o.from, created, authorized);
      throw err;
    }
  }

  /** Something failed before a result could be given: the claim is undone and holds made by this try released */
  private async undo(session: SessionRow, req: PlaceRequestRow, from: 'open' | 'payment_failed', created: { hold?: string; redemption?: string; credit?: string }, authorized?: payments.AuthorizeResult) {
    try {
      const current = (await this.core.repo.getSession(session.id))!;
      if (authorized && (authorized.state === 'accepted' || authorized.state === 'pending_check') && !current.order_id) {
        await this.core.optional('payments.voidIntent', () => this.ctx.use('payments').voidIntent(authorized.intentId, 'The order could not be created'));
      }
      if (created.hold) await this.core.optional('inventory.releaseHold', () => this.ctx.use('inventory').releaseHold(created.hold!, 'Place order failed'));
      if (created.redemption) await this.core.optional('promotions.releaseRedemption', () => this.ctx.tryUse('promotions')!.releaseRedemption(created.redemption!));
      if (created.credit) await this.core.optional('wallet.releaseHold', () => this.ctx.tryUse('wallet')!.releaseHold(created.credit!));
      if (current.status === 'placing') {
        await this.core.repo.updateSession(session.id, {
          status: from,
          ...(created.hold ? { stock_reservation_id: null } : {}),
          ...(created.redemption ? { redemption_reservation_id: null } : {}),
          ...(created.credit ? { credit_hold_id: null } : {}),
          updated_at: this.now(),
        });
      }
      await this.core.repo.deletePlaceRequest(req.id);
    } catch (err) {
      this.ctx.log.error({ err, sessionId: session.id }, 'checkout: could not undo a failed Place order');
    }
  }

  /** inventory refused the hold: the short lines become changes */
  private async stockChanged(session: SessionRow, req: PlaceRequestRow, err: AppError, by: By): Promise<PlaceOrderResult> {
    const short = ((err.details as { lines?: { stockItemId: string; requested: number; available: number }[] })?.lines ?? []);
    const det = await this.reval.detect(session);
    if (!det.items.length) {
      // the hold saw less stock than availability did a moment ago: report the short lines from the hold
      const lines = (await this.core.repo.listLines(session.id)).filter(included);
      const q = this.core.quote(session);
      const cur = session.currency;
      for (const s of short) {
        const l = lines.find((x) => x.stock_item_id === s.stockItemId);
        if (!l) continue;
        const kind = s.available > 0 ? 'quantity_reduced' : 'out_of_stock';
        const info = this.views.info(q, l.id);
        det.items.push({
          change: {
            id: newId(),
            kind,
            lineId: l.id,
            packageKey: l.package_key,
            headline: kind === 'out_of_stock' ? 'Out of stock' : 'Less stock available',
            title: info.title,
            image: info.image,
            sellerName: info.seller.name,
            previous: `Quantity ${l.quantity}`,
            current: s.available > 0 ? `Only ${s.available} available` : 'Out of stock',
            previousAmount: null,
            currentAmount: null,
            availableQuantity: s.available,
            detail: null,
            alternatives: [],
            choices: kind === 'out_of_stock' ? ['remove'] : ['reduce_quantity', 'remove'],
            defaultChoice: kind === 'out_of_stock' ? 'remove' : 'reduce_quantity',
            effectOnTotal: m(-(l.quantity - s.available) * l.unit_price, cur),
          },
          apply: { available: s.available, maxQuantity: s.available },
        } satisfies StoredChange);
        det.newTotal -= (l.quantity - s.available) * l.unit_price;
      }
      det.partialOrder = true;
    }
    const r = await this.reval.record(session, det, by);
    const result = await this.currentResult(r.session);
    await this.finishRequest(req, r.session, result);
    return result;
  }

  /** promotions refused the reservation (budget, usage limit, deal sold out): the discounts become changes */
  private async discountRefused(session: SessionRow, req: PlaceRequestRow, err: AppError, by: By, created: { hold?: string }): Promise<PlaceOrderResult> {
    if (created.hold) {
      await this.core.optional('inventory.releaseHold', () => this.ctx.use('inventory').releaseHold(created.hold!, 'Discount no longer available'));
      session = await this.core.repo.updateSession(session.id, { stock_reservation_id: null });
    }
    const q = this.core.quote(session);
    const cur = session.currency;
    const det = await this.reval.detect(session);
    if (!det.items.length) {
      for (const c of q.coupons.filter((x) => x.status === 'applied')) {
        det.items.push({
          change: {
            id: newId(),
            kind: 'coupon_no_longer_applies',
            lineId: null,
            packageKey: null,
            headline: 'Coupon no longer applies',
            title: `Coupon ${c.code}`,
            image: null,
            sellerName: '',
            previous: `-${c.amount ? c.amount.amount : 0}`,
            current: 'No discount',
            previousAmount: c.amount ?? null,
            currentAmount: m(0, cur),
            availableQuantity: null,
            detail: err.message,
            alternatives: [],
            choices: ['keep_without_discount'],
            defaultChoice: 'keep_without_discount',
            effectOnTotal: m(c.amount?.amount ?? 0, cur),
          },
          apply: { couponCode: c.code },
        });
        det.newTotal += c.amount?.amount ?? 0;
      }
      if (!det.items.length) throw err;
    }
    const r = await this.reval.record(session, det, by);
    const result = await this.currentResult(r.session);
    await this.finishRequest(req, r.session, result);
    return result;
  }

  /** The authorization result moves the session on */
  private async outcome(session: SessionRow, auth: payments.AuthorizeResult, by: By): Promise<SessionRow> {
    switch (auth.state) {
      case 'accepted':
      case 'pending_check':
        return this.finishWithOrder(session, { intentId: auth.intentId, state: auth.state, methodLabel: auth.methodLabel }, by);
      case 'failed':
        return this.failPayment(session, auth.decline ?? null, by);
      case 'requires_action': {
        const t = await this.transition(session.id, ['placing'], 'require_action');
        return t.session;
      }
    }
  }

  /* ================================================================ accepted or pending: the order */

  orderInput(session: SessionRow, lines: LineRow[], packages: PackageRow[], intent: { intentId: string; methodLabel: string }, policyVersions: orders.AcceptedPolicyVersion[], orderKey: string): orders.OrderCreateInput {
    const cur = session.currency;
    const q = this.core.quote(session);
    const account = this.core.account(session);
    const address = this.core.address(session)!;
    const keys = [...new Set(lines.map((l) => l.package_key))];
    const pkgs = new Map(packages.map((p) => [p.package_key, p]));
    const returnsPolicy = policyVersions.find((p) => p.policyKey === 'returns')?.versionId ?? null;
    const groups: orders.OrderGroupInput[] = keys.map((key) => {
      const pl = lines.filter((l) => l.package_key === key);
      const info = this.views.info(q, pl[0]!.id);
      const pkg = pkgs.get(key);
      const opt = pkg?.selected_option as shipping.DeliveryOption | null;
      const idx = q.totals.shippingByPackage.findIndex((s) => s.packageKey === key);
      const t = q.totals.perPackage[idx]!;
      const shares = allocate(t.shipping, pl.map((l) => Math.max(1, l.unit_price * l.quantity)));
      const now = this.now();
      return {
        key,
        ownerType: pl[0]!.owner_type as 'official' | 'seller',
        sellerId: pl[0]!.owner_type === 'official' ? null : pl[0]!.seller_id,
        shipsFrom: pkg?.ships_from || info.dispatch.shipsFrom,
        fulfilledBy: pl[0]!.owner_type === 'official' ? 'official_warehouse' : 'seller',
        delivery: {
          methodName: opt?.methodName ?? 'Standard',
          carrier: opt?.carrierService ?? null,
          service: opt?.methodCode ?? null,
          price: opt ? (opt.free ? m(0, cur) : opt.price) : m(0, cur),
          free: opt ? opt.free || t.shipping.amount === 0 : t.shipping.amount === 0,
          fundedBy: opt?.fundedBy ?? 'customer',
          arrival: opt?.arrival ?? { from: now.toISOString().slice(0, 10), to: now.toISOString().slice(0, 10) },
          dispatchBy: opt?.dispatchBy ?? now.toISOString(),
        },
        returnTermsSummary: pkg?.return_terms ?? info.returnTerms.summary,
        items: pl.map((l, j) => {
          const li = this.views.info(q, l.id);
          return {
            offerId: l.offer_id,
            variantId: l.variant_id,
            stockItemId: l.stock_item_id,
            quantity: l.quantity,
            unitPrice: m(l.unit_price, cur),
            discounts: (q.lineAllocations[l.id] ?? []).map((a) => ({ code: a.code ?? null, label: a.label, amount: a.amount, fundedBy: a.platformPart.amount > 0 && a.sellerPart.amount > 0 ? 'shared' : a.sellerPart.amount > 0 ? 'seller' : 'platform', campaignId: a.campaignId })),
            shippingShare: shares[j]!,
            taxShare: m(l.tax, cur),
            returnTerms: { ...li.returnTerms, policyVersionId: returnsPolicy },
            checkoutLineId: l.id,
          };
        }),
        totals: { items: t.items, discounts: t.discounts, shipping: t.shipping, tax: t.tax, total: t.total },
      };
    });
    const sum = (f: (g: orders.OrderGroupInput) => number) => m(groups.reduce((s, g) => s + f(g), 0), cur);
    return {
      checkoutSessionId: orderKey,
      contact: { kind: account.kind, customerId: session.customer_id, name: account.name ?? address.name, email: account.email!, phone: account.phone ?? address.phone ?? null },
      channel: (session.channel as 'web' | 'android' | null) ?? 'web',
      currency: cur,
      deliveryAddress: address,
      giftNote: session.gift_note,
      hidePricesOnSlip: account.hidePricesOnSlip,
      policyVersions,
      couponCodes: q.coupons.filter((c) => c.status === 'applied').map((c) => c.code),
      paymentIntentId: intent.intentId,
      paymentState: 'pending_check',
      paymentMethodLabel: intent.methodLabel,
      groups,
      totals: { items: sum((g) => g.totals.items.amount), discounts: sum((g) => g.totals.discounts.amount), shipping: sum((g) => g.totals.shipping.amount), tax: sum((g) => g.totals.tax.amount), total: sum((g) => g.totals.total.amount) },
    };
  }

  /**
   * The order for an accepted or pending payment. Every step is idempotent, so the synchronous path and
   * the payments event may both run it; only the status transition decides who publishes.
   */
  async finishWithOrder(session: SessionRow, intent: { intentId: string; state: 'accepted' | 'pending_check'; methodLabel: string }, by: By): Promise<SessionRow> {
    const id = session.id;
    const [lines0, packages] = await Promise.all([this.core.repo.listLines(id), this.core.repo.listPackages(id)]);
    const lines = lines0.filter(included).sort(byLineOrder);
    const policyVersions = await this.views.policyVersions();
    const pay = this.core.payment(session);
    const orderKey = pay.cancelledOrders.length ? stableUuid(`${id}:order:${pay.cancelledOrders.length}`) : id;
    const order = await this.ctx.use('orders').createOrder(this.orderInput(session, lines, packages, intent, policyVersions, orderKey));
    session = await this.core.repo.updateSession(id, { order_id: order.id, order_ref: order.ref, updated_at: this.now() });

    // order items per checkout line (one included line per offer)
    const items = order.groups.flatMap((g) => g.items);
    const itemByLine: Record<string, string> = {};
    const used = new Set<string>();
    for (const l of lines) {
      const it = items.find((i) => i.offer.offerId === l.offer_id && !used.has(i.id));
      if (!it) continue;
      used.add(it.id);
      itemByLine[l.id] = it.id;
    }
    const soft = async (what: string, call: () => Promise<unknown>) => {
      try {
        await call();
      } catch (err) {
        this.ctx.log.warn({ err, sessionId: id, orderId: order.id, what }, 'checkout: a step after the order was created failed');
      }
    };
    const promo = this.ctx.tryUse('promotions');
    if (promo && session.redemption_reservation_id) await soft('promotions.commitRedemption', () => promo.commitRedemption(session.redemption_reservation_id!, order.id, itemByLine));
    if (session.stock_reservation_id) {
      await soft('inventory.attachOrder', () => this.ctx.use('inventory').attachOrder(session.stock_reservation_id!, order.id, lines.filter((l) => itemByLine[l.id]).map((l) => ({ stockItemId: l.stock_item_id, orderItemId: itemByLine[l.id]! }))));
    }
    await soft('payments.linkOrder', () =>
      this.ctx.use('payments').linkOrder(
        intent.intentId,
        order.id,
        order.groups.map((g) => ({ groupId: g.id, ownerType: g.seller.ownerType, sellerId: g.seller.id ?? null, amount: g.totals.total })),
      ),
    );
    if (intent.state === 'accepted') {
      await soft('orders.acceptOrder', () => this.ctx.use('orders').acceptOrder(order.id, intent.intentId));
      const wallet = this.ctx.tryUse('wallet');
      if (wallet && session.credit_hold_id) await soft('wallet.captureHold', () => wallet.captureHold(session.credit_hold_id!, order.id));
    } else if (session.stock_reservation_id) {
      const hours = Number(await this.ctx.settings.get('pendingHoldHours')) || 24;
      await soft('inventory.extendHold', () => this.ctx.use('inventory').extendHold(session.stock_reservation_id!, new Date(this.now().getTime() + hours * 3600_000).toISOString()));
    }
    const q = this.core.quote(session);
    if (session.source === 'cart' && session.cart_id) {
      const purchased = lines.map((l) => l.cart_item_id).filter((x): x is string => Boolean(x));
      if (purchased.length) await soft('cart.removePurchasedItems', () => this.ctx.use('cart').removePurchasedItems(session.cart_id!, purchased, order.id));
    }
    const account = this.core.account(session);
    const identity = this.ctx.tryUse('identity');
    if (!session.customer_id && session.guest_session_id && identity) await soft('identity.grantGuestOrderAccess', () => identity.grantGuestOrderAccess(session.guest_session_id!, order.id, account.email!, 'checkout'));

    const t = await this.transition(id, ['placing', 'awaiting_action'], intent.state === 'accepted' ? 'payment_accepted' : 'payment_uncertain', { hold_until: null });
    if (t.won) {
      await this.core.log(id, intent.state === 'accepted' ? 'Order placed' : 'Order placed, payment being checked', `${order.ref}`);
      this.core.publish('checkout.session.completed', { sessionId: id, orderId: order.id, orderRef: order.ref, paymentState: intent.state, total: q.totals.total, guest: account.kind === 'guest', createAccountAfter: account.createAccountAfter, email: account.email! }, by);
    }
    return t.session;
  }

  /** Declined: no order; lines, choices, coupons and holds are kept until holdUntil */
  async failPayment(session: SessionRow, decline: payments.Decline | null, by: By): Promise<SessionRow> {
    const minutes = Number(await this.ctx.settings.get('retryWindowMinutes')) || 30;
    const holdUntil = new Date(this.now().getTime() + minutes * 60_000);
    const t = await this.transition(session.id, ['placing', 'awaiting_action', 'payment_pending'], 'payment_declined', { hold_until: holdUntil });
    if (!t.won) return t.session;
    await this.savePayment(session.id, { intentState: 'failed', decline });
    if (t.session.stock_reservation_id) {
      await this.core.optional('inventory.extendHold', () => this.ctx.use('inventory').extendHold(t.session.stock_reservation_id!, holdUntil.toISOString()));
    }
    await this.core.log(session.id, 'Payment declined', `${decline?.message ?? 'Declined'}${by.actor.kind === 'system' ? ' (payment check)' : ''}`);
    return (await this.core.repo.getSession(session.id))!;
  }

  /* ================================================================ bank challenge */

  async completeAction(owner: Owner | null, id: string, resultToken: string, key: string, by: By): Promise<PlaceOrderResult> {
    let session = await this.core.load(owner, id);
    const { hash, replay } = await this.replayed(session, 'complete_action', key, { resultToken });
    if (replay) return replay;
    if (session.status === 'expired') throw this.core.error('SESSION_EXPIRED', 'This checkout expired. Start again from your cart; nothing was charged.');
    if (['completed', 'payment_pending', 'payment_failed', 'placing'].includes(session.status)) return this.answered(session, 'complete_action', key, hash, await this.currentResult(session));
    if (session.status !== 'awaiting_action') checkoutSessionMachine.next(session.status as Status, 'payment_accepted');
    const pay = this.core.payment(session);
    const req = await this.core.repo.insertPlaceRequest({ id: newId(), session_id: id, idempotency_key: key, request_hash: hash, kind: 'complete_action', outcome: null, response: { quoteVersion: session.quote_version, total: this.core.quote(session).totals.total.amount } as never, payment_intent_id: pay.intentId, created_at: this.now(), completed_at: null });
    if (!req) return (await this.replayed(session, 'complete_action', key, { resultToken })).replay ?? this.currentResult(session);
    try {
      const auth = await this.ctx.use('payments').completeAction(pay.intentId!, resultToken, `${id}:${key}`);
      session = await this.savePayment(id, { intentId: auth.intentId, intentState: auth.state, methodLabel: auth.methodLabel, decline: auth.decline ?? null });
      if (auth.state === 'accepted' || auth.state === 'pending_check') session = await this.finishWithOrder(session, { intentId: auth.intentId, state: auth.state, methodLabel: auth.methodLabel }, by);
      else if (auth.state === 'failed') session = await this.failPayment(session, auth.decline ?? null, by);
      const result = await this.currentResult(session);
      await this.finishRequest(req, session, result);
      return result;
    } catch (err) {
      await this.core.repo.deletePlaceRequest(req.id);
      throw err;
    }
  }

  /* ================================================================ holds */

  /** Releases stock, discount and credit holds (abandon, expiry, a changed checkout) */
  async releaseHolds(session: SessionRow, reason: string): Promise<SessionRow> {
    if (session.stock_reservation_id) {
      const holdId = session.stock_reservation_id;
      try {
        await this.ctx.use('inventory').releaseHold(holdId, reason);
      } catch (err) {
        if (!isAppError(err) || err.status >= 500) throw err;
        this.ctx.log.info({ err, holdId }, 'checkout: stock hold already gone');
      }
    }
    const promo = this.ctx.tryUse('promotions');
    if (promo && session.redemption_reservation_id) await this.core.optional('promotions.releaseRedemption', () => promo.releaseRedemption(session.redemption_reservation_id!));
    const wallet = this.ctx.tryUse('wallet');
    if (wallet && session.credit_hold_id) await this.core.optional('wallet.releaseHold', () => wallet.releaseHold(session.credit_hold_id!));
    if (!session.stock_reservation_id && !session.redemption_reservation_id && !session.credit_hold_id) return session;
    return this.core.repo.updateSession(session.id, { stock_reservation_id: null, redemption_reservation_id: null, credit_hold_id: null });
  }

  /* ================================================================ payments and orders events */

  private async sessionOfPayment(checkoutSessionId: string, orderId: string | null | undefined): Promise<SessionRow | undefined> {
    return (await this.core.repo.getSession(checkoutSessionId)) ?? (orderId ? await this.core.repo.findSessionByOrder(orderId) : undefined);
  }

  async onAuthorized(e: EventPayload<'payments.payment.authorized'>) {
    const s = await this.sessionOfPayment(e.checkoutSessionId, e.orderId);
    if (!s) return this.ctx.log.info({ intentId: e.intentId }, 'checkout: authorized payment of an unknown checkout');
    const pay = this.core.payment(s);
    if (pay.intentId && pay.intentId !== e.intentId) return; // an older attempt
    if (s.status === 'awaiting_action') {
      await this.savePayment(s.id, { intentId: e.intentId, intentState: 'accepted', methodLabel: e.methodLabel });
      await this.finishWithOrder((await this.core.repo.getSession(s.id))!, { intentId: e.intentId, state: 'accepted', methodLabel: e.methodLabel }, SYSTEM);
      return;
    }
    if (s.status !== 'payment_pending') return;
    const t = await this.transition(s.id, ['payment_pending'], 'payment_accepted');
    if (!t.won) return;
    await this.savePayment(s.id, { intentState: 'accepted', methodLabel: e.methodLabel, decline: null });
    if (t.session.order_id) {
      try {
        await this.ctx.use('orders').acceptOrder(t.session.order_id, e.intentId);
      } catch (err) {
        this.ctx.log.warn({ err, orderId: t.session.order_id }, 'checkout: orders could not accept the order yet (it does so on the same event)');
      }
    }
    const wallet = this.ctx.tryUse('wallet');
    if (wallet && t.session.credit_hold_id && t.session.order_id) await this.core.optional('wallet.captureHold', () => wallet.captureHold(t.session.credit_hold_id!, t.session.order_id!));
    await this.core.log(s.id, 'Payment accepted', `${e.methodLabel}; order ${t.session.order_ref ?? ''}`.trim());
  }

  async onFailed(e: EventPayload<'payments.payment.failed'>) {
    const s = await this.sessionOfPayment(e.checkoutSessionId, e.orderId);
    if (!s) return this.ctx.log.info({ intentId: e.intentId }, 'checkout: failed payment of an unknown checkout');
    const pay = this.core.payment(s);
    if (pay.intentId && pay.intentId !== e.intentId) return;
    const decline: payments.Decline = { code: '', category: (e.declineCategory as payments.Decline['category']) || 'card_declined', message: 'Your bank declined the payment. Nothing was charged.', advice: 'Try again with another card or a digital wallet.', retryable: true };
    if (s.status === 'awaiting_action') {
      await this.failPayment(s, decline, SYSTEM);
      return;
    }
    if (s.status === 'payment_pending') await this.declinedAfterPending(s, decline);
  }

  async onOrderCancelled(e: EventPayload<'orders.order.cancelled'>) {
    if (e.reason !== 'payment_declined') return;
    const s = (await this.core.repo.findSessionByOrder(e.orderId)) ?? (await this.core.repo.getSession(e.checkoutSessionId));
    if (!s || s.status !== 'payment_pending' || s.order_id !== e.orderId) return;
    await this.declinedAfterPending(s, { code: '', category: 'card_declined', message: 'Your bank declined the payment, so the order was cancelled. Nothing was charged.', advice: 'Pay again with another card or a digital wallet.', retryable: true });
  }

  /** A pending payment was finally declined: orders cancels the order, the lines go back to the cart and a retry makes a new order */
  private async declinedAfterPending(s: SessionRow, decline: payments.Decline) {
    const minutes = Number(await this.ctx.settings.get('retryWindowMinutes')) || 30;
    const holdUntil = new Date(this.now().getTime() + minutes * 60_000);
    const orderId = s.order_id;
    const orderRef = s.order_ref;
    const pay = this.core.payment(s);
    const t = await this.transition(s.id, ['payment_pending'], 'payment_declined', {
      hold_until: holdUntil,
      order_id: null,
      order_ref: null,
      payment_selection: { ...pay, intentState: 'failed', decline, cancelledOrders: orderId ? [...pay.cancelledOrders, { orderId, ref: orderRef ?? '' }] : pay.cancelledOrders } as never,
    });
    if (!t.won) return;
    if (orderId) {
      try {
        await this.ctx.use('orders').cancelForDeclinedPayment(orderId);
      } catch (err) {
        this.ctx.log.warn({ err, orderId }, 'checkout: orders could not cancel the declined order (it does so on the same event)');
      }
    }
    // the hold belongs to the cancelled order: a retry holds the stock again
    await this.releaseHolds(t.session, 'Pending payment declined');
    if (t.session.source === 'cart' && t.session.cart_id) {
      const lines = (await this.core.repo.listLines(s.id)).filter(included);
      try {
        await this.ctx.use('cart').restoreItems(
          t.session.cart_id,
          lines.map((l) => ({ offerId: l.offer_id, quantity: l.quantity, acceptedUnitPrice: m(l.unit_price, t.session.currency) })),
        );
      } catch (err) {
        this.ctx.log.warn({ err, sessionId: s.id }, 'checkout: could not restore the lines to the cart');
      }
    }
    await this.core.log(s.id, 'Pending payment declined', `Order ${orderRef ?? ''} cancelled; items back in the cart`);
  }

  /** Job: payments' pending check may have finished while no event reached checkout */
  async reconcilePending(s: SessionRow) {
    const pay = this.core.payment(s);
    if (!pay.intentId) return;
    const status = await this.core.optional('payments.getIntentStatus', () => this.ctx.use('payments').getIntentStatus(pay.intentId!, false));
    if (status?.state === 'accepted') await this.onAuthorized({ intentId: pay.intentId, checkoutSessionId: s.id, orderId: s.order_id, amount: status.amount, methodLabel: status.methodLabel, at: this.now().toISOString() });
    else if (status?.state === 'failed') await this.declinedAfterPending(s, status.decline ?? { code: '', category: 'card_declined', message: 'Your bank declined the payment. Nothing was charged.', advice: 'Pay again with another card.', retryable: true });
  }
}
