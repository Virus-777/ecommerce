// Sample rows for the admin "All orders" screen (design: pages/admin/admin-orders.html and
// admin-orders--overdue-dispatch.html). Replaced by the orders search API later.
import type { SellerId } from '@/data/fixtures';
import type { IconName, Tone } from '@/ui';

export type Edge = 'flagged' | 'warn' | '';

export type OrderFlag =
  | 'Overdue dispatch'
  | 'Payment failed'
  | 'Payment checking'
  | 'Due soon'
  | 'Seller restricted'
  | 'Cancellation requested'
  | 'Return requested'
  | 'Case open';

export const FLAG_STYLE: Record<OrderFlag, { tone: Tone; icon: IconName }> = {
  'Overdue dispatch': { tone: 'danger', icon: 'circle-alert' },
  'Payment failed': { tone: 'danger', icon: 'circle-alert' },
  'Payment checking': { tone: 'warning', icon: 'triangle-alert' },
  'Due soon': { tone: 'warning', icon: 'clock' },
  'Seller restricted': { tone: 'warning', icon: 'triangle-alert' },
  'Cancellation requested': { tone: 'warning', icon: 'triangle-alert' },
  'Return requested': { tone: 'warning', icon: 'triangle-alert' },
  'Case open': { tone: 'info', icon: 'info' },
};

export interface AdminOrderRow {
  ref: string;
  placed: string;
  customer: string;
  city: string;
  sellers: SellerId[];
  items: number;
  total: number;
  payment: string;
  fulfilment: string;
  fulfilmentNote: string;
  edge: Edge;
  flags: OrderFlag[];
  /** Overdue dispatch only: how late, and who owns the follow-up. */
  lateBy?: string;
  owner?: string;
}

/** The first DEFAULT_PAGE rows are page 1 of the unfiltered list; the rest come up when filtering. */
export const DEFAULT_PAGE = 11;
export const TOTAL_LAST_7_DAYS = 3418;

export const ADMIN_ORDERS: AdminOrderRow[] = [
  { ref: 'MK-261008-12210', placed: 'Oct 8, 9:31 AM', customer: 'Olivia Bennett', city: 'Denver, CO', sellers: ['official'], items: 1, total: 42, payment: 'Failed', fulfilment: 'Pending', fulfilmentNote: 'Waiting for payment retry', edge: 'flagged', flags: ['Payment failed'] },
  { ref: 'MK-261008-12077', placed: 'Oct 8, 9:14 AM', customer: 'Sam Rivera', city: 'Seattle, WA', sellers: ['northwind'], items: 2, total: 118, payment: 'Captured', fulfilment: 'New', fulfilmentNote: 'Dispatch due today 5:00 PM', edge: '', flags: [] },
  { ref: 'MK-261008-11950', placed: 'Oct 8, 8:40 AM', customer: 'Hannah Moore', city: 'Austin, TX', sellers: ['official', 'trailhead'], items: 3, total: 214.5, payment: 'Checking', fulfilment: 'Confirmed', fulfilmentNote: 'Held until payment confirms', edge: 'warn', flags: ['Payment checking'] },
  { ref: 'MK-261007-10433', placed: 'Oct 7, 6:48 PM', customer: 'Alex Morgan', city: 'Boise, ID', sellers: ['northwind'], items: 1, total: 59, payment: 'Captured', fulfilment: 'Overdue', fulfilmentNote: 'Dispatch overdue 3 h', edge: 'flagged', flags: ['Overdue dispatch'], lateBy: 'Overdue 3 h', owner: 'Seller' },
  { ref: 'MK-261007-10120', placed: 'Oct 7, 3:22 PM', customer: 'Priya Kapoor', city: 'San Jose, CA', sellers: ['official'], items: 1, total: 329, payment: 'Captured', fulfilment: 'Preparing', fulfilmentNote: 'Dispatch due in 1 h', edge: 'warn', flags: ['Due soon'] },
  { ref: 'MK-261006-09977', placed: 'Oct 6, 1:05 PM', customer: 'Marcus Webb', city: 'Tucson, AZ', sellers: ['gadgetgrove', 'official'], items: 2, total: 337, payment: 'Captured', fulfilment: 'Partly delivered', fulfilmentNote: '1 of 2 packages overdue', edge: 'flagged', flags: ['Overdue dispatch', 'Seller restricted'], lateBy: 'Overdue 1 d', owner: 'Grace Kim' },
  { ref: 'MK-261006-09812', placed: 'Oct 6, 10:47 AM', customer: 'Elena Ruiz', city: 'Fresno, CA', sellers: ['casaverde'], items: 2, total: 155, payment: 'Captured', fulfilment: 'Cancellation requested', fulfilmentNote: 'Customer asked to cancel 1 item', edge: 'warn', flags: ['Cancellation requested'] },
  { ref: 'MK-261005-08841', placed: 'Oct 5, 4:30 PM', customer: 'Tom Becker', city: 'Chicago, IL', sellers: ['pixelport', 'trailhead'], items: 3, total: 233.48, payment: 'Partly refunded', fulfilment: 'Partly delivered', fulfilmentNote: '1 of 2 packages delivered', edge: '', flags: [] },
  { ref: 'MK-260914-48213', placed: 'Sep 14, 7:42 PM', customer: 'Jordan Lee', city: 'Portland, OR', sellers: ['official', 'pixelport', 'casaverde'], items: 4, total: 513.98, payment: 'Captured', fulfilment: 'Partly delivered', fulfilmentNote: '1 of 3 packages delivered', edge: 'flagged', flags: ['Overdue dispatch', 'Return requested', 'Case open'], lateBy: 'Overdue 16 d', owner: 'Ana Silva · Warehouse' },
  { ref: 'MK-261004-07730', placed: 'Oct 4, 11:02 AM', customer: 'Grace Wu', city: 'Sacramento, CA', sellers: ['official'], items: 1, total: 58, payment: 'Captured', fulfilment: 'Delivered', fulfilmentNote: 'Delivered Oct 7', edge: '', flags: [] },
  { ref: 'MK-261003-06612', placed: 'Oct 3, 8:19 PM', customer: 'Daniel Kim', city: 'Reno, NV', sellers: ['trailhead'], items: 1, total: 139, payment: 'Refunded', fulfilment: 'Cancelled', fulfilmentNote: 'Seller could not fulfil', edge: '', flags: [] },
  // Not on page 1 of the unfiltered list; part of the "Overdue dispatch" saved filter.
  { ref: 'MK-261007-10388', placed: 'Oct 7, 1:12 PM', customer: 'Zoe Adams', city: 'Eugene, OR', sellers: ['official'], items: 1, total: 36, payment: 'Captured', fulfilment: 'Overdue', fulfilmentNote: 'Warehouse short 1 unit', edge: 'flagged', flags: ['Overdue dispatch'], lateBy: 'Overdue 1 h', owner: 'Ana Silva · Warehouse' },
  { ref: 'MK-261006-09544', placed: 'Oct 6, 9:40 AM', customer: 'Ryan Patel', city: 'Provo, UT', sellers: ['trailhead'], items: 1, total: 45, payment: 'Captured', fulfilment: 'Overdue', fulfilmentNote: 'No tracking received', edge: 'flagged', flags: ['Overdue dispatch'], lateBy: 'Overdue 6 h', owner: 'Seller' },
  { ref: 'MK-261006-09311', placed: 'Oct 6, 8:02 AM', customer: 'Mia Lopez', city: 'Mesa, AZ', sellers: ['gadgetgrove'], items: 1, total: 279, payment: 'Captured', fulfilment: 'Overdue', fulfilmentNote: 'Seller has not confirmed', edge: 'flagged', flags: ['Overdue dispatch', 'Seller restricted'], lateBy: 'Overdue 1 d', owner: 'Grace Kim' },
  { ref: 'MK-261005-08702', placed: 'Oct 5, 6:55 PM', customer: 'Noah Fischer', city: 'Dallas, TX', sellers: ['pixelport'], items: 2, total: 188.98, payment: 'Captured', fulfilment: 'Overdue', fulfilmentNote: 'Label created, no carrier scan', edge: 'flagged', flags: ['Overdue dispatch'], lateBy: 'Overdue 5 h', owner: 'Seller' },
  { ref: 'MK-261005-08455', placed: 'Oct 5, 2:21 PM', customer: 'Ava Thompson', city: 'Oakland, CA', sellers: ['casaverde'], items: 1, total: 119, payment: 'Captured', fulfilment: 'Overdue', fulfilmentNote: 'Seller reported supplier delay', edge: 'flagged', flags: ['Overdue dispatch'], lateBy: 'Overdue 2 d', owner: 'Grace Kim' },
  { ref: 'MK-261004-07981', placed: 'Oct 4, 5:47 PM', customer: 'Liam Brooks', city: 'Phoenix, AZ', sellers: ['gadgetgrove', 'northwind'], items: 2, total: 243, payment: 'Captured', fulfilment: 'Partly delivered', fulfilmentNote: 'Gadget Grove package overdue', edge: 'flagged', flags: ['Overdue dispatch'], lateBy: 'Overdue 2 d', owner: 'Grace Kim' },
];

export interface OrderFilters {
  type: string;
  seller: string;
  status: string;
  payment: string;
  date: string;
  flag: string;
}

export const FILTER_OPTIONS: Record<keyof OrderFilters, string[]> = {
  type: ['All sellers', 'Official Store', 'Marketplace sellers'],
  seller: ['Any seller', 'Marketly Official', 'Northwind Audio', 'Pixel & Port', 'Casa Verde Home', 'Trailhead Outfitters', 'Gadget Grove'],
  status: ['Any status', 'New', 'Preparing', 'Overdue', 'Shipped', 'Partly delivered', 'Delivered', 'Cancellation requested', 'Cancelled'],
  payment: ['Any payment', 'Captured', 'Checking', 'Failed', 'Partly refunded', 'Refunded'],
  date: ['Last 7 days', 'Today', 'Last 30 days', 'Custom range'],
  flag: ['Any flag', 'Overdue dispatch', 'Payment checking', 'Cancellation requested', 'Return requested', 'Seller restricted'],
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

export const NO_FILTERS: OrderFilters = { type: 'All sellers', seller: 'Any seller', status: 'Any status', payment: 'Any payment', date: 'Last 7 days', flag: 'Any flag' };
export const OVERDUE_FILTERS: OrderFilters = { ...NO_FILTERS, status: 'Overdue', date: 'Last 30 days', flag: 'Overdue dispatch' };

export interface SavedFilter {
  label: string;
  icon: IconName;
  count: number;
  /** Filters the chip applies; the overdue chip opens its own view. */
  filters: Partial<OrderFilters>;
  view?: 'overdue-dispatch';
}

export const SAVED_FILTERS: SavedFilter[] = [
  { label: 'Overdue dispatch', icon: 'alarm-clock', count: 9, filters: OVERDUE_FILTERS, view: 'overdue-dispatch' },
  { label: 'Partly delivered', icon: 'package-open', count: 41, filters: { status: 'Partly delivered' } },
  { label: 'Payment checking', icon: 'hourglass', count: 3, filters: { payment: 'Checking' } },
  { label: 'Cancellation requested', icon: 'circle-x', count: 6, filters: { status: 'Cancellation requested' } },
];
