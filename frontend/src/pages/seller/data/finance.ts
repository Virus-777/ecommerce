import { money } from '@/lib/format';
import type { ScreenId } from '@/routes/catalogue';
import type { IconName } from '@/ui';

// Design: pages/seller/seller-finance.html. Sample ledger and payouts (API: GET /seller/finance/*).

export type TxFilter = 'all' | 'sales' | 'fees' | 'refunds' | 'payouts';

export interface Transaction {
  id: string;
  date: string;
  type: string;
  icon: IconName;
  /** Which segment (besides All) shows the row; adjustments only show under All. */
  group: Exclude<TxFilter, 'all'> | null;
  ref: string;
  /** Screen the reference links to; plain text when absent. */
  refTo?: ScreenId;
  details: string;
  amount: number;
  balanceAfter: number;
}

export const TRANSACTIONS: Transaction[] = [
  { id: 't11', date: 'Oct 8, 9:14 AM', type: 'Marketplace fee', icon: 'percent', group: 'fees', ref: 'MK-261008-12077', refTo: 'seller/order', details: '10% of $118.00', amount: -11.8, balanceAfter: 3234.06 },
  { id: 't10', date: 'Oct 8, 9:14 AM', type: 'Sale', icon: 'shopping-bag', group: 'sales', ref: 'MK-261008-12077', refTo: 'seller/order', details: 'Halden Pocket Bluetooth Speaker × 2', amount: 118, balanceAfter: 3245.86 },
  { id: 't09', date: 'Oct 7, 4:30 PM', type: 'Adjustment', icon: 'scale', group: null, ref: 'ADJ-261007-0141', details: 'Carrier claim paid, lost parcel MK-260922-01187 · Priya Nair, Finance', amount: 45, balanceAfter: 3127.86 },
  { id: 't08', date: 'Oct 7, 10:05 AM', type: 'Marketplace fee', icon: 'percent', group: 'fees', ref: 'RT-260929-0702', details: 'Fee refunded on returned item', amount: 2.4, balanceAfter: 3082.86 },
  { id: 't07', date: 'Oct 7, 10:05 AM', type: 'Refund', icon: 'undo-2', group: 'refunds', ref: 'RT-260929-0702', refTo: 'seller/return', details: 'Studio Cable Kit · full refund', amount: -24, balanceAfter: 3080.46 },
  { id: 't06', date: 'Oct 6, 11:59 PM', type: 'Ad charge', icon: 'megaphone', group: 'fees', ref: 'AD-260915-0044', details: 'Pocket Speaker search boost · 38 clicks Oct 6', amount: -13.3, balanceAfter: 3104.46 },
  { id: 't05', date: 'Oct 6, 3:18 PM', type: 'Marketplace fee', icon: 'percent', group: 'fees', ref: 'MK-261006-20419', refTo: 'seller/order', details: '10% of $184.00 item price (shipping excluded)', amount: -18.4, balanceAfter: 3117.76 },
  { id: 't04', date: 'Oct 6, 3:18 PM', type: 'Sale', icon: 'shopping-bag', group: 'sales', ref: 'MK-261006-20419', refTo: 'seller/order', details: 'Halden Aurora ANC Headphones, incl. $6.99 shipping', amount: 190.99, balanceAfter: 3136.16 },
  { id: 't03', date: 'Oct 5, 11:42 AM', type: 'Marketplace fee', icon: 'percent', group: 'fees', ref: 'MK-261005-17730', refTo: 'seller/order', details: '10% of $59.00 item price', amount: -5.9, balanceAfter: 2945.17 },
  { id: 't02', date: 'Oct 5, 11:42 AM', type: 'Sale', icon: 'shopping-bag', group: 'sales', ref: 'MK-261005-17730', refTo: 'seller/order', details: 'Halden Pocket Bluetooth Speaker × 1', amount: 59, balanceAfter: 2951.07 },
  { id: 't01', date: 'Oct 5, 6:00 AM', type: 'Payout', icon: 'landmark', group: 'payouts', ref: 'PO-261005-3381', refTo: 'seller/statement', details: 'To Pacific Coast Credit Union •••• 6620', amount: -3427.95, balanceAfter: 2892.07 },
];

export interface Payout {
  ref: string;
  /** Has a statement page to link to. */
  statement: boolean;
  requested: string;
  arrived: string;
  amount: number;
  status: 'Pending' | 'Processing' | 'Paid' | 'Failed';
  result: string;
}

export const PAYOUTS: Payout[] = [
  { ref: 'PO-261012-3502', statement: false, requested: 'Mon, Oct 12', arrived: 'Estimated', amount: 1318.62, status: 'Pending', result: 'Amount set at cutoff Sun, Oct 11, 11:59 PM PT' },
  { ref: 'PO-261005-3381', statement: true, requested: 'Mon, Oct 5', arrived: 'Oct 6', amount: 3427.95, status: 'Paid', result: 'Statement Sep 28 – Oct 4' },
  { ref: 'PO-260928-3240', statement: true, requested: 'Mon, Sep 28', arrived: 'Sep 29', amount: 2871.44, status: 'Paid', result: 'Statement Sep 21 – Sep 27' },
  { ref: 'PO-260921-2954', statement: true, requested: 'Mon, Sep 21', arrived: 'Sep 22', amount: 3105.08, status: 'Paid', result: 'Statement Sep 14 – Sep 20' },
  { ref: 'PO-260916-2833', statement: true, requested: 'Wed, Sep 16', arrived: 'Sep 17', amount: 2214.9, status: 'Paid', result: 'Retry of PO-260914-2810 to the updated account' },
  { ref: 'PO-260914-2810', statement: false, requested: 'Mon, Sep 14', arrived: '—', amount: 2214.9, status: 'Failed', result: 'Bank returned it: account closed (R02). Funds kept safe in your balance.' },
];

export interface Balance {
  key: string;
  label: string;
  icon: IconName;
  amount: number;
  why: string;
  className?: string;
}

export const BALANCES: Balance[] = [
  { key: 'proceeds', label: 'Sales proceeds', icon: 'shopping-bag', amount: 2184.3, why: 'Accepted sales this period (Oct 5–8), including shipping you charged. Before fees, refunds and holds.' },
  { key: 'pending', label: 'Pending earnings', icon: 'hourglass', amount: 1742.85, why: 'After fees, waiting for delivery plus the 3-day hold. Moves to available on its own.' },
  { key: 'available', label: 'Available earnings', icon: 'wallet', amount: 1318.62, why: 'Eligible for your next payout. Fees, refunds and holds already taken off.', className: 'is-avail' },
  { key: 'held', label: 'Held amounts', icon: 'lock', amount: 172.59, why: 'Temporarily withheld. Not lost: released or adjusted after review.', className: 'is-held' },
];

export const HOLD = { order: 'MK-261003-07712', amount: 172.59, reason: 'carrier shows no delivery scan', review: 'Mon, Oct 12' };

/** +$118.00 / −$11.80 (true minus sign, as in the design). */
export const signedMoney = (n: number, plus = true) => (n < 0 ? `−${money(-n)}` : `${plus ? '+' : ''}${money(n)}`);
