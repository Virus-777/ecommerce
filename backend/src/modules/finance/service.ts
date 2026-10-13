import type { EventPayload } from '../../kernel/events/index.js';
import { isUuid } from '../../kernel/lib/ids.js';
import { toPageRequest } from '../../kernel/lib/pagination.js';
import type * as common from '../../spec/common.js';
import type * as identity from '../../spec/identity.js';
import type { DailySellerIncome, DestinationReview, EarningsPreview, FeeCalcInput, FeeCalculation, FinancePublicApi, Hold, LedgerEntry, Payout, PayoutRun, ReconItem, Reference, RefundImpactPreview, RunPayoutRow, SellerBalances, SellerCredit, SellerFinanceDetail, Statement } from '../../spec/finance.js';
import { Core, type FinanceServiceDeps } from './service/core.js';
import { CREDIT_ACTION, CreditsPart } from './service/credits.js';
import { DestinationsPart } from './service/destinations.js';
import { FeesPart } from './service/fees.js';
import { HoldsPart } from './service/holds.js';
import { LedgerPart } from './service/ledger.js';
import { PayoutsPart } from './service/payouts.js';
import { ReconPart } from './service/recon.js';
import { ReportsPart } from './service/reports.js';
import { StatementsPart } from './service/statements.js';

export type { FinanceServiceDeps };

/**
 * Finance use cases. Depends only on its repository, the payout provider, the event bus, the clock and other modules' public APIs.
 * The work is split by area (service/*.ts); this class is the module's public API, its event consumers and jobs.
 */
export class FinanceService implements FinancePublicApi {
  readonly core: Core;
  readonly ledger: LedgerPart;
  readonly fees: FeesPart;
  readonly holds: HoldsPart;
  readonly payouts: PayoutsPart;
  readonly statements: StatementsPart;
  readonly destinations: DestinationsPart;
  readonly reports: ReportsPart;
  readonly recon: ReconPart;
  readonly credits: CreditsPart;

  constructor(deps: FinanceServiceDeps) {
    this.core = new Core(deps);
    this.ledger = new LedgerPart(this.core);
    this.fees = new FeesPart(this.core);
    this.holds = new HoldsPart(this.core);
    this.payouts = new PayoutsPart(this.core);
    this.statements = new StatementsPart(this.core);
    this.destinations = new DestinationsPart(this.core);
    this.reports = new ReportsPart(this.core);
    this.recon = new ReconPart(this.core);
    this.credits = new CreditsPart(this.core);
    this.core.parts = { ledger: this.ledger, fees: this.fees, holds: this.holds, payouts: this.payouts, statements: this.statements, destinations: this.destinations, reports: this.reports, recon: this.recon, credits: this.credits };
  }

  /* ---------------- public API (in-process) */

  /** Effect of a refund on seller earnings and fees, shown before deciding */
  async previewRefundImpact(orderItemIds: string[], refund: common.Money, fundedBy: string): Promise<{ sellerEarningsChange: common.Money; feeReturned: common.Money; afterPayout: boolean; note: string }> {
    const p = await this.ledger.previewRefundImpact(orderItemIds, refund, fundedBy);
    return { sellerEarningsChange: p.sellerEarningsChange, feeReturned: p.feeReturned, afterPayout: p.afterPayout, note: p.note };
  }

  /** Fee and seller earnings for a price under the active fee rules */
  calculateFee(input: FeeCalcInput): Promise<FeeCalculation> {
    return this.fees.calculate(input);
  }

  /** Balances for dashboards and seller detail */
  getSellerBalances(sellerId: string): Promise<SellerBalances> {
    this.ledger.requireSeller(sellerId);
    return this.ledger.balances(sellerId);
  }

  /** Posts a seller ad charge, kept separate from commission */
  recordAdCharge(input: { sellerId: string; campaignId: string; campaignRef: string; period: common.DateRange; amount: common.Money; description: string }): Promise<LedgerEntry> {
    return this.ledger.recordAdCharge(input);
  }

  /** Posts a fulfillment-service fee to the seller ledger as service_fee; same idempotencyKey returns the first entry */
  recordServiceFee(input: { sellerId: string; amount: common.Money; kind: string; reference: Reference; description: string; idempotencyKey: string }): Promise<LedgerEntry> {
    return this.ledger.recordServiceFee(input);
  }

  /** Credits back all or part of an ad charge or service fee as charge_credit (never more than what is left of it) */
  creditSellerCharge(input: { sellerId: string; amount: common.Money; originalEntryId: string; reason: string; idempotencyKey: string }): Promise<LedgerEntry> {
    return this.ledger.creditSellerCharge(input);
  }

  /** Credits a seller without an original charge as seller_credit: posted at once up to creditSecondReviewerThreshold, above it after finance.credits.issue; same idempotencyKey returns the first credit */
  creditSeller(input: { sellerId: string; amount: common.Money; reason: string; reference: Reference; idempotencyKey: string }): Promise<SellerCredit> {
    return this.credits.creditSeller(input);
  }

  /** Current state of a credit asked for with creditSeller, by id or by the caller's idempotency key */
  getSellerCredit(by: { creditId?: string; idempotencyKey?: string }): Promise<SellerCredit | null> {
    return this.credits.getSellerCredit(by);
  }

  /** Withdraws a credit still pending_approval (its approval request is cancelled; nothing is posted) */
  withdrawSellerCredit(input: { creditId?: string; idempotencyKey?: string; reason: string }): Promise<SellerCredit> {
    return this.credits.withdrawSellerCredit(input);
  }

  /** A money difference another module (wallet) found in its own books, for the daily store_credit check */
  recordExternalDifference(input: { check: 'store_credit'; subject: string; description: string; expected: common.Money; actual: common.Money; reference?: Reference; key: string }): Promise<ReconItem> {
    return this.recon.recordExternalDifference(input);
  }

  /** Company trading costs for the Official Store margin */
  recordCompanyCost(input: { kind: 'buying_cost' | 'shipping_expense' | 'return_loss' | 'write_off' | 'supplier_credit'; amount: common.Money; reference: Reference; at: string }): Promise<void> {
    return this.ledger.recordCompanyCost(input);
  }

  /** Whether a seller can be paid (verified destination, no full hold) */
  hasPayoutBlock(sellerId: string): Promise<{ blocked: boolean; reasons: string[] }> {
    this.ledger.requireSeller(sellerId);
    return this.ledger.payoutBlock(sellerId);
  }

  /** Fee income per seller per market day (commission and fees charged, fee refunds, net, ad income), from fee_charges and ledger_entries. Company revenue only; seller sales are not income. */
  marketplaceIncomeByDay(range: common.DateRange, sellerId?: string): Promise<DailySellerIncome[]> {
    return this.reports.incomeByDay(range, sellerId);
  }

  /** One seller's balances, ledger, payouts, statements, holds, amounts owed and adjustments (seller Finance page, admin seller 360) */
  getSellerAccount(sellerId: string): Promise<SellerFinanceDetail> {
    this.ledger.requireSeller(sellerId);
    return this.reports.sellerDetail(sellerId);
  }

  /** An itemised statement of this seller */
  getStatementForSeller(sellerId: string, ref: string): Promise<Statement | null> {
    return this.statements.byRef(ref, sellerId);
  }

  /** Any seller's statement as the seller sees it (staff) */
  getStatement(ref: string): Promise<Statement | null> {
    return this.statements.byRef(ref);
  }

  /** Payout run with seller rows, holds, approvals, pre-release checks, the last run's failed payouts and destination reviews */
  getPayoutRun(ref: string): Promise<(PayoutRun & { sellers: common.Page<RunPayoutRow>; failedPayouts: Payout[]; destinationReviews: DestinationReview[] }) | null> {
    return this.payouts.runDetail(ref);
  }

  /** Payout runs, newest first */
  listPayoutRuns(filter: { status?: string }, page: common.PageInput): Promise<common.Page<PayoutRun>> {
    return this.payouts.listRuns(filter, toPageRequest(page));
  }

  /** Holds placed for a case, order or chargeback, batched (Case.holds in the dispute view) */
  holdsForReference(references: { kind: string; id: string }[]): Promise<Hold[]> {
    return this.holds.holdsForReference(references);
  }

  /** Fee and earnings at a price on the seller's own offer form (calculateFee under the active rules, with the fee basis explained) */
  previewOfferEarnings(items: { offerId: string; sellerId: string; categoryId: string | null; price: common.Money }[]): Promise<Record<string, EarningsPreview>> {
    return this.fees.previewOfferEarnings(items);
  }

  /** The next payout run to be released (draft, pending approval or approved), for the admin dashboard */
  getNextPayoutRun(): Promise<PayoutRun | null> {
    return this.payouts.nextRun();
  }

  /** previewRefundImpact for staff decision panels: resolves the order's items and refundable amounts, then the seller earnings, fee and balance effect */
  previewRefundImpactForOrder(orderRef: string, items: { orderItemId: string; quantity?: number }[] | null, refund: common.Money | null, fundedBy: string): Promise<RefundImpactPreview> {
    return this.ledger.previewRefundImpactForOrder(orderRef, items, refund, fundedBy);
  }

  /** Export rows for reports datasets finance.admin.ledger, finance.admin.payout_run, finance.admin.checks and finance.seller.ledger (seller rows scoped to the principal's seller) */
  exportRows(dataset: string, filters: unknown, principal: identity.Principal, cursor?: string): Promise<{ rows: unknown[]; nextCursor?: string }> {
    return this.reports.exportRows(dataset, filters, principal, cursor);
  }

  /* ---------------- events consumed */

  onOrderAcceptedFromOrders(event: EventPayload<'orders.order.accepted'>) {
    return this.ledger.onOrderAccepted(event);
  }

  onItemCancelledFromOrders(event: EventPayload<'orders.item.cancelled'>) {
    return this.ledger.onItemCancelled(event);
  }

  onItemDeliveredFromOrders(event: EventPayload<'orders.item.delivered'>) {
    return this.ledger.onItemDelivered(event);
  }

  onPaymentCapturedFromPayments(event: EventPayload<'payments.payment.captured'>) {
    return this.recon.onPaymentCaptured(event);
  }

  onRefundApprovedFromReturns(event: EventPayload<'returns.refund.approved'>) {
    return this.ledger.onRefundApproved(event);
  }

  onRefundSentFromPayments(event: EventPayload<'payments.refund.sent'>) {
    return this.ledger.onRefundSent(event);
  }

  /** payments.refund.failed: the stored funding split is marked failed; a final failure goes to the daily checks */
  onRefundFailedFromPayments(event: EventPayload<'payments.refund.failed'>, eventId: string) {
    return this.ledger.onRefundFailed(event, eventId);
  }

  onChargebackOpenedFromPayments(event: EventPayload<'payments.chargeback.opened'>) {
    return this.holds.onChargebackOpened(event);
  }

  onChargebackDecidedFromPayments(event: EventPayload<'payments.chargeback.decided'>) {
    return this.holds.onChargebackDecided(event);
  }

  onLabelCreatedFromReturns(event: EventPayload<'returns.label.created'>) {
    return this.ledger.onReturnLabel(event);
  }

  onLabelPurchasedFromShipping(event: EventPayload<'shipping.label.purchased'>) {
    return this.ledger.onLabelPurchased(event);
  }

  onLabelVoidedFromShipping(event: EventPayload<'shipping.label.voided'>) {
    return this.ledger.onLabelVoided(event);
  }

  onClaimStatusChangedFromShipping(event: EventPayload<'shipping.claim.status_changed'>) {
    return this.ledger.onClaimStatusChanged(event);
  }

  onCouponRedeemedFromPromotions(event: EventPayload<'promotions.coupon.redeemed'>) {
    return this.ledger.onCouponRedeemed(event);
  }

  /** promotions.redemption.reversed: the recorded discount funding (platform and seller parts) is reversed */
  onRedemptionReversedFromPromotions(event: EventPayload<'promotions.redemption.reversed'>, eventId: string) {
    return this.ledger.onRedemptionReversed(event, eventId);
  }

  onSellerApprovedFromSellers(event: EventPayload<'sellers.seller.approved'>) {
    return this.holds.onSellerApproved(event);
  }

  onSellerSuspendedFromSellers(event: EventPayload<'sellers.seller.suspended'>) {
    return this.holds.onSellerSuspended(event);
  }

  async onSellerClosedFromSellers(event: EventPayload<'sellers.seller.closed'>) {
    if (!isUuid(event.sellerId)) return;
    await this.statements.issueFinal(event.sellerId);
  }

  onPayoutAccountChangedFromSellers(event: EventPayload<'sellers.payout_account.changed'>) {
    return this.destinations.onAccountChanged(event);
  }

  async onApprovalDecidedFromAccess(event: EventPayload<'access.approval.decided'>) {
    if (event.module !== 'finance' && !event.actionKey.startsWith('finance.')) return;
    switch (event.actionKey) {
      case 'finance.fees.change':
        return this.fees.onApprovalDecided(event);
      case 'finance.payouts.release':
        return this.payouts.onApprovalDecided(event);
      case CREDIT_ACTION:
        return this.credits.onApprovalDecided(event);
      case 'finance.reconciliation.correct':
        return this.recon.onApprovalDecided(event);
      case 'finance.holds.place':
      case 'finance.holds.release':
      case 'finance.adjustments.record':
      case 'finance.writeoffs.approve':
        return this.holds.onApprovalDecided(event);
      default:
        return;
    }
  }

  onCaseDecidedFromSupport(event: EventPayload<'support.case.decided'>) {
    return this.holds.onCaseDecided(event);
  }

  onCreditGrantedFromWallet(event: EventPayload<'wallet.credit.granted'>) {
    return this.ledger.onCreditGranted(event);
  }

  onCreditUsedFromWallet(event: EventPayload<'wallet.credit.used'>) {
    return this.ledger.onCreditUsed(event);
  }

  onCreditReversedFromWallet(event: EventPayload<'wallet.credit.reversed'>) {
    return this.ledger.onCreditReversed(event);
  }

  onCreditExpiredFromWallet(event: EventPayload<'wallet.credit.expired'>) {
    return this.ledger.onCreditExpired(event);
  }

  onCreditCorrectedFromWallet(event: EventPayload<'wallet.credit.corrected'>) {
    return this.ledger.onCreditCorrected(event);
  }

  /* ---------------- jobs */

  releasePending() {
    return this.ledger.releasePending();
  }

  payoutRunCreate() {
    return this.payouts.createDue();
  }

  payoutRunRelease() {
    return this.payouts.releaseDue();
  }

  payoutStatusPoll() {
    return this.payouts.poll();
  }

  reconcileDaily() {
    return this.recon.daily();
  }

  holdsReviewDue() {
    return this.holds.reviewDue();
  }

  negativeBalanceAge() {
    return this.holds.ageNegativeBalances();
  }

  feeRulesActivate() {
    return this.fees.activateDue();
  }
}
