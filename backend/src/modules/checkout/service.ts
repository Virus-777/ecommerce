import { notImplemented } from '../../kernel/errors/index.js';
import type { EventPayload } from '../../kernel/events/index.js';
import type { ModuleContext } from '../../kernel/module-system/index.js';
import type { CheckoutPublicApi, CheckoutView, ConfirmationView } from '../../spec/checkout.js';
import type { CheckoutRepository } from './ports.js';

export interface CheckoutServiceDeps {
  repo: CheckoutRepository;
  ctx: ModuleContext<'checkout'>;
}

/**
 * Checkout use cases. Depends only on ports, the event bus, the clock and other modules' public APIs.
 * Each method maps to a publicApi function, a consumed event or a job in docs/api/spec/modules/checkout.json.
 */
export class CheckoutService implements CheckoutPublicApi {
  constructor(protected readonly deps: CheckoutServiceDeps) {}

  /* ---------------- public API (in-process) */

  /** Whether a checkout produced an order (used by payments' orphan check) */
  async getSessionForOrder(sessionId: string): Promise<{ orderId: string | null, status: string, customerId: string | null } | null> {
    throw notImplemented("checkout.getSessionForOrder");
  }

  /** A checkout session of this shopper (same as GET /sessions/{id}); null when it belongs to someone else */
  async getSessionView(owner: { customerId?: string, guestSessionId?: string }, sessionId: string): Promise<CheckoutView | null> {
    throw notImplemented("checkout.getSessionView");
  }

  /** Order confirmation once the payment is accepted (same as GET /sessions/{id}/confirmation); null before */
  async getConfirmation(owner: { customerId?: string, guestSessionId?: string }, sessionId: string): Promise<ConfirmationView | null> {
    throw notImplemented("checkout.getConfirmation");
  }

  /* ---------------- events consumed */

  /** payments.payment.authorized: A payment_pending or awaiting_action session becomes completed (orders accepts the order on the same event) */
  async onPaymentAuthorizedFromPayments(event: EventPayload<"payments.payment.authorized">): Promise<void> {
    throw notImplemented("checkout consumer of payments.payment.authorized");
  }

  /** payments.payment.failed: A payment_pending or awaiting_action session becomes payment_failed; when the order had been created, restore the lines to the cart (cart.restoreItems) so the customer can pay another way */
  async onPaymentFailedFromPayments(event: EventPayload<"payments.payment.failed">): Promise<void> {
    throw notImplemented("checkout consumer of payments.payment.failed");
  }

  /** orders.order.cancelled: If the cancelled order came from a pending payment, keep the session in payment_failed and point the customer to a new attempt */
  async onOrderCancelledFromOrders(event: EventPayload<"orders.order.cancelled">): Promise<void> {
    throw notImplemented("checkout consumer of orders.order.cancelled");
  }

  /** identity.guest_session.claimed: Attach open guest sessions to the customer who signed in (account step switches to the customer) */
  async onGuestSessionClaimedFromIdentity(event: EventPayload<"identity.guest_session.claimed">): Promise<void> {
    throw notImplemented("checkout consumer of identity.guest_session.claimed");
  }

  /* ---------------- jobs */

  /** Job checkout.expire-sessions (every 5 min): Expire idle open sessions (sessionTtlMinutes) and payment_failed sessions past holdUntil: release stock and promotion reservations, release credit holds, void authorizations; publish checkout.session.abandoned */
  async expireSessions(): Promise<void> {
    throw notImplemented("job checkout.expire-sessions");
  }

  /** Job checkout.extend-pending-holds (every 10 min): Keep stock holds alive for payment_pending sessions (inventory.extendHold) up to pendingHoldHours */
  async extendPendingHolds(): Promise<void> {
    throw notImplemented("job checkout.extend-pending-holds");
  }

  /** Job checkout.purge-idempotency (daily 03:30 PT): Delete place_requests older than idempotencyRetentionDays */
  async purgeIdempotency(): Promise<void> {
    throw notImplemented("job checkout.purge-idempotency");
  }
}
