/**
 * Pure order rules (no I/O): status derivation, labels, money splits, refund previews, deadlines.
 * Everything here works on plain values so it can be tested and reused by every view.
 */
import { allocate, format as formatMoney, money } from '../../../kernel/lib/money.js';
import { dateInZone, zonedTimeToUtc } from '../../../kernel/lib/clock.js';
import type * as common from '../../../spec/common.js';
import type { DiscountAllocation, OrderDisplayStatus, RefundPreviewLine } from '../../../spec/orders.js';

export type ItemState =
  | 'pending_payment'
  | 'confirmed'
  | 'preparing'
  | 'delayed'
  | 'shipped'
  | 'delivered'
  | 'cancellation_requested'
  | 'cancelled'
  | 'return_requested'
  | 'returned'
  | 'refunded';

export type GroupStatus = 'new' | 'preparing' | 'delayed' | 'partly_shipped' | 'shipped' | 'partly_delivered' | 'delivered' | 'partly_cancelled' | 'cancelled';
export type DisplayStatus = OrderDisplayStatus['value'];
export type DisplayFlag = OrderDisplayStatus['flags'][number];
export type Lifecycle = 'payment_pending' | 'open' | 'completed' | 'cancelled';

/** Not shipped yet and still to be fulfilled (a pending cancellation request keeps the units unshipped) */
export const UNSHIPPED: readonly ItemState[] = ['pending_payment', 'confirmed', 'preparing', 'delayed', 'cancellation_requested'];
/** Items the customer, seller or staff may still cancel */
export const CANCELLABLE: readonly ItemState[] = ['confirmed', 'preparing', 'delayed'];
/** Handed to a carrier or later */
export const SHIPPED_OR_LATER: readonly ItemState[] = ['shipped', 'delivered', 'return_requested', 'returned', 'refunded'];
/** Arrived (a return request or a refund happens after delivery) */
export const DELIVERED_LIKE: readonly ItemState[] = ['delivered', 'return_requested', 'returned', 'refunded'];
/** Final for completion: nothing more happens to the line */
export const FINAL: readonly ItemState[] = ['delivered', 'cancelled', 'returned', 'refunded'];

export const ITEM_STATE_LABEL: Record<ItemState, string> = {
  pending_payment: 'Payment being checked',
  confirmed: 'Confirmed',
  preparing: 'Preparing',
  delayed: 'Delayed',
  shipped: 'Shipped',
  delivered: 'Delivered',
  cancellation_requested: 'Cancellation requested',
  cancelled: 'Cancelled',
  return_requested: 'Return requested',
  returned: 'Returned',
  refunded: 'Refunded',
};

export const DISPLAY_LABEL: Record<DisplayStatus, string> = {
  payment_pending: 'Payment being checked',
  confirmed: 'Confirmed',
  preparing: 'Preparing',
  delayed: 'Delayed',
  partly_shipped: 'Partly shipped',
  shipped: 'Shipped',
  partly_delivered: 'Partly delivered',
  delivered: 'Delivered',
  partly_cancelled: 'Partly cancelled',
  cancelled: 'Cancelled',
  partly_refunded: 'Partly refunded',
  refunded: 'Refunded',
  completed: 'Completed',
};

export const GROUP_LABEL: Record<GroupStatus, string> = {
  new: 'New',
  preparing: 'Preparing',
  delayed: 'Delayed',
  partly_shipped: 'Partly shipped',
  shipped: 'Shipped',
  partly_delivered: 'Partly delivered',
  delivered: 'Delivered',
  partly_cancelled: 'Partly cancelled',
  cancelled: 'Cancelled',
};

export type SellerRowStatus =
  | 'new'
  | 'preparing'
  | 'delayed'
  | 'partly_shipped'
  | 'shipped'
  | 'in_transit'
  | 'out_for_delivery'
  | 'delivered'
  | 'completed'
  | 'cancelled'
  | 'partly_refunded'
  | 'cancellation_requested';

export const SELLER_STATUS_LABEL: Record<SellerRowStatus, string> = {
  new: 'New',
  preparing: 'Preparing',
  delayed: 'Delayed',
  partly_shipped: 'Partly shipped',
  shipped: 'Shipped',
  in_transit: 'In transit',
  out_for_delivery: 'Out for delivery',
  delivered: 'Delivered',
  completed: 'Completed',
  cancelled: 'Cancelled',
  partly_refunded: 'Partly refunded',
  cancellation_requested: 'Cancellation requested',
};

export const CONDITION_LABEL: Record<string, string> = {
  new: 'New',
  used_like_new: 'Used, like new',
  used_good: 'Used, good',
  used_acceptable: 'Used, acceptable',
  refurbished: 'Refurbished',
};

export const SHIPMENT_STATUS_LABEL: Record<string, string> = {
  label_created: 'Label created',
  shipped: 'Shipped, tracking pending',
  in_transit: 'In transit',
  out_for_delivery: 'Out for delivery',
  delivered: 'Delivered',
  delivery_failed: 'Delivery attempt failed',
  held_for_pickup: 'Held for pickup',
  returning: 'Returning to sender',
  returned_to_sender: 'Returned to sender',
  lost: 'Lost in transit',
  cancelled: 'Shipment cancelled',
};

/** Seller-area tabs → group statuses (seller_groups.status) */
export const SELLER_TAB_STATUSES: Record<string, GroupStatus[]> = {
  new: ['new'],
  preparing: ['preparing', 'delayed', 'partly_shipped'],
  shipped: ['shipped', 'partly_delivered'],
  completed: ['delivered', 'partly_cancelled', 'cancelled'],
};
/** Groups still waiting for something to ship */
export const OPEN_GROUP: readonly GroupStatus[] = ['new', 'preparing', 'delayed', 'partly_shipped'];

export const is = <T extends string>(list: readonly T[], v: string): v is T => (list as readonly string[]).includes(v);

/** The state an item counts as for status purposes (a pending request keeps the state before it) */
export const effectiveState = (i: { state: string; state_before_request?: string | null }): ItemState =>
  (i.state === 'cancellation_requested' ? (i.state_before_request ?? 'confirmed') : i.state) as ItemState;

/* ------------------------------------------------------------------ status derivation */

/** Group status from its items */
export function groupStatus(items: readonly { state: string; state_before_request?: string | null }[]): GroupStatus {
  const states = items.map(effectiveState);
  const active = states.filter((s) => s !== 'cancelled');
  if (!active.length) return 'cancelled';
  const unshipped = active.filter((s) => is(UNSHIPPED, s));
  const later = active.filter((s) => is(SHIPPED_OR_LATER, s));
  if (unshipped.length) {
    if (later.length) return 'partly_shipped';
    if (unshipped.includes('delayed')) return 'delayed';
    if (unshipped.includes('preparing')) return 'preparing';
    return 'new';
  }
  const delivered = active.filter((s) => is(DELIVERED_LIKE, s));
  if (delivered.length === active.length) return active.length < states.length ? 'partly_cancelled' : 'delivered';
  if (delivered.length) return 'partly_delivered';
  return 'shipped';
}

/** Overall status derived from the items, first match wins (spec notes) */
export function displayStatus(lifecycle: Lifecycle, items: readonly { state: string; state_before_request?: string | null }[]): DisplayStatus {
  const states = items.map(effectiveState);
  if (lifecycle === 'payment_pending' || states.includes('pending_payment')) return 'payment_pending';
  if (!states.length || states.every((s) => s === 'cancelled')) return 'cancelled';
  if (states.every((s) => s === 'refunded')) return 'refunded';
  const remaining = states.filter((s) => s !== 'cancelled');
  const delivered = (s: ItemState) => is(DELIVERED_LIKE, s);
  if (remaining.length < states.length && remaining.every(delivered)) return 'partly_cancelled';
  if (states.every(delivered)) return lifecycle === 'completed' ? 'completed' : 'delivered';
  if (remaining.some(delivered)) return 'partly_delivered';
  if (remaining.some((s) => s === 'shipped')) return remaining.every((s) => is(SHIPPED_OR_LATER, s)) ? 'shipped' : 'partly_shipped';
  if (remaining.includes('delayed')) return 'delayed';
  if (remaining.includes('preparing')) return 'preparing';
  return 'confirmed';
}

/* ------------------------------------------------------------------ money */

/** Integer amount of a Money-like jsonb value */
export const amountOf = (m: { amount?: number } | null | undefined) => m?.amount ?? 0;

/** Sum of a line's discount allocations */
export const discountSum = (discounts: readonly DiscountAllocation[]) => discounts.reduce((s, d) => s + d.amount.amount, 0);

export interface LineMoney {
  quantity: number;
  unit_price: number;
  discounts: DiscountAllocation[];
  shipping_share: number;
  tax_share: number;
  refunded_amount: number;
}

/** paidAmount = lineSubtotal − discounts + shippingShare + taxShare */
export const paidOf = (l: Pick<LineMoney, 'quantity' | 'unit_price' | 'discounts' | 'shipping_share' | 'tax_share'>) =>
  l.quantity * l.unit_price - discountSum(l.discounts) + l.shipping_share + l.tax_share;

/**
 * Splits a line: `part` units go to the first result, the rest to the second. Discount, shipping and tax shares
 * (and any refunded amount) are re-allocated by largest remainder in cents, so the two parts add up exactly.
 */
export function splitMoney(l: LineMoney, part: number, currency: string): [Omit<LineMoney, 'unit_price'>, Omit<LineMoney, 'unit_price'>] {
  const rest = l.quantity - part;
  const two = (amount: number) => allocate(money(amount, currency), [part, rest]).map((m) => m.amount) as [number, number];
  const discounts: [DiscountAllocation[], DiscountAllocation[]] = [[], []];
  for (const d of l.discounts) {
    const [a, b] = two(d.amount.amount);
    discounts[0].push({ ...d, amount: money(a, d.amount.currency) });
    discounts[1].push({ ...d, amount: money(b, d.amount.currency) });
  }
  const [s0, s1] = two(l.shipping_share);
  const [t0, t1] = two(l.tax_share);
  const [r0, r1] = two(l.refunded_amount);
  return [
    { quantity: part, discounts: discounts[0], shipping_share: s0, tax_share: t0, refunded_amount: r0 },
    { quantity: rest, discounts: discounts[1], shipping_share: s1, tax_share: t1, refunded_amount: r1 },
  ];
}

export interface PreviewLineInput {
  itemId: string;
  title: string;
  quantity: number;
  line: LineMoney;
}

/**
 * Refund estimate for cancelled quantities: item amount minus the coupon share, plus tax; shipping only when the
 * whole group ends up cancelled before dispatch (`groupShipping` is then the shipping not yet refunded for the group).
 */
export function refundLines(lines: readonly PreviewLineInput[], currency: string, groupShipping: number | null): RefundPreviewLine[] {
  const parts = lines.map((l) => {
    const share = l.quantity === l.line.quantity ? l.line : splitMoney(l.line, l.quantity, currency)[0];
    return { l, itemAmount: l.quantity * l.line.unit_price, discountShare: discountSum(share.discounts), taxRefund: share.tax_share, shipping: share.shipping_share };
  });
  const shipping =
    groupShipping == null
      ? parts.map(() => 0)
      : allocate(
          money(groupShipping, currency),
          parts.map((p) => p.shipping || p.itemAmount || 1),
        ).map((m) => m.amount);
  return parts.map((p, i) => {
    const shippingRefund = shipping[i] ?? 0;
    return {
      itemId: p.l.itemId,
      title: p.l.title,
      quantity: p.l.quantity,
      itemAmount: money(p.itemAmount, currency),
      discountShare: money(p.discountShare, currency),
      shippingRefund: money(shippingRefund, currency),
      taxRefund: money(p.taxRefund, currency),
      refund: money(p.itemAmount - p.discountShare + shippingRefund + p.taxRefund, currency),
    };
  });
}

export const sumMoney = (list: readonly common.Money[], currency: string) => money(list.reduce((s, m) => s + m.amount, 0), currency);

export const fmt = (amount: number, currency: string) => formatMoney(money(amount, currency));

/* ------------------------------------------------------------------ time and deadlines */

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export function deadline(dueAt: Date, now: Date, open: boolean, dueSoonMinutes: number): common.Deadline {
  const state = !open ? 'on_time' : now.getTime() > dueAt.getTime() ? 'overdue' : dueAt.getTime() - now.getTime() <= dueSoonMinutes * MINUTE ? 'due_soon' : 'on_time';
  return { dueAt: dueAt.toISOString(), state };
}

export const human = (ms: number) => {
  const h = Math.round(ms / HOUR);
  if (h < 1) return `${Math.max(1, Math.round(ms / MINUTE))} min`;
  if (h < 48) return `${h} h`;
  return `${Math.round(ms / DAY)} d`;
};

export const shortDate = (d: Date | string, timeZone: string) =>
  new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(d));
export const monthDay = (d: Date | string, timeZone: string) => new Intl.DateTimeFormat('en-US', { timeZone, month: 'short', day: 'numeric' }).format(new Date(d));
export const clockTime = (d: Date | string, timeZone: string) => new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(new Date(d));
/** A date-only value (YYYY-MM-DD) shown as 'Mon, Oct 12' */
export const dayLabel = (ymd: string) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(`${ymd}T12:00:00Z`));

/** 'Due today 5:00 PM', 'Overdue 3 h', 'Shipped Oct 6 · 1 day late' */
export function deadlineLabel(dueAt: Date, now: Date, shippedAt: Date | null, open: boolean, timeZone: string): string {
  if (shippedAt) {
    const late = shippedAt.getTime() - dueAt.getTime();
    return late > 0 ? `Shipped ${monthDay(shippedAt, timeZone)} · ${human(late)} late` : `Shipped ${monthDay(shippedAt, timeZone)} · on time`;
  }
  if (!open) return `Was due ${monthDay(dueAt, timeZone)}`;
  if (now.getTime() > dueAt.getTime()) return `Overdue ${human(now.getTime() - dueAt.getTime())}`;
  const today = dateInZone(now, timeZone);
  const due = dateInZone(dueAt, timeZone);
  if (due === today) return `Due today ${clockTime(dueAt, timeZone)}`;
  const tomorrow = dateInZone(new Date(now.getTime() + DAY), timeZone);
  if (due === tomorrow) return `Due tomorrow ${clockTime(dueAt, timeZone)}`;
  return `Due ${shortDate(dueAt, timeZone)}`;
}

export function dispatchResult(dueAt: Date, shippedAt: Date | null): string | null {
  if (!shippedAt) return null;
  const late = shippedAt.getTime() - dueAt.getTime();
  return late > 0 ? `Shipped ${human(late)} late` : 'Shipped on time';
}

/** End of the market day of an instant (start of the next day) */
export function endOfMarketDay(at: Date, timeZone: string): Date {
  const next = dateInZone(new Date(at.getTime() + DAY), timeZone);
  return zonedTimeToUtc(next, '00:00', timeZone);
}

/**
 * When a seller must answer a customer cancellation request (setting sellerCancellationResponse):
 * 'next_business_day_HH:MM' (Mon–Fri, market time), or 'hours_N'.
 */
export function respondBy(now: Date, rule: string, timeZone: string): Date {
  const hours = /^hours_(\d+)$/.exec(rule);
  if (hours) return new Date(now.getTime() + Number(hours[1]) * HOUR);
  const m = /^next_business_day_(\d{1,2}):(\d{2})$/.exec(rule) ?? /^next_business_day_(\d{1,2})(\d{2})$/.exec(rule);
  const time = m ? `${m[1]!.padStart(2, '0')}:${m[2]}` : '17:00';
  let day = dateInZone(now, timeZone);
  for (let i = 0; i < 10; i++) {
    day = dateInZone(new Date(zonedTimeToUtc(day, '12:00', timeZone).getTime() + DAY), timeZone);
    const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
    if (weekday !== 0 && weekday !== 6) break;
  }
  return zonedTimeToUtc(day, time, timeZone);
}

/** 'Sam R.' from 'Sam Rivera' */
export function buyerName(full: string): string {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'Customer';
  if (parts.length === 1) return parts[0]!;
  return `${parts[0]} ${parts.at(-1)!.charAt(0).toUpperCase()}.`;
}

/** 'Queen · Sage' from variant options */
export const variantLabelOf = (options: Record<string, string> | null | undefined) => Object.values(options ?? {}).filter(Boolean).join(' · ');

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Date range presets of the store order list, as an instant from which orders count */
export function rangeStart(range: string | undefined, now: Date, timeZone: string): Date | null {
  switch (range) {
    case 'last_30_days':
      return new Date(now.getTime() - 30 * DAY);
    case 'last_3_months':
      return new Date(now.getTime() - 91 * DAY);
    case 'last_6_months':
      return new Date(now.getTime() - 182 * DAY);
    case 'this_year':
      return zonedTimeToUtc(`${dateInZone(now, timeZone).slice(0, 4)}-01-01`, '00:00', timeZone);
    default:
      return null;
  }
}

/** A market date (YYYY-MM-DD) as the instant it starts; `end` gives the start of the next day */
export const dayStart = (ymd: string, timeZone: string, end = false) => {
  const start = zonedTimeToUtc(ymd, '00:00', timeZone);
  return end ? endOfMarketDay(start, timeZone) : start;
};

export const maskEmail = (email: string) => {
  const [user = '', domain = ''] = email.split('@');
  return `${user.slice(0, 1)}***@${domain}`;
};
export const maskPhone = (phone: string | null | undefined) => (phone ? `***${phone.slice(-2)}` : null);
