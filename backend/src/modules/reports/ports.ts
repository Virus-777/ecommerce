/**
 * What the reports service needs from the outside world, database-agnostic.
 * The MongoDB adapter lives in infra/mongo/.
 */
import type { Page } from '../../spec/common.js';
import type { ReportsDb } from '../../spec/reports.js';
import type { PageRequest } from '../../kernel/lib/pagination.js';

export type Table = keyof ReportsDb;
export type Row<T extends Table> = ReportsDb[T];

export type MetricRow = Row<'metric_definitions'>;
export type VersionRow = Row<'metric_versions'>;
export type SuggestionRow = Row<'metric_suggestions'>;
export type ReportRow = Row<'report_definitions'>;
export type GroupRow = Row<'report_groups'>;
export type SavedViewRow = Row<'saved_views'>;
export type ScheduleRow = Row<'report_schedules'>;
export type DatasetRow = Row<'export_datasets'>;
export type JobRow = Row<'export_jobs'>;
export type OrderItemFact = Row<'fact_order_items'>;
export type CheckpointRow = Row<'read_model_checkpoints'>;
export type OwnerChangeRow = Row<'metric_owner_changes'>;

/** Filters shared by the sales facts (fact_order_items) */
export interface SalesFilter {
  /** Instants of the range on the chosen date basis column */
  basis: 'placed_at' | 'paid_at' | 'shipped_at' | 'completed_at' | 'cancelled_at';
  start: Date;
  end: Date;
  timeZone: string;
  ownerType?: 'official' | 'seller';
  sellerId?: string;
  categoryId?: string;
  productId?: string;
}

export type SalesGroup = 'bucket' | 'owner_type' | 'seller_id' | 'product_id' | 'category_id' | 'cancelled_by' | 'customer' | 'none';

export interface SalesAgg {
  key: string | null;
  gross: number;
  tax: number;
  cancelled: number;
  refunded: number;
  orders: number;
  units: number;
  /** Item value of rows with a known buying cost, and that cost */
  costedSales: number;
  cost: number;
  buyers: number;
  platformDiscount: number;
  sellerDiscount: number;
}

export interface DailyFilter {
  from: string;
  to: string;
  sellerId?: string;
  productId?: string;
  campaignKind?: 'promotion' | 'ad';
}

/** Daily fact tables keyed by day */
export type DailyTable = 'fact_marketplace_finance_daily' | 'fact_service_daily' | 'fact_marketly_fulfillment_daily' | 'fact_discovery_daily' | 'fact_search_misses_daily' | 'fact_campaigns_daily';

/** Persistence for this module's own tables (reports schema). */
export interface ReportsRepository {
  transaction<T>(fn: (tx: ReportsRepository) => Promise<T>): Promise<T>;

  /* catalogue and definitions */
  seedGroup(row: GroupRow): Promise<void>;
  listGroups(): Promise<GroupRow[]>;
  /** Names the owner of a report group; undefined for an unknown group */
  setGroupOwner(key: string, ownerStaffId: string): Promise<GroupRow | undefined>;
  seedMetric(row: MetricRow, version: VersionRow): Promise<void>;
  getMetric(key: string, opts?: { forUpdate?: boolean }): Promise<MetricRow | undefined>;
  listMetrics(filter: { group?: string; status?: string; keys?: string[] }): Promise<MetricRow[]>;
  insertMetric(row: MetricRow): Promise<MetricRow>;
  updateMetric(key: string, patch: Partial<MetricRow>): Promise<MetricRow>;
  insertVersion(row: VersionRow): Promise<void>;
  listVersions(key: string): Promise<VersionRow[]>;
  insertOwnerChange(row: OwnerChangeRow): Promise<void>;
  /** Owner history of a metric, newest first */
  listOwnerChanges(key: string): Promise<OwnerChangeRow[]>;
  /** Latest published version of each metric in effect on `day` */
  versionsInEffect(keys: string[] | null, day: string): Promise<VersionRow[]>;
  insertSuggestion(row: SuggestionRow): Promise<SuggestionRow>;
  getSuggestion(id: string, opts?: { forUpdate?: boolean }): Promise<SuggestionRow | undefined>;
  updateSuggestion(id: string, patch: Partial<SuggestionRow>): Promise<SuggestionRow>;
  listSuggestions(key: string): Promise<SuggestionRow[]>;
  upsertReport(row: ReportRow): Promise<void>;
  getReport(key: string): Promise<ReportRow | undefined>;
  listReports(filter: { audience?: string; active?: boolean }): Promise<ReportRow[]>;

  /* saved views and schedules */
  listSavedViews(ownerId: string, reportKey?: string): Promise<SavedViewRow[]>;
  insertSavedView(row: SavedViewRow): Promise<SavedViewRow>;
  getSavedView(id: string): Promise<SavedViewRow | undefined>;
  deleteSavedView(id: string): Promise<void>;
  insertSchedule(row: ScheduleRow): Promise<ScheduleRow>;
  listSchedules(): Promise<ScheduleRow[]>;
  getSchedule(id: string, opts?: { forUpdate?: boolean }): Promise<ScheduleRow | undefined>;
  updateSchedule(id: string, patch: Partial<ScheduleRow>): Promise<ScheduleRow>;
  dueSchedules(now: Date, limit: number): Promise<ScheduleRow[]>;

  /* export registry and jobs */
  listDatasets(): Promise<DatasetRow[]>;
  getDataset(key: string): Promise<DatasetRow | undefined>;
  /** Seed from the registry setting: keeps registered columns and title */
  seedDataset(row: DatasetRow): Promise<void>;
  /** Owner registration: columns, title and availability */
  registerDataset(row: DatasetRow): Promise<void>;
  insertJob(row: JobRow): Promise<JobRow>;
  getJob(id: string, opts?: { forUpdate?: boolean }): Promise<JobRow | undefined>;
  updateJob(id: string, patch: Partial<JobRow>): Promise<JobRow>;
  listJobs(filter: { requesterId?: string; sellerId?: string; dataset?: string; state?: string }, page: PageRequest): Promise<Page<JobRow>>;
  countActiveJobs(requesterId: string): Promise<number>;
  queuedJobs(limit: number): Promise<JobRow[]>;
  readyJobsExpiring(now: Date, limit: number): Promise<JobRow[]>;

  /* facts: order items */
  insertOrderItems(rows: OrderItemFact[]): Promise<string[]>;
  getOrderItems(orderId: string): Promise<OrderItemFact[]>;
  getOrderItemsByIds(ids: string[]): Promise<OrderItemFact[]>;
  updateOrderItems(where: { orderId?: string; itemIds?: string[]; groupId?: string | null; ownerType?: string; sellerId?: string | null; nullColumn?: keyof OrderItemFact }, patch: Partial<OrderItemFact>): Promise<number>;
  addToOrderItem(itemId: string, add: { cancelled_minor?: number; refunded_minor?: number }, patch: Partial<OrderItemFact>): Promise<OrderItemFact | undefined>;
  orderIdsWithFacts(afterOrderId: string | null, limit: number): Promise<string[]>;
  officialItemsWithoutCost(since: Date, limit: number): Promise<OrderItemFact[]>;
  salesAgg(f: SalesFilter, group: SalesGroup, bucket?: 'day' | 'week' | 'month'): Promise<SalesAgg[]>;
  /** Cancellations by cancellation date */
  cancellationsAgg(f: Omit<SalesFilter, 'basis'>, group: 'bucket' | 'cancelled_by' | 'none', bucket?: 'day' | 'week' | 'month'): Promise<{ key: string | null; amount: number; items: number }[]>;
  /** Seller sales and discount funding per seller and placement day (for the finance daily facts) */
  sellerSalesByDay(from: string, to: string, timeZone: string): Promise<{ sellerId: string; day: string; sales: number; platformDiscount: number; sellerDiscount: number }[]>;
  purchasesByDay(from: string, to: string, timeZone: string): Promise<{ productId: string; day: string; units: number }[]>;

  /* facts: refunds, returns, customers */
  insertRefund(row: Row<'fact_refunds'>): Promise<boolean>;
  /** A payout to the seller was paid on a day between these market days (inclusive) */
  paidPayoutBetween(sellerId: string, fromDay: string, toDay: string): Promise<boolean>;
  refundsAgg(f: { start: Date; end: Date; timeZone: string; ownerType?: string; sellerId?: string }, group: 'bucket' | 'reason' | 'none', bucket?: 'day' | 'week' | 'month'): Promise<{ key: string | null; amount: number; count: number }[]>;
  insertReturn(row: Row<'fact_returns'>): Promise<boolean>;
  updateReturn(returnId: string, patch: Partial<Row<'fact_returns'>>): Promise<number>;
  returnsAgg(f: { start: Date; end: Date; sellerId?: string; productId?: string; timeZone: string }, group: 'reason' | 'product_id' | 'seller_id' | 'outcome' | 'none'): Promise<{ key: string | null; requests: number; units: number }[]>;
  upsertCustomer(key: string, at: Date, spend: number): Promise<void>;
  adjustCustomerSpend(key: string, delta: number): Promise<void>;
  rebuildCustomers(): Promise<number>;
  customersAgg(f: { start: Date; end: Date }): Promise<{ buyers: number; newBuyers: number; returning: number; repeat: number }>;

  /* facts: daily tables */
  /** Adds to counters of one (key, day) row, creating it; returns nothing. `set` overwrites columns. */
  bumpDaily(table: DailyTable, key: Record<string, string>, add: Record<string, number>, set?: Record<string, unknown>, jsonAdd?: { column: string; add: Record<string, number> }): Promise<void>;
  /** Service rows carry the open-case count forward from the seller's previous day */
  bumpService(sellerId: string, day: string, add: Record<string, number>, complaintCategory?: string): Promise<void>;
  dailySums(table: DailyTable, f: DailyFilter, columns: string[], group: 'bucket' | 'seller_id' | 'product_id' | 'campaign' | 'query_norm' | 'none', bucket?: 'day' | 'week' | 'month'): Promise<({ key: string | null } & Record<string, number>)[]>;
  caseBacklog(day: string, sellerId?: string): Promise<number>;
  sellersWithMessages(day: string): Promise<string[]>;

  /* read model bookkeeping */
  getCheckpoint(key: string): Promise<CheckpointRow | undefined>;
  listCheckpoints(keys: string[]): Promise<CheckpointRow[]>;
  upsertCheckpoint(key: string, patch: Partial<CheckpointRow>): Promise<void>;
  /** Claims a natural key in the inbox (ctx.inbox) within this repository's transaction; false when it was already handled */
  claim(key: string): Promise<boolean>;
  /** Opens an out-of-stock interval for a stock item (open_stockouts); an open one stays as it is */
  openStockout(stockItemId: string, productId: string, since: Date): Promise<boolean>;
  getStockout(stockItemId: string, opts?: { forUpdate?: boolean }): Promise<Row<'open_stockouts'> | undefined>;
  closeStockout(stockItemId: string): Promise<void>;
  /** The campaign behind a coupon redemption or ad charge (campaign_refs); the first value stays */
  rememberCampaign(kind: 'redemption' | 'charge', refId: string, campaignId: string, at: Date): Promise<void>;
  campaignOf(kind: 'redemption' | 'charge', refId: string): Promise<string | null>;
  countRows(table: Table): Promise<number>;
}
