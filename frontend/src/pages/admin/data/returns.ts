// Sample rows for the admin returns and refunds queue (design: pages/admin/admin-returns.html and
// admin-returns--exception-review.html). Replaced by the returns API later.
import type { SellerId, Tint } from '@/data/fixtures';
import type { IconName, Tone } from '@/ui';

export type ReturnEdge = 'flagged' | 'warn' | '';
export type Due = 'overdue' | 'today' | 'soon' | '';

export interface ReturnFlag {
  label: string;
  tone: Tone;
  icon: IconName;
  note?: string;
}

export interface ReturnRow {
  ref: string;
  order: string;
  seller: SellerId;
  /** Short item name (table) and full name (drawer). */
  item: string;
  itemFull: string;
  variant: string;
  icon: IconName;
  tint: Tint;
  customer: string;
  reason: string;
  amount: number;
  /** Coupon share already deducted from the amount. */
  couponShare?: number;
  owner: string;
  deadline: { tone: 'ok' | 'warning' | 'danger'; text: string };
  due: Due;
  status: string;
  /** Refund status; 'Not started' renders as muted text. */
  refund: string;
  flag?: ReturnFlag;
  edge: ReturnEdge;
  delivered?: string;
  window?: string;
  photos?: number;
  quote?: string;
  /** Prefilled exception details (the proposal already written by the owner). */
  details?: string;
  proposed?: string;
}

export const RETURNS: ReturnRow[] = [
  {
    ref: 'RT-261006-0193', order: 'MK-260914-48213', seller: 'official', item: 'Pour-over Coffee Set', itemFull: 'Mosswood Ceramic Pour-over Coffee Set', variant: 'Cream', icon: 'coffee', tint: '3',
    customer: 'Jordan Lee', reason: 'Damaged on arrival', amount: 34.65, couponShare: 1.35, owner: 'Lena Park', deadline: { tone: 'warning', text: 'Decide by Oct 9' }, due: 'soon',
    status: 'Return requested', refund: 'Under review', edge: 'warn',
    flag: { label: 'Refund without return proposed', tone: 'warning', icon: 'file-warning', note: 'Proposed by Lena Park: fragile item, chip visible in 3 photos, return label costs more than the item.' },
    delivered: 'Sep 17, 2026', window: 'Open until Oct 17 (30 days)', photos: 3, quote: 'The carafe arrived with a chip on the spout. Box looked fine from outside.',
    details: 'Fragile ceramic item. Chip visible in 3 photos. Prepaid return label would cost $9.80; resale value after return is $0.', proposed: 'Oct 6, 2:30 PM',
  },
  {
    ref: 'RT-261005-0187', order: 'MK-261001-04410', seller: 'northwind', item: 'Halden Pocket Speaker', itemFull: 'Halden Pocket Bluetooth Speaker', variant: 'Slate', icon: 'speaker', tint: '2',
    customer: 'Chris Diaz', reason: 'Changed mind', amount: 59, owner: 'Northwind Audio', deadline: { tone: 'danger', text: 'Seller reply overdue 1 d' }, due: 'overdue',
    status: 'Return requested', refund: 'Not started', edge: 'flagged', flag: { label: 'Seller missed deadline', tone: 'danger', icon: 'circle-alert' },
    delivered: 'Oct 3, 2026', window: 'Open until Nov 2 (30 days)',
  },
  {
    ref: 'RT-261004-0179', order: 'MK-260928-02215', seller: 'pixelport', item: 'Kestrel 1 TB Portable SSD', itemFull: 'Kestrel 1 TB Portable SSD, USB 3.2', variant: 'Space gray', icon: 'hard-drive', tint: '6',
    customer: 'Maya Singh', reason: 'Not as described', amount: 94.99, owner: 'Pixel & Port', deadline: { tone: 'ok', text: 'Arrives Oct 12' }, due: '',
    status: 'Return in transit', refund: 'Not started', edge: '', delivered: 'Oct 1, 2026', window: 'Open until Oct 31 (30 days)',
  },
  {
    ref: 'RT-261003-0172', order: 'MK-260925-01987', seller: 'official', item: 'Halden Aurora ANC Headphones', itemFull: 'Halden Aurora ANC Wireless Headphones', variant: 'Midnight black', icon: 'headphones', tint: '2',
    customer: 'Ben Carter', reason: 'Defective', amount: 189, owner: 'Lena Park', deadline: { tone: 'warning', text: 'Inspect by Oct 9' }, due: 'soon',
    status: 'Inspecting', refund: 'Requested', edge: '', delivered: 'Sep 28, 2026', window: 'Open until Oct 28 (30 days)',
  },
  {
    ref: 'RT-261001-0158', order: 'MK-260919-00541', seller: 'gadgetgrove', item: 'Brightline S2 Robot Vacuum', itemFull: 'Brightline S2 Robot Vacuum', variant: 'White', icon: 'bot', tint: '3',
    customer: 'Lucy Hart', reason: 'Defective', amount: 279, owner: 'Lena Park', deadline: { tone: 'ok', text: 'Label used by Oct 10' }, due: 'soon',
    status: 'Return approved', refund: 'Not started', edge: '', flag: { label: 'Platform took over', tone: 'info', icon: 'shield' }, delivered: 'Sep 23, 2026', window: 'Open until Oct 23 (30 days)',
  },
  {
    ref: 'RT-260929-0144', order: 'MK-260917-00291', seller: 'official', item: 'Aster Vitamin C Serum', itemFull: 'Aster Vitamin C Brightening Serum, 30 ml', variant: '30 ml', icon: 'droplet', tint: '4',
    customer: 'Omar Haddad', reason: 'Changed mind', amount: 24, owner: 'Lena Park', deadline: { tone: 'warning', text: 'Due back Oct 8' }, due: 'today',
    status: 'Return in transit', refund: 'Not started', edge: '', delivered: 'Sep 20, 2026', window: 'Closed Oct 20 (30 days)',
  },
  {
    ref: 'RT-260928-0139', order: 'MK-260916-00188', seller: 'pixelport', item: 'Kestrel K75 Keyboard', itemFull: 'Kestrel K75 Mechanical Keyboard', variant: 'Graphite', icon: 'keyboard', tint: '6',
    customer: 'Nina Park', reason: 'Wrong item sent', amount: 109, owner: 'Priya Nair', deadline: { tone: 'danger', text: 'Retry by Oct 9' }, due: 'soon',
    status: 'Completed', refund: 'Failed', edge: 'flagged', flag: { label: 'Card closed: refund failed', tone: 'danger', icon: 'circle-alert' }, delivered: 'Sep 19, 2026', window: 'Return received Oct 2',
  },
  {
    ref: 'RT-260930-0151', order: 'MK-260918-00377', seller: 'casaverde', item: 'Mosswood Linen Napkins, set of 4', itemFull: 'Mosswood Linen Napkins, set of 4', variant: 'Natural', icon: 'package', tint: '1',
    customer: 'Jake Ellis', reason: 'Missing parts', amount: 48, owner: 'Lena Park', deadline: { tone: 'ok', text: 'Closed Sep 30' }, due: '',
    status: 'Completed', refund: 'Sent', edge: '',
    flag: { label: 'Refund without return approved', tone: 'info', icon: 'file-check', note: 'Approved by Priya Nair, Sep 30: return shipping cost more than the item; seller agreed to the deduction.' },
  },
  {
    ref: 'RT-261002-0166', order: 'MK-260920-00812', seller: 'trailhead', item: 'Corvo Swift Trail Running Shoes', itemFull: 'Corvo Swift Trail Running Shoes', variant: 'Size 9 · Ember', icon: 'footprints', tint: '5',
    customer: 'Sofia Rossi', reason: 'Wrong size', amount: 112, owner: 'Trailhead Outfitters', deadline: { tone: 'ok', text: 'Closed Oct 6' }, due: '',
    status: 'Completed', refund: 'Sent', edge: '',
  },
];

export type ReturnTab = 'all' | 'decision' | 'transit' | 'inspecting' | 'refund' | 'exceptions' | 'closed';

/** Tab counts are queue totals across all pages (design copy). */
export const RETURN_TABS: Array<{ value: ReturnTab; label: string; count?: number }> = [
  { value: 'all', label: 'All open', count: 14 },
  { value: 'decision', label: 'Needs decision', count: 4 },
  { value: 'transit', label: 'In transit', count: 3 },
  { value: 'inspecting', label: 'Inspecting', count: 5 },
  { value: 'refund', label: 'Refund pending', count: 9 },
  { value: 'exceptions', label: 'Exceptions', count: 2 },
  { value: 'closed', label: 'Closed' },
];

export const inTab = (r: ReturnRow, t: ReturnTab) => {
  switch (t) {
    case 'decision': return r.status === 'Return requested';
    case 'transit': return r.status === 'Return in transit';
    case 'inspecting': return r.status === 'Inspecting';
    case 'refund': return ['Requested', 'Under review', 'Approved', 'Processing', 'Failed'].includes(r.refund);
    case 'exceptions': return !!r.flag?.label.startsWith('Refund without return');
    case 'closed': return r.status === 'Completed' && r.refund === 'Sent';
    default: return true;
  }
};

export interface ReturnFilters {
  type: string;
  seller: string;
  reason: string;
  owner: string;
  refund: string;
  deadline: string;
}

export const RETURN_FILTERS: Array<{ key: keyof ReturnFilters; id: string; label: string; options: string[] }> = [
  { key: 'type', id: 'aa-rt-type', label: 'Seller type', options: ['All sellers', 'Official Store', 'Marketplace sellers'] },
  { key: 'seller', id: 'aa-rt-seller', label: 'Seller', options: ['Any seller', 'Marketly Official', 'Northwind Audio', 'Pixel & Port', 'Casa Verde Home', 'Trailhead Outfitters', 'Gadget Grove'] },
  { key: 'reason', id: 'aa-rt-reason', label: 'Reason', options: ['Any reason', 'Damaged on arrival', 'Defective', 'Not as described', 'Wrong item sent', 'Changed mind', 'Missing parts'] },
  { key: 'owner', id: 'aa-rt-owner', label: 'Owner', options: ['Any owner', 'Lena Park', 'Priya Nair', 'Seller'] },
  { key: 'refund', id: 'aa-rt-refund', label: 'Refund status', options: ['Any', 'Requested', 'Under review', 'Approved', 'Processing', 'Sent', 'Failed'] },
  { key: 'deadline', id: 'aa-rt-dl', label: 'Deadline', options: ['Any time', 'Overdue', 'Due today', 'Next 3 days'] },
];

export const NO_RETURN_FILTERS: ReturnFilters = Object.fromEntries(RETURN_FILTERS.map((f) => [f.key, f.options[0]])) as unknown as ReturnFilters;

export const DUE_BY_FILTER: Record<string, Due> = { Overdue: 'overdue', 'Due today': 'today', 'Next 3 days': 'soon' };

export const STAFF_TITLE: Record<string, string> = { 'Lena Park': 'Lena Park, Returns Manager', 'Priya Nair': 'Priya Nair, Finance Manager' };

export const EXCEPTION_REASONS = ['Return shipping costs more than the item', 'Hazardous or unsafe to ship back', 'Item damaged beyond resale, photo evidence', 'Customer goodwill'];

export const KPIS: Array<{ k: string; v: string; d: string; danger?: boolean }> = [
  { k: 'Open returns', v: '14', d: '6 company · 8 sellers' },
  { k: 'Past deadline', v: '3', d: '2 seller replies overdue', danger: true },
  { k: 'Awaiting inspection', v: '5', d: 'Reno warehouse' },
  { k: 'Refunds pending', v: '$1,284.62', d: '9 refunds · not yet sent' },
  { k: 'Exceptions', v: '2', d: 'Refund without return' },
];
