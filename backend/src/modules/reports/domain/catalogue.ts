/**
 * The launch report library (plan ch. 19): six business groups with a named owner role, the metric
 * definitions every figure links to, and the reports built from them. Seeded at boot (idempotent);
 * metric definitions are then managed through the admin endpoints (versions, owners, suggestions).
 */
import type { FilterSpec, MetricDefinition, ReportDefinition } from '../../../spec/reports.js';

/** Staff id used while a group or seeded metric is owned by its role and no person is named yet */
export const UNASSIGNED_OWNER = '00000000-0000-0000-0000-000000000000';

/** Read-model key for Official Store / platform-level rows in per-seller tables (seller_id is not null there) */
export const OFFICIAL_KEY = '00000000-0000-0000-0000-000000000000';

export type GroupKey = MetricDefinition['group'];
export const GROUP_KEYS: GroupKey[] = ['commerce', 'company_trading', 'marketplace_finance', 'products_discovery', 'service_sellers', 'customers_marketing_ads'];
export const UNITS: MetricDefinition['unit'][] = ['money', 'count', 'percent', 'ratio', 'duration_hours', 'days'];
export const DATE_BASES: MetricDefinition['defaultDateBasis'][] = ['placement', 'payment', 'shipment', 'completion', 'event'];

export interface GroupSeed {
  key: GroupKey;
  label: string;
  /** Owner role shown while no person is named */
  ownerRole: string;
  permission: string;
  position: number;
}

export const GROUPS: GroupSeed[] = [
  { key: 'commerce', label: 'Commerce', ownerRole: 'Order Manager', permission: 'reports.commerce.view', position: 1 },
  { key: 'company_trading', label: 'Company trading', ownerRole: 'Official Store Manager', permission: 'reports.trading.view', position: 2 },
  { key: 'marketplace_finance', label: 'Marketplace finance', ownerRole: 'Finance Manager', permission: 'reports.marketplace-finance.view', position: 3 },
  { key: 'products_discovery', label: 'Products and discovery', ownerRole: 'Catalog Manager', permission: 'reports.discovery.view', position: 4 },
  { key: 'service_sellers', label: 'Service and sellers', ownerRole: 'Seller Manager', permission: 'reports.service.view', position: 5 },
  { key: 'customers_marketing_ads', label: 'Customers, marketing and ads', ownerRole: 'Marketing Manager', permission: 'reports.customers-marketing.view', position: 6 },
];

export const groupOf = (key: string) => GROUPS.find((g) => g.key === key);
export const SELLER_GROUP = 'seller';
export const SELLER_PERMISSION = 'reports.seller.view';

export type MetricSeed = Pick<MetricDefinition, 'key' | 'name' | 'group' | 'definition' | 'formula' | 'unit' | 'includes' | 'excludes' | 'dateBasisOptions' | 'defaultDateBasis' | 'relatedKeys' | 'audience'> & {
  /** Higher is better (deltas: refunds going down is good news) */
  higherIsBetter?: boolean;
};

const SALES_BASES = ['placement', 'payment', 'shipment', 'completion'];
const EVENT = ['event'];

export const METRICS: MetricSeed[] = [
  /* ---------------------------------------------------------------- commerce */
  {
    key: 'commerce.gross_sales', name: 'Gross sales', group: 'commerce', unit: 'money', audience: 'both',
    definition: 'Value of the items customers ordered, after customer discounts and before cancellations and refunds. Shipping charges and tax are not included.',
    formula: 'Sum of fact_order_items.item_minor for items whose date basis falls in the range',
    includes: ['Official Store items', 'Marketplace seller items', 'Customer discounts deducted'], excludes: ['Tax', 'Shipping charges', 'Cancellations and refunds (see Sales after cancellations and refunds)'],
    dateBasisOptions: SALES_BASES, defaultDateBasis: 'placement', relatedKeys: ['commerce.net_sales', 'marketplace.seller_sales'],
  },
  {
    key: 'commerce.net_sales', name: 'Sales after cancellations and refunds', group: 'commerce', unit: 'money', audience: 'staff',
    definition: 'Gross sales minus the item value of cancellations and refunds sent so far for the same items. Recent days can still change.',
    formula: 'Sum of item_minor − cancelled_minor − refunded_minor over the same items as gross sales',
    includes: ['Cancellations', 'Refunds sent'], excludes: ['Tax', 'Shipping charges', "Refunds approved but not sent"],
    dateBasisOptions: SALES_BASES, defaultDateBasis: 'placement', relatedKeys: ['commerce.gross_sales', 'commerce.refunds'],
  },
  {
    key: 'commerce.orders', name: 'Orders', group: 'commerce', unit: 'count', audience: 'both',
    definition: 'Orders whose payment was accepted, counted once per order (an order with items from three sellers is one order).',
    formula: 'Count of distinct order_id in fact_order_items whose date basis falls in the range',
    includes: ['Orders with a later cancellation'], excludes: ['Orders still waiting for payment', 'Orders whose payment was declined'],
    dateBasisOptions: SALES_BASES, defaultDateBasis: 'placement', relatedKeys: ['commerce.average_order_value'],
  },
  {
    key: 'commerce.average_order_value', name: 'Average order value', group: 'commerce', unit: 'money', audience: 'both',
    definition: 'Gross sales divided by orders in the same range.',
    formula: 'commerce.gross_sales ÷ commerce.orders',
    includes: [], excludes: ['Tax', 'Shipping charges'],
    dateBasisOptions: SALES_BASES, defaultDateBasis: 'placement', relatedKeys: ['commerce.gross_sales', 'commerce.orders'],
  },
  {
    key: 'commerce.refunds', name: 'Refunds sent', group: 'commerce', unit: 'money', audience: 'both', higherIsBetter: false,
    definition: "Money sent back to customers, on the day the refund was sent. Refunds that are approved but not sent yet are never counted.",
    formula: 'Sum of fact_refunds.amount_minor with sent_at in the range',
    includes: ['Refunds after payout'], excludes: ['Approved refunds not sent yet'],
    dateBasisOptions: EVENT, defaultDateBasis: 'event', relatedKeys: ['commerce.net_sales'],
  },
  {
    key: 'commerce.cancelled_sales', name: 'Cancelled sales', group: 'commerce', unit: 'money', audience: 'staff', higherIsBetter: false,
    definition: 'Item value of cancelled items, on the day they were cancelled, by who asked for the cancellation.',
    formula: 'Sum of fact_order_items.cancelled_minor with cancelled_at in the range',
    includes: ['Customer, seller, staff and system cancellations'], excludes: ['Tax', 'Shipping charges'],
    dateBasisOptions: EVENT, defaultDateBasis: 'event', relatedKeys: ['commerce.net_sales'],
  },
  {
    key: 'commerce.units_sold', name: 'Units sold', group: 'commerce', unit: 'count', audience: 'both',
    definition: 'Units ordered, before cancellations and returns.',
    formula: 'Sum of fact_order_items.quantity whose date basis falls in the range',
    includes: [], excludes: [],
    dateBasisOptions: SALES_BASES, defaultDateBasis: 'placement', relatedKeys: ['commerce.gross_sales'],
  },
  /* ---------------------------------------------------------------- company trading */
  {
    key: 'trading.official_sales', name: 'Official Store sales', group: 'company_trading', unit: 'money', audience: 'staff',
    definition: 'Gross sales of the Official Store (our own products), after customer discounts.',
    formula: 'commerce.gross_sales for owner_type = official',
    includes: [], excludes: ['Marketplace seller items', 'Tax', 'Shipping charges'],
    dateBasisOptions: SALES_BASES, defaultDateBasis: 'placement', relatedKeys: ['trading.gross_margin'],
  },
  {
    key: 'trading.buying_cost', name: 'Buying cost', group: 'company_trading', unit: 'money', audience: 'staff', higherIsBetter: false,
    definition: 'Weighted average buying cost of the Official Store units sold, from inventory.',
    formula: 'Sum of fact_order_items.buying_cost_minor (unit cost × quantity) for Official Store items',
    includes: [], excludes: ['Items whose cost is not known yet'],
    dateBasisOptions: SALES_BASES, defaultDateBasis: 'placement', relatedKeys: ['trading.gross_margin'],
  },
  {
    key: 'trading.gross_margin', name: 'Gross margin', group: 'company_trading', unit: 'money', audience: 'staff',
    definition: 'Official Store sales minus their buying cost, for items whose cost is known.',
    formula: 'Σ item_minor − Σ buying_cost_minor over Official Store items with a known cost',
    includes: [], excludes: ['Items whose cost is not known yet', 'Marketplace seller items'],
    dateBasisOptions: SALES_BASES, defaultDateBasis: 'placement', relatedKeys: ['trading.official_sales', 'trading.buying_cost'],
  },
  {
    key: 'trading.gross_margin_pct', name: 'Gross margin %', group: 'company_trading', unit: 'percent', audience: 'staff',
    definition: 'Gross margin as a share of the Official Store sales that have a known cost.',
    formula: 'trading.gross_margin ÷ sales with a known cost × 100',
    includes: [], excludes: [],
    dateBasisOptions: SALES_BASES, defaultDateBasis: 'placement', relatedKeys: ['trading.gross_margin'],
  },
  /* ---------------------------------------------------------------- marketplace finance */
  {
    key: 'marketplace.seller_sales', name: 'Marketplace sales', group: 'marketplace_finance', unit: 'money', audience: 'staff',
    definition: 'Item sales by outside sellers. This money belongs to the sellers; it is not company income.',
    formula: 'commerce.gross_sales for owner_type = seller',
    includes: [], excludes: ['Official Store items', 'Tax', 'Shipping charges'],
    dateBasisOptions: SALES_BASES, defaultDateBasis: 'placement', relatedKeys: ['marketplace.fee_income', 'commerce.gross_sales'],
  },
  {
    key: 'marketplace.fee_income', name: 'Marketplace fee income', group: 'marketplace_finance', unit: 'money', audience: 'staff',
    definition: 'Commission and fees charged to sellers, net of fee refunds, on the day finance charged them. This is company income from the marketplace.',
    formula: 'Sum of fact_marketplace_finance_daily.fee_income_minor (finance.marketplaceIncomeByDay, pulled daily)',
    includes: ['Commission', 'Fees'], excludes: ['Seller sales', 'Advertising income'],
    dateBasisOptions: EVENT, defaultDateBasis: 'event', relatedKeys: ['marketplace.seller_sales'],
  },
  {
    key: 'marketplace.discount_funding', name: 'Platform-funded discounts', group: 'marketplace_finance', unit: 'money', audience: 'staff', higherIsBetter: false,
    definition: 'Customer discounts on marketplace seller items that the platform paid for.',
    formula: 'Sum of fact_marketplace_finance_daily.platform_discount_minor',
    includes: [], excludes: ['Seller-funded discounts'],
    dateBasisOptions: EVENT, defaultDateBasis: 'event', relatedKeys: ['marketplace.seller_sales'],
  },
  {
    key: 'marketplace.held', name: 'Holds placed (net)', group: 'marketplace_finance', unit: 'money', audience: 'staff',
    definition: 'Seller money put on hold minus holds released in the range.',
    formula: 'Sum of fact_marketplace_finance_daily.held_minor',
    includes: [], excludes: [],
    dateBasisOptions: EVENT, defaultDateBasis: 'event', relatedKeys: ['marketplace.payouts_paid'],
  },
  {
    key: 'marketplace.payouts_paid', name: 'Payouts paid', group: 'marketplace_finance', unit: 'money', audience: 'staff',
    definition: 'Payouts that reached sellers, on the day they were paid.',
    formula: 'Sum of fact_marketplace_finance_daily.payouts_paid_minor',
    includes: [], excludes: ['Failed payouts'],
    dateBasisOptions: EVENT, defaultDateBasis: 'event', relatedKeys: ['marketplace.held'],
  },
  {
    key: 'marketplace.amounts_owed', name: 'Amounts owed by sellers', group: 'marketplace_finance', unit: 'money', audience: 'staff', higherIsBetter: false,
    definition: 'Negative seller balances that became amounts owed (for example refunds after payout).',
    formula: 'Sum of fact_marketplace_finance_daily.owed_minor',
    includes: [], excludes: [],
    dateBasisOptions: EVENT, defaultDateBasis: 'event', relatedKeys: ['commerce.refunds'],
  },
  {
    key: 'marketplace.ad_income', name: 'Advertising charges', group: 'marketplace_finance', unit: 'money', audience: 'staff',
    definition: 'Paid seller advertising charged, minus credits.',
    formula: 'Sum of fact_marketplace_finance_daily.ad_charges_minor',
    includes: [], excludes: ['Fee income'],
    dateBasisOptions: EVENT, defaultDateBasis: 'event', relatedKeys: ['ads.spend'],
  },
  /* ---------------------------------------------------------------- products and discovery */
  {
    key: 'discovery.product_views', name: 'Product views', group: 'products_discovery', unit: 'count', audience: 'both',
    definition: 'Product page views from the website and the app (anonymous counts).',
    formula: 'Sum of fact_discovery_daily.views',
    includes: [], excludes: ['Shoppers who opted out of personalisation'],
    dateBasisOptions: EVENT, defaultDateBasis: 'event', relatedKeys: ['discovery.view_to_order'],
  },
  {
    key: 'discovery.cart_adds', name: 'Cart additions', group: 'products_discovery', unit: 'count', audience: 'both',
    definition: 'Times a product was added to a cart.',
    formula: 'Sum of fact_discovery_daily.cart_adds',
    includes: [], excludes: [],
    dateBasisOptions: EVENT, defaultDateBasis: 'event', relatedKeys: ['discovery.view_to_order'],
  },
  {
    key: 'discovery.view_to_order', name: 'Units ordered per 100 views', group: 'products_discovery', unit: 'percent', audience: 'both',
    definition: 'Units ordered as a share of product views on the same days.',
    formula: 'Σ fact_discovery_daily.purchases ÷ Σ views × 100',
    includes: [], excludes: [],
    dateBasisOptions: EVENT, defaultDateBasis: 'event', relatedKeys: ['discovery.product_views'],
  },
  {
    key: 'discovery.stockout_hours', name: 'Out-of-stock hours', group: 'products_discovery', unit: 'duration_hours', audience: 'staff', higherIsBetter: false,
    definition: 'Hours products were out of stock.',
    formula: 'Σ fact_discovery_daily.stockout_minutes ÷ 60',
    includes: [], excludes: [],
    dateBasisOptions: EVENT, defaultDateBasis: 'event', relatedKeys: [],
  },
  {
    key: 'discovery.unavailable_searches', name: 'Unavailable searches', group: 'products_discovery', unit: 'count', audience: 'staff', higherIsBetter: false,
    definition: 'Searches that found no available product.',
    formula: 'Sum of fact_search_misses_daily.count (search.zeroResultStats, pulled daily)',
    includes: [], excludes: [],
    dateBasisOptions: EVENT, defaultDateBasis: 'event', relatedKeys: [],
  },
  /* ---------------------------------------------------------------- service and sellers */
  {
    key: 'service.on_time_dispatch', name: 'On-time dispatch', group: 'service_sellers', unit: 'percent', audience: 'both',
    definition: 'Share of packages dispatched by their dispatch deadline.',
    formula: 'Σ dispatched_on_time ÷ Σ dispatched × 100 (fact_service_daily)',
    includes: [], excludes: ['Return shipments'],
    dateBasisOptions: ['shipment'], defaultDateBasis: 'shipment', relatedKeys: ['service.overdue_dispatch'],
  },
  {
    key: 'service.valid_tracking', name: 'Valid tracking', group: 'service_sellers', unit: 'percent', audience: 'both',
    definition: 'Share of dispatched packages with a valid tracking number.',
    formula: 'Σ valid_tracking ÷ Σ dispatched × 100',
    includes: [], excludes: [],
    dateBasisOptions: ['shipment'], defaultDateBasis: 'shipment', relatedKeys: ['service.on_time_dispatch'],
  },
  {
    key: 'service.overdue_dispatch', name: 'Overdue dispatches', group: 'service_sellers', unit: 'count', audience: 'both', higherIsBetter: false,
    definition: 'Packages that passed their dispatch deadline without being shipped.',
    formula: 'Σ fact_service_daily.overdue',
    includes: [], excludes: [],
    dateBasisOptions: EVENT, defaultDateBasis: 'event', relatedKeys: ['service.on_time_dispatch'],
  },
  {
    key: 'service.seller_cancellations', name: 'Seller cancellations', group: 'service_sellers', unit: 'count', audience: 'both', higherIsBetter: false,
    definition: 'Items cancelled by the seller or counted against the seller.',
    formula: 'Σ fact_service_daily.seller_cancellations',
    includes: [], excludes: ['Customer cancellations'],
    dateBasisOptions: EVENT, defaultDateBasis: 'event', relatedKeys: [],
  },
  {
    key: 'service.delivery_exceptions', name: 'Delivery issues', group: 'service_sellers', unit: 'count', audience: 'both', higherIsBetter: false,
    definition: 'Delivery exceptions opened: late dispatch, missing tracking, lost or damaged, failed delivery.',
    formula: 'Σ fact_service_daily.delivery_exceptions',
    includes: [], excludes: [],
    dateBasisOptions: EVENT, defaultDateBasis: 'event', relatedKeys: [],
  },
  {
    key: 'service.cases_opened', name: 'Support cases opened', group: 'service_sellers', unit: 'count', audience: 'staff', higherIsBetter: false,
    definition: 'Support cases opened in the range.',
    formula: 'Σ fact_service_daily.cases_opened',
    includes: [], excludes: [],
    dateBasisOptions: EVENT, defaultDateBasis: 'event', relatedKeys: ['service.case_backlog'],
  },
  {
    key: 'service.case_backlog', name: 'Case backlog', group: 'service_sellers', unit: 'count', audience: 'staff', higherIsBetter: false,
    definition: 'Support cases still open at the end of the range.',
    formula: 'Latest fact_service_daily.cases_open_eod on or before the last day, summed over sellers',
    includes: [], excludes: [],
    dateBasisOptions: EVENT, defaultDateBasis: 'event', relatedKeys: ['service.cases_opened'],
  },
  {
    key: 'service.return_requests', name: 'Return requests', group: 'service_sellers', unit: 'count', audience: 'both', higherIsBetter: false,
    definition: 'Return requests opened, by the reason the customer gave.',
    formula: 'Count of fact_returns with requested_at in the range',
    includes: [], excludes: [],
    dateBasisOptions: EVENT, defaultDateBasis: 'event', relatedKeys: [],
  },
  {
    key: 'service.messages_received', name: 'Customer messages', group: 'service_sellers', unit: 'count', audience: 'both',
    definition: 'Messages customers sent to sellers.',
    formula: 'Σ fact_service_daily.messages_received',
    includes: [], excludes: [],
    dateBasisOptions: EVENT, defaultDateBasis: 'event', relatedKeys: [],
  },
  /* ---------------------------------------------------------------- customers, marketing and ads */
  {
    key: 'customers.buyers', name: 'Buyers', group: 'customers_marketing_ads', unit: 'count', audience: 'staff',
    definition: 'Different customers (accounts or guest emails) with an accepted order in the range.',
    formula: 'Count of distinct fact_order_items.customer_key',
    includes: ['Guest checkouts'], excludes: [],
    dateBasisOptions: ['placement'], defaultDateBasis: 'placement', relatedKeys: ['customers.returning_buyers'],
  },
  {
    key: 'customers.new_buyers', name: 'New buyers', group: 'customers_marketing_ads', unit: 'count', audience: 'staff',
    definition: 'Buyers whose first accepted order is in the range.',
    formula: 'Count of fact_customers with first_order_at in the range',
    includes: [], excludes: [],
    dateBasisOptions: ['placement'], defaultDateBasis: 'placement', relatedKeys: ['customers.buyers'],
  },
  {
    key: 'customers.returning_buyers', name: 'Returning buyers', group: 'customers_marketing_ads', unit: 'count', audience: 'staff',
    definition: 'Buyers in the range who had ordered before the range started.',
    formula: 'Buyers whose fact_customers.first_order_at is before the range',
    includes: [], excludes: [],
    dateBasisOptions: ['placement'], defaultDateBasis: 'placement', relatedKeys: ['customers.buyers'],
  },
  {
    key: 'customers.repeat_rate', name: 'Repeat purchase rate', group: 'customers_marketing_ads', unit: 'percent', audience: 'staff',
    definition: 'Share of buyers in the range who have placed two or more orders in total.',
    formula: 'Buyers with fact_customers.orders ≥ 2 ÷ buyers × 100',
    includes: [], excludes: [],
    dateBasisOptions: ['placement'], defaultDateBasis: 'placement', relatedKeys: ['customers.returning_buyers'],
  },
  {
    key: 'marketing.discount_cost', name: 'Discount cost', group: 'customers_marketing_ads', unit: 'money', audience: 'staff', higherIsBetter: false,
    definition: 'Coupon and campaign discounts given, minus discounts reversed by cancellations, with who funded them.',
    formula: 'Σ fact_campaigns_daily.discount_cost_minor (promotion)',
    includes: ['Platform-funded', 'Seller-funded'], excludes: [],
    dateBasisOptions: EVENT, defaultDateBasis: 'event', relatedKeys: ['marketing.redemptions'],
  },
  {
    key: 'marketing.redemptions', name: 'Coupon redemptions', group: 'customers_marketing_ads', unit: 'count', audience: 'staff',
    definition: 'Orders that used a coupon or campaign discount.',
    formula: 'Σ fact_campaigns_daily.redemptions',
    includes: [], excludes: [],
    dateBasisOptions: EVENT, defaultDateBasis: 'event', relatedKeys: ['marketing.discount_cost'],
  },
  {
    key: 'ads.spend', name: 'Ad spending', group: 'customers_marketing_ads', unit: 'money', audience: 'staff',
    definition: 'Paid seller advertising charged, minus credits.',
    formula: 'Σ fact_campaigns_daily.spend_minor (ad)',
    includes: [], excludes: [],
    dateBasisOptions: EVENT, defaultDateBasis: 'event', relatedKeys: ['marketplace.ad_income'],
  },
  {
    key: 'ads.displays', name: 'Ad displays', group: 'customers_marketing_ads', unit: 'count', audience: 'staff',
    definition: 'Times ads were shown (advertising daily totals).',
    formula: 'Σ fact_campaigns_daily.displays (advertising.dailyPerformance, pulled daily)',
    includes: [], excludes: [],
    dateBasisOptions: EVENT, defaultDateBasis: 'event', relatedKeys: ['ads.clicks'],
  },
  {
    key: 'ads.clicks', name: 'Ad clicks', group: 'customers_marketing_ads', unit: 'count', audience: 'staff',
    definition: 'Clicks on ads (advertising daily totals).',
    formula: 'Σ fact_campaigns_daily.clicks',
    includes: [], excludes: [],
    dateBasisOptions: EVENT, defaultDateBasis: 'event', relatedKeys: ['ads.displays'],
  },
];

export const metricSeed = (key: string) => METRICS.find((m) => m.key === key);

/* ---------------------------------------------------------------- reports */

const f = (key: string, label: string, type: FilterSpec['type'], extra: Partial<FilterSpec> = {}): FilterSpec => ({ key, label, type, ...extra });
const RANGE = f('range', 'Date range', 'date_range', { default: 'last_14_days', hint: 'Days run 00:00–23:59 market time' });
const BASIS = f('dateBasis', 'Date basis', 'enum', { options: ['placement', 'payment', 'shipment', 'completion'], default: 'placement', hint: 'Which date puts an item in the range' });
const SOLD_BY = f('soldBy', 'Sold by', 'enum', { options: ['all', 'official', 'marketplace'], default: 'all' });
const SELLER = f('sellerId', 'Seller', 'uuid');
const CATEGORY = f('categoryId', 'Category', 'uuid');
const PRODUCT = f('productId', 'Product', 'uuid');

export type ReportSeed = Omit<ReportDefinition, 'phase'> & { phase?: number };

export const REPORTS: ReportSeed[] = [
  {
    key: 'commerce.sales', title: 'Sales', group: 'commerce', audience: 'staff', permission: 'reports.commerce.view',
    description: 'Gross sales, sales after cancellations and refunds, orders and average order value, with the Official Store and marketplace split.',
    metrics: ['commerce.gross_sales', 'commerce.net_sales', 'commerce.orders', 'commerce.average_order_value', 'commerce.units_sold'],
    dimensions: ['day', 'sold_by', 'seller', 'category'], filters: [RANGE, BASIS, SOLD_BY, SELLER, CATEGORY, PRODUCT],
    layout: ['kpis', 'series', 'split', 'table', 'definitions', 'callouts'],
  },
  {
    key: 'commerce.refunds', title: 'Refunds and cancellations', group: 'commerce', audience: 'staff', permission: 'reports.commerce.view',
    description: 'Refunds sent and cancelled sales, by refund reason and by who cancelled.',
    metrics: ['commerce.refunds', 'commerce.cancelled_sales'],
    dimensions: ['day', 'reason', 'cancelled_by', 'sold_by'], filters: [RANGE, SOLD_BY, SELLER],
    layout: ['kpis', 'series', 'breakdown', 'table', 'definitions'],
  },
  {
    key: 'trading.margin', title: 'Official Store margin', group: 'company_trading', audience: 'staff', permission: 'reports.trading.view',
    description: 'Official Store sales, buying cost and gross margin by product.',
    metrics: ['trading.official_sales', 'trading.buying_cost', 'trading.gross_margin', 'trading.gross_margin_pct'],
    dimensions: ['day', 'product', 'category'], filters: [RANGE, BASIS, CATEGORY, PRODUCT],
    layout: ['kpis', 'series', 'table', 'definitions', 'callouts'],
  },
  {
    key: 'marketplace.fees', title: 'Marketplace fees and payouts', group: 'marketplace_finance', audience: 'staff', permission: 'reports.marketplace-finance.view',
    description: 'Marketplace sales next to marketplace fee income, discount funding, holds, payouts and amounts owed, by seller.',
    metrics: ['marketplace.seller_sales', 'marketplace.fee_income', 'marketplace.discount_funding', 'marketplace.held', 'marketplace.payouts_paid', 'marketplace.amounts_owed', 'marketplace.ad_income'],
    dimensions: ['day', 'seller'], filters: [RANGE, SELLER],
    layout: ['kpis', 'series', 'table', 'definitions', 'callouts'],
  },
  {
    key: 'discovery.products', title: 'Product discovery', group: 'products_discovery', audience: 'staff', permission: 'reports.discovery.view',
    description: 'Views, cart additions, units ordered and out-of-stock hours by product.',
    metrics: ['discovery.product_views', 'discovery.cart_adds', 'discovery.view_to_order', 'discovery.stockout_hours'],
    dimensions: ['day', 'product'], filters: [RANGE, PRODUCT],
    layout: ['kpis', 'series', 'table', 'definitions'],
  },
  {
    key: 'discovery.searches', title: 'Unavailable searches', group: 'products_discovery', audience: 'staff', permission: 'reports.discovery.view',
    description: 'What customers searched for and could not find available.',
    metrics: ['discovery.unavailable_searches'],
    dimensions: ['day', 'query'], filters: [RANGE],
    layout: ['kpis', 'series', 'table', 'definitions'],
  },
  {
    key: 'service.sellers', title: 'Seller service', group: 'service_sellers', audience: 'staff', permission: 'reports.service.view',
    description: 'Dispatch on time, tracking, seller cancellations, delivery issues, cases and messages by seller.',
    metrics: ['service.on_time_dispatch', 'service.valid_tracking', 'service.overdue_dispatch', 'service.seller_cancellations', 'service.delivery_exceptions', 'service.cases_opened', 'service.case_backlog', 'service.messages_received'],
    dimensions: ['day', 'seller'], filters: [RANGE, SELLER],
    layout: ['kpis', 'series', 'table', 'definitions'],
  },
  {
    key: 'service.returns', title: 'Returns by reason', group: 'service_sellers', audience: 'staff', permission: 'reports.service.view',
    description: 'Return requests by the reason customers gave, with inspection outcomes.',
    metrics: ['service.return_requests'],
    dimensions: ['reason', 'seller', 'product'], filters: [RANGE, SELLER, PRODUCT],
    layout: ['kpis', 'breakdown', 'table', 'definitions'],
  },
  {
    key: 'customers.buyers', title: 'Buyers', group: 'customers_marketing_ads', audience: 'staff', permission: 'reports.customers-marketing.view',
    description: 'Buyers, new and returning buyers and repeat purchase.',
    metrics: ['customers.buyers', 'customers.new_buyers', 'customers.returning_buyers', 'customers.repeat_rate'],
    dimensions: ['day'], filters: [RANGE],
    layout: ['kpis', 'series', 'definitions'],
  },
  {
    key: 'marketing.campaigns', title: 'Campaigns and ads', group: 'customers_marketing_ads', audience: 'staff', permission: 'reports.customers-marketing.view',
    description: 'Discount cost and redemptions per promotion, ad spending, displays and clicks per ad campaign.',
    metrics: ['marketing.discount_cost', 'marketing.redemptions', 'ads.spend', 'ads.displays', 'ads.clicks'],
    dimensions: ['campaign'], filters: [RANGE],
    layout: ['kpis', 'table', 'definitions'],
  },
  /* ---------------------------------------------------------------- seller reports (always the caller's own seller) */
  {
    key: 'seller.product_sales', title: 'Product sales', group: SELLER_GROUP, audience: 'seller', permission: SELLER_PERMISSION,
    description: 'Your item sales and units by product, by order date.',
    metrics: ['commerce.gross_sales', 'commerce.units_sold', 'commerce.orders'],
    dimensions: ['product'], filters: [RANGE, PRODUCT],
    layout: ['kpis', 'table', 'definitions'],
  },
  {
    key: 'seller.order_trend', title: 'Order trend', group: SELLER_GROUP, audience: 'seller', permission: SELLER_PERMISSION,
    description: 'Your orders, item sales and average order per day, week or month.',
    metrics: ['commerce.orders', 'commerce.gross_sales', 'commerce.average_order_value'],
    dimensions: ['day'], filters: [RANGE],
    layout: ['kpis', 'series', 'table', 'definitions'],
  },
  {
    key: 'seller.returns_by_reason', title: 'Returns by reason', group: SELLER_GROUP, audience: 'seller', permission: SELLER_PERMISSION,
    description: 'Return requests on your items by the reason customers gave.',
    metrics: ['service.return_requests'],
    dimensions: ['reason', 'product'], filters: [RANGE, PRODUCT],
    layout: ['kpis', 'breakdown', 'table', 'definitions'],
  },
  {
    key: 'seller.service_performance', title: 'Service performance', group: SELLER_GROUP, audience: 'seller', permission: SELLER_PERMISSION,
    description: 'Dispatch on time, valid tracking, cancellations, delivery issues and customer messages.',
    metrics: ['service.on_time_dispatch', 'service.valid_tracking', 'service.seller_cancellations', 'service.delivery_exceptions', 'service.messages_received'],
    dimensions: ['day'], filters: [RANGE],
    layout: ['kpis', 'series', 'definitions'],
  },
];

export const reportSeed = (key: string) => REPORTS.find((r) => r.key === key);

/* ---------------------------------------------------------------- read models */

export interface ReadModelDef {
  key: string;
  description: string;
  sourceEvents: string[];
  /** Table counted for `rows` */
  table: string;
  /** Fed (partly) by the daily pull: stale when the last pull is older than a day plus the lag allowance */
  pulled?: boolean;
}

export const READ_MODELS: ReadModelDef[] = [
  { key: 'order_items', table: 'fact_order_items', description: 'One row per accepted order item with the placement, payment, shipment, delivery and completion dates', sourceEvents: ['orders.order.placed', 'orders.order.accepted', 'payments.payment.captured', 'shipping.shipment.dispatched', 'orders.item.delivered', 'orders.order.completed', 'orders.item.cancelled', 'payments.refund.sent'] },
  { key: 'refunds', table: 'fact_refunds', description: 'Refunds sent to customers', sourceEvents: ['payments.refund.sent'] },
  { key: 'returns', table: 'fact_returns', description: 'Return requests with reason and inspection outcome', sourceEvents: ['returns.return.requested', 'returns.return.inspected'] },
  { key: 'marketplace_finance', table: 'fact_marketplace_finance_daily', pulled: true, description: 'Per seller and day: marketplace sales, fee income, discount funding, holds, payouts, amounts owed, ad charges', sourceEvents: ['finance.payout.paid', 'finance.payout.failed', 'finance.hold.placed', 'finance.hold.released', 'finance.amount_owed.created', 'advertising.charge.posted', 'advertising.charge.credited'] },
  { key: 'service', table: 'fact_service_daily', description: 'Per seller and day: dispatch, tracking, cancellations, delivery issues, messages and cases', sourceEvents: ['shipping.shipment.dispatched', 'shipping.dispatch.overdue', 'shipping.shipment.exception', 'orders.item.cancelled', 'messaging.message.sent', 'support.case.opened', 'support.case.resolved'] },
  { key: 'discovery', table: 'fact_discovery_daily', description: 'Per product and day: views, cart additions, units ordered and out-of-stock minutes', sourceEvents: ['cart.item.added', 'inventory.stock.changed', 'orders.order.accepted'] },
  { key: 'search_misses', table: 'fact_search_misses_daily', pulled: true, description: 'Searches without an available result per day (search.zeroResultStats)', sourceEvents: [] },
  { key: 'customers', table: 'fact_customers', description: 'First and last order, order count and net spend per buyer', sourceEvents: ['orders.order.placed', 'orders.order.accepted', 'payments.refund.sent'] },
  { key: 'campaigns', table: 'fact_campaigns_daily', pulled: true, description: 'Per campaign and day: promotion sales, discount cost and funding; ad spend, displays, clicks and attributed purchases', sourceEvents: ['promotions.coupon.redeemed', 'promotions.redemption.reversed', 'advertising.charge.posted', 'advertising.charge.credited'] },
];

export const readModelDef = (key: string) => READ_MODELS.find((m) => m.key === key);
