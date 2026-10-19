// Types and labels for admin/cases and admin/case (design: pages/admin/admin-cases.html, admin-case.html),
// mapped from GET /api/admin/support/cases, /cases/stats, /categories, /assignees and the AdminCase screen query.
import type { components } from '@marketly/web-shared/api';
import type { Tone } from '@marketly/web-shared/ui';

type S = components['schemas'];
export type CaseRow = S['support.AdminCaseRow'];
export type CaseStats = S['support.CaseStats'];
export type CaseCategory = S['support.CaseCategory'];
export type Assignee = S['support.CaseAssignee'];

export type ApiPriority = 'low' | 'medium' | 'high' | 'urgent';
export type TabKey = 'all' | 'mine' | 'unassigned' | 'overdue' | 'disputes';
export type SortKey = 'deadline' | 'newest' | 'priority';

export const TAB_LABEL: Record<TabKey, string> = { all: 'All open', mine: 'My cases', unassigned: 'Unassigned', overdue: 'Overdue', disputes: 'Disputes' };
export const API_TAB: Record<TabKey, 'all_open' | 'mine' | 'unassigned' | 'overdue' | 'disputes'> = { all: 'all_open', mine: 'mine', unassigned: 'unassigned', overdue: 'overdue', disputes: 'disputes' };
export const API_SORT: Record<SortKey, 'next_deadline' | 'newest' | 'priority'> = { deadline: 'next_deadline', newest: 'newest', priority: 'priority' };

export const PRIORITY_LABEL: Record<ApiPriority, string> = { urgent: 'Urgent', high: 'High', medium: 'Medium', low: 'Low' };
export const PRIORITY_TONE: Record<ApiPriority, Tone> = { urgent: 'danger', high: 'danger', medium: 'warning', low: '' };

/** "2 h 40 m" from minutes. */
export function minutesLabel(m: number | null | undefined): string {
  if (m == null) return '—';
  const h = Math.floor(m / 60);
  const r = Math.round(m % 60);
  return h ? `${h} h${r ? ` ${r} m` : ''}` : `${r} min`;
}

/* ---------------- Case detail (admin/case) ---------------- */

export type CaseDetail = S['support.AdminCaseDetail'];
export type CaseMessage = S['support.CaseMessage'];
export type Remedy = S['support.Remedy'];
export type DecisionInput = S['support.DecisionInput'];
export type Outcome = DecisionInput['outcome'];
export type RemedyKind = DecisionInput['remedies'][number]['kind'];
export type ChargedTo = 'seller' | 'platform' | 'shared';

export const OUTCOMES: Array<{ value: Outcome; label: string }> = [
  { value: 'customer_favored', label: 'Customer favored' },
  { value: 'seller_favored', label: 'Seller favored' },
  { value: 'shared', label: 'Shared outcome' },
  { value: 'no_fault', label: 'No fault' },
  { value: 'information_only', label: 'Information only' },
];
export const OUTCOME_LABEL = Object.fromEntries(OUTCOMES.map((o) => [o.value, o.label])) as Record<Outcome, string>;

export const CHARGED: Array<{ value: ChargedTo; label: string; text: string }> = [
  { value: 'seller', label: 'Seller', text: 'the seller' },
  { value: 'platform', label: 'Platform: goodwill', text: 'Marketly as goodwill' },
  { value: 'shared', label: 'Shared', text: 'the seller and Marketly' },
];

export const REMEDY_LABEL: Record<RemedyKind, string> = {
  refund: 'full item refund',
  partial_refund: 'partial refund',
  replacement: 'replacement',
  return_label: 'free return label',
  goodwill_credit: 'goodwill credit',
  ship_by_deadline: 'ship by a deadline',
  none: 'no remedy',
};

export const ESCALATE_TO: Array<{ value: 'returns' | 'finance' | 'trust' | 'seller_management' | 'support_lead'; label: string }> = [
  { value: 'support_lead', label: 'Support lead' },
  { value: 'returns', label: 'Returns' },
  { value: 'finance', label: 'Finance' },
  { value: 'trust', label: 'Trust and Risk' },
  { value: 'seller_management', label: 'Seller Manager' },
];

/** 11:59 PM Pacific on a calendar day (YYYY-MM-DD), as an ISO instant. */
export function pacificEndOfDay(day: string): string {
  const noon = new Date(`${day}T12:00:00Z`);
  const la = new Date(noon.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  const utc = new Date(noon.toLocaleString('en-US', { timeZone: 'UTC' }));
  const offsetMs = utc.getTime() - la.getTime();
  return new Date(new Date(`${day}T23:59:00Z`).getTime() + offsetMs).toISOString();
}

/** Parses a dollar amount typed by staff ("$114.54") into minor units; NaN when invalid. */
export const toMinor = (s: string): number => {
  const n = Number(s.replace(/[$,\s]/g, ''));
  return s.trim() && Number.isFinite(n) ? Math.round(n * 100) : NaN;
};

interface GqlMoney {
  amount: number;
  currency: string;
  formatted?: string | null;
}
/** AdminCase `refundImpactPreview` (withRemedyPreview): the seller earnings effect of a proposed refund. */
export interface RefundImpactPreview {
  fundedBy: string;
  afterPayout: boolean;
  note: string | null;
  refund: GqlMoney;
  sellerEarningsChange: GqlMoney;
  feeReturned: GqlMoney;
  platformShare: GqlMoney;
  balanceAfter: GqlMoney | null;
}
