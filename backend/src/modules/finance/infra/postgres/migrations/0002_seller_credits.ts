import type { Migration } from '../../../../../kernel/migrations/index.js';

/** seller_credits (spec gap pass 2): credits to sellers without an original charge (creditSeller); pending ones wait for finance.credits.issue */
export const m0002SellerCredits: Migration = {
  id: '0002_seller_credits',
  sql: /* sql */ `
create table if not exists finance.seller_credits (
  id uuid primary key,
  seller_id uuid not null,
  amount bigint not null,
  currency text not null,
  reason text not null,
  ref_kind text not null,
  ref_id text not null,
  ref_label text,
  status text not null,
  idempotency_key text not null unique,
  requested_by text not null,
  approval_request_id uuid,
  ledger_entry_id uuid references finance.ledger_entries (id),
  created_at timestamptz not null,
  decided_at timestamptz
);
comment on table finance.seller_credits is 'Credits to sellers without an original charge (creditSeller); pending ones wait for finance.credits.issue';
create index if not exists seller_credits_seller_created on finance.seller_credits (seller_id, created_at desc);
create index if not exists seller_credits_status on finance.seller_credits (status);
`,
};
