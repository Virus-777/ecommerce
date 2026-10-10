// Sample data for the admin order detail (design: pages/admin/admin-order.html and
// admin-order--issue-refund.html). Order MK-260914-48213 from @/data/fixtures, with the
// back-office fields (coupon share per item, cancellation/return requests, owners, history).
import type { SellerId, Tint } from '@/data/fixtures';
import type { IconName, TimelineEvent } from '@/ui';

export type ItemId = 'aurora' | 'pourover' | 'ssd1tb' | 'duvet';

export interface AdminOrderItem {
  id: ItemId;
  name: string;
  /** Short label in the cancellations table. */
  short: string;
  icon: IconName;
  tint: Tint;
  seller: SellerId;
  variant: string;
  sku: string;
  qty: number;
  unit: number;
  /** Paid after the coupon share. */
  paid: number;
  status: string;
  /** Second status pair shown next to the item status, e.g. Refund · Under review. */
  sub?: { label: string; status: string };
  note: string;
  /** Line under the item in the refund dialog. */
  refundNote: string;
  /** Not refundable yet (shown greyed out in the dialog). */
  blocked?: boolean;
  request:
    | { kind: 'return'; ref: string; note: string; owner: string; edge: 'warn' | 'flagged' }
    | { kind: 'cancel'; note: string; owner: string; edge: 'warn' | 'flagged' }
    | { kind: 'none' };
}

export const ITEMS: Record<ItemId, AdminOrderItem> = {
  aurora: {
    id: 'aurora', name: 'Halden Aurora ANC Wireless Headphones', short: 'Aurora ANC Headphones', icon: 'headphones', tint: '2', seller: 'official',
    variant: 'Midnight black', sku: 'HAL-AUR-BLK', qty: 1, unit: 189, paid: 181.92, status: 'Delivered',
    note: 'Delivered Sep 17 · return window open until Oct 17', refundNote: 'Delivered · return window open until Oct 17', request: { kind: 'none' },
  },
  pourover: {
    id: 'pourover', name: 'Mosswood Ceramic Pour-over Coffee Set', short: 'Pour-over Coffee Set', icon: 'coffee', tint: '3', seller: 'official',
    variant: 'Cream', sku: 'MSW-PO-CRM', qty: 1, unit: 36, paid: 34.65, status: 'Return requested', sub: { label: 'Refund', status: 'Under review' },
    note: 'Return RT-261006-0193 · arrived chipped · refund without return proposed', refundNote: 'Return RT-261006-0193 · refund without return (exception)',
    request: { kind: 'return', ref: 'RT-261006-0193', note: 'Refund without return proposed', owner: 'Lena Park', edge: 'warn' },
  },
  ssd1tb: {
    id: 'ssd1tb', name: 'Kestrel 1 TB Portable SSD, USB 3.2', short: '1 TB Portable SSD × 2', icon: 'hard-drive', tint: '6', seller: 'pixelport',
    variant: 'Space gray', sku: 'KST-SSD1T', qty: 2, unit: 94.99, paid: 182.87, status: 'In transit',
    note: 'In transit · USPS last scan Oct 7, Memphis, TN', refundNote: 'In transit · refund after delivery or after the carrier confirms a loss', blocked: true, request: { kind: 'none' },
  },
  duvet: {
    id: 'duvet', name: 'Mosswood Washed Linen Duvet Cover, Queen', short: 'Linen Duvet Cover', icon: 'bed-double', tint: '1', seller: 'casaverde',
    variant: 'Queen · Sage', sku: 'MSW-LIN-Q-SAGE', qty: 1, unit: 119, paid: 114.54, status: 'Delayed',
    note: 'Not shipped · dispatch was due Sep 22 · seller promises Oct 12 · eligible to cancel', refundNote: 'Not shipped · this also cancels the item and closes the overdue task',
    request: { kind: 'cancel', note: 'Customer asked in CS-261007-0412', owner: 'Grace Kim', edge: 'flagged' },
  },
};

/** Dialog order: refundable requests first, then the rest. Table order matches the design. */
export const REFUND_ORDER: ItemId[] = ['pourover', 'duvet', 'aurora', 'ssd1tb'];

export interface AdminPackage {
  seller: SellerId;
  label: string;
  sub: string;
  status: string;
  items: ItemId[];
  carrier: string;
  tracking?: string;
  trackingNote?: string;
  eta: string;
  deadline: { tone: 'ok' | 'danger'; text: string };
  /** Footer actions: tracking tools, or follow-up on an unshipped package. */
  foot: 'tracking' | 'unshipped';
}

export const PACKAGES: AdminPackage[] = [
  { seller: 'official', label: 'Package 1 of 3', sub: 'Package 1 of 3 · Shipped by Marketly warehouse, Reno, NV · items $225.00', status: 'Delivered', items: ['aurora', 'pourover'], carrier: 'UPS Ground', tracking: '1Z84E2W70392017745', eta: 'Delivered Sep 17', deadline: { tone: 'ok', text: 'Dispatched Sep 15, 10:12 AM · on time' }, foot: 'tracking' },
  { seller: 'pixelport', label: 'Package 2 of 3', sub: 'Package 2 of 3 · Seller ships · Austin, TX · items $189.98', status: 'Shipped', items: ['ssd1tb'], carrier: 'USPS Priority', tracking: '9405 5112 9830 1847 2290 31', eta: 'Arrives Oct 9–10', deadline: { tone: 'ok', text: 'Dispatched Oct 6, 4:40 PM · on time after backorder notice' }, foot: 'tracking' },
  { seller: 'casaverde', label: 'Package 3 of 3', sub: 'Package 3 of 3 · Seller ships · Sacramento, CA · items $119.00', status: 'Delayed', items: ['duvet'], carrier: 'No shipment yet', trackingNote: 'No tracking number', eta: 'Was due Sep 22 · now Oct 12', deadline: { tone: 'danger', text: 'Dispatch deadline Sep 22 · overdue 16 days' }, foot: 'unshipped' },
];

export const ORDER_META = {
  ref: 'MK-260914-48213',
  placed: 'Sep 14, 2026, 7:42 PM PT',
  status: 'Partly delivered',
  payment: 'Captured',
  card: 'Visa •••• 4417',
  authorized: 'Sep 14, 7:42 PM',
  captured: 'Sep 14, 7:42 PM',
  processorRef: 'ch_3PqK8e2L0dX41',
  subtotal: 533.98,
  coupon: 'WELCOME20',
  discount: 20,
  total: 513.98,
  caseRef: 'CS-261007-0412',
  financeApprover: 'Finance Manager · Priya Nair',
  financeLimit: 2000,
};

export interface FundingRow {
  seller: SellerId;
  kind: string;
  items: number;
  platform: number;
  sellerFunded: number;
  paid: number;
  /** null = Official Store (no fee, company sales). */
  fee: number | null;
  earnings: number | null;
}

export const FUNDING: FundingRow[] = [
  { seller: 'official', kind: 'Official Store', items: 225, platform: 8.43, sellerFunded: 0, paid: 216.57, fee: null, earnings: null },
  { seller: 'pixelport', kind: 'Marketplace seller', items: 189.98, platform: 7.11, sellerFunded: 0, paid: 182.87, fee: 19, earnings: 170.98 },
  { seller: 'casaverde', kind: 'Marketplace seller', items: 119, platform: 4.46, sellerFunded: 0, paid: 114.54, fee: 11.9, earnings: 107.1 },
];

/** Example marketplace fee (design copy: 10% of item price after seller-funded discounts). */
export const FEE_RATE = 0.1;

export const HISTORY: TimelineEvent[] = [
  { t: 'Overdue dispatch escalated to Casa Verde Home', d: 'Oct 8, 9:02 AM · Grace Kim, Seller Manager', state: 'warn', body: 'Reason: 16 days past dispatch deadline. Seller reports a supplier delay and promises dispatch by Oct 12. Customer updated.' },
  { t: 'Support case CS-261007-0412 opened', d: 'Oct 7, 4:18 PM · Isabel Cruz, Customer Support', state: 'current', body: 'Reason: customer asked when the duvet cover will ship and whether they can cancel it.' },
  { t: 'Return RT-261006-0193 requested for Pour-over Coffee Set', d: 'Oct 6, 11:20 AM · Customer', state: '', body: 'Reason given: arrived chipped. 3 photos attached.' },
  { t: 'Package 2 dispatched by Pixel & Port', d: 'Oct 6, 4:40 PM · Seller', state: 'done', body: 'USPS Priority, 9405 5112 9830 1847 2290 31.' },
  { t: 'Overdue task created for Package 3', d: 'Sep 23, 8:00 AM · System', state: 'warn', body: 'Seller reminded. Customer notified with new estimate and a link to contact support.' },
  { t: 'Package 1 delivered', d: 'Sep 17, 2:41 PM · UPS', state: 'done' },
  { t: 'Package 1 dispatched', d: 'Sep 15, 10:12 AM · Ana Silva, Warehouse', state: 'done' },
  { t: 'Payment captured and order accepted', d: 'Sep 14, 7:42 PM · System', state: 'done', body: '$513.98 on Visa •••• 4417. Purchase snapshots saved for 4 items.' },
];

export interface InternalNote {
  who: string;
  when: string;
  text: string;
}

export const NOTES: InternalNote[] = [
  { who: 'Grace Kim', when: 'Oct 8, 9:05 AM', text: 'Casa Verde confirmed restock arrives Oct 10. If the duvet is not shipped by Oct 12, cancel it and refund in full.' },
  { who: 'Lena Park', when: 'Oct 6, 2:30 PM', text: 'Chip clearly visible in photos. Low value and fragile. Recommend refund without return.' },
];

export const REFUND_REASONS = ['Choose a reason', 'Damaged on arrival, refund without return', 'Seller cannot fulfil', 'Late delivery', 'Goodwill'];
export const REFUND_DESTINATIONS = ['Original payment · Visa •••• 4417', 'Store credit'];
export const REFUND_NOTE_SAMPLE =
  'Pour-over: chip visible in 3 customer photos, return shipping costs more than the item (Lena Park recommendation). Duvet: 16 days overdue, customer asked to cancel in CS-261007-0412.';
