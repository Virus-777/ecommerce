// Types and helpers for the admin "Payments and fees" screen (design: pages/admin/admin-finance.html,
// --disputes-and-chargebacks, --refunds-failing), mapped from GET /api/admin/finance/overview, /finance/fee-rules,
// /finance/reconciliation/items, /payments/disputes and /payments/refunds. The approval and step-up helpers at
// the bottom are shared by the other finance and support screens.
import { ApiError, type components } from '@marketly/web-shared/api';

type S = components['schemas'];
export type FinanceOverview = S['finance.FinanceOverview'];
export type FeeRules = S['finance.FeeRulesAdmin'];
export type FeeRuleSet = S['finance.FeeRuleSet'];
export type ReconItem = S['finance.ReconItem'];
export type Dispute = S['payments.Dispute'];
export type Refund = S['payments.Refund'];
export type Money = { amount: number; currency: string };

export type Edge = 'flagged' | 'warn' | '';
/**
 * Change of a range figure against the comparison range (Finance overview KPIs, docs/09 §4.3): "12.5%" with its
 * direction, and whether that direction is good. Null when there is nothing to compare with.
 */
export function overviewDelta(now: Money, before: Money | undefined, higherIsBetter = true): { delta: string; dir: 'up' | 'down'; good: boolean } | null {
  if (!before || before.amount === 0 || now.amount === before.amount) return null;
  const pct = ((now.amount - before.amount) / Math.abs(before.amount)) * 100;
  const dir = pct > 0 ? 'up' : 'down';
  return { delta: `${Math.abs(pct).toFixed(1)}%`, dir, good: (dir === 'up') === higherIsBetter };
}

const BASIS: Record<FeeRuleSet['basis'], string> = {
  after_seller_discounts: 'Item price after seller-funded discounts',
  before_discounts: 'Item price before discounts',
};
const CANCEL: Record<FeeRuleSet['treatment']['cancellationBeforeDispatch'], string> = { no_fee: 'No fee', fee_kept: 'Fee kept' };
const RETURNS: Record<FeeRuleSet['treatment']['returns'], string> = {
  fee_returned_pro_rata: 'Fee returned in proportion to the refunded item value',
  fee_kept: 'Fee kept',
};
const DISPUTES: Record<FeeRuleSet['treatment']['paymentDisputes'], string> = {
  fee_kept_returned_if_won: 'Fee kept while open; returned if we win',
  fee_kept: 'Fee kept',
  fee_returned: 'Fee returned',
};

/** The design's fee rule list, from the active rule set. */
export function feeRulePairs(r: FeeRuleSet): Array<[string, string]> {
  return [
    ['Commission basis', BASIS[r.basis]],
    ['Shipping', r.includeShipping ? 'Included in commission' : 'Not included in commission'],
    ['Platform-funded discounts', r.platformDiscountsReduceFee ? 'Reduce the item price that commission is charged on' : 'Do not reduce seller proceeds. Platform pays the difference.'],
    ['Seller-funded discounts', r.basis === 'after_seller_discounts' ? 'Reduce the item price that commission is charged on' : 'Do not reduce the commission basis'],
    ['Cancellation before dispatch', CANCEL[r.treatment.cancellationBeforeDispatch]],
    ['Returns and refunds', RETURNS[r.treatment.returns]],
    ['Payment disputes', DISPUTES[r.treatment.paymentDisputes]],
  ];
}

/** A rate in basis points as the design prints it ("8", "12.5"). */
/** Basis points as a percent number without the sign: 1500 → "15" */
export const bpsNumber = (bps: number) => String(Math.round(bps) / 100);

export const refundEdge = (r: Refund): Edge => (r.status === 'failed' ? 'flagged' : r.outcomeUnknown ? 'warn' : '');

/** "Why it failed" cell of a failing refund. */
export function refundWhy(r: Refund): { why: string; detail: string } {
  if (r.outcomeUnknown) return { why: 'Provider timed out, outcome unknown', detail: 'We check the provider before any retry' };
  return { why: r.failureReason ?? r.statusLabel, detail: r.nextStep ?? r.destinationLabel };
}

export const reconEdge = (i: ReconItem): Edge => (i.ageDays >= 3 ? 'flagged' : i.ageDays >= 1 ? 'warn' : '');

/* ---------------- Approvals (shared by the finance and support screens) ---------------- */


/** APPROVAL_REQUIRED: nothing was saved; an approval request was opened (details.approvalRequestId). */
export const sentForApproval = (e: unknown): boolean => e instanceof ApiError && e.code === 'APPROVAL_REQUIRED';
