import type { Migration } from '../../../../../kernel/migrations/index.js';

/** Tables, constraints and indexes from docs/api/spec/modules/checkout.json (spec "tables"). */
export const m0001Init: Migration = {
  id: '0001_init',
  sql: /* sql */ `
create table checkout.sessions (
  id uuid primary key,
  source text not null,
  cart_id uuid,
  customer_id uuid,
  guest_session_id uuid,
  account jsonb not null,
  address jsonb,
  address_id uuid,
  status text not null,
  quote_version int not null,
  currency text not null,
  totals jsonb not null,
  coupon_codes jsonb not null,
  credit jsonb,
  payment_selection jsonb,
  gift_note text,
  promotion_evaluation_id uuid,
  redemption_reservation_id uuid,
  stock_reservation_id uuid,
  credit_hold_id uuid,
  hold_until timestamptz,
  attempt_count int not null,
  order_id uuid,
  order_ref text,
  channel text,
  expires_at timestamptz not null,
  created_at timestamptz not null,
  updated_at timestamptz not null
);
comment on table checkout.sessions is 'One checkout (quote) per Buy now or cart checkout';
create index on checkout.sessions (customer_id, status);
create index on checkout.sessions (guest_session_id, status);
create index on checkout.sessions (status, expires_at);
create unique index on checkout.sessions (order_id);
create table checkout.session_lines (
  id text primary key,
  session_id uuid not null,
  cart_item_id uuid,
  offer_id uuid not null,
  owner_type text not null,
  seller_id uuid,
  product_id uuid not null,
  variant_id uuid not null,
  stock_item_id uuid not null,
  profile_id uuid not null,
  package_key text not null,
  quantity int not null,
  unit_price int not null,
  terms_version int not null,
  discounts jsonb not null,
  tax int not null,
  status text not null
);
create index on checkout.session_lines (session_id);
create table checkout.session_packages (
  session_id uuid not null,
  package_key text not null,
  owner_type text not null,
  seller_id uuid,
  ships_from text not null,
  options jsonb not null,
  selected_option_id text,
  selected_option jsonb,
  return_terms text not null
);
create unique index on checkout.session_packages (session_id, package_key);
create table checkout.change_sets (
  id uuid primary key,
  session_id uuid not null,
  status text not null,
  changes jsonb not null,
  previous_total int not null,
  new_total int not null,
  decisions jsonb,
  created_at timestamptz not null,
  decided_at timestamptz
);
create index on checkout.change_sets (session_id, created_at desc);
create table checkout.place_requests (
  id uuid primary key,
  session_id uuid not null,
  idempotency_key text not null,
  request_hash text not null,
  kind text not null check (kind in ('place', 'retry', 'complete_action')),
  outcome text,
  response jsonb,
  payment_intent_id uuid,
  created_at timestamptz not null,
  completed_at timestamptz
);
comment on table checkout.place_requests is 'Idempotency record for Place order and payment retries';
create unique index on checkout.place_requests (session_id, idempotency_key);
create table checkout.session_log (
  id uuid primary key,
  session_id uuid not null,
  label text not null,
  detail text,
  at timestamptz not null
);
alter table checkout.session_lines add foreign key (session_id) references checkout.sessions (id);
alter table checkout.session_packages add foreign key (session_id) references checkout.sessions (id);
alter table checkout.change_sets add foreign key (session_id) references checkout.sessions (id);
alter table checkout.place_requests add foreign key (session_id) references checkout.sessions (id);
alter table checkout.session_log add foreign key (session_id) references checkout.sessions (id);
`,
};
