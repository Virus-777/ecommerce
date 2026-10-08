import type { Migration } from '../../../../../kernel/migrations/index.js';

/** Tables, constraints and indexes from docs/api/spec/modules/finance.json (spec "tables"). */
export const m0001Init: Migration = {
  id: '0001_init',
  sql: /* sql */ `
create table finance.seller_accounts (
  seller_id uuid primary key,
  pending bigint not null,
  available bigint not null,
  held bigint not null,
  currency text not null,
  negative_since timestamptz,
  payouts_blocked_reason text,
  fee_override_set_id uuid,
  updated_at timestamptz not null
);
comment on table finance.seller_accounts is 'Running balances per seller (derived from ledger_entries, kept for fast reads)';
create table finance.ledger_entries (
  id uuid primary key,
  seller_id uuid not null,
  at timestamptz not null,
  type text not null,
  ref_kind text not null,
  ref_id text not null,
  ref_label text,
  description text not null,
  amount bigint not null,
  currency text not null,
  bucket text not null,
  balance_after bigint not null,
  lot_id uuid,
  statement_id uuid,
  recorded_by text,
  source_event_id text unique
);
comment on table finance.ledger_entries is 'Append-only seller ledger. Corrections are new entries, never edits.';
create index on finance.ledger_entries (seller_id, at desc);
create index on finance.ledger_entries (ref_kind, ref_id);
create index on finance.ledger_entries (statement_id);
create table finance.earnings_lots (
  id uuid primary key,
  seller_id uuid not null,
  order_id uuid not null,
  order_item_id uuid not null unique,
  state text not null,
  gross bigint not null,
  fee bigint not null,
  net bigint not null,
  delivered_at timestamptz,
  available_at timestamptz,
  payout_id uuid
);
comment on table finance.earnings_lots is 'Net earnings per seller order item, moving pending → available → paid out';
create index on finance.earnings_lots (state, available_at);
create index on finance.earnings_lots (seller_id, state);
create table finance.fee_rule_sets (
  id uuid primary key,
  version text not null,
  status text not null,
  basis text not null,
  include_shipping bool not null,
  platform_discounts_reduce_fee bool not null,
  default_rate_bps int not null,
  treatment jsonb not null,
  agreement_version text not null,
  effective_from timestamptz,
  reason text,
  approval_request_id uuid,
  created_by text not null,
  created_at timestamptz not null
);
create index on finance.fee_rule_sets (status, effective_from);
create table finance.fee_category_rates (
  rule_set_id uuid not null,
  category_id uuid not null,
  rate_bps int not null
);
create unique index on finance.fee_category_rates (rule_set_id, category_id);
create table finance.fee_charges (
  id uuid primary key,
  order_item_id uuid not null unique,
  seller_id uuid not null,
  rule_set_id uuid not null,
  basis_amount bigint not null,
  rate_bps int not null,
  fee bigint not null,
  refunded_fee bigint not null,
  status text not null check (status in ('charged', 'kept_disputed', 'reversed')),
  created_at timestamptz not null
);
comment on table finance.fee_charges is 'Fee computed per order item at sale with the rule version used';
create table finance.refund_allocations (
  refund_request_id uuid primary key,
  payment_refund_id uuid,
  order_id uuid not null,
  owner_type text not null check (owner_type in ('official', 'seller')),
  seller_id uuid,
  funded_by text not null,
  seller_share bigint not null,
  platform_share bigint not null,
  breakdown jsonb not null,
  applied_at timestamptz
);
comment on table finance.refund_allocations is 'Funding split from returns.refund.approved, applied when payments.refund.sent arrives';
create table finance.holds (
  id uuid primary key,
  seller_id uuid not null,
  amount bigint not null,
  released_amount bigint not null,
  currency text not null,
  reason_code text not null,
  reason text not null,
  review_date date not null,
  ref_kind text,
  ref_id text,
  status text not null,
  placed_by text not null,
  placed_at timestamptz not null,
  released_at timestamptz,
  release_reason text,
  approval_request_id uuid
);
create index on finance.holds (seller_id, status);
create index on finance.holds (status, review_date);
create table finance.adjustments (
  id uuid primary key,
  ref text not null unique,
  seller_id uuid not null,
  direction text not null,
  amount bigint not null,
  currency text not null,
  reason_code text not null,
  reason text not null,
  ref_kind text,
  ref_id text,
  status text not null,
  recorded_by text not null,
  approval_request_id uuid,
  idempotency_key text unique,
  created_at timestamptz not null
);
create index on finance.adjustments (seller_id, created_at desc);
create index on finance.adjustments (status);
create table finance.amounts_owed (
  id uuid primary key,
  seller_id uuid not null,
  amount bigint not null,
  remaining bigint not null,
  currency text not null,
  since date not null,
  due_by date,
  status text not null,
  origin jsonb not null,
  note text
);
create index on finance.amounts_owed (seller_id, status);
create table finance.payout_destinations (
  id uuid primary key,
  seller_id uuid not null,
  sellers_account_id uuid not null,
  label text not null,
  provider_destination_id text,
  status text not null,
  verified_at timestamptz,
  active bool not null,
  pause_until timestamptz,
  deposits_sent_at timestamptz,
  deposit_attempts int not null
);
comment on table finance.payout_destinations is 'Verification state of the seller''s payout account (details stay in sellers)';
create index on finance.payout_destinations (seller_id, active);
create table finance.destination_reviews (
  id uuid primary key,
  seller_id uuid not null,
  destination_id uuid not null,
  from_label text,
  to_label text not null,
  requested_by text not null,
  requested_at timestamptz not null,
  status text not null,
  checks jsonb not null,
  decided_by text,
  decided_at timestamptz,
  reason text
);
create index on finance.destination_reviews (status, requested_at);
create table finance.payout_runs (
  id uuid primary key,
  ref text not null unique,
  status text not null,
  scheduled_release timestamptz not null,
  cutoff_at timestamptz not null,
  total bigint not null,
  paying_now bigint not null,
  held bigint not null,
  negative_offset bigint not null,
  currency text not null,
  approvals jsonb not null,
  approval_request_id uuid,
  created_at timestamptz not null,
  released_at timestamptz,
  completed_at timestamptz
);
create index on finance.payout_runs (status, scheduled_release);
create table finance.payouts (
  id uuid primary key,
  ref text not null unique,
  seller_id uuid not null,
  run_id uuid,
  amount bigint not null,
  currency text not null,
  status text not null,
  destination_id uuid not null,
  requested_on date not null,
  released_at timestamptz,
  paid_at timestamptz,
  failed_at timestamptz,
  failure_code text,
  failure_reason text,
  retry_of uuid,
  provider_payout_id text unique,
  bank_reference text,
  statement_id uuid,
  holds_withheld bigint not null,
  negative_offset bigint not null,
  idempotency_key text unique
);
create index on finance.payouts (seller_id, requested_on desc);
create index on finance.payouts (run_id, status);
create index on finance.payouts (status);
create table finance.statements (
  id uuid primary key,
  ref text not null unique,
  seller_id uuid not null,
  period_from date not null,
  period_to date not null,
  status text not null,
  issued_at timestamptz,
  payout_id uuid,
  sections jsonb not null,
  reconciliation jsonb not null,
  rule_version text not null,
  pdf_media_id uuid,
  csv_media_id uuid
);
comment on table finance.statements is 'Issued statements are immutable; later corrections appear on the next statement';
create index on finance.statements (seller_id, period_to desc);
create table finance.trading_entries (
  id uuid primary key,
  at timestamptz not null,
  kind text not null check (kind in ('sale', 'buying_cost', 'discount', 'shipping_expense', 'return', 'write_off', 'chargeback_loss', 'supplier_credit')),
  amount bigint not null,
  currency text not null,
  order_id uuid,
  order_item_id uuid,
  variant_id uuid,
  ref_kind text,
  ref_id text
);
comment on table finance.trading_entries is 'Company trading facts for the Official Store (never part of seller payouts)';
create index on finance.trading_entries (at);
create index on finance.trading_entries (kind, at);
create table finance.trading_targets (
  id uuid primary key,
  period text not null,
  category_id uuid,
  sales_target bigint not null,
  currency text not null,
  margin_target_bps int,
  note text,
  set_by text not null,
  set_at timestamptz not null
);
comment on table finance.trading_targets is 'Official Store sales and margin targets per month, optionally per category';
create unique index on finance.trading_targets (period, category_id);
create table finance.recon_days (
  date date primary key,
  status text not null,
  owner_staff_id uuid not null,
  backup_staff_id uuid,
  due_at timestamptz not null,
  checklist jsonb not null,
  completed_by text,
  completed_at timestamptz
);
create table finance.recon_items (
  id uuid primary key,
  date date not null,
  "check" text not null,
  ref_kind text,
  ref_id text,
  subject text not null,
  description text not null,
  expected bigint not null,
  actual bigint not null,
  difference bigint not null,
  currency text not null,
  detected_at timestamptz not null,
  status text not null,
  note text,
  owner_staff_id uuid,
  correction jsonb,
  approval_request_id uuid
);
create index on finance.recon_items (date, "check");
create index on finance.recon_items (status, detected_at);
alter table finance.fee_category_rates add foreign key (rule_set_id) references finance.fee_rule_sets (id);
alter table finance.fee_charges add foreign key (rule_set_id) references finance.fee_rule_sets (id);
alter table finance.destination_reviews add foreign key (destination_id) references finance.payout_destinations (id);
alter table finance.payouts add foreign key (run_id) references finance.payout_runs (id);
alter table finance.payouts add foreign key (destination_id) references finance.payout_destinations (id);
alter table finance.payouts add foreign key (retry_of) references finance.payouts (id);
alter table finance.recon_items add foreign key (date) references finance.recon_days (date);
`,
};
