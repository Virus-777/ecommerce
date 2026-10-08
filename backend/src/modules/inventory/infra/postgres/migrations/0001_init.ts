import type { Migration } from '../../../../../kernel/migrations/index.js';

/** Tables, constraints and indexes from docs/api/spec/modules/inventory.json (spec "tables"). */
export const m0001Init: Migration = {
  id: '0001_init',
  sql: /* sql */ `
create table inventory.locations (
  id uuid primary key,
  code text not null unique,
  name text not null,
  kind text not null,
  owner_type text not null,
  seller_id uuid,
  address jsonb,
  time_zone text not null,
  sellable bool not null,
  active bool not null,
  is_default bool not null
);
comment on table inventory.locations is 'Stock locations (company warehouses; one virtual location per seller)';
create table inventory.stock_items (
  id uuid primary key,
  owner_type text not null check (owner_type in ('official', 'seller')),
  seller_id uuid,
  sku text not null,
  offer_id uuid,
  product_id uuid not null,
  variant_id uuid not null,
  condition text not null,
  label text not null,
  low_stock_threshold int,
  reorder_quantity int,
  unit_cost_amount bigint,
  currency char(3) not null,
  primary_bin_code text,
  low_since timestamptz,
  archived bool not null,
  created_at timestamptz not null,
  updated_at timestamptz not null
);
comment on table inventory.stock_items is 'One per seller offer or company SKU';
create unique index on inventory.stock_items (owner_type, (coalesce(seller_id, '00000000-0000-0000-0000-000000000000')), sku);
create index on inventory.stock_items (seller_id, archived);
create index on inventory.stock_items (offer_id);
create index on inventory.stock_items (variant_id);
create table inventory.stock_levels (
  stock_item_id uuid not null,
  location_id uuid not null,
  available int not null check (available >= 0),
  reserved int not null check (reserved >= 0),
  incoming int not null check (incoming >= 0),
  damaged_held int not null check (damaged_held >= 0),
  returned int not null check (returned >= 0),
  version int not null,
  updated_at timestamptz not null,
  primary key (stock_item_id, location_id)
);
comment on table inventory.stock_levels is 'Current quantities per item and location; changed only together with a movement row';
comment on column inventory.stock_levels.version is 'optimistic lock';
create index on inventory.stock_levels (location_id);
create table inventory.stock_movements (
  id uuid primary key,
  stock_item_id uuid not null,
  location_id uuid not null,
  from_group text not null,
  to_group text not null,
  quantity int not null check (quantity > 0),
  reason_code text not null,
  note text,
  ref_kind text,
  ref_id text,
  ref_label text,
  actor_kind text not null,
  actor_id text,
  actor_name text,
  approved_by text,
  after jsonb not null,
  at timestamptz not null
);
comment on table inventory.stock_movements is 'Append-only ledger; never updated or deleted';
create index on inventory.stock_movements (stock_item_id, at);
create index on inventory.stock_movements (ref_kind, ref_id);
create index on inventory.stock_movements (reason_code, at);
create table inventory.incoming_expectations (
  id uuid primary key,
  stock_item_id uuid not null,
  location_id uuid not null,
  source_kind text not null check (source_kind in ('purchase_order', 'transfer')),
  source_id uuid not null,
  source_ref text not null,
  quantity_open int not null,
  expected_date date
);
comment on table inventory.incoming_expectations is 'Open incoming quantities from purchase orders (and transfers)';
create index on inventory.incoming_expectations (stock_item_id, expected_date);
create index on inventory.incoming_expectations (source_kind, source_id);
create table inventory.reservations (
  id uuid primary key,
  key text not null unique,
  order_id uuid,
  order_ref text,
  state text not null,
  expires_at timestamptz,
  released_reason text,
  created_at timestamptz not null,
  updated_at timestamptz not null
);
create index on inventory.reservations (state, expires_at);
create index on inventory.reservations (order_id);
create table inventory.reservation_lines (
  id uuid primary key,
  reservation_id uuid not null,
  stock_item_id uuid not null,
  location_id uuid not null,
  order_item_id uuid,
  quantity int not null,
  fulfilled_qty int not null,
  released_qty int not null,
  state text not null
);
create index on inventory.reservation_lines (reservation_id);
create index on inventory.reservation_lines (stock_item_id, state);
create index on inventory.reservation_lines (order_item_id);
create table inventory.adjustments (
  id uuid primary key,
  stock_item_id uuid not null,
  location_id uuid not null,
  from_group text not null,
  to_group text not null,
  quantity int not null,
  reason_code text not null,
  note text,
  review_date date,
  state text not null,
  approval_request_id uuid,
  requested_by text not null,
  decided_by text,
  movement_id uuid,
  created_at timestamptz not null,
  applied_at timestamptz
);
comment on table inventory.adjustments is 'Staff adjustment requests incl. those waiting for a second reviewer';
create index on inventory.adjustments (state, created_at);
create index on inventory.adjustments (stock_item_id);
create index on inventory.adjustments (approval_request_id);
create table inventory.held_stock (
  id uuid primary key,
  stock_item_id uuid not null,
  location_id uuid not null,
  quantity int not null,
  reason_code text not null,
  reason text,
  review_date date not null,
  source_ref text,
  released_at timestamptz
);
comment on table inventory.held_stock is 'Units in Damaged or held with reason and review date';
create index on inventory.held_stock (review_date) where released_at is null;
create table inventory.inbound_receipts (
  id uuid primary key,
  receipt_id uuid not null unique,
  receipt_ref text not null,
  purchase_order_id uuid not null,
  purchase_order_ref text not null,
  supplier_name text not null,
  location_id uuid not null,
  received_by text not null,
  received_at timestamptz not null,
  state text not null,
  confirmed_by text,
  confirmed_at timestamptz,
  note text
);
comment on table inventory.inbound_receipts is 'Counted receipts from purchasing waiting for confirmation';
create index on inventory.inbound_receipts (state, received_at);
create table inventory.inbound_lines (
  inbound_id uuid not null,
  stock_item_id uuid not null,
  expected int not null,
  received int not null,
  damaged int not null,
  bin_code text,
  unit_cost_amount bigint not null,
  sellable int,
  reason text,
  primary key (inbound_id, stock_item_id)
);
create table inventory.return_outcomes (
  id uuid primary key,
  return_id uuid not null,
  return_ref text not null,
  order_ref text not null,
  stock_item_id uuid not null,
  quantity int not null,
  inspected_condition text not null,
  proposed_outcome text not null,
  proposed_target_sku text,
  state text not null,
  recorded_outcome text,
  target_stock_item_id uuid,
  recorded_by text,
  recorded_at timestamptz,
  inspected_at timestamptz not null
);
create unique index on inventory.return_outcomes (return_id, stock_item_id);
create index on inventory.return_outcomes (state);
create table inventory.discrepancies (
  id uuid primary key,
  kind text not null,
  stock_item_id uuid not null,
  location_id uuid not null,
  bin_code text,
  quantity int not null,
  order_id uuid,
  order_ref text,
  note text,
  photo_media_ids jsonb not null,
  state text not null,
  resolution text,
  resolution_note text,
  reported_by text not null,
  reported_at timestamptz not null,
  resolved_by text,
  resolved_at timestamptz
);
create index on inventory.discrepancies (state, reported_at);
create index on inventory.discrepancies (order_id);
create table inventory.transfers (
  id uuid primary key,
  ref text not null unique,
  from_location_id uuid not null,
  to_location_id uuid not null,
  state text not null,
  created_by text not null,
  shipped_at timestamptz,
  received_at timestamptz
);
comment on table inventory.transfers is 'Phase 4';
create table inventory.transfer_lines (
  transfer_id uuid not null,
  stock_item_id uuid not null,
  quantity int not null,
  received_quantity int,
  primary key (transfer_id, stock_item_id)
);
comment on table inventory.transfer_lines is 'Phase 4';
create table inventory.stock_counts (
  id uuid primary key,
  location_id uuid not null,
  scope text not null,
  state text not null,
  created_by text not null,
  submitted_at timestamptz
);
comment on table inventory.stock_counts is 'Phase 4';
create table inventory.count_lines (
  count_id uuid not null,
  stock_item_id uuid not null,
  bin_code text,
  expected int not null,
  counted int,
  primary key (count_id, stock_item_id)
);
comment on table inventory.count_lines is 'Phase 4';
alter table inventory.stock_levels add foreign key (stock_item_id) references inventory.stock_items (id);
alter table inventory.stock_levels add foreign key (location_id) references inventory.locations (id);
alter table inventory.stock_movements add foreign key (stock_item_id) references inventory.stock_items (id);
alter table inventory.stock_movements add foreign key (location_id) references inventory.locations (id);
alter table inventory.incoming_expectations add foreign key (stock_item_id) references inventory.stock_items (id);
alter table inventory.incoming_expectations add foreign key (location_id) references inventory.locations (id);
alter table inventory.reservation_lines add foreign key (reservation_id) references inventory.reservations (id);
alter table inventory.reservation_lines add foreign key (stock_item_id) references inventory.stock_items (id);
alter table inventory.reservation_lines add foreign key (location_id) references inventory.locations (id);
alter table inventory.adjustments add foreign key (stock_item_id) references inventory.stock_items (id);
alter table inventory.adjustments add foreign key (location_id) references inventory.locations (id);
alter table inventory.adjustments add foreign key (movement_id) references inventory.stock_movements (id);
alter table inventory.held_stock add foreign key (stock_item_id) references inventory.stock_items (id);
alter table inventory.held_stock add foreign key (location_id) references inventory.locations (id);
alter table inventory.inbound_receipts add foreign key (location_id) references inventory.locations (id);
alter table inventory.inbound_lines add foreign key (inbound_id) references inventory.inbound_receipts (id);
alter table inventory.inbound_lines add foreign key (stock_item_id) references inventory.stock_items (id);
alter table inventory.return_outcomes add foreign key (stock_item_id) references inventory.stock_items (id);
alter table inventory.discrepancies add foreign key (stock_item_id) references inventory.stock_items (id);
alter table inventory.discrepancies add foreign key (location_id) references inventory.locations (id);
alter table inventory.transfers add foreign key (from_location_id) references inventory.locations (id);
alter table inventory.transfers add foreign key (to_location_id) references inventory.locations (id);
alter table inventory.transfer_lines add foreign key (transfer_id) references inventory.transfers (id);
alter table inventory.transfer_lines add foreign key (stock_item_id) references inventory.stock_items (id);
alter table inventory.stock_counts add foreign key (location_id) references inventory.locations (id);
alter table inventory.count_lines add foreign key (count_id) references inventory.stock_counts (id);
alter table inventory.count_lines add foreign key (stock_item_id) references inventory.stock_items (id);
`,
};
