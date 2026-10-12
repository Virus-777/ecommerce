import type { IconName } from '@marketly/web-shared/ui';

// Design: pages/admin/admin-settings.html and admin-settings--review-change.html.

export type SettingValue = string | boolean;

export interface FieldDef {
  label: string;
  kind: 'select' | 'text' | 'switch';
  options?: string[];
  prefix?: string;
  suffix?: string;
  icon?: IconName;
  hint?: string;
  /** How the value reads in the review dialog (old → new). */
  show?: (v: SettingValue) => string;
}

export const FIELDS: Record<string, FieldDef> = {
  // Market
  'se-region': { label: 'Service region', kind: 'select', options: ['United States, 48 contiguous states', 'United States, all states'], hint: 'Alaska, Hawaii and territories are planned for a later phase.' },
  'se-cur': { label: 'Currency', kind: 'select', options: ['USD (US dollar)'], hint: 'Fixed for launch. All prices, fees and payouts use USD.' },
  'se-tz': { label: 'Time zone', kind: 'select', options: ['Pacific Time (PT)', 'Mountain Time (MT)', 'Central Time (CT)', 'Eastern Time (ET)'], hint: 'Used for dispatch deadlines, reports and campaign schedules.' },
  'se-hours': { label: 'Business hours', kind: 'text', hint: 'Support response targets count only these hours.' },
  'se-hol': { label: 'Holidays with no dispatch', kind: 'text', hint: 'Arrival estimates skip these days and show a notice to customers.' },
  // Shipping defaults
  'se-disp': { label: 'Seller dispatch target', kind: 'select', options: ['1 business day', '2 business days', '3 business days'] },
  'se-cut': { label: 'Official Store order cutoff', kind: 'text', icon: 'clock', hint: 'Orders before cutoff ship the same business day.' },
  'se-free': { label: 'Free delivery threshold, Official Store', kind: 'text', prefix: '$' },
  'se-trk': { label: 'Flag missing tracking after', kind: 'text', suffix: 'hours after marked shipped' },
  // Returns baseline
  'se-rw': { label: 'Standard return window', kind: 'text', suffix: 'days after delivery', show: (v) => `${v}-day return window` },
  'se-rt': { label: 'Refund timing target', kind: 'text', suffix: 'business days after inspection' },
  // Fees
  'se-basis': { label: 'Commission basis', kind: 'select', options: ['Item price after seller-funded discounts, excluding shipping', 'Item price before discounts, excluding shipping', 'Item price and shipping'] },
  'se-pfd': { label: 'Platform-funded discounts', kind: 'select', options: ['Do not reduce the seller fee', 'Reduce the seller fee'] },
  // Payouts and holds
  'se-po': { label: 'Payout schedule', kind: 'select', options: ['Weekly, Friday', 'Twice weekly, Tuesday and Friday', 'Daily'] },
  'se-av': { label: 'Earnings become available', kind: 'text', suffix: 'days after delivery' },
  'se-min': { label: 'Minimum payout', kind: 'text', prefix: '$' },
  'se-new': { label: 'New seller hold', kind: 'text', suffix: 'days, first 30 days of selling' },
  // Advertising rules
  'se-af': { label: 'Opening ad frequency', kind: 'select', options: ['Once per session', 'Once per day', 'Once per campaign'] },
  'se-ov': { label: 'Overlays per page view', kind: 'select', options: ['1 at most', '2 at most'] },
  'se-noad': { label: 'Pages where ads never show', kind: 'text', hint: 'Ads must not cover purchase, tracking or return actions.' },
  'se-dismiss': { label: 'Dismissing an ad stops it for the rest of the session', kind: 'switch' },
  'se-paid': { label: 'Paid seller advertising', kind: 'switch' },
  // Checkout
  'se-guest': { label: 'Allow guest checkout', kind: 'switch' },
  'se-acc': { label: 'Offer to create an account after a guest purchase', kind: 'switch' },
};

export const INITIAL_VALUES: Record<string, SettingValue> = {
  'se-region': 'United States, 48 contiguous states',
  'se-cur': 'USD (US dollar)',
  'se-tz': 'Pacific Time (PT)',
  'se-hours': 'Mon–Sat, 8:00 AM – 8:00 PM PT',
  'se-hol': 'Nov 26 Thanksgiving · Dec 25 Christmas · Jan 1 New Year',
  'se-disp': '2 business days',
  'se-cut': '2:00 PM PT',
  'se-free': '35.00',
  'se-trk': '24',
  'se-rw': '30',
  'se-rt': '5',
  'se-basis': 'Item price after seller-funded discounts, excluding shipping',
  'se-pfd': 'Do not reduce the seller fee',
  'se-po': 'Weekly, Friday',
  'se-av': '7',
  'se-min': '25.00',
  'se-new': '14',
  'se-af': 'Once per session',
  'se-ov': '1 at most',
  'se-noad': 'Checkout · Payment result · Order tracking · Return request',
  'se-dismiss': true,
  'se-paid': false,
  'se-guest': true,
  'se-acc': true,
};

/** Old/new value as shown in the review dialog. */
export function showValue(id: string, v: SettingValue): string {
  const f = FIELDS[id];
  if (f.show) return f.show(v);
  if (typeof v === 'boolean') return v ? 'On' : 'Off';
  return `${f.prefix ?? ''}${v}${f.suffix ? ` ${f.suffix}` : ''}`;
}

export interface Impact {
  icon: IconName;
  strong?: string;
  text: string;
}

export interface SectionDef {
  nav: string;
  navIcon: IconName;
  title: string;
  sub: string;
  fields: string[];
  /** Changes need the Business Owner's approval before they are scheduled. */
  approval: boolean;
  changed: string;
  effective: string;
  /** Review dialog defaults. */
  nextEffective: string;
  effectiveHint: string;
  impacts: Impact[];
}

const SOON = 'Changes start at 12:00 AM PT on this date.';
const NOTICE = 'At least 14 days after saving, so sellers and Help content can update.';

export const SECTIONS: SectionDef[] = [
  {
    nav: 'Market', navIcon: 'globe', title: 'Market', sub: 'One service region and one currency at launch',
    fields: ['se-region', 'se-cur', 'se-tz', 'se-hours', 'se-hol'], approval: false,
    changed: 'Sep 14 by Riley Chen', effective: 'Sep 15, 2026', nextEffective: 'Oct 11, 2026', effectiveHint: SOON,
    impacts: [
      { icon: 'calendar', text: 'Dispatch deadlines, arrival estimates and reports use the new value from the effective date.' },
      { icon: 'package', strong: 'Open orders', text: 'keep the deadlines and arrival estimates shown at checkout.' },
    ],
  },
  {
    nav: 'Shipping defaults', navIcon: 'truck', title: 'Shipping defaults', sub: 'Sellers can be faster, not slower, than these targets',
    fields: ['se-disp', 'se-cut', 'se-free', 'se-trk'], approval: false,
    changed: 'Sep 30 by Theo Grant', effective: 'Oct 1, 2026', nextEffective: 'Oct 11, 2026', effectiveHint: SOON,
    impacts: [
      { icon: 'store', strong: 'All sellers', text: 'are notified today. Sellers already faster than the target keep their own.' },
      { icon: 'package', strong: 'Open orders', text: 'keep the dispatch deadline shown at checkout.' },
    ],
  },
  {
    nav: 'Returns baseline', navIcon: 'undo-2', title: 'Returns baseline', sub: 'Sellers can offer more generous terms, never less',
    fields: ['se-rw', 'se-rt'], approval: true,
    changed: 'Oct 7 by Riley Chen', effective: 'Sep 1, 2026 · next change Nov 1', nextEffective: 'Nov 1, 2026', effectiveHint: NOTICE,
    impacts: [
      { icon: 'package', strong: 'Open orders', text: 'keep the return window they were sold with. Their order pages and return requests do not change.' },
      { icon: 'store', strong: 'All sellers', text: 'are notified today. Sellers who already offer more keep their terms.' },
      { icon: 'file-text', strong: 'Help articles', text: 'and the Returns policy need an update by Noor Aziz, Content Manager, before the effective date.' },
    ],
  },
  {
    nav: 'Fees', navIcon: 'percent', title: 'Fees', sub: 'Commission rules by category',
    fields: ['se-basis', 'se-pfd'], approval: true,
    changed: 'Aug 28 by Riley Chen', effective: 'Sep 1, 2026', nextEffective: 'Nov 1, 2026', effectiveHint: NOTICE,
    impacts: [
      { icon: 'store', strong: 'All sellers', text: 'are notified today and the fee summary in the seller agreement is updated.' },
      { icon: 'receipt', text: 'Orders placed before the effective date keep the fee they were sold with.' },
    ],
  },
  {
    nav: 'Payouts and holds', navIcon: 'wallet', title: 'Payout schedule and hold rules', sub: 'Earnings move from Pending to Available, then to a payout',
    fields: ['se-po', 'se-av', 'se-min', 'se-new'], approval: true,
    changed: 'Sep 3 by Priya Nair (proposed), Morgan Hale (approved)', effective: 'Sep 4, 2026', nextEffective: 'Nov 1, 2026', effectiveHint: NOTICE,
    impacts: [
      { icon: 'wallet', strong: 'Payouts already scheduled', text: 'before the effective date do not change.' },
      { icon: 'store', strong: 'All sellers', text: 'are notified today and see the new schedule in Finance.' },
    ],
  },
  {
    nav: 'Advertising rules', navIcon: 'megaphone', title: 'Advertising rules', sub: 'Launch formats: opening full-screen ad, banners, optional pop-ups',
    fields: ['se-af', 'se-ov', 'se-noad', 'se-dismiss', 'se-paid'], approval: false,
    changed: 'Sep 22 by Jamie Brooks', effective: 'Sep 23, 2026', nextEffective: 'Oct 11, 2026', effectiveHint: SOON,
    impacts: [
      { icon: 'megaphone', strong: 'Live campaigns', text: 'follow the new rule from the effective date.' },
      { icon: 'shield-check', text: 'Ads still never cover purchase, tracking or return actions.' },
    ],
  },
  {
    nav: 'Checkout', navIcon: 'shopping-cart', title: 'Checkout', sub: 'Guest purchases and order identity',
    fields: ['se-guest', 'se-acc'], approval: false,
    changed: 'Aug 20 by Riley Chen', effective: 'Sep 1, 2026', nextEffective: 'Oct 11, 2026', effectiveHint: SOON,
    impacts: [{ icon: 'shopping-cart', text: 'Checkout shows the new option from the effective date. Orders already placed do not change.' }],
  },
];

export const SCOPES = ['Orders placed on or after the effective date', 'All orders not yet delivered'];

export interface ChangeItem {
  eyebrow: string;
  before: string;
  after: string;
}

export interface Change {
  section: number;
  items: ChangeItem[];
  /** Field ids and their new values (empty for the design's sample change). */
  values: Record<string, SettingValue>;
  effective: string;
  effectiveHint: string;
  scope: string;
  impacts: Impact[];
  reason: string;
  approval: boolean;
}

/** The change shown in the design's review-change view. */
export const DESIGN_CHANGE: Change = {
  section: 2,
  items: [{ eyebrow: 'Returns baseline · Electronics', before: '30-day return window', after: '15-day return window' }],
  values: {},
  effective: 'Nov 1, 2026',
  effectiveHint: NOTICE,
  scope: SCOPES[0],
  impacts: [
    { icon: 'package', strong: '1,284 open Electronics orders', text: 'keep their 30-day window. Their order pages and return requests do not change.' },
    { icon: 'store', strong: '23 sellers', text: 'with Electronics offers are notified today. 4 sellers already offer 30 days and keep it.' },
    { icon: 'file-text', strong: '3 Help articles', text: 'and the Returns policy need an update by Noor Aziz, Content Manager, before Nov 1.' },
    { icon: 'shopping-cart', text: 'Product pages and checkout show the new window from Nov 1, 12:00 AM PT.' },
  ],
  reason: 'Align Electronics with manufacturer return terms and reduce used-as-new resale.',
  approval: true,
};

export const CARRIERS = ['UPS Ground', 'UPS 2nd Day Air', 'USPS Priority Mail', 'USPS Ground Advantage', 'FedEx Home Delivery'];

export interface ReturnException {
  category: string;
  window: string;
  scheduled?: string;
  condition: string;
  shown: string;
}

export const RETURN_EXCEPTIONS: ReturnException[] = [
  { category: 'Electronics', window: '30 days', scheduled: '15 days from Nov 1', condition: 'Opened items accepted with all accessories', shown: 'Product page, checkout' },
  { category: 'Beauty', window: 'Unopened only', condition: 'Opened skincare not returnable for hygiene', shown: 'Product page, checkout' },
  { category: 'Fashion', window: '30 days', condition: 'Tags attached, unworn', shown: 'Product page' },
  { category: 'Mattresses and bedding', window: '30 days', condition: 'Sealed in original packaging', shown: 'Product page, checkout' },
];

export const RETURN_SHIPPING: Array<[string, string]> = [
  ['Damaged, incorrect or defective', 'Seller or Official Store pays'],
  ['Change of mind', 'Customer pays, unless the seller offers free returns'],
  ['Lost in transit to warehouse', 'Marketly support decides with carrier claim'],
];

export const COMMISSIONS: Array<{ category: string; rate: number }> = [
  { category: 'Electronics', rate: 8 },
  { category: 'Computers', rate: 7 },
  { category: 'Home & Kitchen', rate: 12 },
  { category: 'Fashion', rate: 15 },
  { category: 'Sports & Outdoors', rate: 12 },
  { category: 'Beauty', rate: 15 },
  { category: 'Toys & Games', rate: 12 },
  { category: 'Pet Supplies', rate: 12 },
];

export const PAYOUT_RULES: Array<{ icon: IconName; text: string }> = [
  { icon: 'lock', text: 'Every hold needs a reason and a review date, both shown to the seller.' },
  { icon: 'shield-check', text: 'Payout destination changes need verification and pause payouts for 72 hours.' },
  { icon: 'undo-2', text: 'Refunds after payout are deducted from later earnings. If none, the seller balance shows the amount owed.' },
];
