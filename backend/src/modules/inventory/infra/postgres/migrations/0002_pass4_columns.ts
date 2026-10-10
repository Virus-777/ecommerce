import type { Migration } from '../../../../../kernel/migrations/index.js';

/**
 * Gap pass 4.
 * 1. reservations.source replaces the `order-allocation:<kind>:` key prefix that marked allocateForOrder
 *    reservations: existing rows get their source from the prefix and lose it from the key; keys are unique per source.
 * 2. transfers.note: the planner's note (it was kept only in the audit entry, which inventory can't read: existing
 *    transfers have none).
 * 3. valuation_snapshots: the daily valuation job writes here (it only logged before; nothing to backfill).
 * 4. Consumers dedupe through the kernel inbox instead of movement notes: the cancellations and shipments already
 *    applied (notes "Cancellation <id>" / "Shipment <id>") are claimed so a redelivered event changes nothing.
 */
export const m0002Pass4Columns: Migration = {
  id: '0002_pass4_columns',
  sql: /* sql */ `
alter table inventory.reservations add column source text not null default 'checkout' check (source in ('checkout', 'replacement', 'exchange'));
update inventory.reservations
  set source = case when key like 'order-allocation:exchange:%' then 'exchange' else 'replacement' end,
      key = regexp_replace(key, '^order-allocation:(exchange|replacement):', '')
  where key like 'order-allocation:%';
alter table inventory.reservations alter column source drop default;
alter table inventory.reservations drop constraint reservations_key_key;
create unique index on inventory.reservations (source, key);

alter table inventory.transfers add column note text;

create table inventory.valuation_snapshots (
  snapshot_date date not null,
  stock_group text not null check (stock_group in ('available', 'reserved', 'incoming', 'damaged_held', 'returned')),
  units int not null,
  value_at_cost_amount bigint not null,
  currency char(3) not null,
  sku_count int not null,
  taken_at timestamptz not null,
  primary key (snapshot_date, stock_group)
);
comment on table inventory.valuation_snapshots is 'Daily company stock valuation per stock group (job inventory.valuation-snapshot) for trading reports; one row per market day and group, rewritten if the job runs again that day';

insert into kernel.processed_events (module, key)
  select distinct 'inventory', 'shipment-dispatched:' || substr(m.note, 10)
  from inventory.stock_movements m
  where m.reason_code = 'dispatched' and m.note like 'Shipment %'
  on conflict do nothing;
insert into kernel.processed_events (module, key)
  select distinct 'inventory', 'item-cancelled:' || substr(m.note, 14) || ':' || l.order_item_id || ':' || r.id
  from inventory.stock_movements m
  join inventory.reservations r on r.order_id::text = m.ref_id
  join inventory.reservation_lines l on l.reservation_id = r.id and l.stock_item_id = m.stock_item_id and l.order_item_id is not null and l.released_qty > 0
  where m.reason_code = 'order_cancelled' and m.ref_kind = 'order' and m.note like 'Cancellation %'
  on conflict do nothing;
`,
};
