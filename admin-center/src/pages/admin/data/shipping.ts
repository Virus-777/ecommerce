// Sample data for the admin Shipping settings screen (design: pages/admin/admin-shipping.html).
import type { IconName } from '@marketly/web-shared/ui';

export interface CarrierMethod {
  name: string;
  eta: string;
  on: boolean;
}

export interface Carrier {
  name: string;
  account: string;
  onTime: string;
  methods: CarrierMethod[];
}

export interface Rate {
  method: string;
  sees: string;
  carriers: string;
  r1: number;
  r2: number;
  r3: number;
  /** null = never free. */
  free: string | null;
}

export interface Destination {
  icon: IconName;
  title: string;
  sub: string;
  badge?: 'Active' | 'Disabled';
}

export interface ServiceNotice {
  id: string;
  when: string;
  title: string;
  effect: string;
  status: 'Live' | 'Scheduled' | 'Draft';
  /** Sentence for the "service notice is live" banner. */
  banner?: string;
}

export interface FreeRule {
  title: string;
  sub: string;
  status: 'Active' | 'Scheduled';
}

export const CARRIERS: Carrier[] = [
  {
    name: 'UPS',
    account: '•••• 7Y2W',
    onTime: '96.1%',
    methods: [
      { name: 'Ground', eta: '1–5 business days', on: true },
      { name: '2nd Day Air', eta: '2 business days', on: true },
      { name: 'Next Day Air Saver', eta: '1 business day', on: false },
    ],
  },
  {
    name: 'USPS',
    account: '•••• 3301',
    onTime: '93.4%',
    methods: [
      { name: 'Ground Advantage', eta: '2–5 business days', on: true },
      { name: 'Priority Mail', eta: '1–3 business days', on: true },
      { name: 'Priority Mail Express', eta: '1–2 days', on: false },
    ],
  },
  {
    name: 'FedEx',
    account: '•••• 5820',
    onTime: '95.0%',
    methods: [
      { name: 'Home Delivery', eta: '1–5 business days', on: true },
      { name: 'Express Saver', eta: '3 business days', on: true },
      { name: '2Day', eta: '2 business days', on: true },
    ],
  },
];

export const RATES: Rate[] = [
  { method: 'Standard', sees: '3–6 business days', carriers: 'UPS Ground, USPS Ground Advantage, FedEx Home', r1: 5.99, r2: 7.99, r3: 12.99, free: 'Official Store order $35+' },
  { method: 'Expedited', sees: '2–3 business days', carriers: 'USPS Priority, FedEx Express Saver', r1: 12.99, r2: 16.99, r3: 24.99, free: null },
  { method: 'Express', sees: '1–2 business days', carriers: 'UPS 2nd Day Air, FedEx 2Day', r1: 24.99, r2: 29.99, r3: 44.99, free: null },
];

export const DESTINATIONS: Destination[] = [
  { icon: 'map', title: 'Contiguous US · 48 states and DC', sub: 'All methods · Official Store and sellers', badge: 'Active' },
  { icon: 'map-pin', title: 'Zone 1 · West (from Reno, NV)', sub: 'CA, NV, OR, WA, ID, UT, AZ · Standard 2–4 days' },
  { icon: 'map-pin', title: 'Zone 2 · Central', sub: 'Standard 3–5 days' },
  { icon: 'map-pin', title: 'Zone 3 · East', sub: 'Standard 4–6 days' },
  { icon: 'circle-slash', title: 'Alaska, Hawaii, US territories, APO/FPO', sub: 'Not served at launch. Customers see this before checkout.', badge: 'Disabled' },
];

export const OFFICIAL_DISPATCH: Array<[string, string]> = [
  ['Order cutoff', '2:00 PM PT, Mon–Fri'],
  ['Before cutoff', 'Ships same business day'],
  ['After cutoff', 'Ships next business day'],
];

export const SELLER_TARGETS: Array<[string, string]> = [
  ['Dispatch within', '2 business days (sellers can promise 1–3)'],
  ['Valid tracking', 'Within 24 hours of dispatch'],
  ['Reply to customers', 'Within 24 hours'],
  ['Performance target', '95% on time over 30 days'],
];

export const NOTICES: ServiceNotice[] = [
  {
    id: 'sn1',
    when: 'Oct 6–11',
    title: 'Wildfire road closures, Sacramento area',
    effect: 'UPS Ground +1–2 days',
    status: 'Live',
    banner: 'Wildfire road closures, Sacramento area: UPS Ground +1–2 business days, Oct 6–11. Shown on product pages, checkout and tracking.',
  },
  { id: 'sn2', when: 'Mon, Oct 12', title: 'Columbus Day · USPS closed', effect: 'No USPS pickup or delivery', status: 'Scheduled' },
  { id: 'sn3', when: 'Wed, Nov 11', title: 'Veterans Day · USPS closed', effect: 'No USPS pickup or delivery', status: 'Scheduled' },
  { id: 'sn4', when: 'Thu, Nov 26', title: 'Thanksgiving · warehouse and carriers closed', effect: 'No dispatch; estimates skip the day', status: 'Scheduled' },
  { id: 'sn5', when: 'Dec 17–21', title: 'Holiday cutoffs: Standard Dec 17, Expedited Dec 19, Express Dec 21', effect: 'Shown on product pages from Dec 1', status: 'Draft' },
];

export const FREE_RULES: FreeRule[] = [
  { title: 'Official Store orders $35 and over', sub: 'Standard method · company-funded · always on', status: 'Active' },
  { title: 'Seller free shipping', sub: 'Sellers choose per offer or above their own minimum · seller-funded', status: 'Active' },
  { title: 'Home Week free shipping', sub: 'All sellers, orders $25+ · platform-funded · Oct 12–19', status: 'Scheduled' },
];

/* ---------- Add service notice form ---------- */

export const NOTICE_TYPES = ['Service interruption', 'Holiday', 'Carrier delay', 'Warehouse closure'];

/** Carrier option -> [short label for the table/banner, service shown in the checkout preview]. */
export const NOTICE_CARRIERS: Record<string, [string, string]> = {
  'All carriers': ['All carriers', 'UPS Ground'],
  'UPS · all services': ['UPS', 'UPS Ground'],
  'UPS Ground only': ['UPS Ground', 'UPS Ground'],
  'USPS · all services': ['USPS', 'USPS Ground Advantage'],
  'FedEx · all services': ['FedEx', 'FedEx Home Delivery'],
};

/** Delay option -> [short effect, preview arrival line] (preview order would arrive Wed, Oct 14). */
export const NOTICE_DELAYS: Record<string, [string, string]> = {
  '+1 business day': ['+1 day', 'Arrives Thu, Oct 15'],
  '+1–2 business days': ['+1–2 days', 'Arrives Thu, Oct 15 – Fri, Oct 16'],
  '+3 business days': ['+3 days', 'Arrives Mon, Oct 19'],
  'Pause delivery to this area': ['delivery paused', 'Not available until the notice ends'],
};

export const NOTICE_AUDIENCE = ['Official Store and all sellers', 'Official Store only', 'Marketplace sellers only'];

export const NOTICE_PLACES = [
  { id: 'aa-sn-s1', label: 'Product page delivery estimate', short: 'product pages' },
  { id: 'aa-sn-s2', label: 'Checkout delivery options', short: 'checkout' },
  { id: 'aa-sn-s3', label: 'Order tracking for affected packages', short: 'tracking' },
];

export const NOTICE_SAMPLE = {
  title: 'Wildfire road closures, Sacramento area',
  type: 'Service interruption',
  carrier: 'UPS Ground only',
  area: 'ZIP codes 956xx, 957xx, 958xx',
  from: 'Tue, Oct 6, 2026',
  until: 'Sun, Oct 11, 2026',
  delay: '+1–2 business days',
  audience: 'Official Store and all sellers',
  message: 'UPS deliveries to the Sacramento area may take 1–2 extra business days because of road closures. Estimates below include the delay.',
};
