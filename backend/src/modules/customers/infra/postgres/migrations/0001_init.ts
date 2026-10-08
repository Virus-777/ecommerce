import type { Migration } from '../../../../../kernel/migrations/index.js';

/** Tables, constraints and indexes from docs/api/spec/modules/customers.json (spec "tables"). */
export const m0001Init: Migration = {
  id: '0001_init',
  sql: /* sql */ `
create table customers.customers (
  id uuid primary key,
  user_id uuid not null unique,
  ref text not null unique,
  first_name text not null,
  last_name text not null,
  email text not null,
  email_verified_at timestamptz,
  phone text,
  phone_verified_at timestamptz,
  account_status text not null,
  default_address_id uuid,
  order_count int not null,
  total_spend_minor bigint not null,
  currency text not null,
  closed_at timestamptz,
  created_at timestamptz not null,
  updated_at timestamptz not null
);
comment on table customers.customers is 'One row per identity user who shops';
comment on column customers.customers.ref is 'CU-NNNNNN';
comment on column customers.customers.email is 'mirror of identity, lower-case';
comment on column customers.customers.order_count is 'read model from orders events';
create index on customers.customers (account_status, id);
create index on customers.customers (email);
create index on customers.customers (created_at, id);
create index on customers.customers using gin ((to_tsvector('simple', first_name || ' ' || last_name || ' ' || email)));
create table customers.addresses (
  id uuid primary key,
  customer_id uuid not null,
  label text,
  name text not null,
  line1 text not null,
  line2 text,
  city text not null,
  region text not null,
  postal_code text not null,
  country text not null,
  phone text,
  delivery_instructions text,
  is_default bool not null,
  validated_at timestamptz,
  last_used_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null,
  updated_at timestamptz not null
);
comment on table customers.addresses is 'Saved addresses. Soft-deleted so past checkout references stay explainable; orders hold their own copy.';
create index on customers.addresses (customer_id) where deleted_at is null;
create unique index on customers.addresses (customer_id) where is_default and deleted_at is null;
create table customers.marketing_preferences (
  customer_id uuid primary key,
  email_promotions bool not null,
  sms_promotions bool not null,
  push_promotions bool not null,
  wishlist_alerts bool not null,
  personalized_recommendations bool not null,
  recent_searches bool not null,
  updated_at timestamptz not null
);
create table customers.consent_log (
  id uuid primary key,
  customer_id uuid not null,
  channel text not null,
  granted bool not null,
  source text not null,
  actor_kind text not null,
  actor_id text,
  ip inet,
  at timestamptz not null
);
comment on table customers.consent_log is 'Append-only history of every consent change (proof of opt-in and opt-out)';
create index on customers.consent_log (customer_id, at desc);
create table customers.recently_viewed (
  id uuid primary key,
  owner_kind text not null check (owner_kind in ('customer', 'guest')),
  owner_id text not null,
  product_id uuid not null,
  variant_id uuid,
  title text not null,
  image_media_id uuid,
  viewed_at timestamptz not null
);
comment on table customers.recently_viewed is 'One row per owner and product; upserted on each view';
comment on column customers.recently_viewed.title is 'snapshot at view time';
create unique index on customers.recently_viewed (owner_kind, owner_id, product_id);
create index on customers.recently_viewed (owner_kind, owner_id, viewed_at desc);
create table customers.account_restrictions (
  id uuid primary key,
  customer_id uuid not null,
  scope text not null,
  reason_code text not null,
  reason text not null,
  still_works jsonb not null,
  appeal_route text not null,
  appeal_deadline timestamptz,
  starts_at timestamptz not null,
  ends_at timestamptz,
  state text not null,
  set_by_kind text not null,
  set_by_id text,
  trust_report_id uuid,
  trust_enforcement_id uuid,
  lifted_at timestamptz,
  lift_reason text
);
create index on customers.account_restrictions (customer_id, state);
create index on customers.account_restrictions (state, ends_at);
create table customers.account_actions (
  id uuid primary key,
  customer_id uuid not null,
  action text not null,
  reason_code text not null,
  details text not null,
  from_status text,
  to_status text,
  restriction_id uuid,
  actor_kind text not null,
  actor_id text not null,
  at timestamptz not null
);
comment on table customers.account_actions is 'Every staff account action with reason and before/after status (also sent to audit)';
create index on customers.account_actions (customer_id, at desc);
create table customers.guest_buyers (
  id uuid primary key,
  email_normalized text not null unique,
  email text not null,
  name text not null,
  order_count int not null,
  total_spend bigint not null,
  currency text not null,
  first_order_at timestamptz not null,
  last_order_at timestamptz not null,
  last_order_id uuid not null,
  last_order_ref text not null
);
comment on table customers.guest_buyers is 'Read model of people who bought without an account, one row per checkout email (from orders.order.placed with guestEmail); removed when the email registers';
create index on customers.guest_buyers (last_order_at desc);
create table customers.customer_notes (
  id uuid primary key,
  customer_id uuid not null,
  body text not null,
  author_id text not null,
  author_name text not null,
  created_at timestamptz not null
);
comment on table customers.customer_notes is 'Internal staff notes; never shown to the customer';
create index on customers.customer_notes (customer_id, created_at desc);
create table customers.data_requests (
  id uuid primary key,
  customer_id uuid not null,
  kind text not null check (kind in ('export', 'closure')),
  state text not null,
  requested_at timestamptz not null,
  due_by timestamptz not null,
  file_media_id uuid,
  ready_at timestamptz,
  expires_at timestamptz,
  scheduled_for timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  failure text
);
create index on customers.data_requests (state, due_by);
create index on customers.data_requests (customer_id, requested_at desc);
create table customers.guest_lookup_attempts (
  id uuid primary key,
  email_hash text not null,
  ip inet not null,
  guest_session_id uuid,
  succeeded bool not null,
  order_id uuid,
  at timestamptz not null
);
comment on table customers.guest_lookup_attempts is 'Guest order lookup attempts for rate limiting and abuse signals (the access grants themselves live in identity)';
create index on customers.guest_lookup_attempts (email_hash, at desc);
create index on customers.guest_lookup_attempts (ip, at desc);
alter table customers.customers add foreign key (default_address_id) references customers.addresses (id);
alter table customers.addresses add foreign key (customer_id) references customers.customers (id);
alter table customers.marketing_preferences add foreign key (customer_id) references customers.customers (id);
alter table customers.consent_log add foreign key (customer_id) references customers.customers (id);
alter table customers.account_restrictions add foreign key (customer_id) references customers.customers (id);
alter table customers.account_actions add foreign key (customer_id) references customers.customers (id);
alter table customers.customer_notes add foreign key (customer_id) references customers.customers (id);
alter table customers.data_requests add foreign key (customer_id) references customers.customers (id);
`,
};
