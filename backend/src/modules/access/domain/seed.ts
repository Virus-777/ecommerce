/**
 * Seeded system roles, their permission sets and example approval limits (docs/03-auth-middleware.md §14,
 * access spec notes). Seeded limits are the prototype's example values; the Business Owner confirms them.
 * Pure data and pure helpers: no I/O.
 */
import type { LimitValue } from '../../../spec/access.js';

export const BUSINESS_OWNER = 'business_owner';
export const PLATFORM_ADMINISTRATOR = 'platform_administrator';

export type SeedKind = 'owner' | 'management' | 'task';

export interface SeedRole {
  key: string;
  name: string;
  kind: SeedKind;
  workArea: string;
  description: string;
  escalationRoleKey?: string;
  /** Exact keys, `module.*` / `module.resource.*` wildcards, or `*.view` (every staff view key); `!key` removes */
  permissions: string[];
  /** Example limits: actionKey → value (money in USD minor units) */
  limits: Record<string, Partial<LimitValue> & { authority: LimitValue['authority'] }>;
}

const usd = (dollars: number) => ({ amount: dollars * 100, currency: 'USD' });
const upTo = (dollars: number, extra: Partial<LimitValue> = {}) => ({ authority: 'permitted' as const, limitMoney: usd(dollars), ...extra });
const PERMITTED = { authority: 'permitted' as const };
/** May propose a Business-Owner-only action: check() answers approval_required (not denied) and the proposal becomes a Business Owner request (access spec notes, Seeded limits) */
const RECOMMEND = { authority: 'recommend_only' as const };
/** Every staff role also works its own queues */
const QUEUES = ['workqueues.items.view', 'workqueues.items.work'];
/** Owner teams accept or decline Trust and Risk's recommendations for the actions they own (trust spec: trust.recommendations.decide); Trust recommends, the owner acts */
const OWNER_DECIDES = 'trust.recommendations.decide';
/** Fulfilled by Marketly staff keys (fulfillment-service, phase 4; access spec notes). Installs seeded before them get them from migration 0004. */
const FS_REVIEW = 'fulfillment-service.enrollment.review';
const FS_RECEIVE = 'fulfillment-service.inbound.receive';
const FS_OPERATIONS = 'fulfillment-service.operations.view';
const FS_FEES = 'fulfillment-service.fees.manage';
/**
 * Staff uploads (media spec: POST /api/admin/media/uploads and its content and complete steps). Every role whose work
 * attaches files gets it: inspection, damage and receiving photos, case, trust and dispute evidence, Official Store,
 * content and ad files. It only starts uploads: editing and deleting platform files stay with media.assets.manage, and
 * attaching a file still needs the permission of the screen that uses it. Installs seeded before it get it from access
 * migration 2026-10-17-staff-work-uploads.
 */
export const STAFF_UPLOADS = 'media.uploads.create';
/** The Marketing Manager searches offers when adding flash-sale items (Admin › Promotions); installs seeded before it get it from the same migration */
export const MARKETING_OFFERS_VIEW = 'offers.offers.view';

export const SYSTEM_ROLES: SeedRole[] = [
  {
    key: BUSINESS_OWNER,
    name: 'Business Owner',
    kind: 'owner',
    workArea: 'Business',
    description: 'Sets approval limits and is the final approver above every limit.',
    permissions: ['*.view', 'access.limits.approve', 'access.limits.propose', 'access.approvals.view-all', 'audit.entries.*', 'audit.retention.manage', STAFF_UPLOADS, ...QUEUES],
    limits: {}, // permitted without limit for every registered action (added by the registry sync)
  },
  {
    key: PLATFORM_ADMINISTRATOR,
    name: 'Platform Administrator',
    kind: 'management',
    workArea: 'Settings',
    description: 'Staff accounts, roles, settings and notification templates. No financial authority.',
    escalationRoleKey: BUSINESS_OWNER,
    permissions: [
      'access.roles.view',
      'access.roles.manage',
      'access.away.manage',
      'access.limits.propose',
      'identity.staff-accounts.manage',
      'identity.accounts.view',
      'settings.view',
      'settings.changes.propose',
      'settings.flags.manage',
      'notifications.templates.*',
      'notifications.routing.manage',
      // reads the action history: told when the hash-chain check fails, and proposes retention changes
      'audit.entries.view',
      // may propose shortening the retention period (the Business Owner approves audit.retention.change)
      'audit.retention.manage',
      ...QUEUES,
    ],
    limits: {
      'access.roles.sensitive-grant': PERMITTED,
      'settings.changes.apply': { authority: 'permitted_with_second_review', secondReviewerRoleKeys: [PLATFORM_ADMINISTRATOR, BUSINESS_OWNER] },
      'settings.changes.apply-owner': RECOMMEND,
      'audit.retention.change': RECOMMEND,
      'access.limits.change': RECOMMEND,
      'access.delegations.approve': RECOMMEND,
    },
  },
  {
    key: 'official_store_manager',
    name: 'Official Store Manager',
    kind: 'management',
    workArea: 'Official store',
    description: 'Company offers and official store prices.',
    escalationRoleKey: BUSINESS_OWNER,
    permissions: ['offers.official.manage', 'offers.official.price', 'catalog.products.manage-official', 'inventory.stock.view', 'purchasing.orders.view', STAFF_UPLOADS, ...QUEUES],
    limits: { 'offers.prices.change': { authority: 'permitted', limitNumber: 30 } },
  },
  {
    key: 'purchasing_manager',
    name: 'Purchasing Manager',
    kind: 'management',
    workArea: 'Official store',
    description: 'Suppliers, purchase orders, receipts and supplier claims.',
    escalationRoleKey: BUSINESS_OWNER,
    permissions: ['purchasing.*', STAFF_UPLOADS, ...QUEUES],
    limits: { 'purchasing.orders.send': upTo(25_000) },
  },
  {
    key: 'inventory_manager',
    name: 'Inventory Manager',
    kind: 'management',
    workArea: 'Inventory and warehouse',
    description: 'Stock groups, adjustments, transfers and counts.',
    escalationRoleKey: BUSINESS_OWNER,
    permissions: ['inventory.*', FS_OPERATIONS, ...QUEUES],
    limits: { 'inventory.adjustments.apply': { authority: 'permitted', limitNumber: 50 } },
  },
  {
    key: 'warehouse_manager',
    name: 'Warehouse Manager',
    kind: 'management',
    workArea: 'Inventory and warehouse',
    description: 'Warehouse bins, waves, picking, packing and put-away.',
    escalationRoleKey: BUSINESS_OWNER,
    permissions: ['warehouse.*', 'inventory.stock.view', 'inventory.discrepancies.resolve', FS_RECEIVE, FS_OPERATIONS, STAFF_UPLOADS, ...QUEUES],
    limits: { 'fulfillment-service.reimbursements.approve': upTo(500) },
  },
  {
    key: 'order_manager',
    name: 'Order Manager',
    kind: 'management',
    workArea: 'Orders and shipping',
    description: 'Orders, cancellations and order exceptions.',
    escalationRoleKey: BUSINESS_OWNER,
    permissions: ['orders.orders.*', 'orders.cancellations.decide', 'cart.carts.view', 'checkout.sessions.view', FS_OPERATIONS, OWNER_DECIDES, ...QUEUES],
    limits: {},
  },
  {
    key: 'shipping_manager',
    name: 'Shipping Manager',
    kind: 'management',
    workArea: 'Orders and shipping',
    description: 'Shipping settings, shipments, delivery exceptions and carrier claims.',
    escalationRoleKey: BUSINESS_OWNER,
    permissions: ['shipping.*', STAFF_UPLOADS, ...QUEUES],
    limits: { 'shipping.claims.open': upTo(1_000) },
  },
  {
    key: 'returns_manager',
    name: 'Returns Manager',
    kind: 'management',
    workArea: 'Returns and cases',
    description: 'Return requests, inspections and return policies. Refund approval belongs to Finance.',
    escalationRoleKey: BUSINESS_OWNER,
    permissions: ['returns.requests.*', 'returns.inspections.record', 'returns.exceptions.propose', 'returns.policies.manage', 'inventory.returns.record', FS_RECEIVE, OWNER_DECIDES, STAFF_UPLOADS, ...QUEUES],
    limits: { 'returns.baseline.change': RECOMMEND, 'returns.policies.shorten-window': RECOMMEND },
  },
  {
    key: 'catalog_manager',
    name: 'Catalog Manager',
    kind: 'management',
    workArea: 'Catalog',
    description: 'Product review and publication, taxonomy, media and search synonyms.',
    escalationRoleKey: BUSINESS_OWNER,
    // offers.offers.remove: Catalog owns offer suspension (decision D8)
    permissions: ['catalog.*', 'media.assets.*', STAFF_UPLOADS, 'search.synonyms.manage', 'reviews.answers.staff', 'offers.offers.view', 'offers.offers.remove', OWNER_DECIDES, ...QUEUES],
    limits: { 'catalog.products.publication-override': PERMITTED },
  },
  {
    key: 'seller_manager',
    name: 'Seller Manager',
    kind: 'management',
    workArea: 'Sellers',
    description: 'Seller applications, accounts, performance and restrictions.',
    escalationRoleKey: BUSINESS_OWNER,
    permissions: ['sellers.*', 'offers.offers.view', 'offers.offers.remove', FS_REVIEW, OWNER_DECIDES, ...QUEUES],
    limits: {
      'sellers.sellers.restrict': PERMITTED,
      'sellers.sellers.suspend': PERMITTED,
      'sellers.sellers.close': PERMITTED,
      'sellers.performance.targets': PERMITTED,
    },
  },
  {
    key: 'customer_support_manager',
    name: 'Customer Support Manager',
    kind: 'management',
    workArea: 'Customers and support',
    description: 'Support cases, customer accounts and messaging.',
    escalationRoleKey: BUSINESS_OWNER,
    permissions: ['support.*', 'customers.*', '!customers.accounts.export', 'messaging.*', 'orders.orders.view', 'orders.customers.view-contact', 'returns.requests.view', 'wallet.credit.view', 'wallet.goodwill.grant', OWNER_DECIDES, STAFF_UPLOADS, ...QUEUES],
    limits: {
      'support.remedies.approve': upTo(500),
      'wallet.goodwill.grant': upTo(50),
      'customers.accounts.close-with-obligations': PERMITTED,
    },
  },
  {
    key: 'finance_manager',
    name: 'Finance Manager',
    kind: 'management',
    workArea: 'Finance',
    description: 'Ledger, payouts, holds, adjustments, payments and refunds.',
    escalationRoleKey: BUSINESS_OWNER,
    permissions: ['finance.*', 'payments.*', 'returns.refunds.approve', 'returns.requests.view', 'reports.marketplace-finance.view', 'reports.trading.view', 'wallet.*', FS_FEES, OWNER_DECIDES, STAFF_UPLOADS, ...QUEUES],
    limits: {
      'finance.payouts.release': upTo(250_000, { secondReviewerAboveMoney: usd(50_000), secondReviewerRoleKeys: ['finance_manager', BUSINESS_OWNER] }),
      'finance.holds.place': upTo(50_000),
      'finance.holds.release': upTo(50_000),
      'finance.adjustments.record': upTo(10_000),
      'finance.writeoffs.approve': upTo(10_000),
      'finance.credits.issue': upTo(10_000),
      'finance.destinations.approve': PERMITTED,
      'finance.reconciliation.correct': upTo(5_000),
      'payments.disputes.accept': upTo(10_000),
      'returns.refunds.approve': upTo(10_000),
      'advertising.charges.void': upTo(10_000),
      'shipping.claims.open': upTo(10_000),
      'wallet.gift-cards.issue': upTo(1_000),
      'wallet.goodwill.grant': upTo(2_000),
      'wallet.credit.correct': upTo(2_000),
      'support.remedies.approve': upTo(2_000),
      'promotions.budgets.approve': upTo(25_000, { secondReviewerAboveMoney: usd(10_000), secondReviewerRoleKeys: ['finance_manager', BUSINESS_OWNER] }),
      'fulfillment-service.reimbursements.approve': upTo(10_000),
      'fulfillment-service.charges.reverse': upTo(10_000),
      'inventory.adjustments.apply': { authority: 'permitted', limitNumber: 500 },
      'finance.fees.change': RECOMMEND,
    },
  },
  {
    key: 'marketing_manager',
    name: 'Marketing Manager',
    kind: 'management',
    workArea: 'Marketing and content',
    description: 'Promotions, homepage and marketing broadcasts.',
    escalationRoleKey: BUSINESS_OWNER,
    permissions: ['promotions.*', 'content.homepage.manage', 'reports.customers-marketing.view', 'notifications.broadcasts.manage', 'advertising.campaigns.review', MARKETING_OFFERS_VIEW, STAFF_UPLOADS, ...QUEUES],
    limits: { 'promotions.budgets.approve': upTo(5_000) },
  },
  {
    key: 'advertising_manager',
    name: 'Advertising Manager',
    kind: 'management',
    workArea: 'Advertising',
    description: 'Ad campaigns, placements, rules and billing.',
    escalationRoleKey: BUSINESS_OWNER,
    permissions: ['advertising.*', STAFF_UPLOADS, ...QUEUES],
    limits: { 'advertising.charges.void': upTo(500), 'advertising.rules.change': RECOMMEND },
  },
  {
    key: 'content_manager',
    name: 'Content Manager',
    kind: 'management',
    workArea: 'Marketing and content',
    description: 'Pages, help center and policies (policies approved by the Business Owner).',
    escalationRoleKey: BUSINESS_OWNER,
    permissions: ['content.*', 'media.assets.manage', STAFF_UPLOADS, 'advertising.campaigns.review', ...QUEUES],
    limits: { 'content.policies.approve': RECOMMEND, 'content.policies.short-notice': RECOMMEND },
  },
  {
    key: 'trust_and_risk_manager',
    name: 'Trust and Risk Manager',
    kind: 'management',
    workArea: 'Trust and risk',
    description: 'Reports, investigations, enforcements, review moderation and appeals.',
    escalationRoleKey: BUSINESS_OWNER,
    permissions: ['trust.*', '!trust.reports.export-identities', 'reviews.moderation.*', 'reviews.appeals.decide', STAFF_UPLOADS, ...QUEUES],
    limits: { 'trust.enforcements.reverse': PERMITTED, 'catalog.products.publication-override': PERMITTED },
  },
  {
    key: 'reports_analyst',
    name: 'Reports Analyst',
    kind: 'management',
    workArea: 'Reports',
    description: 'Reports, exports and schedules.',
    escalationRoleKey: BUSINESS_OWNER,
    permissions: ['reports.*', '!reports.readmodels.manage', 'search.analytics.view', ...QUEUES],
    limits: {},
  },
  {
    key: 'warehouse_worker',
    name: 'Warehouse Worker',
    kind: 'task',
    workArea: 'Inventory and warehouse',
    description: 'Picking, packing, put-away and receiving returns.',
    escalationRoleKey: 'warehouse_manager',
    permissions: ['warehouse.view', 'warehouse.picking.perform', 'warehouse.packing.perform', 'warehouse.putaway.perform', 'warehouse.returns.receive', FS_RECEIVE, STAFF_UPLOADS, ...QUEUES],
    limits: {},
  },
  {
    key: 'finance_staff',
    name: 'Finance Staff',
    kind: 'task',
    workArea: 'Finance',
    description: 'Reconciliation, payout preparation, holds, adjustments and refund approval within limits.',
    escalationRoleKey: 'finance_manager',
    permissions: [
      'finance.ledger.view',
      'finance.reconciliation.work',
      'finance.payouts.prepare',
      'finance.holds.manage',
      'finance.adjustments.record',
      'payments.refunds.view',
      'returns.refunds.approve',
      'returns.requests.view', // to see the refund requests it approves
      ...QUEUES,
    ],
    limits: {
      'finance.holds.place': upTo(5_000),
      'finance.holds.release': upTo(5_000),
      'finance.adjustments.record': upTo(500),
      'finance.reconciliation.correct': upTo(200),
      'finance.credits.issue': upTo(2_000),
      'finance.destinations.approve': PERMITTED,
      'payments.disputes.accept': upTo(1_000),
      'returns.refunds.approve': upTo(2_000, { secondReviewerAboveMoney: usd(1_000), secondReviewerRoleKeys: ['finance_staff', 'finance_manager', BUSINESS_OWNER] }),
      'wallet.credit.correct': upTo(200),
    },
  },
  {
    key: 'support_agent',
    name: 'Support Agent',
    kind: 'task',
    workArea: 'Customers and support',
    description: 'Support cases, customer notes and conversations.',
    escalationRoleKey: 'customer_support_manager',
    permissions: ['support.cases.view', 'support.cases.handle', 'customers.accounts.view', 'customers.notes.write', 'messaging.conversations.read', 'messaging.conversations.participate', 'orders.orders.view', 'wallet.credit.view', 'wallet.goodwill.grant', STAFF_UPLOADS, ...QUEUES],
    limits: { 'support.remedies.approve': upTo(50), 'wallet.goodwill.grant': upTo(50) },
  },
];

/**
 * G77: read-only keys for admin pages that were gated by manage keys. A role holding any key under the prefix (e.g.
 * returns.inspections.record) also holds the view key, so nobody loses a screen when the reads move to it.
 */
export const VIEW_COMPANIONS: Readonly<Record<string, string>> = {
  'catalog.view': 'catalog.',
  'content.view': 'content.',
  'offers.official.view': 'offers.official.',
  'sellers.applications.view': 'sellers.applications.',
  'returns.inspections.view': 'returns.inspections.',
};

/** The companion view keys (among `available`) a role holding `held` should also hold */
export function viewCompanions(held: readonly string[], available: readonly string[]): string[] {
  return Object.entries(VIEW_COMPANIONS)
    .filter(([view, prefix]) => available.includes(view) && !held.includes(view) && held.some((k) => k !== view && k.startsWith(prefix)))
    .map(([view]) => view);
}

/** Expands a seed permission list against the registry's staff keys (with the G77 companion view keys). */
export function expandPermissions(patterns: readonly string[], staffKeys: readonly string[]): string[] {
  const out = new Set<string>();
  const matches = (p: string, key: string) => {
    if (p === '*.view') return key.endsWith('.view');
    if (p.endsWith('.*')) return key.startsWith(p.slice(0, -1));
    return key === p;
  };
  for (const p of patterns.filter((x) => !x.startsWith('!'))) for (const k of staffKeys) if (matches(p, k)) out.add(k);
  for (const p of patterns.filter((x) => x.startsWith('!'))) for (const k of [...out]) if (matches(p.slice(1), k)) out.delete(k);
  for (const view of viewCompanions([...out], staffKeys)) out.add(view);
  return [...out].sort();
}

/** Who may approve each declared action by default (from the approvers text of each spec). */
export const DEFAULT_ELIGIBLE: Record<string, string[]> = {
  'access.limits.change': [BUSINESS_OWNER],
  'access.roles.sensitive-grant': [PLATFORM_ADMINISTRATOR, BUSINESS_OWNER],
  'access.delegations.approve': [BUSINESS_OWNER],
  'advertising.rules.change': [BUSINESS_OWNER],
  'advertising.charges.void': ['advertising_manager', 'finance_manager'],
  'audit.retention.change': [BUSINESS_OWNER],
  'catalog.products.publication-override': ['catalog_manager', 'trust_and_risk_manager'],
  'content.policies.approve': [BUSINESS_OWNER],
  'content.policies.short-notice': [BUSINESS_OWNER],
  'customers.accounts.close-with-obligations': ['customer_support_manager', BUSINESS_OWNER],
  'finance.fees.change': [BUSINESS_OWNER],
  'finance.holds.place': ['finance_staff', 'finance_manager', BUSINESS_OWNER],
  'finance.holds.release': ['finance_staff', 'finance_manager'],
  'finance.adjustments.record': ['finance_staff', 'finance_manager'],
  'finance.writeoffs.approve': ['finance_manager', BUSINESS_OWNER],
  'finance.payouts.release': ['finance_manager', BUSINESS_OWNER],
  'finance.destinations.approve': ['finance_manager', 'finance_staff'],
  'finance.reconciliation.correct': ['finance_staff', 'finance_manager'],
  'fulfillment-service.reimbursements.approve': ['warehouse_manager', 'finance_manager'],
  'fulfillment-service.fees.change': [BUSINESS_OWNER],
  'fulfillment-service.charges.reverse': ['finance_manager'],
  'inventory.adjustments.apply': ['inventory_manager', 'finance_manager', BUSINESS_OWNER],
  'offers.prices.change': ['official_store_manager', BUSINESS_OWNER],
  'payments.disputes.accept': ['finance_staff', 'finance_manager'],
  'promotions.budgets.approve': ['marketing_manager', 'finance_manager', BUSINESS_OWNER],
  'purchasing.orders.send': ['purchasing_manager', BUSINESS_OWNER],
  'returns.refunds.approve': ['finance_staff', 'finance_manager', BUSINESS_OWNER],
  'returns.baseline.change': [BUSINESS_OWNER],
  'returns.policies.shorten-window': [BUSINESS_OWNER],
  'sellers.sellers.restrict': ['seller_manager', BUSINESS_OWNER],
  'sellers.sellers.suspend': ['seller_manager', BUSINESS_OWNER],
  'sellers.sellers.close': ['seller_manager', BUSINESS_OWNER],
  'sellers.performance.targets': ['seller_manager', BUSINESS_OWNER],
  'settings.changes.apply': [PLATFORM_ADMINISTRATOR, BUSINESS_OWNER],
  'settings.changes.apply-owner': [BUSINESS_OWNER],
  'shipping.claims.open': ['shipping_manager', 'finance_manager'],
  'support.remedies.approve': ['support_agent', 'customer_support_manager', 'finance_manager'],
  'trust.enforcements.reverse': ['trust_and_risk_manager', BUSINESS_OWNER],
  'wallet.goodwill.grant': ['support_agent', 'customer_support_manager', 'finance_manager'],
  'wallet.credit.correct': ['finance_staff', 'finance_manager'],
  'wallet.gift-cards.issue': ['finance_manager'],
};

/** Default approvers of an action: the table above, else the system role names found in its approvers text. */
export function defaultEligibleRoleKeys(actionKey: string, approvers: string | undefined): string[] {
  const known = DEFAULT_ELIGIBLE[actionKey];
  if (known) return known;
  const text = (approvers ?? '').toLowerCase();
  return SYSTEM_ROLES.filter((r) => text.includes(r.name.toLowerCase())).map((r) => r.key);
}

/** Grouping on the role editor */
export const MODULE_AREAS: Record<string, string> = {
  access: 'Staff and access',
  identity: 'Staff and access',
  audit: 'Audit',
  settings: 'Settings',
  notifications: 'Notifications',
  reports: 'Reports',
  workqueues: 'Work queues',
  customers: 'Customers and support',
  support: 'Customers and support',
  messaging: 'Customers and support',
  sellers: 'Sellers',
  catalog: 'Catalog and offers',
  media: 'Catalog and offers',
  search: 'Catalog and offers',
  offers: 'Catalog and offers',
  purchasing: 'Official store',
  inventory: 'Inventory and warehouse',
  warehouse: 'Inventory and warehouse',
  'fulfillment-service': 'Inventory and warehouse',
  orders: 'Orders and shipping',
  shipping: 'Orders and shipping',
  cart: 'Orders and shipping',
  checkout: 'Orders and shipping',
  payments: 'Finance',
  finance: 'Finance',
  wallet: 'Finance',
  returns: 'Returns and cases',
  reviews: 'Trust and reviews',
  trust: 'Trust and reviews',
  promotions: 'Marketing and content',
  content: 'Marketing and content',
  wishlist: 'Marketing and content',
  advertising: 'Advertising',
};

export const areaOf = (module: string) => MODULE_AREAS[module] ?? 'Other';

const words = (s: string) => s.replace(/[-_]/g, ' ');
const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

/** "finance.payouts.approve" → "Approve payouts"; "warehouse.view" → "View warehouse" */
export function permissionLabel(key: string): string {
  const parts = key.split('.');
  if (parts.length < 3) return cap(`${words(parts[1] ?? '')} ${words(parts[0] ?? '')}`.trim());
  const [, resource, ...action] = parts;
  return cap(`${words(action.join(' '))} ${words(resource!)}`);
}

/** "returns.refunds.approve" → "Refunds" (short noun for limit summaries) */
export const actionNoun = (key: string) => cap(words(key.split('.')[1] ?? key));

/** "Trust & Ops" → "trust_ops" */
export const slugKey = (name: string) =>
  name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60) || 'role';
