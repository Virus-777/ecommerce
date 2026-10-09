/**
 * Pure return rules: reason groups, who pays return shipping, business-day deadlines, labels and tracks,
 * item eligibility, refund breakdowns and policy comparisons. No I/O.
 */
import { allocate, format, money } from '../../../kernel/lib/money.js';
import { zoneOffsetMs } from '../../../kernel/lib/clock.js';
import type * as common from '../../../spec/common.js';
import type { RefundDeduction, ShippingResponsibility, TrackStep } from '../../../spec/returns.js';

export const HOUR = 3_600_000;
export const DAY = 86_400_000;

/** EffectiveTerms.sellerId is required; the Official Store has no seller record (sellerId null everywhere else) */
export const OFFICIAL_TERMS_ID = '00000000-0000-0000-0000-000000000000';
/** Id of the baseline used while no policy version was ever proposed (settings fallback) */
export const DEFAULT_POLICY_ID = '00000000-0000-4000-8000-000000000001';
export const OFFICIAL_NAME = 'Marketly Official';
/**
 * Where Official Store returns go. The spec gives returns no source for the warehouse address
 * (warehouse is not a dependency and there is no setting), so it is a constant here.
 */
export const OFFICIAL_RETURN_ADDRESS: common.Address = {
  name: 'Marketly Returns Center',
  line1: '4100 Logistics Way',
  city: 'Reno',
  region: 'NV',
  postalCode: '89502',
  country: 'US',
};

/* ---------------------------------------------------------------- statuses */

export type ReturnStatus = 'requested' | 'info_requested' | 'approved' | 'rejected' | 'in_transit' | 'received' | 'awaiting_remedy' | 'completed' | 'cancelled';
export type RefundStatus = 'requested' | 'under_review' | 'approved' | 'declined' | 'processing' | 'sent' | 'failed' | 'cancelled';

/** Not completed or cancelled (a rejected return can still be escalated) */
export const OPEN_STATUSES: ReturnStatus[] = ['requested', 'info_requested', 'approved', 'rejected', 'in_transit', 'received', 'awaiting_remedy'];
/** Still being handled (rejected is a decision) */
export const ACTIVE_STATUSES: ReturnStatus[] = ['requested', 'info_requested', 'approved', 'in_transit', 'received', 'awaiting_remedy'];
export const CLOSED_STATUSES: ReturnStatus[] = ['completed', 'cancelled', 'rejected'];
/** A refund request that still covers its items (DUPLICATE_REFUND) */
export const LIVE_REFUND: RefundStatus[] = ['requested', 'under_review', 'approved', 'processing', 'sent', 'failed'];
/** Money not yet sent */
export const PENDING_REFUND: RefundStatus[] = ['requested', 'under_review', 'approved', 'processing', 'failed'];

export const is = <T extends string>(list: readonly T[], v: string | null | undefined): v is T => !!v && (list as readonly string[]).includes(v);

/* ---------------------------------------------------------------- reasons and shipping responsibility */

export type CustomerReason = 'defective' | 'damaged' | 'wrong_item' | 'not_as_described' | 'missing_parts' | 'changed_mind' | 'better_price' | 'no_longer_needed' | 'wrong_size' | 'other';
export type ReasonGroup = ShippingResponsibility['reasonGroup'];

const REASON_GROUP: Record<string, ReasonGroup> = {
  defective: 'defective',
  damaged: 'damaged',
  wrong_item: 'incorrect',
  not_as_described: 'not_as_described',
  missing_parts: 'missing_parts',
  changed_mind: 'change_of_mind',
  better_price: 'change_of_mind',
  no_longer_needed: 'change_of_mind',
  wrong_size: 'change_of_mind',
  other: 'change_of_mind',
};
export const reasonGroupOf = (reason: string | null | undefined): ReasonGroup => REASON_GROUP[reason ?? ''] ?? 'change_of_mind';
/** The item is at fault: the seller pays return shipping, and customer-pays is refused */
export const isFault = (reason: string | null | undefined) => reasonGroupOf(reason) !== 'change_of_mind';

const REASON_LABEL: Record<string, string> = {
  defective: 'Defective or not working',
  damaged: 'Arrived damaged',
  wrong_item: 'Wrong item sent',
  not_as_described: 'Not as described',
  missing_parts: 'Missing parts or accessories',
  changed_mind: 'Changed my mind',
  better_price: 'Found a better price',
  no_longer_needed: 'No longer needed',
  wrong_size: 'Wrong size or fit',
  other: 'Other',
};
export const reasonLabel = (reason: string) => REASON_LABEL[reason] ?? human(reason);
export const human = (s: string | null | undefined) => (s ? s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ') : '');

/** Default who-pays matrix while no baseline version exists */
export function defaultResponsibilities(fee: common.Money): ShippingResponsibility[] {
  const fault = (reasonGroup: ReasonGroup, note: string): ShippingResponsibility => ({
    reasonGroup,
    paidBy: 'seller',
    customerFee: null,
    originalShippingRefunded: true,
    officialStoreRule: 'Free for every reason',
    note,
  });
  return [
    fault('damaged', 'Prepaid label from the seller'),
    fault('incorrect', 'Prepaid label from the seller'),
    fault('defective', 'Prepaid label from the seller'),
    fault('not_as_described', 'Prepaid label from the seller'),
    fault('missing_parts', 'Prepaid label from the seller'),
    { reasonGroup: 'change_of_mind', paidBy: 'customer', customerFee: fee, originalShippingRefunded: false, officialStoreRule: 'Free for every reason', note: `${format(fee)} return shipping is deducted from the refund unless the seller offers free returns` },
    fault('lost_in_transit', 'Refund without return after a carrier claim'),
  ];
}

export function responsibilityFor(list: ShippingResponsibility[], group: ReasonGroup): ShippingResponsibility {
  return list.find((r) => r.reasonGroup === group) ?? { reasonGroup: group, paidBy: group === 'change_of_mind' ? 'customer' : 'seller', customerFee: null, originalShippingRefunded: group !== 'change_of_mind' };
}

/* ---------------------------------------------------------------- time */

/** Weekday in a time zone (0 = Sunday) */
function weekdayIn(at: Date, tz: string): number {
  return new Date(at.getTime() + zoneOffsetMs(at, tz)).getUTCDay();
}

/** n business days (Mon–Fri, market time) after `from`, same time of day */
export function addBusinessDays(from: Date, n: number, tz: string): Date {
  let t = new Date(from.getTime());
  let left = Math.max(0, Math.round(n));
  while (left > 0) {
    t = new Date(t.getTime() + DAY);
    const wd = weekdayIn(t, tz);
    if (wd !== 0 && wd !== 6) left -= 1;
  }
  return t;
}

export const addDays = (from: Date, n: number) => new Date(from.getTime() + n * DAY);

export function deadline(dueAt: Date | string | null | undefined, now: Date, dueSoonHours = 24): common.Deadline | null {
  if (!dueAt) return null;
  const d = new Date(dueAt);
  const left = d.getTime() - now.getTime();
  return { dueAt: d.toISOString(), state: left < 0 ? 'overdue' : left <= dueSoonHours * HOUR ? 'due_soon' : 'on_time' };
}

export function shortDate(at: Date | string, tz: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(at));
}

/** e.g. Overdue 6 h, Due in 2 d */
export function relative(dueAt: Date | string, now: Date): string {
  const ms = new Date(dueAt).getTime() - now.getTime();
  const abs = Math.abs(ms);
  const span = abs >= DAY ? `${Math.round(abs / DAY)} d` : `${Math.max(1, Math.round(abs / HOUR))} h`;
  return ms < 0 ? `Overdue ${span}` : `Due in ${span}`;
}

export const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

/* ---------------------------------------------------------------- labels and tracks */

export interface LabelFacts {
  status: ReturnStatus;
  withoutReturn: boolean;
  outcome?: string | null;
  platformHandling: boolean;
  inspecting: boolean;
}

const OUTCOME_LABEL: Record<string, string> = { refunded: 'Refunded', partly_refunded: 'Partly refunded', replaced: 'Replaced', exchanged: 'Exchanged', credited: 'Refunded as store credit' };

export function customerStatusLabel(f: LabelFacts): string {
  switch (f.status) {
    case 'requested':
      return 'Requested';
    case 'info_requested':
      return 'Waiting for you';
    case 'approved':
      return 'Approved: send it back';
    case 'in_transit':
      return 'Sent back';
    case 'received':
      return 'Received';
    case 'awaiting_remedy':
      return f.withoutReturn ? 'Approved without return' : 'Inspected';
    case 'completed':
      return OUTCOME_LABEL[f.outcome ?? ''] ?? 'Completed';
    case 'rejected':
      return 'Rejected';
    case 'cancelled':
      return 'Cancelled';
  }
}

export function sellerStatusLabel(f: LabelFacts): string {
  if (f.platformHandling && is(ACTIVE_STATUSES, f.status)) return 'Escalated';
  switch (f.status) {
    case 'requested':
      return 'Return requested';
    case 'info_requested':
      return 'Waiting on customer';
    case 'approved':
      return 'Approved';
    case 'in_transit':
      return 'Return in transit';
    case 'received':
      return f.inspecting ? 'Inspecting' : 'Received';
    case 'awaiting_remedy':
      return f.withoutReturn ? 'Approved without return' : 'Decision made';
    case 'completed':
      return OUTCOME_LABEL[f.outcome ?? ''] ?? 'Completed';
    case 'rejected':
      return 'Rejected';
    case 'cancelled':
      return 'Cancelled';
  }
}

function steps(keys: [string, string][], current: number): TrackStep[] {
  return keys.map(([key, label], i) => ({ key, label, state: i < current ? 'done' : i === current ? 'current' : 'upcoming' }));
}

/** Item track: Requested, Approved, Sent back, Received, Inspected, Refunded (or Replaced) */
export function returnTrack(f: LabelFacts & { remedyKind: string }): TrackStep[] {
  const last: [string, string] = ['completed', f.remedyKind === 'replacement' ? 'Replaced' : f.remedyKind === 'exchange' ? 'Exchanged' : 'Refunded'];
  if (f.status === 'rejected') return steps([['requested', 'Requested'], ['rejected', 'Rejected']], 2);
  if (f.status === 'cancelled') return steps([['requested', 'Requested'], ['cancelled', 'Cancelled']], 2);
  if (f.withoutReturn) {
    const order: [string, string][] = [['requested', 'Requested'], ['approved', 'Approved without return'], last];
    return steps(order, f.status === 'completed' ? 3 : f.status === 'awaiting_remedy' ? 2 : 0);
  }
  const order: [string, string][] = [['requested', 'Requested'], ['approved', 'Approved'], ['in_transit', 'Sent back'], ['received', 'Received'], ['inspected', 'Inspected'], last];
  const at: Record<string, number> = { requested: 0, info_requested: 0, approved: 1, in_transit: 2, received: 3, awaiting_remedy: 5, completed: 6 };
  return steps(order, at[f.status] ?? 0);
}

export const REFUND_LABEL: Record<RefundStatus, string> = {
  requested: 'Requested',
  under_review: 'Under review',
  approved: 'Approved',
  declined: 'Declined',
  processing: 'Processing',
  sent: 'Sent',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export function refundTrack(status: RefundStatus): TrackStep[] {
  const order: [string, string][] = [['requested', 'Requested'], ['under_review', 'Under review'], ['approved', 'Approved'], ['processing', 'Processing'], ['sent', 'Sent']];
  const at: Record<string, number> = { requested: 0, under_review: 1, declined: 1, approved: 2, processing: 3, failed: 3, sent: 5, cancelled: 0 };
  return steps(order, at[status] ?? 0);
}

export function refundExplanation(status: RefundStatus): string {
  switch (status) {
    case 'requested':
    case 'under_review':
      return 'We are checking the refund amount. Nothing has been sent yet.';
    case 'declined':
      return 'The refund is being reviewed again. Nothing has been sent yet.';
    case 'approved':
      return "Approved still means the money hasn't been sent.";
    case 'processing':
      return 'The refund is on its way to your payment provider.';
    case 'sent':
      return 'The refund was sent. Banks usually show it in 3–5 business days.';
    case 'failed':
      return 'The refund could not be sent yet. We are retrying and will tell you if we need anything.';
    case 'cancelled':
      return 'This refund was cancelled.';
  }
}

/* ---------------------------------------------------------------- eligibility */

export type IneligibleReason = 'not_delivered' | 'not_shipped' | 'window_closed' | 'return_open' | 'final_sale' | 'category_excluded' | 'already_returned' | 'cancelled';

export interface ItemFacts {
  orderItemId: string;
  state: string;
  quantity: number;
  deliveredAt: string | null;
  /** Change-of-mind window end from orders (delivery + the snapshot window) */
  returnWindowEndsAt: string | null;
  windowDays: number;
  /** Units in returns that are not cancelled or rejected */
  used: number;
  openReturn: { id: string; ref: string } | null;
}

export interface ItemVerdict {
  eligible: boolean;
  reason: IneligibleReason | null;
  message: string;
  quantityReturnable: number;
  /** Change-of-mind return-by (fault return-by for final sale) */
  returnBy: Date | null;
  faultReturnBy: Date | null;
  changeOfMindReturnBy: Date | null;
}

const NOT_SHIPPED = ['pending_payment', 'confirmed', 'preparing', 'delayed', 'cancellation_requested'];

/**
 * Whether an order item can be returned now. Damaged, wrong or defective items have at least the
 * baseline window (faultWindowDays) even when the snapshot window is shorter or zero (final sale).
 */
export function itemVerdict(i: ItemFacts, now: Date, faultWindowDays: number, tz: string): ItemVerdict {
  const none = (reason: IneligibleReason, message: string, extra: Partial<ItemVerdict> = {}): ItemVerdict => ({ eligible: false, reason, message, quantityReturnable: 0, returnBy: null, faultReturnBy: null, changeOfMindReturnBy: null, ...extra });
  if (i.state === 'cancelled') return none('cancelled', 'Cancelled');
  if (NOT_SHIPPED.includes(i.state)) return none('not_shipped', 'Not shipped yet. You can cancel it instead.');
  if (i.state === 'shipped' || !i.deliveredAt) return none('not_delivered', 'Not delivered yet. You can return it once it arrives.');
  const delivered = new Date(i.deliveredAt);
  const changeOfMind = i.windowDays > 0 ? (i.returnWindowEndsAt ? new Date(i.returnWindowEndsAt) : addDays(delivered, i.windowDays)) : null;
  const faultDays = Math.max(i.windowDays, faultWindowDays);
  const fault = addDays(delivered, faultDays);
  const returnBy = changeOfMind ?? fault;
  const left = Math.max(0, i.quantity - i.used);
  const extra = { returnBy, faultReturnBy: fault, changeOfMindReturnBy: changeOfMind };
  if (i.state === 'refunded') return none('already_returned', 'Already refunded', extra);
  if (left === 0) return i.openReturn ? none('return_open', `Return ${i.openReturn.ref} is open`, extra) : none('already_returned', 'Already returned', extra);
  if (now.getTime() > fault.getTime()) return none('window_closed', `The return window closed on ${shortDate(returnBy, tz)}`, extra);
  if (!changeOfMind) return { eligible: true, reason: null, message: `Final sale: returns only if it arrived damaged, defective or wrong, by ${shortDate(fault, tz)}`, quantityReturnable: left, ...extra };
  if (now.getTime() > changeOfMind.getTime()) return { eligible: true, reason: null, message: `Only damaged, defective or wrong items can be returned now, by ${shortDate(fault, tz)}`, quantityReturnable: left, ...extra };
  return { eligible: true, reason: null, message: `Return by ${shortDate(returnBy, tz)}`, quantityReturnable: left, ...extra };
}

/** The verdict once the reason is known: change-of-mind returns need the change-of-mind window */
export function reasonVerdict(v: ItemVerdict, reason: string | null | undefined, now: Date, tz: string): { ok: true } | { ok: false; reason: IneligibleReason; message: string } {
  if (!v.eligible) return { ok: false, reason: v.reason!, message: v.message };
  if (!reason || isFault(reason)) return { ok: true };
  if (!v.changeOfMindReturnBy) return { ok: false, reason: 'final_sale', message: 'Final sale: change-of-mind returns are not accepted' };
  if (now.getTime() > v.changeOfMindReturnBy.getTime()) return { ok: false, reason: 'window_closed', message: `The change-of-mind window closed on ${shortDate(v.changeOfMindReturnBy, tz)}` };
  return { ok: true };
}

/* ---------------------------------------------------------------- refunds */

/** What the order says was paid for one line (orders.getPaidAmounts) */
export interface PaidLine {
  orderItemId: string;
  quantity: number;
  itemAmount: number;
  discountShare: number;
  shippingShare: number;
  taxShare: number;
  paid: number;
}

export interface BreakdownInput {
  lines: { paid: PaidLine; quantity: number; remaining?: number | null }[];
  currency: string;
  originalShippingRefunded: boolean;
  returnShippingDeduction: number;
  deductions: RefundDeduction[];
  /** Partial amount asked for (capped) */
  amount?: number | null;
}

export interface BreakdownResult {
  itemAmount: number;
  discountShare: number;
  shippingRefund: number;
  returnShippingDeduction: number;
  deductionsTotal: number;
  /** Before the cap */
  full: number;
  total: number;
  maxRefundable: number;
  perItem: { orderItemId: string; amount: number }[];
}

/** Share of a line amount for `part` of `whole` units (rounded down; the last units take the rest) */
const share = (amount: number, part: number, whole: number) => (whole > 0 && part < whole ? Math.floor((amount * part) / whole) : amount);

/**
 * Itemised refund for returned units: item price (tax included) − coupon share + original shipping
 * (when refunded for the reason) − return shipping paid by the customer − other deductions, never above
 * what is still refundable for these items.
 */
export function computeBreakdown(b: BreakdownInput): BreakdownResult {
  let itemAmount = 0;
  let discount = 0;
  let shipping = 0;
  let cap = 0;
  const perLine: { orderItemId: string; value: number; cap: number }[] = [];
  for (const l of b.lines) {
    const p = l.paid;
    const item = share(p.itemAmount + p.taxShare, l.quantity, p.quantity);
    const disc = share(p.discountShare, l.quantity, p.quantity);
    const ship = b.originalShippingRefunded ? share(p.shippingShare, l.quantity, p.quantity) : 0;
    const paidShare = share(p.paid, l.quantity, p.quantity);
    const lineCap = Math.max(0, Math.min(paidShare, l.remaining ?? paidShare));
    itemAmount += item;
    discount += disc;
    shipping += ship;
    cap += lineCap;
    perLine.push({ orderItemId: p.orderItemId, value: Math.max(0, item - disc + ship), cap: lineCap });
  }
  const deductionsTotal = b.deductions.reduce((s, d) => s + d.amount.amount, 0);
  const full = Math.max(0, itemAmount - discount + shipping - b.returnShippingDeduction - deductionsTotal);
  const asked = b.amount ?? full;
  const total = Math.max(0, Math.min(asked, cap));
  const parts = allocate(money(total, b.currency), perLine.map((l) => Math.max(1, l.value)));
  return {
    itemAmount,
    discountShare: discount,
    shippingRefund: shipping,
    returnShippingDeduction: b.returnShippingDeduction,
    deductionsTotal,
    full,
    total,
    maxRefundable: cap,
    perItem: perLine.map((l, i) => ({ orderItemId: l.orderItemId, amount: parts[i]!.amount })),
  };
}

/* ---------------------------------------------------------------- policies */

export interface WindowFacts {
  windowDays: number | null;
  changeOfMindAllowed: boolean;
  faultReturnsWindowDays: number;
}

/** True when the change gives customers less time (change-of-mind or fault window) */
export function shortensWindow(before: WindowFacts, after: WindowFacts): boolean {
  const com = (w: WindowFacts) => (w.changeOfMindAllowed ? (w.windowDays ?? 0) : 0);
  return com(after) < com(before) || after.faultReturnsWindowDays < before.faultReturnsWindowDays;
}

/** Next baseline version label: 1.0, 1.1, … */
export function nextVersion(versions: string[]): string {
  let best: [number, number] | null = null;
  for (const v of versions) {
    const m = /^(\d+)\.(\d+)$/.exec(v);
    if (!m) continue;
    const pair: [number, number] = [Number(m[1]), Number(m[2])];
    if (!best || pair[0] > best[0] || (pair[0] === best[0] && pair[1] > best[1])) best = pair;
  }
  return best ? `${best[0]}.${best[1] + 1}` : '1.0';
}

export function termsSummary(windowDays: number, changeOfMindAllowed: boolean, freeReturns: boolean): string {
  if (!changeOfMindAllowed || windowDays <= 0) return 'Final sale: returns only for damaged, defective or wrong items';
  return freeReturns ? `${windowDays}-day returns, free return shipping` : `${windowDays}-day returns, free for defects`;
}

export const isEmail = (s: string | null | undefined): s is string => !!s && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

/** Actors are stored as JSON text in *_by text columns */
export const actorText = (a: common.Actor) => JSON.stringify({ kind: a.kind, id: a.id ?? null, ...(a.name ? { name: a.name } : {}) });
export function actorFrom(text: string | null | undefined): common.Actor | null {
  if (!text) return null;
  try {
    const a = JSON.parse(text) as common.Actor;
    if (a && typeof a.kind === 'string') return { kind: a.kind, id: a.id ?? null, ...(a.name ? { name: a.name } : {}) };
  } catch {
    /* fall through */
  }
  return { kind: 'system', id: null, name: text };
}
