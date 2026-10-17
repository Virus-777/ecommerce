/**
 * Refund execution: Requested → Processing → Sent / Failed (→ Cancelled), capped at the remaining refundable
 * amount per item and per payment.
 *
 * Money safety:
 *   - every cap decision runs under a row lock on the payment intent, so concurrent refunds of one order
 *     serialize and the remainder can never go below zero;
 *   - one refund per (origin, originId) and per idempotency key (unique indexes), so a retried hand-over or a
 *     replayed event returns the existing refund;
 *   - each provider attempt has its own key (the id of the log entry that started it); an attempt without an
 *     answer is only ever retrieved, and resent with the same key only after the provider says it never got it.
 */
import type { PageRequest } from '../../../kernel/lib/pagination.js';
import { AppError, isAppError } from '../../../kernel/errors/index.js';
import { newId } from '../../../kernel/lib/ids.js';
import { format } from '../../../kernel/lib/money.js';
import type * as common from '../../../spec/common.js';
import type { ItemPaidAmount } from '../../../spec/orders.js';
import type { Refund, RefundableItem, RefundableSummary, RefundView, StartRefundInput } from '../../../spec/payments.js';
import { refundExecutionMachine } from '../domain/state-machines.js';
import { ACCEPTED, is, isExpired, methodLabel, refundBackoffMs, retryableRefundFailure, type RefundStatus, refundOrderKey } from '../domain/rules.js';
import { ProviderError, type IntentRec, type ProviderRefund, type RefundDestination, type RefundItemRec, type RefundLogRec, type RefundRec } from '../ports.js';
import type { PaymentsRepository } from '../repository.js';
import type { Scope } from '../../../kernel/auth/scope.js';
import { Batch, SYSTEM, illegal, invalid, notFound, type By, type Cfg, type Core, type Lookup, type OrderInfo } from './core.js';
import { refundKey, type Credit } from './credit.js';
import type { Intents } from './intents.js';
import type { Views } from './views.js';

type REv = Parameters<typeof refundExecutionMachine.next>[1];
const STORE_CREDIT_LABEL = 'Marketly store credit';

interface ItemCap {
  orderItemId: string;
  groupId: string;
  sellerId: string | null;
  paid: number;
  sent: number;
  inFlight: number;
  remaining: number;
  captured: boolean;
}

export class Refunds {
  constructor(
    private readonly core: Core,
    private readonly views: Views,
    private readonly intents: Intents,
    private readonly credit: Credit,
  ) {}

  /**
   * What the order's payment took and refunds can still count against: the card captures plus the store credit used,
   * less credit given back outside the live refunds (cancellation, excess, cancelled refunds whose credit part was sent)
   */
  private async charged(repo: PaymentsRepository, i: IntentRec): Promise<number> {
    const t = this.credit.tender(i);
    const keys = Object.keys(t?.creditReturns ?? {}).filter((k) => k.startsWith('refund:')).map((k) => k.slice('refund:'.length));
    const cancelled = keys.length ? new Set((await repo.find('refunds', { id: keys, status: 'cancelled' })).map((r) => r.id)) : new Set<string>();
    // the card captures plus the credit charged with them, less credit of cancelled refunds that went back anyway
    return i.captured_amount + this.credit.taken(i) - (this.credit.returned(i, { notRefunds: true, cancelledRefunds: cancelled }) - this.credit.outside(i));
  }

  private get repo() {
    return this.core.repo;
  }
  private m = (amount: number, currency: string): common.Money => ({ amount, currency });

  async get(refundId: string): Promise<RefundRec> {
    const r = await this.repo.get('refunds', refundId);
    if (!r) throw notFound('Refund');
    return r;
  }

  /* ---------------------------------------------------------------- caps */

  private async paidAmounts(orderId: string): Promise<ItemPaidAmount[]> {
    return this.core.ctx.use('orders').getPaidAmounts(orderId);
  }

  /** Groups whose money was captured (a whole-payment capture covers every group) */
  private async capturedGroups(repo: PaymentsRepository, intent: IntentRec | undefined): Promise<{ all: boolean; groups: Set<string> }> {
    // paid entirely with store credit: the whole order is charged once the payment is captured (nothing goes to a card)
    if (intent && intent.status === 'captured' && this.credit.card(intent) === 0 && this.credit.paid(intent) > 0) return { all: true, groups: new Set() };
    if (!intent) return { all: false, groups: new Set() };
    // succeeded captures charged their groups, credit-only ones (amount 0) included
    const captures = await repo.find('captures', { intent_id: intent.id, status: 'succeeded' });
    if (!captures.length) return { all: intent.captured_amount > 0, groups: new Set() };
    return { all: captures.some((c) => c.group_id === null), groups: new Set(captures.map((c) => c.group_id).filter((g): g is string => Boolean(g))) };
  }

  /** Per item paid, sent, in flight and remaining, from the given repository (inside the lock when deciding) */
  private async caps(repo: PaymentsRepository, orderId: string, intent: IntentRec | undefined, paid: ItemPaidAmount[]): Promise<{ items: ItemCap[]; sent: number; inFlight: number; captured: number }> {
    // one after the other: repo may be a transaction (no concurrent operations on one session)
    const totals = await repo.refundTotals(orderId);
    const captured = await this.capturedGroups(repo, intent);
    const payment = intent ? await repo.intentRefundTotals(intent.id) : { sent: 0, inFlight: 0 };
    const items = paid.map((p) => {
      const t = totals.find((x) => x.orderItemId === p.orderItemId);
      const sent = t?.sent ?? 0;
      const inFlight = t?.inFlight ?? 0;
      const isCaptured = captured.all || captured.groups.has(p.groupId);
      return { orderItemId: p.orderItemId, groupId: p.groupId, sellerId: p.sellerId ?? null, paid: p.paid.amount, sent, inFlight, remaining: isCaptured ? Math.max(0, p.paid.amount - sent - inFlight) : 0, captured: isCaptured };
    });
    return { items, sent: payment.sent, inFlight: payment.inFlight, captured: intent ? await this.charged(repo, intent) : 0 };
  }

  async remainingRefundable(orderId: string, orderItemIds?: string[]): Promise<RefundableSummary> {
    const lookup = this.core.lookup();
    const order = await lookup.order(orderId);
    if (!order) throw notFound('Order');
    const intent = await this.intents.intentOfOrder(orderId, order.paymentIntentId);
    const paid = await this.paidAmounts(orderId);
    const currency = intent?.currency ?? paid[0]?.paid.currency ?? this.core.ctx.config.market.currency;
    const c = await this.caps(this.repo, orderId, intent, paid);
    const wanted = orderItemIds?.length ? c.items.filter((i) => orderItemIds.includes(i.orderItemId)) : c.items;
    const items: RefundableItem[] = wanted.map((i) => {
      const info = order.items.get(i.orderItemId);
      const group = order.groups.get(i.groupId);
      return {
        orderItemId: i.orderItemId,
        title: info?.title ?? 'Item',
        groupId: i.groupId,
        sellerName: group?.sellerName ?? 'Seller',
        paid: this.m(i.paid, currency),
        refunded: this.m(i.sent, currency),
        inFlight: this.m(i.inFlight, currency),
        remaining: this.m(i.remaining, currency),
        blockedReason: !i.captured ? 'Not charged yet: cancel the item instead of refunding it' : info?.state === 'shipped' ? 'In transit: refund after delivery or a confirmed loss' : null,
      };
    });
    const paymentLeft = Math.max(0, c.captured - c.sent - c.inFlight);
    const itemsLeft = wanted.reduce((s, i) => s + i.remaining, 0);
    const sum = (k: 'sent' | 'inFlight') => wanted.reduce((s, i) => s + i[k], 0);
    return {
      orderId,
      captured: this.m(c.captured, currency),
      refunded: this.m(orderItemIds?.length ? sum('sent') : c.sent, currency),
      inFlight: this.m(orderItemIds?.length ? sum('inFlight') : c.inFlight, currency),
      remaining: this.m(Math.min(itemsLeft, paymentLeft), currency),
      items,
    };
  }

  /* ---------------------------------------------------------------- start */

  private sameContent(r: RefundRec, items: RefundItemRec[], input: StartRefundInput) {
    if (input.items.length !== items.length) return false;
    return input.items.every((x) => items.some((i) => i.order_item_id === x.orderItemId && i.amount === x.amount.amount)) && r.order_id === input.orderId;
  }

  /** Hand-over of an approved refund (returns, finance, support) */
  async startRefund(input: StartRefundInput, idempotencyKey: string): Promise<Refund> {
    if (!idempotencyKey?.trim()) throw invalid([{ path: 'idempotencyKey', message: 'An idempotency key is required' }]);
    const issues: { path: string; message: string }[] = [];
    if (!input.items?.length) issues.push({ path: 'items', message: 'Name at least one item' });
    const seen = new Set<string>();
    input.items?.forEach((x, n) => {
      if (!Number.isSafeInteger(x.amount.amount) || x.amount.amount <= 0) issues.push({ path: `items.${n}.amount`, message: 'Each amount must be more than zero' });
      if (seen.has(x.orderItemId)) issues.push({ path: `items.${n}.orderItemId`, message: 'Each item can appear once' });
      seen.add(x.orderItemId);
    });
    if (!input.reason?.trim()) issues.push({ path: 'reason', message: 'Give a reason' });
    if (issues.length) throw invalid(issues);

    const byKey = (await this.repo.find('refunds', { idempotency_key: idempotencyKey }))[0];
    if (byKey) return this.toApi(byKey);
    // one refund per origin, except cancellations (one per cancelled item, keyed by the hand-over key)
    if (input.originId && input.origin !== 'cancellation') {
      const same = await this.byOrigin(this.repo, input.origin, input.originId);
      if (same) {
        const items = await this.repo.find('refund_items', { refund_id: same.id });
        if (this.sameContent(same, items, input)) return this.toApi(same);
        throw this.core.error('DUPLICATE_REFUND', undefined, { refundId: same.id });
      }
    }
    if (input.destination === 'store_credit' && !this.core.ctx.tryUse('wallet')) throw invalid([{ path: 'destination', message: 'Store credit refunds are not available yet' }]);

    const lookup = this.core.lookup();
    const order = await lookup.order(input.orderId);
    if (!order) throw notFound('Order');
    const intent = await this.intents.intentOfOrder(input.orderId, order.paymentIntentId);
    if (input.destination === 'store_credit' && !intent?.customer_id) throw invalid([{ path: 'destination', message: 'Guest orders are refunded to the original payment method' }]);
    const paid = await this.paidAmounts(input.orderId);
    const unknown = input.items.filter((x) => !paid.some((p) => p.orderItemId === x.orderItemId));
    if (unknown.length) throw invalid(unknown.map((x) => ({ path: 'items', message: `Item ${x.orderItemId} is not part of this order` })));
    const currency = intent?.currency ?? paid[0]!.paid.currency;
    if (input.items.some((x) => x.amount.currency !== currency)) throw invalid([{ path: 'items', message: `Refunds are in ${currency}` }]);
    // a card authorization released after store credit alone paid what was left (voided) still has that credit to refund
    const creditCharged = intent?.status === 'voided' && this.credit.taken(intent) > 0;
    if (!intent || (!is(ACCEPTED, intent.status) && !creditCharged) || (await this.charged(this.repo, intent)) <= 0) {
      throw this.core.error('REFUND_EXCEEDS_REFUNDABLE', 'Nothing was charged for this order yet, so there is nothing to refund.', { items: input.items.map((x) => ({ orderItemId: x.orderItemId, remaining: this.m(0, currency) })) });
    }
    const ref = await this.refFor(input.requestRef);
    const requestedBy = input.requestedBy ?? SYSTEM;
    const cfg = await this.core.cfg();

    const created = await this.repo.transaction(async (tx) => {
      const locked = (await tx.get('intents', intent.id, { forUpdate: true }))!;
      const c = await this.caps(tx, input.orderId, locked, paid);
      const over = input.items
        .map((x) => ({ x, cap: c.items.find((i) => i.orderItemId === x.orderItemId)! }))
        .filter(({ x, cap }) => x.amount.amount > cap.remaining)
        .map(({ x, cap }) => ({ orderItemId: x.orderItemId, requested: x.amount, remaining: this.m(cap.remaining, currency) }));
      const total = input.items.reduce((s, x) => s + x.amount.amount, 0);
      const paymentLeft = c.captured - c.sent - c.inFlight;
      if (over.length || total > paymentLeft) {
        throw this.core.error('REFUND_EXCEEDS_REFUNDABLE', undefined, {
          items: c.items.filter((i) => input.items.some((x) => x.orderItemId === i.orderItemId)).map((i) => ({ orderItemId: i.orderItemId, remaining: this.m(i.remaining, currency) })),
          over,
          paymentRemaining: this.m(Math.max(0, paymentLeft), currency),
        });
      }
      const row = this.newRow({
        ref,
        orderId: input.orderId,
        intent: locked,
        origin: input.origin,
        originId: input.originId ?? null,
        originRef: input.originRef ?? null,
        amount: total,
        destination: input.destination,
        reason: input.reason.trim(),
        requestedBy,
        key: idempotencyKey,
      });
      const r = await tx.insertIfAbsent('refunds', row);
      if (!r) return null;
      await tx.insertMany(
        'refund_items',
        input.items.map((x) => {
          const cap = c.items.find((i) => i.orderItemId === x.orderItemId)!;
          return { refund_id: r.id, order_item_id: x.orderItemId, group_id: cap.groupId, seller_id: cap.sellerId, amount: x.amount.amount };
        }),
      );
      await this.log(tx, r.id, null, 'requested', `Handed over by ${input.origin}${input.originRef ? ` ${input.originRef}` : ''}`, requestedBy);
      return r;
    });
    if (!created) {
      // a concurrent hand-over with the same key or origin won
      const winner = (await this.repo.find('refunds', { idempotency_key: idempotencyKey }))[0] ?? (input.originId && input.origin !== 'cancellation' ? await this.byOrigin(this.repo, input.origin, input.originId) : undefined);
      if (!winner) throw new AppError('CONFLICT', 'The refund could not be started; try again');
      const items = await this.repo.find('refund_items', { refund_id: winner.id });
      if (winner.idempotency_key === idempotencyKey || this.sameContent(winner, items, input)) return this.toApi(winner);
      throw this.core.error('DUPLICATE_REFUND', undefined, { refundId: winner.id });
    }
    await this.publishChange(created, null, 'requested', { actor: requestedBy });
    if (created.destination === 'store_credit') await this.submit(created.id, { actor: SYSTEM }, cfg);
    return this.toApi((await this.repo.get('refunds', created.id))!, lookup, cfg);
  }

  private async byOrigin(repo: PaymentsRepository, origin: RefundRec['origin'], originId: string): Promise<RefundRec | undefined> {
    return (await repo.find('refunds', { origin, origin_id: originId, status: ['requested', 'processing', 'sent', 'failed'] }))[0];
  }

  /** The returns request reference when given (kept unique), else RF-YYMMDD-NNNN */
  private async refFor(requestRef: string | null | undefined): Promise<string> {
    const base = requestRef?.trim();
    if (!base) return this.core.nextRef('RF');
    for (let n = 1; n < 50; n++) {
      const ref = n === 1 ? base : `${base}-${n}`;
      if (!(await this.repo.find('refunds', { ref }))[0]) return ref;
    }
    return this.core.nextRef('RF');
  }

  private newRow(o: { ref: string; orderId: string | null; intent: IntentRec; origin: RefundRec['origin']; originId: string | null; originRef: string | null; amount: number; destination: string; reason: string; requestedBy: common.Actor; key: string }): RefundRec {
    const now = this.core.now();
    return {
      id: newId(),
      ref: o.ref,
      order_id: o.orderId,
      checkout_session_id: o.intent.checkout_session_id,
      intent_id: o.intent.id,
      origin: o.origin,
      origin_id: o.originId,
      origin_ref: o.originRef,
      amount: o.amount,
      currency: o.intent.currency,
      destination: o.destination,
      destination_label: o.destination === 'store_credit' ? STORE_CREDIT_LABEL : o.intent.method.label,
      status: refundExecutionMachine.initial,
      attempts: 0,
      outcome_unknown: false,
      failure_code: null,
      failure_reason: null,
      provider_ref: null,
      reason: o.reason,
      requested_by: o.requestedBy,
      idempotency_key: o.key,
      destination_ref: null,
      attempt_key: null,
      sent_at: null,
      last_attempt_at: null,
      next_attempt_at: null,
      created_at: now,
      updated_at: now,
    };
  }

  private async log(tx: PaymentsRepository, refundId: string, from: string | null, to: string, detail: string | null, actor: common.Actor, id: string = newId()): Promise<RefundLogRec> {
    return tx.insert('refund_log', { id, refund_id: refundId, from_status: from, to_status: to, detail, actor, at: this.core.now() });
  }

  private async publishChange(r: RefundRec, from: string | null, to: string, by: { actor?: common.Actor; requestId?: string }) {
    const items = await this.views.refundItems(r, await this.repo.find('refund_items', { refund_id: r.id }), this.core.lookup());
    this.core.publish('payments.refund.status_changed', { refundId: r.id, ref: r.ref, orderId: refundOrderKey(r), origin: r.origin, originId: r.origin_id, from, to, amount: this.m(r.amount, r.currency), items }, by);
  }

  /** orders.item.cancelled: a cancellation refund for the item's breakdown, or a smaller uncaptured authorization */
  async onItemCancelled(e: { orderId: string; groupId: string; itemId: string; cancellationId: string; initiatedBy: string; reasonCode: string; refund: { total: common.Money }; paymentIntentId: string }) {
    if (e.refund.total.amount <= 0) return;
    const lookup = this.core.lookup();
    const order = await lookup.order(e.orderId);
    const intent = await this.intents.intentOfOrder(e.orderId, e.paymentIntentId);
    if (!intent) return this.core.ctx.log.info({ orderId: e.orderId }, 'payments: cancelled item of an order without a payment');
    const captured = await this.capturedGroups(this.repo, intent);
    if (!captured.all && !captured.groups.has(e.groupId)) {
      // nothing charged for this group yet: the authorization (its allocation) shrinks by the item's card share, its
      // store-credit share goes back to the wallet, and an authorization with no card amount left is voided
      if (is(ACCEPTED, intent.status) || intent.status === 'pending_check') await this.intents.refreshAllocations(intent, order);
      await this.intents.onUncapturedItemCancelled(intent.id, e.itemId, order);
      return;
    }
    const paid = await this.paidAmounts(e.orderId);
    const actor: common.Actor = { kind: e.initiatedBy === 'customer' ? 'customer' : e.initiatedBy === 'seller' ? 'seller' : e.initiatedBy === 'staff' ? 'staff' : 'system', id: null };
    const reason = `Cancellation (${e.reasonCode.replace(/_/g, ' ')})`;
    // one refund per cancelled item: origin cancellation, originId = the cancellation, keyed by cancellation + item
    const key = `cancel:${e.cancellationId}:${e.itemId}`;
    const outcome = await this.repo.transaction(async (tx) => {
      const locked = (await tx.get('intents', intent.id, { forUpdate: true }))!;
      if ((await tx.find('refunds', { idempotency_key: key }))[0]) return null; // replayed event
      // refunds started before pass 3 grouped a cancellation's items in one refund
      for (const earlier of await tx.find('refunds', { origin: 'cancellation', origin_id: e.cancellationId })) {
        if ((await tx.find('refund_items', { refund_id: earlier.id, order_item_id: e.itemId })).length) return null;
      }
      const c = await this.caps(tx, e.orderId, locked, paid);
      const cap = c.items.find((i) => i.orderItemId === e.itemId);
      const amount = Math.min(e.refund.total.amount, cap?.remaining ?? 0, Math.max(0, c.captured - c.sent - c.inFlight));
      if (!cap || amount <= 0) {
        this.core.ctx.log.warn({ orderId: e.orderId, itemId: e.itemId }, 'payments: cancelled item has nothing left to refund');
        return null;
      }
      if (amount < e.refund.total.amount) this.core.ctx.log.warn({ orderId: e.orderId, itemId: e.itemId, asked: e.refund.total.amount, amount }, 'payments: cancellation refund capped at the remaining amount');
      const item: RefundItemRec = { refund_id: '', order_item_id: e.itemId, group_id: cap.groupId, seller_id: cap.sellerId, amount };
      const r = await tx.insertIfAbsent(
        'refunds',
        this.newRow({ ref: await this.core.nextRef('RF', tx), orderId: e.orderId, intent: locked, origin: 'cancellation', originId: e.cancellationId, originRef: null, amount, destination: 'original_method', reason, requestedBy: actor, key }),
      );
      if (!r) return null;
      await tx.insert('refund_items', { ...item, refund_id: r.id });
      await this.log(tx, r.id, null, 'requested', `Started by an item cancellation (${order?.items.get(e.itemId)?.title ?? 'item'})`, actor);
      return r;
    });
    if (outcome) await this.publishChange(outcome, null, 'requested', { actor });
  }

  /** Refund of money captured without an order (orphan payment); the checkout session stands in for the order */
  async startOrphanRefund(intent: IntentRec, by: By, reason: string): Promise<RefundRec | null> {
    const ref = await this.core.nextRef('RF');
    const created = await this.repo.transaction(async (tx) => {
      const locked = (await tx.get('intents', intent.id, { forUpdate: true }))!;
      const existing = await this.byOrigin(tx, 'orphan_payment', locked.id);
      if (existing) return { r: existing, fresh: false };
      const totals = await tx.intentRefundTotals(locked.id);
      const amount = locked.captured_amount - totals.sent - totals.inFlight;
      if (amount <= 0) return null;
      const r = await tx.insertIfAbsent(
        'refunds',
        this.newRow({ ref, orderId: locked.order_id, intent: locked, origin: 'orphan_payment', originId: locked.id, originRef: locked.ref, amount, destination: 'original_method', reason, requestedBy: by.actor, key: `orphan:${locked.id}` }),
      );
      if (!r) return null;
      await this.log(tx, r.id, null, 'requested', 'Payment without an order', by.actor);
      return { r, fresh: true };
    });
    if (!created) return null;
    if (created.fresh) await this.publishChange(created.r, null, 'requested', by);
    return created.r;
  }

  /* ---------------------------------------------------------------- execution */

  /**
   * The provider key of the attempt in flight: refunds.attempt_key, stored with the move to processing before the
   * provider is called (refunds from before it was stored: the log entry that moved the refund to processing)
   */
  private async attemptKey(r: RefundRec): Promise<string | null> {
    if (r.attempt_key) return r.attempt_key;
    const logs = await this.repo.find('refund_log', { refund_id: r.id, to_status: 'processing' }, { orderBy: [['at', 'desc']], limit: 1 });
    return logs[0] ? `refund:${logs[0].id}` : null;
  }

  /** The customer-chosen destination stored on the refund (refunds.destination_ref), for sends, checks and retries */
  static destinationRef(d: RefundDestination | null): string | null {
    if (d?.methodId) return `method:${d.methodId}`;
    if (d?.token) return `token:${d.token}`;
    return null;
  }

  static destinationOf(ref: string | null | undefined): RefundDestination | null {
    if (ref?.startsWith('method:')) return { methodId: ref.slice('method:'.length) };
    if (ref?.startsWith('token:')) return { token: ref.slice('token:'.length) };
    return null;
  }

  /** requested → processing, then send (the store-credit part goes through wallet) */
  async submit(refundId: string, by: By, cfg?: Cfg): Promise<RefundRec> {
    const moved = await this.move(refundId, 'submit', by, 'Sent to the provider', { attemptsDelta: 1, newAttempt: true });
    if (!moved) return this.get(refundId);
    return this.send(moved.r, by, cfg ?? (await this.core.cfg()));
  }

  /** One transition with its log entry; null when the refund is no longer in a state that allows it */
  private async move(
    refundId: string,
    event: REv,
    by: By,
    detail: string | null,
    o: { attemptsDelta?: number; resetAttempts?: boolean; patch?: Partial<RefundRec>; publish?: boolean; strict?: boolean; newAttempt?: boolean } = {},
  ): Promise<{ r: RefundRec; from: RefundStatus; logId: string } | null> {
    const res = await this.repo.transaction(async (tx) => {
      const r = await tx.get('refunds', refundId, { forUpdate: true });
      if (!r) throw notFound('Refund');
      if (!refundExecutionMachine.can(r.status as never, event)) {
        if (o.strict) refundExecutionMachine.next(r.status as never, event);
        return null;
      }
      const to = refundExecutionMachine.next(r.status as never, event);
      const now = this.core.now();
      const attempts = o.resetAttempts ? (o.attemptsDelta ?? 0) : r.attempts + (o.attemptsDelta ?? 0);
      // a new provider attempt: its key is stored before the provider is called, so a check or retry after a restart
      // asks about this attempt
      const logId = newId();
      const updated = await tx.update('refunds', r.id, {
        ...o.patch,
        ...(o.newAttempt ? { attempt_key: `refund:${logId}` } : {}),
        status: to,
        attempts,
        ...(to === 'processing' ? { last_attempt_at: now, outcome_unknown: false, failure_code: null, failure_reason: null, next_attempt_at: null } : {}),
        updated_at: now,
      });
      const log = await this.log(tx, r.id, r.status, to, detail, by.actor, logId);
      return { r: updated, from: r.status as RefundStatus, logId: log.id };
    });
    if (res && o.publish !== false) await this.publishChange(res.r, res.from, res.r.status, by);
    return res;
  }

  /**
   * Sends the attempt in flight (refunds.attempt_key) to the refund's destination (the original payment, or the
   * customer's choice in refunds.destination_ref) and applies the answer
   */
  private async send(r: RefundRec, by: By, cfg: Cfg): Promise<RefundRec> {
    const attemptKey = (await this.attemptKey(r)) ?? `refund:${newId()}`;
    const destination = Refunds.destinationOf(r.destination_ref);
    const intent = (await this.repo.get('intents', r.intent_id))!;
    const creditUnavailable: ProviderRefund = { status: 'failed', failure: { code: 'store_credit_unavailable', reason: 'Store credit could not be added right now', retryable: true } };
    // a mixed payment: the store-credit part goes back first (reserved once per refund, so a retry sends the same split)
    const key = refundKey(r.id);
    const share = this.credit.tender(intent) ? await this.credit.reserve(intent.id, key, r.amount) : { amount: 0, sent: true };
    if (r.destination === 'store_credit') {
      // all of it to store credit: wallet gives the order's credit back first and adds the rest as a refund to credit
      const credited = await this.core.soft('wallet', 'creditRefund', (w) =>
        w.creditRefund({ customerId: intent.customer_id!, refundId: r.id, orderId: refundOrderKey(r), amount: this.m(r.amount, r.currency), reason: r.reason }, `refund:${r.id}`),
      );
      if (credited && !share.sent) await this.credit.confirm(intent.id, key);
      return this.apply(r.id, credited ? { status: 'succeeded', providerRef: credited.id ?? null } : creditUnavailable, by, cfg);
    }
    let creditEntry: string | null = null;
    if (!share.sent) {
      try {
        creditEntry = await this.credit.giveBack(intent, key, share, r.reason);
      } catch (err) {
        if (!isAppError(err)) throw err;
        this.core.ctx.log.warn({ err, refundId: r.id }, 'payments: the store-credit part of a refund could not be given back');
        return this.apply(r.id, creditUnavailable, by, cfg);
      }
    }
    const cardAmount = r.amount - share.amount;
    if (cardAmount <= 0) return this.apply(r.id, { status: 'succeeded', providerRef: creditEntry }, by, cfg); // all of it was store credit
    if (r.destination === 'original_method' && !intent.provider_ref) {
      return this.apply(r.id, { status: 'failed', failure: { code: 'no_payment', reason: 'The original payment has no processor reference', retryable: false } }, by, cfg);
    }
    try {
      const result = await this.core.call(
        'refund',
        { intentId: intent.id, refundId: r.id },
        () => this.core.provider.refund({ providerRef: intent.provider_ref ?? '', amount: this.m(cardAmount, r.currency), idempotencyKey: attemptKey, destination, refundId: r.id }),
        (x) => ({ outcome: x.status === 'failed' ? 'declined' : 'ok', providerRef: x.providerRef, message: x.failure ? `${x.failure.code}: ${x.failure.reason}` : `refund ${x.status}` }),
      );
      return this.apply(r.id, result, by, cfg);
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err;
      if (err.uncertain) return this.markUnknown(r.id);
      // not reached: nothing was sent; a retry is safe
      return this.apply(r.id, { status: 'failed', failure: { code: 'provider_unavailable', reason: 'The payment provider was unavailable', retryable: true } }, by, cfg);
    }
  }

  private async markUnknown(refundId: string): Promise<RefundRec> {
    const now = this.core.now();
    const r = await this.get(refundId);
    if (r.status !== 'processing') return r;
    return this.repo.update('refunds', refundId, { outcome_unknown: true, next_attempt_at: new Date(now.getTime() + refundBackoffMs(0)), updated_at: now });
  }

  /** Applies the provider's answer about the attempt in flight; publishes sent / failed once */
  private async apply(refundId: string, p: ProviderRefund, by: By, cfg: Cfg): Promise<RefundRec> {
    const batch = new Batch();
    let changed: { r: RefundRec; from: RefundStatus } | null = null;
    const pre = await this.repo.get('refunds', refundId);
    const payer = pre ? await this.repo.get('intents', pre.intent_id) : undefined;
    const lookup = this.core.lookup();
    const who = payer ? await this.core.contactOf({ customer_id: payer.customer_id, guest_email: payer.guest_email, order_id: pre!.order_id }, lookup) : { customerId: null, contactEmail: null };
    // refund notices link to the order screen: they carry its reference, not the refund's RF- reference
    const orderRef = (await lookup.order(pre?.order_id))?.ref ?? null;
    const after = await this.repo.transaction(async (tx) => {
      const r = (await tx.get('refunds', refundId, { forUpdate: true }))!;
      if (r.status !== 'processing') return r;
      const now = this.core.now();
      if (p.status === 'pending') {
        return tx.update('refunds', r.id, { outcome_unknown: false, provider_ref: p.providerRef ?? r.provider_ref, next_attempt_at: new Date(now.getTime() + refundBackoffMs(0)), updated_at: now });
      }
      if (p.status === 'not_found') return r;
      if (p.status === 'succeeded') {
        const to = refundExecutionMachine.next('processing', 'provider_confirms');
        // sent: the chosen destination and the attempt key are no longer needed
        const updated = await tx.update('refunds', r.id, { status: to, sent_at: now, provider_ref: p.providerRef ?? r.provider_ref, outcome_unknown: false, next_attempt_at: null, failure_code: null, failure_reason: null, destination_ref: null, attempt_key: null, updated_at: now });
        // the intent lock is taken after the refund lock everywhere a refund changes the intent
        const intent = (await tx.get('intents', r.intent_id, { forUpdate: true }))!;
        await tx.update('intents', intent.id, { refunded_amount: intent.refunded_amount + r.amount, updated_at: now });
        await this.log(tx, r.id, 'processing', to, r.destination === 'store_credit' ? 'Store credit added' : `Sent to ${r.destination_label}`, by.actor);
        changed = { r: updated, from: 'processing' };
        return updated;
      }
      const f = p.failure ?? { code: 'failed', reason: 'The provider could not send the refund', retryable: true };
      const to = refundExecutionMachine.next('processing', 'provider_fails');
      const retryable = f.retryable && retryableRefundFailure(f.code) && r.destination !== 'new_method';
      const final = !(retryable && r.attempts < cfg.refundMaxAttempts);
      const updated = await tx.update('refunds', r.id, {
        status: to,
        outcome_unknown: false,
        failure_code: f.code,
        failure_reason: f.reason,
        provider_ref: p.providerRef ?? r.provider_ref,
        next_attempt_at: final ? null : new Date(now.getTime() + refundBackoffMs(r.attempts)),
        updated_at: now,
      });
      await this.log(tx, r.id, 'processing', to, f.reason, by.actor);
      batch.push('payments.refund.failed', { refundId: r.id, ref: r.ref, orderId: refundOrderKey(r), orderRef, ...who, origin: r.origin, originId: r.origin_id, amount: this.m(r.amount, r.currency), reason: f.reason, attempts: r.attempts, finalAttempt: final });
      changed = { r: updated, from: 'processing' };
      return updated;
    });
    const c = changed as { r: RefundRec; from: RefundStatus } | null;
    if (c) {
      await this.publishChange(c.r, c.from, c.r.status, by);
      if (c.r.status === 'sent') {
        const items = await this.views.refundItems(c.r, await this.repo.find('refund_items', { refund_id: c.r.id }), this.core.lookup());
        this.core.publish('payments.refund.sent', { refundId: c.r.id, ref: c.r.ref, orderId: refundOrderKey(c.r), orderRef, ...who, origin: c.r.origin, originId: c.r.origin_id, amount: this.m(c.r.amount, c.r.currency), items, destination: c.r.destination, sentAt: c.r.sent_at!.toISOString() }, by);
      }
    }
    this.core.flush(batch, by);
    return after;
  }

  /**
   * Asks the provider about the attempt in flight (admin Check, the refund job, webhooks). An attempt the
   * provider never received is sent again with the same key; nothing is sent twice.
   */
  async check(refundId: string, by: By, cfg?: Cfg): Promise<RefundRec> {
    const c = cfg ?? (await this.core.cfg());
    const r = await this.get(refundId);
    if (r.status !== 'processing' && r.status !== 'failed') return r;
    const key = await this.attemptKey(r);
    if (!key || r.destination === 'store_credit') {
      if (r.status === 'processing' && r.destination === 'store_credit') return this.send(r, by, c);
      return r;
    }
    let p: ProviderRefund;
    try {
      p = await this.core.call('retrieve', { intentId: r.intent_id, refundId: r.id }, () => this.core.provider.retrieveRefund({ idempotencyKey: key }), (x) => ({ outcome: 'ok', providerRef: x.providerRef, message: `refund ${x.status}` }));
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err;
      const now = this.core.now();
      return this.repo.update('refunds', r.id, { last_attempt_at: now, next_attempt_at: r.status === 'processing' ? new Date(now.getTime() + refundBackoffMs(1)) : r.next_attempt_at, updated_at: now });
    }
    await this.repo.update('refunds', r.id, { last_attempt_at: this.core.now() });
    if (r.status === 'failed') {
      // the attempt marked failed was sent after all: failed → processing → sent
      if (p.status !== 'succeeded') return this.get(r.id);
      const moved = await this.move(r.id, 'retry', by, 'The provider confirmed the earlier attempt');
      if (!moved) return this.get(r.id);
      return this.apply(r.id, p, by, c);
    }
    if (p.status === 'not_found') {
      if (r.destination === 'new_method' && !r.destination_ref) {
        // chosen before destinations were stored: there is nothing to send it to again
        return this.apply(r.id, { status: 'failed', failure: { code: 'destination_needed', reason: 'The refund did not reach the new card; choose where it should go', retryable: false } }, by, c);
      }
      return this.send(r, by, c); // never received: the same key again, to the same destination
    }
    return this.apply(r.id, p, by, c);
  }

  /**
   * failed → processing after confirming with the provider that the earlier attempt was not sent.
   * Admin retries are capped at refundMaxAttempts; an unknown outcome must be checked first.
   */
  async retry(refundId: string, by: By, reason: string | null, o: { admin: boolean }): Promise<RefundRec> {
    const cfg = await this.core.cfg();
    const r = await this.get(refundId);
    if (r.status === 'processing' && r.outcome_unknown) throw this.core.error('REFUND_OUTCOME_UNKNOWN');
    if (r.status !== 'failed') refundExecutionMachine.next(r.status as never, 'retry'); // ILLEGAL_TRANSITION
    if (r.attempts >= cfg.refundMaxAttempts) throw this.core.error('REFUND_RETRY_LIMIT');
    if (r.destination === 'new_method') throw illegal('A refund to a new card is retried by asking the customer for a destination again');
    const key = await this.attemptKey(r);
    if (key && r.destination !== 'store_credit') {
      let p: ProviderRefund;
      try {
        p = await this.core.call('retrieve', { intentId: r.intent_id, refundId: r.id }, () => this.core.provider.retrieveRefund({ idempotencyKey: key }), (x) => ({ outcome: 'ok', providerRef: x.providerRef, message: `refund ${x.status}` }));
      } catch (err) {
        if (!(err instanceof ProviderError)) throw err;
        if (o.admin) throw this.core.error('REFUND_OUTCOME_UNKNOWN', 'The provider did not answer about the earlier attempt; check again before retrying.');
        return r;
      }
      if (p.status === 'succeeded' || p.status === 'pending') {
        const moved = await this.move(r.id, 'retry', by, 'The provider confirmed the earlier attempt');
        if (!moved) return this.get(r.id);
        return this.apply(r.id, p, by, cfg);
      }
    }
    const moved = await this.move(r.id, 'retry', by, reason ? `Retried: ${reason}` : 'Retried', { attemptsDelta: 1, strict: o.admin, newAttempt: true });
    if (!moved) return this.get(r.id);
    return this.send(moved.r, by, cfg);
  }

  /** payments.process-refunds */
  async processRefunds(): Promise<void> {
    const cfg = await this.core.cfg();
    const now = this.core.now();
    const by: By = { actor: SYSTEM };
    const requested = await this.repo.find('refunds', { status: 'requested' }, { orderBy: [['created_at', 'asc']], limit: 50 });
    for (const r of requested) {
      if (r.next_attempt_at && r.next_attempt_at > now) continue;
      await this.submit(r.id, by, cfg).catch((err) => this.core.ctx.log.warn({ err, refundId: r.id }, 'payments: refund not submitted'));
    }
    const processing = await this.repo.find('refunds', { status: 'processing', next_attempt_at: { op: '<=', value: now } }, { orderBy: [['next_attempt_at', 'asc']], limit: 50 });
    for (const r of processing) await this.check(r.id, by, cfg).catch((err) => this.core.ctx.log.warn({ err, refundId: r.id }, 'payments: refund check failed'));
    const failed = await this.repo.find('refunds', { status: 'failed', next_attempt_at: { op: '<=', value: now } }, { orderBy: [['next_attempt_at', 'asc']], limit: 50 });
    for (const r of failed) {
      if (!retryableRefundFailure(r.failure_code) || r.attempts >= cfg.refundMaxAttempts || r.destination === 'new_method') {
        await this.repo.update('refunds', r.id, { next_attempt_at: null });
        continue;
      }
      await this.retry(r.id, by, null, { admin: false }).catch((err) => this.core.ctx.log.warn({ err, refundId: r.id }, 'payments: refund retry failed'));
    }
  }

  /* ---------------------------------------------------------------- reads */

  async toApi(r: RefundRec, lookup: Lookup = this.core.lookup(), cfg?: Cfg): Promise<Refund> {
    const [items, logs, intent] = await Promise.all([this.repo.find('refund_items', { refund_id: r.id }), this.repo.find('refund_log', { refund_id: r.id }, { orderBy: [['at', 'asc']] }), this.repo.get('intents', r.intent_id)]);
    return this.views.refund(r, items, logs, intent!, lookup, cfg ?? (await this.core.cfg()));
  }

  async getRefund(refundId: string): Promise<Refund | null> {
    const r = await this.repo.get('refunds', refundId);
    return r ? this.toApi(r) : null;
  }

  async listForOrder(orderId: string): Promise<Refund[]> {
    const rows = await this.repo.find('refunds', { order_id: orderId }, { orderBy: [['created_at', 'desc']] });
    return this.views.refunds(rows, this.core.lookup(), await this.core.cfg());
  }

  async listAdmin(q: { status?: string; failing?: boolean; origin?: string; orderId?: string; q?: string }, page: PageRequest): Promise<common.Page<Refund>> {
    const res = await this.repo.listRefunds(q, page);
    return { ...res, items: await this.views.refunds(res.items, this.core.lookup(), await this.core.cfg()) };
  }

  async adminCheck(refundId: string, by: By): Promise<Refund> {
    return this.toApi(await this.check(refundId, by));
  }

  /** Manual money action: limits and step-up through access (Core.manual, payments.payments.correct, the refund amount) */
  async adminRetry(refundId: string, reason: string, by: By, o: { reauthToken?: string | null; approvedBy?: string | null } = {}): Promise<Refund> {
    if (!reason?.trim()) throw invalid([{ path: 'reason', message: 'Give a reason' }]);
    const before = await this.get(refundId);
    const amount = this.m(before.amount, before.currency);
    const op = { kind: 'refund_retry' as const, id: before.id, ref: before.ref, label: before.destination_label, summary: `Retry refund ${before.ref} of ${format(amount)}`, amount, reason: reason.trim() };
    return this.core.manual(op, by, o, async () => {
      const after = await this.retry(refundId, by, reason, { admin: true });
      await this.core.audit({ action: 'payments.refund.retry', actionLabel: 'Retried a failed refund', category: 'financial', target: { type: 'refund', id: before.id, ref: before.ref, label: before.destination_label, screen: 'admin/finance' }, reason, before: { status: before.status, attempts: before.attempts }, after: { status: after.status, attempts: after.attempts }, approvalRequestId: o.approvedBy ?? null }, by);
      return this.toApi(after);
    });
  }

  async requestDestination(refundId: string, message: string | null | undefined, by: By): Promise<Refund> {
    const r = await this.get(refundId);
    if (r.status !== 'failed') throw illegal('Only a failed refund can be sent somewhere else', { status: r.status });
    const after = await this.repo.transaction(async (tx) => {
      const x = (await tx.get('refunds', refundId, { forUpdate: true }))!;
      if (x.status !== 'failed') throw illegal('Only a failed refund can be sent somewhere else', { status: x.status });
      await this.log(tx, x.id, 'failed', 'failed', `Asked the customer for a new destination${message?.trim() ? `: ${message.trim()}` : ''}`, by.actor);
      return tx.update('refunds', x.id, { next_attempt_at: null, updated_at: this.core.now() });
    });
    const lookup = this.core.lookup();
    const [order, payer] = await Promise.all([lookup.order(r.order_id), this.repo.get('intents', r.intent_id)]);
    const who = payer ? await this.core.contactOf({ customer_id: payer.customer_id, guest_email: payer.guest_email, order_id: r.order_id }, lookup) : { customerId: null, contactEmail: null };
    this.core.publish(
      'payments.refund.destination_requested',
      { refundId: r.id, ref: r.ref, orderId: refundOrderKey(r), orderRef: order?.ref ?? r.origin_ref ?? r.ref, ...who, amount: this.m(r.amount, r.currency), failureReason: r.failure_reason ?? null, message: message?.trim() || null },
      by,
    );
    await this.core.audit({ action: 'payments.refund.request_destination', actionLabel: 'Asked the customer for a new refund destination', category: 'financial', target: { type: 'refund', id: r.id, ref: r.ref, label: r.destination_label, screen: 'admin/finance' }, reason: message ?? null }, by);
    return this.toApi(after);
  }

  /** Manual money action: limits and step-up through access (Core.manual, payments.payments.correct, the refund amount) */
  async cancel(refundId: string, reason: string, by: By, o: { reauthToken?: string | null; approvedBy?: string | null } = {}): Promise<Refund> {
    if (!reason?.trim()) throw invalid([{ path: 'reason', message: 'Give a reason, e.g. settled another way' }]);
    const before = await this.get(refundId);
    refundExecutionMachine.next(before.status as RefundStatus, 'cancel'); // ILLEGAL_TRANSITION before asking anyone to approve
    const amount = this.m(before.amount, before.currency);
    const op = { kind: 'refund_cancel' as const, id: before.id, ref: before.ref, label: before.destination_label, summary: `Cancel refund ${before.ref} of ${format(amount)}`, amount, reason: reason.trim() };
    return this.core.manual(op, by, o, async () => {
      const moved = await this.move(refundId, 'cancel', by, `Cancelled: ${reason.trim()}`, { strict: true, patch: { next_attempt_at: null, destination_ref: null, attempt_key: null } });
      const after = moved?.r ?? (await this.get(refundId));
      if (after.status === 'cancelled') await this.credit.unreserve(after.intent_id, refundKey(after.id)); // a store-credit part not given back yet is free again
      await this.core.audit({ action: 'payments.refund.cancel', actionLabel: 'Cancelled a refund', category: 'financial', target: { type: 'refund', id: before.id, ref: before.ref, label: before.destination_label, screen: 'admin/finance' }, reason, before: { status: before.status, amount: before.amount }, after: { status: after.status }, approvalRequestId: o.approvedBy ?? null }, by);
      return this.toApi(after);
    });
  }

  /* ---------------------------------------------------------------- store */

  /** The refund if the shopper owns its payment (customer) or may open its order (guest session) */
  async ownRefund(refundId: string, scope: Scope): Promise<RefundRec> {
    const r = await this.repo.get('refunds', refundId);
    if (!r) throw notFound('Refund');
    const intent = await this.repo.get('intents', r.intent_id);
    if (!intent) throw notFound('Refund');
    if (scope.kind === 'customer') {
      if (scope.customerId && intent.customer_id === scope.customerId) return r;
      throw notFound('Refund');
    }
    if (scope.kind === 'visitor' && !intent.customer_id) {
      const order = await this.core.lookup().order(r.order_id);
      const visible = order ? await this.core.ctx.use('orders').getOrderForViewer({ guestSessionId: scope.visitorSessionId }, order.ref).catch(() => null) : null;
      if (visible) return r;
    }
    throw notFound('Refund');
  }

  async view(r: RefundRec): Promise<RefundView> {
    const [items, intent, cfg] = await Promise.all([this.repo.find('refund_items', { refund_id: r.id }), this.repo.get('intents', r.intent_id), this.core.cfg()]);
    return this.views.refundView(r, items, this.core.lookup(), cfg, intent!);
  }

  async listMine(customerId: string | null, orderId: string | undefined, page: PageRequest): Promise<common.Page<RefundView>> {
    if (!customerId) return { items: [], nextCursor: null, ...(page.mode === 'page' ? { page: page.page, totalPages: 1, total: 0 } : {}) };
    const res = await this.repo.listRefunds({ customerId, orderId }, page);
    return { ...res, items: await this.views.refundViews(res.items, this.core.lookup(), await this.core.cfg()) };
  }

  /** The customer chooses where a failed refund goes instead; sent right away */
  async chooseDestination(refundId: string, scope: Scope, body: { savedMethodId?: string | null; providerToken?: string | null; storeCredit?: boolean | null }, by: By): Promise<RefundView> {
    const r = await this.ownRefund(refundId, scope);
    const chosen = [body.savedMethodId ? 1 : 0, body.providerToken ? 1 : 0, body.storeCredit ? 1 : 0].reduce((a, b) => a + b, 0);
    if (chosen !== 1) throw invalid([{ path: 'body', message: 'Choose one: a saved card, a new card or store credit' }]);
    if (r.status !== 'failed') throw illegal('A new destination can be chosen only after a refund failed', { status: r.status });
    const intent = (await this.repo.get('intents', r.intent_id))!;
    const cfg = await this.core.cfg();
    let destination: RefundDestination | null = null;
    let kind: 'new_method' | 'store_credit' = 'new_method';
    let label: string;
    if (body.storeCredit) {
      if (!this.core.ctx.tryUse('wallet') || !intent.customer_id) throw this.core.error('PAYMENT_METHOD_INVALID', 'Store credit is not available for this refund.');
      kind = 'store_credit';
      label = STORE_CREDIT_LABEL;
    } else if (body.savedMethodId) {
      const m = await this.repo.get('saved_methods', body.savedMethodId);
      if (!m || m.removed_at || scope.kind !== 'customer' || m.customer_id !== scope.customerId) throw this.core.error('PAYMENT_METHOD_INVALID', 'This saved card cannot be used.');
      if (isExpired(m.exp_month, m.exp_year, this.core.today())) throw this.core.error('PAYMENT_METHOD_INVALID', 'This card has expired. Update it or choose another one.');
      destination = { methodId: m.provider_method_id };
      label = methodLabel(m);
    } else {
      let card;
      try {
        card = await this.core.provider.describeToken(body.providerToken!.trim());
      } catch (err) {
        return this.core.unavailable(err);
      }
      if (!card) throw this.core.error('PAYMENT_METHOD_INVALID', 'These card details cannot be used.');
      destination = { token: body.providerToken!.trim() };
      label = methodLabel(card);
    }
    // the destination is stored with the move (before the provider is called), so an uncertain send is checked and
    // resent to the same destination after a restart
    const moved = await this.move(r.id, 'retry', by, `New destination: ${label}`, { attemptsDelta: 1, resetAttempts: true, strict: true, newAttempt: true, patch: { destination: kind, destination_label: label, destination_ref: Refunds.destinationRef(destination) } });
    if (!moved) throw illegal('A new destination can be chosen only after a refund failed');
    await this.send(moved.r, by, cfg);
    return this.view(await this.get(r.id));
  }
}

export type { OrderInfo };
