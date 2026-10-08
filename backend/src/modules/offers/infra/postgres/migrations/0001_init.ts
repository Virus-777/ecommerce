import type { Migration } from '../../../../../kernel/migrations/index.js';

/** Tables, constraints and indexes from docs/api/spec/modules/offers.json (spec "tables"). */
export const m0001Init: Migration = {
  id: '0001_init',
  sql: /* sql */ `
create table offers.offers (
  id uuid primary key,
  owner_type text not null check (owner_type in ('official', 'seller')),
  seller_id uuid,
  product_id uuid not null,
  variant_id uuid not null,
  condition text not null,
  condition_notes text,
  included_items jsonb not null,
  missing_items jsonb not null,
  seller_sku text not null,
  stock_item_id uuid not null,
  price_amount bigint not null,
  currency char(3) not null,
  compare_at_amount bigint,
  compare_at_basis text,
  compare_at_verified bool not null,
  sale_ends_at timestamptz,
  purchase_limit int,
  dispatch_business_days int not null,
  same_day_cutoff time,
  ships_from text not null,
  shipping_profile_id uuid not null,
  return_kind text not null,
  return_window_days int not null,
  free_return_shipping bool not null,
  return_policy_id uuid,
  warranty_kind text not null,
  warranty_months int,
  warranty_handled_by text,
  status text not null,
  status_before_ineligible text,
  ineligible_source jsonb,
  status_reason jsonb,
  publish_on_approval bool not null,
  content_gaps text[] not null,
  terms_version int not null,
  published_at timestamptz,
  removed_at timestamptz,
  created_at timestamptz not null,
  updated_at timestamptz not null
);
comment on table offers.offers is 'One row per offer; product and seller are referenced by id only';
comment on column offers.offers.ineligible_source is '{ kind: restriction|suspension|product|staff, id }';
create unique index on offers.offers (owner_type, seller_id, seller_sku);
create unique index on offers.offers (seller_id, variant_id) where condition = 'new' and status <> 'removed';
create index on offers.offers (product_id, variant_id, status);
create index on offers.offers (seller_id, status, id);
create index on offers.offers (status, id);
create index on offers.offers (stock_item_id);
create table offers.offer_price_history (
  id uuid primary key,
  offer_id uuid not null,
  price_amount bigint not null,
  compare_at_amount bigint,
  valid_from timestamptz not null,
  valid_to timestamptz,
  price_change_id uuid,
  actor_kind text not null,
  actor_id text
);
comment on table offers.offer_price_history is 'Every price in force and when; basis for ''lowest price in the last 30 days'' was-price checks';
create index on offers.offer_price_history (offer_id, valid_from);
create table offers.price_changes (
  id uuid primary key,
  offer_id uuid not null,
  from_amount bigint not null,
  to_amount bigint not null,
  change_pct numeric(6,2) not null,
  compare_at_amount bigint,
  compare_at_basis text,
  starts_at timestamptz,
  ends_at timestamptz,
  revert_to_amount bigint,
  reason text,
  source text not null,
  bulk_job_id uuid,
  state text not null,
  approval_request_id uuid,
  requested_by_kind text not null,
  requested_by_id text,
  decided_at timestamptz,
  applied_at timestamptz,
  created_at timestamptz not null
);
comment on table offers.price_changes is 'Requested, scheduled, approval-gated and applied price changes';
create index on offers.price_changes (state, starts_at);
create index on offers.price_changes (state, ends_at);
create index on offers.price_changes (offer_id, created_at);
create index on offers.price_changes (approval_request_id);
create table offers.offer_status_log (
  id uuid primary key,
  offer_id uuid not null,
  from_status text,
  to_status text not null,
  event text not null,
  reason_code text,
  reason text,
  affected_activity text,
  appeal_route text,
  review_date date,
  actor_kind text not null,
  actor_id text,
  at timestamptz not null
);
comment on table offers.offer_status_log is 'Every status change with reason and actor';
create index on offers.offer_status_log (offer_id, at);
create table offers.offer_eligibility (
  offer_id uuid primary key,
  eligible bool not null,
  reasons jsonb not null,
  seller_on_time_pct numeric(5,2),
  seller_restriction_ref text,
  evaluated_at timestamptz not null
);
comment on table offers.offer_eligibility is 'Featured-offer eligibility per offer (location-independent part)';
create table offers.featured_offers (
  variant_id uuid not null,
  condition_group text not null check (condition_group in ('new', 'used', 'refurbished')),
  zone_key text not null,
  product_id uuid not null,
  offer_id uuid,
  rule_version int not null,
  candidates jsonb not null,
  dirty bool not null,
  computed_at timestamptz not null,
  primary key (variant_id, condition_group, zone_key)
);
comment on table offers.featured_offers is 'Cached featured-offer decision per variant, condition group and delivery zone';
create index on offers.featured_offers (product_id);
create index on offers.featured_offers (dirty) where dirty;
create table offers.featured_rules (
  version int primary key,
  text text not null,
  steps jsonb not null,
  parameters jsonb not null,
  effective_from timestamptz not null,
  reason text not null,
  published_by text not null,
  published_at timestamptz not null
);
comment on table offers.featured_rules is 'Published versions of the featured-offer rule';
create table offers.bulk_update_jobs (
  id uuid primary key,
  owner_type text not null,
  seller_id uuid,
  file_media_id uuid not null,
  file_name text not null,
  state text not null,
  totals jsonb not null,
  report_media_id uuid,
  uploaded_by text not null,
  uploaded_at timestamptz not null,
  applied_by text,
  applied_at timestamptz,
  expires_at timestamptz not null,
  failure text
);
comment on table offers.bulk_update_jobs is 'Uploaded price/quantity files (seller or Official Store)';
create index on offers.bulk_update_jobs (seller_id, uploaded_at);
create index on offers.bulk_update_jobs (state, expires_at);
create table offers.bulk_update_rows (
  job_id uuid not null,
  row_no int not null,
  seller_sku text not null,
  offer_id uuid,
  price_from bigint,
  price_to bigint,
  qty_from int,
  qty_to int,
  result text not null,
  error_code text,
  error_message text,
  primary key (job_id, row_no)
);
create index on offers.bulk_update_rows (job_id, result);
alter table offers.offer_price_history add foreign key (offer_id) references offers.offers (id);
alter table offers.offer_price_history add foreign key (price_change_id) references offers.price_changes (id);
alter table offers.price_changes add foreign key (offer_id) references offers.offers (id);
alter table offers.price_changes add foreign key (bulk_job_id) references offers.bulk_update_jobs (id);
alter table offers.offer_status_log add foreign key (offer_id) references offers.offers (id);
alter table offers.offer_eligibility add foreign key (offer_id) references offers.offers (id);
alter table offers.bulk_update_rows add foreign key (job_id) references offers.bulk_update_jobs (id);
`,
};
