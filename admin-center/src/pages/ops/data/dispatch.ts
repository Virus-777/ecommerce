import type { IconName } from '@marketly/web-shared/ui';

// Sample data for pages/ops/Dispatch.tsx (design: pages/ops/ops-dispatch*.html).

export type DispatchView = '' | 'seller-cannot-fulfill' | 'missing-tracking' | 'lost-or-damaged' | 'delivery-failed';
export type ActionKey = 'contact' | 'notify' | 'escalate' | 'cancel' | 'track' | 'claim';

export const ACTIONS: Record<ActionKey, { label: string; icon: IconName }> = {
  contact: { label: 'Contact customer', icon: 'message-square' },
  notify: { label: 'Notify seller', icon: 'bell' },
  escalate: { label: 'Escalate to Seller Manager', icon: 'arrow-up-right' },
  cancel: { label: 'Cancel item and refund', icon: 'circle-x' },
  track: { label: 'Request tracking', icon: 'scan-line' },
  claim: { label: 'Open carrier claim', icon: 'file-plus' },
};

export interface ExceptionRow {
  order: string;
  seller: string;
  official?: boolean;
  item: string;
  /** Date the customer was notified, or the state when they were not. */
  notified: string | 'no' | 'not-yet' | 'not-needed';
  response: string;
  owner: string;
  deadline: { tone: 'ok' | 'warning' | 'danger'; text: string };
  edge: 'flagged' | 'warn' | '';
  /** Actions in order; the first is the row button, the rest sit under "More actions". */
  actions: ActionKey[];
  /** Refund amount for "Cancel item and refund". */
  refund?: number;
  carrier?: string;
}

export interface DispatchTab {
  view: DispatchView;
  label: string;
  icon: IconName;
  /** Open items not shown on this page (the list shows the first page). */
  hidden: number;
  hot?: boolean;
  response: string;
}

export const TABS: DispatchTab[] = [
  { view: 'seller-cannot-fulfill', label: 'Seller cannot fulfill', icon: 'package-x', hidden: 0, response: 'Flag the affected items, notify the customer and apply the cancellation and refund policy.' },
  { view: '', label: 'Late dispatch', icon: 'alarm-clock', hidden: 4, hot: true, response: 'Create an overdue task, notify the seller and offer customer support escalation.' },
  { view: 'missing-tracking', label: 'Missing tracking', icon: 'scan-line', hidden: 0, response: 'Request valid details and avoid implying the package has been delivered.' },
  { view: 'lost-or-damaged', label: 'Lost or damaged', icon: 'package-minus', hidden: 0, hot: true, response: 'Open a case with the item, carrier information and agreed customer remedy.' },
  { view: 'delivery-failed', label: 'Delivery failed', icon: 'house', hidden: 0, response: 'Show next delivery, pickup or return steps and any applicable costs.' },
];

export const ROWS: Record<DispatchView, ExceptionRow[]> = {
  '': [
    { order: 'MK-260914-48213', seller: 'Casa Verde Home', item: 'Mosswood Washed Linen Duvet Cover, Queen', notified: 'Oct 5', response: 'Seller performance action', owner: 'Grace Kim', deadline: { tone: 'danger', text: 'Overdue 16 d' }, edge: 'flagged', actions: ['contact', 'cancel'], refund: 89 },
    { order: 'MK-261006-09977', seller: 'Gadget Grove', item: 'Brightline S2 Robot Vacuum', notified: 'Oct 8, 8:00 AM', response: 'Escalate, seller restricted', owner: 'Theo Grant', deadline: { tone: 'danger', text: 'Overdue 1 d' }, edge: 'flagged', actions: ['escalate', 'contact'] },
    { order: 'MK-261007-10388', seller: 'Pixel & Port', item: 'Kestrel K75 Wireless Keyboard', notified: 'no', response: 'Notify seller and customer', owner: 'Theo Grant', deadline: { tone: 'danger', text: 'Overdue 5 h' }, edge: 'flagged', actions: ['notify', 'contact'] },
    { order: 'MK-261007-10433', seller: 'Northwind Audio', item: 'Halden Pocket Bluetooth Speaker × 1', notified: 'no', response: 'Notify seller', owner: 'Theo Grant', deadline: { tone: 'danger', text: 'Overdue 3 h' }, edge: 'flagged', actions: ['notify', 'contact'] },
    { order: 'MK-261007-10120', seller: 'Marketly Official', official: true, item: 'Halden Aurora ANC Headphones, Silver', notified: 'not-yet', response: 'Allocate incoming stock, pack', owner: 'Ana Silva', deadline: { tone: 'warning', text: 'Due in 1 h' }, edge: 'warn', actions: ['contact'] },
  ],
  'seller-cannot-fulfill': [
    { order: 'MK-261007-10512', seller: 'Trailhead Outfitters', item: 'Corvo Swift Trail Running Shoes, size 10', notified: 'Oct 8, 8:12 AM', response: 'Cancel item, refund $112.00', owner: 'Theo Grant', deadline: { tone: 'warning', text: 'Refund by today 5:00 PM' }, edge: 'warn', actions: ['cancel', 'contact'], refund: 112 },
    { order: 'MK-261008-11204', seller: 'Pixel & Port', item: 'Kestrel 1 TB Portable SSD × 2 of 2', notified: 'no', response: 'Notify customer, offer other seller', owner: 'Theo Grant', deadline: { tone: 'danger', text: 'Notify by 12:00 PM' }, edge: 'flagged', actions: ['contact', 'cancel'], refund: 198 },
    { order: 'MK-261006-08870', seller: 'Casa Verde Home', item: 'Mosswood Linen Duvet Cover, King', notified: 'Oct 7', response: 'Cancel item, refund $149.00', owner: 'Isabel Cruz', deadline: { tone: 'ok', text: 'Refund sent, confirm' }, edge: '', actions: ['contact'] },
  ],
  'missing-tracking': [
    { order: 'MK-261005-07711', seller: 'Trailhead Outfitters', item: 'Trailhead Ridge 40 L Backpack · USPS number not recognized', notified: 'Oct 7', response: 'Request valid tracking', owner: 'Theo Grant', deadline: { tone: 'danger', text: 'Overdue 3 d' }, edge: 'flagged', actions: ['track', 'escalate'] },
    { order: 'MK-261006-08345', seller: 'Northwind Audio', item: 'Halden Aurora ANC Headphones · marked shipped, no number', notified: 'no', response: 'Request tracking number', owner: 'Theo Grant', deadline: { tone: 'warning', text: 'Details due 2:00 PM' }, edge: 'warn', actions: ['track', 'notify'] },
    { order: 'MK-261007-09530', seller: 'Gadget Grove', item: 'Brightline S2 Robot Vacuum · label created, no scan 36 h', notified: 'no', response: 'Confirm handover to carrier', owner: 'Theo Grant', deadline: { tone: 'warning', text: 'Due 4:00 PM' }, edge: 'warn', actions: ['track', 'escalate'] },
    { order: 'MK-261007-09102', seller: 'Marketly Official', official: true, item: 'Pellar Cast Iron Skillet · label voided and reprinted', notified: 'not-needed', response: 'Attach new tracking', owner: 'Ana Silva', deadline: { tone: 'ok', text: 'Due 12:00 PM' }, edge: '', actions: [] },
  ],
  'lost-or-damaged': [
    { order: 'MK-260929-30126', seller: 'Pixel & Port', item: 'Kestrel 27" 4K Monitor · USPS no scan for 9 days', notified: 'Oct 6', response: 'Remedy: refund $329.00 (Finance)', owner: 'Theo Grant', deadline: { tone: 'warning', text: 'Decide by Oct 9' }, edge: 'warn', actions: ['claim', 'contact'], carrier: 'USPS', refund: 329 },
    { order: 'MK-261001-33019', seller: 'Marketly Official', official: true, item: 'Pellar Cast Iron Skillet × 2 · UPS damaged in transit', notified: 'Oct 6', response: 'Replacement shipped, claim open', owner: 'Theo Grant', deadline: { tone: 'ok', text: 'Claim reply Oct 13' }, edge: '', actions: ['contact'] },
    { order: 'MK-261003-35501', seller: 'Trailhead Outfitters', item: 'Tidewell Insulated Bottle · dented on arrival', notified: 'Oct 7', response: 'Seller sends replacement', owner: 'Isabel Cruz', deadline: { tone: 'warning', text: 'Seller reply by 3:00 PM' }, edge: 'warn', actions: ['notify', 'claim'], carrier: 'UPS', refund: 34 },
  ],
  'delivery-failed': [
    { order: 'MK-261004-36620', seller: 'Marketly Official', official: true, item: 'Brightline Smart LED Desk Lamp · UPS: address not found', notified: 'Oct 8, 7:30 AM', response: 'Pickup at UPS Access Point by Oct 14, no cost', owner: 'Theo Grant', deadline: { tone: 'ok', text: 'Customer reply by Oct 10' }, edge: '', actions: ['contact'] },
    { order: 'MK-261002-34018', seller: 'Casa Verde Home', item: 'Mosswood Linen Duvet Cover · returning after 3 attempts', notified: 'no', response: 'Offer reship for $8.99 or refund', owner: 'Theo Grant', deadline: { tone: 'danger', text: 'Notify by 1:00 PM' }, edge: 'flagged', actions: ['contact', 'notify'] },
  ],
};

export interface Claim {
  id: string;
  carrier: string;
  order: string;
  amount: number;
  filed: string;
  status: string;
  owner: string;
}

export const CLAIMS: Claim[] = [
  { id: 'UPS-CLM-88412', carrier: 'UPS', order: 'MK-261001-33019', amount: 116, filed: 'Oct 6', status: 'Under review', owner: 'Theo Grant' },
  { id: 'USPS-CLM-4410', carrier: 'USPS', order: 'MK-260929-30126', amount: 329, filed: 'Oct 7', status: 'Submitted', owner: 'Pixel & Port (seller files)' },
  { id: 'FDX-CLM-20931', carrier: 'FedEx', order: 'MK-260925-27760', amount: 289, filed: 'Sep 28', status: 'Paid', owner: 'Theo Grant' },
  { id: 'UPS-CLM-87960', carrier: 'UPS', order: 'MK-260919-21455', amount: 58, filed: 'Sep 22', status: 'Rejected', owner: 'Theo Grant' },
];

export const OWNERS = ['All owners', 'Theo Grant', 'Ana Silva', 'Isabel Cruz', 'Grace Kim'];
export const SELLER_FILTERS = ['All sellers', 'Official Store', 'Marketplace sellers'];
export const CARRIERS = ['UPS', 'USPS', 'FedEx'];
