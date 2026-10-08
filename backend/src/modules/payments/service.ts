import { notImplemented } from '../../kernel/errors/index.js';
import type { EventPayload } from '../../kernel/events/index.js';
import type { ModuleContext } from '../../kernel/module-system/index.js';
import type * as common from '../../spec/common.js';
import type { PaymentsPublicApi, Allocation, AuthorizeInput, AuthorizeResult, PaymentStatusView, SavedPaymentMethod, PaymentOptions, PaymentDetail, RefundableSummary, Refund, StartRefundInput, Dispute } from '../../spec/payments.js';
import type { PaymentsRepository } from './ports.js';

export interface PaymentsServiceDeps {
  repo: PaymentsRepository;
  ctx: ModuleContext<'payments'>;
}

/**
 * Payments use cases. Depends only on ports, the event bus, the clock and other modules' public APIs.
 * Each method maps to a publicApi function, a consumed event or a job in docs/api/spec/modules/payments.json.
 */
export class PaymentsService implements PaymentsPublicApi {
  readonly #deps: PaymentsServiceDeps;

  constructor(deps: PaymentsServiceDeps) {
    this.#deps = deps;
  }

  protected get deps(): PaymentsServiceDeps {
    return this.#deps;
  }

  /* ---------------- public API (in-process) */

  /** Accepted brands, saved methods, wallet availability and a setup session for a new card */
  async listOptions(owner: { customerId?: string, guestSessionId?: string }, amount: common.Money): Promise<PaymentOptions> {
    throw notImplemented('payments.listOptions');
  }

  /** Create an intent for a checkout attempt and authorize it. Returns accepted, failed (with decline), pending_check (uncertain) or requires_action. Only one non-failed intent per checkout session at a time; the same key returns the first result. */
  async authorize(input: AuthorizeInput, idempotencyKey: string): Promise<AuthorizeResult> {
    throw notImplemented('payments.authorize');
  }

  /** Attach the created order and its seller-group allocations. Also done on orders.order.placed. */
  async linkOrder(intentId: string, orderId: string, allocations: Allocation[]): Promise<void> {
    throw notImplemented('payments.linkOrder');
  }

  /** Finish an authorization after a bank challenge or wallet confirmation (checkout calls it from POST /sessions/{id}/complete-action) */
  async completeAction(intentId: string, resultToken: string, idempotencyKey: string): Promise<AuthorizeResult> {
    throw notImplemented('payments.completeAction');
  }

  /** Current customer-facing state; refresh asks the provider first */
  async getIntentStatus(intentId: string, refresh?: boolean): Promise<PaymentStatusView> {
    throw notImplemented('payments.getIntentStatus');
  }

  /** Release an authorization (abandoned checkout, order cancelled before capture) */
  async voidIntent(intentId: string, reason: string): Promise<void> {
    throw notImplemented('payments.voidIntent');
  }

  /** Per item: paid, refunded, in flight and remaining. The cap for every refund. */
  async remainingRefundable(orderId: string, orderItemIds?: string[]): Promise<RefundableSummary> {
    throw notImplemented('payments.remainingRefundable');
  }

  /** Hand over an approved refund for execution. Fails with REFUND_EXCEEDS_REFUNDABLE or DUPLICATE_REFUND. Returns the existing refund for the same key or origin. */
  async startRefund(input: StartRefundInput, idempotencyKey: string): Promise<Refund> {
    throw notImplemented('payments.startRefund');
  }

  /** Execution status for mirrors in returns, support and orders */
  async getRefund(refundId: string): Promise<Refund | null> {
    throw notImplemented('payments.getRefund');
  }

  /** e.g. 'Visa •••• 4417', from the snapshot (stays after the saved card is removed) */
  async methodLabel(intentId: string): Promise<string> {
    throw notImplemented('payments.methodLabel');
  }

  /** The order's accepted payment intent. Callers show the customer view (customerState, method label, amounts) to customers and the full detail to staff. */
  async getPaymentForOrder(orderId: string): Promise<PaymentDetail | null> {
    throw notImplemented('payments.getPaymentForOrder');
  }

  /** Refund executions of an order, newest first, with items and status (Requested, Processing, Sent, Failed, Cancelled) */
  async listRefundsForOrder(orderId: string): Promise<Refund[]> {
    throw notImplemented('payments.listRefundsForOrder');
  }

  /** Chargebacks and payment disputes on an order (order 360, dispute case) */
  async listDisputesForOrder(orderId: string): Promise<Dispute[]> {
    throw notImplemented('payments.listDisputesForOrder');
  }

  /** The customer's saved cards and wallets, default first */
  async listSavedMethods(customerId: string): Promise<SavedPaymentMethod[]> {
    throw notImplemented('payments.listSavedMethods');
  }

  /* ---------------- events consumed */

  /** orders.order.placed: Link the intent to the order and store seller-group allocations (fallback when linkOrder was not called) */
  async onOrderPlacedFromOrders(event: EventPayload<"orders.order.placed">): Promise<void> {
    void event;
    throw notImplemented('payments consumer of orders.order.placed');
  }

  /** orders.order.accepted: Capture the authorization when captureMode is on_acceptance */
  async onOrderAcceptedFromOrders(event: EventPayload<"orders.order.accepted">): Promise<void> {
    void event;
    throw notImplemented('payments consumer of orders.order.accepted');
  }

  /** shipping.shipment.dispatched: Capture the group's allocation when captureMode is per_group_on_dispatch */
  async onShipmentDispatchedFromShipping(event: EventPayload<"shipping.shipment.dispatched">): Promise<void> {
    void event;
    throw notImplemented('payments consumer of shipping.shipment.dispatched');
  }

  /** orders.order.cancelled: Void the authorization if nothing was captured */
  async onOrderCancelledFromOrders(event: EventPayload<"orders.order.cancelled">): Promise<void> {
    void event;
    throw notImplemented('payments consumer of orders.order.cancelled');
  }

  /** orders.item.cancelled: Start a cancellation refund for the item's refund breakdown (origin cancellation, no Finance approval) or reduce the uncaptured authorization */
  async onItemCancelledFromOrders(event: EventPayload<"orders.item.cancelled">): Promise<void> {
    void event;
    throw notImplemented('payments consumer of orders.item.cancelled');
  }

  /** access.approval.decided: Complete or drop a dispute concession waiting for approval */
  async onApprovalDecidedFromAccess(event: EventPayload<"access.approval.decided">): Promise<void> {
    void event;
    throw notImplemented('payments consumer of access.approval.decided');
  }

  /* ---------------- jobs */

  /** Job payments.check-uncertain (every 30 s): Retrieve pending_check intents from the provider with backoff (30 s, 1 min, 2 min, 5 min…); after uncertainMaxHours raise it to Finance (payments.payment.orphaned with needs_review if money moved) */
  async checkUncertain(): Promise<void> {
    throw notImplemented('job payments.check-uncertain');
  }

  /** Job payments.process-refunds (every 1 min): Submit requested refunds; retrieve processing refunds with unknown outcome; retry failed refunds with retryable reasons up to refundMaxAttempts after confirming with the provider that nothing was sent */
  async processRefunds(): Promise<void> {
    throw notImplemented('job payments.process-refunds');
  }

  /** Job payments.detect-orphans (every 10 min): Intents authorized or captured with no order after orphanGraceMinutes and a completed or expired checkout session: void authorizations, start refunds for captures, publish payments.payment.orphaned */
  async detectOrphans(): Promise<void> {
    throw notImplemented('job payments.detect-orphans');
  }

  /** Job payments.expire-authorizations (hourly): Authorizations near expiry: capture if the order is accepted, otherwise void */
  async expireAuthorizations(): Promise<void> {
    throw notImplemented('job payments.expire-authorizations');
  }

  /** Job payments.dispute-deadlines (hourly): Flag disputes with evidence due within 48 h; mark lost when the deadline passed without evidence */
  async disputeDeadlines(): Promise<void> {
    throw notImplemented('job payments.dispute-deadlines');
  }

  /** Job payments.card-expiry (daily 05:00 PT): Mark saved cards expired; apply provider card-updater results */
  async cardExpiry(): Promise<void> {
    throw notImplemented('job payments.card-expiry');
  }
}
