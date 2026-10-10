/**
 * Rows (snake_case) → API types (camelCase), one place per type. Names, destinations and approval
 * infos are looked up by the caller (batched) and passed in.
 */
import type * as common from '../../spec/common.js';
import type { Adjustment, AmountOwed, DestinationReview, DestinationStatus, FeeRuleSet, Hold, LedgerEntry, Payout, Reference, StatementSummary, TradingTarget } from '../../spec/finance.js';
import { decodeActor, m, SYSTEM, TYPE_LABELS, type EntryType } from './domain/rules.js';
import type { AdjustmentRec, EntryRec, HoldRec, OwedRec, PayoutRec, ReviewRec, RuleSetRec, StatementRec, TargetRec } from './ports.js';

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export function reference(kind: string | null | undefined, id: string | null | undefined, ref?: string | null): Reference | null {
  if (!kind || !id) return null;
  return { kind: kind as Reference['kind'], id, ref: ref ?? null };
}

export function toEntry(r: EntryRec, statementRefs: Map<string, string>): LedgerEntry {
  return {
    id: r.id,
    at: r.at.toISOString(),
    type: r.type as LedgerEntry['type'],
    typeLabel: TYPE_LABELS[r.type as EntryType] ?? r.type,
    reference: reference(r.ref_kind, r.ref_id, r.ref_label) ?? { kind: 'seller', id: r.seller_id, ref: null },
    description: r.description,
    amount: m(r.amount, r.currency),
    bucket: r.bucket as LedgerEntry['bucket'],
    balanceAfter: m(r.balance_after, r.currency),
    statementId: r.statement_id,
    recordedBy: decodeActor(r.recorded_by),
    statementRef: r.statement_id ? (statementRefs.get(r.statement_id) ?? null) : null,
  };
}

export function toHold(r: HoldRec, sellerName: string, approval: common.ApprovalInfo | null, refLabel?: string | null): Hold {
  return {
    id: r.id,
    sellerId: r.seller_id,
    sellerName,
    amount: m(r.amount, r.currency),
    releasedAmount: m(r.released_amount, r.currency),
    reasonCode: r.reason_code as Hold['reasonCode'],
    reason: r.reason,
    reviewDate: r.review_date,
    reference: reference(r.ref_kind, r.ref_id, refLabel ?? null),
    trustReportId: null,
    status: r.status as Hold['status'],
    placedBy: decodeActor(r.placed_by) ?? SYSTEM,
    placedAt: r.placed_at.toISOString(),
    releasedAt: iso(r.released_at),
    releaseReason: r.release_reason,
    approval,
  };
}

export function toAdjustment(r: AdjustmentRec, sellerName: string, approval: common.ApprovalInfo | null): Adjustment {
  return {
    id: r.id,
    ref: r.ref,
    sellerId: r.seller_id,
    sellerName,
    direction: r.direction as Adjustment['direction'],
    amount: m(r.amount, r.currency),
    reasonCode: r.reason_code as Adjustment['reasonCode'],
    reason: r.reason,
    reference: reference(r.ref_kind, r.ref_id),
    status: r.status as Adjustment['status'],
    recordedBy: decodeActor(r.recorded_by) ?? SYSTEM,
    approval,
    createdAt: r.created_at.toISOString(),
  };
}

export function toOwed(r: OwedRec, sellerName: string, approvals?: Map<string, common.ApprovalInfo>): AmountOwed {
  return {
    pendingWriteOff: r.write_off_amount !== null ? m(r.write_off_amount, r.currency) : null,
    approval: r.approval_request_id ? (approvals?.get(r.approval_request_id) ?? { required: true, approvalRequestId: r.approval_request_id, approvers: [] }) : null,
    id: r.id,
    sellerId: r.seller_id,
    sellerName,
    amount: m(r.amount, r.currency),
    remaining: m(r.remaining, r.currency),
    since: r.since,
    dueBy: r.due_by,
    status: r.status as AmountOwed['status'],
    origin: Array.isArray(r.origin) ? (r.origin as unknown as Reference[]) : [],
    note: r.note,
  };
}

export interface PayoutContext {
  sellerName: string;
  destination: DestinationStatus;
  statement?: StatementRec | null;
  retryOfRef?: string | null;
  retriedBy?: string | null;
}

export function toPayout(r: PayoutRec, c: PayoutContext): Payout {
  const nextStep =
    r.status === 'failed'
      ? c.retriedBy
        ? 'Retried with a new payout'
        : 'Fix or verify the payout account, then retry the payout. The money stays in the balance.'
      : r.status === 'on_hold'
        ? 'Waiting for a hold, account restriction or payout account review to clear'
        : r.status === 'processing'
          ? 'Waiting for the bank to confirm the deposit'
          : null;
  const resultNote =
    r.status === 'paid'
      ? `Paid to ${c.destination.label}`
      : r.status === 'failed'
        ? `${r.failure_reason ?? 'The bank returned the payout'}${r.failure_code ? ` (${r.failure_code})` : ''}. Funds kept safe in the balance.`
        : r.status === 'cancelled'
          ? 'Not sent; the amount stays in the balance for the next payout'
          : null;
  return {
    id: r.id,
    ref: r.ref,
    sellerId: r.seller_id,
    sellerName: c.sellerName,
    runId: r.run_id,
    amount: m(r.amount, r.currency),
    status: r.status as Payout['status'],
    destination: c.destination,
    requestedOn: r.requested_on,
    releasedAt: iso(r.released_at),
    paidAt: iso(r.paid_at),
    arrivedOn: r.paid_at ? r.paid_at.toISOString().slice(0, 10) : null,
    failedAt: iso(r.failed_at),
    failureCode: r.failure_code,
    failureReason: r.failure_reason,
    nextStep,
    retryOf: r.retry_of,
    retriedBy: c.retriedBy ?? null,
    statementId: r.statement_id,
    statementPeriod: c.statement ? { from: c.statement.period_from, to: c.statement.period_to } : null,
    bankReference: r.bank_reference,
    holdsWithheld: m(r.holds_withheld, r.currency),
    negativeOffset: m(r.negative_offset, r.currency),
    resultNote,
    statementRef: c.statement?.ref ?? null,
    retryOfRef: c.retryOfRef ?? null,
  };
}

export function toReview(r: ReviewRec, sellerName: string, pauseUntil: Date | null): DestinationReview {
  return {
    id: r.id,
    sellerId: r.seller_id,
    sellerName,
    fromLabel: r.from_label,
    toLabel: r.to_label,
    requestedBy: decodeActor(r.requested_by) ?? SYSTEM,
    requestedAt: r.requested_at.toISOString(),
    status: r.status as DestinationReview['status'],
    checks: Array.isArray(r.checks) ? (r.checks as unknown as DestinationReview['checks']) : [],
    pauseUntil: iso(pauseUntil),
    decidedBy: decodeActor(r.decided_by),
    decidedAt: iso(r.decided_at),
    reason: r.reason,
  };
}

export function toRuleSet(r: RuleSetRec, rates: { category_id: string; category_name: string; rate_bps: number }[], approval: common.ApprovalInfo | null): FeeRuleSet {
  const treatment = (r.treatment ?? {}) as unknown as FeeRuleSet['treatment'];
  return {
    id: r.id,
    version: r.version,
    status: r.status as FeeRuleSet['status'],
    basis: r.basis as FeeRuleSet['basis'],
    includeShipping: r.include_shipping,
    platformDiscountsReduceFee: r.platform_discounts_reduce_fee,
    defaultRateBps: r.default_rate_bps,
    categoryRates: rates.map((c) => ({ categoryId: c.category_id, categoryName: c.category_name, rateBps: c.rate_bps })),
    treatment,
    agreementVersion: r.agreement_version,
    effectiveFrom: iso(r.effective_from),
    reason: r.reason,
    approval,
    createdBy: decodeActor(r.created_by) ?? SYSTEM,
    createdAt: r.created_at.toISOString(),
  };
}

export function toStatementSummary(r: StatementRec, payout: PayoutRec | null): StatementSummary {
  return {
    id: r.id,
    ref: r.ref,
    period: { from: r.period_from, to: r.period_to },
    status: r.status as StatementSummary['status'],
    payoutRef: payout?.ref ?? null,
    payoutAmount: payout ? m(payout.amount, payout.currency) : null,
    payoutStatus: payout?.status ?? null,
    issuedAt: iso(r.issued_at),
  };
}

export function toTarget(r: TargetRec): TradingTarget {
  return {
    id: r.id,
    period: r.period,
    categoryId: r.category_id,
    categoryName: null,
    salesTarget: m(r.sales_target, r.currency),
    marginTargetPct: r.margin_target_bps === null ? null : r.margin_target_bps / 100,
    note: r.note,
    setBy: decodeActor(r.set_by) ?? SYSTEM,
    setAt: r.set_at.toISOString(),
  };
}
