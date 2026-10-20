import { date, shortDate } from '@marketly/web-shared/lib/dates';
import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ApiError, useApi, type components } from '@marketly/web-shared/api';
import SELLER_RETURN_DETAIL from '@marketly/web-shared/api/graphql/seller/SellerReturnDetail.graphql?raw';
import { formatMoney, type MoneyValue } from '@marketly/web-shared/lib/format';


// Seller returns and cases: list (GET /api/seller/returns/requests, …/counts, …/terms, …/exports) and the return
// case (GraphQL SellerReturnDetail; actions are the REST routes under /api/seller/returns/requests/{id}/…).
// All times are shown in Pacific time, as the design says.

export type SellerReturnRow = components['schemas']['returns.SellerReturnRow'];
export type SellerReturnCounts = components['schemas']['returns.SellerReturnCounts'];
type Deadline = components['schemas']['Deadline'];

/** List tab as the URL view ('' = Return requests) and the API's `tab`. */
export type ReturnTab = '' | 'received-to-inspect' | 'disputes' | 'closed';
export const API_TAB: Record<ReturnTab, 'requests' | 'to_inspect' | 'disputes' | 'closed'> = { '': 'requests', 'received-to-inspect': 'to_inspect', disputes: 'disputes', closed: 'closed' };
export const tabCount = (c: SellerReturnCounts | undefined, t: ReturnTab): number | undefined =>
  c ? { '': c.tabs.requests, 'received-to-inspect': c.tabs.toInspect, disputes: c.tabs.disputes, closed: c.tabs.closed }[t] : undefined;

/** Customer return reasons (returns/domain/rules.ts labels); the list filter takes the code. */
export const RETURN_REASONS: Array<{ value: string; label: string }> = [
  { value: '', label: 'All reasons' },
  { value: 'defective', label: 'Defective or not working' },
  { value: 'damaged', label: 'Arrived damaged' },
  { value: 'wrong_item', label: 'Wrong item sent' },
  { value: 'not_as_described', label: 'Not as described' },
  { value: 'missing_parts', label: 'Missing parts or accessories' },
  { value: 'changed_mind', label: 'Changed my mind' },
  { value: 'better_price', label: 'Found a better price' },
  { value: 'no_longer_needed', label: 'No longer needed' },
  { value: 'wrong_size', label: 'Wrong size or fit' },
  { value: 'other', label: 'Other' },
];
export const RETURN_PERIODS: Array<{ value: 'last_30_days' | 'last_90_days' | 'this_year'; label: string }> = [
  { value: 'last_30_days', label: 'Last 30 days' },
  { value: 'last_90_days', label: 'Last 90 days' },
  { value: 'this_year', label: 'This year' },
];

/* ------------------------------------------------------------------ formatting */

const TZ = 'America/Los_Angeles';
const fmt = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-US', { timeZone: TZ, ...o });
const DATE_TIME = fmt({ month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const LONG = fmt({ weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const FULL = fmt({ month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });

/** "Oct 4" */
export const fmtDate = (iso?: string | null) => (iso ? shortDate(iso) : '');
/** "Oct 4, 7:02 PM" */
export const fmtDateTime = (iso?: string | null) => (iso ? DATE_TIME.format(new Date(iso)) : '');
/** "Fri, Oct 9, 4:00 PM PT" */
export const fmtDue = (iso?: string | null) => (iso ? `${LONG.format(new Date(iso))} PT` : '');
/** "Oct 5, 2026, 4:12 PM PT" */
export const fmtFull = (iso?: string | null) => (iso ? `${FULL.format(new Date(iso))} PT` : '');
/** "Sep 26, 2026" */
export const fmtDay = (iso?: string | null) => (iso ? date(iso) : '');

/** "1 day 6 h left" / "Overdue 6 h" */
export function timeLeft(iso: string, now = Date.now()): string {
  const ms = new Date(iso).getTime() - now;
  const abs = Math.abs(ms);
  const h = Math.floor(abs / 3_600_000);
  const d = Math.floor(h / 24);
  const text = d ? `${d} day${d > 1 ? 's' : ''}${h % 24 ? ` ${h % 24} h` : ''}` : h ? `${h} h` : `${Math.max(1, Math.floor(abs / 60_000))} min`;
  return ms < 0 ? `Overdue ${text}` : `${text} left`;
}

/** Deadline chip tone from the API state (on_time / due_soon / overdue; GraphQL sends them upper case). */
export const deadlineTone = (d?: { state: string } | null): 'ok' | 'warning' | 'danger' => {
  const s = d?.state.toLowerCase();
  return s === 'overdue' ? 'danger' : s === 'due_soon' ? 'warning' : 'ok';
};
/** Row edge: red when overdue, amber when due soon. */
export const rowEdge = (d?: Deadline | null): 'flagged' | 'warn' | undefined => (d?.state === 'overdue' ? 'flagged' : d?.state === 'due_soon' ? 'warn' : undefined);

export const money = (m?: MoneyValue | null) => formatMoney(m);
/** "−$27.90" (the amount shown as a deduction) */
export const negMoney = (m?: MoneyValue | null) => (m ? `−${formatMoney({ ...m, amount: Math.abs(m.amount) })}` : '');
/** "12.50" → 1250; NaN when it isn't a money amount */
export const toMinor = (s: string): number => (/^\d+(\.\d{1,2})?$/.test(s.trim()) ? Math.round(Number(s.trim()) * 100) : NaN);
export const human = (s?: string | null) => (s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase().replace(/_/g, ' ') : '');

/* ------------------------------------------------------------------ hooks */

export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Calls onVisible when the element scrolls into view (phone lazy loading). */
export function useInView<T extends HTMLElement>(onVisible: () => void, enabled: boolean) {
  const ref = useRef<T | null>(null);
  const cb = useRef(onVisible);
  cb.current = onVisible;
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && cb.current(), { rootMargin: '200px' });
    io.observe(el);
    return () => io.disconnect();
  }, [enabled]);
  return ref;
}

/* ------------------------------------------------------------------ return case (GraphQL SellerReturnDetail) */

export interface GMoney {
  amount: number;
  currency: string;
  formatted?: string;
}
export interface GDue {
  dueAt: string;
  state: string;
}
export interface GImage {
  id: string;
  url: string | null;
  alt: string | null;
}
export interface GWho {
  kind: string;
  name: string | null;
}
export interface GEvent {
  at: string;
  label: string;
  detail: string | null;
  actor?: GWho | null;
}
export interface GMessage {
  id: string;
  kind: string;
  authorLabel: string | null;
  fromMe: boolean;
  body: string;
  hidden: boolean;
  at: string;
  author: { kind: string } | null;
  attachments: GImage[];
}

export interface SellerReturn {
  id: string;
  ref: string;
  orderRef: string;
  status: string;
  statusLabel: string;
  requestedAt: string;
  open: boolean;
  nextStep: string;
  nextDeadline: GDue | null;
  track: Array<{ key: string; label: string; state: string }>;
  reason: string;
  details: string | null;
  remedy: string;
  handledBy: string;
  media: GImage[];
  items: Array<{ orderItemId: string; title: string; sku: string | null; imageUrl: string | null; quantity: number; options: Array<{ name: string; value: string }>; unitPrice: GMoney }>;
  customer: { displayName: string; city: string | null; ordersWithSeller: number } | null;
  payment: { methodLabel: string; itemPaid: GMoney; shippingPaid: GMoney; discountShare: GMoney; maxRefundable: GMoney; refundedSoFar: GMoney } | null;
  terms: {
    windowDays: number;
    changeOfMindAllowed: boolean;
    condition: string | null;
    remedies: string[];
    responseTargetBusinessDays: number;
    summary: string;
    policyVersion: string;
    source: string;
    responsibilities: Array<{ reasonGroup: string; paidBy: string; note: string | null; customerFee: GMoney | null }>;
  };
  shippingPaidBy: string | null;
  deadlines: { respondBy: GDue | null; inspectBy: GDue | null; refundBy: GDue | null } | null;
  infoRequest: { question: string; askedAt: string; replyDueAt: string; reply: string | null; repliedAt: string | null } | null;
  decision: { kind: string; explanation: string | null; decidedAt: string; platformDecision: boolean; decidedBy: GWho } | null;
  shipment: {
    id: string;
    status: string;
    method: string;
    carrier: string | null;
    service: string | null;
    trackingNumber: string | null;
    trackingUrl: string | null;
    paidBy: string;
    cost: GMoney | null;
    to: { name: string | null; line1: string | null; city: string | null; region: string | null; postalCode: string | null } | null;
    events: GEvent[];
  } | null;
  inspection: {
    id: string;
    inspectedAt: string;
    conditionOutcome: string;
    grade: string;
    notes: string | null;
    proposedStockOutcome: string;
    missingParts: string[];
    media: GImage[];
    inspectedBy: GWho;
  } | null;
  inspectionChecklist: { expectedContents: string[]; serialShipped: string | null; items: Array<{ key: string; kind: string; label: string; expected: string | null; required: boolean }> } | null;
  inspectionDraft: { inspection: Record<string, unknown> | null; remedy: Record<string, unknown> | null; savedAt: string; savedBy: GWho } | null;
  inspector: GWho | null;
  evidence: Array<{ id: string; kind: string; note: string | null; party: string; addedAt: string; caseId: string | null; media: GImage[] }>;
  refund: { ref: string; status: string; statusLabel: string; explanation: string } | null;
  refundRequest: { ref: string; status: string } | null;
  earningsImpact: { afterPayout: boolean; note: string; refundToCustomer: GMoney; sellerEarningsChange: GMoney; feeReturned: GMoney; labelCharge: GMoney | null; totalBalanceChange: GMoney } | null;
  escalation: { at: string; reason: string; caseRef: string | null } | null;
  case: {
    id: string;
    ref: string;
    status: string;
    statusLabel: string;
    marketplaceInvolved: boolean;
    nextAction: { label: string; whoMustAct: string; youNeedToAct: boolean; due: GDue | null } | null;
    evidence: Array<{ id: string; party: string; kind: string; note: string | null; at: string; addedBy: GWho | null; media: Array<GImage & { bytes?: number | null }> }>;
  } | null;
  platformInvolved: boolean;
  flags: Array<{ kind: string; label: string }>;
  allowedActions: string[];
  activity: GEvent[];
  order: { id: string; ref: string; placedAt: string; groups: Array<{ id: string; items: Array<{ id: string; deliveredAt: string | null; returnWindowEndsAt: string | null }> }> } | null;
  conversation: {
    id: string;
    privacyNote: string | null;
    rulesNote: string | null;
    canSend: boolean;
    replyDue: GDue | null;
    participants: Array<{ kind: string; name: string | null; label: string | null }>;
    messages: { nextCursor: string | null; items: GMessage[] };
  } | null;
}

/** The return case by its RT- reference (null when it isn't this seller's return). */
export function useSellerReturn(ref: string) {
  const { gql } = useApi();
  return useQuery({
    queryKey: ['returns', 'detail', ref],
    queryFn: async () => {
      const r = await gql<{ sellerReturn: SellerReturn | null }>(SELLER_RETURN_DETAIL, { ref, messagePaging: { limit: 50 } }, 'SellerReturnDetail');
      return r.data?.sellerReturn ?? null;
    },
    retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 2,
  });
}

/* ------------------------------------------------------------------ labels for the case screen */

export const REMEDY_WANTED: Record<string, string> = {
  REFUND: 'refund to original payment',
  REPLACEMENT: 'replacement',
  EXCHANGE: 'exchange for another size or color',
  STORE_CREDIT: 'Marketly store credit',
};
export const REMEDY_OFFERED: Record<string, string> = { REFUND: 'refund', REPLACEMENT: 'replacement', EXCHANGE: 'exchange', STORE_CREDIT: 'store credit' };

export const PAID_BY: Record<string, string> = { SELLER: 'You pay', CUSTOMER: 'Customer pays', PLATFORM: 'Marketly pays' };

export const LABEL_METHOD: Record<string, string> = { PREPAID_QR: 'prepaid QR drop-off code', PREPAID_LABEL: 'prepaid label', CUSTOMER_ARRANGED: 'customer-arranged shipping' };

export type RejectCode = 'outside_window' | 'item_not_eligible' | 'damaged_by_customer' | 'other';
export const REJECT_REASONS: Array<{ value: '' | RejectCode; label: string }> = [
  { value: '', label: 'Choose a reason' },
  { value: 'outside_window', label: 'Outside the return window' },
  { value: 'item_not_eligible', label: 'Item not eligible for return' },
  { value: 'damaged_by_customer', label: 'Item damaged by the customer' },
  { value: 'other', label: 'Other (explain below)' },
];

export type NoReturnCode = 'return_cost_exceeds_value' | 'unsafe_to_ship' | 'damaged_beyond_resale' | 'lost_by_carrier' | 'customer_goodwill' | 'other';
export const NO_RETURN_REASONS: Array<{ value: '' | NoReturnCode; label: string }> = [
  { value: '', label: 'Choose a reason' },
  { value: 'return_cost_exceeds_value', label: 'Return shipping costs more than the item' },
  { value: 'unsafe_to_ship', label: 'Unsafe to ship back' },
  { value: 'damaged_beyond_resale', label: 'Damaged beyond resale' },
  { value: 'lost_by_carrier', label: 'Lost by the carrier' },
  { value: 'customer_goodwill', label: 'Goodwill for the customer' },
  { value: 'other', label: 'Other (explain below)' },
];

export type Condition = 'as_described' | 'damaged_by_customer' | 'missing_parts' | 'not_matching_request' | 'wrong_item_returned' | 'empty_package';
export const CONDITIONS: Array<{ value: Condition; title: string; body: string; partial?: boolean }> = [
  { value: 'as_described', title: 'As described by the customer', body: 'The item and the problem match the customer’s request.' },
  { value: 'damaged_by_customer', title: 'Damaged by the customer', body: 'Physical damage not reported in the request. Add photos.', partial: true },
  { value: 'missing_parts', title: 'Missing parts', body: 'Choose what is missing so a partial refund can be explained.', partial: true },
  { value: 'not_matching_request', title: 'Doesn’t match the request', body: 'The reported problem couldn’t be found. Describe your tests.' },
  { value: 'wrong_item_returned', title: 'Wrong item returned', body: 'A different item came back. Add photos of what arrived.', partial: true },
  { value: 'empty_package', title: 'Empty package', body: 'The parcel arrived without the item. Add photos of the package.', partial: true },
];

export type Grade = 'new_sealed' | 'like_new' | 'good' | 'damaged';
export const GRADES: Array<{ value: Grade; label: string }> = [
  { value: 'new_sealed', label: 'New, sealed' },
  { value: 'like_new', label: 'Like new' },
  { value: 'good', label: 'Good, signs of use' },
  { value: 'damaged', label: 'Damaged' },
];

export type StockOutcome = 'restock' | 'different_condition' | 'damaged_stock' | 'repair' | 'return_to_supplier' | 'write_off';
export const STOCK: Array<{ value: StockOutcome; label: string; hint: string }> = [
  { value: 'restock', label: 'Back to available stock', hint: 'Updates your inventory: the unit goes back on sale.' },
  { value: 'different_condition', label: 'Resell in another condition', hint: 'Updates your inventory: the unit goes on sale in the condition you enter.' },
  { value: 'damaged_stock', label: 'Damaged stock', hint: 'Updates your inventory: the unit is held as damaged and not sold.' },
  { value: 'repair', label: 'Send for repair', hint: 'Updates your inventory: the unit is held until it is repaired.' },
  { value: 'return_to_supplier', label: 'Return to supplier', hint: 'Updates your inventory: the unit does not go back on sale.' },
  { value: 'write_off', label: 'Write off', hint: 'Updates your inventory: the unit is removed from stock.' },
];

/** Evidence kind for an uploaded file. */
export const evidenceKind = (f: { name: string }): 'photo' | 'video' | 'document' => (/\.(jpe?g|png|webp|heic|gif)$/i.test(f.name) ? 'photo' : /\.(mp4|mov)$/i.test(f.name) ? 'video' : 'document');
