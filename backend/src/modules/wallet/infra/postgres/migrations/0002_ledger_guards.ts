import type { Migration } from '../../../../../kernel/migrations/index.js';

/**
 * Money guards and lookups (no new columns: the tables stay exactly as the spec designs them).
 *
 * - The ledger is append-only: a trigger refuses UPDATE, DELETE and TRUNCATE, so the balance can always be
 *   rebuilt as the sum of its entries.
 * - Balances, lot remainders and hold amounts can never go negative or above what a lot was given.
 * - One live hold per checkout (quote): a second concurrent hold for the same quote fails on the index.
 * - Lookups used by the jobs, the approval consumer and the refund path.
 */
export const m0002LedgerGuards: Migration = {
  id: '0002_ledger_guards',
  sql: /* sql */ `
create function wallet.ledger_append_only() returns trigger language plpgsql as $fn$
begin
  raise exception 'wallet.ledger is append-only (% refused)', tg_op using errcode = '42501';
end
$fn$;
create trigger ledger_append_only before update or delete on wallet.ledger
  for each row execute function wallet.ledger_append_only();
create trigger ledger_no_truncate before truncate on wallet.ledger
  for each statement execute function wallet.ledger_append_only();

alter table wallet.accounts add constraint accounts_non_negative check (available >= 0 and held >= 0);
alter table wallet.lots add constraint lots_amounts check (original > 0 and remaining >= 0 and remaining <= original);
alter table wallet.lots add constraint lots_source check (source in ('refund', 'goodwill', 'price_adjustment', 'gift_card', 'correction'));
alter table wallet.holds add constraint holds_amount check (amount > 0);
alter table wallet.holds add constraint holds_state check (state in ('held', 'captured', 'released'));
alter table wallet.goodwill_grants add constraint goodwill_amount check (amount > 0);
alter table wallet.goodwill_grants add constraint goodwill_state check (state in ('pending_approval', 'granted', 'rejected', 'reversed'));
alter table wallet.gift_cards add constraint gift_cards_amounts check (initial > 0 and remaining >= 0 and remaining <= initial);
alter table wallet.gift_cards add constraint gift_cards_state check (state in ('issued', 'active', 'redeemed', 'voided', 'expired'));

create unique index holds_one_live_per_quote on wallet.holds (quote_id) where state = 'held';
create index on wallet.holds (state, expires_at);
create index on wallet.holds (customer_id, state);
create index on wallet.lots (state, expires_at) where state = 'active';
create index on wallet.ledger (order_id) where order_id is not null;
create index on wallet.ledger (hold_id) where hold_id is not null;
create index on wallet.goodwill_grants (approval_request_id) where approval_request_id is not null;
create index on wallet.goodwill_grants (ledger_entry_id) where ledger_entry_id is not null;
create index on wallet.gift_cards (batch_id, created_at);
create index on wallet.gift_cards (code_last4);
create index on wallet.gift_cards (state, expires_at);
create index on wallet.loyalty_entries (customer_id, at);
`,
};
