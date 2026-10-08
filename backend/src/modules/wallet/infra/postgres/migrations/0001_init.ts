import type { Migration } from '../../../../../kernel/migrations/index.js';

/** Tables, constraints and indexes from docs/api/spec/modules/wallet.json (spec "tables"). */
export const m0001Init: Migration = {
  id: '0001_init',
  sql: /* sql */ `
create table wallet.accounts (
  customer_id uuid primary key,
  currency text not null,
  available bigint not null,
  held bigint not null,
  updated_at timestamptz not null,
  version int not null
);
create table wallet.lots (
  id uuid primary key,
  customer_id uuid not null,
  source text not null,
  original bigint not null,
  remaining bigint not null,
  expires_at timestamptz,
  reference text,
  state text not null check (state in ('active', 'depleted', 'expired')),
  created_at timestamptz not null
);
comment on table wallet.lots is 'Credit in buckets with source and expiry; uses consume earliest-expiring first';
create index on wallet.lots (customer_id, state, expires_at);
create table wallet.ledger (
  id uuid primary key,
  customer_id uuid not null,
  kind text not null,
  amount bigint not null,
  balance_after bigint not null,
  lot_allocations jsonb not null,
  order_id uuid,
  refund_id uuid,
  case_id uuid,
  hold_id uuid,
  idempotency_key text,
  actor_kind text not null,
  actor_id text,
  reason text,
  at timestamptz not null
);
comment on table wallet.ledger is 'Append-only; balance is the sum of entries';
create index on wallet.ledger (customer_id, at);
create unique index on wallet.ledger (idempotency_key);
create unique index on wallet.ledger (refund_id, kind) where refund_id is not null;
create table wallet.holds (
  id uuid primary key,
  customer_id uuid not null,
  quote_id uuid not null,
  order_id uuid,
  amount bigint not null,
  state text not null,
  expires_at timestamptz not null,
  idempotency_key text not null unique
);
create table wallet.goodwill_grants (
  id uuid primary key,
  customer_id uuid not null,
  amount bigint not null,
  currency text not null,
  reason text not null,
  reason_code text not null,
  case_id uuid,
  order_id uuid,
  charged_to text not null,
  seller_id uuid,
  state text not null,
  approval_request_id uuid,
  requested_by text not null,
  decided_by text,
  ledger_entry_id uuid,
  idempotency_key text not null unique,
  created_at timestamptz not null
);
create index on wallet.goodwill_grants (state, created_at);
create index on wallet.goodwill_grants (customer_id, created_at);
create table wallet.gift_cards (
  id uuid primary key,
  code_hash text not null unique,
  code_last4 text not null,
  batch_id uuid,
  initial bigint not null,
  remaining bigint not null,
  currency text not null,
  state text not null,
  purpose text not null,
  expires_at timestamptz,
  redeemed_by uuid,
  redeemed_at timestamptz,
  created_by text not null,
  created_at timestamptz not null
);
create table wallet.loyalty_entries (
  id uuid primary key,
  customer_id uuid not null,
  points int not null,
  kind text not null,
  order_id uuid,
  at timestamptz not null
);
comment on table wallet.loyalty_entries is 'Phase 4 experiment: points earned and spent';
alter table wallet.lots add foreign key (customer_id) references wallet.accounts (customer_id);
alter table wallet.ledger add foreign key (customer_id) references wallet.accounts (customer_id);
alter table wallet.holds add foreign key (customer_id) references wallet.accounts (customer_id);
`,
};
