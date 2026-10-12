import type { IconName } from '@marketly/web-shared/ui';

// Design: pages/admin/admin-notifications.html and admin-notifications--edit-template.html.

export type Audience = 'Customer' | 'Seller' | 'Staff';

export interface NoticeEvent {
  id: string;
  audience: Audience;
  name: string;
  /** Screen the notice links to. */
  opens: string;
  email: boolean;
}

export interface NoticeGroup {
  audience: Audience;
  title: string;
  icon: IconName;
  sub: string;
}

export const GROUPS: NoticeGroup[] = [
  { audience: 'Customer', title: 'Customer notices', icon: 'user-round', sub: 'Order accepted through case replies' },
  { audience: 'Seller', title: 'Seller notices', icon: 'store', sub: 'Application through payout results' },
  { audience: 'Staff', title: 'Staff notices', icon: 'user-cog', sub: 'Sent to the queue lead and backup' },
];

const ev = (audience: Audience, id: string, name: string, opens: string, email = true): NoticeEvent => ({ id: `${audience[0].toLowerCase()}-${id}`, audience, name, opens, email });

export const EVENTS: NoticeEvent[] = [
  ev('Customer', 'accepted', 'Order accepted', 'Order details'),
  ev('Customer', 'payment', 'Payment result', 'Order details'),
  ev('Customer', 'dispatched', 'Dispatched, with tracking', 'Tracking'),
  ev('Customer', 'delay', 'Delay', 'Order details'),
  ev('Customer', 'delivered', 'Delivered', 'Order details'),
  ev('Customer', 'cancellation', 'Cancellation', 'Order details'),
  ev('Customer', 'return', 'Return update', 'Return'),
  ev('Customer', 'refund', 'Refund update', 'Refund progress'),
  ev('Customer', 'case', 'Case reply', 'Case'),
  ev('Seller', 'application', 'Application result', 'Application status'),
  ev('Seller', 'corrections', 'Requested corrections', 'Product or application'),
  ev('Seller', 'order', 'New order', 'Seller order'),
  ev('Seller', 'deadline', 'Dispatch deadline, 4 h before', 'Seller order'),
  ev('Seller', 'return', 'Return request', 'Seller return'),
  ev('Seller', 'case', 'Case opened or reply', 'Case'),
  ev('Seller', 'restriction', 'Restriction', 'Account health'),
  ev('Seller', 'payout', 'Payout result', 'Payout record'),
  ev('Staff', 'overdue', 'Overdue shipping', 'Dispatch queue'),
  ev('Staff', 'stock', 'Stock shortage', 'Stock'),
  ev('Staff', 'approval', 'Waiting approval', 'Approval'),
  ev('Staff', 'escalated', 'Escalated case', 'Case', false),
  ev('Staff', 'failed-payout', 'Failed payout', 'Payout record'),
  ev('Staff', 'unusual', 'Unusual financial activity', 'Finance checks'),
];

export interface PromoMessage {
  id: string;
  name: string;
  audience: 'Customer' | 'Seller';
  frequency: string;
  email: boolean;
  /** Not available yet (growth phase). */
  disabled?: boolean;
}

export const PROMOS: PromoMessage[] = [
  { id: 'p-deals', name: 'Deals and coupons newsletter', audience: 'Customer', frequency: 'Weekly', email: true },
  { id: 'p-alerts', name: 'Price drop and back-in-stock alerts', audience: 'Customer', frequency: 'Growth phase', email: false, disabled: true },
  { id: 'p-tips', name: 'Seller tips and campaigns', audience: 'Seller', frequency: 'Monthly', email: true },
];

/* ---------------- Templates ---------------- */

export const VARIABLES = [
  'customer.first_name', 'order.ref', 'seller.name', 'package.label', 'package.items',
  'carrier.name', 'tracking.number', 'tracking.url', 'delivery.estimate', 'order.url',
];

/** Sample values used by the preview. */
export const SAMPLE: Record<string, string> = {
  'customer.first_name': 'Jordan',
  'order.ref': 'MK-261008-12544',
  'seller.name': 'Pixel & Port',
  'package.label': 'Package 2 of 3',
  'package.items': 'Kestrel 1 TB Portable SSD, USB 3.2 (Qty 2)',
  'carrier.name': 'USPS Priority Mail',
  'tracking.number': '9405 5112 9830 1847 2290 31',
  'tracking.url': 'https://track.marketly.example/9405511298301847229031',
  'delivery.estimate': 'Fri, Oct 9 – Sat, Oct 10',
  'order.url': 'https://marketly.example/account/orders/MK-261008-12544',
};

/** In-app notices use compact values. */
export const SAMPLE_SHORT: Record<string, string> = { ...SAMPLE, 'carrier.name': 'USPS Priority', 'delivery.estimate': 'Oct 9–10' };

/** Values shown in a monospace span (references and tracking numbers). */
export const MONO_VARS = ['order.ref', 'tracking.number'];

export const SAMPLE_ITEM = { name: 'Kestrel 1 TB Portable SSD, USB 3.2', meta: 'Space gray · Qty 2 · Sold by Pixel & Port', icon: 'hard-drive' as IconName, tint: '6' };

export interface TemplateContent {
  subject: string;
  preheader: string;
  body: string;
  button: string;
  inappTitle: string;
  inappBody: string;
  inappLink: string;
}

export interface Version {
  n: number;
  who: string;
  when: string;
  note?: string;
  status: 'Draft' | 'Published' | '';
  content: TemplateContent;
}

export interface TemplateState {
  versions: Version[];
  essential: boolean;
  promo: boolean;
}

export const STAFF_TITLE: Record<string, string> = { 'Noor Aziz': 'Content Manager', 'Riley Chen': 'Platform Administrator' };
export const ME = 'Riley Chen';
export const TEST_EMAIL = 'riley.chen@marketly.example';

const DISPATCHED_V5: TemplateContent = {
  subject: 'Your package from {{seller.name}} is on the way',
  preheader: '{{package.label}} · arrives {{delivery.estimate}}',
  body: `Hi {{customer.first_name}},

{{seller.name}} shipped {{package.label}} of your order {{order.ref}}.

{{package.items}}

Carrier: {{carrier.name}}
Tracking: {{tracking.number}}
Estimated arrival: {{delivery.estimate}}

Other packages in this order ship separately. You can follow each one from your order page.`,
  button: 'Track package → {{tracking.url}}',
  inappTitle: '{{package.label}} shipped',
  inappBody: '{{seller.name}} · {{carrier.name}} · arrives {{delivery.estimate}}',
  inappLink: '{{tracking.url}}',
};
const DISPATCHED_V4: TemplateContent = { ...DISPATCHED_V5, body: DISPATCHED_V5.body.replace(/\n\nOther packages[^]*$/, '') };
const DISPATCHED_V3: TemplateContent = { ...DISPATCHED_V4, subject: 'Your order {{order.ref}} has shipped' };

export function initialTemplate(name: string, id: string, promo: boolean): TemplateState {
  if (id === 'c-dispatched') {
    return {
      essential: true,
      promo: false,
      versions: [
        { n: 5, who: 'Riley Chen', when: 'today 9:50 AM', note: 'added separate-package line', status: 'Draft', content: DISPATCHED_V5 },
        { n: 4, who: 'Noor Aziz', when: 'Sep 30', status: 'Published', content: DISPATCHED_V4 },
        { n: 3, who: 'Noor Aziz', when: 'Sep 12', status: '', content: DISPATCHED_V3 },
      ],
    };
  }
  const content: TemplateContent = promo
    ? {
        subject: `${name} from Marketly`,
        preheader: 'Picked for you this week',
        body: `Hi {{customer.first_name}},\n\nHere is what is new in ${name.toLowerCase()}.\n\nYou get this email because you opted in. You can change this in Account › Notifications.`,
        button: 'See what is new → {{order.url}}',
        inappTitle: name,
        inappBody: 'New this week',
        inappLink: '{{order.url}}',
      }
    : {
        subject: `${name}: {{order.ref}}`,
        preheader: '{{seller.name}} · {{order.ref}}',
        body: `Hi {{customer.first_name}},\n\n${name} for {{order.ref}}.\n\nOpen the details to see what changed and what happens next.`,
        button: 'View details → {{order.url}}',
        inappTitle: name,
        inappBody: '{{order.ref}} · {{seller.name}}',
        inappLink: '{{order.url}}',
      };
  return { essential: !promo, promo: false, versions: [{ n: 1, who: 'Noor Aziz', when: 'Sep 12', status: 'Published', content }] };
}
