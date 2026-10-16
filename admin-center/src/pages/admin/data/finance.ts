// Types and helpers for the admin "Payments and fees" screen (design: pages/admin/admin-finance.html,
// --disputes-and-chargebacks, --refunds-failing), mapped from GET /api/admin/finance/overview, /finance/fee-rules,
// /finance/reconciliation/items, /payments/disputes and /payments/refunds. The approval and step-up helpers at
// the bottom are shared by the other finance and support screens.
import { ApiError, type components } from '@marketly/web-shared/api';
import { dayKey } from '@/app/parts';

type S = components['schemas'];
export type FinanceOverview = S['finance.FinanceOverview'];
export type FeeRules = S['finance.FeeRulesAdmin'];
export type FeeRuleSet = S['finance.FeeRuleSet'];
export type ReconItem = S['finance.ReconItem'];
export type Dispute = S['payments.Dispute'];
export type Refund = S['payments.Refund'];
export type Money = { amount: number; currency: string };

export type Edge = 'flagged' | 'warn' | '';
export type Period = 'today' | '7d' | 'mtd';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Pacific calendar days for a period: from and to (inclusive), and the label the header shows. */
export function periodRange(period: Period, now = new Date()): { from: string; to: string; label: string } {
  const to = dayKey(now);
  const from = period === 'today' ? to : period === '7d' ? dayKey(new Date(now.getTime() - 6 * 86_400_000)) : `${to.slice(0, 8)}01`;
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  const label =
    from === to
      ? `${MONTHS[tm - 1]} ${td}, ${ty}`
      : fm === tm && fy === ty
        ? `${MONTHS[fm - 1]} ${fd}–${td}, ${ty}`
        : `${MONTHS[fm - 1]} ${fd} – ${MONTHS[tm - 1]} ${td}, ${ty}`;
  return { from, to, label };
}

export const PERIODS: Array<{ value: Period; label: string }> = [
  { value: 'today', label: 'Today' },
  { value: '7d', label: '7 days' },
  { value: 'mtd', label: 'Month to date' },
];

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
export const pct = (bps: number) => String(Math.round(bps) / 100);

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
