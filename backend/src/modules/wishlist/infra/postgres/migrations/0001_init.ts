import type { Migration } from '../../../../../kernel/migrations/index.js';

/** Tables, constraints and indexes from docs/api/spec/modules/wishlist.json (spec "tables"). */
export const m0001Init: Migration = {
  id: '0001_init',
  sql: /* sql */ `
create table wishlist.lists (
  id uuid primary key,
  customer_id uuid not null,
  name text not null,
  is_default bool not null,
  share_token text unique,
  created_at timestamptz not null,
  updated_at timestamptz not null
);
create index on wishlist.lists (customer_id);
create unique index on wishlist.lists (customer_id) where is_default;
create table wishlist.items (
  id uuid primary key,
  list_id uuid not null,
  customer_id uuid not null,
  product_id uuid not null,
  variant_id uuid,
  offer_id uuid,
  price_when_saved bigint,
  currency text not null,
  note text,
  added_at timestamptz not null
);
create unique index on wishlist.items (list_id, product_id, variant_id);
create index on wishlist.items (customer_id, product_id);
create index on wishlist.items (product_id);
create table wishlist.alerts (
  id uuid primary key,
  customer_id uuid not null,
  item_id uuid,
  product_id uuid not null,
  variant_id uuid,
  seller_id uuid,
  kind text not null,
  target_price bigint,
  reference_price bigint,
  state text not null,
  triggered_at timestamptz,
  triggered_price bigint,
  paused_reason text,
  last_notified_at timestamptz,
  created_at timestamptz not null
);
create index on wishlist.alerts (product_id, kind, state);
create index on wishlist.alerts (customer_id, state);
alter table wishlist.items add foreign key (list_id) references wishlist.lists (id);
alter table wishlist.alerts add foreign key (item_id) references wishlist.items (id);
`,
};
