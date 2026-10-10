import type { Migration } from '../../../../../kernel/migrations/index.js';

/**
 * Fulfilled by Marketly (seller stock held and sold from a Marketly warehouse).
 * 1. stock_items.service_location_id: the company location a seller item sells from (setServiceLocation); null for
 *    every existing item (they sell as before).
 * 2. inbound_receipts take Fulfilled by Marketly receipts too: source_kind (existing rows purchase_order), source_id
 *    and source_ref (backfilled from the purchase order), owner_type (existing rows official) and seller_id; the
 *    purchase order columns become optional.
 * 3. inbound_lines.unit_cost_amount becomes optional (service receipts carry no company cost).
 * 4. incoming_expectations.source_kind accepts service_inbound.
 */
export const m0003FulfilledByMarketly: Migration = {
  id: '0003_fulfilled_by_marketly',
  sql: /* sql */ `
alter table inventory.stock_items add column service_location_id uuid references inventory.locations (id);
comment on column inventory.stock_items.service_location_id is 'Fulfilled by Marketly: the company location this seller item sells from; null = the seller''s own location';
create index stock_items_service_location_idx on inventory.stock_items (service_location_id) where service_location_id is not null;

alter table inventory.inbound_receipts add column source_kind text not null default 'purchase_order' check (source_kind in ('purchase_order', 'service_inbound'));
alter table inventory.inbound_receipts add column source_id uuid;
alter table inventory.inbound_receipts add column source_ref text;
alter table inventory.inbound_receipts add column owner_type text not null default 'official' check (owner_type in ('official', 'seller'));
alter table inventory.inbound_receipts add column seller_id uuid;
update inventory.inbound_receipts set source_id = purchase_order_id, source_ref = purchase_order_ref where source_id is null;
alter table inventory.inbound_receipts alter column purchase_order_id drop not null;
alter table inventory.inbound_receipts alter column purchase_order_ref drop not null;
create index inbound_receipts_source_idx on inventory.inbound_receipts (source_kind, source_id);
comment on table inventory.inbound_receipts is 'Counted receipts from purchasing and from the fulfillment service waiting for confirmation';

alter table inventory.inbound_lines alter column unit_cost_amount drop not null;

alter table inventory.incoming_expectations drop constraint incoming_expectations_source_kind_check;
alter table inventory.incoming_expectations add constraint incoming_expectations_source_kind_check check (source_kind in ('purchase_order', 'transfer', 'service_inbound'));
comment on table inventory.incoming_expectations is 'Open incoming quantities from purchase orders, transfers and Fulfilled by Marketly inbound shipments';
`,
};
