import type { Migration } from '../../../../../kernel/migrations/index.js';

/**
 * Gap pass 3:
 * - title (product title with variant label, denormalised from catalog for title search; filled at create and on
 *   catalog.product.updated / merged, and for existing rows by the hourly offers.reevaluate-eligibility job) and
 *   missing_items_stale.
 * - Uniqueness enforced for the Official Store too (seller_id null): NULLS NOT DISTINCT on (owner_type, seller_id,
 *   seller_sku) and on live New offers per (owner_type, seller_id, variant_id); one live offer per stock item.
 *
 * Existing duplicates are resolved first, deterministically, keeping the offer that was published (non-draft) and
 * created first (then the lowest id):
 *   1. several live (not removed) offers on one stock item: the others are removed;
 *   2. several live New offers of one owner on one variant: the others are removed;
 *   3. one SKU used twice by one owner (any status): the other rows get "<sku>-dup-<first 8 of id>".
 * Each removal writes a status log row (event remove, reason code duplicate_resolved) and a status reason the
 * seller sees; nobody is notified (no events from a migration).
 */
const removeLosers = (partition: string, where: string, text: string) => /* sql */ `
with ranked as (
  select id, status,
         row_number() over (partition by ${partition} order by (status = 'draft'), created_at, id) as rn
    from offers.offers
   where status <> 'removed' and ${where}
), logged as (
  insert into offers.offer_status_log (id, offer_id, from_status, to_status, event, reason_code, reason, affected_activity, appeal_route, review_date, actor_kind, actor_id, at)
  select gen_random_uuid(), id, status, 'removed', 'remove', 'duplicate_resolved', '${text}', null, null, null, 'system', null, now()
    from ranked where rn > 1
)
update offers.offers o
   set status = 'removed',
       removed_at = now(),
       updated_at = now(),
       status_before_ineligible = null,
       ineligible_source = null,
       status_reason = jsonb_build_object('code', 'removed_by_staff', 'text', '${text}', 'affectedActivity', null, 'appealRoute', null, 'reviewDate', null,
                                          'actor', jsonb_build_object('kind', 'system', 'id', null), 'at', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
  from ranked r
 where r.id = o.id and r.rn > 1;
`;

export const m0002TitlesAndUniqueness: Migration = {
  id: '0002_titles_and_uniqueness',
  sql: /* sql */ `
alter table offers.offers add column title text not null default '';
alter table offers.offers add column missing_items_stale bool not null default false;
comment on column offers.offers.title is 'product title with variant label, denormalised from catalog for title search';
comment on column offers.offers.missing_items_stale is 'product box changed since missingItems was saved';

${removeLosers('stock_item_id', 'true', 'Removed automatically: another live offer already sells this stock item')}
${removeLosers("owner_type, coalesce(seller_id::text, ''), variant_id", "condition = 'new'", 'Removed automatically: another live New offer already exists for this variant')}

with ranked as (
  select id, row_number() over (partition by owner_type, coalesce(seller_id::text, ''), seller_sku order by (status = 'removed'), created_at, id) as rn
    from offers.offers
)
update offers.offers o
   set seller_sku = left(o.seller_sku, 50) || '-dup-' || left(o.id::text, 8), updated_at = now()
  from ranked r
 where r.id = o.id and r.rn > 1;

drop index if exists offers.offers_owner_type_seller_id_seller_sku_idx;
drop index if exists offers.offers_seller_id_variant_id_idx;
create unique index offers_owner_seller_sku_key on offers.offers (owner_type, seller_id, seller_sku) nulls not distinct;
create unique index offers_live_new_variant_key on offers.offers (owner_type, seller_id, variant_id) nulls not distinct where condition = 'new' and status <> 'removed';
create unique index offers_live_stock_item_key on offers.offers (stock_item_id) where status <> 'removed';
create index on offers.offers (shipping_profile_id, status);
create index offers_title_trgm on offers.offers using gin (title gin_trgm_ops);
`,
};
