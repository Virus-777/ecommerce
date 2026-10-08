import type { Migration } from '../../../../../kernel/migrations/index.js';

/** Tables, constraints and indexes from docs/api/spec/modules/search.json (spec "tables"). */
export const m0001Init: Migration = {
  id: '0001_init',
  sql: /* sql */ `
create table search.search_documents (
  product_id uuid primary key,
  slug text not null,
  title text not null,
  brand_id uuid,
  brand_name text,
  category_id uuid,
  category_path_ids uuid[] not null,
  attributes jsonb not null,
  variant_count int not null,
  variant_options jsonb not null,
  image jsonb,
  seller_ids uuid[] not null,
  has_official bool not null,
  conditions text[] not null,
  offer_count int not null,
  featured_offer_id uuid,
  featured_price bigint,
  featured_seller_name text,
  featured_official bool not null,
  min_price bigint,
  max_price bigint,
  currency char(3) not null,
  was_price bigint,
  deal_ends_at timestamptz,
  on_sale bool not null,
  gtins text[] not null,
  variant_gtins jsonb not null,
  badges jsonb not null,
  in_stock bool not null,
  low_stock bool not null,
  free_delivery bool not null,
  fastest_dispatch_days int,
  same_day_cutoff time,
  rating numeric(2,1),
  rating_count int not null,
  sales_30d int not null,
  first_listed_at timestamptz not null,
  popularity numeric not null,
  tsv tsvector,
  title_norm text not null,
  version bigint not null,
  indexed_at timestamptz not null,
  best_seller_rank int,
  best_seller_category_id uuid
);
comment on table search.search_documents is 'One row per purchasable product: denormalized from catalog, offers, inventory, reviews and promotions events';
comment on column search.search_documents.attributes is 'filterable attribute key → values';
comment on column search.search_documents.on_sale is 'an active campaign price from promotions or a verified compare-at on the featured offer';
comment on column search.search_documents.gtins is 'variant GTINs from catalog, normalized';
comment on column search.search_documents.variant_gtins is 'GTIN → variantId';
comment on column search.search_documents.tsv is 'title A, brand A, category B, attributes C, description D';
comment on column search.search_documents.title_norm is 'for trigram';
comment on column search.search_documents.best_seller_rank is 'rank in best_seller_category_id by sales_30d; null outside the top 100';
create index on search.search_documents using gin (tsv);
create index on search.search_documents using gin (title_norm gin_trgm_ops);
create index on search.search_documents using gin (seller_ids);
create index on search.search_documents using gin (category_path_ids);
create index on search.search_documents using gin (attributes jsonb_path_ops);
create index on search.search_documents (in_stock, featured_price);
create index on search.search_documents (first_listed_at);
create index on search.search_documents (rating, rating_count);
create table search.search_offers (
  offer_id uuid primary key,
  product_id uuid not null,
  variant_id uuid not null,
  seller_id uuid,
  official bool not null,
  condition text not null,
  price bigint not null,
  in_stock bool not null,
  free_delivery bool not null,
  dispatch_days int not null,
  featured_eligible bool not null
);
comment on table search.search_offers is 'Offer-level rows so seller, condition and price filters show the matching seller''s price (e.g. Official Store filter shows company offers)';
create index on search.search_offers (product_id);
create index on search.search_offers (seller_id, price);
create index on search.search_offers (condition, price);
create table search.suggestion_terms (
  id uuid primary key,
  term text not null,
  kind text not null check (kind in ('query', 'category', 'brand', 'store', 'product')),
  target_id uuid,
  weight numeric not null,
  updated_at timestamptz not null
);
comment on table search.suggestion_terms is 'Popular queries, category, brand, store and product names for suggestions and spelling correction';
create index on search.suggestion_terms using gin (term gin_trgm_ops);
create index on search.suggestion_terms (kind, weight desc);
create table search.synonyms (
  id uuid primary key,
  terms text[] not null,
  kind text not null,
  from_term text,
  active bool not null,
  note text,
  updated_by text not null,
  updated_at timestamptz not null
);
create table search.recent_searches (
  id uuid primary key,
  owner_kind text not null check (owner_kind in ('customer', 'guest')),
  owner_id text not null,
  query text not null,
  filters jsonb not null,
  searched_at timestamptz not null
);
create index on search.recent_searches (owner_kind, owner_id, searched_at desc);
create table search.query_log (
  id uuid primary key,
  search_id text not null,
  raw text,
  normalized text,
  filters jsonb not null,
  sort text not null,
  results int not null,
  corrected_to text,
  session_key text,
  at timestamptz not null
);
comment on table search.query_log is 'Every search (partitioned by month); feeds zero-result reports, suggestions and ranking';
create index on search.query_log (normalized, at);
create index on search.query_log (results, at) where results = 0;
create table search.click_log (
  search_id text not null,
  product_id uuid not null,
  position int not null,
  sponsored bool not null,
  at timestamptz not null
);
create index on search.click_log (search_id);
create index on search.click_log (product_id, at);
create table search.dirty_documents (
  product_id uuid primary key,
  reason text not null,
  queued_at timestamptz not null
);
comment on table search.dirty_documents is 'Products waiting to be reindexed';
create table search.reindex_jobs (
  id uuid primary key,
  scope text not null,
  ids uuid[] not null,
  state text not null,
  total int not null,
  processed int not null,
  requested_by text not null,
  reason text not null,
  started_at timestamptz,
  finished_at timestamptz,
  error text
);
create table search.ranking_policies (
  version int primary key,
  text text not null,
  factors jsonb not null,
  effective_from timestamptz not null,
  reason text not null,
  published_by text not null,
  published_at timestamptz not null
);
alter table search.search_offers add foreign key (product_id) references search.search_documents (product_id);
`,
};
