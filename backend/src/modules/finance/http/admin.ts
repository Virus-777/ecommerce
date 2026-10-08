import { notImplemented, routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/finance.js';
import type { FinanceService } from '../service.js';

/**
 * Admin API: /api/admin/finance/…  (docs/api/modules/finance.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const adminRoutes = (service: FinanceService) => {
  void service;
  return routes(endpoints, 'admin', {
    /** GET /overview: Collected payments, company sales, fee income, owed to sellers, refunds, holds and discount funding */
    getOverview: notImplemented,
    /** GET /marketplace-income: Marketplace fee income, ad income and amounts owed to sellers (separate from company trading) */
    getMarketplaceIncome: notImplemented,
    /** GET /trading-targets: Official Store sales and margin targets by month (plan ch. 2) */
    listTradingTargets: notImplemented,
    /** PUT /trading-targets/{period}: Set the sales and margin target for a month (whole store or one category) */
    setTradingTarget: notImplemented,
    /** GET /trading: Company trading: product sales, buying cost, discounts, shipping, returns and margin */
    getTrading: notImplemented,
    /** GET /fee-rules: Active fee rules, scheduled changes and history */
    getFeeRules: notImplemented,
    /** POST /fee-rules: Propose a new fee rule version with an effective date */
    proposeFeeRules: notImplemented,
    /** POST /fee-rules/{id}/withdraw: Withdraw a draft or scheduled fee rule version */
    withdrawFeeRules: notImplemented,
    /** POST /fee-rules/calculate: Example fee and seller earnings for a price */
    calculateFee: notImplemented,
    /** GET /sellers: Seller balances */
    listSellerFinance: notImplemented,
    /** GET /sellers/{sellerId}: One seller's balances, holds, payouts, amounts owed and adjustments */
    getSellerFinance: notImplemented,
    /** GET /sellers/{sellerId}/ledger: A seller's ledger */
    listSellerLedgerAdmin: notImplemented,
    /** GET /sellers/{sellerId}/statements: A seller's statements */
    listSellerStatementsAdmin: notImplemented,
    /** GET /statements/{id}: A statement as the seller sees it */
    getStatementAdmin: notImplemented,
    /** GET /holds: Holds with reason and review date */
    listHolds: notImplemented,
    /** POST /holds: Hold part of a seller's earnings with a reason and review date */
    placeHold: notImplemented,
    /** POST /holds/{id}/release: Release all or part of a hold */
    releaseHold: notImplemented,
    /** POST /holds/{id}/extend: Move the review date with a reason */
    extendHold: notImplemented,
    /** POST /holds/{id}/apply: Turn a held amount into a deduction (e.g. chargeback lost) */
    applyHold: notImplemented,
    /** GET /adjustments: Adjustments with reasons and approvals */
    listAdjustments: notImplemented,
    /** POST /adjustments: Credit or debit a seller with a recorded reason */
    recordAdjustment: notImplemented,
    /** GET /amounts-owed: Negative balances that became amounts owed */
    listAmountsOwed: notImplemented,
    /** POST /amounts-owed/{id}/settle: Record payment received or write off an amount owed */
    settleAmountOwed: notImplemented,
    /** GET /payout-runs: Payout runs */
    listPayoutRuns: notImplemented,
    /** POST /payout-runs: Calculate a payout run for a cutoff (normally created by the schedule) */
    createPayoutRun: notImplemented,
    /** GET /payout-runs/{id}: Run totals, approvals and pre-release checks */
    getPayoutRun: notImplemented,
    /** GET /payout-runs/{id}/statements: Seller statements settled by this payout run */
    listRunStatements: notImplemented,
    /** GET /payout-runs/{id}/payouts: Sellers in a run (held and changed-destination rows first) */
    listRunPayouts: notImplemented,
    /** POST /payout-runs/{id}/recalculate: Refresh a draft run after holds, retries or destination changes */
    recalculatePayoutRun: notImplemented,
    /** POST /payout-runs/{id}/submit: Submit the run for approval */
    submitPayoutRun: notImplemented,
    /** POST /payout-runs/{id}/approve: Approve a payout run (first or second Finance reviewer) */
    approvePayoutRun: notImplemented,
    /** POST /payout-runs/{id}/send-back: Return the run to draft with a comment */
    sendBackPayoutRun: notImplemented,
    /** POST /payout-runs/{id}/release: Release an approved run now (otherwise released at the scheduled time) */
    releasePayoutRun: notImplemented,
    /** GET /payouts: All payouts, e.g. failed payouts to follow up */
    listPayouts: notImplemented,
    /** POST /payouts/{id}/retry: Recover a failed payout to a verified destination */
    retryPayout: notImplemented,
    /** GET /destination-reviews: Payout destination changes waiting for verification and review */
    listDestinationReviews: notImplemented,
    /** POST /destination-reviews/{id}/approve: Verify a new payout destination */
    approveDestination: notImplemented,
    /** POST /destination-reviews/{id}/reject: Reject a payout destination change */
    rejectDestination: notImplemented,
    /** GET /reconciliation/days/{date}: Daily finance check: checklist, totals and failed payouts */
    getReconDay: notImplemented,
    /** GET /reconciliation/items: Mismatched payments, seller amounts, deposits and unexplained amounts */
    listReconItems: notImplemented,
    /** POST /reconciliation/items/{id}/assign: Set the owner of a mismatch */
    assignReconItem: notImplemented,
    /** POST /reconciliation/items/{id}/explain: Close a difference with a recorded reason (no money moves) */
    explainReconItem: notImplemented,
    /** POST /reconciliation/items/{id}/correct: Record a correction with a reason */
    correctReconItem: notImplemented,
    /** POST /reconciliation/days/{date}/complete: Sign off the day's checks */
    completeReconDay: notImplemented,
  });
};
