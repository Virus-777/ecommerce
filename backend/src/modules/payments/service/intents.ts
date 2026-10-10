/**
 * Payment intents: one per checkout payment attempt. Authorization (with bank challenges and uncertain results
 * resolved only by asking the provider), linking to the order with seller-group allocations, captures (whole
 * order on acceptance or per seller group on dispatch), voids, orphan detection and authorization expiry.
 *
 * Money safety: every provider call carries an idempotency key derived from the intent (intent:authorize,
 * intent:capture:…), captures are rows unique by key, and an uncertain answer is never followed by a second
 * charge: the intent waits in pending_check until the provider is asked (job, webhook, Check now).
 */
import { AppError } from '../../../kernel/errors/index.js';
import { newId } from '../../../kernel/lib/ids.js';
import type * as common from '../../../spec/common.js';
import type { Allocation, AuthorizeInput, AuthorizeResult, PaymentDetail, PaymentStatusView, Tender } from '../../../spec/payments.js';
import { paymentIntentMachine } from '../domain/state-machines.js';
import { ACCEPTED, DAY, ENDED, HOUR, MINUTE, PENDING, checkBackoffMs, declineOf, is, isExpired, methodLabel, type IntentStatus } from '../domain/rules.js';
import { ProviderError, type AllocationRec, type CaptureRec, type CardDetails, type IntentRec, type PaymentsRepository, type ProviderCapture, type ProviderPayment, type StoredMethod } from '../ports.js';
import { Batch, SYSTEM, illegal, invalid, notFound, type By, type Cfg, type Core, type Lookup, type OrderInfo } from './core.js';
import { CANCELLED_KEY, EXCESS_KEY, itemKey, type Credit } from './credit.js';
import type { Views } from './views.js';

type Ev = Parameters<typeof paymentIntentMachine.next>[1];

const LIVE: IntentStatus[] = [...PENDING, ...ACCEPTED];
const randomRef = () => `PAY-${newId().replace(/-/g, '').slice(-8).toUpperCase()}`;

export class Intents {
  /** Set by the service: refunds start orphan refunds */
  startOrphanRefund!: (intent: IntentRec, by: By, reason: string) => Promise<unknown>;

  constructor(
    private readonly core: Core,
    private readonly views: Views,
    private readonly credit: Credit,
  ) {}

  private get repo() {
    return this.core.repo;
  }

  private m = (amount: number, currency: string): common.Money => ({ amount, currency });

  async get(intentId: string): Promise<IntentRec> {
    const i = await this.repo.get('intents', intentId);
    if (!i) throw notFound();
    return i;
  }

  /* ---------------------------------------------------------------- authorize */

  resultOf(i: IntentRec): AuthorizeResult {
    const state: AuthorizeResult['state'] = is(ACCEPTED, i.status) ? 'accepted' : is(ENDED, i.status) ? 'failed' : i.status === 'requires_action' ? 'requires_action' : 'pending_check';
    return { intentId: i.id, state, decline: state === 'failed' ? i.decline : null, nextAction: state === 'requires_action' ? (i.method.pendingAction ?? null) : null, methodLabel: i.method.label };
  }

  async authorize(input: AuthorizeInput, idempotencyKey: string): Promise<AuthorizeResult> {
    if (!idempotencyKey?.trim()) throw invalid([{ path: 'idempotencyKey', message: 'An idempotency key is required' }]);
    const known = (await this.repo.find('intents', { idempotency_key: idempotencyKey }))[0];
    if (known) return this.resultOf(known);
    const active = (await this.repo.find('intents', { checkout_session_id: input.checkoutSessionId, status: LIVE }))[0];
    if (active) return this.resultOf(active); // one live intent per checkout session: a double submit never authorizes twice

    const cfg = await this.core.cfg();
    const amount = input.amount;
    const credit = input.creditAmount?.amount ?? 0;
    if (!Number.isSafeInteger(amount.amount) || amount.amount <= 0) throw invalid([{ path: 'amount', message: 'The amount must be more than zero' }]);
    if (input.creditAmount && input.creditAmount.currency !== amount.currency) throw invalid([{ path: 'creditAmount', message: 'Store credit must be in the order currency' }]);
    if (credit < 0 || credit > amount.amount) throw invalid([{ path: 'creditAmount', message: 'Store credit cannot be more than the amount' }]);
    if (credit > 0 && !input.creditHoldId) throw invalid([{ path: 'creditHoldId', message: 'Store credit needs a wallet hold' }]);
    const cardAmount = amount.amount - credit;

    const { card, source, savedMethodId } = await this.resolveMethod(input, cfg, cardAmount > 0);
    const snapshot: StoredMethod = card
      ? { kind: card.kind, brand: card.brand, last4: card.last4, expMonth: card.expMonth, expYear: card.expYear, wallet: card.wallet ?? null, label: methodLabel(card), savedMethodId }
      : { kind: 'store_credit', label: 'Marketly store credit', savedMethodId: null };
    const tenders: Tender[] = [
      ...(cardAmount > 0 ? [{ kind: (card?.kind ?? 'card') as Tender['kind'], amount: this.m(cardAmount, amount.currency) }] : []),
      ...(credit > 0 ? [{ kind: 'store_credit' as const, amount: this.m(credit, amount.currency), creditHoldId: input.creditHoldId ?? null }] : []),
    ];
    const now = this.core.now();
    const id = newId();
    const row: IntentRec = {
      id,
      ref: randomRef(),
      checkout_session_id: input.checkoutSessionId,
      attempt_no: input.attemptNo,
      order_id: null,
      customer_id: input.customerId ?? null,
      guest_email: input.customerId ? null : (input.guestEmail ?? null),
      amount: amount.amount,
      currency: amount.currency,
      tenders,
      method: snapshot,
      provider: this.core.provider.code,
      provider_ref: null,
      status: paymentIntentMachine.next('created', 'submit'),
      decline: null,
      authorized_amount: 0,
      captured_amount: 0,
      refunded_amount: 0,
      authorized_at: null,
      captured_at: null,
      authorization_expires_at: null,
      last_checked_at: null,
      next_check_at: null,
      check_attempts: 0,
      orphan: false,
      idempotency_key: idempotencyKey,
      created_at: now,
      updated_at: now,
    };
    for (let attempt = 0; ; attempt++) {
      const inserted = await this.repo.insertIfNew('intents', row);
      if (inserted) break;
      // the same key or another live intent of the session won a race
      const winner = (await this.repo.find('intents', { idempotency_key: idempotencyKey }))[0] ?? (await this.repo.find('intents', { checkout_session_id: input.checkoutSessionId, status: LIVE }))[0];
      if (winner) return this.resultOf(winner);
      if (attempt >= 2) throw new AppError('CONFLICT', 'Another payment for this checkout is being processed');
      row.ref = randomRef(); // PAY- reference collision: draw another
    }

    if (cardAmount === 0) {
      // fully paid with store credit (phase 3): nothing to ask a card processor
      const after = await this.applyPayment(id, { status: 'authorized', authorizedAmount: 0 }, { by: { actor: SYSTEM }, cfg });
      return this.resultOf(after);
    }

    let result: ProviderPayment;
    try {
      result = await this.core.call(
        'authorize',
        { intentId: id },
        () =>
          this.core.provider.authorize({
            amount: this.m(cardAmount, amount.currency),
            source,
            idempotencyKey: `${id}:authorize`,
            description: input.description,
            statementDescriptor: cfg.statementDescriptor,
            returnUrl: input.returnUrl,
            intentId: id,
          }),
        (r) => ({ outcome: r.status === 'declined' ? 'declined' : 'ok', providerRef: r.providerRef, message: r.decline ? `Declined ${r.decline.code} (${r.decline.category})` : r.status }),
      );
    } catch (err) {
      if (err instanceof ProviderError && !err.uncertain) {
        // the provider was not reached: nothing was charged; the customer may simply try again
        result = { status: 'declined', decline: { code: 'unavailable', category: 'processing_error' } };
      } else {
        // timeout or an unexpected error after sending: the answer is uncertain, never charge again
        const after = await this.markUncertain(id, { actor: SYSTEM });
        return this.resultOf(after);
      }
    }
    const after = await this.applyPayment(id, result, { by: { actor: SYSTEM }, cfg });
    if (after.status === 'authorized' && input.method.saveForLater && input.method.kind !== 'saved_card' && input.customerId && input.method.providerToken) {
      await this.saveForLater(input.customerId, input.method.providerToken, input.method.label ?? null, input.method.billingAddress ?? null);
    }
    return this.resultOf(after);
  }

  /** Set by the service: saved methods keep a card the customer asked to save at checkout */
  saveForLater: (customerId: string, token: string, label: string | null, billing: common.Address | null) => Promise<unknown> = async () => undefined;

  private async resolveMethod(input: AuthorizeInput, cfg: Cfg, needsCard: boolean): Promise<{ card: CardDetails | null; source: { token?: string | null; methodId?: string | null }; savedMethodId: string | null }> {
    if (!needsCard) return { card: null, source: {}, savedMethodId: null };
    const sel = input.method;
    let card: CardDetails | null;
    let source: { token?: string | null; methodId?: string | null };
    let savedMethodId: string | null = null;
    if (sel.kind === 'saved_card') {
      const m = sel.savedMethodId ? await this.repo.get('saved_methods', sel.savedMethodId) : undefined;
      if (!m || m.removed_at || !input.customerId || m.customer_id !== input.customerId) throw this.core.error('PAYMENT_METHOD_INVALID', 'This saved card cannot be used. Choose another card.');
      if (isExpired(m.exp_month, m.exp_year, this.core.today())) throw this.core.error('PAYMENT_METHOD_EXPIRED');
      card = { kind: m.kind as CardDetails['kind'], brand: m.brand, last4: m.last4, expMonth: m.exp_month, expYear: m.exp_year };
      source = { methodId: m.provider_method_id };
      savedMethodId = m.id;
    } else {
      const token = sel.providerToken?.trim();
      if (!token) throw this.core.error('PAYMENT_METHOD_INVALID', 'Enter your card details again.');
      try {
        card = await this.core.provider.describeToken(token);
      } catch (err) {
        return this.core.unavailable(err);
      }
      if (!card) throw this.core.error('PAYMENT_METHOD_INVALID', 'These card details cannot be used. Enter them again or use another card.');
      if (sel.kind === 'digital_wallet' && card.kind !== 'digital_wallet') throw this.core.error('PAYMENT_METHOD_INVALID', 'This is not a digital wallet payment.');
      source = { token };
    }
    if (card.kind === 'digital_wallet' && !cfg.walletsEnabled) throw this.core.error('PAYMENT_METHOD_INVALID', 'Digital wallets are not available right now. Use a card.');
    if (!cfg.acceptedCardBrands.includes(card.brand.toLowerCase())) throw this.core.error('PAYMENT_METHOD_INVALID', `We don't accept this card brand. Use ${cfg.acceptedCardBrands.join(', ')}.`);
    return { card, source, savedMethodId };
  }

  /**
   * Applies the provider's record of a payment through the state machine (authorize answer, bank challenge
   * result, status check, webhook). Never moves a record backwards; publishes after the commit.
   */
  async applyPayment(intentId: string, p: ProviderPayment, o: { by: By; cfg?: Cfg; checked?: boolean }): Promise<IntentRec> {
    const cfg = o.cfg ?? (await this.core.cfg());
    const batch = new Batch();
    let releaseHold: string | null = null;
    const pre = await this.repo.get('intents', intentId);
    const who = pre ? await this.core.contactOf(pre) : { customerId: null, contactEmail: null };
    const after = await this.repo.transaction(async (tx) => {
      const i = await tx.get('intents', intentId, { forUpdate: true });
      if (!i) throw notFound();
      const now = this.core.now();
      const patch: Partial<IntentRec> = { updated_at: now };
      if (p.providerRef && !i.provider_ref) patch.provider_ref = p.providerRef;
      if (o.checked) {
        patch.last_checked_at = now;
        patch.check_attempts = i.check_attempts + 1;
      }
      let status = i.status as IntentStatus;
      const step = (event: Ev) => {
        status = paymentIntentMachine.next(status as never, event) as IntentStatus;
      };
      const wasPending = status === 'pending_check';
      switch (p.status) {
        case 'authorized':
        case 'captured': {
          if (status === 'requires_action') step('complete_action');
          if (status !== 'authorizing' && status !== 'pending_check') break;
          step(status === 'authorizing' ? 'approve' : p.status === 'captured' ? 'confirm_captured' : 'confirm_approved');
          const authorized = p.authorizedAmount || this.cardAmount(i);
          Object.assign(patch, {
            authorized_amount: authorized,
            authorized_at: now,
            authorization_expires_at: new Date(now.getTime() + cfg.authorizationValidDays * DAY),
            decline: null,
            next_check_at: null,
            method: { ...i.method, pendingAction: null },
          });
          batch.push('payments.payment.authorized', { intentId: i.id, checkoutSessionId: i.checkout_session_id, orderId: i.order_id, amount: this.m(authorized, i.currency), methodLabel: i.method.label, at: now.toISOString() });
          if ((status as IntentStatus) === 'captured') {
            // the provider captured on its own (confirm_captured): record it as one whole-payment capture
            const captured = p.capturedAmount || authorized;
            // a whole-payment capture: all the store credit still used goes with it (an order's only)
            const credit = i.order_id ? Math.max(0, (this.credit.tender(i)?.amount.amount ?? 0) - this.credit.outside(i)) : 0;
            const capture = await tx.insertIfNew('captures', { id: newId(), intent_id: i.id, group_id: null, amount: captured, credit_amount: credit, status: 'succeeded', provider_ref: p.providerRef ?? i.provider_ref, idempotency_key: `${i.id}:capture:provider`, at: now });
            Object.assign(patch, { captured_amount: captured, captured_at: now });
            if (capture && i.order_id) {
              const withShare: IntentRec = credit > 0 ? { ...i, tenders: this.credit.withShare(i, capture.id, { amount: credit, groupId: null }) } : i;
              if (credit > 0) patch.tenders = withShare.tenders;
              batch.push('payments.payment.captured', await this.capturedPayload(tx, withShare, capture, null, who));
            }
          }
          break;
        }
        case 'requires_action':
          if (status === 'authorizing') {
            step('require_action');
            patch.method = { ...i.method, pendingAction: p.nextAction ?? null };
            patch.next_check_at = null;
          }
          break;
        case 'declined':
        case 'not_found': {
          if (p.status === 'not_found' && status !== 'pending_check') break; // only a status check can conclude "nothing happened"
          if (status === 'requires_action') step('complete_action');
          if (status !== 'authorizing' && status !== 'pending_check') break;
          step(status === 'authorizing' ? 'decline' : 'confirm_declined');
          const d = p.decline ?? { code: 'no_record', category: 'processing_error' as const };
          patch.decline = declineOf(d.code, d.category, i.method.label);
          patch.next_check_at = null;
          patch.method = { ...i.method, pendingAction: null };
          batch.push('payments.payment.failed', { intentId: i.id, checkoutSessionId: i.checkout_session_id, orderId: i.order_id, ...who, declineCategory: d.category, afterPendingCheck: wasPending, at: now.toISOString() });
          releaseHold = i.tenders.find((t) => t.creditHoldId)?.creditHoldId ?? null;
          break;
        }
        case 'voided':
          if (status === 'authorized') {
            step('void');
            batch.push('payments.payment.voided', { intentId: i.id, checkoutSessionId: i.checkout_session_id, orderId: i.order_id, reason: 'Released at the payment provider' });
          }
          break;
      }
      if (status !== i.status) patch.status = status;
      return tx.update('intents', i.id, patch);
    });
    this.core.flush(batch, o.by);
    if (releaseHold) await this.core.soft('wallet', 'releaseHold', (w) => w.releaseHold(releaseHold!));
    return after;
  }

  private cardAmount(i: IntentRec): number {
    return i.tenders.filter((t) => t.kind !== 'store_credit').reduce((s, t) => s + t.amount.amount, 0);
  }

  /** authorizing (or a challenge being completed) → pending_check: the status-check job takes over */
  async markUncertain(intentId: string, by: By): Promise<IntentRec> {
    const batch = new Batch();
    const pre = await this.repo.get('intents', intentId);
    const who = pre ? await this.core.contactOf(pre) : { customerId: null, contactEmail: null };
    const after = await this.repo.transaction(async (tx) => {
      const i = await tx.get('intents', intentId, { forUpdate: true });
      if (!i) throw notFound();
      let status = i.status as IntentStatus;
      if (status === 'requires_action') status = paymentIntentMachine.next('requires_action', 'complete_action') as IntentStatus;
      if (status !== 'authorizing') return i;
      status = paymentIntentMachine.next('authorizing', 'timeout') as IntentStatus;
      const now = this.core.now();
      batch.push('payments.payment.pending_check', { intentId: i.id, checkoutSessionId: i.checkout_session_id, orderId: i.order_id, ...who, amount: this.m(i.amount, i.currency), since: now.toISOString() });
      return tx.update('intents', i.id, { status, next_check_at: new Date(now.getTime() + checkBackoffMs(0)), check_attempts: 0, updated_at: now, method: { ...i.method, pendingAction: null } });
    });
    this.core.flush(batch, by);
    return after;
  }

  /* ---------------------------------------------------------------- bank challenge, status checks */

  async completeAction(intentId: string, resultToken: string, idempotencyKey: string): Promise<AuthorizeResult> {
    const i = await this.get(intentId);
    if (i.status !== 'requires_action') return this.resultOf(i);
    if (!i.provider_ref) throw illegal('This payment has no bank challenge to complete');
    let result: ProviderPayment;
    try {
      result = await this.core.call(
        'authorize',
        { intentId },
        () => this.core.provider.completeAction({ providerRef: i.provider_ref!, resultToken, idempotencyKey: `${intentId}:action:${idempotencyKey}` }),
        (r) => ({ outcome: r.status === 'declined' ? 'declined' : 'ok', providerRef: r.providerRef, message: `bank challenge: ${r.status}` }),
      );
    } catch (err) {
      if (err instanceof ProviderError && !err.uncertain) return this.core.unavailable(err);
      return this.resultOf(await this.markUncertain(intentId, { actor: SYSTEM }));
    }
    if (result.status === 'requires_action') return this.resultOf(i);
    return this.resultOf(await this.applyPayment(intentId, result, { by: { actor: SYSTEM } }));
  }

  /**
   * Asks the provider for its record (Check now, the status-check job, admin check, webhooks). On no answer the
   * next check is scheduled with backoff; nothing is ever sent again.
   */
  async sync(intentId: string, by: By): Promise<IntentRec> {
    const i = await this.get(intentId);
    if (!is(PENDING, i.status) && !(i.status === 'authorized' && !i.provider_ref)) {
      await this.resolveUnknownCaptures(i, by);
      return (await this.repo.get('intents', intentId))!;
    }
    let p: ProviderPayment;
    try {
      p = await this.core.call(
        'retrieve',
        { intentId },
        () => this.core.provider.retrievePayment({ providerRef: i.provider_ref, idempotencyKey: `${i.id}:authorize` }),
        (r) => ({ outcome: 'ok', providerRef: r.providerRef, message: `status ${r.status}` }),
      );
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err;
      const now = this.core.now();
      return this.repo.update('intents', i.id, { last_checked_at: now, check_attempts: i.check_attempts + 1, next_check_at: i.status === 'pending_check' ? new Date(now.getTime() + checkBackoffMs(i.check_attempts + 1)) : i.next_check_at, updated_at: now });
    }
    if (p.status === 'requires_action' && i.status === 'requires_action') return this.repo.update('intents', i.id, { last_checked_at: this.core.now() });
    const after = await this.applyPayment(i.id, p, { by, checked: true });
    if (after.status === 'pending_check') {
      const now = this.core.now();
      return this.repo.update('intents', i.id, { next_check_at: new Date(now.getTime() + checkBackoffMs(after.check_attempts)) });
    }
    return after;
  }

  /** Provider webhooks: the event only says "look again"; the retrieved record is applied (never backwards) */
  async reconcile(intentId: string, by: By): Promise<IntentRec> {
    const i = await this.get(intentId);
    if (is(PENDING, i.status)) return this.sync(intentId, by);
    if (i.status === 'authorized' && i.provider_ref) {
      try {
        const p = await this.core.call('retrieve', { intentId }, () => this.core.provider.retrievePayment({ providerRef: i.provider_ref, idempotencyKey: `${i.id}:authorize` }), (r) => ({ outcome: 'ok', providerRef: r.providerRef, message: `status ${r.status}` }));
        if (p.status === 'voided') await this.applyPayment(i.id, p, { by });
      } catch (err) {
        if (!(err instanceof ProviderError)) throw err;
      }
    }
    await this.resolveUnknownCaptures(i, by);
    return (await this.repo.get('intents', intentId))!;
  }

  async getIntentStatus(intentId: string, refresh = false, rateLimited = false): Promise<PaymentStatusView> {
    let i = await this.get(intentId);
    if (refresh && (is(PENDING, i.status) || i.status === 'requires_action')) {
      const cfg = await this.core.cfg();
      const recent = i.last_checked_at && this.core.now().getTime() - i.last_checked_at.getTime() < cfg.storeCheckRateLimitSeconds * 1000;
      if (recent && rateLimited) throw new AppError('RATE_LIMITED', `You can check again in ${cfg.storeCheckRateLimitSeconds} seconds.`, { retryAfterSeconds: cfg.storeCheckRateLimitSeconds });
      if (!recent) i = await this.sync(intentId, { actor: SYSTEM });
    }
    return this.views.statusView(i, this.core.lookup());
  }

  /* ---------------------------------------------------------------- order link */

  private allocationsOfOrder(order: OrderInfo): Allocation[] {
    return [...order.groups.entries()].map(([groupId, g]) => ({ groupId, ownerType: g.ownerType, sellerId: g.sellerId, amount: { amount: g.total, currency: 'USD' } }));
  }

  async linkOrder(intentId: string, orderId: string, allocations: Allocation[]): Promise<void> {
    for (const a of allocations) if (!Number.isSafeInteger(a.amount.amount) || a.amount.amount < 0) throw invalid([{ path: 'allocations', message: 'Allocation amounts are whole minor units of zero or more' }]);
    await this.repo.transaction(async (tx) => {
      const i = await tx.get('intents', intentId, { forUpdate: true });
      if (!i) throw notFound();
      if (i.order_id && i.order_id !== orderId) throw new AppError('CONFLICT', 'This payment belongs to another order', { orderId: i.order_id });
      if (i.order_id !== orderId || i.orphan) await tx.update('intents', i.id, { order_id: orderId, orphan: false, updated_at: this.core.now() });
      await this.replaceAllocations(tx, i, allocations);
    });
  }

  /** Allocations of groups not captured yet follow the latest numbers; captured groups keep theirs */
  private async replaceAllocations(tx: PaymentsRepository, i: IntentRec, allocations: Allocation[]) {
    if (!allocations.length) return;
    const [current, captures] = await Promise.all([tx.find('allocations', { intent_id: i.id }), tx.find('captures', { intent_id: i.id, status: ['succeeded', 'pending', 'unknown'] })]);
    if (captures.some((c) => c.group_id === null)) {
      if (current.length) return; // the whole payment was captured with its allocations
    }
    const capturedGroups = new Set(captures.map((c) => c.group_id).filter(Boolean));
    for (const a of allocations) {
      if (capturedGroups.has(a.groupId)) continue;
      const row: AllocationRec = { intent_id: i.id, group_id: a.groupId, owner_type: a.ownerType, seller_id: a.sellerId ?? null, amount: a.amount.amount };
      const existing = current.find((c) => c.group_id === a.groupId);
      if (existing) {
        if (existing.amount !== row.amount || existing.seller_id !== row.seller_id) await tx.updateWhere('allocations', { intent_id: i.id, group_id: a.groupId }, { amount: row.amount, owner_type: row.owner_type, seller_id: row.seller_id });
      } else await tx.insert('allocations', row);
    }
  }

  /** The order's payment: its linked intent that took money (latest first) */
  async intentOfOrder(orderId: string, fallbackIntentId?: string | null): Promise<IntentRec | undefined> {
    const linked = await this.repo.find('intents', { order_id: orderId }, { orderBy: [['created_at', 'desc']] });
    const accepted = linked.find((i) => is(ACCEPTED, i.status)) ?? linked.find((i) => i.status === 'pending_check') ?? linked[0];
    if (accepted) return accepted;
    if (fallbackIntentId) {
      const i = await this.repo.get('intents', fallbackIntentId);
      if (i && !i.order_id) {
        await this.linkOrder(i.id, orderId, []);
        return this.repo.get('intents', i.id);
      }
    }
    return undefined;
  }

  /** Links the order's intent from the order itself (placed and accepted events can arrive together) */
  private async ensureLinked(orderId: string, lookup: Lookup): Promise<IntentRec | undefined> {
    const linked = await this.intentOfOrder(orderId);
    if (linked) return linked;
    const order = await lookup.order(orderId);
    if (!order?.paymentIntentId) return undefined;
    const i = await this.repo.get('intents', order.paymentIntentId);
    if (!i) return undefined;
    await this.linkOrder(i.id, orderId, this.allocationsOfOrder(order).map((a) => ({ ...a, amount: { ...a.amount, currency: i.currency } })));
    return this.repo.get('intents', i.id);
  }

  /** Allocation amounts of uncaptured groups recomputed from the order (cancelled items are never captured) */
  async refreshAllocations(i: IntentRec, order: OrderInfo | null): Promise<void> {
    if (!order) return;
    const allocations: Allocation[] = [...order.groups.entries()].map(([groupId, g]) => {
      const open = [...order.items.values()].filter((x) => x.groupId === groupId && x.state !== 'cancelled');
      return { groupId, ownerType: g.ownerType, sellerId: g.sellerId, amount: this.m(open.reduce((s, x) => s + x.paid, 0), i.currency) };
    });
    await this.repo.transaction(async (tx) => {
      const locked = await tx.get('intents', i.id, { forUpdate: true });
      if (locked) await this.replaceAllocations(tx, locked, allocations);
    });
  }

  /* ---------------------------------------------------------------- capture */

  private async capturedPayload(tx: PaymentsRepository, i: IntentRec, c: CaptureRec, groupId: string | null, who: { customerId: string | null; contactEmail: string | null }) {
    const allocations = await tx.find('allocations', { intent_id: i.id, ...(groupId ? { group_id: groupId } : {}) });
    const credit = this.credit.shareOf(i, c.id);
    return {
      intentId: i.id,
      captureId: c.id,
      orderId: i.order_id!,
      ...who,
      groupId,
      amount: this.m(c.amount, i.currency),
      // the store-credit part of what this capture charged (the card was charged only `amount`)
      creditAmount: credit > 0 ? this.m(credit, i.currency) : null,
      allocations: allocations.map((a) => ({ groupId: a.group_id, ownerType: a.owner_type as 'official' | 'seller', sellerId: a.seller_id, amount: this.m(a.amount, i.currency) })),
      providerRef: c.provider_ref,
      capturedAt: c.at.toISOString(),
    };
  }

  /**
   * Captures part or all of an authorization. One capture row per idempotency key, so a retry or a replayed
   * event never captures twice. `final` releases what is left of the authorization.
   */
  async capture(intentId: string, o: { key: string; groupId?: string | null; amount?: number | null; final?: boolean; by: By; strict?: boolean }): Promise<CaptureRec | null> {
    let excessCredit = 0;
    let excessKey = EXCESS_KEY;
    let release = false;
    let closeRest = false;
    const batch = new Batch();
    const pre = await this.repo.get('intents', intentId);
    const who = pre?.order_id ? await this.core.contactOf(pre) : { customerId: null, contactEmail: null };
    const prepared = await this.repo.transaction(async (tx) => {
      const i = await tx.get('intents', intentId, { forUpdate: true });
      if (!i) throw notFound();
      const existing = (await tx.find('captures', { idempotency_key: o.key }))[0];
      if (existing) return { i, capture: existing, fresh: false };
      if (i.status !== 'authorized' && i.status !== 'partially_captured') {
        if (o.strict) paymentIntentMachine.next(i.status as never, 'capture'); // ILLEGAL_TRANSITION
        return null;
      }
      const creditOnly = this.credit.card(i) === 0;
      if (creditOnly && !i.order_id) return null; // store credit is only charged for an order
      const captures = await tx.find('captures', { intent_id: i.id });
      const holding = captures.filter((c) => c.status === 'pending' || c.status === 'unknown').reduce((s, c) => s + c.amount, 0);
      const remaining = i.authorized_amount - i.captured_amount - holding;
      const mixed = Boolean(this.credit.tender(i));
      let amount = o.amount ?? null;
      let creditShare = 0;
      if (amount === null) {
        const allocations = await tx.find('allocations', { intent_id: i.id });
        const live = captures.filter((c) => c.status !== 'failed');
        if (o.groupId) {
          const a = allocations.find((x) => x.group_id === o.groupId);
          const done = live.filter((c) => c.group_id === o.groupId).reduce((s, c) => s + c.amount, 0);
          const due = a?.amount ?? 0;
          if (mixed && due > 0) {
            // the group's card share: its allocation less its store-credit share (the last group to be charged takes
            // all the credit not charged yet, so the shares add up to the credit exactly)
            const others = allocations.filter((x) => x.group_id !== o.groupId && x.amount > 0 && !live.some((c) => c.group_id === x.group_id || c.group_id === null));
            const before = this.credit.groupShare(i, o.groupId);
            const open = this.credit.unallocated(i);
            const groupCredit = others.length === 0 ? before + open : Math.min(Math.max(this.credit.ratio(i, due), before), before + open);
            const cardDue = Math.max(0, due - groupCredit);
            excessCredit = Math.max(0, groupCredit - due);
            excessKey = `${EXCESS_KEY}:${o.groupId}`;
            creditShare = Math.max(0, Math.min(groupCredit, due) - before);
            amount = Math.min(Math.max(0, cardDue - done), Math.max(0, remaining));
          } else amount = Math.max(0, due - done);
        } else {
          const groupsDone = live.filter((c) => c.group_id);
          // the card pays what the store credit did not: items cancelled before the capture come off the card, and
          // credit beyond what is left of the order goes back to the customer's credit
          const credit = allocations.length || creditOnly ? this.credit.unallocated(i) : 0;
          const total = allocations.length ? allocations.filter((a) => !groupsDone.some((c) => c.group_id === a.group_id)).reduce((s, a) => s + a.amount, 0) : creditOnly ? credit : remaining;
          excessCredit = Math.max(0, credit - total);
          creditShare = Math.min(credit, total);
          amount = Math.min(Math.max(0, total - credit), remaining);
        }
      } else if (mixed && o.groupId) {
        // an amount chosen by staff for one group: the group's credit share not charged yet goes with it
        const a = (await tx.find('allocations', { intent_id: i.id, group_id: o.groupId }))[0];
        const before = this.credit.groupShare(i, o.groupId);
        creditShare = a ? Math.max(0, Math.min(this.credit.ratio(i, a.amount), a.amount, before + this.credit.unallocated(i)) - before) : 0;
      }
      if (!Number.isSafeInteger(amount) || amount < 0) throw invalid([{ path: 'amount', message: 'Enter an amount of zero or more' }]);
      if (amount > remaining) throw this.core.error('CAPTURE_EXCEEDS_AUTHORIZED', undefined, { remaining: this.m(Math.max(0, remaining), i.currency) });
      if (amount === 0 && creditShare > 0 && o.amount == null) {
        // store credit alone pays this order or group: a succeeded capture of 0 on the card carrying the credit share,
        // keyed like any capture (once), reported as payments.payment.captured with amount 0 and creditAmount
        const now = this.core.now();
        const capture = await tx.insert('captures', { id: newId(), intent_id: i.id, group_id: o.groupId ?? null, amount: 0, credit_amount: creditShare, status: 'succeeded', provider_ref: null, idempotency_key: o.key, at: now });
        let x = await tx.update('intents', i.id, { tenders: this.credit.withShare(i, capture.id, { amount: creditShare, groupId: o.groupId ?? null }), updated_at: now });
        const allocations = await tx.find('allocations', { intent_id: i.id });
        const done = await tx.find('captures', { intent_id: i.id, status: 'succeeded' });
        const groupsLeft = capture.group_id ? allocations.filter((a) => a.amount > 0 && !done.some((c) => c.group_id === a.group_id || c.group_id === null)) : [];
        const last = Boolean(o.final) || capture.group_id === null || groupsLeft.length === 0;
        if (creditOnly) {
          // nothing on a card: authorized → partially_captured (more groups to go) or captured, with no provider call
          const status = last ? paymentIntentMachine.next(i.status as never, 'capture') : i.status === 'authorized' ? paymentIntentMachine.next('authorized', 'capture_part') : i.status;
          x = await tx.update('intents', i.id, { status, captured_at: now, updated_at: now });
        } else if (last && !holding) {
          // nothing left for the card: an untouched authorization is voided, the rest of a partly captured one released
          if (i.status === 'authorized' && i.captured_amount === 0) release = true;
          else if (i.status === 'partially_captured') closeRest = true;
        }
        batch.push('payments.payment.captured', await this.capturedPayload(tx, x, capture, capture.group_id, who));
        return { i: x, capture, fresh: false };
      }
      if (amount === 0) {
        if (o.strict) throw invalid([{ path: 'amount', message: 'Nothing is left to capture' }]);
        if (o.final && i.status === 'partially_captured') {
          await tx.update('intents', i.id, { status: paymentIntentMachine.next('partially_captured', 'close_remainder'), updated_at: this.core.now() });
        }
        // nothing left for the card: the authorization is released (voided) instead of being left to lapse
        if (o.final && i.status === 'authorized' && i.captured_amount === 0 && !holding) release = true;
        return null;
      }
      if (!i.provider_ref) throw illegal('The authorization has no processor reference yet');
      const capture = await tx.insert('captures', { id: newId(), intent_id: i.id, group_id: o.groupId ?? null, amount, credit_amount: creditShare, status: 'pending', provider_ref: null, idempotency_key: o.key, at: this.core.now() });
      // the capture's store-credit share, kept with the tender (reported as creditAmount once the capture succeeds)
      if (creditShare > 0) await tx.update('intents', i.id, { tenders: this.credit.withShare(i, capture.id, { amount: creditShare, groupId: o.groupId ?? null }), updated_at: this.core.now() });
      return { i, capture, fresh: true };
    });
    this.core.flush(batch, o.by);
    if (excessCredit > 0) {
      const i = (await this.repo.get('intents', intentId))!;
      await this.credit.returnOutsideRefund(i, excessKey, excessCredit, 'Items were cancelled before the payment was taken: the store credit they no longer need is returned');
    }
    if (release) await this.void(intentId, 'Nothing is left to charge to the card', o.by);
    if (closeRest) await this.closeRemainder((await this.repo.get('intents', intentId))!, 'Nothing is left to charge to the card', o.by);
    if (!prepared) return null;
    const { i, capture } = prepared;
    if (capture.status === 'succeeded' || capture.status === 'failed') return capture;
    if (!prepared.fresh && capture.status === 'unknown') return capture; // the status-check job resolves it
    let result: ProviderCapture;
    try {
      result = await this.core.call(
        'capture',
        { intentId: i.id },
        () => this.core.provider.capture({ providerRef: i.provider_ref!, amount: this.m(capture.amount, i.currency), idempotencyKey: capture.idempotency_key }),
        (r) => ({ outcome: r.status === 'succeeded' ? 'ok' : 'declined', providerRef: r.providerRef, message: r.message ?? `capture ${r.status}` }),
      );
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err;
      const done = await this.finishCapture(capture.id, err.uncertain ? { status: 'not_found' } : { status: 'failed', message: err.message }, { final: o.final, by: o.by, unknown: err.uncertain });
      if (o.strict) this.core.unavailable(err);
      return done;
    }
    return this.finishCapture(capture.id, result, { final: o.final, by: o.by });
  }

  /** Applies a capture outcome under the intent lock; publishes payments.payment.captured once */
  async finishCapture(captureId: string, r: ProviderCapture, o: { final?: boolean; by: By; unknown?: boolean }): Promise<CaptureRec> {
    const batch = new Batch();
    const pre = await this.repo.get('captures', captureId);
    const owner = pre ? await this.repo.get('intents', pre.intent_id) : undefined;
    const who = owner ? await this.core.contactOf(owner) : { customerId: null, contactEmail: null };
    const after = await this.repo.transaction(async (tx) => {
      const c0 = await tx.get('captures', captureId);
      if (!c0) throw notFound('Capture');
      const i = (await tx.get('intents', c0.intent_id, { forUpdate: true }))!;
      const c = (await tx.get('captures', captureId))!;
      if (c.status === 'succeeded' || c.status === 'failed') return c;
      if (r.status === 'not_found') return o.unknown ? tx.update('captures', c.id, { status: 'unknown' }) : c;
      if (r.status === 'failed') {
        await this.dropShare(tx, i, c.id); // its store-credit share is not charged after all
        return tx.update('captures', c.id, { status: 'failed', provider_ref: r.providerRef ?? null });
      }
      const now = this.core.now();
      const updated = await tx.update('captures', c.id, { status: 'succeeded', provider_ref: r.providerRef ?? null });
      const captured = i.captured_amount + c.amount;
      let status = i.status as IntentStatus;
      if (status === 'authorized' || status === 'partially_captured') {
        const allocations = await tx.find('allocations', { intent_id: i.id });
        const captures = await tx.find('captures', { intent_id: i.id, status: 'succeeded' });
        const groupsLeft = c.group_id ? allocations.filter((a) => a.amount > 0 && !captures.some((x) => x.group_id === a.group_id) && a.group_id !== c.group_id) : [];
        const final = o.final || captured >= i.authorized_amount || (c.group_id !== null && allocations.length > 0 && groupsLeft.length === 0);
        status = paymentIntentMachine.next(status as never, final ? 'capture' : status === 'authorized' ? 'capture_part' : 'capture') as IntentStatus;
        if (!final && i.status === 'partially_captured') status = 'partially_captured';
      }
      await tx.update('intents', i.id, { captured_amount: captured, captured_at: now, status, updated_at: now });
      if (i.order_id) batch.push('payments.payment.captured', await this.capturedPayload(tx, i, updated, c.group_id, who));
      return updated;
    });
    this.core.flush(batch, o.by);
    return after;
  }

  /** A failed capture gives its store-credit share back to the uncharged credit (inside the intent lock) */
  private async dropShare(tx: PaymentsRepository, i: IntentRec, captureId: string) {
    if (!this.credit.shareOf(i, captureId)) return;
    await tx.update('intents', i.id, { tenders: this.credit.withShare(i, captureId, null), updated_at: this.core.now() });
  }

  /** Captures whose answer never came: ask the provider (status-check job, admin check) */
  async resolveUnknownCaptures(i: IntentRec, by: By): Promise<void> {
    const unknown = await this.repo.find('captures', { intent_id: i.id, status: ['unknown', 'pending'] });
    for (const c of unknown) {
      if (c.status === 'pending' && this.core.now().getTime() - c.at.getTime() < MINUTE) continue; // still in flight
      try {
        const r = await this.core.call('retrieve', { intentId: i.id }, () => this.core.provider.retrieveCapture({ idempotencyKey: c.idempotency_key }), (x) => ({ outcome: 'ok', providerRef: x.providerRef, message: `capture ${x.status}` }));
        if (r.status === 'not_found') {
          // the provider never received it: safe to send the same capture again (same key)
          await this.repo.transaction(async (tx) => {
            const locked = (await tx.get('intents', c.intent_id, { forUpdate: true }))!;
            await this.dropShare(tx, locked, c.id);
            await tx.update('captures', c.id, { status: 'failed' });
          });
          continue;
        }
        await this.finishCapture(c.id, r, { by });
      } catch (err) {
        if (!(err instanceof ProviderError)) throw err;
      }
    }
  }

  /* ---------------------------------------------------------------- void */

  async void(intentId: string, reason: string, by: By, o: { strict?: boolean } = {}): Promise<IntentRec> {
    const i = await this.get(intentId);
    if (is(ENDED, i.status)) {
      if (o.strict && i.status !== 'voided') paymentIntentMachine.next(i.status as never, 'void');
      return i;
    }
    if (i.status === 'requires_action') {
      const after = await this.repo.transaction(async (tx) => {
        const x = (await tx.get('intents', intentId, { forUpdate: true }))!;
        if (x.status !== 'requires_action') return x;
        return tx.update('intents', x.id, { status: paymentIntentMachine.next('requires_action', 'abandon'), method: { ...x.method, pendingAction: null }, updated_at: this.core.now() });
      });
      const hold = i.tenders.find((t) => t.creditHoldId)?.creditHoldId;
      if (hold) await this.core.soft('wallet', 'releaseHold', (w) => w.releaseHold(hold));
      return after;
    }
    if (i.status === 'pending_check' || i.status === 'authorizing' || i.status === 'created') throw illegal('The payment result is not known yet. It is checked with the bank before it can be released.', { status: i.status });
    if (i.status === 'captured') paymentIntentMachine.next('captured', 'void'); // ILLEGAL_TRANSITION: refund instead
    if (i.status === 'partially_captured') {
      if (o.strict) paymentIntentMachine.next('partially_captured', 'void');
      return this.closeRemainder(i, reason, by);
    }
    if (this.credit.card(i) > 0) {
      try {
        await this.core.call('void', { intentId }, () => this.core.provider.void({ providerRef: i.provider_ref!, idempotencyKey: `${i.id}:void` }), () => ({ outcome: 'ok', providerRef: i.provider_ref }));
      } catch (err) {
        return this.core.unavailable(err);
      }
    }
    const batch = new Batch();
    const after = await this.repo.transaction(async (tx) => {
      const x = (await tx.get('intents', intentId, { forUpdate: true }))!;
      if (x.status !== 'authorized') return x;
      batch.push('payments.payment.voided', { intentId: x.id, checkoutSessionId: x.checkout_session_id, orderId: x.order_id, reason });
      return tx.update('intents', x.id, { status: paymentIntentMachine.next('authorized', 'void'), updated_at: this.core.now() });
    });
    this.core.flush(batch, by);
    // without an order the checkout's credit hold was never used: release it. An order's credit was used when the
    // order was placed; it goes back when the order is cancelled (onOrderCancelled), never by releasing the hold.
    const hold = i.tenders.find((t) => t.creditHoldId)?.creditHoldId;
    if (hold && after.status === 'voided' && !after.order_id) await this.core.soft('wallet', 'releaseHold', (w) => w.releaseHold(hold));
    return after;
  }

  /** partially_captured → captured: the rest of the authorization is released */
  private async closeRemainder(i: IntentRec, reason: string, by: By): Promise<IntentRec> {
    try {
      await this.core.call('void', { intentId: i.id }, () => this.core.provider.void({ providerRef: i.provider_ref!, idempotencyKey: `${i.id}:void-remainder` }), () => ({ outcome: 'ok', providerRef: i.provider_ref, message: 'release remainder' }));
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err; // the processor releases an unused remainder by itself at expiry
    }
    const batch = new Batch();
    const after = await this.repo.transaction(async (tx) => {
      const x = (await tx.get('intents', i.id, { forUpdate: true }))!;
      if (x.status !== 'partially_captured') return x;
      batch.push('payments.payment.voided', { intentId: x.id, checkoutSessionId: x.checkout_session_id, orderId: x.order_id, reason });
      return tx.update('intents', x.id, { status: paymentIntentMachine.next('partially_captured', 'close_remainder'), updated_at: this.core.now() });
    });
    this.core.flush(batch, by);
    return after;
  }

  /* ---------------------------------------------------------------- events from orders and shipping */

  async onOrderPlaced(e: { orderId: string; paymentIntentId: string; groups: { groupId: string; ownerType: 'official' | 'seller'; sellerId?: string | null; total: common.Money }[] }) {
    const i = await this.repo.get('intents', e.paymentIntentId);
    if (!i) return this.core.ctx.log.info({ intentId: e.paymentIntentId, orderId: e.orderId }, 'payments: placed order names an unknown payment');
    if (i.order_id && i.order_id !== e.orderId) return this.core.ctx.log.warn({ intentId: i.id, orderId: e.orderId }, 'payments: payment already linked to another order');
    await this.linkOrder(
      i.id,
      e.orderId,
      e.groups.map((g) => ({ groupId: g.groupId, ownerType: g.ownerType, sellerId: g.sellerId ?? null, amount: g.total })),
    );
  }

  async onOrderAccepted(orderId: string) {
    const cfg = await this.core.cfg();
    const lookup = this.core.lookup();
    const i = await this.ensureLinked(orderId, lookup);
    if (!i) return this.core.ctx.log.info({ orderId }, 'payments: accepted order has no payment yet');
    if (cfg.captureMode !== 'on_acceptance') return;
    if (i.status !== 'authorized' && i.status !== 'partially_captured') return;
    await this.refreshAllocations(i, await lookup.order(orderId));
    await this.capture(i.id, { key: `${i.id}:capture:order`, final: true, by: { actor: SYSTEM } });
  }

  async onShipmentDispatched(e: { kind: string; orderId: string; groupId: string }) {
    if (e.kind !== 'outbound') return;
    const cfg = await this.core.cfg();
    if (cfg.captureMode !== 'per_group_on_dispatch') return;
    const lookup = this.core.lookup();
    const i = await this.ensureLinked(e.orderId, lookup);
    if (!i || (i.status !== 'authorized' && i.status !== 'partially_captured')) return;
    await this.refreshAllocations(i, await lookup.order(e.orderId));
    await this.capture(i.id, { key: `${i.id}:capture:group:${e.groupId}`, groupId: e.groupId, by: { actor: SYSTEM } });
  }

  async onOrderCancelled(e: { orderId: string; reason: string }) {
    if (e.reason === 'payment_declined') return;
    const linked = await this.repo.find('intents', { order_id: e.orderId, status: ['authorized', 'partially_captured'] });
    for (const i of linked) {
      try {
        if (i.status === 'authorized' && i.captured_amount === 0) await this.void(i.id, 'Order cancelled before capture', { actor: SYSTEM });
        else await this.closeRemainder(i, 'Order cancelled: remaining authorization released', { actor: SYSTEM });
      } catch (err) {
        this.core.ctx.log.warn({ err, intentId: i.id }, 'payments: could not release the authorization of a cancelled order');
      }
    }
    // the store credit of what was not charged yet goes back to the customer's credit (what was charged comes back
    // through the cancellation refunds, credit first)
    for (const i of await this.repo.find('intents', { order_id: e.orderId })) {
      if (!this.credit.tender(i)) continue;
      await this.credit.returnOutsideRefund(i, CANCELLED_KEY, this.credit.unallocated(i), 'Order cancelled before the payment was taken');
    }
  }

  /**
   * An item cancelled before its group was charged (orders.item.cancelled; the allocation already shrank): its
   * store-credit share goes back to the wallet (keyed by the item, once), so only its card share came off the
   * authorization; an authorization with no card amount left is released.
   */
  async onUncapturedItemCancelled(intentId: string, itemId: string, order: OrderInfo | null): Promise<void> {
    const i = await this.repo.get('intents', intentId);
    if (!i || !is(ACCEPTED, i.status)) return;
    const item = order?.items.get(itemId);
    let creditShare = 0;
    if (this.credit.tender(i) && order && item) {
      const charged = new Set((await this.repo.find('captures', { intent_id: i.id, status: ['succeeded', 'pending', 'unknown'] })).map((c) => c.group_id));
      // the last item still to be charged takes all the credit not charged yet (the shares add up to the credit)
      const stillOpen = charged.has(null) ? false : [...order.items.entries()].some(([id, x]) => id !== itemId && x.state !== 'cancelled' && x.paid > 0 && !charged.has(x.groupId));
      const share = this.credit.proportional(i, item.paid, !stillOpen);
      creditShare = share; // the item's credit share is not card money, whether wallet took it back now or on a redelivery
      await this.credit.returnOutsideRefund(i, itemKey(itemId), share, `${item.title} was cancelled before it was charged: its store credit is returned`);
    }
    if (await this.releaseIfNothingLeft(intentId, { actor: SYSTEM }, 'Every item was cancelled before the card was charged')) return;
    if (item) await this.reduceAuthorization(intentId, itemId, item.paid - creditShare);
  }

  /**
   * Partial reversal (decision D-P1): when the adapter supports it, the authorization is lowered by the cancelled
   * item's card share (ProviderCall partial_void, intent transition reduce), once per item. Without it, or when the
   * provider refuses, the amount stays authorized and the remainder is released at the final capture.
   */
  async reduceAuthorization(intentId: string, itemId: string, cardShare: number): Promise<void> {
    const partialVoid = this.core.provider.partialVoid?.bind(this.core.provider);
    if (!partialVoid || cardShare <= 0) return;
    const i = await this.repo.get('intents', intentId);
    if (!i?.provider_ref || (i.status !== 'authorized' && i.status !== 'partially_captured')) return;
    const holding = (await this.repo.find('captures', { intent_id: i.id, status: ['pending', 'unknown'] })).reduce((s, c) => s + c.amount, 0);
    const amount = Math.min(cardShare, i.authorized_amount - i.captured_amount - holding);
    if (amount <= 0) return;
    let left: number;
    try {
      left = (
        await this.core.call('partial_void', { intentId }, () => partialVoid({ providerRef: i.provider_ref!, amount: this.m(amount, i.currency), idempotencyKey: `${i.id}:reduce:${itemId}` }), (r) => ({ outcome: 'ok', providerRef: i.provider_ref, message: `authorization lowered by ${amount} to ${r.authorizedAmount}` }))
      ).authorizedAmount;
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err;
      return void this.core.ctx.log.warn({ err, intentId, itemId }, 'payments: authorization not lowered; the remainder is released at the final capture');
    }
    await this.repo.transaction(async (tx) => {
      const x = (await tx.get('intents', intentId, { forUpdate: true }))!;
      if (x.status !== 'authorized' && x.status !== 'partially_captured') return;
      if (x.authorized_amount === left) return; // already applied (the provider answers the same for the same key)
      await tx.update('intents', x.id, { status: paymentIntentMachine.next(x.status as never, 'reduce'), authorized_amount: left, updated_at: this.core.now() });
    });
  }

  /** Card amount the authorization still has to charge: the allocations of groups not captured less their store credit; null when unknown */
  async cardLeft(i: IntentRec): Promise<number | null> {
    if (!i.order_id) return null;
    const [allocations, captures] = await Promise.all([this.repo.find('allocations', { intent_id: i.id }), this.repo.find('captures', { intent_id: i.id, status: ['succeeded', 'pending', 'unknown'] })]);
    if (!allocations.length || captures.some((c) => c.group_id === null)) return null;
    // groups paid entirely by store credit are charged: they have a credit-only capture (amount 0), or, recorded
    // before those existed, a "nocard:" credit share on the tender
    const legacy = Object.entries(this.credit.tender(i)?.captureCredits ?? {}).filter(([key]) => key.startsWith('nocard:')).map(([, c]) => c.groupId);
    if (legacy.includes(null)) return 0;
    const open = allocations.filter((a) => !captures.some((c) => c.group_id === a.group_id) && !legacy.includes(a.group_id)).reduce((s, a) => s + a.amount, 0);
    return Math.max(0, open - this.credit.unallocated(i));
  }

  /** An authorization whose card amount dropped to 0 is voided (or, after part captures, its remainder is closed); true when released */
  async releaseIfNothingLeft(intentId: string, by: By, reason: string): Promise<boolean> {
    const i = await this.repo.get('intents', intentId);
    if (!i || (i.status !== 'authorized' && i.status !== 'partially_captured') || this.credit.card(i) === 0) return false;
    if ((await this.repo.find('captures', { intent_id: i.id, status: ['pending', 'unknown'] })).length) return false; // a capture is in flight
    const left = await this.cardLeft(i);
    if (left === null || left > 0) return false;
    if (i.status === 'authorized' && i.captured_amount === 0) await this.void(i.id, reason, by);
    else await this.closeRemainder(i, reason, by);
    return true;
  }

  /* ---------------------------------------------------------------- jobs */

  /** payments.check-uncertain: pending checks with backoff, unknown captures, Finance review after uncertainMaxHours */
  async checkUncertain(): Promise<void> {
    const cfg = await this.core.cfg();
    const now = this.core.now();
    const due = await this.repo.find('intents', { status: 'pending_check', next_check_at: { op: '<=', value: now } }, { orderBy: [['next_check_at', 'asc']], limit: 50 });
    for (const i of due) {
      try {
        const after = await this.sync(i.id, { actor: SYSTEM });
        if (after.status === 'pending_check') await this.keepCreditHold(after);
        if (after.status === 'pending_check' && !after.orphan && now.getTime() - after.created_at.getTime() > cfg.uncertainMaxHours * HOUR) {
          await this.repo.update('intents', after.id, { orphan: true, updated_at: now });
          // what may have moved on the card (never the intent amount with its store credit), and the credit held for it
          const credit = this.credit.tender(after)?.amount.amount ?? 0;
          this.core.publish('payments.payment.orphaned', { intentId: after.id, checkoutSessionId: after.checkout_session_id, amount: this.m(after.authorized_amount || this.credit.card(after), after.currency), creditAmount: credit > 0 ? this.m(credit, after.currency) : null, captured: false, action: 'needs_review' });
        }
      } catch (err) {
        this.core.ctx.log.warn({ err, intentId: i.id }, 'payments: status check failed');
      }
    }
    const captures = await this.repo.find('captures', { status: 'unknown' }, { orderBy: [['at', 'asc']], limit: 50 });
    for (const intentId of new Set(captures.map((c) => c.intent_id))) {
      const i = await this.repo.get('intents', intentId);
      if (i) await this.resolveUnknownCaptures(i, { actor: SYSTEM });
    }
  }

  /** Margin past the next status check that a pending payment's store-credit hold is kept alive */
  static readonly HOLD_MARGIN_MS = 15 * MINUTE;

  /**
   * While a payment is pending check its store-credit hold must not lapse (the capture would then fail with
   * INSUFFICIENT_CREDIT): wallet.extendHold until the next check plus a margin. Wallet caps it
   * (pendingHoldMaxHours) and never shortens a hold; a failure is logged, the next check tries again.
   */
  async keepCreditHold(i: IntentRec): Promise<void> {
    const holdId = this.credit.tender(i)?.creditHoldId;
    if (!holdId) return;
    const next = i.next_check_at ?? this.core.now();
    const until = new Date(next.getTime() + Intents.HOLD_MARGIN_MS).toISOString();
    await this.core.soft('wallet', 'extendHold', (w) => w.extendHold(holdId, until));
  }

  /** payments.detect-orphans: money without an order after the grace period and an ended checkout session */
  async detectOrphans(): Promise<void> {
    const cfg = await this.core.cfg();
    const before = new Date(this.core.now().getTime() - cfg.orphanGraceMinutes * MINUTE);
    const candidates = await this.repo.find('intents', { status: [...ACCEPTED], order_id: null, orphan: false, created_at: { op: '<', value: before } }, { orderBy: [['created_at', 'asc']], limit: 50 });
    for (const i of candidates) {
      try {
        const session = await this.core.soft('checkout', 'getSessionForOrder', (c) => c.getSessionForOrder(i.checkout_session_id));
        if (session?.orderId) {
          const order = await this.core.lookup().order(session.orderId);
          await this.linkOrder(i.id, session.orderId, order ? this.allocationsOfOrder(order).map((a) => ({ ...a, amount: { ...a.amount, currency: i.currency } })) : []);
          continue;
        }
        if (session && !['completed', 'expired', 'abandoned', 'cancelled', 'failed'].includes(session.status)) continue; // the customer may still be placing it
        await this.handleOrphan(i, { actor: SYSTEM }, 'No order was created for this payment');
      } catch (err) {
        this.core.ctx.log.warn({ err, intentId: i.id }, 'payments: orphan check failed');
      }
    }
  }

  /** Marks an orphan and returns its money: void an authorization, refund a capture, or leave it to Finance */
  async handleOrphan(i: IntentRec, by: By, reason: string): Promise<'voided' | 'refund_started' | 'needs_review'> {
    await this.repo.update('intents', i.id, { orphan: true, updated_at: this.core.now() });
    let action: 'voided' | 'refund_started' | 'needs_review' = 'needs_review';
    const captured = i.captured_amount > 0;
    // card money that moved without an order: what the orphan refund returns (captured less refunds already sent or
    // in flight), else the authorized amount; the store credit held for it is reported apart
    const totals = captured ? await this.repo.intentRefundTotals(i.id) : { sent: 0, inFlight: 0 };
    const moved = captured ? Math.max(0, i.captured_amount - totals.sent - totals.inFlight) : i.authorized_amount;
    const credit = this.credit.tender(i)?.amount.amount ?? 0;
    try {
      if (i.status === 'authorized' && !captured) {
        const after = await this.void(i.id, reason, by);
        action = after.status === 'voided' ? 'voided' : 'needs_review';
      } else if (captured) {
        await this.startOrphanRefund(i, by, reason);
        action = 'refund_started';
      }
    } catch (err) {
      this.core.ctx.log.warn({ err, intentId: i.id }, 'payments: orphan payment needs review');
      action = 'needs_review';
    }
    this.core.publish('payments.payment.orphaned', { intentId: i.id, checkoutSessionId: i.checkout_session_id, amount: this.m(moved, i.currency), creditAmount: credit > 0 ? this.m(credit, i.currency) : null, captured, action }, by);
    return action;
  }

  /** Page size of the expiry sweep (keyset pages over (updated_at, id)); tests lower it to walk several pages */
  expiryPageSize = 200;

  /**
   * payments.expire-authorizations: walks every live authorization (authorized, partially_captured) in keyset
   * pages ordered by (updated_at, id) until none are left. One with no card amount left (its items cancelled, or
   * its groups paid by store credit) is voided at once; one near expiry is captured if the order is accepted,
   * otherwise voided. One failing intent never stops the walk; rows the walk itself changes are not visited again.
   */
  async expireAuthorizations(): Promise<{ visited: number; failed: number }> {
    const start = this.core.now();
    const soon = new Date(start.getTime() + DAY);
    const lookup = this.core.lookup();
    let after: { updatedAt: Date; id: string } | null = null;
    let visited = 0;
    let failed = 0;
    for (;;) {
      const page = await this.repo.liveAuthorizations(after, start, this.expiryPageSize);
      for (const i of page) {
        visited++;
        try {
          await this.expireOne(i, soon, lookup);
        } catch (err) {
          failed++;
          this.core.ctx.log.warn({ err, intentId: i.id }, 'payments: live authorization not handled by the expiry sweep');
        }
      }
      if (page.length < this.expiryPageSize) break;
      const last = page.at(-1)!;
      after = { updatedAt: last.updated_at, id: last.id };
    }
    return { visited, failed };
  }

  private async expireOne(i: IntentRec, soon: Date, lookup: Lookup): Promise<void> {
    if (i.order_id && (await this.releaseIfNothingLeft(i.id, { actor: SYSTEM }, 'Nothing is left to charge to the card'))) return;
    const x = await this.repo.get('intents', i.id);
    if (!x || (x.status !== 'authorized' && x.status !== 'partially_captured')) return;
    if (!x.authorization_expires_at || x.authorization_expires_at > soon) return;
    const now = this.core.now();
    const order = await lookup.order(x.order_id);
    if (order && (order.lifecycle === 'open' || order.lifecycle === 'completed')) {
      await this.refreshAllocations(x, order);
      await this.capture(x.id, { key: await this.expiryCaptureKey(x.id), final: true, by: { actor: SYSTEM } });
      return;
    }
    if (x.order_id && !order) return; // orders did not answer: try again next hour
    try {
      await this.void(x.id, 'Authorization expiring without an accepted order', { actor: SYSTEM });
    } catch (err) {
      if (!(err instanceof AppError) || !x.authorization_expires_at || x.authorization_expires_at > now || x.status !== 'authorized') throw err;
      // the provider did not answer and the authorization has lapsed anyway
      await this.repo.transaction(async (tx) => {
        const y = (await tx.get('intents', x.id, { forUpdate: true }))!;
        if (y.status === 'authorized') await tx.update('intents', y.id, { status: paymentIntentMachine.next('authorized', 'expire'), updated_at: now });
      });
    }
  }

  /**
   * The capture key of the expiry capture: intent + expiry + attempt number. An attempt still in flight (pending,
   * unknown) or one that succeeded keeps its key (capture answers with it); after a failed attempt the next run
   * uses a new key, so the failed row never blocks the capture.
   */
  async expiryCaptureKey(intentId: string): Promise<string> {
    const base = `${intentId}:capture:expiry`;
    const attempts = (await this.repo.find('captures', { intent_id: intentId })).filter((c) => c.idempotency_key === base || c.idempotency_key.startsWith(`${base}:`));
    const open = attempts.find((c) => c.status !== 'failed');
    if (open) return open.idempotency_key;
    return `${base}:${attempts.length + 1}`;
  }

  /* ---------------------------------------------------------------- admin */

  async detail(i: IntentRec): Promise<PaymentDetail> {
    return this.views.paymentDetail(i, this.core.lookup(), await this.core.cfg());
  }

  async adminCapture(intentId: string, body: { amount?: common.Money | null; groupId?: string | null; reason: string }, by: By & { idempotencyKey: string }): Promise<PaymentDetail> {
    if (!body.reason?.trim()) throw invalid([{ path: 'reason', message: 'Give a reason' }]);
    const before = await this.get(intentId);
    if (body.amount && body.amount.currency !== before.currency) throw invalid([{ path: 'amount.currency', message: `Use ${before.currency}` }]);
    if (body.groupId) {
      const allocations = await this.repo.find('allocations', { intent_id: intentId, group_id: body.groupId });
      if (!allocations.length) throw invalid([{ path: 'groupId', message: 'This seller group is not part of the payment' }]);
    }
    const capture = await this.capture(intentId, { key: `${intentId}:capture:admin:${by.idempotencyKey}`, groupId: body.groupId ?? null, amount: body.amount?.amount ?? null, final: !body.groupId && !body.amount, by, strict: true });
    const after = await this.get(intentId);
    await this.core.audit(
      {
        action: 'payments.payment.capture',
        actionLabel: 'Captured a payment manually',
        category: 'financial',
        target: { type: 'payment', id: intentId, ref: before.ref, label: before.method.label, screen: 'admin/order' },
        reason: body.reason,
        before: { status: before.status, captured: before.captured_amount },
        after: { status: after.status, captured: after.captured_amount, capture: capture ? { id: capture.id, amount: capture.amount, status: capture.status } : null },
      },
      by,
    );
    return this.detail(after);
  }

  async adminVoid(intentId: string, reason: string, by: By): Promise<PaymentDetail> {
    if (!reason?.trim()) throw invalid([{ path: 'reason', message: 'Give a reason' }]);
    const before = await this.get(intentId);
    if (before.status !== 'voided') paymentIntentMachine.next(before.status as never, 'void'); // only authorizations
    const after = await this.void(intentId, reason, by, { strict: true });
    if (before.status !== after.status) {
      await this.core.audit(
        { action: 'payments.payment.void', actionLabel: 'Voided an authorization', category: 'financial', target: { type: 'payment', id: intentId, ref: before.ref, label: before.method.label, screen: 'admin/order' }, reason, before: { status: before.status }, after: { status: after.status } },
        by,
      );
    }
    return this.detail(after);
  }

  async resolveOrphan(intentId: string, body: { action: 'refund' | 'link_to_order'; orderId?: string | null; reason: string }, by: By): Promise<PaymentDetail> {
    if (!body.reason?.trim()) throw invalid([{ path: 'reason', message: 'Give a reason' }]);
    const before = await this.get(intentId);
    if (!before.orphan && before.order_id) throw illegal('This payment already belongs to an order');
    if (!is(ACCEPTED, before.status) && before.status !== 'pending_check') throw illegal('Only money that was authorized or captured can be resolved', { status: before.status });
    if (body.action === 'link_to_order') {
      if (!body.orderId) throw invalid([{ path: 'orderId', message: 'Choose the order this checkout created' }]);
      const order = await this.core.lookup().order(body.orderId);
      const session = await this.core.soft('checkout', 'getSessionForOrder', (c) => c.getSessionForOrder(before.checkout_session_id));
      const madeBySession = order && (order.paymentIntentId === before.id || session?.orderId === order.id);
      if (!order || !madeBySession) throw invalid([{ path: 'orderId', message: "This checkout did not create that order. Refund the payment instead." }]);
      await this.linkOrder(before.id, order.id, this.allocationsOfOrder(order).map((a) => ({ ...a, amount: { ...a.amount, currency: before.currency } })));
    } else {
      if (before.status === 'pending_check') throw illegal('The payment result is not known yet. Check it with the provider first.');
      if (before.order_id) throw illegal('This payment belongs to an order: refund it from the order');
      const action = await this.handleOrphan(before, by, body.reason);
      if (action === 'needs_review') throw this.core.error('PROVIDER_UNAVAILABLE');
    }
    const after = await this.get(intentId);
    await this.core.audit(
      {
        action: 'payments.payment.resolve_orphan',
        actionLabel: body.action === 'refund' ? 'Returned money of a payment without an order' : 'Linked a payment to its order',
        category: 'financial',
        target: { type: 'payment', id: intentId, ref: before.ref, label: before.method.label, screen: 'admin/finance' },
        reason: body.reason,
        before: { status: before.status, orphan: before.orphan, orderId: before.order_id },
        after: { status: after.status, orphan: after.orphan, orderId: after.order_id },
      },
      by,
    );
    return this.detail(after);
  }
}

