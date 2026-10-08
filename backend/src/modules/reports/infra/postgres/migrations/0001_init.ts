import type { Migration } from '../../../../../kernel/migrations/index.js';

/** Tables, constraints and indexes from docs/api/spec/modules/reports.json (spec "tables"). */
export const m0001Init: Migration = {
  id: '0001_init',
  sql: /* sql */ `
create table reports.metric_definitions (
  key text primary key,
  name text not null,
  group_key text not null,
  definition text not null,
  formula text not null,
  unit text not null,
  includes jsonb not null,
  excludes jsonb not null,
  date_basis_options jsonb not null,
  default_date_basis text not null,
  currency_rule text not null,
  time_zone text not null,
  related_keys jsonb not null,
  audience text not null,
  launch_measure bool not null,
  owner_staff_id uuid not null,
  status text not null,
  version int not null,
  effective_from date not null,
  reviewed_at date
);
create table reports.metric_versions (
  id uuid primary key,
  metric_key text not null,
  version int not null,
  snapshot jsonb not null,
  change_note text not null,
  changed_by text not null,
  effective_from date not null,
  created_at timestamptz not null
);
comment on table reports.metric_versions is 'Every published version of a definition; reports state which version they used';
create unique index on reports.metric_versions (metric_key, version);
create table reports.metric_suggestions (
  id uuid primary key,
  metric_key text not null,
  proposed text not null,
  reason text not null,
  suggested_by text not null,
  state text not null,
  decision_note text,
  decided_by text,
  created_at timestamptz not null
);
create table reports.report_definitions (
  key text primary key,
  group_key text not null,
  title text not null,
  description text not null,
  metrics jsonb not null,
  dimensions jsonb not null,
  filters jsonb not null,
  permission text not null,
  audience text not null,
  layout jsonb not null,
  phase int not null,
  active bool not null
);
comment on table reports.report_definitions is 'Catalogue seeded per launch report; group owners from report_groups';
create table reports.report_groups (
  key text primary key,
  label text not null,
  owner_staff_id uuid not null,
  position int not null
);
create table reports.saved_views (
  id uuid primary key,
  report_key text not null,
  name text not null,
  query jsonb not null,
  owner_staff_id uuid not null,
  shared bool not null,
  created_at timestamptz not null
);
create table reports.report_schedules (
  id uuid primary key,
  report_key text not null,
  saved_view_id uuid,
  recipients jsonb not null,
  frequency text not null,
  day_of_week int,
  time text not null,
  format text not null,
  next_run_at timestamptz not null,
  owner_staff_id uuid not null,
  active bool not null
);
create table reports.export_datasets (
  key text primary key,
  owner_module text not null,
  title text not null,
  permission text not null,
  audience text not null check (audience in ('staff', 'seller')),
  columns jsonb not null,
  screens jsonb not null,
  available bool not null,
  phase int not null,
  registered_at timestamptz
);
comment on table reports.export_datasets is 'Export dataset registry: one row per ExportDatasetKey, seeded from the exportDatasets setting and filled with columns when the owner registers at boot; available=false while the owner module is disabled';
create table reports.export_jobs (
  id uuid primary key,
  ref text not null unique,
  dataset text not null,
  report_key text,
  format text not null,
  filters jsonb not null,
  requested_by_kind text not null,
  requested_by_id text not null,
  seller_id uuid,
  state text not null,
  row_count int,
  columns_excluded jsonb not null,
  file_media_id uuid,
  sha256 text,
  expires_at timestamptz,
  error text,
  created_at timestamptz not null,
  finished_at timestamptz
);
create index on reports.export_jobs (requested_by_id, created_at desc);
create index on reports.export_jobs (state, created_at);
create table reports.fact_order_items (
  order_item_id uuid primary key,
  order_id uuid not null,
  owner_type text not null check (owner_type in ('official', 'seller')),
  seller_id uuid,
  customer_key text not null,
  category_id uuid,
  product_id uuid not null,
  offer_id uuid not null,
  quantity int not null,
  item_minor bigint not null,
  shipping_minor bigint not null,
  discount_platform_minor bigint not null,
  discount_seller_minor bigint not null,
  tax_minor bigint not null,
  currency text not null,
  placed_at timestamptz not null,
  paid_at timestamptz,
  shipped_at timestamptz,
  delivered_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  cancelled_by text,
  cancelled_minor bigint not null,
  refunded_minor bigint not null,
  last_refund_at timestamptz,
  buying_cost_minor bigint
);
comment on table reports.fact_order_items is 'One row per order item with the four date bases; the base of every sales metric';
comment on column reports.fact_order_items.customer_key is 'hashed customer id or guest email';
comment on column reports.fact_order_items.item_minor is 'after customer discounts';
comment on column reports.fact_order_items.buying_cost_minor is 'Official Store, from inventory.getUnitCost';
create index on reports.fact_order_items (placed_at);
create index on reports.fact_order_items (paid_at);
create index on reports.fact_order_items (shipped_at);
create index on reports.fact_order_items (completed_at);
create index on reports.fact_order_items (seller_id, placed_at);
create index on reports.fact_order_items (product_id, placed_at);
create table reports.fact_refunds (
  refund_id uuid primary key,
  order_id uuid not null,
  owner_type text not null check (owner_type in ('official', 'seller')),
  seller_id uuid,
  amount_minor bigint not null,
  currency text not null,
  reason text,
  after_payout bool not null,
  sent_at timestamptz not null
);
create index on reports.fact_refunds (sent_at);
create index on reports.fact_refunds (seller_id, sent_at);
create table reports.fact_returns (
  return_id uuid primary key,
  seller_id uuid not null,
  product_id uuid not null,
  category_id uuid,
  units int not null,
  reason text not null,
  requested_at timestamptz not null,
  outcome text,
  stock_outcome text
);
create index on reports.fact_returns (seller_id, requested_at);
create index on reports.fact_returns (product_id, requested_at);
create table reports.fact_marketplace_finance_daily (
  seller_id uuid not null,
  day date not null,
  seller_sales_minor bigint not null,
  fee_income_minor bigint not null,
  platform_discount_minor bigint not null,
  seller_discount_minor bigint not null,
  held_minor bigint not null,
  payouts_paid_minor bigint not null,
  payouts_failed int not null,
  owed_minor bigint not null,
  ad_charges_minor bigint not null
);
comment on table reports.fact_marketplace_finance_daily is 'Per seller and day: fee income, discount funding, amounts owed, holds, payouts';
create unique index on reports.fact_marketplace_finance_daily (seller_id, day);
create table reports.fact_service_daily (
  seller_id uuid not null,
  day date not null,
  dispatched int not null,
  dispatched_on_time int not null,
  overdue int not null,
  valid_tracking int not null,
  seller_cancellations int not null,
  delivery_exceptions int not null,
  messages_received int not null,
  first_reply_minutes_p50 int,
  cases_opened int not null,
  cases_open_eod int not null,
  complaints_by_category jsonb not null
);
comment on table reports.fact_service_daily is 'Per seller and day: dispatch, tracking, cancellations, response time, cases, delivery issues';
create unique index on reports.fact_service_daily (seller_id, day);
create table reports.fact_discovery_daily (
  product_id uuid not null,
  day date not null,
  views int not null,
  cart_adds int not null,
  purchases int not null,
  stockout_minutes int not null
);
comment on table reports.fact_discovery_daily is 'Per product and day: views, cart additions, purchases, stockout minutes';
create unique index on reports.fact_discovery_daily (product_id, day);
create table reports.fact_search_misses_daily (
  day date not null,
  query_norm text not null,
  count int not null,
  had_unavailable_match bool not null
);
create unique index on reports.fact_search_misses_daily (day, query_norm);
create table reports.fact_customers (
  customer_key text primary key,
  first_order_at timestamptz not null,
  last_order_at timestamptz not null,
  orders int not null,
  net_spend_minor bigint not null
);
comment on table reports.fact_customers is 'Returning buyers and repeat purchase';
create table reports.fact_campaigns_daily (
  campaign_kind text not null check (campaign_kind in ('promotion', 'ad')),
  campaign_id uuid not null,
  day date not null,
  sales_minor bigint not null,
  discount_cost_minor bigint not null,
  funded_by jsonb not null,
  redemptions int not null,
  displays int not null,
  clicks int not null,
  dismissals int not null,
  spend_minor bigint not null,
  attributed_purchases int not null
);
create unique index on reports.fact_campaigns_daily (campaign_kind, campaign_id, day);
create table reports.read_model_checkpoints (
  key text primary key,
  last_event_id text,
  last_event_at timestamptz,
  state text not null,
  rebuild_started_at timestamptz,
  rebuild_progress int
);
alter table reports.metric_versions add foreign key (metric_key) references reports.metric_definitions (key);
alter table reports.metric_suggestions add foreign key (metric_key) references reports.metric_definitions (key);
`,
};
