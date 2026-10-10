import type { Migration } from '../../../../../kernel/migrations/index.js';

/**
 * A takedown keeps when it happened and whether public URLs serve the placeholder (spec assets.removed_at,
 * assets.show_placeholder). Before this, both lived only in the takedown's action-history entry
 * (audit.entries, action media.asset.remove, after.showPlaceholder): files removed now are backfilled from
 * their latest takedown entry, read once here because that is the only place the data was kept. Removed files
 * without one (audit off) keep the behaviour they had: the placeholder is shown, removed_at stays unknown.
 */
export const m0002TakedownColumns: Migration = {
  id: '0002_takedown_columns',
  sql: /* sql */ `
alter table media.assets add column removed_at timestamptz;
alter table media.assets add column show_placeholder bool;
comment on column media.assets.removed_at is 'set while status is removed';
comment on column media.assets.show_placeholder is 'while removed: public URLs serve the neutral placeholder; false = they stop serving';
do $$
begin
  if to_regclass('audit.entries') is not null then
    update media.assets a
       set removed_at = t.at,
           show_placeholder = coalesce((t.after ->> 'showPlaceholder')::bool, true)
      from (
        select distinct on (target_id) target_id, at, after
          from audit.entries
         where action = 'media.asset.remove' and target_type = 'media_asset'
         order by target_id, at desc
      ) t
     where a.status = 'removed' and a.id::text = t.target_id;
  end if;
end $$;
update media.assets set show_placeholder = true where status = 'removed' and show_placeholder is null;
`,
};
