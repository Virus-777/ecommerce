import type { Migration } from '../../../../../kernel/migrations/index.js';

/** Tables, constraints and indexes from docs/api/spec/modules/catalog.json (spec "tables"). */
export const m0001Init: Migration = {
  id: '0001_init',
  sql: /* sql */ `
create table catalog.categories (
  id uuid primary key,
  parent_id uuid,
  name text not null,
  slug text not null unique,
  position int not null,
  visible bool not null,
  coming_soon bool not null,
  image_media_id uuid
);
comment on table catalog.categories is 'Category tree';
create table catalog.attributes (
  id uuid primary key,
  category_id uuid not null,
  name text not null,
  kind text not null,
  unit text,
  options jsonb not null,
  required bool not null,
  filterable bool not null,
  variant_defining bool not null,
  position int not null
);
comment on table catalog.attributes is 'Attributes per category; drive specs, filters and variant options';
create table catalog.image_standards (
  category_id uuid primary key,
  min_width int not null,
  min_count int not null,
  rules jsonb not null
);
comment on table catalog.image_standards is 'Minimum size, background, count per category';
comment on column catalog.image_standards.rules is 'ImageRule[]';
create table catalog.brands (
  id uuid primary key,
  name text not null,
  slug text not null unique,
  logo_media_id uuid,
  description text,
  banner_media_id uuid,
  status text not null check (status in ('active', 'under_review', 'blocked')),
  status_reason text,
  flag_note text,
  trust_report_id uuid,
  selling_policy text not null check (selling_policy in ('open', 'authorized_list', 'official_only')),
  requested_by_seller_id uuid,
  requested_for_product_id uuid,
  requested_change_request_id uuid,
  created_at timestamptz not null,
  updated_at timestamptz not null
);
create index on catalog.brands (status, name);
create table catalog.products (
  id uuid primary key,
  ref text not null unique,
  title text not null,
  slug text not null,
  brand_id uuid,
  category_id uuid,
  description text not null,
  key_features jsonb not null,
  specs jsonb not null,
  included_items jsonb not null,
  media_ids jsonb not null,
  video_media_id uuid,
  model_number text,
  mpn text,
  no_gtin bool not null,
  requested_brand jsonb,
  content_score int not null,
  owner_type text not null check (owner_type in ('official', 'seller')),
  owner_seller_id uuid,
  review_state text not null,
  publication text not null,
  version int not null,
  merged_into_id uuid,
  search tsvector,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  listed_at timestamptz
);
comment on table catalog.products is 'Shared content; owner is the Official Store or the submitting seller';
comment on column catalog.products.ref is 'PRD-NNNNN';
comment on column catalog.products.search is 'generated';
create index on catalog.products (review_state, id);
create index on catalog.products (category_id, id);
create index on catalog.products (owner_seller_id, id);
create index on catalog.products using gin (search);
create index on catalog.products (publication, id);
create index on catalog.products (brand_id, id);
create table catalog.variants (
  id uuid primary key,
  product_id uuid not null,
  options jsonb not null,
  gtin text unique,
  media_ids jsonb not null,
  position int not null
);
create table catalog.review_log (
  id uuid primary key,
  product_id uuid not null,
  action text not null,
  reason text,
  fields jsonb not null,
  actor_kind text not null,
  actor_id text,
  at timestamptz not null
);
comment on table catalog.review_log is 'Every submission, decision, publication change and merge';
create table catalog.correction_suggestions (
  id uuid primary key,
  product_id uuid not null,
  seller_id uuid not null,
  field text not null,
  current text,
  proposed text not null,
  evidence_media_ids jsonb not null,
  state text not null,
  decision_reason text,
  decided_by text,
  created_at timestamptz not null
);
create table catalog.submissions (
  id uuid primary key,
  ref text not null unique,
  product_id uuid not null,
  kind text not null check (kind in ('new', 'content_change', 'resubmitted')),
  state text not null check (state in ('open', 'decided', 'withdrawn')),
  product_version int not null,
  submitted_at timestamptz not null,
  submitted_by jsonb not null,
  last_saved_at timestamptz,
  last_saved_by jsonb,
  expected_review_by timestamptz,
  review_due_at timestamptz,
  assignee_staff_id uuid,
  assignee_name text,
  decided_at timestamptz,
  note text
);
comment on table catalog.submissions is 'One row per submission for review; the review queue reads open rows by review_due_at';
create index on catalog.submissions (state, review_due_at);
create index on catalog.submissions (product_id, submitted_at desc);
create table catalog.submission_checks (
  id uuid primary key,
  submission_id uuid not null,
  kind text not null,
  result text not null check (result in ('pass', 'warn', 'fail')),
  message text not null,
  details jsonb not null,
  evidence jsonb not null,
  ran_at timestamptz not null,
  dismissed_at timestamptz,
  dismissed_by jsonb,
  dismiss_reason text,
  dismissed_matched_product_id uuid
);
comment on table catalog.submission_checks is 'Automated check results per submission (advisory; the reviewer decides)';
create index on catalog.submission_checks (submission_id);
create index on catalog.submission_checks (kind, result);
create table catalog.review_drafts (
  submission_id uuid not null,
  staff_id uuid not null,
  decision text,
  reason text,
  fields jsonb not null,
  saved_at timestamptz not null,
  primary key (submission_id, staff_id)
);
comment on table catalog.review_drafts is 'A reviewer''s unsent decision per open submission; deleted when the decision is sent';
create table catalog.brand_authorized_sellers (
  brand_id uuid not null,
  seller_id uuid not null,
  source text not null check (source in ('staff', 'claim')),
  added_by jsonb not null,
  added_at timestamptz not null,
  primary key (brand_id, seller_id)
);
comment on table catalog.brand_authorized_sellers is 'Authorized seller list per brand';
create index on catalog.brand_authorized_sellers (seller_id);
create table catalog.offer_index (
  offer_id uuid primary key,
  product_id uuid not null,
  variant_id uuid not null,
  owner_type text not null check (owner_type in ('official', 'seller')),
  seller_id uuid,
  seller_name text,
  condition text not null,
  status text not null,
  eligible bool not null,
  in_stock bool not null,
  price jsonb,
  updated_at timestamptz not null
);
comment on table catalog.offer_index is 'Read model of offers on catalog products, kept from offers and inventory events (no cross-module keys)';
comment on column catalog.offer_index.price is 'Money';
create index on catalog.offer_index (product_id);
create index on catalog.offer_index (seller_id);
create table catalog.listing_stats (
  product_id uuid primary key,
  offer_count int not null,
  live_offer_count int not null,
  in_stock bool not null,
  best_price jsonb,
  offer_note text,
  refreshed_at timestamptz not null
);
comment on table catalog.listing_stats is 'Per-product counts from offer_index: admin list columns, CatalogMatch counts';
comment on column catalog.listing_stats.best_price is 'Money';
create table catalog.category_stats (
  category_id uuid primary key,
  product_count int not null,
  offer_count int not null,
  refreshed_at timestamptz not null
);
comment on table catalog.category_stats is 'Per-category counts including subcategories (job catalog.refresh-counts)';
create table catalog.brand_stats (
  brand_id uuid not null,
  category_id uuid,
  product_count int not null,
  offer_count int not null,
  seller_count int not null,
  refreshed_at timestamptz not null,
  unique nulls not distinct (brand_id, category_id)
);
comment on table catalog.brand_stats is 'Per-brand counts, overall and per top-level category (popular brands)';
comment on column catalog.brand_stats.category_id is 'null = all categories';
create index on catalog.brand_stats (category_id, product_count desc);
alter table catalog.categories add foreign key (parent_id) references catalog.categories (id);
alter table catalog.attributes add foreign key (category_id) references catalog.categories (id);
alter table catalog.image_standards add foreign key (category_id) references catalog.categories (id);
alter table catalog.products add foreign key (brand_id) references catalog.brands (id);
alter table catalog.products add foreign key (category_id) references catalog.categories (id);
alter table catalog.variants add foreign key (product_id) references catalog.products (id);
alter table catalog.review_log add foreign key (product_id) references catalog.products (id);
alter table catalog.correction_suggestions add foreign key (product_id) references catalog.products (id);
alter table catalog.submissions add foreign key (product_id) references catalog.products (id);
alter table catalog.submission_checks add foreign key (submission_id) references catalog.submissions (id);
alter table catalog.review_drafts add foreign key (submission_id) references catalog.submissions (id);
alter table catalog.brand_authorized_sellers add foreign key (brand_id) references catalog.brands (id);
alter table catalog.offer_index add foreign key (product_id) references catalog.products (id);
alter table catalog.listing_stats add foreign key (product_id) references catalog.products (id);
alter table catalog.category_stats add foreign key (category_id) references catalog.categories (id);
alter table catalog.brand_stats add foreign key (brand_id) references catalog.brands (id);
`,
};
