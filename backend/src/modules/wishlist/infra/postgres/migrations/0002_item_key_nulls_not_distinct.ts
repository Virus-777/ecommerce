import type { Migration } from '../../../../../kernel/migrations/index.js';

/**
 * A list holds a product and variant once (spec table items: `unique nulls not distinct (list_id, product_id,
 * variant_id)`). The old index counted a null variant as distinct, so a product saved without a variant could be in
 * a list twice. Before the index is built, duplicates merge into the oldest item of their key (added_at, then id),
 * the way moving an item onto its twin does: the kept item takes the duplicate's note and offer when it has none,
 * an alert kind the kept item lacks moves to it, an alert kind it already has is removed (state removed, no item),
 * and the duplicate items are deleted.
 */
export const m0002ItemKeyNullsNotDistinct: Migration = {
  id: '0002_item_key_nulls_not_distinct',
  sql: /* sql */ `
create temporary table item_dupes on commit drop as
select id, keeper from (
  select id, first_value(id) over w as keeper, row_number() over w as n
  from wishlist.items
  window w as (partition by list_id, product_id, variant_id order by added_at, id)
) r
where n > 1;

update wishlist.items k
set note = coalesce(k.note, s.note),
    offer_id = coalesce(k.offer_id, s.offer_id),
    price_when_saved = coalesce(k.price_when_saved, s.price_when_saved)
from (
  select distinct on (d.keeper) d.keeper, i.note, i.offer_id, i.price_when_saved
  from item_dupes d join wishlist.items i on i.id = d.id
  order by d.keeper, i.added_at, i.id
) s
where k.id = s.keeper;

with ranked as (
  select a.id, coalesce(d.keeper, a.item_id) as keeper,
    row_number() over (partition by coalesce(d.keeper, a.item_id), a.kind order by (d.id is not null), a.created_at, a.id) as n,
    d.id is not null as on_duplicate
  from wishlist.alerts a
  left join item_dupes d on d.id = a.item_id
  where a.state <> 'removed'
    and (d.id is not null or a.item_id in (select keeper from item_dupes))
)
update wishlist.alerts a
set item_id = case when r.n = 1 then r.keeper else null end,
    state = case when r.n = 1 then a.state else 'removed' end
from ranked r
where r.id = a.id and r.on_duplicate;
update wishlist.alerts a set item_id = null from item_dupes d where a.item_id = d.id;

delete from wishlist.items i using item_dupes d where i.id = d.id;

do $$
declare idx text;
begin
  for idx in
    select i.relname from pg_index x join pg_class i on i.oid = x.indexrelid
    where x.indrelid = 'wishlist.items'::regclass and x.indisunique and not x.indisprimary
  loop
    execute format('drop index wishlist.%I', idx);
  end loop;
end $$;
create unique index items_key_idx on wishlist.items (list_id, product_id, variant_id) nulls not distinct;
`,
};
