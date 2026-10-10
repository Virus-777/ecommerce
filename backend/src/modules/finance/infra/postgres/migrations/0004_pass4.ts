import type { Migration } from '../../../../../kernel/migrations/index.js';

const UUID_RE = `'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'`;
/** Platform (marketplace) facts that pass 3 kept in trading_entries under these ref_kind values */
const PLATFORM_COST_KINDS = `('platform_label', 'platform_refund', 'platform_claim', 'wallet_credit', 'wallet_correction', 'wallet_breakage', 'platform_write_off')`;

/**
 * Gap pass 4: columns and tables for what pass 3 kept in jsonb, notes and ref_kind prefixes. Every new
 * column or table is backfilled from where its data lived.
 *
 * - captures: payments captured (card and store credit). Before, a capture existed only as its recon item
 *   (ref_kind 'capture'): backfilled from those items; the store credit is read from the item's description
 *   ("plus store credit $12.00" / "store credit $12.00 also applied"). Order and intent ids were never kept
 *   (null for these rows).
 * - recon_items.credit: the store credit applied with a captured payment. expected is now the order total
 *   (it was stored as total − credit), so capture items get expected + credit.
 * - discount_funding, platform_costs, store_credit_liability: marketplace facts moved out of trading_entries
 *   (ref_kind coupon_redemption / coupon_seller_part; platform_label, platform_refund, platform_claim,
 *   wallet_credit, wallet_correction, wallet_breakage, platform_write_off; wallet_liability). Row ids are kept,
 *   so the consumers' deterministic ids still match and a redelivered event adds nothing. A written-off seller
 *   debt (platform_write_off) is a platform cost now, no longer counted in Official Store trading.
 * - fee_category_rates.category_name: from fee_rule_sets.treatment.categoryNames (then removed from treatment).
 * - seller_accounts.new_seller_until / new_seller_extra_days: from the zero-amount new_seller rule holds
 *   (review date; "N extra days" in the reason, else the newSellerHoldDays default 14), which are deleted.
 * - amounts_owed.write_off_amount / write_off_reason / approval_request_id: a write-off waiting for approval
 *   is kept on the record (the endpoint answers 200 with `approval`). Write-offs requested before this kept
 *   only a note; they still finish from their approval request's details when decided.
 */
export const m0004Pass4: Migration = {
  id: '0004_pass4',
  sql: /* sql */ `
-- ---------------------------------------------------------------- captures and recon_items.credit
create table finance.captures (
  id uuid primary key,
  intent_id uuid,
  order_id uuid,
  group_id uuid,
  card_amount bigint not null,
  credit_amount bigint not null,
  currency text not null,
  provider_ref text,
  captured_at timestamptz not null,
  recon_item_id uuid
);
comment on table finance.captures is 'Payments captured (payments.payment.captured): card amount and store credit applied';
create index on finance.captures (captured_at);
create index on finance.captures (order_id);

alter table finance.recon_items add column credit bigint not null default 0;

insert into finance.captures (id, intent_id, order_id, group_id, card_amount, credit_amount, currency, provider_ref, captured_at, recon_item_id)
select r.ref_id::uuid, null, null, null, r.actual,
  coalesce(round(replace((regexp_match(r.description, 'store credit [^0-9]*([0-9][0-9,]*\\.[0-9]{2})'))[1], ',', '')::numeric * 100)::bigint, 0),
  r.currency, case when r."check" = 'unexplained_amount' and r.subject <> 'Captured payment' then r.subject else null end, r.detected_at, r.id
from finance.recon_items r
where r.ref_kind = 'capture' and r.ref_id ~ ${UUID_RE}
on conflict (id) do nothing;

update finance.recon_items r
set credit = c.credit_amount,
    expected = case when r."check" = 'payments_vs_orders' then r.expected + c.credit_amount else r.expected end,
    difference = case when r."check" = 'payments_vs_orders' then r.difference else r.difference + c.credit_amount end
from finance.captures c
where c.recon_item_id = r.id and c.credit_amount <> 0;

alter table finance.recon_items alter column credit drop default;

-- ---------------------------------------------------------------- discount funding
create table finance.discount_funding (
  id uuid primary key,
  at timestamptz not null,
  redemption_id uuid not null,
  funded_by text not null check (funded_by in ('platform', 'seller')),
  kind text not null check (kind in ('redeemed', 'reversed')),
  amount bigint not null,
  currency text not null,
  order_id uuid,
  order_item_id uuid
);
create index on finance.discount_funding (at);
create index on finance.discount_funding (redemption_id);

insert into finance.discount_funding (id, at, redemption_id, funded_by, kind, amount, currency, order_id, order_item_id)
select t.id, t.at, t.ref_id::uuid, case when t.ref_kind = 'coupon_redemption' then 'platform' else 'seller' end,
  case when t.amount < 0 then 'reversed' else 'redeemed' end, t.amount, t.currency, t.order_id, t.order_item_id
from finance.trading_entries t
where t.ref_kind in ('coupon_redemption', 'coupon_seller_part') and t.ref_id ~ ${UUID_RE}
on conflict (id) do nothing;

-- ---------------------------------------------------------------- platform costs
create table finance.platform_costs (
  id uuid primary key,
  at timestamptz not null,
  kind text not null check (kind in ('label', 'refund', 'carrier_claim', 'goodwill_credit', 'credit_correction', 'credit_breakage', 'write_off')),
  amount bigint not null,
  currency text not null,
  order_id uuid,
  order_item_id uuid,
  ref_kind text check (ref_kind in ('label', 'refund', 'claim', 'wallet_entry', 'amount_owed')),
  ref_id text
);
create index on finance.platform_costs (at);
create index on finance.platform_costs (kind, at);

insert into finance.platform_costs (id, at, kind, amount, currency, order_id, order_item_id, ref_kind, ref_id)
select t.id, t.at,
  case t.ref_kind when 'platform_label' then 'label' when 'platform_refund' then 'refund' when 'platform_claim' then 'carrier_claim'
    when 'wallet_credit' then 'goodwill_credit' when 'wallet_correction' then 'credit_correction' when 'wallet_breakage' then 'credit_breakage' else 'write_off' end,
  case when t.ref_kind = 'platform_claim' then -t.amount else t.amount end,
  t.currency, t.order_id, t.order_item_id,
  case t.ref_kind when 'platform_label' then 'label' when 'platform_refund' then 'refund' when 'platform_claim' then 'claim' when 'platform_write_off' then 'amount_owed' else 'wallet_entry' end,
  t.ref_id
from finance.trading_entries t
where t.ref_kind in ${PLATFORM_COST_KINDS}
on conflict (id) do nothing;

-- ---------------------------------------------------------------- store credit liability
create table finance.store_credit_liability (
  id uuid primary key,
  at timestamptz not null,
  kind text not null check (kind in ('granted', 'used', 'reversed', 'expired', 'corrected')),
  amount bigint not null,
  currency text not null,
  wallet_entry_id uuid,
  order_id uuid
);
comment on table finance.store_credit_liability is 'Store credit liability from wallet events';
create index on finance.store_credit_liability (at);

insert into finance.store_credit_liability (id, at, kind, amount, currency, wallet_entry_id, order_id)
select t.id, t.at,
  case
    when t.order_id is not null and t.ref_id = t.order_id::text then 'used'
    when exists (select 1 from finance.trading_entries x where x.ref_kind = 'wallet_breakage' and x.ref_id = t.ref_id) then 'expired'
    when exists (select 1 from finance.trading_entries x where x.ref_kind = 'wallet_correction' and x.ref_id = t.ref_id) then 'corrected'
    when t.amount < 0 then 'reversed'
    else 'granted'
  end,
  t.amount, t.currency,
  case when t.order_id is not null and t.ref_id = t.order_id::text then null when t.ref_id ~ ${UUID_RE} then t.ref_id::uuid else null end,
  t.order_id
from finance.trading_entries t
where t.ref_kind = 'wallet_liability'
on conflict (id) do nothing;

delete from finance.trading_entries
where ref_kind in ('coupon_redemption', 'coupon_seller_part', 'wallet_liability', 'wallet_credit_used')
   or ref_kind in ${PLATFORM_COST_KINDS};

-- ---------------------------------------------------------------- fee category names
alter table finance.fee_category_rates add column category_name text;
update finance.fee_category_rates r
set category_name = s.treatment -> 'categoryNames' ->> r.category_id::text
from finance.fee_rule_sets s
where s.id = r.rule_set_id;
update finance.fee_category_rates set category_name = 'Category' where category_name is null or category_name = '';
alter table finance.fee_category_rates alter column category_name set not null;
update finance.fee_rule_sets set treatment = treatment - 'categoryNames' where treatment ? 'categoryNames';

-- ---------------------------------------------------------------- new-seller period on the account
alter table finance.seller_accounts add column new_seller_until date;
alter table finance.seller_accounts add column new_seller_extra_days int;
insert into finance.seller_accounts (seller_id, pending, available, held, currency, negative_since, payouts_blocked_reason, fee_override_set_id, new_seller_until, new_seller_extra_days, updated_at)
select h.seller_id, 0, 0, 0, h.currency, null, null, null, h.review_date, coalesce((substring(h.reason from '([0-9]+) extra days'))::int, 14), h.placed_at
from finance.holds h
where h.reason_code = 'new_seller' and h.amount = 0 and h.status = 'active'
on conflict (seller_id) do update set new_seller_until = excluded.new_seller_until, new_seller_extra_days = excluded.new_seller_extra_days;
delete from finance.holds where reason_code = 'new_seller' and amount = 0;

-- ---------------------------------------------------------------- write-offs waiting for approval
alter table finance.amounts_owed add column write_off_amount bigint;
alter table finance.amounts_owed add column write_off_reason text;
alter table finance.amounts_owed add column approval_request_id uuid;
`,
};
