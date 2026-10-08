/**
 * What the reports service needs from the outside world, database-agnostic.
 * The Postgres adapter lives in infra/postgres/; a MongoDB switch would add infra/mongo/.
 */

/** Persistence for this module's own tables: reports.metric_definitions, reports.metric_versions, reports.metric_suggestions, reports.report_definitions, reports.report_groups, reports.saved_views, reports.report_schedules, reports.export_datasets, reports.export_jobs, reports.fact_order_items, reports.fact_refunds, reports.fact_returns, reports.fact_marketplace_finance_daily, reports.fact_service_daily, reports.fact_discovery_daily, reports.fact_search_misses_daily, reports.fact_customers, reports.fact_campaigns_daily, reports.read_model_checkpoints. */
export interface ReportsRepository {}
