import type { Migration } from '../../../../../kernel/migrations/index.js';

/**
 * Gap pass 4: values that were derived from other rows get columns of their own.
 *
 * campaigns
 * - paused_by, paused_at, pause_cause: who paused and why (automatic cause), read from the campaign log until now
 *   (latest pause / auto_pause:<cause> entry). Backfill for paused campaigns from that entry.
 * - rejected_reason: the rejection reason was kept in paused_reason. Backfill: moved out of paused_reason for
 *   rejected campaigns, and for archived ones whose paused_reason is the text of their reject log entry.
 *
 * campaign_items
 * - product_id: the product an offer or product item promotes. Offer items carried it in a synthetic
 *   'offer_product' row (target_id = product, label = offer id). Backfill from those rows (product items: their own
 *   target), then the synthetic rows are deleted and kind is checked.
 *
 * frequency_state
 * - total_displays: backfilled from the display events of the visitor key (ad_events, as counted until now).
 * - display_day / day_displays: the market day is not known in SQL, so existing rows start with display_day null;
 *   serving counts today's displays of such a row from ad_events until its next display sets the day.
 */
export const m0004PauseItemsFrequency: Migration = {
  id: '0004_pause_items_frequency',
  sql: /* sql */ `
alter table advertising.campaigns add column paused_by text;
alter table advertising.campaigns add column paused_at timestamptz;
alter table advertising.campaigns add column pause_cause text check (pause_cause in ('promotion', 'offer', 'stock', 'product', 'availability', 'seller', 'trust'));
alter table advertising.campaigns add column rejected_reason text;
comment on column advertising.campaigns.paused_by is 'Actor kind:id of the last pause';
comment on column advertising.campaigns.pause_cause is 'automatic pauses only';

with last_pause as (
  select distinct on (campaign_id) campaign_id, action, actor_kind, actor_id, at
    from advertising.campaign_log
   where action = 'pause' or action like 'auto\\_pause:%'
   order by campaign_id, at desc, id desc
)
update advertising.campaigns c
   set paused_by = p.actor_kind || coalesce(':' || p.actor_id, ''),
       paused_at = p.at,
       pause_cause = case when p.action like 'auto\\_pause:%' and substr(p.action, 12) in ('promotion', 'offer', 'stock', 'product', 'availability', 'seller', 'trust') then substr(p.action, 12) end
  from last_pause p
 where p.campaign_id = c.id and c.status = 'paused';

update advertising.campaigns set rejected_reason = paused_reason, paused_reason = null where status = 'rejected';
update advertising.campaigns c set rejected_reason = c.paused_reason, paused_reason = null
 where c.status = 'archived' and c.paused_reason is not null
   and exists (select 1 from advertising.campaign_log l where l.campaign_id = c.id and l.action = 'reject' and l.reason = c.paused_reason);

alter table advertising.campaign_items add column product_id uuid;
comment on column advertising.campaign_items.product_id is 'the product: target_id for kind product, the offer''s product for kind offer; null for stores and brands';
update advertising.campaign_items set product_id = target_id where kind = 'product';
update advertising.campaign_items i
   set product_id = op.target_id
  from advertising.campaign_items op
 where i.kind = 'offer' and op.kind = 'offer_product' and op.campaign_id = i.campaign_id and op.label = i.target_id::text;
delete from advertising.campaign_items where kind = 'offer_product';
alter table advertising.campaign_items add constraint campaign_items_kind_check check (kind in ('offer', 'product', 'seller_store', 'brand'));
create index on advertising.campaign_items (product_id);

alter table advertising.frequency_state add column display_day date;
alter table advertising.frequency_state add column day_displays int not null default 0;
alter table advertising.frequency_state add column total_displays int not null default 0;
alter table advertising.frequency_state alter column day_displays drop default;
alter table advertising.frequency_state alter column total_displays drop default;
comment on column advertising.frequency_state.display_day is 'market day day_displays counts; null for rows written before it was kept';
update advertising.frequency_state f
   set total_displays = (select count(*)::int from advertising.ad_events e where e.visitor_key = f.visitor_key and e.campaign_id = f.campaign_id and e.kind = 'display');
`,
};
