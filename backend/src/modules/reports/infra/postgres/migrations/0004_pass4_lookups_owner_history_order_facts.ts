import type { Migration } from '../../../../../kernel/migrations/index.js';

/**
 * Pass 4 (spec tables metric_definitions, metric_owner_changes, open_stockouts, campaign_refs, fact_order_items):
 *  1. metric_definitions.change_note: the note of the current draft or published version (it was read back from
 *     metric_versions per metric, and a draft's note was only in the audit history). Backfilled from the version row of
 *     the current version; drafts keep null until revised again.
 *  2. metric_owner_changes: the owner history behind PUT /metrics/{key}/owner (only audit-logged before; nothing to
 *     copy).
 *  3. open_stockouts and campaign_refs replace the 'lookup:' rows kept in read_model_checkpoints: open out-of-stock
 *     intervals ('lookup:stockout:<stockItemId>' = '<productId>|<since>') and the campaign of a coupon redemption or ad
 *     charge ('lookup:redemption:<id>', 'lookup:charge:<id>' = campaign id). The rows move and the lookups are deleted.
 *  4. fact_order_items.accepted_at and group_id. Existing rows only belong to accepted orders: accepted_at takes the
 *     placement time; group_id stays null (orders holds it; captures fall back to the group owner for those rows).
 */
export const m0004Pass4LookupsOwnerHistoryOrderFacts: Migration = {
  id: '0004_pass4_lookups_owner_history_order_facts',
  sql: /* sql */ `
alter table reports.metric_definitions add column change_note text;
comment on column reports.metric_definitions.change_note is 'what the current draft changes, or the published version''s note';
update reports.metric_definitions m set change_note = v.change_note
from reports.metric_versions v
where v.metric_key = m.key and v.version = m.version and m.status <> 'draft';

create table reports.metric_owner_changes (
  id uuid primary key,
  metric_key text not null references reports.metric_definitions (key),
  from_staff_id uuid,
  to_staff_id uuid not null,
  reason text not null,
  changed_by text not null,
  changed_at timestamptz not null
);
comment on table reports.metric_owner_changes is 'Who owned a metric when: every PUT /metrics/{key}/owner (not a new version)';
create index on reports.metric_owner_changes (metric_key, changed_at desc);

create table reports.open_stockouts (
  stock_item_id uuid primary key,
  product_id uuid not null,
  since timestamptz not null
);
comment on table reports.open_stockouts is 'Out-of-stock intervals still open per stock item (inventory.stock.changed); closing one adds its minutes to fact_discovery_daily';
create table reports.campaign_refs (
  kind text not null check (kind in ('redemption', 'charge')),
  ref_id uuid not null,
  campaign_id uuid not null,
  created_at timestamptz not null,
  primary key (kind, ref_id)
);
comment on table reports.campaign_refs is 'Campaign behind a coupon redemption or ad charge, for the reversal or credit that names only the redemption or charge';

insert into reports.open_stockouts (stock_item_id, product_id, since)
select substr(key, 17)::uuid, split_part(last_event_id, '|', 1)::uuid, split_part(last_event_id, '|', 2)::timestamptz
from reports.read_model_checkpoints
where key like 'lookup:stockout:%' and last_event_id like '%|%'
  and substr(key, 17) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  and split_part(last_event_id, '|', 1) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
on conflict (stock_item_id) do nothing;
insert into reports.campaign_refs (kind, ref_id, campaign_id, created_at)
select split_part(key, ':', 2), split_part(key, ':', 3)::uuid, last_event_id::uuid, coalesce(last_event_at, now())
from reports.read_model_checkpoints
where (key like 'lookup:redemption:%' or key like 'lookup:charge:%')
  and split_part(key, ':', 3) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  and last_event_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
on conflict (kind, ref_id) do nothing;
delete from reports.read_model_checkpoints where key like 'lookup:%';

alter table reports.fact_order_items add column accepted_at timestamptz, add column group_id uuid;
comment on column reports.fact_order_items.accepted_at is 'order acceptance; rows recorded before pass 4 hold the placement time';
comment on column reports.fact_order_items.group_id is 'seller group of the order; payments.payment.captured is matched on it';
update reports.fact_order_items set accepted_at = placed_at where accepted_at is null;
create index on reports.fact_order_items (order_id, group_id);
comment on column reports.fact_service_daily.first_reply_minutes_p50 is 'median first reply minutes of the day from messaging.sellerResponseStats, its average when no median; a range shows the average of the daily medians';
`,
};
