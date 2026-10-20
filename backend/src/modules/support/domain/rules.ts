/**
 * Pure support rules: default categories, labels, who acts next, deadlines, remedy tracks, what a viewer may
 * do now. No I/O.
 */
import type * as common from '../../../spec/common.js';
import type { CaseActions, CaseCategory, NextAction, Remedy } from '../../../spec/support.js';

export type CaseKind = 'customer_help' | 'order_problem' | 'dispute' | 'seller_request';
export type CaseStatus = 'open' | 'waiting_on_seller' | 'waiting_on_customer' | 'escalated' | 'decision_made' | 'appealed' | 'resolved' | 'closed' | 'reopened';
export type Priority = 'low' | 'medium' | 'high' | 'urgent';
export type Team = CaseCategory['team'];
export type HandlerKind = 'seller' | 'official_store' | 'marketplace_support';
export type RemedyKind = Remedy['kind'];
export type RemedyStatus = Remedy['status'];
export type Area = 'store' | 'seller' | 'admin';

export const KINDS: readonly CaseKind[] = ['customer_help', 'order_problem', 'dispute', 'seller_request'];
export const PRIORITIES: readonly Priority[] = ['low', 'medium', 'high', 'urgent'];
export const CLOSED_STATUSES: readonly CaseStatus[] = ['resolved', 'closed'];
export const OPEN_STATUSES: readonly CaseStatus[] = ['open', 'waiting_on_seller', 'waiting_on_customer', 'escalated', 'decision_made', 'appealed', 'reopened'];
/** A remedy in one of these states is a promise not yet kept (REMEDY_PENDING) */
export const UNRESOLVED_REMEDY: readonly RemedyStatus[] = ['pending_approval', 'approved', 'in_progress'];
export const isOpen = (status: string) => !(CLOSED_STATUSES as readonly string[]).includes(status);
/** Display name of the Official Store (shared constant) */
export { OFFICIAL_STORE_NAME } from '../../../spec/common.js';
export const SUPPORT_NAME = 'Marketly support';

/* ---------------------------------------------------------------- categories */

type Seed = Omit<CaseCategory, 'active'>;
const c = (key: string, label: string, audience: 'customer' | 'seller', group: CaseCategory['group'], defaultPriority: Priority, team: Team, sellerHandlesFirst: boolean, first = 4, next = 8, days = 5): Seed => ({
  key,
  label,
  audience,
  group,
  defaultPriority,
  team,
  sellerHandlesFirst,
  firstResponseBusinessHours: first,
  nextResponseBusinessHours: next,
  resolutionBusinessDays: days,
});

/** Categories installed at first start (staff change them later through PUT /categories/{key}) */
export const DEFAULT_CATEGORIES: readonly Seed[] = [
  c('delivery_late', 'Delivery, late item', 'customer', 'delivery', 'medium', 'customer_support', true),
  c('delivery_not_arrived', "Package didn't arrive", 'customer', 'delivery', 'high', 'customer_support', true),
  c('item_damaged', 'Item arrived damaged', 'customer', 'damaged_or_wrong', 'high', 'customer_support', true),
  c('wrong_item', 'Wrong or missing item', 'customer', 'damaged_or_wrong', 'medium', 'customer_support', true),
  c('return_dispute', 'Return or refund dispute', 'customer', 'returns_refunds', 'high', 'returns', false),
  c('refund_status', 'Refund status', 'customer', 'returns_refunds', 'medium', 'customer_support', false),
  c('payment_issue', 'Payment or charge', 'customer', 'payment', 'high', 'customer_support', false),
  c('order_change', 'Change or cancel an order', 'customer', 'order_change', 'medium', 'customer_support', true),
  c('account_help', 'Account and sign-in', 'customer', 'account', 'low', 'customer_support', false, 8, 8, 3),
  c('report_seller', 'Report a seller', 'customer', 'seller_report', 'high', 'trust', false),
  c('other_help', 'Something else', 'customer', 'other', 'low', 'customer_support', false, 8, 8, 5),
  c('account_health', 'Account health', 'seller', 'account_health', 'high', 'seller_management', false, 8, 8, 3),
  c('fees_payouts', 'Fees and payouts', 'seller', 'fees_payouts', 'medium', 'seller_management', false, 8, 8, 3),
  c('listing_rules', 'Listing rules', 'seller', 'listing_rules', 'medium', 'seller_management', false, 8, 8, 3),
  c('shipping_dispatch', 'Shipping', 'seller', 'shipping_dispatch', 'medium', 'seller_management', false, 8, 8, 3),
  c('seller_returns_disputes', 'Returns and disputes', 'seller', 'returns_refunds', 'medium', 'seller_management', false, 8, 8, 3),
  c('advertising', 'Advertising', 'seller', 'advertising', 'low', 'seller_management', false, 8, 8, 5),
  c('seller_other', 'Something else', 'seller', 'other', 'low', 'seller_management', false, 8, 8, 5),
];

/** Category names other modules use when they open a case (openCase) → the installed key */
const ALIASES: Record<string, string> = {
  return: 'return_dispute',
  returns: 'return_dispute',
  return_escalation: 'return_dispute',
  refund: 'refund_status',
  refund_failed: 'refund_status',
  payment: 'payment_issue',
  lost: 'delivery_not_arrived',
  lost_or_damaged: 'item_damaged',
  damaged: 'item_damaged',
  not_arrived: 'delivery_not_arrived',
  missing_item: 'wrong_item',
  late_dispatch: 'delivery_late',
  delivery: 'delivery_late',
  other: 'other_help',
};

/** The installed category for a key another module passed (exact key, known alias, else the "something else" topic) */
export function resolveCategoryKey(key: string, known: ReadonlySet<string>, audience: 'customer' | 'seller'): string {
  if (known.has(key)) return key;
  const alias = ALIASES[key];
  if (alias && known.has(alias)) return alias;
  const fallback = audience === 'seller' ? 'seller_other' : 'other_help';
  return known.has(fallback) ? fallback : [...known][0] ?? key;
}

/** Category for an order problem type when the app did not send one that exists */
export const PROBLEM_CATEGORY: Record<string, string> = {
  missing_item: 'wrong_item',
  damaged: 'item_damaged',
  wrong_item: 'wrong_item',
  not_arrived: 'delivery_not_arrived',
  other: 'other_help',
};

export const PROBLEM_LABEL: Record<string, string> = {
  missing_item: 'Missing item',
  damaged: 'Damaged item',
  wrong_item: 'Wrong item',
  not_arrived: "Package didn't arrive",
  other: 'Problem with an order',
};

/* ---------------------------------------------------------------- labels */

export function statusLabel(status: string, o: { area: Area; handler: string; sellerReplied?: boolean }): string {
  switch (status) {
    case 'open':
      return o.handler === 'seller' && o.sellerReplied ? 'Seller replied' : 'Open';
    case 'waiting_on_seller':
      return 'Waiting on seller';
    case 'waiting_on_customer':
      return o.area === 'store' ? 'Waiting on you' : 'Waiting on customer';
    case 'escalated':
      return o.area === 'store' ? 'Marketly is reviewing' : 'Escalated';
    case 'decision_made':
      return 'Decision made';
    case 'appealed':
      return 'Appeal under review';
    case 'resolved':
      return 'Resolved';
    case 'closed':
      return 'Closed';
    case 'reopened':
      return 'Reopened';
    default:
      return status.replace(/_/g, ' ');
  }
}

export const human = (s: string | null | undefined) => (s ? s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ') : '');

export const TEAM_LABEL: Record<string, string> = {
  customer_support: 'Customer Support',
  returns: 'Returns',
  finance: 'Finance',
  trust: 'Trust and Risk',
  seller_management: 'Seller Manager',
  official_store: 'Official Store',
  support_lead: 'Support lead',
};

/** Access roles whose members can own cases, per team */
export const TEAM_ROLES: Record<Team, string[]> = {
  customer_support: ['customer_support_manager', 'support_agent'],
  returns: ['returns_manager'],
  finance: ['finance_manager', 'finance_staff'],
  trust: ['trust_and_risk_manager'],
  seller_management: ['seller_manager'],
  official_store: ['official_store_manager'],
};

/* ---------------------------------------------------------------- deadlines */

export function deadline(due: Date | string | null | undefined, now: Date, soonMs = 4 * 3_600_000): common.Deadline | null {
  if (!due) return null;
  const at = typeof due === 'string' ? new Date(due) : due;
  const left = at.getTime() - now.getTime();
  return { dueAt: at.toISOString(), state: left < 0 ? 'overdue' : left <= soonMs ? 'due_soon' : 'on_time' };
}

/** e.g. "Fri, Oct 9, 5:00 PM PDT" in the market time zone */
export function dateTimeLabel(at: Date | string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone, timeZoneName: 'short' }).format(new Date(at));
}

export function dateLabel(at: Date | string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone }).format(new Date(at));
}

/** "Due in 3h", "Overdue by 2d" */
export function relativeLabel(due: Date | null, now: Date): string {
  if (!due) return 'No deadline';
  const ms = due.getTime() - now.getTime();
  const abs = Math.abs(ms);
  const text = abs >= 86_400_000 ? `${Math.round(abs / 86_400_000)}d` : abs >= 3_600_000 ? `${Math.round(abs / 3_600_000)}h` : `${Math.max(1, Math.round(abs / 60_000))}m`;
  return ms < 0 ? `Overdue by ${text}` : `Due in ${text}`;
}

export function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return Math.round(s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2);
}

/* ---------------------------------------------------------------- next action */

export interface NextFacts {
  status: string;
  kind: string;
  handler: string;
  handlerName: string;
  sellerName: string;
  dueAt: Date | null;
  infoFrom?: 'customer' | 'seller' | null;
  openOffer?: { respondBy: Date | null } | null;
  pendingRemedy?: { kind: string; status: string } | null;
  appealDeadline?: Date | null;
  decisionFinal?: boolean;
  appealed?: boolean;
  sellerReplied?: boolean;
  reopenUntil?: Date | null;
}

/** Who must act now and what happens next (stored on the case; viewers add youNeedToAct) */
export function nextActionOf(f: NextFacts, now: Date): Omit<NextAction, 'youNeedToAct'> {
  const due = (d: Date | null | undefined) => deadline(d ?? null, now);
  if (f.pendingRemedy?.status === 'failed' && isOpen(f.status)) return { label: 'Marketly support is fixing the refund', whoMustAct: 'marketplace', due: due(f.dueAt), note: null };
  const remedyLabel = f.pendingRemedy
    ? f.pendingRemedy.kind === 'ship_by_deadline'
      ? `${f.sellerName} ships the item by the agreed date`
      : f.pendingRemedy.kind === 'replacement'
        ? 'The replacement is on its way'
        : f.pendingRemedy.status === 'pending_approval'
          ? 'Marketly finance reviews the refund'
          : 'The refund is being processed'
    : null;
  switch (f.status) {
    case 'waiting_on_seller':
      return {
        label: f.infoFrom === 'seller' ? `${f.sellerName} sends the information Marketly asked for` : `${f.sellerName} confirms tracking or offers a solution`,
        whoMustAct: 'seller',
        due: due(f.dueAt),
        note: f.handler === 'seller' ? 'If they miss it, Marketly steps in' : null,
      };
    case 'waiting_on_customer':
      return { label: 'Reply with the information asked for', whoMustAct: 'customer', due: due(f.dueAt), note: null };
    case 'open':
    case 'reopened':
      if (f.openOffer) return { label: `Accept or decline ${f.sellerName}'s offer`, whoMustAct: 'customer', due: due(f.openOffer.respondBy), note: 'If you decline, you can ask Marketly to step in' };
      if (remedyLabel) return { label: remedyLabel, whoMustAct: f.pendingRemedy?.kind === 'ship_by_deadline' ? 'seller' : 'marketplace', due: null, note: null };
      if (f.handler === 'seller' && f.sellerReplied) return { label: `Review ${f.sellerName}'s reply`, whoMustAct: 'customer', due: null, note: 'If you disagree, you can ask Marketly to step in' };
      return { label: `${f.handlerName} replies`, whoMustAct: f.handler === 'seller' ? 'seller' : 'marketplace', due: due(f.dueAt), note: null };
    case 'escalated':
      return { label: 'Marketly support reviews the case and decides', whoMustAct: 'marketplace', due: due(f.dueAt), note: null };
    case 'decision_made':
      if (remedyLabel) return { label: remedyLabel, whoMustAct: f.pendingRemedy?.kind === 'ship_by_deadline' ? 'seller' : 'marketplace', due: null, note: f.appealDeadline && !f.decisionFinal ? 'You can appeal the decision until the deadline' : null };
      return {
        label: f.decisionFinal ? 'The decision is final' : 'Decision shared with both parties',
        whoMustAct: 'none',
        due: !f.decisionFinal && !f.appealed ? due(f.appealDeadline) : null,
        note: !f.decisionFinal && f.appealDeadline ? 'Either party can appeal until the deadline' : null,
      };
    case 'appealed':
      return { label: 'A different Marketly team member reviews the appeal', whoMustAct: 'marketplace', due: due(f.dueAt), note: null };
    case 'resolved':
      return { label: 'Resolved', whoMustAct: 'none', due: null, note: f.reopenUntil ? 'You can reopen it if the promised remedy does not happen' : null };
    default:
      return { label: 'Closed', whoMustAct: 'none', due: null, note: null };
  }
}

/* ---------------------------------------------------------------- remedies */

const REFUND_TRACK = ['Requested', 'Approved', 'Processing', 'Sent'];

export function remedyTrack(kind: string, status: string, o: { linked?: boolean } = {}): { track: string[]; currentStep: number | null; statusLabel: string; note: string | null } {
  const cancelled = status === 'cancelled';
  if (kind === 'refund' || kind === 'partial_refund' || kind === 'goodwill_credit') {
    const step = { pending_approval: 0, approved: 1, in_progress: 2, failed: 2, completed: 3 }[status as string] ?? null;
    const label = { pending_approval: 'Requested: waiting for approval', approved: 'Approved, not sent yet', in_progress: 'Processing', failed: 'Failed: Marketly is fixing it', completed: 'Sent', cancelled: 'Cancelled' }[status as string] ?? human(status);
    return { track: kind === 'goodwill_credit' ? ['Requested', 'Approved', 'Credited'] : REFUND_TRACK, currentStep: cancelled ? null : kind === 'goodwill_credit' && step !== null ? Math.min(step, 2) : step, statusLabel: label, note: status === 'approved' ? "Approved means we agreed to refund you; it isn't money in your account yet" : null };
  }
  if (kind === 'replacement') {
    const step = status === 'completed' ? 3 : status === 'in_progress' ? (o.linked ? 2 : 1) : 0;
    return { track: ['Agreed', 'Preparing', 'Shipped', 'Delivered'], currentStep: cancelled ? null : step, statusLabel: status === 'completed' ? 'Delivered' : status === 'in_progress' ? 'Replacement on its way' : status === 'failed' ? 'Failed' : status === 'cancelled' ? 'Cancelled' : 'Agreed', note: null };
  }
  if (kind === 'return_label') {
    return { track: ['Label ready', 'Sent back', 'Received'], currentStep: cancelled ? null : status === 'completed' ? 2 : 0, statusLabel: status === 'completed' ? 'Return received' : status === 'cancelled' ? 'Cancelled' : 'Send the item back with the label', note: null };
  }
  if (kind === 'ship_by_deadline') {
    return { track: ['Agreed', 'Shipped'], currentStep: cancelled ? null : status === 'completed' ? 1 : 0, statusLabel: status === 'completed' ? 'Shipped' : status === 'failed' ? 'Missed: falls back to a refund' : status === 'cancelled' ? 'Cancelled' : 'Waiting for the seller to ship', note: null };
  }
  return { track: [], currentStep: null, statusLabel: human(status), note: null };
}

/* ---------------------------------------------------------------- what the viewer may do */

export interface ActionFacts {
  status: string;
  handler: string;
  escalationAvailable: boolean;
  decisionFinal: boolean;
  hasDecision: boolean;
  appealDeadline: Date | null;
  appealed: boolean;
  reopenUntil: Date | null;
  openOffer: boolean;
}

export function actionsFor(area: Area, f: ActionFacts, now: Date): CaseActions {
  const open = isOpen(f.status);
  const appeal = f.status === 'decision_made' && f.hasDecision && !f.decisionFinal && !f.appealed && !!f.appealDeadline && f.appealDeadline.getTime() > now.getTime();
  if (area === 'seller') return { reply: open, escalate: false, appeal, reopen: false, respondToOffer: false, addEvidence: open };
  if (area === 'admin') return { reply: true, escalate: open, appeal: false, reopen: !open, respondToOffer: false, addEvidence: true };
  return {
    reply: open,
    escalate: open && f.escalationAvailable,
    appeal,
    reopen: !open && !!f.reopenUntil && f.reopenUntil.getTime() > now.getTime(),
    respondToOffer: open && f.openOffer,
    addEvidence: open,
  };
}

/** Text shown under the case about when it closes and how to reopen it */
export function reopenRules(o: { unresolvedRemedy: string | null; reopenWindowDays: number; reopenUntil: Date | null; status: string; timeZone: string }): string {
  const what = o.unresolvedRemedy === 'refund' || o.unresolvedRemedy === 'partial_refund' || o.unresolvedRemedy === 'goodwill_credit' ? 'the refund is sent' : o.unresolvedRemedy === 'replacement' ? 'the replacement arrives' : o.unresolvedRemedy ? 'the agreed solution is done' : 'the problem is solved';
  if (!isOpen(o.status) && o.reopenUntil) return `Resolved. You can reopen it until ${dateLabel(o.reopenUntil, o.timeZone)} if the promised remedy doesn't happen.`;
  return `Stays open until ${what}; reopen within ${o.reopenWindowDays} days if it doesn't arrive.`;
}

/** The outcome after an appeal overturns a decision */
export function overturnedOutcome(outcome: string, hasMoneyRemedy: boolean): 'customer_favored' | 'seller_favored' | 'shared' | 'no_fault' | 'information_only' {
  if (outcome === 'customer_favored') return 'seller_favored';
  if (outcome === 'seller_favored') return 'customer_favored';
  return hasMoneyRemedy ? 'customer_favored' : 'seller_favored';
}

/** Share of a remedy Marketly pays (support.remedies.approve limit) */
export function platformShare(amount: number, chargedTo: string | null | undefined): number {
  if (chargedTo === 'platform') return amount;
  if (chargedTo === 'shared') return amount - Math.floor(amount / 2);
  return 0;
}
