import type { Migration } from '../../../../../kernel/migrations/index.js';

/** Tables, constraints and indexes from docs/api/spec/modules/cart.json (spec "tables"). */
export const m0001Init: Migration = {
  id: '0001_init',
  sql: /* sql */ `
create table cart.carts (
  id uuid primary key,
  owner_kind text not null check (owner_kind in ('customer', 'guest')),
  customer_id uuid,
  guest_session_id uuid,
  status text not null check (status in ('active', 'merged', 'converted', 'expired')),
  currency text not null,
  destination jsonb,
  coupon_codes jsonb not null,
  merged_into_id uuid,
  checked_at timestamptz,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  expires_at timestamptz not null
);
comment on table cart.carts is 'One active cart per customer or guest session';
create unique index on cart.carts (customer_id) where status = 'active';
create unique index on cart.carts (guest_session_id) where status = 'active';
create index on cart.carts (status, expires_at);
create table cart.cart_items (
  id uuid primary key,
  cart_id uuid not null,
  offer_id uuid not null,
  owner_type text not null check (owner_type in ('official', 'seller')),
  seller_id uuid,
  product_id uuid not null,
  variant_id uuid not null,
  stock_item_id uuid not null,
  ships_from text not null,
  quantity int not null,
  price_at_add int not null,
  accepted_price int not null,
  accepted_terms_version int not null,
  currency text not null,
  source text,
  added_at timestamptz not null,
  updated_at timestamptz not null,
  last_checked_at timestamptz
);
comment on table cart.cart_items is 'Lines bound to an offer; one line per offer per cart';
comment on column cart.cart_items.price_at_add is 'minor units';
comment on column cart.cart_items.accepted_price is 'minor units';
create unique index on cart.cart_items (cart_id, offer_id);
create index on cart.cart_items (offer_id);
create index on cart.cart_items (seller_id);
create table cart.cart_item_notices (
  id uuid primary key,
  item_id uuid not null,
  kind text not null,
  severity text not null,
  previous jsonb not null,
  current jsonb not null,
  detected_at timestamptz not null,
  accepted_at timestamptz,
  resolved_at timestamptz
);
comment on table cart.cart_item_notices is 'Detected changes per line; kept until accepted, resolved or the line is removed';
create index on cart.cart_item_notices (item_id) where resolved_at is null;
create table cart.saved_items (
  id uuid primary key,
  owner_kind text not null,
  customer_id uuid,
  guest_session_id uuid,
  offer_id uuid not null,
  product_id uuid not null,
  variant_id uuid not null,
  saved_at timestamptz not null
);
comment on table cart.saved_items is 'Save for later (phase 3)';
create unique index on cart.saved_items (customer_id, offer_id);
create index on cart.saved_items (guest_session_id);
create table cart.cart_merges (
  id uuid primary key,
  from_cart_id uuid not null,
  into_cart_id uuid not null,
  report jsonb not null,
  at timestamptz not null
);
comment on table cart.cart_merges is 'Guest-to-customer merges with their report';
create table cart.recheck_queue (
  item_id uuid primary key,
  reason text not null,
  queued_at timestamptz not null
);
comment on table cart.recheck_queue is 'Lines touched by offer, stock or seller events; the recheck job refreshes their notices';
alter table cart.carts add foreign key (merged_into_id) references cart.carts (id);
alter table cart.cart_items add foreign key (cart_id) references cart.carts (id);
alter table cart.cart_item_notices add foreign key (item_id) references cart.cart_items (id);
alter table cart.cart_merges add foreign key (from_cart_id) references cart.carts (id);
alter table cart.cart_merges add foreign key (into_cart_id) references cart.carts (id);
alter table cart.recheck_queue add foreign key (item_id) references cart.cart_items (id);
`,
};
