import type { Migration } from '../../../../../kernel/migrations/index.js';

/** Tables, constraints and indexes from docs/api/spec/modules/warehouse.json (spec "tables"). */
export const m0001Init: Migration = {
  id: '0001_init',
  sql: /* sql */ `
create table warehouse.bins (
  id uuid primary key,
  location_id uuid not null,
  code text not null,
  zone text not null,
  kind text not null,
  barcode text not null,
  active bool not null
);
create unique index on warehouse.bins (location_id, code);
create unique index on warehouse.bins (barcode);
create index on warehouse.bins (location_id, zone);
create table warehouse.bin_assignments (
  stock_item_id uuid not null,
  bin_id uuid not null,
  primary_bin bool not null,
  assigned_at timestamptz not null,
  primary key (stock_item_id, bin_id)
);
comment on table warehouse.bin_assignments is 'Which stock items are stored in which bins';
create unique index on warehouse.bin_assignments (stock_item_id) where primary_bin;
create index on warehouse.bin_assignments (bin_id);
create table warehouse.fulfillments (
  id uuid primary key,
  order_id uuid not null,
  order_ref text not null,
  seller_group_id uuid not null unique,
  location_id uuid not null,
  status text not null,
  ship_by timestamptz not null,
  delivery_choice text not null,
  ship_to jsonb not null,
  wave_id uuid,
  hold_reason text,
  discrepancy_ids jsonb not null,
  total_packages_in_order int not null,
  created_at timestamptz not null,
  updated_at timestamptz not null
);
comment on table warehouse.fulfillments is 'One per Official Store seller group of an accepted order';
create index on warehouse.fulfillments (status, ship_by);
create index on warehouse.fulfillments (wave_id);
create index on warehouse.fulfillments (order_id);
create table warehouse.fulfillment_lines (
  id uuid primary key,
  fulfillment_id uuid not null,
  order_item_id uuid not null,
  stock_item_id uuid not null,
  sku text not null,
  label text not null,
  quantity int not null,
  bin_code text,
  picked int not null,
  short int not null,
  state text not null,
  picked_by text,
  picked_at timestamptz
);
create index on warehouse.fulfillment_lines (fulfillment_id);
create index on warehouse.fulfillment_lines (bin_code);
create table warehouse.waves (
  id uuid primary key,
  ref text not null,
  location_id uuid not null,
  status text not null,
  carrier_pickup_at timestamptz,
  created_by text not null,
  created_at timestamptz not null,
  completed_at timestamptz
);
create index on warehouse.waves (location_id, status);
create table warehouse.scan_log (
  id uuid primary key,
  context text not null,
  context_id uuid,
  code text not null,
  result text not null,
  actor_id text not null,
  station text,
  at timestamptz not null
);
comment on table warehouse.scan_log is 'Every scan at pick, pack, put-away and returns (troubleshooting and productivity)';
create index on warehouse.scan_log (context, context_id, at);
create table warehouse.box_types (
  id uuid primary key,
  name text not null,
  kind text not null,
  dimensions jsonb not null,
  max_weight jsonb,
  active bool not null
);
create table warehouse.packages (
  id uuid primary key,
  fulfillment_id uuid not null,
  index_in_order int not null,
  of_in_order int not null,
  status text not null,
  box_type_id uuid,
  dimensions jsonb,
  weight jsonb,
  fragile bool not null,
  handling_note text,
  carrier text,
  service text,
  tracking_number text,
  label_media_id uuid,
  label_idempotency_key text,
  shipment_id uuid,
  packed_by text,
  packed_at timestamptz,
  station text
);
create index on warehouse.packages (fulfillment_id);
create unique index on warehouse.packages (tracking_number);
create table warehouse.package_items (
  package_id uuid not null,
  order_item_id uuid not null,
  stock_item_id uuid not null,
  quantity int not null,
  scanned int not null,
  serial_numbers text[] not null,
  primary key (package_id, order_item_id)
);
create table warehouse.putaway_tasks (
  id uuid primary key,
  receipt_id uuid not null,
  receipt_ref text not null,
  location_id uuid not null,
  stock_item_id uuid not null,
  quantity int not null,
  suggested_bin_code text,
  bin_code text,
  status text not null,
  done_by text,
  done_at timestamptz
);
create index on warehouse.putaway_tasks (status, receipt_id);
create table warehouse.return_parcels (
  id uuid primary key,
  location_id uuid not null,
  return_id uuid,
  return_ref text,
  order_ref text,
  tracking_number text,
  status text not null,
  expected_by date,
  expected_items jsonb not null,
  unexpected bool not null,
  parcel_condition text,
  photo_media_ids jsonb not null,
  note text,
  received_by text,
  received_at timestamptz,
  handed_over_to text,
  handed_over_at timestamptz
);
create index on warehouse.return_parcels (status, expected_by);
create index on warehouse.return_parcels (return_id);
create index on warehouse.return_parcels (tracking_number);
alter table warehouse.bin_assignments add foreign key (bin_id) references warehouse.bins (id);
alter table warehouse.fulfillments add foreign key (wave_id) references warehouse.waves (id);
alter table warehouse.fulfillment_lines add foreign key (fulfillment_id) references warehouse.fulfillments (id);
alter table warehouse.packages add foreign key (fulfillment_id) references warehouse.fulfillments (id);
alter table warehouse.packages add foreign key (box_type_id) references warehouse.box_types (id);
alter table warehouse.package_items add foreign key (package_id) references warehouse.packages (id);
`,
};
