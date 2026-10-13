/** Row types and query shapes the reports repository and service share. */
import type { ReportsDb } from '../../spec/reports.js';

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
