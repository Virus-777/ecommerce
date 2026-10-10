// Seller orders (design: pages/seller/seller-orders*.html, seller-order*.html).
import type { IconName } from '@/ui';

export type OrderStatus = 'New' | 'Preparing' | 'Shipped' | 'In transit' | 'Out for delivery' | 'Completed' | 'Partly refunded' | 'Cancelled';
export type DueTone = 'ok' | 'warning' | 'danger';

export interface SellerOrderRow {
  ref: string;
  placed: string;
  /** Minutes since Oct 1, 00:00 PT, for sorting and the date filter. */
  at: number;
  buyer: string;
  items: string;
  total: number;
  status: OrderStatus;
  due: string;
  dueTone: DueTone;
  /** "1 of 2 items shipped" under the items. */
  partial?: string;
  /** Override for the next-action label. */
  action?: string;
}

const t = (day: number, h: number, m: number) => (day - 1) * 1440 + h * 60 + m;

export const ORDER_ROWS: SellerOrderRow[] = [
  { ref: 'MK-261008-12077', placed: 'Oct 8, 9:14 AM', at: t(8, 9, 14), buyer: 'Sam R.', items: 'Halden Pocket Bluetooth Speaker, Teal × 2', total: 118, status: 'New', due: 'Due today 5:00 PM', dueTone: 'warning' },
  { ref: 'MK-261008-11902', placed: 'Oct 8, 8:02 AM', at: t(8, 8, 2), buyer: 'Priya K.', items: 'Halden Aurora ANC Headphones, Midnight black', total: 190.99, status: 'New', due: 'Due today 5:00 PM', dueTone: 'warning' },
  { ref: 'MK-261008-12688', placed: 'Oct 8, 9:52 AM', at: t(8, 9, 52), buyer: 'Dev P.', items: 'Northwind Studio Cable Kit × 3', total: 72, status: 'New', due: 'Due today 5:00 PM', dueTone: 'warning' },
  { ref: 'MK-261007-10433', placed: 'Oct 7, 6:48 PM', at: t(7, 18, 48), buyer: 'Alex M.', items: 'Halden Pocket Bluetooth Speaker, Charcoal × 1', total: 59, status: 'Preparing', due: 'Overdue 3 h', dueTone: 'danger' },
  { ref: 'MK-261007-10291', placed: 'Oct 7, 3:20 PM', at: t(7, 15, 20), buyer: 'Nina W.', items: 'Halden Aurora ANC Headphones, Silver + Studio Cable Kit', total: 214.99, status: 'Preparing', due: 'Due today 5:00 PM', dueTone: 'warning' },
  { ref: 'MK-261008-11430', placed: 'Oct 8, 7:40 AM', at: t(8, 7, 40), buyer: 'Hana Y.', items: 'Halden Aurora ANC Headphones + Pocket Speaker, Teal', total: 243, status: 'Preparing', due: 'Due today 5:00 PM', dueTone: 'warning', partial: '1 of 2 items shipped', action: 'Ship remaining item' },
  { ref: 'MK-261007-09811', placed: 'Oct 7, 2:10 PM', at: t(7, 14, 10), buyer: 'Chris T.', items: 'Halden Aurora ANC Headphones, Midnight black', total: 190.99, status: 'Shipped', due: 'Shipped Oct 8 · on time', dueTone: 'ok' },
  { ref: 'MK-261006-08544', placed: 'Oct 6, 4:55 PM', at: t(6, 16, 55), buyer: 'Leah S.', items: 'Halden Pocket Bluetooth Speaker, Teal', total: 59, status: 'In transit', due: 'Shipped Oct 7 · on time', dueTone: 'ok' },
  { ref: 'MK-261006-08302', placed: 'Oct 6, 10:21 AM', at: t(6, 10, 21), buyer: 'Ben A.', items: 'Northwind Studio Cable Kit × 2', total: 52.99, status: 'Out for delivery', due: 'Shipped Oct 6 · on time', dueTone: 'ok' },
  { ref: 'MK-261005-07710', placed: 'Oct 5, 1:37 PM', at: t(5, 13, 37), buyer: 'Marco D.', items: 'Halden Buds Pro, Charcoal', total: 149, status: 'Shipped', due: 'Shipped Oct 6 · 1 day late', dueTone: 'danger' },
  { ref: 'MK-261006-08120', placed: 'Oct 6, 11:31 AM', at: t(6, 11, 31), buyer: 'Jordan L.', items: 'Northwind Studio Cable Kit', total: 24, status: 'Completed', due: 'Delivered Oct 8', dueTone: 'ok' },
  { ref: 'MK-261003-05530', placed: 'Oct 3, 8:15 PM', at: t(3, 20, 15), buyer: 'Erin C.', items: 'Halden Aurora ANC Headphones, Silver', total: 190.99, status: 'Completed', due: 'Delivered Oct 7', dueTone: 'ok' },
  { ref: 'MK-261002-04418', placed: 'Oct 2, 12:02 PM', at: t(2, 12, 2), buyer: 'Tom H.', items: 'Halden Pocket Bluetooth Speaker, Teal × 1', total: 59, status: 'Partly refunded', due: 'Delivered Oct 6', dueTone: 'ok' },
];

/** Completed orders on the server beyond the loaded page (126 in total). */
export const COMPLETED_TOTAL = 126;

export interface CancelRequest {
  ref: string;
  placed: string;
  buyer: string;
  item: string;
  icon: IconName;
  tint: string;
  amount: number;
  shipped: boolean;
  reason: string;
  quote: string;
  due: string;
}

export const CANCEL_REQUESTS: CancelRequest[] = [
  { ref: 'MK-261008-12519', placed: 'Oct 8, 8:47 AM', buyer: 'Taylor B.', item: 'Halden Pocket Bluetooth Speaker, Charcoal × 1', icon: 'speaker', tint: '6', amount: 59, shipped: false, reason: 'Ordered the wrong color.', quote: "Meant to order Teal, sorry. I'll place a new order.", due: 'Respond by today 5:00 PM' },
];
