/**
 * The topic catalogue: every notice per audience, seeded into notifications.topics from this file
 * (staff switch channels; everything else follows the code). Pure data, no I/O.
 *
 * Keys are <audience>.<subject>.<event>. Groups are the inbox filters of each area; seller topics also
 * name the member preference group (who hears about what) and the seller permission a member needs.
 */
import type { Notice, TemplateContent, TemplateVariable, Topic } from '../../../spec/notifications.js';

export type Audience = Topic['audience'];
export type Category = Topic['category'];
export type Channel = 'in_app' | 'email' | 'sms' | 'push';
export type DeliveryChannel = 'email' | 'sms' | 'push';
export type Tone = Notice['tone'];
export type SenderFamily = 'orders' | 'account' | 'sellers' | 'promotions';

export const CHANNELS: readonly Channel[] = ['in_app', 'email', 'sms', 'push'];
/** Launch phase each channel arrives in (plan ch. 20) */
export const CHANNEL_PHASE: Record<Channel, number> = { in_app: 1, email: 1, sms: 2, push: 3 };

/** Seller member preference groups (MemberPreference.groups keys) */
export type SellerPrefGroup = 'new_orders' | 'dispatch_overdue' | 'returns_cases' | 'customer_messages' | 'payouts_holds' | 'products' | 'promotions' | 'account';

export interface SellerGroupDef {
  key: SellerPrefGroup;
  label: string;
  ownerOnly: boolean;
  /** Always on (and always emailed) for the owner */
  essentialForOwner: boolean;
  /** Seller permission a member needs to receive the group */
  permission: string | null;
  /** Default for members who never set preferences */
  defaultOn: boolean;
}

export const SELLER_GROUPS: readonly SellerGroupDef[] = [
  { key: 'new_orders', label: 'New orders and cancellations', ownerOnly: false, essentialForOwner: true, permission: 'orders.fulfillment.view', defaultOn: true },
  { key: 'dispatch_overdue', label: 'Dispatch deadlines and overdue orders', ownerOnly: false, essentialForOwner: true, permission: 'orders.fulfillment.view', defaultOn: true },
  { key: 'returns_cases', label: 'Returns, cases and disputes', ownerOnly: false, essentialForOwner: true, permission: null, defaultOn: true },
  { key: 'customer_messages', label: 'Customer messages', ownerOnly: false, essentialForOwner: false, permission: 'messaging.conversations.reply', defaultOn: true },
  { key: 'payouts_holds', label: 'Payouts, holds and statements', ownerOnly: true, essentialForOwner: true, permission: 'finance.balances.view', defaultOn: true },
  { key: 'products', label: 'Products, stock and corrections', ownerOnly: false, essentialForOwner: true, permission: null, defaultOn: true },
  { key: 'account', label: 'Account health, restrictions and verification', ownerOnly: true, essentialForOwner: true, permission: null, defaultOn: true },
  { key: 'promotions', label: 'Seller tips and campaigns', ownerOnly: false, essentialForOwner: false, permission: null, defaultOn: false },
];

export const sellerGroup = (key: string | null | undefined) => SELLER_GROUPS.find((g) => g.key === key);

/** Inbox filter groups per audience (Notice.group) */
export const INBOX_GROUPS: Record<Audience, readonly string[]> = {
  customer: ['orders', 'returns_refunds', 'cases', 'account', 'promotions'],
  seller: ['orders', 'returns_cases', 'products', 'account_finance'],
  staff: ['Shipping', 'Inventory', 'Approvals', 'Support', 'Returns', 'Finance', 'Sellers', 'Content', 'Trust', 'Advertising', 'Operations', 'Platform', 'Security', 'Reports'],
};

/** Staff role keys seeded by access, with display names */
export const ROLE_NAMES: Record<string, string> = {
  business_owner: 'Business Owner',
  platform_administrator: 'Platform Administrator',
  official_store_manager: 'Official Store Manager',
  purchasing_manager: 'Purchasing Manager',
  inventory_manager: 'Inventory Manager',
  warehouse_manager: 'Warehouse Manager',
  order_manager: 'Order Manager',
  shipping_manager: 'Shipping Manager',
  returns_manager: 'Returns Manager',
  catalog_manager: 'Catalog Manager',
  seller_manager: 'Seller Manager',
  customer_support_manager: 'Customer Support Manager',
  finance_manager: 'Finance Manager',
  marketing_manager: 'Marketing Manager',
  advertising_manager: 'Advertising Manager',
  content_manager: 'Content Manager',
  trust_and_risk_manager: 'Trust and Risk Manager',
  reports_analyst: 'Reports Analyst',
  warehouse_worker: 'Warehouse Worker',
  finance_staff: 'Finance Staff',
  support_agent: 'Support Agent',
};

export const roleName = (key: string) =>
  ROLE_NAMES[key] ?? key.split(/[_.-]/).filter(Boolean).map((w) => w[0]!.toUpperCase() + w.slice(1)).join(' ');

/* ------------------------------------------------------------------ variables */

/** Variables every template may use */
export const STANDARD_VARIABLES: Record<string, { desc: string; example: string }> = {
  'link.url': { desc: 'Link to the record the notice is about', example: 'https://marketly.example/account/orders/MK-261008-12544' },
  'link.ref': { desc: 'Reference of the record', example: 'MK-261008-12544' },
  'link.label': { desc: 'Button text', example: 'View order' },
  'recipient.name': { desc: "Recipient's first name", example: 'Jordan' },
};

/** Examples for topic variables (preview sample data) */
const VARIABLE_EXAMPLES: Record<string, string> = {
  'order.ref': 'MK-261008-12544',
  'order.total': '$189.00',
  'payment.amount': '$189.00',
  'item.count': '1',
  'refund.amount': '$49.00',
  'refund.destination': 'Visa •••• 4417',
  'refund.reason': 'The card was closed',
  'delay.dispatchBy': 'Oct 12',
  'delay.reason': 'Waiting for stock from the supplier',
  'cancellation.outcome': 'accepted',
  'package.items': 'Aurora Desk Lamp × 1',
  'delivery.estimate': 'Oct 11–13',
  'exception.kind': 'failed delivery',
  'exception.action': 'Choose a redelivery date',
  'due.date': 'Oct 9, 5:00 PM',
  'return.ref': 'RT-261002-0520',
  'return.reason': 'Arrived damaged',
  'return.outcome': 'Approved for refund',
  'case.ref': 'CS-261005-3381',
  'case.outcome': 'Refund to the original payment method',
  'code.value': '482913',
  'code.expires': '10 minutes',
  'reset.url': 'https://marketly.example/reset/…',
  'invite.url': 'https://marketly.example/invite/…',
  'invite.context': 'Casa Verde Home',
  'invite.by': 'Riley Chen',
  'device.label': 'Chrome on Windows',
  'device.location': 'Portland, OR',
  'email.old': 'j***@example.com',
  'email.new': 'jo***@example.com',
  'twostep.state': 'turned on',
  'lock.until': 'Oct 9, 10:30 AM',
  'export.expires': 'Oct 16',
  'product.title': 'Aurora Desk Lamp',
  'product.reason': 'Main image has a watermark',
  'stock.label': 'Aurora Desk Lamp, black',
  'stock.available': '3',
  'payout.ref': 'PO-261009-0418',
  'payout.amount': '$1,240.00',
  'payout.reason': 'The bank rejected the account number',
  'hold.amount': '$1,240.00',
  'hold.reason': 'Disputed order under review',
  'hold.reviewDate': 'Oct 20',
  'balance.amount': '-$35.00',
  'statement.period': 'Sep 1–30',
  'seller.name': 'Casa Verde Home',
  'restriction.reason': 'Late dispatch 11% over 30 days',
  'restriction.activities': 'new offers',
  'appeal.deadline': 'Oct 23',
  'appeal.outcome': 'overturned',
  'warning.title': 'Late dispatch above target',
  'change.kind': 'legal name',
  'change.outcome': 'approved',
  'verification.state': 'granted',
  'review.outcome': 'passed',
  'destination.label': 'Checking •••• 6610',
  'destination.reason': 'The name does not match the business',
  'campaign.name': 'Home Week',
  'campaign.status': 'live',
  'campaign.respondBy': 'Oct 15',
  'change.summary': 'Electronics return window becomes 15 days',
  'change.effective': 'Nov 1',
  'approval.summary': 'Release payout run PO-RUN-261009 ($48,210.00)',
  'approval.outcome': 'approved',
  'approval.comment': 'Attach the bank confirmation',
  'approval.by': 'Morgan Hale',
  'queue.item': 'MK-260914-48213',
  'queue.name': 'Overdue dispatch',
  'escalation.reason': 'Overdue for 48 hours',
  'report.type': 'counterfeit',
  'report.ref': 'TR-261007-004',
  'mismatch.check': 'Card deposits',
  'mismatch.difference': '$12.40',
  'chargeback.ref': 'CB-261006-0042',
  'chargeback.amount': '$89.00',
  'integrity.seq': '18342',
  'account.kind': 'staff',
  'digest.count': '7',
  'digest.lines': 'Overdue shipping MK-260914-48213…',
  'mention.by': 'Theo Grant',
  'mention.text': 'Can you check this payout?',
  'message.from': 'Casa Verde Home',
  'wishlist.product': 'Aurora Desk Lamp',
  'wishlist.price': '$159.00',
  'unsubscribe.url': 'https://marketly.example/unsubscribe/…',
  'guest.url': 'https://marketly.example/orders/link/…',
};

/* ------------------------------------------------------------------ topics */

export interface DefaultTemplate {
  title: string;
  body: string;
  subject?: string;
  button?: string;
}

export interface TopicDef {
  key: string;
  audience: Audience;
  category: Category;
  group: string;
  label: string;
  description: string;
  triggers: string[];
  opens: string;
  /** Default channel switches */
  channels: Record<Channel, boolean>;
  /** Channels that exist for this topic (email-only topics have no in-app notice) */
  supports: Channel[];
  actionRequired: boolean;
  staffRoleKeys: string[];
  sellerPermission: string | null;
  ownerOnly: boolean;
  frequencyLabel: string | null;
  phase: number;
  /** Seller preference group */
  prefGroup: SellerPrefGroup | null;
  /** Staff: always emailed, even with the daily digest */
  urgent: boolean;
  /** Codes and links: rendered and sent without storing the secret, not retryable */
  sensitive: boolean;
  family: SenderFamily;
  icon: string;
  tone: Tone;
  template: DefaultTemplate;
  /** Topic variables (beyond the standard ones) */
  vars: string[];
}

interface TopicInput {
  group: string;
  label: string;
  opens: string;
  triggers?: string[];
  description?: string;
  category?: Category;
  channels?: Partial<Record<Channel, boolean>>;
  supports?: Channel[];
  action?: boolean;
  roles?: string[];
  permission?: string | null;
  ownerOnly?: boolean;
  frequency?: string;
  phase?: number;
  pref?: SellerPrefGroup | null;
  urgent?: boolean;
  sensitive?: boolean;
  family?: SenderFamily;
  icon?: string;
  tone?: Tone;
  t: DefaultTemplate;
}

const VAR = /\{\{\s*([\w.]+)\s*\}\}/g;
export const variablesIn = (...texts: (string | null | undefined)[]) => [...new Set(texts.flatMap((t) => [...(t ?? '').matchAll(VAR)].map((m) => m[1]!)))];

function topic(audience: Audience, key: string, i: TopicInput): TopicDef {
  const supports = i.supports ?? ['in_app', 'email', 'push'];
  const channels: Record<Channel, boolean> = { in_app: false, email: false, sms: false, push: false };
  for (const c of supports) channels[c] = c === 'in_app' || c === 'email' || (c === 'push' && audience !== 'staff');
  Object.assign(channels, i.channels ?? {});
  for (const c of CHANNELS) if (!supports.includes(c)) channels[c] = false;
  const vars = variablesIn(i.t.title, i.t.body, i.t.subject).filter((v) => !(v in STANDARD_VARIABLES));
  return {
    key,
    audience,
    category: i.category ?? 'essential',
    group: i.group,
    label: i.label,
    description: i.description ?? i.label,
    triggers: i.triggers ?? ['direct'],
    opens: i.opens,
    channels,
    supports,
    actionRequired: i.action ?? false,
    staffRoleKeys: i.roles ?? [],
    sellerPermission: i.permission ?? null,
    ownerOnly: i.ownerOnly ?? false,
    frequencyLabel: i.frequency ?? null,
    phase: i.phase ?? 1,
    prefGroup: i.pref ?? null,
    urgent: i.urgent ?? false,
    sensitive: i.sensitive ?? false,
    family: i.family ?? (audience === 'seller' ? 'sellers' : audience === 'staff' ? 'account' : 'orders'),
    icon: i.icon ?? 'bell',
    tone: i.tone ?? 'info',
    template: i.t,
    vars,
  };
}

const cu = (key: string, i: TopicInput) => topic('customer', `customer.${key}`, i);
const se = (key: string, i: TopicInput) => topic('seller', `seller.${key}`, i);
const st = (key: string, i: TopicInput) => topic('staff', `staff.${key}`, { supports: ['in_app', 'email'], ...i });

const EMAIL_ONLY: Channel[] = ['email'];

export const TOPICS: readonly TopicDef[] = [
  /* ---------------------------------------------------------------- customer: orders */
  cu('order.accepted', { group: 'orders', label: 'Order accepted', opens: 'Order details', triggers: ['orders.order.accepted'], icon: 'shopping-bag', tone: 'success',
    description: 'Confirmation once the order is accepted (never before acceptance)',
    t: { title: 'Order {{order.ref}} accepted', body: "We've accepted your order {{order.ref}} ({{order.total}}). We'll tell you when each package is on its way.", subject: 'Your order {{order.ref}} is confirmed', button: 'View order' } }),
  cu('payment.captured', { group: 'orders', label: 'Payment accepted', opens: 'Order details', triggers: ['payments.payment.captured'], icon: 'credit-card', tone: 'success',
    description: 'Payment result (combined with order accepted when both happen together)',
    t: { title: 'Payment received for {{order.ref}}', body: 'We received your payment of {{payment.amount}} for order {{order.ref}}.', subject: 'Payment received for {{order.ref}}', button: 'View order' } }),
  cu('payment.failed', { group: 'orders', label: 'Payment failed', opens: 'Order details', triggers: ['payments.payment.failed'], icon: 'credit-card', tone: 'danger', action: true,
    t: { title: "Your payment didn't go through", body: 'The payment for order {{order.ref}} was declined. Try again or choose another payment method.', subject: "Your payment for {{order.ref}} didn't go through", button: 'Try again' } }),
  cu('payment.pending_check', { group: 'orders', label: 'Payment being checked', opens: 'Order status', triggers: ['payments.payment.pending_check'], icon: 'clock', tone: 'warning',
    t: { title: "We're checking your payment", body: "We're confirming the result of your payment of {{payment.amount}} for {{order.ref}}. We'll update you as soon as we know.", subject: "We're checking your payment for {{order.ref}}", button: 'View order status' } }),
  cu('order.item_cancelled', { group: 'orders', label: 'Cancellation', opens: 'Order details', triggers: ['orders.item.cancelled'], icon: 'x-circle', tone: 'warning',
    t: { title: 'Item cancelled in {{order.ref}}', body: '{{item.count}} item(s) in order {{order.ref}} were cancelled. We will refund {{refund.amount}} to your original payment method.', subject: 'An item in {{order.ref}} was cancelled', button: 'View order' } }),
  cu('order.delayed', { group: 'orders', label: 'Delay', opens: 'Order details', triggers: ['orders.item.delayed'], icon: 'clock', tone: 'warning',
    t: { title: 'Your package from {{order.ref}} is delayed', body: 'New dispatch estimate: {{delay.dispatchBy}}. {{delay.reason}}. You can wait, cancel the item or contact support.', subject: 'Delay on your order {{order.ref}}', button: 'See your options' } }),
  cu('order.cancellation_decided', { group: 'orders', label: 'Cancellation request result', opens: 'Order details', triggers: ['orders.cancellation.decided'], icon: 'x-circle',
    t: { title: 'Cancellation request {{cancellation.outcome}}', body: 'Your cancellation request for order {{order.ref}} was {{cancellation.outcome}}.', subject: 'Your cancellation request for {{order.ref}}', button: 'View order' } }),
  cu('shipment.dispatched', { group: 'orders', label: 'Dispatched, with tracking', opens: 'Tracking', triggers: ['shipping.shipment.dispatched'], icon: 'truck', tone: 'info',
    description: 'Package dispatched with its contents, carrier and tracking (never says in transit before a carrier scan)',
    t: { title: 'Package dispatched: {{order.ref}}', body: '{{package.items}} from order {{order.ref}} has been dispatched. Estimated arrival: {{delivery.estimate}}.', subject: 'Your package from {{order.ref}} has been dispatched', button: 'Track package' } }),
  cu('shipment.delivered', { group: 'orders', label: 'Delivered', opens: 'Order details', triggers: ['shipping.shipment.delivered'], icon: 'package-check', tone: 'success',
    t: { title: 'Package delivered: {{order.ref}}', body: '{{package.items}} from order {{order.ref}} was delivered. Something wrong? You can report a problem from the order.', subject: 'Your package from {{order.ref}} was delivered', button: 'View order' } }),
  cu('shipment.exception', { group: 'orders', label: 'Delivery problem', opens: 'Tracking', triggers: ['shipping.shipment.exception'], icon: 'alert-triangle', tone: 'warning', action: true, supports: ['in_app', 'email', 'sms', 'push'],
    t: { title: 'Problem with your delivery for {{order.ref}}', body: 'There is a delivery problem ({{exception.kind}}). Next step: {{exception.action}} by {{due.date}}.', subject: 'Action needed: delivery problem with {{order.ref}}', button: 'See next steps' } }),
  cu('order.guest_link', { group: 'orders', label: 'Guest order links', opens: 'Order details', supports: EMAIL_ONLY, icon: 'link',
    description: 'Emailed order links for guests (minted by customers)',
    t: { title: 'Your Marketly order links', body: 'Use this link to open your order {{order.ref}}: {{guest.url}}', subject: 'Your order links for {{order.ref}}', button: 'Open order' } }),
  cu('message.new', { group: 'orders', label: 'New message', opens: 'Conversation', triggers: ['messaging.message.sent'], icon: 'message-circle',
    t: { title: 'New message from {{message.from}}', body: 'You have a new message about order {{order.ref}}. Reply in your account or answer this email.', subject: 'New message from {{message.from}}', button: 'Read message' } }),
  cu('review.invite', { group: 'orders', label: 'Review invitation', opens: 'Write a review', triggers: ['reviews.invite.due'], category: 'optional', icon: 'star',
    t: { title: 'How was your purchase?', body: 'Tell other shoppers what you think of your recent purchase.', subject: 'How was your purchase?', button: 'Write a review' } }),

  /* ---------------------------------------------------------------- customer: returns and refunds */
  cu('return.info_requested', { group: 'returns_refunds', label: 'Return: information needed', opens: 'Return', triggers: ['returns.return.info_requested'], icon: 'help-circle', tone: 'warning', action: true,
    t: { title: 'We need more information for your return', body: 'Please reply by {{due.date}} so we can continue with your return {{return.ref}}.', subject: 'Action needed for your return {{return.ref}}', button: 'Reply' } }),
  cu('return.approved', { group: 'returns_refunds', label: 'Return approved', opens: 'Return', triggers: ['returns.return.approved'], icon: 'rotate-ccw', tone: 'success',
    t: { title: 'Return {{return.ref}} approved', body: 'Your return was approved. {{return.outcome}}', subject: 'Your return {{return.ref}} was approved', button: 'View return' } }),
  cu('return.rejected', { group: 'returns_refunds', label: 'Return declined', opens: 'Return', triggers: ['returns.return.rejected'], icon: 'rotate-ccw', tone: 'danger',
    t: { title: 'Return {{return.ref}} declined', body: 'Your return was declined ({{return.reason}}). If you disagree, you can ask us for help from the return page.', subject: 'Update on your return {{return.ref}}', button: 'Get help' } }),
  cu('return.label_ready', { group: 'returns_refunds', label: 'Return label ready', opens: 'Return', triggers: ['returns.label.created'], icon: 'tag',
    t: { title: 'Your return label is ready', body: 'Print the label for return {{return.ref}} and drop the package off.', subject: 'Your return label for {{return.ref}}', button: 'Get label' } }),
  cu('return.dropoff_reminder', { group: 'returns_refunds', label: 'Return drop-off reminder', opens: 'Return', triggers: ['scheduled'], icon: 'clock', tone: 'warning',
    t: { title: 'Reminder: drop off your return', body: 'Please drop off return {{return.ref}} by {{due.date}}.', subject: 'Reminder: drop off your return {{return.ref}}', button: 'View return' } }),
  cu('return.received', { group: 'returns_refunds', label: 'Return received', opens: 'Return', triggers: ['returns.return.received'], icon: 'package',
    t: { title: 'Return {{return.ref}} received', body: 'We received your return. We will let you know after it has been inspected.', subject: 'We received your return {{return.ref}}', button: 'View return' } }),
  cu('return.inspected', { group: 'returns_refunds', label: 'Return inspected', opens: 'Return', triggers: ['returns.return.inspected'], icon: 'search',
    t: { title: 'Return {{return.ref}} inspected', body: 'Inspection result: {{return.outcome}}.', subject: 'Inspection result for your return {{return.ref}}', button: 'View return' } }),
  cu('refund.approved', { group: 'returns_refunds', label: 'Refund approved', opens: 'Refund progress', triggers: ['returns.refund.approved'], icon: 'wallet', tone: 'success',
    description: "Refund approved and processing (never says the money has arrived)",
    t: { title: 'Refund of {{refund.amount}} approved', body: "We approved a refund of {{refund.amount}} for order {{order.ref}}. It's being processed; we'll tell you when it's sent.", subject: 'Your refund of {{refund.amount}} was approved', button: 'Track refund' } }),
  cu('refund.sent', { group: 'returns_refunds', label: 'Refund sent', opens: 'Refund progress', triggers: ['payments.refund.sent'], icon: 'wallet', tone: 'success',
    t: { title: 'Refund of {{refund.amount}} sent', body: 'We sent {{refund.amount}} to {{refund.destination}}. Banks usually show it within 3–5 business days.', subject: 'Your refund of {{refund.amount}} was sent', button: 'Track refund' } }),
  cu('refund.failed', { group: 'returns_refunds', label: 'Refund problem', opens: 'Refund progress', triggers: ['payments.refund.failed'], icon: 'alert-triangle', tone: 'danger',
    t: { title: 'Problem with your refund', body: "We couldn't send your refund of {{refund.amount}} ({{refund.reason}}). Our team is on it; we'll contact you about the next steps.", subject: 'There is a problem with your refund', button: 'View refund' } }),
  cu('replacement.created', { group: 'returns_refunds', label: 'Replacement on its way', opens: 'Order details', triggers: ['returns.replacement.created'], icon: 'repeat',
    t: { title: 'A replacement is being prepared', body: 'A replacement for your return {{return.ref}} will ship as its own package. We will send tracking when it is dispatched.', subject: 'Your replacement is being prepared', button: 'View order' } }),

  /* ---------------------------------------------------------------- customer: cases */
  cu('case.opened', { group: 'cases', label: 'Case opened', opens: 'Case', triggers: ['support.case.opened'], icon: 'life-buoy',
    t: { title: 'We received your request {{case.ref}}', body: 'Thanks for contacting us. We usually reply by {{due.date}}.', subject: 'We received your request {{case.ref}}', button: 'View case' } }),
  cu('case.reply', { group: 'cases', label: 'Case reply', opens: 'Case', triggers: ['support.case.message_added'], icon: 'message-square',
    t: { title: 'New reply on {{case.ref}}', body: 'There is a new reply on your case {{case.ref}}. Reply in your account or answer this email.', subject: 'New reply on your case {{case.ref}}', button: 'View reply' } }),
  cu('case.decided', { group: 'cases', label: 'Case decision', opens: 'Case', triggers: ['support.case.decided'], icon: 'scale',
    t: { title: 'Decision on case {{case.ref}}', body: 'Our decision: {{case.outcome}}. You can appeal until {{appeal.deadline}}.', subject: 'Decision on your case {{case.ref}}', button: 'View decision' } }),
  cu('case.resolved', { group: 'cases', label: 'Case resolved', opens: 'Case', triggers: ['support.case.resolved'], icon: 'check-circle', tone: 'success',
    t: { title: 'Case {{case.ref}} resolved', body: 'Your case {{case.ref}} is resolved. Reply within 7 days if you still need help.', subject: 'Your case {{case.ref}} is resolved', button: 'View case' } }),

  /* ---------------------------------------------------------------- customer: account and security */
  cu('account.verification_code', { group: 'account', label: 'Verification code', opens: 'Sign-in', triggers: ['identity.verification.code_issued'], supports: ['email', 'sms'], channels: { sms: true }, sensitive: true, family: 'account', icon: 'key',
    t: { title: 'Your Marketly code', body: 'Your verification code is {{code.value}}. It expires in {{code.expires}}. Never share it with anyone.', subject: 'Your Marketly verification code', button: 'Continue' } }),
  cu('account.already_registered', { group: 'account', label: 'You already have an account', opens: 'Sign-in', triggers: ['identity.verification.code_issued'], supports: EMAIL_ONLY, sensitive: true, family: 'account', icon: 'user',
    t: { title: 'You already have an account', body: 'Someone tried to register with this email. You already have a Marketly account: sign in or reset your password.', subject: 'You already have a Marketly account', button: 'Sign in' } }),
  cu('account.password_reset', { group: 'account', label: 'Password reset link', opens: 'Reset password', triggers: ['identity.password_reset.requested'], supports: EMAIL_ONLY, sensitive: true, family: 'account', icon: 'key',
    t: { title: 'Reset your password', body: 'Use this link to choose a new password: {{reset.url}}. If you did not ask for this, ignore this email.', subject: 'Reset your Marketly password', button: 'Reset password' } }),
  cu('account.password_changed', { group: 'account', label: 'Password changed', opens: 'Security', triggers: ['identity.password.changed'], family: 'account', icon: 'shield', tone: 'warning',
    t: { title: 'Your password was changed', body: "Your Marketly password was changed. If this wasn't you, reset your password and contact us.", subject: 'Your Marketly password was changed', button: 'Review security' } }),
  cu('account.new_device', { group: 'account', label: 'New sign-in', opens: 'Security', triggers: ['identity.session.new_device'], family: 'account', icon: 'smartphone', tone: 'warning',
    t: { title: 'New sign-in on {{device.label}}', body: "Your account was signed in on {{device.label}} ({{device.location}}). If this wasn't you, change your password.", subject: 'New sign-in to your Marketly account', button: 'Review security' } }),
  cu('account.email_changed', { group: 'account', label: 'Email address changed', opens: 'Security', triggers: ['identity.email.changed'], family: 'account', icon: 'mail', tone: 'warning',
    t: { title: 'Your email address was changed', body: "The email address of your account changed from {{email.old}} to {{email.new}}. If this wasn't you, contact us.", subject: 'Your Marketly email address was changed', button: 'Review security' } }),
  cu('account.two_step_changed', { group: 'account', label: '2-step verification changed', opens: 'Security', triggers: ['identity.two_step.changed'], family: 'account', icon: 'shield',
    t: { title: '2-step verification {{twostep.state}}', body: "2-step verification was {{twostep.state}} on your account. If this wasn't you, contact us.", subject: '2-step verification was {{twostep.state}}', button: 'Review security' } }),
  cu('account.locked', { group: 'account', label: 'Account locked', opens: 'Security', triggers: ['identity.account.locked'], family: 'account', icon: 'lock', tone: 'danger',
    t: { title: 'Your account was locked', body: 'We locked your account to protect it (until {{lock.until}}). Reset your password to sign in again.', subject: 'Your Marketly account was locked', button: 'Reset password' } }),
  cu('account.welcome', { group: 'account', label: 'Welcome', opens: 'Account overview', triggers: ['identity.user.verified'], supports: ['in_app'], family: 'account', icon: 'sparkles', tone: 'brand',
    t: { title: 'Welcome to Marketly', body: 'Your account is ready. Track orders, returns and messages here.' } }),
  cu('account.data_export_ready', { group: 'account', label: 'Data export ready', opens: 'Privacy', triggers: ['customers.data_export.ready'], family: 'account', icon: 'download',
    t: { title: 'Your data export is ready', body: 'Download your data before {{export.expires}}.', subject: 'Your Marketly data export is ready', button: 'Download' } }),
  cu('account.reply_not_delivered', { group: 'account', label: 'Email reply not delivered', opens: 'Account', supports: EMAIL_ONLY, family: 'account', icon: 'mail-x',
    description: "Automatic answer to replies with an unknown or expired reply address",
    t: { title: 'Please reply in your account', body: "We couldn't match your email to a conversation. Please sign in and reply in your account.", subject: 'Please reply in your Marketly account', button: 'Open my account' } }),

  /* ---------------------------------------------------------------- customer: promotional */
  cu('promotions.newsletter', { group: 'promotions', label: 'Deals and coupons newsletter', opens: 'Deals', category: 'promotional', frequency: 'Weekly', family: 'promotions', icon: 'percent', tone: 'deal', supports: ['email', 'sms', 'push'], channels: { sms: true },
    t: { title: "This week's deals", body: 'New deals and coupons picked for you.', subject: "This week's deals on Marketly", button: 'See deals' } }),
  cu('wishlist.alert', { group: 'promotions', label: 'Price drop and back-in-stock alerts', opens: 'Product', triggers: ['wishlist.alert.triggered'], category: 'promotional', phase: 3, family: 'promotions', icon: 'heart', tone: 'deal',
    t: { title: '{{wishlist.product}}: {{wishlist.price}}', body: 'An item on your wishlist changed: {{wishlist.product}} is now {{wishlist.price}}.', subject: 'Wishlist alert: {{wishlist.product}}', button: 'View product' } }),

  /* ---------------------------------------------------------------- seller: orders */
  se('order.new', { group: 'orders', label: 'New order', opens: 'Seller order', triggers: ['orders.order.accepted'], pref: 'new_orders', permission: 'orders.fulfillment.view', icon: 'shopping-bag', tone: 'brand',
    t: { title: 'New order {{order.ref}}', body: 'You have a new order {{order.ref}} ({{order.total}}). Dispatch by {{due.date}}.', subject: 'New order {{order.ref}}', button: 'Open order' } }),
  se('order.item_cancelled', { group: 'orders', label: 'Item cancelled', opens: 'Seller order', triggers: ['orders.item.cancelled'], pref: 'new_orders', permission: 'orders.fulfillment.view', icon: 'x-circle', tone: 'warning',
    t: { title: 'Item cancelled in {{order.ref}}', body: '{{item.count}} item(s) in order {{order.ref}} were cancelled. Do not ship them.', subject: 'Item cancelled in {{order.ref}}', button: 'Open order' } }),
  se('dispatch.reminder', { group: 'orders', label: 'Dispatch deadline, 4 h before', opens: 'Seller order', triggers: ['scheduled'], pref: 'dispatch_overdue', permission: 'orders.fulfillment.view', icon: 'clock', tone: 'warning', action: true,
    t: { title: 'Dispatch {{order.ref}} by {{due.date}}', body: 'Order {{order.ref}} must be dispatched by {{due.date}} to stay on time.', subject: 'Reminder: dispatch {{order.ref}} by {{due.date}}', button: 'Open dispatch queue' } }),
  se('dispatch.overdue', { group: 'orders', label: 'Dispatch overdue', opens: 'Seller order', triggers: ['shipping.dispatch.overdue'], pref: 'dispatch_overdue', permission: 'orders.fulfillment.view', icon: 'alert-triangle', tone: 'danger', action: true,
    t: { title: 'Dispatch overdue: {{order.ref}}', body: 'Order {{order.ref}} was due for dispatch on {{due.date}}. Dispatch it now or tell the customer about the delay.', subject: 'Overdue: dispatch {{order.ref}} now', button: 'Open order' } }),
  se('order.dispute_opened', { group: 'returns_cases', label: 'Payment dispute opened', opens: 'Seller order', triggers: ['payments.chargeback.opened'], pref: 'returns_cases', permission: 'orders.fulfillment.view', icon: 'scale', tone: 'danger', action: true,
    t: { title: 'Dispute opened on {{order.ref}}', body: 'The customer disputed {{chargeback.amount}} with their bank. Add evidence by {{due.date}}.', subject: 'Payment dispute on {{order.ref}}', button: 'Add evidence' } }),
  se('message.new', { group: 'orders', label: 'Customer message', opens: 'Conversation', triggers: ['messaging.message.sent'], pref: 'customer_messages', permission: 'messaging.conversations.reply', icon: 'message-circle',
    t: { title: 'New customer message', body: 'A customer wrote about order {{order.ref}}. Reply within 24 hours.', subject: 'New customer message about {{order.ref}}', button: 'Reply' } }),

  /* ---------------------------------------------------------------- seller: returns and cases */
  se('return.requested', { group: 'returns_cases', label: 'Return request', opens: 'Seller return', triggers: ['returns.return.requested'], pref: 'returns_cases', permission: 'returns.requests.respond', icon: 'rotate-ccw', tone: 'warning', action: true,
    t: { title: 'Return request {{return.ref}}', body: 'A customer asked to return items from {{order.ref}} ({{return.reason}}). Respond by {{due.date}}.', subject: 'Return request {{return.ref}}: respond by {{due.date}}', button: 'Respond' } }),
  se('return.received', { group: 'returns_cases', label: 'Return received', opens: 'Seller return', triggers: ['returns.return.received'], pref: 'returns_cases', permission: 'returns.refunds.issue', icon: 'package', action: true,
    t: { title: 'Return {{return.ref}} received', body: 'The returned package arrived. Inspect it and refund or replace by {{due.date}}.', subject: 'Return {{return.ref}} received: inspect it', button: 'Inspect return' } }),
  se('return.escalated', { group: 'returns_cases', label: 'Return escalated', opens: 'Seller return', triggers: ['returns.return.escalated'], pref: 'returns_cases', permission: 'returns.requests.respond', icon: 'life-buoy', tone: 'warning',
    t: { title: 'Marketly support stepped in on {{return.ref}}', body: 'Platform support is now handling return {{return.ref}} ({{return.reason}}).', subject: 'Marketly support stepped in on a return', button: 'View return' } }),
  se('case.opened', { group: 'returns_cases', label: 'Case opened', opens: 'Case', triggers: ['support.case.opened'], pref: 'returns_cases', permission: 'support.cases.respond', icon: 'life-buoy', tone: 'warning', action: true,
    t: { title: 'Case {{case.ref}} opened on {{order.ref}}', body: 'A customer opened a case about order {{order.ref}}. Respond by {{due.date}}.', subject: 'New case {{case.ref}} on {{order.ref}}', button: 'Respond' } }),
  se('case.reply', { group: 'returns_cases', label: 'Case reply', opens: 'Case', triggers: ['support.case.message_added'], pref: 'returns_cases', permission: 'support.cases.respond', icon: 'message-square',
    t: { title: 'New reply on {{case.ref}}', body: 'There is a new reply on case {{case.ref}}. Reply in Seller Center or answer this email.', subject: 'New reply on case {{case.ref}}', button: 'View reply' } }),
  se('case.decided', { group: 'returns_cases', label: 'Case decision', opens: 'Case', triggers: ['support.case.decided'], pref: 'returns_cases', permission: 'support.cases.respond', icon: 'scale',
    t: { title: 'Decision on case {{case.ref}}', body: 'Decision: {{case.outcome}}. You can appeal until {{appeal.deadline}}.', subject: 'Decision on case {{case.ref}}', button: 'View decision' } }),

  /* ---------------------------------------------------------------- seller: products */
  se('product.changes_requested', { group: 'products', label: 'Requested corrections', opens: 'Product', triggers: ['catalog.product.changes_requested'], pref: 'products', permission: 'catalog.products.submit', icon: 'edit', tone: 'warning', action: true,
    t: { title: 'Corrections requested', body: 'Please correct your product and resubmit: {{product.reason}}.', subject: 'Corrections requested for your product', button: 'Fix product' } }),
  se('product.approved', { group: 'products', label: 'Product approved', opens: 'Product', triggers: ['catalog.product.approved'], pref: 'products', permission: 'catalog.products.submit', icon: 'check-circle', tone: 'success',
    t: { title: 'Product approved', body: 'Your product was approved. You can now publish offers for it.', subject: 'Your product was approved', button: 'View product' } }),
  se('product.rejected', { group: 'products', label: 'Product rejected', opens: 'Product', triggers: ['catalog.product.rejected'], pref: 'products', permission: 'catalog.products.submit', icon: 'x-circle', tone: 'danger',
    t: { title: 'Product rejected', body: 'Your product was rejected: {{product.reason}}.', subject: 'Your product was rejected', button: 'View product' } }),
  se('stock.low', { group: 'products', label: 'Low stock', opens: 'Stock', triggers: ['inventory.stock.low'], pref: 'products', permission: 'inventory.stock.adjust', icon: 'package', tone: 'warning',
    t: { title: 'Low stock: {{stock.label}}', body: 'Only {{stock.available}} left of {{stock.label}}.', subject: 'Low stock: {{stock.label}}', button: 'Update stock' } }),
  se('advertising.campaign_status', { group: 'products', label: 'Sponsored campaign update', opens: 'Campaign', triggers: ['advertising.campaign.status_changed'], category: 'optional', permission: 'advertising.requests.manage', icon: 'megaphone',
    t: { title: 'Campaign {{campaign.status}}', body: 'Your sponsored campaign is now {{campaign.status}}.', subject: 'Your sponsored campaign is {{campaign.status}}', button: 'View campaign' } }),
  se('promotion.invited', { group: 'products', label: 'Campaign invitation', opens: 'Campaign', triggers: ['promotions.participation.invited'], category: 'optional', pref: 'promotions', permission: 'promotions.campaigns.join', icon: 'percent', tone: 'deal',
    t: { title: "You're invited to a campaign", body: 'Join the campaign and see the expected earnings impact. Respond by {{campaign.respondBy}}.', subject: "You're invited to a Marketly campaign", button: 'Review invitation' } }),

  /* ---------------------------------------------------------------- seller: account and finance (owner) */
  se('application.information_requested', { group: 'account_finance', label: 'Application: information required', opens: 'Application status', triggers: ['sellers.application.information_requested'], ownerOnly: true, pref: 'account', icon: 'file-text', tone: 'warning', action: true,
    t: { title: 'Information required for your application', body: 'We need more information to review your application. Please answer by {{due.date}}.', subject: 'Action needed: your Marketly seller application', button: 'Answer now' } }),
  se('application.decided', { group: 'account_finance', label: 'Application result', opens: 'Application status', triggers: ['sellers.application.decided'], ownerOnly: true, pref: 'account', icon: 'file-check',
    t: { title: 'Your application was {{change.outcome}}', body: 'Your seller application was {{change.outcome}}. Open Seller Center for the next steps.', subject: 'Your Marketly seller application was {{change.outcome}}', button: 'See next steps' } }),
  se('account.restricted', { group: 'account_finance', label: 'Restriction', opens: 'Account health', triggers: ['sellers.seller.restricted'], ownerOnly: true, pref: 'account', icon: 'shield-alert', tone: 'danger',
    t: { title: 'Your account has a restriction', body: 'Restricted: {{restriction.activities}}. Reason: {{restriction.reason}}. You can appeal until {{appeal.deadline}}.', subject: 'Your Marketly seller account has a restriction', button: 'View account health' } }),
  se('account.suspended', { group: 'account_finance', label: 'Suspension', opens: 'Account health', triggers: ['sellers.seller.suspended'], ownerOnly: true, pref: 'account', icon: 'shield-x', tone: 'danger',
    t: { title: 'Your account is suspended', body: 'Reason: {{restriction.reason}}. Open orders: see Seller Center. You can appeal until {{appeal.deadline}}.', subject: 'Your Marketly seller account is suspended', button: 'View account health' } }),
  se('account.reinstated', { group: 'account_finance', label: 'Account reinstated', opens: 'Account health', triggers: ['sellers.seller.reinstated'], ownerOnly: true, pref: 'account', icon: 'shield-check', tone: 'success',
    t: { title: 'Your account was reinstated', body: 'Your seller account was reinstated.', subject: 'Your Marketly seller account was reinstated', button: 'View account health' } }),
  se('account.warning', { group: 'account_finance', label: 'Warning', opens: 'Account health', triggers: ['sellers.warning.issued'], ownerOnly: true, pref: 'account', icon: 'alert-triangle', tone: 'warning',
    t: { title: 'Warning: {{warning.title}}', body: 'We issued a warning on your account: {{warning.title}}.', subject: 'Warning on your seller account', button: 'View account health' } }),
  se('appeal.decided', { group: 'account_finance', label: 'Appeal result', opens: 'Account health', triggers: ['sellers.appeal.decided'], ownerOnly: true, pref: 'account', icon: 'scale',
    t: { title: 'Appeal {{appeal.outcome}}', body: 'Your appeal was {{appeal.outcome}}.', subject: 'The result of your appeal', button: 'View appeal' } }),
  se('payout_account.changed', { group: 'account_finance', label: 'Payout destination changed', opens: 'Payout settings', triggers: ['sellers.payout_account.changed'], ownerOnly: true, pref: 'payouts_holds', icon: 'landmark', tone: 'warning',
    description: 'Security notice: the payout destination changed (always emailed to the owner)',
    t: { title: 'Payout destination changed', body: 'Your payout destination changed to {{destination.label}}. If you did not do this, contact us now.', subject: 'Security notice: your payout destination changed', button: 'Review payout settings' } }),
  se('change_request.decided', { group: 'account_finance', label: 'Change request decision', opens: 'Account settings', triggers: ['sellers.change_request.decided'], ownerOnly: true, pref: 'account', icon: 'file-check',
    t: { title: 'Change request {{change.outcome}}', body: 'Your request to change your {{change.kind}} was {{change.outcome}}.', subject: 'Your change request was {{change.outcome}}', button: 'View request' } }),
  se('verification.changed', { group: 'account_finance', label: 'Verified seller label', opens: 'Account health', triggers: ['sellers.verification.changed'], ownerOnly: true, pref: 'account', icon: 'badge-check',
    t: { title: 'Verified seller label {{verification.state}}', body: 'The Verified seller label on your store was {{verification.state}}.', subject: 'Your Verified seller label was {{verification.state}}', button: 'View verification' } }),
  se('launch_review.decided', { group: 'account_finance', label: 'Launch review result', opens: 'Launch checklist', triggers: ['sellers.launch_review.decided'], ownerOnly: true, pref: 'account', icon: 'rocket',
    t: { title: 'Launch review {{review.outcome}}', body: 'Your launch review {{review.outcome}}. Open Seller Center for what this changes.', subject: 'Your launch review {{review.outcome}}', button: 'View launch checklist' } }),
  se('payout_destination.verified', { group: 'account_finance', label: 'Payout destination verified', opens: 'Payout settings', triggers: ['finance.destination.verified'], ownerOnly: true, pref: 'payouts_holds', icon: 'landmark', tone: 'success',
    t: { title: 'Payout destination verified', body: 'Your new payout destination is verified. Your next payout goes there.', subject: 'Your payout destination is verified', button: 'View payout settings' } }),
  se('payout_destination.rejected', { group: 'account_finance', label: 'Payout destination rejected', opens: 'Payout settings', triggers: ['finance.destination.rejected'], ownerOnly: true, pref: 'payouts_holds', icon: 'landmark', tone: 'danger',
    t: { title: 'Payout destination rejected', body: 'We could not verify your payout destination: {{destination.reason}}.', subject: 'Your payout destination was rejected', button: 'Update payout settings' } }),
  se('payout.paid', { group: 'account_finance', label: 'Payout paid', opens: 'Payout record', triggers: ['finance.payout.paid'], ownerOnly: true, pref: 'payouts_holds', permission: 'finance.balances.view', icon: 'wallet', tone: 'success',
    t: { title: 'Payout {{payout.ref}} paid', body: 'Your bank confirmed payout {{payout.ref}} of {{payout.amount}}.', subject: 'Payout {{payout.ref}} paid', button: 'View payout' } }),
  se('payout.failed', { group: 'account_finance', label: 'Payout failed', opens: 'Payout record', triggers: ['finance.payout.failed'], ownerOnly: true, pref: 'payouts_holds', permission: 'finance.balances.view', icon: 'wallet', tone: 'danger', action: true,
    t: { title: 'Payout {{payout.ref}} failed', body: 'Payout {{payout.ref}} of {{payout.amount}} failed: {{payout.reason}}. Fix your payout settings to receive it.', subject: 'Payout {{payout.ref}} failed', button: 'Fix payout settings' } }),
  se('hold.placed', { group: 'account_finance', label: 'Hold placed', opens: 'Hold', triggers: ['finance.hold.placed'], ownerOnly: true, pref: 'payouts_holds', permission: 'finance.balances.view', icon: 'pause-circle', tone: 'warning',
    t: { title: 'Hold of {{hold.amount}} placed', body: 'We placed a hold of {{hold.amount}}: {{hold.reason}}. Review date: {{hold.reviewDate}}.', subject: 'A hold was placed on your balance', button: 'View hold' } }),
  se('hold.released', { group: 'account_finance', label: 'Hold released', opens: 'Hold', triggers: ['finance.hold.released'], ownerOnly: true, pref: 'payouts_holds', permission: 'finance.balances.view', icon: 'play-circle', tone: 'success',
    t: { title: 'Hold of {{hold.amount}} released', body: 'The hold of {{hold.amount}} was released.', subject: 'A hold on your balance was released', button: 'View balance' } }),
  se('balance.negative', { group: 'account_finance', label: 'Amount owed', opens: 'Balance', triggers: ['finance.balance.negative'], ownerOnly: true, pref: 'payouts_holds', permission: 'finance.balances.view', icon: 'minus-circle', tone: 'danger',
    t: { title: 'Your balance is negative', body: 'Your available balance is {{balance.amount}}. It will be recovered from your next sales.', subject: 'Your Marketly balance is negative', button: 'View balance' } }),
  se('statement.issued', { group: 'account_finance', label: 'Statement available', opens: 'Statement', triggers: ['finance.statement.issued'], ownerOnly: true, pref: 'payouts_holds', permission: 'finance.balances.view', icon: 'file-text',
    t: { title: 'Statement for {{statement.period}}', body: 'Your statement for {{statement.period}} is available.', subject: 'Your statement for {{statement.period}}', button: 'View statement' } }),
  se('platform.change_scheduled', { group: 'account_finance', label: 'Upcoming platform change', opens: 'Upcoming changes', triggers: ['settings.change.scheduled'], icon: 'calendar',
    t: { title: 'Upcoming change from {{change.effective}}', body: '{{change.summary}}. Effective {{change.effective}}.', subject: 'Upcoming Marketly change from {{change.effective}}', button: 'View change' } }),
  se('member.invitation', { group: 'account_finance', label: 'Seller team invitation', opens: 'Accept invitation', triggers: ['identity.invitation.created'], supports: EMAIL_ONLY, sensitive: true, icon: 'user-plus',
    t: { title: 'Join {{invite.context}} on Marketly', body: '{{invite.by}} invited you to help run {{invite.context}} in Seller Center. Accept: {{invite.url}}', subject: "You're invited to {{invite.context}} on Marketly", button: 'Accept invitation' } }),
  se('export.ready', { group: 'account_finance', label: 'Export ready', opens: 'Exports', triggers: ['reports.export.ready'], icon: 'download',
    t: { title: 'Your export is ready', body: 'Your export is ready to download until {{export.expires}}.', subject: 'Your Seller Center export is ready', button: 'Download' } }),
  se('promotions.tips', { group: 'account_finance', label: 'Seller tips and campaigns', opens: 'Seller Center', category: 'promotional', frequency: 'Monthly', pref: 'promotions', family: 'promotions', icon: 'lightbulb', tone: 'deal', supports: ['in_app', 'email'],
    t: { title: 'Tips to grow your sales', body: 'New tips and campaigns for your store.', subject: 'Seller tips and campaigns this month', button: 'Read more' } }),

  /* ---------------------------------------------------------------- staff */
  st('shipping.dispatch_overdue', { group: 'Shipping', label: 'Overdue shipping', opens: 'Dispatch queue', triggers: ['shipping.dispatch.overdue'], roles: ['shipping_manager'], action: true, urgent: true, icon: 'truck', tone: 'danger',
    t: { title: 'Overdue dispatch {{order.ref}}', body: '{{seller.name}} missed the dispatch deadline for {{order.ref}} ({{due.date}}).', subject: 'Overdue dispatch: {{order.ref}}', button: 'Open dispatch queue' } }),
  st('shipping.exception', { group: 'Shipping', label: 'Delivery exception', opens: 'Dispatch queue', triggers: ['shipping.shipment.exception'], roles: ['shipping_manager'], action: true, icon: 'alert-triangle', tone: 'warning',
    t: { title: 'Delivery exception on {{order.ref}}', body: 'Exception: {{exception.kind}}. Due {{due.date}}.', subject: 'Delivery exception on {{order.ref}}', button: 'Open exception' } }),
  st('inventory.stock_shortage', { group: 'Inventory', label: 'Stock shortage', opens: 'Stock', triggers: ['inventory.stock.low'], roles: ['inventory_manager'], action: true, icon: 'package', tone: 'warning',
    t: { title: 'Stock shortage: {{stock.label}}', body: 'Official Store stock of {{stock.label}} is down to {{stock.available}}.', subject: 'Stock shortage: {{stock.label}}', button: 'Open stock' } }),
  st('approval.waiting', { group: 'Approvals', label: 'Waiting approval', opens: 'Approval', triggers: ['access.approval.requested'], action: true, icon: 'user-check', tone: 'warning',
    t: { title: 'Approval needed: {{approval.summary}}', body: '{{approval.by}} asked for your approval: {{approval.summary}}. Due {{due.date}}.', subject: 'Approval needed: {{approval.summary}}', button: 'Review request' } }),
  st('approval.second_needed', { group: 'Approvals', label: 'Second approval needed', opens: 'Approval', triggers: ['access.approval.partially_approved'], action: true, icon: 'user-check', tone: 'warning',
    t: { title: 'Second approval needed', body: '{{approval.by}} approved; one more approval is needed for {{approval.summary}}.', subject: 'Second approval needed', button: 'Review request' } }),
  st('approval.returned', { group: 'Approvals', label: 'Request returned', opens: 'Approval', triggers: ['access.approval.returned'], action: true, icon: 'corner-up-left', tone: 'warning',
    t: { title: 'Your request was returned', body: '{{approval.by}} sent your request back: {{approval.comment}}', subject: 'Your approval request was returned', button: 'Update request' } }),
  st('approval.decided', { group: 'Approvals', label: 'Approval decided', opens: 'Approval', triggers: ['access.approval.decided'], icon: 'check-circle',
    t: { title: 'Request {{approval.outcome}}', body: 'Your request was {{approval.outcome}}.', subject: 'Your approval request was {{approval.outcome}}', button: 'View request' } }),
  st('approval.reminder', { group: 'Approvals', label: 'Approval reminder', opens: 'Approval', triggers: ['access.approval.reminder_sent'], action: true, icon: 'bell', tone: 'warning',
    t: { title: 'Reminder: approval waiting', body: 'A request is still waiting for your decision. {{approval.comment}}', subject: 'Reminder: an approval is waiting for you', button: 'Review request' } }),
  st('approval.due_soon', { group: 'Approvals', label: 'Approval due soon', opens: 'Approval', triggers: ['scheduled'], action: true, icon: 'clock', tone: 'warning',
    t: { title: 'Approval due {{due.date}}', body: 'A request waiting for your decision is due {{due.date}}.', subject: 'Approval due {{due.date}}', button: 'Review request' } }),
  st('case.escalated', { group: 'Support', label: 'Escalated case', opens: 'Case', triggers: ['support.case.escalated'], roles: ['customer_support_manager', 'returns_manager'], action: true, icon: 'life-buoy', tone: 'warning',
    t: { title: 'Escalated case {{case.ref}}', body: 'Case {{case.ref}} was escalated: {{escalation.reason}}.', subject: 'Escalated case {{case.ref}}', button: 'Open case' } }),
  st('case.overdue', { group: 'Support', label: 'Case overdue', opens: 'Case', triggers: ['support.case.overdue'], roles: ['customer_support_manager'], action: true, urgent: true, icon: 'clock', tone: 'danger',
    t: { title: 'Case past its response target', body: 'A case is past its response target ({{due.date}}).', subject: 'Overdue case', button: 'Open case' } }),
  st('returns.escalated', { group: 'Returns', label: 'Escalated return', opens: 'Return', triggers: ['returns.return.escalated'], roles: ['returns_manager'], action: true, icon: 'rotate-ccw', tone: 'warning',
    t: { title: 'Return escalated', body: 'A return was escalated: {{return.reason}}.', subject: 'Return escalated', button: 'Open return' } }),
  st('finance.refund_failed', { group: 'Finance', label: 'Refund failed', opens: 'Refund', triggers: ['payments.refund.failed'], roles: ['finance_manager'], action: true, icon: 'wallet', tone: 'danger',
    t: { title: 'Refund failed: {{refund.amount}}', body: 'Refund for {{order.ref}} failed: {{refund.reason}}.', subject: 'Refund failed for {{order.ref}}', button: 'Open refund' } }),
  st('finance.chargeback_opened', { group: 'Finance', label: 'Unusual financial activity: dispute', opens: 'Dispute', triggers: ['payments.chargeback.opened'], roles: ['finance_manager'], icon: 'scale', tone: 'warning',
    t: { title: 'Dispute {{chargeback.ref}} opened', body: 'A {{chargeback.amount}} dispute was opened on {{order.ref}}.', subject: 'Dispute opened on {{order.ref}}', button: 'Open dispute' } }),
  st('finance.payout_failed', { group: 'Finance', label: 'Failed payout', opens: 'Payout record', triggers: ['finance.payout.failed'], roles: ['finance_manager'], action: true, urgent: true, icon: 'wallet', tone: 'danger',
    t: { title: 'Payout {{payout.ref}} failed', body: 'Payout {{payout.ref}} of {{payout.amount}} failed: {{payout.reason}}.', subject: 'Failed payout {{payout.ref}}', button: 'Open payout' } }),
  st('finance.balance_negative', { group: 'Finance', label: 'Negative seller balance', opens: 'Seller balance', triggers: ['finance.balance.negative'], roles: ['finance_manager'], icon: 'minus-circle', tone: 'warning',
    t: { title: 'Negative balance: {{balance.amount}}', body: 'A seller balance is negative ({{balance.amount}}).', subject: 'Negative seller balance', button: 'Open balance' } }),
  st('finance.reconciliation_mismatch', { group: 'Finance', label: 'Unusual financial activity', opens: 'Finance checks', triggers: ['finance.reconciliation.mismatch_found'], roles: ['finance_manager'], action: true, icon: 'alert-octagon', tone: 'danger',
    t: { title: 'Reconciliation mismatch: {{mismatch.check}}', body: 'The {{mismatch.check}} check is off by {{mismatch.difference}}.', subject: 'Reconciliation mismatch', button: 'Open finance checks' } }),
  st('seller.application_submitted', { group: 'Sellers', label: 'New seller application', opens: 'Application', triggers: ['sellers.application.submitted'], roles: ['seller_manager'], action: true, icon: 'store',
    t: { title: 'New seller application', body: 'A new seller application is waiting for review.', subject: 'New seller application', button: 'Review application' } }),
  st('moderation.report', { group: 'Content', label: 'Reported content', opens: 'Moderation queue', triggers: ['reviews.report.created'], roles: ['content_manager'], action: true, icon: 'flag', tone: 'warning',
    t: { title: 'Reported content', body: 'Content was reported ({{report.type}}). Review it in the moderation queue.', subject: 'Reported content to review', button: 'Open moderation queue' } }),
  st('trust.report', { group: 'Trust', label: 'New risk report', opens: 'Trust report', triggers: ['trust.report.created'], roles: ['trust_and_risk_manager'], action: true, icon: 'shield-alert', tone: 'warning',
    t: { title: 'New risk report {{report.ref}}', body: 'A new {{report.type}} report needs review.', subject: 'New risk report {{report.ref}}', button: 'Open report' } }),
  st('advertising.approval_waiting', { group: 'Advertising', label: 'Campaign waiting for approval', opens: 'Campaign review', triggers: ['advertising.campaign.status_changed'], roles: ['advertising_manager', 'content_manager'], action: true, icon: 'megaphone',
    t: { title: 'Sponsored campaign waiting for approval', body: 'A sponsored campaign is waiting for review.', subject: 'Sponsored campaign waiting for approval', button: 'Review campaign' } }),
  st('queue.item_overdue', { group: 'Operations', label: 'Overdue work item', opens: 'Work queue', triggers: ['workqueues.item.overdue'], action: true, urgent: true, icon: 'clock', tone: 'danger',
    t: { title: 'Overdue: {{queue.item}}', body: 'An item in {{queue.name}} is overdue (due {{due.date}}).', subject: 'Overdue work item {{queue.item}}', button: 'Open queue' } }),
  st('queue.item_escalated', { group: 'Operations', label: 'Escalated work item', opens: 'Work queue', triggers: ['workqueues.item.escalated'], action: true, icon: 'arrow-up-circle', tone: 'warning',
    t: { title: 'Escalated to you: {{queue.name}}', body: 'A work item was escalated: {{escalation.reason}}.', subject: 'Work item escalated to you', button: 'Open queue' } }),
  st('audit.integrity_failed', { group: 'Platform', label: 'Integrity alert', opens: 'Action history', triggers: ['audit.integrity.failed'], roles: ['platform_administrator', 'business_owner'], action: true, urgent: true, icon: 'alert-octagon', tone: 'danger',
    t: { title: 'Action history integrity check failed', body: 'The action history chain is broken at entry {{integrity.seq}}. Investigate now.', subject: 'URGENT: action history integrity check failed', button: 'Open action history' } }),
  st('security.account_locked', { group: 'Platform', label: 'Staff account locked', opens: 'Staff member', triggers: ['identity.account.locked'], roles: ['platform_administrator'], icon: 'lock', tone: 'warning',
    t: { title: 'A staff account was locked', body: 'A staff account was locked ({{lock.until}}).', subject: 'A staff account was locked', button: 'Open staff member' } }),
  st('account.password_reset', { group: 'Security', label: 'Staff password reset link', opens: 'Reset password', triggers: ['identity.password_reset.requested'], supports: EMAIL_ONLY, sensitive: true, icon: 'key',
    t: { title: 'Reset your staff password', body: 'Use this link to choose a new password: {{reset.url}}', subject: 'Reset your Marketly staff password', button: 'Reset password' } }),
  st('account.invitation', { group: 'Security', label: 'Staff invitation', opens: 'Accept invitation', triggers: ['identity.invitation.created'], supports: EMAIL_ONLY, sensitive: true, icon: 'user-plus',
    t: { title: 'Join the Marketly team', body: '{{invite.by}} invited you to Marketly Admin Center. Accept: {{invite.url}}', subject: "You're invited to Marketly Admin Center", button: 'Accept invitation' } }),
  st('account.password_changed', { group: 'Security', label: 'Password changed', opens: 'Security', triggers: ['identity.password.changed'], urgent: true, icon: 'shield', tone: 'warning',
    t: { title: 'Your password was changed', body: "Your staff password was changed. If this wasn't you, contact the Platform Administrator.", subject: 'Your Marketly staff password was changed', button: 'Review security' } }),
  st('account.new_device', { group: 'Security', label: 'New sign-in', opens: 'Security', triggers: ['identity.session.new_device'], urgent: true, icon: 'smartphone', tone: 'warning',
    t: { title: 'New sign-in on {{device.label}}', body: "Your staff account was signed in on {{device.label}} ({{device.location}}).", subject: 'New sign-in to your staff account', button: 'Review security' } }),
  st('account.two_step_changed', { group: 'Security', label: '2-step verification changed', opens: 'Security', triggers: ['identity.two_step.changed'], urgent: true, icon: 'shield',
    t: { title: '2-step verification {{twostep.state}}', body: '2-step verification was {{twostep.state}} on your staff account.', subject: '2-step verification was {{twostep.state}}', button: 'Review security' } }),
  st('account.locked', { group: 'Security', label: 'Account locked', opens: 'Security', triggers: ['identity.account.locked'], urgent: true, icon: 'lock', tone: 'danger',
    t: { title: 'Your staff account was locked', body: 'Your staff account was locked until {{lock.until}}.', subject: 'Your staff account was locked', button: 'Review security' } }),
  st('account.email_changed', { group: 'Security', label: 'Email address changed', opens: 'Security', triggers: ['identity.email.changed'], urgent: true, icon: 'mail', tone: 'warning',
    t: { title: 'Your email address was changed', body: 'The email address of your staff account changed from {{email.old}} to {{email.new}}.', subject: 'Your staff email address was changed', button: 'Review security' } }),
  st('export.ready', { group: 'Reports', label: 'Export ready', opens: 'Exports', triggers: ['reports.export.ready'], icon: 'download',
    t: { title: 'Your export is ready', body: 'Your export is ready to download until {{export.expires}}.', subject: 'Your export is ready', button: 'Download' } }),
  st('mention', { group: 'Operations', label: 'Mention', opens: 'Record', icon: 'at-sign',
    t: { title: '{{mention.by}} mentioned you', body: '{{mention.text}}', subject: '{{mention.by}} mentioned you', button: 'Open' } }),
  st('digest.daily', { group: 'Operations', label: 'Daily digest', opens: 'Inbox', triggers: ['scheduled'], supports: EMAIL_ONLY, icon: 'inbox',
    t: { title: 'Your daily summary', body: 'You have {{digest.count}} unread notices: {{digest.lines}}', subject: 'Your Marketly daily summary ({{digest.count}})', button: 'Open inbox' } }),
];

const BY_KEY = new Map(TOPICS.map((t) => [t.key, t]));
export const topicDef = (key: string): TopicDef | undefined => BY_KEY.get(key);

/** Variables a topic's templates may use, with examples (TemplateVariable[]) */
export function topicVariables(t: TopicDef): TemplateVariable[] {
  const required = new Set<string>(t.supports.some((c) => c === 'email' || c === 'sms') ? ['link.url'] : []);
  if (t.category === 'promotional' && t.supports.includes('email')) required.add('unsubscribe.url');
  const out: TemplateVariable[] = Object.entries(STANDARD_VARIABLES).map(([name, v]) => ({ name, desc: v.desc, example: v.example, required: required.has(name) }));
  if (t.category === 'promotional') out.push({ name: 'unsubscribe.url', desc: 'One-click unsubscribe link', example: VARIABLE_EXAMPLES['unsubscribe.url']!, required: required.has('unsubscribe.url') });
  for (const name of t.vars) out.push({ name, desc: describe(name), example: VARIABLE_EXAMPLES[name] ?? name, required: false });
  return out;
}

const describe = (name: string) => name.split('.').map((p) => p.replace(/([A-Z])/g, ' $1').toLowerCase()).join(' ');

/** Sample context for previews: every variable filled with its example */
export function sampleContext(t: TopicDef): Record<string, unknown> {
  const ctx: Record<string, unknown> = {};
  for (const v of topicVariables(t)) setPath(ctx, v.name, v.example);
  return ctx;
}

export function setPath(obj: Record<string, unknown>, path: string, value: unknown) {
  const parts = path.split('.');
  let node = obj;
  for (const p of parts.slice(0, -1)) {
    if (typeof node[p] !== 'object' || node[p] === null) node[p] = {};
    node = node[p] as Record<string, unknown>;
  }
  node[parts.at(-1)!] = value;
}

/** Default template content of a topic for one channel (seeded as version 1) */
export function defaultContent(t: TopicDef, channel: Channel, senders: Record<string, string>): TemplateContent {
  const { title, body, subject, button } = t.template;
  const promo = t.category === 'promotional';
  switch (channel) {
    case 'email':
      return {
        subject: subject ?? title,
        preheader: body.length > 90 ? `${body.slice(0, 87)}…` : body,
        title,
        body: promo ? `${body}\n\nUnsubscribe: {{unsubscribe.url}}` : body,
        button: { label: button ?? 'Open', url: '{{link.url}}' },
        sender: senders[t.family] ?? null,
        allowPromotionalContent: promo,
      };
    case 'sms':
      // codes and links are the message itself; other texts carry the title and the link
      return { title: null, body: `Marketly: ${t.sensitive ? body : `${title}.`} {{link.url}}${promo ? ' Reply STOP to opt out.' : ''}`, allowPromotionalContent: promo };
    case 'push':
      return { title, body: body.length > 140 ? `${body.slice(0, 137)}…` : body, allowPromotionalContent: promo };
    case 'in_app':
      return { title, body, allowPromotionalContent: promo };
  }
}

/** Channels with a template (in-app, email and the later-phase channels the topic supports) */
export const templateChannels = (t: TopicDef): Channel[] => CHANNELS.filter((c) => t.supports.includes(c));
