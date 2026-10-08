import { notImplemented } from '../../kernel/errors/index.js';
import type { EventPayload } from '../../kernel/events/index.js';
import type { ModuleContext } from '../../kernel/module-system/index.js';
import type * as common from '../../spec/common.js';
import type * as identity from '../../spec/identity.js';
import type { FinancePublicApi, Reference, Hold, SellerBalances, LedgerEntry, FeeCalcInput, FeeCalculation, Payout, PayoutRun, RunPayoutRow, DestinationReview, Statement, SellerFinanceDetail, DailySellerIncome, EarningsPreview, RefundImpactPreview } from '../../spec/finance.js';
import type { FinanceRepository } from './ports.js';

export interface FinanceServiceDeps {
  repo: FinanceRepository;
  ctx: ModuleContext<'finance'>;
}

/**
 * Finance use cases. Depends only on ports, the event bus, the clock and other modules' public APIs.
 * Each method maps to a publicApi function, a consumed event or a job in docs/api/spec/modules/finance.json.
 */
export class FinanceService implements FinancePublicApi {
  readonly #deps: FinanceServiceDeps;

  constructor(deps: FinanceServiceDeps) {
    this.#deps = deps;
  }

  protected get deps(): FinanceServiceDeps {
    return this.#deps;
  }

  /* ---------------- public API (in-process) */

  /** Effect of a refund on seller earnings and fees, shown before deciding */
  async previewRefundImpact(orderItemIds: string[], refund: common.Money, fundedBy: string): Promise<{ sellerEarningsChange: common.Money, feeReturned: common.Money, afterPayout: boolean, note: string }> {
    throw notImplemented('finance.previewRefundImpact');
  }

  /** Fee and seller earnings for a price under the active fee rules */
  async calculateFee(input: FeeCalcInput): Promise<FeeCalculation> {
    throw notImplemented('finance.calculateFee');
  }

  /** Balances for dashboards and seller detail */
  async getSellerBalances(sellerId: string): Promise<SellerBalances> {
    throw notImplemented('finance.getSellerBalances');
  }

  /** Posts a seller ad charge, kept separate from commission */
  async recordAdCharge(input: { sellerId: string, campaignId: string, campaignRef: string, period: common.DateRange, amount: common.Money, description: string }): Promise<LedgerEntry> {
    throw notImplemented('finance.recordAdCharge');
  }

  /** Company trading costs for the Official Store margin */
  async recordCompanyCost(input: { kind: 'buying_cost' | 'shipping_expense' | 'return_loss' | 'write_off' | 'supplier_credit', amount: common.Money, reference: Reference, at: string }): Promise<void> {
    throw notImplemented('finance.recordCompanyCost');
  }

  /** Whether a seller can be paid (verified destination, no full hold) */
  async hasPayoutBlock(sellerId: string): Promise<{ blocked: boolean, reasons: string[] }> {
    throw notImplemented('finance.hasPayoutBlock');
  }

  /** Fee income per seller per market day (commission and fees charged, fee refunds, net, ad income), from fee_charges and ledger_entries. Company revenue only; seller sales are not income. */
  async marketplaceIncomeByDay(range: common.DateRange, sellerId?: string): Promise<DailySellerIncome[]> {
    throw notImplemented('finance.marketplaceIncomeByDay');
  }

  /** One seller's balances, ledger, payouts, statements, holds, amounts owed and adjustments (seller Finance page, admin seller 360) */
  async getSellerAccount(sellerId: string): Promise<SellerFinanceDetail> {
    throw notImplemented('finance.getSellerAccount');
  }

  /** An itemised statement of this seller */
  async getStatementForSeller(sellerId: string, ref: string): Promise<Statement | null> {
    throw notImplemented('finance.getStatementForSeller');
  }

  /** Any seller's statement as the seller sees it (staff) */
  async getStatement(ref: string): Promise<Statement | null> {
    throw notImplemented('finance.getStatement');
  }

  /** Payout run with seller rows, holds, approvals, pre-release checks, the last run's failed payouts and destination reviews */
  async getPayoutRun(ref: string): Promise<PayoutRun & { sellers: common.Page<RunPayoutRow>, failedPayouts: Payout[], destinationReviews: DestinationReview[] } | null> {
    throw notImplemented('finance.getPayoutRun');
  }

  /** Payout runs, newest first */
  async listPayoutRuns(filter: { status?: string }, page: common.PageInput): Promise<common.Page<PayoutRun>> {
    throw notImplemented('finance.listPayoutRuns');
  }

  /** Holds placed for a case, order or chargeback, batched (Case.holds in the dispute view) */
  async holdsForReference(references: { kind: string, id: string }[]): Promise<Hold[]> {
    throw notImplemented('finance.holdsForReference');
  }

  /** Fee and earnings at a price on the seller's own offer form (calculateFee under the active rules, with the fee basis explained) */
  async previewOfferEarnings(items: { offerId: string, sellerId: string, categoryId: string | null, price: common.Money }[]): Promise<Record<string, EarningsPreview>> {
    throw notImplemented('finance.previewOfferEarnings');
  }

  /** The next payout run to be released (draft, pending approval or approved), for the admin dashboard */
  async getNextPayoutRun(): Promise<PayoutRun | null> {
    throw notImplemented('finance.getNextPayoutRun');
  }

  /** previewRefundImpact for staff decision panels: resolves the order's items and refundable amounts, then the seller earnings, fee and balance effect */
  async previewRefundImpactForOrder(orderRef: string, items: { orderItemId: string, quantity?: number }[] | null, refund: common.Money | null, fundedBy: string): Promise<RefundImpactPreview> {
    throw notImplemented('finance.previewRefundImpactForOrder');
  }

  /** Export rows for reports datasets finance.admin.ledger, finance.admin.payout_run, finance.admin.checks and finance.seller.ledger (seller rows scoped to the principal's seller) */
  async exportRows(dataset: string, filters: unknown, principal: identity.Principal, cursor?: string): Promise<{ rows: unknown[], nextCursor?: string }> {
    throw notImplemented('finance.exportRows');
  }

  /* ---------------- events consumed */

  /** orders.order.accepted: Create pending earnings lots and fee charges per seller item (sale, shipping charged, seller-funded discount, fee); Official Store items go to trading_entries */
  async onOrderAcceptedFromOrders(event: EventPayload<"orders.order.accepted">): Promise<void> {
    void event;
    throw notImplemented('finance consumer of orders.order.accepted');
  }

  /** orders.item.cancelled: Reverse the lot; apply the cancellation fee treatment */
  async onItemCancelledFromOrders(event: EventPayload<"orders.item.cancelled">): Promise<void> {
    void event;
    throw notImplemented('finance consumer of orders.item.cancelled');
  }

  /** orders.item.delivered: Start the availability clock for the item's lot */
  async onItemDeliveredFromOrders(event: EventPayload<"orders.item.delivered">): Promise<void> {
    void event;
    throw notImplemented('finance consumer of orders.item.delivered');
  }

  /** payments.payment.captured: Record collected money for reconciliation (payments vs orders) */
  async onPaymentCapturedFromPayments(event: EventPayload<"payments.payment.captured">): Promise<void> {
    void event;
    throw notImplemented('finance consumer of payments.payment.captured');
  }

  /** returns.refund.approved: Store the funding split (seller, platform, shared) for the refund */
  async onRefundApprovedFromReturns(event: EventPayload<"returns.refund.approved">): Promise<void> {
    void event;
    throw notImplemented('finance consumer of returns.refund.approved');
  }

  /** payments.refund.sent: Post the refund and proportional fee refund to the seller ledger (refund_after_payout when the lot was paid out) or to company trading */
  async onRefundSentFromPayments(event: EventPayload<"payments.refund.sent">): Promise<void> {
    void event;
    throw notImplemented('finance consumer of payments.refund.sent');
  }

  /** payments.chargeback.opened: Place a chargeback hold on the seller (fee kept while open per fee treatment) */
  async onChargebackOpenedFromPayments(event: EventPayload<"payments.chargeback.opened">): Promise<void> {
    void event;
    throw notImplemented('finance consumer of payments.chargeback.opened');
  }

  /** payments.chargeback.decided: won: release the chargeback hold. lost: apply the hold as a chargeback deduction from the seller (or a company trading loss for Official Store orders) and record the fee treatment */
  async onChargebackDecidedFromPayments(event: EventPayload<"payments.chargeback.decided">): Promise<void> {
    void event;
    throw notImplemented('finance consumer of payments.chargeback.decided');
  }

  /** returns.label.created: Return labels: charge a seller-paid label to the seller, record a platform shipping expense, or nothing when the customer pays (deducted from the refund). Keyed by labelId */
  async onLabelCreatedFromReturns(event: EventPayload<"returns.label.created">): Promise<void> {
    void event;
    throw notImplemented('finance consumer of returns.label.created');
  }

  /** shipping.label.purchased: Outbound and replacement labels: charge seller-bought labels to the seller ledger, record company labels as Official Store shipping expense and platform labels as platform cost. kind = return is ignored (booked from returns.label.created) */
  async onLabelPurchasedFromShipping(event: EventPayload<"shipping.label.purchased">): Promise<void> {
    void event;
    throw notImplemented('finance consumer of shipping.label.purchased');
  }

  /** shipping.label.voided: Reverse the charge or expense booked for that labelId (any kind) */
  async onLabelVoidedFromShipping(event: EventPayload<"shipping.label.voided">): Promise<void> {
    void event;
    throw notImplemented('finance consumer of shipping.label.voided');
  }

  /** shipping.claim.status_changed: paid: credit paidAmount to whoever bore the loss (seller ledger or company trading); other statuses are kept for reconciliation */
  async onClaimStatusChangedFromShipping(event: EventPayload<"shipping.claim.status_changed">): Promise<void> {
    void event;
    throw notImplemented('finance consumer of shipping.claim.status_changed');
  }

  /** promotions.coupon.redeemed: Record discount funding (platform vs seller) for fee basis and discount reports */
  async onCouponRedeemedFromPromotions(event: EventPayload<"promotions.coupon.redeemed">): Promise<void> {
    void event;
    throw notImplemented('finance consumer of promotions.coupon.redeemed');
  }

  /** sellers.seller.approved: Open the seller account and apply the new-seller hold rule */
  async onSellerApprovedFromSellers(event: EventPayload<"sellers.seller.approved">): Promise<void> {
    void event;
    throw notImplemented('finance consumer of sellers.seller.approved');
  }

  /** sellers.seller.suspended: Put the seller's pending payouts on hold with reason restriction (review date from the restriction) */
  async onSellerSuspendedFromSellers(event: EventPayload<"sellers.seller.suspended">): Promise<void> {
    void event;
    throw notImplemented('finance consumer of sellers.seller.suspended');
  }

  /** sellers.seller.closed: Issue a final statement and schedule the last payout after open obligations */
  async onSellerClosedFromSellers(event: EventPayload<"sellers.seller.closed">): Promise<void> {
    void event;
    throw notImplemented('finance consumer of sellers.seller.closed');
  }

  /** sellers.payout_account.changed: Open a destination review; keep paying the current verified destination */
  async onPayoutAccountChangedFromSellers(event: EventPayload<"sellers.payout_account.changed">): Promise<void> {
    void event;
    throw notImplemented('finance consumer of sellers.payout_account.changed');
  }

  /** access.approval.decided: Finish approval-required holds, adjustments, corrections, payout runs and fee rule changes */
  async onApprovalDecidedFromAccess(event: EventPayload<"access.approval.decided">): Promise<void> {
    void event;
    throw notImplemented('finance consumer of access.approval.decided');
  }

  /** support.case.decided: Release or apply dispute holds linked to the case */
  async onCaseDecidedFromSupport(event: EventPayload<"support.case.decided">): Promise<void> {
    void event;
    throw notImplemented('finance consumer of support.case.decided');
  }

  /** wallet.credit.granted: Phase 3: record the store-credit liability (refund to credit, goodwill, gift cards) */
  async onCreditGrantedFromWallet(event: EventPayload<"wallet.credit.granted">): Promise<void> {
    void event;
    throw notImplemented('finance consumer of wallet.credit.granted');
  }

  /** wallet.credit.used: Phase 3: reduce the store-credit liability when credit pays for an order */
  async onCreditUsedFromWallet(event: EventPayload<"wallet.credit.used">): Promise<void> {
    void event;
    throw notImplemented('finance consumer of wallet.credit.used');
  }

  /* ---------------- jobs */

  /** Job finance.release-pending (hourly): Move earnings lots to available once delivered + availableAfterDeliveryDays have passed */
  async releasePending(): Promise<void> {
    throw notImplemented('job finance.release-pending');
  }

  /** Job finance.payout-run.create (per payoutSchedule at cutoff (e.g. Thu 23:59 PT)): Issue statements for the period and create the draft payout run */
  async payoutRunCreate(): Promise<void> {
    throw notImplemented('job finance.payout-run.create');
  }

  /** Job finance.payout-run.release (every 5 min): Release approved runs at their scheduled time */
  async payoutRunRelease(): Promise<void> {
    throw notImplemented('job finance.payout-run.release');
  }

  /** Job finance.payout-status.poll (every 30 min): Ask the provider about processing payouts without a webhook result */
  async payoutStatusPoll(): Promise<void> {
    throw notImplemented('job finance.payout-status.poll');
  }

  /** Job finance.reconcile.daily (daily 06:00 PT): Build the day check: payments vs orders, seller amounts vs statements, provider deposit, unexplained amounts, failed payouts; publish mismatches */
  async reconcileDaily(): Promise<void> {
    throw notImplemented('job finance.reconcile.daily');
  }

  /** Job finance.holds.review-due (daily 07:00 PT): List holds reaching their review date for Finance (workqueues) */
  async holdsReviewDue(): Promise<void> {
    throw notImplemented('job finance.holds.review-due');
  }

  /** Job finance.negative-balance.age (daily): Turn negative balances older than negativeBalanceOwedAfterDays into amounts owed */
  async negativeBalanceAge(): Promise<void> {
    throw notImplemented('job finance.negative-balance.age');
  }

  /** Job finance.fee-rules.activate (every 5 min): Activate scheduled fee rule versions at their effective time */
  async feeRulesActivate(): Promise<void> {
    throw notImplemented('job finance.fee-rules.activate');
  }
}
