import type { Migration } from '../../../../../kernel/migrations/index.js';

/** Tables, constraints and indexes from docs/api/spec/modules/payments.json (spec "tables"). */
export const m0001Init: Migration = {
  id: '0001_init',
  sql: /* sql */ `
create table payments.intents (
  id uuid primary key,
  ref text not null unique,
  checkout_session_id uuid not null,
  attempt_no int not null,
  order_id uuid,
  customer_id uuid,
  guest_email text,
  amount int not null,
  currency text not null,
  tenders jsonb not null,
  method jsonb not null,
  provider text not null,
  provider_ref text,
  status text not null,
  decline jsonb,
  authorized_amount int not null,
  captured_amount int not null,
  refunded_amount int not null,
  authorized_at timestamptz,
  captured_at timestamptz,
  authorization_expires_at timestamptz,
  last_checked_at timestamptz,
  next_check_at timestamptz,
  check_attempts int not null,
  orphan bool not null,
  idempotency_key text not null unique,
  created_at timestamptz not null,
  updated_at timestamptz not null
);
comment on table payments.intents is 'One per checkout payment attempt';
comment on column payments.intents.method is 'MethodSnapshot';
create index on payments.intents (checkout_session_id, attempt_no);
create unique index on payments.intents (checkout_session_id) where status not in ('failed','voided','expired');
create index on payments.intents (order_id);
create index on payments.intents (status, next_check_at);
create index on payments.intents (provider, provider_ref);
create table payments.allocations (
  intent_id uuid not null,
  group_id uuid not null,
  owner_type text not null,
  seller_id uuid,
  amount int not null
);
comment on table payments.allocations is 'Captured money per seller group';
create index on payments.allocations (intent_id);
create index on payments.allocations (group_id);
create table payments.captures (
  id uuid primary key,
  intent_id uuid not null,
  group_id uuid,
  amount int not null,
  status text not null,
  provider_ref text,
  idempotency_key text not null unique,
  at timestamptz not null
);
create table payments.provider_calls (
  id uuid primary key,
  intent_id uuid,
  refund_id uuid,
  operation text not null,
  outcome text not null,
  provider_ref text,
  message text,
  latency_ms int,
  at timestamptz not null
);
comment on table payments.provider_calls is 'Every adapter call with outcome (no card data)';
create index on payments.provider_calls (intent_id, at);
create index on payments.provider_calls (refund_id, at);
create table payments.refunds (
  id uuid primary key,
  ref text not null unique,
  order_id uuid not null,
  intent_id uuid not null,
  origin text not null,
  origin_id uuid,
  origin_ref text,
  amount int not null,
  currency text not null,
  destination text not null,
  destination_label text not null,
  status text not null,
  attempts int not null,
  outcome_unknown bool not null,
  failure_code text,
  failure_reason text,
  provider_ref text,
  reason text not null,
  requested_by jsonb not null,
  idempotency_key text not null unique,
  sent_at timestamptz,
  last_attempt_at timestamptz,
  next_attempt_at timestamptz,
  created_at timestamptz not null,
  updated_at timestamptz not null
);
create index on payments.refunds (order_id);
create index on payments.refunds (status, next_attempt_at);
create unique index on payments.refunds (origin, origin_id) where origin_id is not null and status <> 'cancelled';
create table payments.refund_items (
  refund_id uuid not null,
  order_item_id uuid not null,
  group_id uuid not null,
  seller_id uuid,
  amount int not null
);
comment on table payments.refund_items is 'Refund amount per order item; the cap check sums these';
create index on payments.refund_items (order_item_id);
create table payments.refund_log (
  id uuid primary key,
  refund_id uuid not null,
  from_status text,
  to_status text not null,
  detail text,
  actor jsonb not null,
  at timestamptz not null
);
create table payments.disputes (
  id uuid primary key,
  ref text not null unique,
  kind text not null,
  provider text not null,
  provider_case_id text not null,
  intent_id uuid not null,
  order_id uuid not null,
  group_id uuid,
  seller_id uuid,
  reason_code text not null,
  reason text not null,
  amount int not null,
  currency text not null,
  evidence_due_at timestamptz,
  status text not null,
  evidence jsonb not null,
  owner_staff_id uuid,
  opened_at timestamptz not null,
  decided_at timestamptz
);
create unique index on payments.disputes (provider, provider_case_id);
create index on payments.disputes (status, evidence_due_at);
create table payments.saved_methods (
  id uuid primary key,
  customer_id uuid not null,
  provider text not null,
  provider_method_id text not null,
  kind text not null,
  brand text not null,
  last4 text not null,
  exp_month int not null,
  exp_year int not null,
  label text not null,
  billing_address jsonb not null,
  is_default bool not null,
  removed_at timestamptz,
  created_at timestamptz not null
);
comment on table payments.saved_methods is 'Provider tokens only: brand, last 4, expiry, label';
create index on payments.saved_methods (customer_id) where removed_at is null;
create table payments.webhook_events (
  id uuid primary key,
  provider text not null,
  external_id text not null,
  type text not null,
  payload jsonb not null,
  received_at timestamptz not null,
  processed_at timestamptz,
  outcome text
);
comment on table payments.webhook_events is 'Raw provider events, deduplicated by provider event id';
create unique index on payments.webhook_events (provider, external_id);
create table payments.ref_sequences (
  kind text not null,
  day date not null,
  last_value int not null
);
comment on table payments.ref_sequences is 'Daily counters for RF- and CB- references';
create unique index on payments.ref_sequences (kind, day);
alter table payments.allocations add foreign key (intent_id) references payments.intents (id);
alter table payments.captures add foreign key (intent_id) references payments.intents (id);
alter table payments.refunds add foreign key (intent_id) references payments.intents (id);
alter table payments.refund_items add foreign key (refund_id) references payments.refunds (id);
alter table payments.refund_log add foreign key (refund_id) references payments.refunds (id);
alter table payments.disputes add foreign key (intent_id) references payments.intents (id);
`,
};
