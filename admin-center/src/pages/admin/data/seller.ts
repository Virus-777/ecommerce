// Sample data for the admin Seller detail screen (design: pages/admin/admin-seller.html).
// Shapes follow what the seller-account API will return.

export type ObKind = 'orders' | 'returns' | 'cases';
export type DeadlineTone = 'ok' | 'warning' | 'danger';

export interface Metric {
  label: string;
  value: string;
  target: string;
  /** Meter fill, 0–100. */
  pct: number;
  tone: 'success' | 'warning' | 'danger';
  /** Detail under the meter (not shown when within target). */
  detail?: string;
}

export interface Obligation {
  ref: string;
  item: string;
  status: string;
  deadline: { tone: DeadlineTone; text: string };
  /** Overdue or past target: red row edge and a Remind action. */
  urgent?: boolean;
}

export interface Appeal {
  ref: string;
  submitted: string;
  argument: string;
  owner: string;
  status: string;
  /** Deadline chip while open, or the outcome once decided. */
  due?: string;
  outcome?: string;
}

export interface HistoryEvent {
  t: string;
  d: string;
  state: 'done' | 'current' | 'warn' | 'danger';
  body?: string;
}

export const SELLER_PROFILE = {
  slug: 'gadget-grove',
  since: 'Mar 2026',
  owner: 'Raj Mehta',
  manager: 'Grace Kim',
  legalName: 'Gadget Grove Trading LLC',
  contact: 'raj@gadgetgrove.example · (602) 555-0139',
  offers: 31,
};

export const RESTRICTION: Array<[string, string]> = [
  ['Reason', 'On-time dispatch below 85% for 30 days, and 2 refurbished items described as "like new" with missing parts.'],
  ['Affected activity', 'Refurbished offers (6) removed from sale. No new listings or product submissions. Weekly payouts held 14 days after delivery.'],
  ['Not affected', 'New-condition offers (25) stay on sale. Open orders, returns, cases and messages work as normal.'],
  ['To resolve', 'Reach 92% on-time dispatch for 21 days and add condition photos to every refurbished offer.'],
  ['Appeal route', 'Seller Center › Account health › Appeal, by Oct 16. Decided by Grace Kim; a second appeal goes to Morgan Hale.'],
  ['Set by', 'Grace Kim, Seller Manager · recommended by Sven Larsen, Trust and Risk'],
];

export const METRICS: Metric[] = [
  { label: 'On-time dispatch', value: '81.5%', target: 'Target ≥ 95%', pct: 81.5, tone: 'danger', detail: '34 late of 186' },
  { label: 'Cancellation rate', value: '4.8%', target: 'Target ≤ 2%', pct: 48, tone: 'danger', detail: '9 cancelled by seller' },
  { label: 'Valid tracking', value: '96.2%', target: 'Target ≥ 98%', pct: 96.2, tone: 'warning', detail: '7 without carrier scan' },
  { label: 'Return rate', value: '6.1%', target: 'Target ≤ 8%', pct: 61, tone: 'success' },
  { label: 'Response time', value: '31 h', target: 'Target ≤ 24 h', pct: 77, tone: 'warning', detail: 'Median first reply' },
  { label: 'Unresolved cases', value: '4', target: 'Target 0 over 3 days', pct: 60, tone: 'warning', detail: '2 older than 3 days' },
];

export const OBLIGATIONS: Record<ObKind, { tab: string; col: string; count: number; rows: Obligation[] }> = {
  orders: {
    tab: 'Orders',
    col: 'Order',
    count: 7,
    rows: [
      { ref: 'MK-261006-09977', item: 'Brightline S2 Robot Vacuum', status: 'Overdue', deadline: { tone: 'danger', text: 'Overdue 1 d' }, urgent: true },
      { ref: 'MK-261006-09311', item: 'Brightline S2 Robot Vacuum', status: 'Overdue', deadline: { tone: 'danger', text: 'Overdue 1 d' }, urgent: true },
      { ref: 'MK-261007-10291', item: 'Halden Aurora ANC (Refurbished)', status: 'Preparing', deadline: { tone: 'warning', text: 'Due Oct 9' } },
      { ref: 'MK-261008-11730', item: 'Kestrel K75 Keyboard', status: 'New', deadline: { tone: 'ok', text: 'Due Oct 10' } },
    ],
  },
  returns: {
    tab: 'Returns',
    col: 'Return',
    count: 2,
    rows: [
      { ref: 'RT-261001-0158', item: 'Halden Aurora ANC (Refurbished)', status: 'Inspecting', deadline: { tone: 'warning', text: 'Decide by Oct 10' } },
      { ref: 'RT-260927-0131', item: 'Kestrel K75 Keyboard', status: 'Return in transit', deadline: { tone: 'ok', text: 'Refund due Oct 14' } },
    ],
  },
  cases: {
    tab: 'Cases',
    col: 'Case',
    count: 4,
    rows: [
      { ref: 'CS-261004-0377', item: 'Halden Aurora ANC (Refurbished) · missing parts', status: 'Escalated', deadline: { tone: 'danger', text: 'Overdue 2 d' }, urgent: true },
      { ref: 'CS-261005-0390', item: 'Brightline S2 Robot Vacuum · not received', status: 'Waiting on seller', deadline: { tone: 'danger', text: 'Overdue 1 d' }, urgent: true },
      { ref: 'CS-261007-0401', item: 'Brightline S2 Robot Vacuum · late delivery', status: 'Open', deadline: { tone: 'warning', text: 'Reply by Oct 10' } },
      { ref: 'CS-261008-0415', item: 'Kestrel K75 Keyboard · wrong switch type', status: 'Open', deadline: { tone: 'ok', text: 'Reply by Oct 11' } },
    ],
  },
};

export const APPEALS: Appeal[] = [
  { ref: 'AP-261004-021', submitted: 'Oct 4', argument: 'Carrier missed 3 pickups in Phoenix in September. UPS pickup log attached.', owner: 'Grace Kim', status: 'Under review', due: 'Decide by Oct 11' },
  { ref: 'AP-260821-007', submitted: 'Aug 21', argument: 'Listing warning for "like new" condition wording.', owner: 'Grace Kim', status: 'Decision made', outcome: 'Warning kept · Aug 25' },
];

export const HISTORY: HistoryEvent[] = [
  { t: 'Appeal AP-261004-021 received', d: 'Oct 4, 2:10 PM · Raj Mehta, seller', state: 'current' },
  { t: 'Restriction applied', d: 'Oct 2, 9:30 AM · Grace Kim', state: 'warn', body: 'Reason: on-time dispatch 79.8% over 30 days; 2 condition misdescriptions. Review date Oct 30.' },
  { t: 'Payout hold set to 14 days after delivery', d: 'Oct 2, 9:31 AM · Priya Nair, Finance', state: 'warn', body: 'Reason: open cases may need refunds.' },
  { t: 'Performance warning sent', d: 'Sep 15 · Grace Kim', state: 'done' },
  { t: 'Approved to sell', d: 'Mar 18, 2026 · Grace Kim', state: 'done' },
];

export const ACCOUNT_KV: Array<[string, string]> = [
  ['Verification', 'Identity and business passed · Verified label not granted: business license renewal expired Sep 30'],
  ['Product approval', '31 approved · 0 waiting (submissions blocked)'],
  ['Payout readiness', 'Bank account verified · payouts on hold rule'],
  ['Legal name', 'Gadget Grove Trading LLC'],
  ['Contact', 'raj@gadgetgrove.example · (602) 555-0139'],
];

export const PAYOUTS = {
  pending: 1018.4,
  available: 732.15,
  held: 640,
  holdNote: 'Reason: covers possible refunds on 4 open cases. Review date Oct 30. Set by Priya Nair.',
  next: 'Fri, Oct 9',
  bank: 'Chase •••• 2208',
};

/** "What happens" rows in the suspend dialog. */
export const SUSPEND_EFFECTS: Array<[string, string]> = [
  ['Offers · 31', "Removed from sale now. Shared products stay live with other sellers' offers."],
  ['Open orders · 7', 'Choose below. Customers are told about any change to their items.'],
  ['Returns · 2', 'Stay open. Seller keeps access to respond. Lena Park takes over if a deadline is missed.'],
  ['Cases · 4', "Stay open with Isabel Cruz's team. Seller can still reply and upload evidence."],
  ['Payouts', 'Available $732.15 and pending $1,018.40 move to Held. Reason: cover refunds on open orders and cases. Review date Nov 7.'],
  ['Seller Center', 'Read and fulfil only. Seller sees the reason and how to appeal.'],
];

export const SUSPEND_ORDER_OPTIONS = [
  { id: 'aa-ss-o1', value: 'keep', title: 'Seller keeps fulfilling open orders', body: '5 orders are within their dispatch deadline' },
  { id: 'aa-ss-o2', value: 'cancel', title: 'Cancel unshipped orders and refund customers', body: '7 orders · $1,284.00 · Finance approval needed' },
] as const;

export const SUSPEND_REASONS = ['Repeated late dispatch after restriction', 'Counterfeit or unsafe products', 'Fraud or abuse', 'Failure to resolve cases'];
export const SECOND_REVIEWERS = ['Grace Kim · Seller Manager', 'Morgan Hale · Business Owner'];

export const SUSPEND_SAMPLE = {
  reason: 'Repeated late dispatch after restriction',
  date: 'Sat, Nov 7, 2026',
  details: 'On-time dispatch stayed at 81.5% during the restriction (target 95%), with 2 more overdue orders this week. New sales are suspended until the review on Nov 7.',
};
