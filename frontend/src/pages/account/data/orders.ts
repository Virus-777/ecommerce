// Shopper order summaries used by the account Overview and Orders pages.
// API shape: one row per order with its packages (one per seller) and item product ids.
import type { Tone } from '@/ui';

export type OrderTab = 'in-progress' | 'delivered' | 'returns' | 'cancelled';

export interface OrderPackage {
  label: string;
  seller: string;
  status: string;
  note: string;
}

export interface OrderSummary {
  ref: string;
  /** ISO date, for the date-range filter. */
  placedOn: string;
  placed: string;
  total: number;
  sellers: number;
  status: string;
  tone?: Tone;
  items: string[];
  packages: OrderPackage[];
  note?: string;
  /** Overview: item state counts ("1 delivered", "2 in transit"). */
  itemBadges: Array<{ label: string; tone: Tone }>;
  tabs: OrderTab[];
  actions: Array<'cancel' | 'track' | 'return' | 'review' | 'buy-again'>;
}

export const ORDER_SUMMARIES: OrderSummary[] = [
  {
    ref: 'MK-261006-90127', placedOn: '2026-10-06', placed: 'Oct 6, 2026', total: 88.5, sellers: 1, status: 'Preparing',
    items: ['bottle', 'yogamat'],
    packages: [{ label: 'Package', seller: 'Trailhead Outfitters', status: 'Preparing', note: 'Ships by Fri, Oct 9' }],
    itemBadges: [{ label: '2 preparing', tone: 'info' }],
    tabs: ['in-progress'], actions: ['cancel'],
  },
  {
    ref: 'MK-260914-48213', placedOn: '2026-09-14', placed: 'Sep 14, 2026', total: 513.98, sellers: 3, status: 'Partly delivered',
    items: ['aurora', 'pourover', 'ssd1tb', 'duvet'],
    packages: [
      { label: 'Package 1', seller: 'Marketly Official', status: 'Delivered', note: 'Delivered Sep 17' },
      { label: 'Package 2', seller: 'Pixel & Port', status: 'In transit', note: 'Arrives Oct 9–10' },
      { label: 'Package 3', seller: 'Casa Verde Home', status: 'Delayed', note: 'Now due Oct 12' },
    ],
    note: '1 return open: RT-260921-0457',
    itemBadges: [
      { label: '1 delivered', tone: 'success' }, { label: '1 return requested', tone: 'warning' }, { label: '2 in transit', tone: 'info' }, { label: '1 delayed', tone: 'warning' },
    ],
    tabs: ['in-progress', 'returns'], actions: ['track', 'return'],
  },
  {
    ref: 'MK-260830-11764', placedOn: '2026-08-30', placed: 'Aug 30, 2026', total: 58, sellers: 1, status: 'Delivered',
    items: ['skillet'],
    packages: [{ label: 'Package', seller: 'Marketly Official', status: 'Delivered', note: 'Delivered Sep 2' }],
    note: 'Return window closed Oct 2',
    itemBadges: [{ label: '1 delivered', tone: 'success' }],
    tabs: ['delivered'], actions: ['review', 'buy-again'],
  },
  {
    ref: 'MK-260818-07352', placedOn: '2026-08-18', placed: 'Aug 18, 2026', total: 139, sellers: 1, status: 'Refunded',
    items: ['backpack'],
    packages: [{ label: 'Package', seller: 'Trailhead Outfitters', status: 'Delivered', note: 'Delivered Aug 21' }],
    note: 'Returned. Refund of $139.00 sent Sep 4 to Visa •••• 4417',
    itemBadges: [{ label: '1 refunded', tone: '' }],
    tabs: ['delivered', 'returns'], actions: ['buy-again'],
  },
  {
    ref: 'MK-260811-03309', placedOn: '2026-08-11', placed: 'Aug 11, 2026', total: 112, sellers: 1, status: 'Cancelled',
    items: ['shoes'],
    packages: [{ label: 'Package', seller: 'Trailhead Outfitters', status: 'Cancelled', note: 'Cancelled before shipping' }],
    note: 'You cancelled on Aug 11. Refund of $112.00 sent Aug 12.',
    itemBadges: [{ label: '1 cancelled', tone: '' }],
    tabs: ['cancelled'], actions: ['buy-again'],
  },
];

/** Totals across the shopper's whole history (the sample rows are the first page). */
export const ORDER_COUNTS = { all: 23, 'in-progress': 2, delivered: 18, returns: 3, cancelled: 1 } as const;
