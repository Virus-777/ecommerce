import type { Migration } from '../../../../../kernel/migrations/index.js';

/**
 * Pass 3: gift card batches (spec table gift_card_batches).
 *
 * A batch keeps its plain codes only encrypted (codes_ciphertext, AES-256-GCM with the
 * secretFor(config, 'wallet.gift-card-codes') key) until the issuer downloads them once or
 * giftCardCodesTtlHours pass; cards keep only code hashes. A batch waiting for approval is saved here too
 * (status pending_approval) so the issue call answers 201 with the pending batch.
 *
 * Batches issued before this migration get a row built from their cards (their codes were never stored, so
 * they have none to download).
 */
export const m0003GiftCardBatches: Migration = {
  id: '0003_gift_card_batches',
  sql: /* sql */ `
create table wallet.gift_card_batches (
  id uuid primary key,
  count int not null,
  amount bigint not null,
  currency text not null,
  purpose text not null,
  expires_at timestamptz,
  reason text not null,
  cost_center text,
  status text not null,
  approval_request_id uuid,
  codes_ciphertext text,
  codes_file_id uuid,
  codes_delivered_at timestamptz,
  codes_expire_at timestamptz,
  created_by text not null,
  idempotency_key text not null unique,
  created_at timestamptz not null,
  constraint gift_card_batches_status check (status in ('pending_approval', 'issued', 'rejected')),
  constraint gift_card_batches_amounts check (count > 0 and amount > 0)
);
create index on wallet.gift_card_batches (status, created_at);
create index on wallet.gift_card_batches (codes_expire_at) where codes_ciphertext is not null;
create index on wallet.gift_card_batches (approval_request_id) where approval_request_id is not null;

insert into wallet.gift_card_batches (id, count, amount, currency, purpose, expires_at, reason, cost_center, status, approval_request_id, codes_ciphertext, codes_file_id, codes_delivered_at, codes_expire_at, created_by, idempotency_key, created_at)
select batch_id, count(*)::int, min(initial), min(currency), min(purpose), min(expires_at), 'Issued before batches were recorded', null, 'issued', null, null, null, null, null,
  min(created_by), 'legacy:' || batch_id::text, min(created_at)
from wallet.gift_cards
where batch_id is not null
group by batch_id;
`,
};
