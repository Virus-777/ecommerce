/**
 * The launch report library (plan ch. 19): six business groups with a named owner role, the metric
 * definitions every figure links to, and the reports built from them. Seeded at boot (idempotent);
 * metric definitions are then managed through the admin endpoints (versions, owners, suggestions).
 */
import { OFFICIAL_STORE_ID } from '../../../spec/common.js';
import type { FilterSpec, MetricDefinition, ReportDefinition } from '../../../spec/reports.js';

/** Staff id used while a group or seeded metric is owned by its role and no person is named yet */
export const UNASSIGNED_OWNER = '00000000-0000-0000-0000-000000000000';

/** Read-model key for Official Store / platform-level rows in per-seller tables (seller_id is not null there): the spec's Official Store seller id */
export const OFFICIAL_KEY: string = OFFICIAL_STORE_ID;
/** No seller id, or the Official Store's */
export const isOfficialSeller = (sellerId: string | null | undefined) => !sellerId || sellerId === OFFICIAL_KEY;

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
    key: 'trading.buying_cost', name: 'Cost of goods sold', group: 'company_trading', unit: 'money', audience: 'staff', higherIsBetter: false,
    definition: 'What the Official Store units sold cost to buy: the weighted average unit cost from inventory when they were sold, times the quantity. Not the stock bought from suppliers in the period (see Stock bought).',
    formula: 'Sum of fact_order_items.buying_cost_minor (unit cost × quantity) for Official Store items',
    includes: [], excludes: ['Items whose cost is not known yet', 'Stock bought from suppliers'],
    dateBasisOptions: SALES_BASES, defaultDateBasis: 'placement', relatedKeys: ['trading.gross_margin'],
  },
  {
    key: 'trading.gross_margin', name: 'Gross margin', group: 'company_trading', unit: 'money', audience: 'staff',
    definition: 'Official Store sales minus their cost of goods sold, for items whose cost is known.',
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
  /* company costs finance books (finance.companyCostsByDay, read when the report runs; by booking day) */
  {
    key: 'trading.purchasing_booked', name: 'Purchasing costs booked', group: 'company_trading', unit: 'money', audience: 'staff', higherIsBetter: false,
    definition: 'Official Store buying costs booked as company costs in finance (stock bought from suppliers), by booking day.',
    formula: 'Σ finance.companyCostsByDay.amount, kind buying_cost',
    includes: [], excludes: ['Supplier credits (shown on their own)'],
    dateBasisOptions: EVENT, defaultDateBasis: 'event', relatedKeys: ['trading.buying_cost', 'trading.supplier_credits'],
  },
  {
    key: 'trading.supplier_credits', name: 'Supplier credits', group: 'company_trading', unit: 'money', audience: 'staff',
    definition: 'Money suppliers and carriers paid back to the company (credits and paid claims), by booking day.',
    formula: 'Σ finance.companyCostsByDay.amount, kind supplier_credit',
    includes: ['Paid carrier claims'], excludes: [],
    dateBasisOptions: EVENT, defaultDateBasis: 'event', relatedKeys: ['trading.purchasing_booked'],
  },
  {
    key: 'trading.discounts', name: 'Official Store discounts', group: 'company_trading', unit: 'money', audience: 'staff', higherIsBetter: false,
    definition: 'Customer discounts on Official Store items the company paid for, less discounts returned by cancellations.',
    formula: 'Σ finance.companyCostsByDay.amount, kind discount',
    includes: [], excludes: ['Discounts on marketplace seller items (see Discount funding)'],
    dateBasisOptions: EVENT, defaultDateBasis: 'event', relatedKeys: ['trading.shipping_expense', 'marketplace.discount_funding'],
  },
  {
    key: 'trading.shipping_expense', name: 'Shipping expense', group: 'company_trading', unit: 'money', audience: 'staff', higherIsBetter: false,
    definition: 'Shipping the company paid for Official Store orders and returns (labels), less the shipping customers paid.',
    formula: 'Σ finance.companyCostsByDay.amount, kind shipping_expense',
    includes: ['Return labels the company pays for'], excludes: ['Seller shipping'],
    dateBasisOptions: EVENT, defaultDateBasis: 'event', relatedKeys: ['trading.discounts'],
  },
  {
    key: 'trading.return_losses', name: 'Return losses', group: 'company_trading', unit: 'money', audience: 'staff', higherIsBetter: false,
    definition: 'Refunds sent for Official Store returns, booked as a company cost.',
    formula: 'Σ finance.companyCostsByDay.amount, kind return_loss',
    includes: [], excludes: ['Refunds on seller items'],
    dateBasisOptions: EVENT, defaultDateBasis: 'event', relatedKeys: ['trading.write_offs', 'commerce.refunds'],
  },
  {
    key: 'trading.write_offs', name: 'Write-offs', group: 'company_trading', unit: 'money', audience: 'staff', higherIsBetter: false,
    definition: 'Stock written off (damaged, lost or returned unsellable) and balances written off, at cost.',
    formula: 'Σ finance.companyCostsByDay.amount, kind write_off',
    includes: [], excludes: [],
    dateBasisOptions: EVENT, defaultDateBasis: 'event', relatedKeys: ['trading.return_losses'],
  },
  {
    key: 'trading.chargeback_losses', name: 'Chargeback losses', group: 'company_trading', unit: 'money', audience: 'staff', higherIsBetter: false,
    definition: 'Payment disputes on Official Store orders the company lost.',
    formula: 'Σ finance.companyCostsByDay.amount, kind chargeback_loss',
    includes: [], excludes: [],
    dateBasisOptions: EVENT, defaultDateBasis: 'event', relatedKeys: ['trading.return_losses'],
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
    key: 'marketplace.seller_balances', name: 'Seller balances', group: 'marketplace_finance', unit: 'money', audience: 'staff',
    definition: 'Money Marketly holds for sellers now: pending and available earnings plus held amounts, across sellers. A balance, not a figure for the range.',
    formula: 'finance.sellerBalanceTotals().total (pending + available + held), read when the report runs',
    includes: ['Pending earnings', 'Available for payout', 'Held amounts'], excludes: ['Payouts already paid'],
    dateBasisOptions: EVENT, defaultDateBasis: 'event', relatedKeys: ['marketplace.payouts_paid', 'marketplace.amounts_owed'],
  },
  {
    key: 'marketplace.ad_income', name: 'Advertising charges', group: 'marketplace_finance', unit: 'money', audience: 'staff',
    definition: 'Paid seller advertising charged, minus credits.',
    formula: 'Sum of fact_marketplace_finance_daily.ad_charges_minor',
    includes: [], excludes: ['Fee income'],
    dateBasisOptions: EVENT, defaultDateBasis: 'event', relatedKeys: ['ads.spend'],
  },
  {
    key: 'marketplace.service_fees', name: 'Service fees', group: 'marketplace_finance', unit: 'money', audience: 'both',
    definition: 'Fulfilled by Marketly fees charged to sellers (storage, pick and pack, order handling, returns processing, removals and other service fees), minus fees reversed, on the day they were charged or reversed.',
    formula: 'Sum of fact_marketplace_finance_daily.service_fees_minor (fulfillment-service.fee.charged less fee.reversed)',
    includes: ['Fulfilled by Marketly fees', 'Reversals'], excludes: ['Marketplace commission and fees (see Marketplace fee income)', 'Advertising charges'],
    dateBasisOptions: EVENT, defaultDateBasis: 'event', relatedKeys: ['marketplace.fee_income', 'service.marketly_on_time_dispatch'],
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
    includes: [], excludes: ['Return shipments', 'Fulfilled by Marketly packages (see Fulfilled by Marketly on-time dispatch)'],
    dateBasisOptions: ['shipment'], defaultDateBasis: 'shipment', relatedKeys: ['service.overdue_dispatch', 'service.marketly_on_time_dispatch'],
  },
  {
    key: 'service.marketly_on_time_dispatch', name: 'Fulfilled by Marketly on-time dispatch', group: 'service_sellers', unit: 'percent', audience: 'staff',
    definition: "Share of Fulfilled by Marketly packages Marketly's warehouse dispatched by their dispatch deadline. These never count toward the seller's own dispatch figures.",
    formula: 'Σ dispatched_on_time ÷ Σ dispatched × 100 (fact_marketly_fulfillment_daily)',
    includes: ['Packages Marketly ships for sellers'], excludes: ['Packages sellers ship themselves', 'Official Store packages', 'Return shipments'],
    dateBasisOptions: ['shipment'], defaultDateBasis: 'shipment', relatedKeys: ['service.on_time_dispatch', 'marketplace.service_fees'],
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
    key: 'service.return_rate', name: 'Return rate', group: 'service_sellers', unit: 'percent', audience: 'both', higherIsBetter: false,
    definition: 'Units customers asked to return, as a share of the units sold in the same range.',
    formula: 'Σ fact_returns.units (requested in the range) ÷ Σ fact_order_items.quantity (placed in the range) × 100',
    includes: ['Every return request, whatever its outcome'], excludes: ['Cancelled items (never shipped)'],
    dateBasisOptions: EVENT, defaultDateBasis: 'event', relatedKeys: ['service.return_requests', 'commerce.units_sold'],
  },
  {
    key: 'service.messages_received', name: 'Customer messages', group: 'service_sellers', unit: 'count', audience: 'both',
    definition: 'Messages customers sent to sellers.',
    formula: 'Σ fact_service_daily.messages_received',
    includes: [], excludes: [],
    dateBasisOptions: EVENT, defaultDateBasis: 'event', relatedKeys: [],
  },
  /* the figures below are read from support and messaging when the report runs (caseStatsByDay, replyStatsByDay) */
  {
    key: 'service.complaints', name: 'Customer complaints', group: 'service_sellers', unit: 'count', audience: 'staff', higherIsBetter: false,
    definition: 'Support cases customers opened (help requests, order problems and disputes), by the reason they chose.',
    formula: 'Σ support.caseStatsByDay.opened for customer categories, by opening day',
    includes: ['Cases about Official Store and seller orders'], excludes: ['Seller requests to Marketly'],
    dateBasisOptions: EVENT, defaultDateBasis: 'event', relatedKeys: ['service.cases_opened', 'service.return_requests'],
  },
  {
    key: 'service.response_time', name: 'Average first reply on cases', group: 'service_sellers', unit: 'duration_hours', audience: 'staff', higherIsBetter: false,
    definition: 'Average time from opening a support case to its first reply (by Marketly support, or the seller when the seller handles the case), for cases opened in the range that got a reply.',
    formula: 'Σ support.caseStatsByDay.firstReplyMinutesTotal ÷ Σ firstReplied ÷ 60',
    includes: [], excludes: ['Cases without a reply yet'],
    dateBasisOptions: EVENT, defaultDateBasis: 'event', relatedKeys: ['service.first_reply_on_time', 'service.message_reply_time'],
  },
  {
    key: 'service.first_reply_on_time', name: 'Cases answered within target', group: 'service_sellers', unit: 'percent', audience: 'staff',
    definition: 'Share of the cases opened in the range whose first reply came by the first-response target (targets count business hours).',
    formula: 'Σ support.caseStatsByDay.firstReplyWithinTarget ÷ Σ opened × 100',
    includes: [], excludes: [],
    dateBasisOptions: EVENT, defaultDateBasis: 'event', relatedKeys: ['service.response_time'],
  },
  {
    key: 'service.message_reply_time', name: 'Average seller reply to messages', group: 'service_sellers', unit: 'duration_hours', audience: 'staff', higherIsBetter: false,
    definition: "Average time from a customer's message to the seller's reply, for customer messages sent in the range that got a reply.",
    formula: 'Σ messaging.replyStatsByDay.replyMinutesTotal ÷ Σ replied ÷ 60',
    includes: ['Order and product conversations'], excludes: ['Messages still waiting for a reply'],
    dateBasisOptions: EVENT, defaultDateBasis: 'event', relatedKeys: ['service.messages_received', 'service.response_time'],
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
  {
    key: 'ads.dismissals', name: 'Ad dismissals', group: 'customers_marketing_ads', unit: 'count', audience: 'staff', higherIsBetter: false,
    definition: 'Times shoppers closed or hid an ad (advertising daily totals).',
    formula: 'Σ fact_campaigns_daily.dismissals (advertising.dailyPerformance, pulled daily)',
    includes: [], excludes: [],
    dateBasisOptions: EVENT, defaultDateBasis: 'event', relatedKeys: ['ads.displays'],
  },
  /* ---------------------------------------------------------------- financial statistics (docs/09 §3.3) */
  /* seller earnings and profit: order-date figures (fact_order_items) and charge-date figures (fact_marketplace_finance_daily) */
  {
    key: 'seller.item_sales', name: 'Item sales', group: 'marketplace_finance', unit: 'money', audience: 'seller',
    definition: 'What your items sold for, after your own discounts, on the orders of the period. Discounts Marketly paid for are paid to you, so they count in your item sales. Shipping and tax are not included.',
    formula: 'Σ fact_order_items.item_minor + discount_platform_minor of your items, by order date',
    includes: ['Marketly-funded discounts'], excludes: ['Your own discounts', 'Shipping', 'Tax'],
    dateBasisOptions: ['placement'], defaultDateBasis: 'placement', relatedKeys: ['seller.net_earnings', 'seller.refunds'],
  },
  {
    key: 'seller.shipping_charged', name: 'Shipping charged', group: 'marketplace_finance', unit: 'money', audience: 'seller',
    definition: 'Shipping customers paid on the orders of the period.',
    formula: 'Σ fact_order_items.shipping_minor of your items, by order date',
    includes: [], excludes: ['Shipping Marketly paid for'],
    dateBasisOptions: ['placement'], defaultDateBasis: 'placement', relatedKeys: ['seller.net_earnings'],
  },
  {
    key: 'seller.refunds', name: 'Refunds and cancellations', group: 'marketplace_finance', unit: 'money', audience: 'seller', higherIsBetter: false,
    definition: 'Item value cancelled or refunded so far on the orders of the period. A refund later on can still change a past period.',
    formula: 'Σ fact_order_items.cancelled_minor + refunded_minor of your items, by order date',
    includes: ['Cancellations', 'Refunds sent'], excludes: ['Refunds approved but not sent'],
    dateBasisOptions: ['placement'], defaultDateBasis: 'placement', relatedKeys: ['seller.item_sales'],
  },
  {
    key: 'seller.fees', name: 'Marketplace fees', group: 'marketplace_finance', unit: 'money', audience: 'seller', higherIsBetter: false,
    definition: 'Commission charged on the orders of the period, less fees given back on cancellations and refunds.',
    formula: 'Σ fact_order_items.fee_minor of your items (finance fee charges net of fee refunds), by order date',
    includes: ['Fee refunds'], excludes: ['Advertising', 'Fulfilled by Marketly fees', 'Label charges'],
    dateBasisOptions: ['placement'], defaultDateBasis: 'placement', relatedKeys: ['seller.net_earnings'],
  },
  {
    key: 'seller.ad_spend', name: 'Ad spend', group: 'marketplace_finance', unit: 'money', audience: 'seller', higherIsBetter: false,
    definition: 'Advertising charged to you, less ad credits, on the day it was charged.',
    formula: 'Σ fact_marketplace_finance_daily.ad_charges_minor, by charge date',
    includes: ['Ad credits'], excludes: [],
    dateBasisOptions: EVENT, defaultDateBasis: 'event', relatedKeys: ['seller.net_earnings'],
  },
  {
    key: 'seller.service_fees', name: 'Service fees', group: 'marketplace_finance', unit: 'money', audience: 'seller', higherIsBetter: false,
    definition: 'Fulfilled by Marketly fees charged to you, less reversals, on the day they were charged.',
    formula: 'Σ fact_marketplace_finance_daily.service_fees_minor, by charge date',
    includes: ['Reversals'], excludes: [],
    dateBasisOptions: EVENT, defaultDateBasis: 'event', relatedKeys: ['seller.net_earnings'],
  },
  {
    key: 'seller.label_charges', name: 'Label charges', group: 'marketplace_finance', unit: 'money', audience: 'seller', higherIsBetter: false,
    definition: 'Shipping labels bought through Marketly, less voided labels, on the day they were charged.',
    formula: 'Σ fact_marketplace_finance_daily.label_charges_minor, by charge date',
    includes: ['Voided labels'], excludes: [],
    dateBasisOptions: EVENT, defaultDateBasis: 'event', relatedKeys: ['seller.net_earnings'],
  },
  {
    key: 'seller.adjustments', name: 'Adjustments', group: 'marketplace_finance', unit: 'money', audience: 'seller',
    definition: 'Credits and debits from Marketly with a reason, and payment disputes lost, on the day they were posted. Credits add, debits take away.',
    formula: 'Σ fact_marketplace_finance_daily.adjustments_minor − chargebacks_minor, by posting date',
    includes: ['Credits from Marketly', 'Debits', 'Payment disputes lost'], excludes: ['Holds (money kept aside, not taken)'],
    dateBasisOptions: EVENT, defaultDateBasis: 'event', relatedKeys: ['seller.net_earnings'],
  },
  {
    key: 'seller.net_earnings', name: 'Net earnings', group: 'marketplace_finance', unit: 'money', audience: 'seller',
    definition: 'What you keep: item sales and shipping charged, less refunds, marketplace fees, ad spend, service fees and label charges, plus or minus adjustments.',
    formula: 'seller.item_sales + seller.shipping_charged − seller.refunds − seller.fees − seller.ad_spend − seller.service_fees − seller.label_charges + seller.adjustments',
    includes: [], excludes: ['Your product costs (see Profit)', 'Payouts'],
    dateBasisOptions: ['placement'], defaultDateBasis: 'placement', relatedKeys: ['seller.profit', 'seller.paid_out'],
  },
  {
    key: 'seller.product_cost', name: 'Product cost', group: 'marketplace_finance', unit: 'money', audience: 'seller', higherIsBetter: false,
    definition: 'Your unit cost on each offer, times the units sold, for the sales that have a cost. Only you see your costs.',
    formula: 'Σ fact_order_items.buying_cost_minor of your items (unit cost in effect on the order date × quantity), by order date',
    includes: [], excludes: ['Sales of offers without a unit cost'],
    dateBasisOptions: ['placement'], defaultDateBasis: 'placement', relatedKeys: ['seller.profit', 'seller.cost_coverage_pct'],
  },
  {
    key: 'seller.profit', name: 'Profit', group: 'marketplace_finance', unit: 'money', audience: 'seller',
    definition: 'Net earnings less the product cost of the sales that have a cost.',
    formula: 'seller.net_earnings − seller.product_cost',
    includes: [], excludes: ['Costs you have not entered'],
    dateBasisOptions: ['placement'], defaultDateBasis: 'placement', relatedKeys: ['seller.margin_pct', 'seller.cost_coverage_pct'],
  },
  {
    key: 'seller.margin_pct', name: 'Margin', group: 'marketplace_finance', unit: 'percent', audience: 'seller',
    definition: 'Profit as a share of item sales. In Earnings and profit, profit keeps the sales without a unit cost at no cost, so check the cost coverage; in Profit by product, profit and sales count only the sales that have a cost.',
    formula: 'seller.profit ÷ item sales × 100 (Profit by product: ÷ item sales with a unit cost)',
    includes: [], excludes: [],
    dateBasisOptions: ['placement'], defaultDateBasis: 'placement', relatedKeys: ['seller.profit'],
  },
  {
    key: 'seller.paid_out', name: 'Paid out', group: 'marketplace_finance', unit: 'money', audience: 'seller',
    definition: 'Payouts that reached your bank account, on the day they were paid.',
    formula: 'Σ fact_marketplace_finance_daily.payouts_paid_minor, by payment date',
    includes: [], excludes: ['Failed payouts'],
    dateBasisOptions: EVENT, defaultDateBasis: 'event', relatedKeys: ['seller.net_earnings'],
  },
  {
    key: 'seller.cost_coverage_pct', name: 'Sales with a cost', group: 'marketplace_finance', unit: 'percent', audience: 'seller',
    definition: 'The share of your item sales whose offer had a unit cost on the order date. Profit covers these sales only.',
    formula: 'item sales with a unit cost ÷ seller.item_sales × 100',
    includes: [], excludes: [],
    dateBasisOptions: ['placement'], defaultDateBasis: 'placement', relatedKeys: ['seller.product_cost'],
  },
  {
    key: 'seller.products_without_cost', name: 'Products without a cost', group: 'marketplace_finance', unit: 'count', audience: 'seller', higherIsBetter: false,
    definition: 'Products you sold in the range with at least one sale that has no unit cost.',
    formula: 'Count of your offers sold in the range with a fact_order_items row whose buying_cost_minor is null',
    includes: [], excludes: [],
    dateBasisOptions: ['placement'], defaultDateBasis: 'placement', relatedKeys: ['seller.sales_without_cost'],
  },
  {
    key: 'seller.sales_without_cost', name: 'Item sales without a cost', group: 'marketplace_finance', unit: 'money', audience: 'seller', higherIsBetter: false,
    definition: 'Item sales in the range whose offer had no unit cost on the order date: profit leaves them out.',
    formula: 'Σ item_minor + discount_platform_minor of your rows whose buying_cost_minor is null, by order date',
    includes: [], excludes: [],
    dateBasisOptions: ['placement'], defaultDateBasis: 'placement', relatedKeys: ['seller.products_without_cost', 'seller.cost_coverage_pct'],
  },
  /* platform income statement: by the day finance booked each amount */
  {
    key: 'platform.fee_income_gross', name: 'Fee income charged', group: 'marketplace_finance', unit: 'money', audience: 'staff',
    definition: 'Commission and fees charged to sellers, on the day finance booked them.',
    formula: 'Σ fact_marketplace_finance_daily.fee_gross_minor (ledger marketplace_fee)',
    includes: [], excludes: ['Fee refunds (shown on their own)'],
    dateBasisOptions: EVENT, defaultDateBasis: 'event', relatedKeys: ['platform.fee_refunds', 'platform.fee_income_net'],
  },
  {
    key: 'platform.fee_refunds', name: 'Fee refunds', group: 'marketplace_finance', unit: 'money', audience: 'staff', higherIsBetter: false,
    definition: 'Fees given back to sellers on cancellations, refunds and won disputes, on the day finance booked them.',
    formula: 'Σ fact_marketplace_finance_daily.fee_refunds_minor (ledger fee_refund)',
    includes: [], excludes: [],
    dateBasisOptions: EVENT, defaultDateBasis: 'event', relatedKeys: ['platform.fee_income_gross'],
  },
  {
    key: 'platform.fee_income_net', name: 'Fee income', group: 'marketplace_finance', unit: 'money', audience: 'staff',
    definition: 'Fees charged less fees given back: the same figure as Marketplace fee income, updated every 15 minutes.',
    formula: 'platform.fee_income_gross − platform.fee_refunds',
    includes: [], excludes: ['Seller sales'],
    dateBasisOptions: EVENT, defaultDateBasis: 'event', relatedKeys: ['marketplace.fee_income'],
  },
  {
    key: 'platform.ad_income', name: 'Advertising income', group: 'marketplace_finance', unit: 'money', audience: 'staff',
    definition: 'Seller advertising charged, less ad credits.',
    formula: 'Σ fact_marketplace_finance_daily.ad_charges_minor',
    includes: [], excludes: [],
    dateBasisOptions: EVENT, defaultDateBasis: 'event', relatedKeys: ['marketplace.ad_income'],
  },
  {
    key: 'platform.service_fees', name: 'Service fee income', group: 'marketplace_finance', unit: 'money', audience: 'staff',
    definition: 'Fulfilled by Marketly fees charged to sellers, less reversals.',
    formula: 'Σ fact_marketplace_finance_daily.service_fees_minor',
    includes: [], excludes: [],
    dateBasisOptions: EVENT, defaultDateBasis: 'event', relatedKeys: ['marketplace.service_fees'],
  },
  {
    key: 'platform.label_income', name: 'Label charges to sellers', group: 'marketplace_finance', unit: 'money', audience: 'staff',
    definition: 'Shipping labels charged to sellers, less voids. What Marketly pays the carriers is in platform costs.',
    formula: 'Σ fact_marketplace_finance_daily.label_charges_minor (ledger label_charge)',
    includes: [], excludes: ['Carrier label costs (platform costs)'],
    dateBasisOptions: EVENT, defaultDateBasis: 'event', relatedKeys: ['platform.costs'],
  },
  {
    key: 'platform.discount_funding', name: 'Platform-funded discounts', group: 'marketplace_finance', unit: 'money', audience: 'staff',
    definition: 'Coupon discounts Marketly paid for on marketplace seller items, as a negative amount, less reversals. Discounts on Official Store items are in its own margin.',
    formula: '− Σ fact_company_daily.amount_minor, source discount_funding, kind platform',
    includes: ['Reversals'], excludes: ['Seller-funded discounts', 'Official Store discounts'],
    dateBasisOptions: EVENT, defaultDateBasis: 'event', relatedKeys: ['marketplace.discount_funding'],
  },
  {
    key: 'platform.costs', name: 'Platform costs', group: 'marketplace_finance', unit: 'money', audience: 'staff', higherIsBetter: false,
    definition: 'Marketplace costs Marketly bore, less recoveries: labels and refund shares on seller orders, goodwill store credit, written-off seller debts and the like.',
    formula: 'Σ fact_company_daily.amount_minor, source platform_cost',
    includes: ['Recoveries (negative)'], excludes: ['Official Store trading costs'],
    dateBasisOptions: EVENT, defaultDateBasis: 'event', relatedKeys: ['platform.net_income'],
  },
  {
    key: 'platform.net_income', name: 'Marketplace net income', group: 'marketplace_finance', unit: 'money', audience: 'staff',
    definition: 'What the marketplace earned: fee income, advertising, service fees and label charges, less platform-funded discounts and platform costs.',
    formula: 'platform.fee_income_net + platform.ad_income + platform.service_fees + platform.label_income + platform.discount_funding − platform.costs',
    includes: [], excludes: ['Official Store trading (see Company result)'],
    dateBasisOptions: EVENT, defaultDateBasis: 'event', relatedKeys: ['platform.company_result'],
  },
  {
    key: 'platform.official_net_margin', name: 'Official Store net margin', group: 'marketplace_finance', unit: 'money', audience: 'staff',
    definition: 'The Official Store net margin of Official Store profit and loss: gross margin (sales less cost of goods sold, by order date) less shipping, returns, write-offs and lost disputes, plus supplier credits (by booking day).',
    formula: 'trading.net_margin',
    includes: [], excludes: ['Stock bought from suppliers'],
    dateBasisOptions: EVENT, defaultDateBasis: 'event', relatedKeys: ['trading.net_margin', 'platform.company_result'],
  },
  {
    key: 'platform.company_result', name: 'Company result', group: 'marketplace_finance', unit: 'money', audience: 'staff',
    definition: 'Marketplace net income plus the Official Store net margin. Tax collected and store credit are not included.',
    formula: 'platform.net_income + platform.official_net_margin',
    includes: [], excludes: ['Tax collected', 'Store credit liability'],
    dateBasisOptions: EVENT, defaultDateBasis: 'event', relatedKeys: ['platform.net_income', 'platform.official_net_margin'],
  },
  /* seller money: end-of-day balances (fact_seller_balances_daily) and payouts */
  {
    key: 'sellers.owed', name: 'Owed to sellers', group: 'marketplace_finance', unit: 'money', audience: 'staff',
    definition: 'Pending and available seller earnings at the end of the day, summed over sellers (a seller below zero counts as zero). A balance, not a sum over days.',
    formula: 'Σ over sellers of max(0, pending_minor + available_minor) on the last day of each period',
    includes: ['Pending', 'Available'], excludes: ['Held amounts (shown on their own)'],
    dateBasisOptions: EVENT, defaultDateBasis: 'event', relatedKeys: ['sellers.held', 'sellers.negative'],
  },
  {
    key: 'sellers.held', name: 'Held for sellers', group: 'marketplace_finance', unit: 'money', audience: 'staff',
    definition: 'Seller money on hold at the end of the day.',
    formula: 'Σ fact_seller_balances_daily.held_minor on the last day of each period',
    includes: [], excludes: [],
    dateBasisOptions: EVENT, defaultDateBasis: 'event', relatedKeys: ['sellers.owed'],
  },
  {
    key: 'sellers.negative', name: 'Owed by sellers', group: 'marketplace_finance', unit: 'money', audience: 'staff', higherIsBetter: false,
    definition: 'Negative seller balances at the end of the day: what sellers owe Marketly.',
    formula: 'Σ fact_seller_balances_daily.owed_minor on the last day of each period',
    includes: [], excludes: [],
    dateBasisOptions: EVENT, defaultDateBasis: 'event', relatedKeys: ['sellers.negative_count', 'marketplace.amounts_owed'],
  },
  {
    key: 'sellers.negative_count', name: 'Sellers below zero', group: 'marketplace_finance', unit: 'count', audience: 'staff', higherIsBetter: false,
    definition: 'Sellers whose available balance was below zero at the end of the day.',
    formula: 'Count of fact_seller_balances_daily rows with owed_minor > 0 on the last day of each period',
    includes: [], excludes: [],
    dateBasisOptions: EVENT, defaultDateBasis: 'event', relatedKeys: ['sellers.negative'],
  },
  {
    key: 'sellers.payouts_paid', name: 'Payouts paid', group: 'marketplace_finance', unit: 'money', audience: 'staff',
    definition: 'Payouts that reached sellers, on the day they were paid.',
    formula: 'Σ fact_marketplace_finance_daily.payouts_paid_minor',
    includes: [], excludes: ['Failed payouts'],
    dateBasisOptions: EVENT, defaultDateBasis: 'event', relatedKeys: ['marketplace.payouts_paid'],
  },
  {
    key: 'sellers.payouts_failed', name: 'Failed payouts', group: 'marketplace_finance', unit: 'count', audience: 'staff', higherIsBetter: false,
    definition: 'Payouts the bank refused or returned, on the day they failed.',
    formula: 'Σ fact_marketplace_finance_daily.payouts_failed',
    includes: [], excludes: [],
    dateBasisOptions: EVENT, defaultDateBasis: 'event', relatedKeys: ['sellers.payouts_paid'],
  },
  /*
   * Official Store profit and loss: sales, cost of goods sold and gross margin by order date (fact_order_items, as
   * trading.margin), the other lines by booking day (fact_company_daily, source trading)
   */
  {
    key: 'trading.returns_cost', name: 'Returns cost', group: 'company_trading', unit: 'money', audience: 'staff', higherIsBetter: false,
    definition: 'Refunds sent for Official Store returns, booked as a company cost, by booking day.',
    formula: 'Σ fact_company_daily.amount_minor, source trading, kind return',
    includes: [], excludes: ['Refunds on seller items'],
    dateBasisOptions: EVENT, defaultDateBasis: 'event', relatedKeys: ['trading.return_losses', 'trading.net_margin'],
  },
  {
    key: 'trading.net_margin', name: 'Net margin', group: 'company_trading', unit: 'money', audience: 'staff',
    definition: 'Official Store gross margin (sales less cost of goods sold, by order date, for items whose cost is known) less shipping expense, returns cost, write-offs and lost disputes, plus supplier credits (by booking day). Stock bought from suppliers and discounts are not taken off: sales are already after discounts.',
    formula: 'trading.gross_margin − shipping_expense − return − write_off − chargeback_loss + supplier_credit (fact_company_daily, source trading)',
    includes: ['Supplier credits'], excludes: ['Marketplace income', 'Stock bought from suppliers', 'Sales whose cost is not known yet'],
    dateBasisOptions: EVENT, defaultDateBasis: 'event', relatedKeys: ['trading.net_margin_pct', 'trading.gross_margin', 'trading.stock_bought'],
  },
  {
    key: 'trading.net_margin_pct', name: 'Net margin %', group: 'company_trading', unit: 'percent', audience: 'staff',
    definition: 'Net margin as a share of the Official Store sales that have a known cost (the sales the margin counts).',
    formula: 'trading.net_margin ÷ sales with a known cost × 100',
    includes: [], excludes: [],
    dateBasisOptions: EVENT, defaultDateBasis: 'event', relatedKeys: ['trading.net_margin'],
  },
  {
    key: 'trading.stock_bought', name: 'Stock bought', group: 'company_trading', unit: 'money', audience: 'staff', higherIsBetter: false,
    definition: 'What the goods received from suppliers cost, on the day finance booked the receipt. Stock bought is not a cost of sales: it is shown next to the profit and loss and not taken off the margin.',
    formula: 'Σ fact_company_daily.amount_minor, source trading, kind buying_cost',
    includes: [], excludes: ['Supplier credits (shown on their own)'],
    dateBasisOptions: EVENT, defaultDateBasis: 'event', relatedKeys: ['trading.buying_cost', 'trading.purchasing_booked'],
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
    metrics: ['marketplace.seller_sales', 'marketplace.fee_income', 'marketplace.discount_funding', 'marketplace.held', 'marketplace.payouts_paid', 'marketplace.amounts_owed', 'marketplace.ad_income', 'marketplace.service_fees'],
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
    metrics: ['service.on_time_dispatch', 'service.valid_tracking', 'service.overdue_dispatch', 'service.seller_cancellations', 'service.delivery_exceptions', 'service.cases_opened', 'service.case_backlog', 'service.messages_received', 'service.marketly_on_time_dispatch'],
    dimensions: ['day', 'seller'], filters: [RANGE, SELLER],
    layout: ['kpis', 'series', 'table', 'definitions'],
  },
  {
    key: 'service.returns', title: 'Returns by reason', group: 'service_sellers', audience: 'staff', permission: 'reports.service.view',
    description: 'Return requests by the reason customers gave, with inspection outcomes and the return rate.',
    metrics: ['service.return_requests', 'service.return_rate'],
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
  /*
   * G74: the design's report library (23 reports in six areas) beyond the ten above, from the same read models and
   * public APIs. The company trading costs (finance.companyCostsByDay), Complaint patterns and response times
   * (support.caseStatsByDay, messaging.replyStatsByDay) are read from their modules when the report runs.
   */
  {
    key: 'trading.purchasing', title: 'Purchasing cost', group: 'company_trading', audience: 'staff', permission: 'reports.trading.view',
    description: 'Buying cost of the Official Store units sold, next to the purchasing costs and supplier credits booked in finance.',
    metrics: ['trading.buying_cost', 'trading.purchasing_booked', 'trading.supplier_credits'],
    dimensions: ['day'], filters: [RANGE],
    layout: ['kpis', 'series', 'table', 'definitions', 'callouts'],
  },
  {
    key: 'trading.discounts_shipping', title: 'Discounts and shipping expense', group: 'company_trading', audience: 'staff', permission: 'reports.trading.view',
    description: 'Customer discounts the Official Store paid for and the shipping it paid, per day, next to Official Store sales.',
    metrics: ['trading.discounts', 'trading.shipping_expense', 'trading.official_sales'],
    dimensions: ['day'], filters: [RANGE],
    layout: ['kpis', 'series', 'table', 'definitions'],
  },
  {
    key: 'trading.returns_cost', title: 'Returns cost', group: 'company_trading', audience: 'staff', permission: 'reports.trading.view',
    description: 'What returns, write-offs and lost payment disputes cost the Official Store, per day.',
    metrics: ['trading.return_losses', 'trading.write_offs', 'trading.chargeback_losses'],
    dimensions: ['day'], filters: [RANGE],
    layout: ['kpis', 'series', 'table', 'definitions'],
  },
  {
    key: 'service.complaints', title: 'Complaint patterns', group: 'service_sellers', audience: 'staff', permission: 'reports.service.view',
    description: 'Support cases customers opened, by the reason they chose and by seller, with the reasons that grew most against the previous period.',
    metrics: ['service.complaints', 'service.response_time'],
    dimensions: ['day', 'reason', 'seller'], filters: [RANGE, SELLER],
    layout: ['kpis', 'series', 'breakdown', 'table', 'definitions'],
  },
  {
    key: 'commerce.orders', title: 'Orders and average order value', group: 'commerce', audience: 'staff', permission: 'reports.commerce.view',
    description: 'Orders, item sales and average order value per day, week or month.',
    metrics: ['commerce.orders', 'commerce.gross_sales', 'commerce.average_order_value'],
    dimensions: ['day', 'sold_by', 'seller', 'category'], filters: [RANGE, BASIS, SOLD_BY, SELLER, CATEGORY],
    layout: ['kpis', 'series', 'table', 'definitions'],
  },
  {
    key: 'marketplace.discount_funding', title: 'Discount funding', group: 'marketplace_finance', audience: 'staff', permission: 'reports.marketplace-finance.view',
    description: 'Customer discounts on marketplace seller items: what the platform paid for and what sellers paid for, by seller.',
    metrics: ['marketplace.discount_funding', 'marketplace.seller_sales'],
    dimensions: ['day', 'seller'], filters: [RANGE, BASIS, SELLER],
    layout: ['kpis', 'series', 'table', 'definitions'],
  },
  {
    key: 'marketplace.owed_to_sellers', title: 'Amounts owed to sellers', group: 'marketplace_finance', audience: 'staff', permission: 'reports.marketplace-finance.view',
    description: 'Seller balances now (pending, available and held) and negative balances, for the sellers with sales or finance activity in the range.',
    metrics: ['marketplace.seller_balances', 'marketplace.amounts_owed'],
    dimensions: ['seller'], filters: [RANGE, SELLER],
    layout: ['kpis', 'table', 'definitions', 'callouts'],
  },
  {
    key: 'marketplace.payouts', title: 'Holds and completed payouts', group: 'marketplace_finance', audience: 'staff', permission: 'reports.marketplace-finance.view',
    description: 'Holds placed and released, and payouts paid or failed, per day and seller.',
    metrics: ['marketplace.held', 'marketplace.payouts_paid'],
    dimensions: ['day', 'seller'], filters: [RANGE, SELLER],
    layout: ['kpis', 'series', 'table', 'definitions'],
  },
  {
    key: 'discovery.stockouts', title: 'Stockouts', group: 'products_discovery', audience: 'staff', permission: 'reports.discovery.view',
    description: 'Products that were out of stock, for how long, and the views they had meanwhile.',
    metrics: ['discovery.stockout_hours'],
    dimensions: ['day', 'product'], filters: [RANGE, PRODUCT],
    layout: ['kpis', 'series', 'table', 'definitions'],
  },
  {
    key: 'service.dispatch', title: 'On-time dispatch', group: 'service_sellers', audience: 'staff', permission: 'reports.service.view',
    description: 'Packages dispatched on time, overdue and with valid tracking, by seller.',
    metrics: ['service.on_time_dispatch', 'service.valid_tracking', 'service.overdue_dispatch'],
    dimensions: ['day', 'seller'], filters: [RANGE, SELLER],
    layout: ['kpis', 'series', 'table', 'definitions'],
  },
  {
    key: 'service.delivery_issues', title: 'Delivery issues', group: 'service_sellers', audience: 'staff', permission: 'reports.service.view',
    description: 'Delivery exceptions reported by carriers (late, damaged, lost, returned to sender), by seller.',
    metrics: ['service.delivery_exceptions'],
    dimensions: ['day', 'seller'], filters: [RANGE, SELLER],
    layout: ['kpis', 'series', 'table', 'definitions'],
  },
  {
    key: 'service.cancellations', title: 'Seller cancellations', group: 'service_sellers', audience: 'staff', permission: 'reports.service.view',
    description: 'Items sellers cancelled, against the packages they dispatched, by seller.',
    metrics: ['service.seller_cancellations'],
    dimensions: ['day', 'seller'], filters: [RANGE, SELLER],
    layout: ['kpis', 'series', 'table', 'definitions'],
  },
  {
    key: 'service.cases', title: 'Response time and case backlog', group: 'service_sellers', audience: 'staff', permission: 'reports.service.view',
    description: 'Support cases opened, the first reply on them, the open case backlog, customer messages to sellers and how fast sellers reply, by seller.',
    metrics: ['service.cases_opened', 'service.case_backlog', 'service.response_time', 'service.first_reply_on_time', 'service.messages_received', 'service.message_reply_time'],
    dimensions: ['day', 'seller'], filters: [RANGE, SELLER],
    layout: ['kpis', 'series', 'table', 'definitions', 'callouts'],
  },
  {
    key: 'ads.performance', title: 'Ad displays, clicks, dismissals and spend', group: 'customers_marketing_ads', audience: 'staff', permission: 'reports.customers-marketing.view',
    description: 'Ad displays, clicks, dismissals and spending per day and per ad campaign.',
    metrics: ['ads.displays', 'ads.clicks', 'ads.dismissals', 'ads.spend'],
    dimensions: ['day', 'campaign'], filters: [RANGE],
    layout: ['kpis', 'series', 'table', 'definitions'],
  },
  /* ---------------------------------------------------------------- seller reports (always the caller's own seller) */
  {
    key: 'seller.product_sales', title: 'Product sales', group: SELLER_GROUP, audience: 'seller', permission: SELLER_PERMISSION,
    description: 'Your item sales and units by product, by order date.',
    metrics: ['commerce.gross_sales', 'commerce.units_sold', 'commerce.orders', 'service.return_rate'],
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
    description: 'Return requests on your items by the reason customers gave, and your return rate.',
    metrics: ['service.return_requests', 'service.return_rate'],
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
  /* ---------------------------------------------------------------- financial statistics (docs/09 §3.3) */
  {
    key: 'seller.earnings', title: 'Earnings and profit', group: SELLER_GROUP, audience: 'seller', permission: 'finance.balances.view',
    description: 'Item sales, shipping, refunds, fees, ad spend, service fees, labels and adjustments down to your net earnings, then your product cost, profit and margin, per day, week or month.',
    metrics: ['seller.item_sales', 'seller.shipping_charged', 'seller.refunds', 'seller.fees', 'seller.ad_spend', 'seller.service_fees', 'seller.label_charges', 'seller.adjustments', 'seller.net_earnings', 'seller.product_cost', 'seller.profit', 'seller.margin_pct', 'seller.paid_out', 'seller.cost_coverage_pct'],
    dimensions: ['day'], filters: [RANGE],
    layout: ['kpis', 'series', 'breakdown', 'table', 'definitions', 'callouts'],
  },
  {
    key: 'seller.profit_by_product', title: 'Profit by product', group: SELLER_GROUP, audience: 'seller', permission: 'finance.balances.view',
    description: 'Per product: units, item sales, refunds, fees, your product cost, profit and margin, and whether a unit cost is set.',
    metrics: ['seller.profit', 'seller.margin_pct', 'seller.products_without_cost', 'seller.sales_without_cost', 'seller.item_sales', 'seller.product_cost'],
    dimensions: ['product'], filters: [RANGE, PRODUCT, CATEGORY],
    layout: ['kpis', 'breakdown', 'table', 'definitions', 'callouts'],
  },
  {
    key: 'finance.platform_income', title: 'Platform income', group: 'marketplace_finance', audience: 'staff', permission: 'reports.marketplace-finance.view',
    description: 'The marketplace income statement by booking day: fee income, advertising, service fees and labels, less platform-funded discounts and platform costs, then the Official Store net margin and the company result.',
    metrics: ['platform.fee_income_gross', 'platform.fee_refunds', 'platform.fee_income_net', 'platform.ad_income', 'platform.service_fees', 'platform.label_income', 'platform.discount_funding', 'platform.costs', 'platform.net_income', 'platform.official_net_margin', 'platform.company_result'],
    dimensions: ['day', 'category', 'seller'], filters: [RANGE],
    layout: ['kpis', 'series', 'breakdown', 'table', 'definitions', 'callouts'],
  },
  {
    key: 'finance.seller_money', title: 'Seller balances and payouts', group: 'marketplace_finance', audience: 'staff', permission: 'reports.marketplace-finance.view',
    description: 'What Marketly owes sellers and holds for them at the end of each day, sellers below zero, and payouts paid and failed, with the sellers that bring the most fee income.',
    metrics: ['sellers.owed', 'sellers.held', 'sellers.negative', 'sellers.negative_count', 'sellers.payouts_paid', 'sellers.payouts_failed'],
    dimensions: ['day', 'seller'], filters: [RANGE, SELLER],
    layout: ['kpis', 'series', 'table', 'definitions', 'callouts'],
  },
  {
    key: 'trading.pnl', title: 'Official Store profit and loss', group: 'company_trading', audience: 'staff', permission: 'reports.trading.view',
    description: 'Official Store sales down to net margin: cost of goods sold and gross margin by order date, then shipping, returns, write-offs and lost disputes by booking day. Stock bought from suppliers is shown on its own.',
    metrics: ['trading.official_sales', 'trading.buying_cost', 'trading.gross_margin', 'trading.discounts', 'trading.shipping_expense', 'trading.returns_cost', 'trading.write_offs', 'trading.chargeback_losses', 'trading.net_margin', 'trading.net_margin_pct', 'trading.stock_bought'],
    dimensions: ['day'], filters: [RANGE],
    layout: ['kpis', 'series', 'breakdown', 'table', 'definitions', 'callouts'],
  },
];

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
  { key: 'marketplace_finance', table: 'fact_marketplace_finance_daily', pulled: true, description: 'Per seller and day: marketplace sales, fee income, discount funding, holds, payouts, amounts owed, ad charges, and the ledger totals pulled every 15 minutes (fees, fee refunds, refunds, shipping charged, labels, adjustments, chargebacks)', sourceEvents: ['finance.payout.paid', 'finance.payout.failed', 'finance.hold.placed', 'finance.hold.released', 'finance.amount_owed.created', 'advertising.charge.posted', 'advertising.charge.credited', 'fulfillment-service.fee.charged', 'fulfillment-service.fee.reversed'] },
  { key: 'company_finance', table: 'fact_company_daily', pulled: true, description: 'Per day: Official Store trading, platform costs and platform-funded discounts on marketplace items, pulled from finance every 15 minutes', sourceEvents: [] },
  { key: 'seller_balances', table: 'fact_seller_balances_daily', pulled: true, description: 'Per seller and day: pending, available, held and owed at the end of the day, rebuilt from the finance ledger every 15 minutes', sourceEvents: [] },
  { key: 'service', table: 'fact_service_daily', description: 'Per seller and day: dispatch, tracking, cancellations, delivery issues, messages and cases (dispatches the seller made)', sourceEvents: ['shipping.shipment.dispatched', 'shipping.dispatch.overdue', 'shipping.shipment.exception', 'orders.item.cancelled', 'messaging.message.sent', 'support.case.opened', 'support.case.resolved'] },
  { key: 'marketly_fulfillment', table: 'fact_marketly_fulfillment_daily', description: "Per seller of record and day: dispatches, overdue packages and delivery issues of Marketly's warehouse for Fulfilled by Marketly groups", sourceEvents: ['shipping.shipment.dispatched', 'shipping.dispatch.overdue', 'shipping.shipment.exception'] },
  { key: 'discovery', table: 'fact_discovery_daily', description: 'Per product and day: views, cart additions, units ordered and out-of-stock minutes', sourceEvents: ['cart.item.added', 'inventory.stock.changed', 'orders.order.accepted'] },
  { key: 'search_misses', table: 'fact_search_misses_daily', pulled: true, description: 'Searches without an available result per day (search.zeroResultStats)', sourceEvents: [] },
  { key: 'customers', table: 'fact_customers', description: 'First and last order, order count and net spend per buyer', sourceEvents: ['orders.order.placed', 'orders.order.accepted', 'payments.refund.sent'] },
  { key: 'campaigns', table: 'fact_campaigns_daily', pulled: true, description: 'Per campaign and day: promotion sales, discount cost and funding; ad spend, displays, clicks and attributed purchases', sourceEvents: ['promotions.coupon.redeemed', 'promotions.redemption.reversed', 'advertising.charge.posted', 'advertising.charge.credited'] },
];

export const readModelDef = (key: string) => READ_MODELS.find((m) => m.key === key);
