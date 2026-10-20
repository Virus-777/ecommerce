// Types and labels for the admin "Payout run" screen (design: pages/admin/admin-payouts.html and
// admin-payouts--approve-run.html), mapped from GET /api/admin/finance/payout-runs, …/{id}, …/{id}/payouts,
// /finance/payouts?status=failed and /finance/destination-reviews.
import type { components } from '@marketly/web-shared/api';
import { dateTime } from '@/app/parts';

type S = components['schemas'];
export type PayoutRun = S['finance.PayoutRun'];
export type RunPayoutRow = S['finance.RunPayoutRow'];
export type Payout = S['finance.Payout'];
export type DestinationReview = S['finance.DestinationReview'];
/** Runs that are still being prepared, approved or released: the screen opens the newest of these. */
export const OPEN_RUN = new Set<PayoutRun['status']>(['draft', 'pending_approval', 'approved', 'releasing']);

export type DestState = 'verified' | 'review' | 'pending' | 'missing';

export const destState = (s: RunPayoutRow['destination']['status']): DestState =>
  s === 'verified' ? 'verified' : s === 'change_under_review' ? 'review' : s === 'verification_pending' ? 'pending' : 'missing';

export const PAYOUT_STATUS: Record<RunPayoutRow['status'], string> = {
  pending: 'Scheduled',
  on_hold: 'On hold',
  processing: 'Processing',
  paid: 'Paid',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export const RUN_STATUS: Record<PayoutRun['status'], string> = {
  draft: 'Draft',
  pending_approval: 'Waiting for approval',
  approved: 'Approved',
  releasing: 'Releasing',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

export interface ApprovalStep {
  key: string;
  who: string;
  role: string;
  /** Page card sub line and dialog sub line. */
  meta: string;
  dialogMeta: string;
  /** Title on the page card while this step waits. */
  pendingTitle?: string;
  state: 'approved' | 'pending' | 'sent-back';
}

const ORDINAL = ['First', 'Second', 'Third', 'Fourth'];

/** The run's approval steps; before anyone is asked, one waiting step per approver role. */
export function approvalSteps(run: PayoutRun): ApprovalStep[] {
  if (run.approvals.length) {
    return [...run.approvals]
      .sort((a, b) => a.order - b.order)
      .map((a, i) => {
        const state = a.status === 'approved' ? 'approved' : a.status === 'sent_back' ? 'sent-back' : 'pending';
        const who = a.approver?.name ?? (i === 0 ? 'Finance reviewer' : 'Second Finance reviewer');
        return {
          key: `${a.order}`,
          who,
          role: a.role,
          pendingTitle: a.approver?.name ? undefined : who,
          meta:
            state === 'approved'
              ? `Approved ${a.at ? dateTime(a.at) : ''}`.trim()
              : state === 'sent-back'
                ? `Sent back${a.approver?.name ? ` by ${a.approver.name}` : ''}${a.at ? ` · ${dateTime(a.at)}` : ''}`
                : a.dueAt
                  ? `${a.approver?.name ? `Assigned to ${a.approver.name} · ` : ''}due ${dateTime(a.dueAt)}`
                  : 'Waiting for a decision',
          dialogMeta: `${ORDINAL[i] ?? `Step ${i + 1}`} approval · ${state === 'approved' && a.at ? dateTime(a.at) : 'now'}`,
          state,
        };
      });
  }
  const roles = run.approval?.approvers?.length ? run.approval.approvers : ['Finance reviewer'];
  return roles.map((role, i) => ({
    key: `r${i}`,
    who: role,
    role,
    pendingTitle: i === 0 ? role : 'Second Finance reviewer',
    meta: run.status === 'draft' ? 'After the run is submitted' : 'Waiting for a decision',
    dialogMeta: `${ORDINAL[i] ?? `Step ${i + 1}`} approval · now`,
    state: 'pending' as const,
  }));
}

export const RUN_CHECK_TONE: Record<PayoutRun['checks'][number]['level'], 'ok' | 'info' | 'warn'> = { ok: 'ok', info: 'info', warn: 'warn', fail: 'warn' };

export const CHECK_TONE: Record<DestinationReview['checks'][number]['result'], 'ok' | 'info' | 'warn'> = { passed: 'ok', pending: 'warn', failed: 'warn' };

export const STATUS_MEANING: Array<{ status: string; text: string }> = [
  { status: 'Pending', text: 'In a run, not yet released' },
  { status: 'Processing', text: 'Sent to the bank, not yet confirmed' },
  { status: 'Paid', text: 'Bank confirmed the deposit' },
  { status: 'Failed', text: 'Returned by the bank with a reason' },
];
