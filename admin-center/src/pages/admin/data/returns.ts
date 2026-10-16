// Filters and helpers for the admin returns and refunds queue (design: pages/admin/admin-returns.html and
// admin-returns--exception-review.html). Data: GET returns/requests (tab, filters, page), GET returns/requests/stats,
// GET returns/requests/{id} (drawer), POST …/{id}/approve-without-return, POST …/{id}/request-info, POST reports/exports.
import type { components } from '@marketly/web-shared/api';
import type { IconName, Tone } from '@marketly/web-shared/ui';

export type ReturnRow = components['schemas']['returns.AdminReturnRow'];
export type ReturnEdge = 'flagged' | 'warn' | '';

export interface RowFlag {
  kind?: string;
  label: string;
  tone?: string | null;
}

export type ReturnTab = 'all' | 'decision' | 'transit' | 'inspecting' | 'refund' | 'exceptions' | 'closed';
export const API_TAB: Record<ReturnTab, 'all_open' | 'needs_decision' | 'in_transit' | 'inspecting' | 'refund_pending' | 'exceptions' | 'closed'> = {
  all: 'all_open',
  decision: 'needs_decision',
  transit: 'in_transit',
  inspecting: 'inspecting',
  refund: 'refund_pending',
  exceptions: 'exceptions',
  closed: 'closed',
};
export const TAB_COUNT_KEY: Partial<Record<ReturnTab, string>> = { all: 'allOpen', decision: 'needsDecision', transit: 'inTransit', inspecting: 'inspecting', refund: 'refundPending', exceptions: 'exceptions' };
export const TAB_LABELS: Array<{ value: ReturnTab; label: string }> = [
  { value: 'all', label: 'All open' },
  { value: 'decision', label: 'Needs decision' },
  { value: 'transit', label: 'In transit' },
  { value: 'inspecting', label: 'Inspecting' },
  { value: 'refund', label: 'Refund pending' },
  { value: 'exceptions', label: 'Exceptions' },
  { value: 'closed', label: 'Closed' },
];

export const REFUND_LABEL: Record<string, string> = {
  requested: 'Requested',
  under_review: 'Under review',
  approved: 'Approved',
  declined: 'Declined',
  processing: 'Processing',
  sent: 'Sent',
  failed: 'Failed',
  cancelled: 'Cancelled',
};
/** A refund already with Finance or sent: a second exception request is blocked. */
export const SENT_REFUNDS = new Set(['requested', 'under_review', 'approved', 'processing', 'sent']);

export interface ReturnFilters {
  type: '' | 'official' | 'marketplace';
  seller: string;
  reason: string;
  owner: string;
  refund: string;
  deadline: '' | 'overdue' | 'due_today' | 'next_3_days';
}
export const NO_RETURN_FILTERS: ReturnFilters = { type: '', seller: '', reason: '', owner: '', refund: '', deadline: '' };

type Opt = { value: string; label: string };
export const STATIC_OPTIONS: Record<'type' | 'refund' | 'deadline', Opt[]> = {
  type: [
    { value: '', label: 'All sellers' },
    { value: 'official', label: 'Official Store' },
    { value: 'marketplace', label: 'Marketplace sellers' },
  ],
  refund: [{ value: '', label: 'Any' }, ...['requested', 'under_review', 'approved', 'processing', 'sent', 'failed'].map((v) => ({ value: v, label: REFUND_LABEL[v] }))],
  deadline: [
    { value: '', label: 'Any time' },
    { value: 'overdue', label: 'Overdue' },
    { value: 'due_today', label: 'Due today' },
    { value: 'next_3_days', label: 'Next 3 days' },
  ],
};

/** The reason filter's options: customer reason codes (rows carry reasonCode, and the server's label in reason).
 * No endpoint lists the codes, so the options stay here, with the server's labels. */
export const REASONS: Array<{ value: string; label: string }> = [
  { value: 'damaged', label: 'Arrived damaged' },
  { value: 'defective', label: 'Defective or not working' },
  { value: 'not_as_described', label: 'Not as described' },
  { value: 'wrong_item', label: 'Wrong item sent' },
  { value: 'missing_parts', label: 'Missing parts or accessories' },
  { value: 'wrong_size', label: 'Wrong size or fit' },
  { value: 'changed_mind', label: 'Changed my mind' },
  { value: 'better_price', label: 'Found a better price' },
  { value: 'no_longer_needed', label: 'No longer needed' },
  { value: 'other', label: 'Other' },
];

export function rowEdge(r: ReturnRow): ReturnEdge {
  const s = (r.deadline?.state ?? '').toLowerCase();
  const flags = (r.flags ?? []) as RowFlag[];
  if (s === 'overdue' || flags.some((f) => f.tone === 'danger') || r.refundStatus === 'failed') return 'flagged';
  if (s === 'due_soon') return 'warn';
  return '';
}

export function flagStyle(f: RowFlag): { tone: Tone; icon: IconName } {
  if (f.tone === 'danger') return { tone: 'danger', icon: 'circle-alert' };
  if (f.tone === 'info' || f.tone === 'success') return { tone: 'info', icon: f.kind?.includes('exception') ? 'file-check' : 'shield' };
  return { tone: 'warning', icon: 'triangle-alert' };
}

export const EXCEPTION_REASONS: Array<{ value: 'return_cost_exceeds_value' | 'unsafe_to_ship' | 'damaged_beyond_resale' | 'lost_by_carrier' | 'customer_goodwill' | 'other'; label: string }> = [
  { value: 'return_cost_exceeds_value', label: 'Return shipping costs more than the item' },
  { value: 'unsafe_to_ship', label: 'Hazardous or unsafe to ship back' },
  { value: 'damaged_beyond_resale', label: 'Item damaged beyond resale, photo evidence' },
  { value: 'lost_by_carrier', label: 'Lost by the carrier' },
  { value: 'customer_goodwill', label: 'Customer goodwill' },
  { value: 'other', label: 'Other' },
];

interface Money {
  amount: number;
  currency: string;
}
interface Due {
  dueAt: string;
  state: string;
}

/** The parts of GET returns/requests/{id} the exception drawer reads (typed loosely in the OpenAPI document). */
export interface ReturnCase {
  detail: {
    id: string;
    ref: string;
    orderRef: string;
    seller: { ownerType: string; id: string | null; name: string };
    status: string;
    statusLabel: string;
    items: Array<{ title: string; options?: Record<string, string> | null; imageUrl?: string | null; quantity: number }>;
    reason: string;
    details?: string | null;
    media?: Array<{ id?: string; url?: string | null; alt?: string | null }>;
    responseDue?: Due | null;
    timeline?: Array<{ at: string; label: string; detail?: string | null }>;
    allowedActions?: string[];
    requestedAt: string;
  };
  customer: { displayName: string; city?: string | null } | null;
  payment: { itemPaid: Money; discountShare?: Money | null; maxRefundable: Money; refundedSoFar: Money; methodLabel?: string | null } | null;
  policyApplied?: { windowDays?: number | null } | null;
  exception: { reasonCode?: string | null; details?: string | null; proposedBy?: { name?: string | null } | null; proposedAt?: string | null; approvedBy?: { name?: string | null } | null } | null;
  refundRequest: { ref?: string; status: string; approval?: { required?: boolean; reason?: string | null; approvers?: string[] | string | null } | null; updatedAt?: string } | null;
  owner: { name?: string | null } | null;
  evidence?: Array<{ url?: string | null; alt?: string | null }>;
  deadlines?: { respondBy?: Due | null; inspectBy?: Due | null; refundBy?: Due | null } | null;
  allowedActions?: string[];
}
