// Filters and row helpers for the admin "All orders" screen (design: pages/admin/admin-orders.html and
// admin-orders--overdue-dispatch.html). Data: GET /api/admin/orders/orders (filters, page), GET orders/saved-filters,
// rows' openExceptionIds (shipping exceptions/{id}/notify-seller and exceptions/bulk), POST orders/exports.
import type { components } from '@marketly/web-shared/api';
import type { IconName, Tone } from '@marketly/web-shared/ui';
import { dayKey } from '@/app/parts';

export type AdminOrderRow = components['schemas']['orders.AdminOrderRow'];
export interface OrderFlag {
  kind: string;
  tone: string;
  label: string;
}
export interface RowSeller {
  ownerType: 'official' | 'seller';
  id: string | null;
  name: string;
  slug?: string | null;
}

export type Edge = 'flagged' | 'warn' | '';

/** Badge style per flag tone (the API sends tone + label). */
export function flagStyle(f: OrderFlag): { tone: Tone; icon: IconName } {
  if (f.tone === 'danger') return { tone: 'danger', icon: 'circle-alert' };
  if (f.tone === 'warning') return { tone: 'warning', icon: f.kind === 'due_soon' ? 'clock' : 'triangle-alert' };
  return { tone: 'info', icon: 'info' };
}

export const rowFlags = (o: AdminOrderRow) => (o.flags ?? []) as OrderFlag[];
export const rowSellers = (o: AdminOrderRow) => (o.sellers ?? []) as RowSeller[];

export function rowEdge(o: AdminOrderRow): Edge {
  const f = rowFlags(o);
  if (o.lateBy || f.some((x) => x.tone === 'danger')) return 'flagged';
  if (f.some((x) => x.tone === 'warning')) return 'warn';
  return '';
}

export const PAYMENT_LABEL: Record<AdminOrderRow['paymentState'], string> = {
  pending_check: 'Checking',
  authorized: 'Authorized',
  captured: 'Captured',
  failed: 'Failed',
  partly_refunded: 'Partly refunded',
  refunded: 'Refunded',
};

/** Filter values are API values; '' = any. */
export interface OrderFilters {
  type: '' | 'official' | 'marketplace';
  seller: string;
  status: string;
  payment: string;
  date: '7d' | 'today' | '30d' | 'any';
  flag: string;
}

type Opt = { value: string; label: string };

export const STATUS_OPTIONS: Opt[] = [
  { value: '', label: 'Any status' },
  { value: 'new', label: 'New' },
  { value: 'preparing', label: 'Preparing' },
  { value: 'overdue', label: 'Overdue' },
  { value: 'shipped', label: 'Shipped' },
  { value: 'partly_delivered', label: 'Partly delivered' },
  { value: 'delivered', label: 'Delivered' },
  { value: 'cancellation_requested', label: 'Cancellation requested' },
  { value: 'cancelled', label: 'Cancelled' },
];

export const FILTER_OPTIONS: Record<Exclude<keyof OrderFilters, 'seller'>, Opt[]> = {
  type: [
    { value: '', label: 'All sellers' },
    { value: 'official', label: 'Official Store' },
    { value: 'marketplace', label: 'Marketplace sellers' },
  ],
  status: STATUS_OPTIONS,
  payment: [
    { value: '', label: 'Any payment' },
    { value: 'captured', label: 'Captured' },
    { value: 'pending_check', label: 'Checking' },
    { value: 'failed', label: 'Failed' },
    { value: 'partly_refunded', label: 'Partly refunded' },
    { value: 'refunded', label: 'Refunded' },
  ],
  date: [
    { value: '7d', label: 'Last 7 days' },
    { value: 'today', label: 'Today' },
    { value: '30d', label: 'Last 30 days' },
    { value: 'any', label: 'Any time' },
  ],
  flag: [
    { value: '', label: 'Any flag' },
    { value: 'overdue_dispatch', label: 'Overdue dispatch' },
    { value: 'payment_checking', label: 'Payment checking' },
    { value: 'payment_failed', label: 'Payment failed' },
    { value: 'cancellation_requested', label: 'Cancellation requested' },
    { value: 'return_requested', label: 'Return requested' },
    { value: 'case_open', label: 'Case open' },
    { value: 'seller_restricted', label: 'Seller restricted' },
    { value: 'chargeback', label: 'Chargeback' },
    { value: 'delivery_issue', label: 'Delivery issue' },
  ],
};

export const FILTER_LABELS: Record<keyof OrderFilters, string> = {
  type: 'Seller type',
  seller: 'Seller',
  status: 'Fulfilment status',
  payment: 'Payment status',
  date: 'Placed',
  flag: 'Flag',
};

/** Prefix used on the applied-filter chips ('' = the value alone, as "Last 30 days"). */
export const CHIP_PREFIX: Record<keyof OrderFilters, string> = {
  type: 'Seller type: ',
  seller: 'Seller: ',
  status: 'Status: ',
  payment: 'Payment: ',
  date: '',
  flag: 'Flag: ',
};

export const NO_FILTERS: OrderFilters = { type: '', seller: '', status: '', payment: '', date: '7d', flag: '' };
export const OVERDUE_FILTERS: OrderFilters = { ...NO_FILTERS, date: '30d', flag: 'overdue_dispatch' };

const daysAgo = (n: number, now = new Date()) => dayKey(new Date(now.getTime() - n * 86_400_000));

/** The list query for a set of filters (placed dates are Pacific calendar days). */
export function orderQuery(f: OrderFilters, q: string) {
  const placedFrom = f.date === 'today' ? daysAgo(0) : f.date === '7d' ? daysAgo(6) : f.date === '30d' ? daysAgo(29) : undefined;
  return {
    q: q.trim() || undefined,
    sellerType: f.type || undefined,
    sellerId: f.seller || undefined,
    fulfillmentStatus: (f.status || undefined) as 'new' | undefined,
    paymentState: (f.payment || undefined) as 'captured' | undefined,
    flag: (f.flag || undefined) as 'overdue_dispatch' | undefined,
    placedFrom,
  };
}

export interface QuickFilter {
  label: string;
  icon: IconName;
  /** Filters the chip applies; the overdue chip opens its own view. */
  filters: Partial<OrderFilters>;
  view?: 'overdue-dispatch';
}

/** The design's saved-filter chips (counts come from the API); the staff member's own saved filters follow. */
export const QUICK_FILTERS: QuickFilter[] = [
  { label: 'Overdue dispatch', icon: 'alarm-clock', filters: OVERDUE_FILTERS, view: 'overdue-dispatch' },
  { label: 'Partly delivered', icon: 'package-open', filters: { status: 'partly_delivered', date: '30d' } },
  { label: 'Payment checking', icon: 'hourglass', filters: { payment: 'pending_check', date: '30d' } },
  { label: 'Cancellation requested', icon: 'circle-x', filters: { status: 'cancellation_requested', date: '30d' } },
];

export const optLabel = (opts: Opt[], v: string) => opts.find((o) => o.value === v)?.label ?? v;
