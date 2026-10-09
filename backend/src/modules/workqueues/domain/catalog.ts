/**
 * Queue catalogue: the definitions installed for the spec setting `seedQueues` (plus the queues the
 * intake table needs), area labels, the Seller Center screen per kind and the placeholders used until a
 * queue has a real lead and backup (plan ch. 2: every queue has a named lead, a different backup and an
 * escalation route; launch readiness requires real people).
 */
import type { EscalationStep, QueueDefinition, WorkItem } from '../../../spec/workqueues.js';

export type Area = QueueDefinition['area'];
export type Kind = WorkItem['kind'];
export type Priority = WorkItem['priority'];
export type ItemState = WorkItem['state'];

export const AREAS: readonly Area[] = ['orders_shipping', 'inventory_warehouse', 'purchasing', 'returns', 'support', 'finance', 'catalog', 'sellers', 'trust', 'marketing_ads', 'content', 'platform'];

export const AREA_LABELS: Record<Area, string> = {
  orders_shipping: 'Order & Shipping',
  inventory_warehouse: 'Inventory & Warehouse',
  purchasing: 'Purchasing',
  returns: 'Returns',
  support: 'Customer Support',
  finance: 'Finance',
  catalog: 'Catalog',
  sellers: 'Sellers',
  trust: 'Trust & Risk',
  marketing_ads: 'Marketing & Ads',
  content: 'Content',
  platform: 'Platform',
};

export const isArea = (s: unknown): s is Area => typeof s === 'string' && (AREAS as readonly string[]).includes(s);

/** Readable names of access role keys (escalation labels when a step names no person) */
export const ROLE_LABELS: Record<string, string> = {
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
  trust_and_risk_manager: 'Trust & Risk Manager',
  reports_analyst: 'Reports Analyst',
};

export const roleLabel = (key: string) => ROLE_LABELS[key] ?? key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/**
 * Placeholder lead and backup of a seeded queue whose owner role has no lead or backup in access yet.
 * Two different ids so a fresh install satisfies "backup differs from lead"; coverage gaps report them
 * as no_lead / no_backup until real people are set.
 */
export const PLACEHOLDER_LEAD = '00000000-0000-4000-8000-00000000000a';
export const PLACEHOLDER_BACKUP = '00000000-0000-4000-8000-00000000000b';
export const isPlaceholder = (id: string | null | undefined) => id === PLACEHOLDER_LEAD || id === PLACEHOLDER_BACKUP;

/** updated_by of rows written by the system (seeding, coverage refresh): lead and backup follow access */
export const SYSTEM_UPDATED_BY = 'system';

export interface QueueSeed {
  key: string;
  name: string;
  area: Area;
  ownerRole: string;
  defaultDeadlineMinutes: number;
  businessHoursOnly: boolean;
  screen: string;
  screenFilter: string | null;
  visibleToSeller: boolean;
  escalationRoute: EscalationStep[];
}

const role = (key: string, afterMinutes: number, condition?: string): EscalationStep => ({
  afterMinutes,
  to: { kind: 'role', key, name: roleLabel(key) },
  ...(condition ? { condition } : {}),
  notify: true,
});

const H = 60;
const D = 24 * H;
const OWNER = 'business_owner';

const seed = (s: Omit<QueueSeed, 'screenFilter' | 'visibleToSeller' | 'businessHoursOnly'> & Partial<Pick<QueueSeed, 'screenFilter' | 'visibleToSeller' | 'businessHoursOnly'>>): QueueSeed => ({
  screenFilter: null,
  visibleToSeller: false,
  businessHoursOnly: false,
  ...s,
});

/** Every queue the module knows how to install. `seedQueues` picks which are created at install. */
export const QUEUE_SEEDS: Record<string, QueueSeed> = Object.fromEntries(
  [
    seed({ key: 'shipping.overdue_dispatch', name: 'Overdue dispatch', area: 'orders_shipping', ownerRole: 'shipping_manager', defaultDeadlineMinutes: 4 * H, screen: 'ops/dispatch', screenFilter: 'overdue', visibleToSeller: true, escalationRoute: [role('seller_manager', 0, 'seller items only'), role('order_manager', 4 * H), role(OWNER, 2 * D)] }),
    seed({ key: 'shipping.missing_tracking', name: 'Missing tracking', area: 'orders_shipping', ownerRole: 'shipping_manager', defaultDeadlineMinutes: D, screen: 'ops/dispatch', screenFilter: 'missing_tracking', visibleToSeller: true, escalationRoute: [role('seller_manager', 0, 'seller items only'), role(OWNER, 2 * D)] }),
    seed({ key: 'shipping.delivery_exceptions', name: 'Delivery exceptions', area: 'orders_shipping', ownerRole: 'shipping_manager', defaultDeadlineMinutes: 8 * H, screen: 'ops/dispatch', screenFilter: 'exceptions', escalationRoute: [role('order_manager', 0), role(OWNER, D)] }),
    seed({ key: 'orders.seller_cannot_fulfill', name: 'Seller cannot fulfill', area: 'orders_shipping', ownerRole: 'order_manager', defaultDeadlineMinutes: 4 * H, screen: 'admin/orders', screenFilter: 'cannot_fulfill', visibleToSeller: true, escalationRoute: [role('seller_manager', 0, 'seller items only'), role(OWNER, D)] }),
    seed({ key: 'warehouse.pick_pack', name: 'Pick and pack', area: 'inventory_warehouse', ownerRole: 'warehouse_manager', defaultDeadlineMinutes: 4 * H, screen: 'ops/pick-pack', escalationRoute: [role('official_store_manager', 0), role(OWNER, D)] }),
    seed({ key: 'warehouse.return_parcels', name: 'Return parcels', area: 'inventory_warehouse', ownerRole: 'warehouse_manager', defaultDeadlineMinutes: D, businessHoursOnly: true, screen: 'ops/return-inspection', screenFilter: 'parcels', escalationRoute: [role('returns_manager', 0), role(OWNER, 2 * D)] }),
    seed({ key: 'purchasing.receiving', name: 'Receiving', area: 'purchasing', ownerRole: 'purchasing_manager', defaultDeadlineMinutes: D, screen: 'ops/receiving', escalationRoute: [role('official_store_manager', 0), role(OWNER, 2 * D)] }),
    seed({ key: 'inventory.reservations', name: 'Stock reservations', area: 'inventory_warehouse', ownerRole: 'inventory_manager', defaultDeadlineMinutes: D, businessHoursOnly: true, screen: 'ops/inventory', screenFilter: 'reservations', escalationRoute: [role('order_manager', 0), role('official_store_manager', D)] }),
    seed({ key: 'inventory.low_stock', name: 'Low stock', area: 'inventory_warehouse', ownerRole: 'inventory_manager', defaultDeadlineMinutes: D, businessHoursOnly: true, screen: 'ops/inventory', screenFilter: 'low_stock', escalationRoute: [role('purchasing_manager', 0), role('official_store_manager', D)] }),
    seed({ key: 'returns.inspection', name: 'Return inspection', area: 'returns', ownerRole: 'returns_manager', defaultDeadlineMinutes: D, screen: 'ops/return-inspection', escalationRoute: [role('warehouse_manager', 0), role(OWNER, 2 * D)] }),
    seed({ key: 'returns.decisions', name: 'Return decisions', area: 'returns', ownerRole: 'returns_manager', defaultDeadlineMinutes: D, screen: 'admin/returns', screenFilter: 'escalated', escalationRoute: [role('customer_support_manager', 0), role(OWNER, 2 * D)] }),
    seed({ key: 'finance.daily_checks', name: 'Daily finance checks', area: 'finance', ownerRole: 'finance_manager', defaultDeadlineMinutes: D, businessHoursOnly: true, screen: 'ops/finance-checks', escalationRoute: [role(OWNER, 0, 'amount over $1,000'), role(OWNER, D)] }),
    seed({ key: 'finance.payment_checks', name: 'Payment checks', area: 'finance', ownerRole: 'finance_manager', defaultDeadlineMinutes: D, businessHoursOnly: true, screen: 'ops/finance-checks', screenFilter: 'payments', escalationRoute: [role(OWNER, 0, 'amount over $1,000'), role(OWNER, D)] }),
    seed({ key: 'finance.chargebacks', name: 'Chargebacks', area: 'finance', ownerRole: 'finance_manager', defaultDeadlineMinutes: 2 * D, businessHoursOnly: true, screen: 'admin/finance', screenFilter: 'disputes', escalationRoute: [role('seller_manager', 0, 'seller orders only'), role(OWNER, D)] }),
    seed({ key: 'finance.payout_failures', name: 'Failed payouts', area: 'finance', ownerRole: 'finance_manager', defaultDeadlineMinutes: D, businessHoursOnly: true, screen: 'admin/payouts', screenFilter: 'failed', escalationRoute: [role('seller_manager', 0), role(OWNER, 2 * D)] }),
    seed({ key: 'support.cases_waiting', name: 'Cases past target', area: 'support', ownerRole: 'customer_support_manager', defaultDeadlineMinutes: 4 * H, screen: 'admin/cases', screenFilter: 'overdue', escalationRoute: [role('seller_manager', 0, 'seller items only'), role(OWNER, D)] }),
    seed({ key: 'catalog.product_review', name: 'Product review', area: 'catalog', ownerRole: 'catalog_manager', defaultDeadlineMinutes: 2 * D, businessHoursOnly: true, screen: 'admin/product-review', escalationRoute: [role(OWNER, D)] }),
    seed({ key: 'sellers.applications', name: 'Seller applications', area: 'sellers', ownerRole: 'seller_manager', defaultDeadlineMinutes: 2 * D, businessHoursOnly: true, screen: 'admin/seller-application', escalationRoute: [role(OWNER, 2 * D)] }),
    seed({ key: 'sellers.launch_reviews', name: 'Launch and store change reviews', area: 'sellers', ownerRole: 'seller_manager', defaultDeadlineMinutes: 2 * D, businessHoursOnly: true, screen: 'admin/sellers', screenFilter: 'launch_reviews', escalationRoute: [role(OWNER, 2 * D)] }),
    seed({ key: 'sellers.restrictions', name: 'Restrictions', area: 'sellers', ownerRole: 'seller_manager', defaultDeadlineMinutes: 2 * D, businessHoursOnly: true, screen: 'admin/sellers', screenFilter: 'restrictions', escalationRoute: [role('trust_and_risk_manager', 0), role(OWNER, 2 * D)] }),
    seed({ key: 'sellers.appeals', name: 'Appeals', area: 'sellers', ownerRole: 'seller_manager', defaultDeadlineMinutes: 2 * D, businessHoursOnly: true, screen: 'admin/sellers', screenFilter: 'appeals', escalationRoute: [role('trust_and_risk_manager', 0), role(OWNER, 2 * D)] }),
    seed({ key: 'sellers.performance', name: 'Seller performance', area: 'sellers', ownerRole: 'seller_manager', defaultDeadlineMinutes: 3 * D, businessHoursOnly: true, screen: 'admin/sellers', screenFilter: 'below_target', escalationRoute: [role(OWNER, 2 * D)] }),
    seed({ key: 'trust.reports', name: 'Trust reports', area: 'trust', ownerRole: 'trust_and_risk_manager', defaultDeadlineMinutes: D, screen: 'admin/trust', escalationRoute: [role(OWNER, D)] }),
    seed({ key: 'access.approvals', name: 'Approvals waiting', area: 'platform', ownerRole: OWNER, defaultDeadlineMinutes: D, screen: 'admin/staff', screenFilter: 'approvals', escalationRoute: [role(OWNER, 0)] }),
    seed({ key: 'customers.data_requests', name: 'Customer data requests', area: 'support', ownerRole: 'customer_support_manager', defaultDeadlineMinutes: 30 * D, screen: 'admin/customers', screenFilter: 'data_requests', escalationRoute: [role('platform_administrator', 0), role(OWNER, 2 * D)] }),
  ].map((q) => [q.key, q]),
);

/**
 * The queue each kind belongs in (spec notes, "Queues per kind"). Intake openings use it, and raise()
 * routes an item of these kinds there even when the raising module names another queue, as long as that
 * queue is installed and active (an install without it keeps the caller's queue).
 */
export const KIND_QUEUES: Partial<Record<Kind, string>> = {
  payment_check: 'finance.payment_checks',
  payment_mismatch: 'finance.payment_checks',
  chargeback: 'finance.chargebacks',
  payout_failed: 'finance.payout_failures',
  hold_review: 'finance.daily_checks',
  launch_review: 'sellers.launch_reviews',
  storefront_review: 'sellers.launch_reviews',
  restriction_evidence: 'sellers.restrictions',
  restriction_review: 'sellers.restrictions',
  appeal_due: 'sellers.appeals',
  seller_performance: 'sellers.performance',
  low_stock: 'inventory.low_stock',
  unexpected_return_parcel: 'warehouse.return_parcels',
  return_parcel_overdue: 'warehouse.return_parcels',
};

/** Seller Center screen of a seller-visible task */
export function sellerScreen(kind: string): string {
  switch (kind) {
    case 'overdue_dispatch':
    case 'missing_tracking':
    case 'seller_cannot_fulfill':
    case 'delivery_exception':
      return 'seller/order';
    case 'seller_reply_overdue':
      return 'seller/customers';
    case 'seller_performance':
      return 'seller/performance';
    case 'return_decision':
      return 'seller/return';
    case 'product_review':
      return 'seller/products';
    case 'payout_failed':
      return 'seller/finance';
    default:
      return 'seller/dashboard';
  }
}

/** Default deadline of a manual task's queue when the queue is unknown (never used for real queues) */
export const DEFAULT_DEADLINE_MINUTES = 24 * 60;

export const PRIORITIES: readonly Priority[] = ['low', 'normal', 'high', 'urgent'];
export const priorityRank = (p: string) => Math.max(0, PRIORITIES.indexOf(p as Priority));
export const bump = (p: Priority): Priority => PRIORITIES[Math.min(PRIORITIES.length - 1, priorityRank(p) + 1)]!;

export const ACTIVE_STATES: readonly ItemState[] = ['open', 'assigned', 'in_progress', 'waiting'];
export const CLOSED_STATES: readonly ItemState[] = ['resolved', 'dismissed'];
export const isActive = (s: string) => (ACTIVE_STATES as readonly string[]).includes(s);
