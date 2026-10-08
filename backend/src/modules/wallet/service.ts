import { notImplemented } from '../../kernel/errors/index.js';
import type { EventPayload } from '../../kernel/events/index.js';
import type { ModuleContext } from '../../kernel/module-system/index.js';
import type * as common from '../../spec/common.js';
import type { WalletPublicApi, CreditBalance, LedgerEntry, CreditHold, GoodwillInput, GoodwillGrant, CustomerWalletAdmin } from '../../spec/wallet.js';
import type { WalletRepository } from './ports.js';

export interface WalletServiceDeps {
  repo: WalletRepository;
  ctx: ModuleContext<'wallet'>;
}

/**
 * Wallet use cases. Depends only on ports, the event bus, the clock and other modules' public APIs.
 * Each method maps to a publicApi function, a consumed event or a job in docs/api/spec/modules/wallet.json.
 */
export class WalletService implements WalletPublicApi {
  readonly #deps: WalletServiceDeps;

  constructor(deps: WalletServiceDeps) {
    this.#deps = deps;
  }

  protected get deps(): WalletServiceDeps {
    return this.#deps;
  }

  /* ---------------- public API (in-process) */

  /** Available balance and soonest expiry, for checkout step 4 'Use my Marketly credit'. */
  async getBalance(customerId: string): Promise<CreditBalance> {
    throw notImplemented('wallet.getBalance');
  }

  /** Reserve credit for a quote; earliest-expiring lots first. Fails with INSUFFICIENT_CREDIT. */
  async holdCredit(customerId: string, quoteId: string, amount: common.Money, idempotencyKey: string): Promise<CreditHold> {
    throw notImplemented('wallet.holdCredit');
  }

  /** Turn a hold into a use when the order is accepted. */
  async captureHold(holdId: string, orderId: string): Promise<CreditHold> {
    throw notImplemented('wallet.captureHold');
  }

  /** Release a hold on payment failure or quote expiry. */
  async releaseHold(holdId: string): Promise<CreditHold> {
    throw notImplemented('wallet.releaseHold');
  }

  /** Refund to store credit (customer's choice) or return the credit part of a refunded order. Called by returns for return refunds to store credit and by payments for the refunds it executes (other origins with destination store_credit, and the credit part of a mixed tender). Idempotent per refundId; the payment tender split decides how much goes back to credit. */
  async creditRefund(input: { customerId: string, refundId: string, orderId: string, amount: common.Money, reason: string }, idempotencyKey: string): Promise<LedgerEntry> {
    throw notImplemented('wallet.creditRefund');
  }

  /** Goodwill credit from a support case or order; above the actor's limit it becomes pending approval. */
  async grantGoodwill(input: GoodwillInput, actor: common.Actor, idempotencyKey: string): Promise<GoodwillGrant> {
    throw notImplemented('wallet.grantGoodwill');
  }

  /** Staff view of a customer's credit: balance, lots, goodwill in the last 30 days against the per-customer limit, and pending grants (GET /admin/wallet/customers/{customerId}). */
  async getCustomerWallet(customerId: string): Promise<CustomerWalletAdmin> {
    throw notImplemented('wallet.getCustomerWallet');
  }

  /* ---------------- events consumed */

  /** orders.order.placed: Capture the quote's credit hold if payments has not already */
  async onOrderPlacedFromOrders(event: EventPayload<"orders.order.placed">): Promise<void> {
    void event;
    throw notImplemented('wallet consumer of orders.order.placed');
  }

  /** payments.payment.failed: Release the quote's credit hold */
  async onPaymentFailedFromPayments(event: EventPayload<"payments.payment.failed">): Promise<void> {
    void event;
    throw notImplemented('wallet consumer of payments.payment.failed');
  }

  /** access.approval.decided: Grant or reject pending goodwill, corrections and gift card batches */
  async onApprovalDecidedFromAccess(event: EventPayload<"access.approval.decided">): Promise<void> {
    void event;
    throw notImplemented('wallet consumer of access.approval.decided');
  }

  /** identity.user.registered: Create an empty wallet account lazily on first credit (no-op otherwise) */
  async onUserRegisteredFromIdentity(event: EventPayload<"identity.user.registered">): Promise<void> {
    void event;
    throw notImplemented('wallet consumer of identity.user.registered');
  }

  /* ---------------- jobs */

  /** Job wallet.expire-lots (daily 00:30 market time): Expire lots past expiresAt; notify customers 30 and 7 days before expiry */
  async expireLots(): Promise<void> {
    throw notImplemented('job wallet.expire-lots');
  }

  /** Job wallet.release-stale-holds (every 1 min): Release holds past expiresAt */
  async releaseStaleHolds(): Promise<void> {
    throw notImplemented('job wallet.release-stale-holds');
  }

  /** Job wallet.balance-check (daily): Verify every account balance equals the ledger sum; flag differences to Finance checks */
  async balanceCheck(): Promise<void> {
    throw notImplemented('job wallet.balance-check');
  }
}
