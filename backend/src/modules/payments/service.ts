import type { Scope } from '../../kernel/auth/scope.js';
import type { EventPayload } from '../../kernel/events/index.js';
import type { PageRequest } from '../../kernel/lib/pagination.js';
import type * as common from '../../spec/common.js';
import type {
  Allocation,
  AuthorizeInput,
  AuthorizeResult,
  Dispute,
  OrderPaymentSummary,
  PaymentDetail,
  PaymentOptions,
  PaymentRow,
  PaymentsPublicApi,
  PaymentStatusView,
  Refund,
  RefundableSummary,
  RefundView,
  SavedPaymentMethod,
  StartRefundInput,
} from '../../spec/payments.js';
import { ACCEPTED, customerState, is } from './domain/rules.js';
import type { IntentRec } from './ports.js';
import { Core, MANUAL_ACTION, SYSTEM, notFound, type By, type PaymentsServiceDeps } from './service/core.js';
import { Credit } from './service/credit.js';
import { Disputes } from './service/disputes.js';
import { Intents } from './service/intents.js';
import { Methods } from './service/methods.js';
import { Refunds } from './service/refunds.js';
import { Views } from './service/views.js';
import { Webhooks } from './service/webhooks.js';

export type { PaymentsServiceDeps };

/**
 * Payments use cases. Depends only on its repository, the payment provider, the event bus, the clock and other modules' public APIs.
 * The work is split by area (service/*.ts); this class is the module's public API, its event consumers, jobs
 * and the entry points of the HTTP handlers.
 */
export class PaymentsService implements PaymentsPublicApi {
  readonly core: Core;
  readonly views: Views;
  readonly credit: Credit;
  readonly intents: Intents;
  readonly refunds: Refunds;
  readonly disputes: Disputes;
  readonly methods: Methods;
  readonly webhooks: Webhooks;

  constructor(deps: PaymentsServiceDeps) {
    this.core = new Core(deps);
    this.views = new Views(this.core);
    this.credit = new Credit(this.core);
    this.intents = new Intents(this.core, this.views, this.credit);
    this.refunds = new Refunds(this.core, this.views, this.intents, this.credit);
    this.disputes = new Disputes(this.core, this.views);
    this.methods = new Methods(this.core, this.views);
    this.webhooks = new Webhooks(this.core, this.intents, this.refunds, this.disputes, this.methods);
    this.intents.startOrphanRefund = (i, by, reason) => this.refunds.startOrphanRefund(i, by, reason);
    this.intents.saveForLater = (customerId, token, label, billing) => this.methods.saveForLater(customerId, token, label, billing);
  }

  /* ---------------------------------------------------------------- public API (in-process) */

  listOptions(owner: { customerId?: string; guestSessionId?: string }, amount: common.Money): Promise<PaymentOptions> {
    return this.methods.listOptions(owner, amount);
  }

  authorize(input: AuthorizeInput, idempotencyKey: string): Promise<AuthorizeResult> {
    return this.intents.authorize(input, idempotencyKey);
  }

  linkOrder(intentId: string, orderId: string, allocations: Allocation[]): Promise<void> {
    return this.intents.linkOrder(intentId, orderId, allocations);
  }

  completeAction(intentId: string, resultToken: string, idempotencyKey: string): Promise<AuthorizeResult> {
    return this.intents.completeAction(intentId, resultToken, idempotencyKey);
  }

  getIntentStatus(intentId: string, refresh?: boolean): Promise<PaymentStatusView> {
    return this.intents.getIntentStatus(intentId, refresh ?? false);
  }

  async voidIntent(intentId: string, reason: string): Promise<void> {
    await this.intents.void(intentId, reason, { actor: SYSTEM });
  }

  remainingRefundable(orderId: string, orderItemIds?: string[]): Promise<RefundableSummary> {
    return this.refunds.remainingRefundable(orderId, orderItemIds);
  }

  startRefund(input: StartRefundInput, idempotencyKey: string): Promise<Refund> {
    return this.refunds.startRefund(input, idempotencyKey);
  }

  getRefund(refundId: string): Promise<Refund | null> {
    return this.refunds.getRefund(refundId);
  }

  async methodLabel(intentId: string): Promise<string> {
    return (await this.intents.get(intentId)).method.label;
  }

  async getPaymentForOrder(orderId: string): Promise<PaymentDetail | null> {
    const i = await this.intents.intentOfOrder(orderId);
    return i ? this.intents.detail(i) : null;
  }

  listRefundsForOrder(orderId: string): Promise<Refund[]> {
    return this.refunds.listForOrder(orderId);
  }

  listDisputesForOrder(orderId: string): Promise<Dispute[]> {
    return this.disputes.listForOrder(orderId);
  }

  listSavedMethods(customerId: string): Promise<SavedPaymentMethod[]> {
    return this.methods.listSavedMethods(customerId);
  }

  /** Payments that failed after their order was placed, since `since` (account overview payment_failed alert) */
  listFailedPaymentsForCustomer(customerId: string, since: string): Promise<PaymentStatusView[]> {
    return this.intents.listFailedForCustomer(customerId, new Date(since));
  }

  /**
   * Export hook (FORMAT.md, Customer data export hook): saved methods masked (never a provider token), the
   * customer's payments and their refunds. No provider references or staff notes.
   */
  async exportCustomerData(input: { customerId: string; accountId: string }): Promise<common.CustomerDataSection[]> {
    const repo = this.core.repo;
    const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
    const money = (amount: number, currency: string) => ({ amount, currency });
    const [methods, intents] = await Promise.all([
      repo.find('saved_methods', { customer_id: input.customerId }, { orderBy: [['created_at', 'asc']] }),
      repo.find('intents', { customer_id: input.customerId }, { orderBy: [['created_at', 'asc']] }),
    ]);
    const refunds = intents.length ? await repo.find('refunds', { intent_id: intents.map((i) => i.id) }, { orderBy: [['created_at', 'asc']] }) : [];
    const lookup = this.core.lookup();
    const orderRef = async (orderId: string | null) => (orderId ? ((await lookup.order(orderId))?.ref ?? null) : null);
    return [
      {
        key: 'payment_methods',
        title: 'Saved payment methods',
        module: 'payments',
        records: methods.map((m) => ({
          kind: m.kind,
          brand: m.brand,
          label: m.label,
          last4: m.last4,
          expires: `${String(m.exp_month).padStart(2, '0')}/${m.exp_year}`,
          billingCity: m.billing_address?.city ?? null,
          billingPostalCode: m.billing_address?.postalCode ?? null,
          isDefault: m.is_default,
          savedAt: m.created_at.toISOString(),
          removedAt: iso(m.removed_at),
        })),
      },
      {
        key: 'payments',
        title: 'Payments',
        module: 'payments',
        records: await Promise.all(
          intents.map(async (i) => ({
            ref: i.ref,
            orderRef: await orderRef(i.order_id),
            amount: money(i.amount, i.currency),
            method: i.method.label,
            status: i.status,
            declined: i.decline ? i.decline.message : null,
            authorizedAt: iso(i.authorized_at),
            captured: money(i.captured_amount, i.currency),
            capturedAt: iso(i.captured_at),
            refunded: money(i.refunded_amount, i.currency),
            createdAt: i.created_at.toISOString(),
          })),
        ),
      },
      {
        key: 'refunds',
        title: 'Refunds',
        module: 'payments',
        records: await Promise.all(
          refunds.map(async (r) => ({
            ref: r.ref,
            orderRef: await orderRef(r.order_id),
            origin: r.origin,
            amount: money(r.amount, r.currency),
            destination: r.destination_label,
            status: r.status,
            requestedAt: r.created_at.toISOString(),
            sentAt: iso(r.sent_at),
          })),
        ),
      },
    ];
  }

  /* ---------------------------------------------------------------- store */

  /** The intent if the shopper owns its checkout: the customer, or the guest session (checkout or order access) */
  async ownIntent(intentId: string, scope: Scope, customerId: string | null): Promise<IntentRec> {
    const i = await this.core.repo.get('intents', intentId);
    if (!i) throw notFound();
    if (scope.kind === 'customer' && customerId && i.customer_id === customerId) return i;
    if (scope.kind === 'visitor' && !i.customer_id) {
      const guestSessionId = scope.visitorSessionId;
      const session = await this.core.soft('checkout', 'getSessionView', (c) => c.getSessionView({ guestSessionId }, i.checkout_session_id));
      if (session) return i;
      const order = await this.core.lookup().order(i.order_id);
      const visible = order ? await this.core.ctx.use('orders').getOrderForViewer({ guestSessionId }, order.ref).catch(() => null) : null;
      if (visible) return i;
    }
    throw notFound();
  }

  async storeStatus(intentId: string, scope: Scope, customerId: string | null, check: boolean): Promise<PaymentStatusView> {
    await this.ownIntent(intentId, scope, customerId);
    return this.intents.getIntentStatus(intentId, check, check);
  }

  /* ---------------------------------------------------------------- admin payments */

  async listPayments(q: { q?: string; status?: string; flag?: string; from?: string; to?: string }, page: PageRequest): Promise<common.Page<PaymentRow>> {
    let orderIds: string[] = [];
    const term = q.q?.trim();
    if (term && /^[A-Z]{2,4}-\d{6}-\d+$/i.test(term)) {
      const order = await this.core.ctx
        .use('orders')
        .getOrderAdmin(term.toUpperCase())
        .catch(() => null);
      if (order) orderIds = [order.order.id];
    }
    const res = await this.core.repo.listIntents({ ...q, q: term, orderIds, timeZone: this.core.ctx.config.market.timeZone }, page);
    return { ...res, items: await this.views.paymentRows(res.items, this.core.lookup()) };
  }

  async paymentAdmin(intentId: string): Promise<PaymentDetail> {
    return this.intents.detail(await this.intents.get(intentId));
  }

  async checkPayment(intentId: string, by: By): Promise<PaymentDetail> {
    const i = await this.intents.get(intentId);
    const after = is(ACCEPTED, i.status) || i.status === 'pending_check' || i.status === 'requires_action' || i.status === 'authorizing' ? await this.intents.reconcile(i.id, by) : i;
    return this.intents.detail(after);
  }

  async orderSummary(orderId: string): Promise<OrderPaymentSummary> {
    const lookup = this.core.lookup();
    const main = await this.intents.intentOfOrder(orderId, (await lookup.order(orderId))?.paymentIntentId);
    if (!main) throw notFound('Payment for this order');
    const [sessionAttempts, linked] = await Promise.all([
      this.core.repo.find('intents', { checkout_session_id: main.checkout_session_id }, { orderBy: [['created_at', 'asc']] }),
      this.core.repo.find('intents', { order_id: orderId }),
    ]);
    const seen = new Set(sessionAttempts.map((s) => s.id));
    const attempts = [...sessionAttempts, ...linked.filter((x) => !seen.has(x.id))];
    const [rows, totals, refundable] = await Promise.all([
      this.views.paymentRows(attempts, lookup),
      this.core.repo.intentRefundTotals(main.id),
      this.refunds.remainingRefundable(orderId).catch(() => null),
    ]);
    const m = (amount: number) => ({ amount, currency: main.currency });
    return {
      orderId,
      state: customerState(main),
      methodLabel: main.method.label,
      authorizedAt: main.authorized_at?.toISOString() ?? null,
      capturedAt: main.captured_at?.toISOString() ?? null,
      processorRef: main.provider_ref,
      captured: m(main.captured_amount),
      refunded: m(main.refunded_amount),
      inFlight: m(totals.inFlight),
      remainingRefundable: refundable?.remaining ?? m(Math.max(0, main.captured_amount - totals.sent - totals.inFlight)),
      attempts: rows,
    };
  }

  /* ---------------------------------------------------------------- GraphQL helpers */

  /** Refund executions of an order with the customer view next to each (GraphQL Refund has both) */
  async refundsWithViews(orderId: string): Promise<{ refund: Refund; view: RefundView }[]> {
    const rows = await this.core.repo.find('refunds', { order_id: orderId }, { orderBy: [['created_at', 'desc']] });
    const lookup = this.core.lookup();
    const cfg = await this.core.cfg();
    const [refunds, views] = await Promise.all([this.views.refunds(rows, lookup, cfg), this.views.refundViews(rows, lookup, cfg)]);
    return refunds.map((refund, n) => ({ refund, view: views[n]! }));
  }

  /** Every attempt of the checkout session of an intent, oldest first */
  async attemptsOf(intentId: string): Promise<IntentRec[]> {
    const i = await this.core.repo.get('intents', intentId);
    if (!i) return [];
    return this.core.repo.find('intents', { checkout_session_id: i.checkout_session_id }, { orderBy: [['created_at', 'asc']] });
  }

  /* ---------------------------------------------------------------- events consumed */

  /** orders.order.placed: Link the intent to the order and store seller-group allocations (fallback when linkOrder was not called) */
  onOrderPlacedFromOrders(event: EventPayload<'orders.order.placed'>): Promise<void> {
    return this.intents.onOrderPlaced(event);
  }

  /** orders.order.accepted: Capture the authorization when captureMode is on_acceptance */
  onOrderAcceptedFromOrders(event: EventPayload<'orders.order.accepted'>): Promise<void> {
    return this.intents.onOrderAccepted(event.orderId);
  }

  /** shipping.shipment.dispatched: Capture the group's allocation when captureMode is per_group_on_dispatch */
  onShipmentDispatchedFromShipping(event: EventPayload<'shipping.shipment.dispatched'>): Promise<void> {
    return this.intents.onShipmentDispatched(event);
  }

  /** orders.order.cancelled: Void the authorization if nothing was captured */
  onOrderCancelledFromOrders(event: EventPayload<'orders.order.cancelled'>): Promise<void> {
    return this.intents.onOrderCancelled(event);
  }

  /** orders.item.cancelled: Start a cancellation refund for the item's refund breakdown (origin cancellation, no Finance approval) or reduce the uncaptured authorization */
  onItemCancelledFromOrders(event: EventPayload<'orders.item.cancelled'>): Promise<void> {
    return this.refunds.onItemCancelled(event);
  }

  /** access.approval.decided: Complete or drop a dispute concession waiting for approval; carry out an approved manual money action */
  async onApprovalDecidedFromAccess(event: EventPayload<'access.approval.decided'>): Promise<void> {
    if (event.actionKey === MANUAL_ACTION) return this.onManualApproved(event);
    return this.disputes.onApprovalDecided(event);
  }

  /**
   * An approved manual money action (Core.manual) runs now with what was asked (the request's details), as the
   * approver. Rejected, cancelled or expired: nothing was done, nothing to undo. When the record changed meanwhile
   * (the refund is no longer failed, the payment was captured) the action is refused as usual and only logged:
   * staff see the current state and can ask again.
   */
  private async onManualApproved(e: EventPayload<'access.approval.decided'>): Promise<void> {
    if (e.outcome !== 'approved') return;
    const req = await this.core.soft('access', 'approval request', (a) => a.getApproval(e.requestId));
    const d = (req?.details ?? {}) as { reason?: string; amount?: common.Money | null; groupId?: string | null };
    const by: By = { actor: e.decidedBy ?? SYSTEM };
    const reason = d.reason?.trim() || `Approved in ${e.ref}`;
    const approved = { approvedBy: e.requestId };
    try {
      if (e.target.type === 'payment_capture') await this.intents.adminCapture(e.target.id, { amount: d.amount ?? null, groupId: d.groupId ?? null, reason }, { ...by, idempotencyKey: `approval:${e.requestId}` }, approved);
      else if (e.target.type === 'payment_void') await this.intents.adminVoid(e.target.id, reason, by, approved);
      else if (e.target.type === 'payment_orphan_refund') await this.intents.resolveOrphan(e.target.id, { action: 'refund', reason }, by, approved);
      else if (e.target.type === 'refund_retry') await this.refunds.adminRetry(e.target.id, reason, by, approved);
      else if (e.target.type === 'refund_cancel') await this.refunds.cancel(e.target.id, reason, by, approved);
    } catch (err) {
      this.core.ctx.log.warn({ err, requestId: e.requestId, target: e.target }, 'payments: approved manual action could not be carried out');
    }
  }

  /* ---------------------------------------------------------------- jobs */

  /** Job payments.check-uncertain (every 30 s) */
  checkUncertain(): Promise<void> {
    return this.intents.checkUncertain();
  }

  /** Job payments.process-refunds (every 1 min) */
  processRefunds(): Promise<void> {
    return this.refunds.processRefunds();
  }

  /** Job payments.detect-orphans (every 10 min) */
  detectOrphans(): Promise<void> {
    return this.intents.detectOrphans();
  }

  /** Job payments.expire-authorizations (hourly) */
  async expireAuthorizations(): Promise<void> {
    await this.intents.expireAuthorizations();
  }

  /** Job payments.dispute-deadlines (hourly) */
  disputeDeadlines(): Promise<void> {
    return this.disputes.deadlines();
  }

  /** Job payments.card-expiry (daily 05:00 PT) */
  cardExpiry(): Promise<void> {
    return this.methods.cardExpiry();
  }
}
