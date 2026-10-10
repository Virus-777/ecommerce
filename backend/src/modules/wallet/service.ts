import { AppError } from '../../kernel/errors/index.js';
import type { EventPayload } from '../../kernel/events/index.js';
import type { ModuleContext } from '../../kernel/module-system/index.js';
import type * as common from '../../spec/common.js';
import type { CreditBalance, CreditHold, CustomerWalletAdmin, GoodwillGrant, GoodwillInput, LedgerEntry, LoyaltyAccount, WalletPublicApi } from '../../spec/wallet.js';
import { isUuid } from '../../kernel/lib/ids.js';
import { toLot } from './mappers.js';
import type { WalletRepository } from './ports.js';
import { WalletCore } from './service/core.js';
import { GiftCards } from './service/gift-cards.js';
import { Ledger } from './service/ledger.js';
import { StaffCredit } from './service/staff-credit.js';

export type { By } from './service/core.js';

export interface WalletServiceDeps {
  repo: WalletRepository;
  ctx: ModuleContext<'wallet'>;
}

/**
 * Wallet use cases. Depends only on ports, the event bus, the clock and other modules' public APIs.
 * Each method maps to a publicApi function, a consumed event or a job in docs/api/spec/modules/wallet.json.
 *
 *   ledger      accounts, lots, the append-only ledger, holds, refunds to credit, corrections applied, expiry, checks
 *   staff       goodwill grants and reversals, corrections (approval limits), approvals decided
 *   giftCards   batches, codes (hashed), check, redemption, void, expiry
 */
export class WalletService implements WalletPublicApi {
  readonly core: WalletCore;
  readonly ledger: Ledger;
  readonly staff: StaffCredit;
  readonly giftCards: GiftCards;

  constructor(protected readonly deps: WalletServiceDeps) {
    this.core = new WalletCore(deps.repo, deps.ctx);
    this.ledger = new Ledger(this.core);
    this.staff = new StaffCredit(this.core, this.ledger);
    this.giftCards = new GiftCards(this.core, this.ledger);
  }

  /* ---------------- public API (in-process) */

  /** Available balance and soonest expiry, for checkout step 4 'Use my Marketly credit'. */
  async getBalance(customerId: string): Promise<CreditBalance> {
    return this.ledger.balance(customerId);
  }

  /** Reserve credit for a quote; earliest-expiring lots first. Fails with INSUFFICIENT_CREDIT. */
  async holdCredit(customerId: string, quoteId: string, amount: common.Money, idempotencyKey: string): Promise<CreditHold> {
    return this.ledger.holdCredit(customerId, quoteId, amount, idempotencyKey);
  }

  /** Turn a hold into a use when the order is accepted. */
  async captureHold(holdId: string, orderId: string): Promise<CreditHold> {
    return this.ledger.captureHold(holdId, orderId);
  }

  /** Release a hold on payment failure or quote expiry. */
  async releaseHold(holdId: string): Promise<CreditHold> {
    return this.ledger.releaseHold(holdId);
  }

  /** Keep a held credit hold alive while its payment is pending check; capped at pendingHoldMaxHours after it was made. */
  async extendHold(holdId: string, until: string): Promise<CreditHold> {
    return this.ledger.extendHold(holdId, until);
  }

  /** Store credit outstanding over all accounts, for finance's daily store_credit check. */
  async getLiabilityTotal(asOf?: string): Promise<{ available: common.Money; held: common.Money; accounts: number }> {
    return this.ledger.liabilityTotal(asOf);
  }

  /** Refund to store credit (customer's choice) or return the credit part of a refunded order. Idempotent per refundId. */
  async creditRefund(input: { customerId: string; refundId: string; orderId: string; amount: common.Money; reason: string }, idempotencyKey: string): Promise<LedgerEntry> {
    return this.ledger.creditRefund(input, idempotencyKey);
  }

  /** Goodwill credit from a support case or order; above the actor's limit it becomes pending approval. */
  async grantGoodwill(input: GoodwillInput, actor: common.Actor, idempotencyKey: string): Promise<GoodwillGrant> {
    return this.staff.grant(input, { actor }, idempotencyKey);
  }

  /** Staff view of a customer's credit: balance, lots, goodwill in the last 30 days against the per-customer limit, and pending grants. */
  async getCustomerWallet(customerId: string): Promise<CustomerWalletAdmin> {
    return this.staff.customerWallet(customerId);
  }

  /**
   * Customer data export hook (FORMAT.md): the customer's credit lots and ledger entries as plain records (labels,
   * amounts, dates). Staff names and internal reasons are left out (entries are shown as the customer sees them).
   */
  async exportCustomerData(input: { customerId: string; accountId: string }): Promise<common.CustomerDataSection[]> {
    const ids = [...new Set([input.customerId, input.accountId].filter((v) => isUuid(v)))];
    const lots: Record<string, unknown>[] = [];
    const entries: Record<string, unknown>[] = [];
    for (const id of ids) {
      const [acct, lotRows, entryRows] = await Promise.all([this.deps.repo.getAccount(id), this.deps.repo.allLotsOf(id), this.deps.repo.allEntriesOf(id)]);
      const currency = acct?.currency ?? this.core.currency;
      for (const l of lotRows) {
        const v = toLot(l, currency);
        lots.push({ source: v.source, original: v.original, remaining: v.remaining, state: l.state, expiresAt: v.expiresAt, createdAt: v.createdAt, reference: v.reference });
      }
      for (const e of await this.ledger.entryViews(entryRows, { staff: false })) {
        entries.push({ at: e.at, kind: e.kind, label: e.label, amount: e.amount, balanceAfter: e.balanceAfter, orderRef: e.orderRef, caseRef: e.caseRef });
      }
    }
    return [
      { key: 'store_credit_lots', title: 'Store credit', module: 'wallet', records: lots },
      { key: 'store_credit_entries', title: 'Store credit history', module: 'wallet', records: entries },
    ];
  }

  /* ---------------- loyalty (phase 4 experiment) */

  /** Points from the loyalty ledger; NOT_IMPLEMENTED until a program is defined (loyaltyEnabled) */
  async loyalty(customerId: string): Promise<LoyaltyAccount> {
    if (!(await this.deps.ctx.settings.get('loyaltyEnabled'))) {
      throw new AppError('NOT_IMPLEMENTED', 'Loyalty points are not available yet.', { operation: 'wallet.getMyLoyalty', reason: 'no_program' });
    }
    return { customerId, points: await this.deps.repo.loyaltyPoints(customerId), tier: null, pendingPoints: 0, programTerms: null };
  }

  /* ---------------- events consumed */

  /** orders.order.placed: Capture the quote's credit hold if payments has not already */
  async onOrderPlacedFromOrders(event: EventPayload<'orders.order.placed'>): Promise<void> {
    await this.ledger.onOrderPlaced(event);
  }

  /** payments.payment.failed: Release the quote's credit hold */
  async onPaymentFailedFromPayments(event: EventPayload<'payments.payment.failed'>): Promise<void> {
    await this.ledger.onPaymentFailed(event);
  }

  /** access.approval.decided: Grant or reject pending goodwill, corrections and gift card batches */
  async onApprovalDecidedFromAccess(event: EventPayload<'access.approval.decided'>): Promise<void> {
    await this.staff.onApprovalDecided(event, this.giftCards);
  }

  /** identity.user.registered: Create an empty wallet account lazily on first credit (no-op otherwise) */
  async onUserRegisteredFromIdentity(_event: EventPayload<'identity.user.registered'>): Promise<void> {
    // accounts are created on the first credit (lockOrCreateAccount); a new customer simply has none yet
  }

  /* ---------------- jobs */

  /** Job wallet.expire-lots (daily 00:30 market time): Expire lots past expiresAt; notify customers 30 and 7 days before expiry */
  async expireLots(): Promise<void> {
    const r = await this.ledger.expireLots();
    const cards = await this.giftCards.expireDue();
    this.deps.ctx.log.info({ ...r, giftCardsExpired: cards }, 'wallet: expiry run');
  }

  /** Job wallet.release-stale-holds (every 1 min): Release holds past expiresAt (an extended hold's is the extended time); delete undelivered gift card codes past giftCardCodesTtlHours */
  async releaseStaleHolds(): Promise<void> {
    await this.ledger.releaseStaleHolds();
    const cleared = await this.giftCards.clearExpiredCodes();
    if (cleared) this.deps.ctx.log.info({ batches: cleared }, 'wallet: undelivered gift card codes deleted');
  }

  /** Job wallet.balance-check (daily 05:00 market time): Verify every account balance equals the ledger sum; report differences to finance.recordExternalDifference */
  async balanceCheck(): Promise<void> {
    await this.ledger.balanceCheck();
  }
}

