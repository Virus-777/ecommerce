// Decisions on the Trust and risk screens (admin/trust, admin/trust-report) that finish what Trust starts:
// - owner teams accept or decline routed recommendations (GET /api/admin/trust/recommendations, POST …/{id}/decide);
//   Trust and Risk deciders withdraw them (…/{id}/withdraw) or send drafts to the owner (…/{id}/route);
// - a report closes with Resolve (an outcome; blocked while a recommendation is still with an owner team, unless the
//   outcome is "referred") or Dismiss (no action), and reopens with a reason (…/reports/{id}/resolve|dismiss|reopen);
// - Trust appeals get a reviewer and a decision (…/appeals/{id}/assign|decide).
import type { components } from '@marketly/web-shared/api';
import type { Recommendation, TrustAppeal, TrustReportDetail } from './trust';

type S = components['schemas'];
export type RecAction = S['trust.Recommendation']['action'];

/** Resolve outcomes (trust.resolveReport). */
export type ResolveOutcome = 'action_taken' | 'no_violation' | 'insufficient_evidence' | 'referred';

export const RESOLVE_OUTCOMES: Array<{ value: ResolveOutcome; label: string; reporter: string }> = [
  { value: 'action_taken', label: 'Action taken', reporter: 'Thank you for your report. We found a problem and took action under our rules.' },
  { value: 'no_violation', label: 'No breach of our rules', reporter: 'We reviewed your report and did not find a breach of our rules, so no action was taken.' },
  { value: 'insufficient_evidence', label: 'Not enough evidence', reporter: 'We reviewed your report but could not confirm the problem with the evidence available. We will look again if more information comes in.' },
  { value: 'referred', label: 'Referred to another team', reporter: 'We passed your report to the team that handles this kind of problem.' },
];
export const outcomeLabel = (o: string) => RESOLVE_OUTCOMES.find((x) => x.value === o)?.label ?? o.replace(/_/g, ' ');

/** Recommendations still with an owner team: resolving is refused (RECOMMENDATIONS_OPEN) unless the outcome is referred. */
export const openWithOwners = (d: Pick<TrustReportDetail, 'recommendations'>) => d.recommendations.filter((r) => r.state === 'sent_to_owner');

const ACTIVE = new Set(['open', 'under_review', 'escalated']);
/** Status machine: resolve from under_review / escalated; dismiss from any active status; reopen from resolved / dismissed. */
export const canResolveStatus = (status: string) => status === 'under_review' || status === 'escalated';
export const canDismissStatus = (status: string) => ACTIVE.has(status);
export const canReopenStatus = (status: string) => status === 'resolved' || status === 'dismissed';

/**
 * Actions no module carries out when a recommendation is accepted: the owner does them in its own screen first
 * (e.g. Finance places the hold) and accepts with that record's reference, else EXTERNAL_REF_REQUIRED (decision D4).
 */
const EXTERNAL_REF: ReadonlySet<string> = new Set(['hold_payout', 'hold_dispatch', 'review_payments', 'refund_buyers', 'inform_customers', 'revoke_claim', 'request_identity_confirmation', 'other']);
export const needsExternalRef = (action: string) => EXTERNAL_REF.has(action);

/** Where the owner does an action that needs a reference, so the hint can say where to go first. */
const DO_IT_IN: Partial<Record<string, string>> = {
  hold_payout: 'Place the hold in Finance (payouts) with this report, then enter the hold reference.',
  hold_dispatch: 'Hold or cancel the items in Orders, then enter the order reference.',
  review_payments: 'Review the payments in Orders or Finance, then enter the reference you recorded.',
  refund_buyers: 'Approve the refunds in Returns, then enter the refund reference.',
  inform_customers: 'Open the outreach case in Support, then enter the case reference.',
  revoke_claim: 'Revoke the claim on the seller’s page, then enter the claim reference.',
  request_identity_confirmation: 'Ask for the identity check on the seller’s page, then enter its reference.',
  other: 'Do the action in its own screen first, then enter the reference of what you did.',
};
export const externalRefHint = (action: string) => DO_IT_IN[action] ?? DO_IT_IN.other!;

/** A recommendation the owner team can decide now: routed and not waiting for an approval of an earlier accept. */
export const decidable = (r: Pick<Recommendation, 'state' | 'approvalRequestId'>) => r.state === 'sent_to_owner' && !r.approvalRequestId;
/** Trust and Risk can withdraw while it is a draft or with the owner team. */
export const withdrawable = (r: Pick<Recommendation, 'state'>) => r.state === 'pending' || r.state === 'sent_to_owner';

/** Short "what the owner reviews" lines from Recommendation.params (dates, reason codes, modes). */
export function paramsSummary(params: unknown): string[] {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return [];
  const label: Record<string, string> = { reasonCode: 'Reason code', reason: 'Reason', reviewDate: 'Review date', openOrders: 'Open orders', mode: 'Mode', appealDays: 'Appeal days', amount: 'Amount' };
  const out: string[] = [];
  for (const [k, v] of Object.entries(params as Record<string, unknown>)) {
    if (v == null || v === '' || typeof v === 'object' || !label[k]) continue;
    out.push(`${label[k]}: ${String(v).replace(/_/g, ' ')}`);
  }
  return out;
}

/* ---------------- Appeals ---------------- */

export type AppealOutcome = 'uphold' | 'overturn' | 'partly_overturn';
export const APPEAL_OUTCOMES: Array<{ value: AppealOutcome; label: string; body: string }> = [
  { value: 'uphold', label: 'Uphold', body: 'The action stays in place. The appellant is told why.' },
  { value: 'overturn', label: 'Overturn', body: 'The action is reversed: the owning team undoes it and gets a work item to check the undo.' },
  { value: 'partly_overturn', label: 'Partly overturn', body: 'Part of the action changes. Describe the change; the owning team applies it.' },
];

/** Trust decides only its own appeals; seller account appeals are mirrored read-only and decided in Sellers. */
export const appealActionable = (a: Pick<TrustAppeal, 'source' | 'state'>) => a.source === 'trust' && (a.state === 'open' || a.state === 'under_review');
