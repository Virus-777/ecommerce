import type { Migration } from '../../../../../kernel/migrations/index.js';

/** Tables, constraints and indexes from docs/api/spec/modules/purchasing.json (spec "tables"). */
export const m0001Init: Migration = {
  id: '0001_init',
  sql: /* sql */ `
create table purchasing.suppliers (
  id uuid primary key,
  name text not null,
  location text,
  contact_name text,
  email text,
  phone text,
  address jsonb,
  payment_terms text not null,
  lead_time_days int not null,
  active bool not null,
  notes text,
  created_at timestamptz not null
);
create index on purchasing.suppliers (active, name);
create table purchasing.supplier_items (
  supplier_id uuid not null,
  stock_item_id uuid not null,
  supplier_sku text,
  unit_cost_amount bigint not null,
  currency char(3) not null,
  min_order_qty int,
  lead_time_days int,
  preferred bool not null,
  updated_at timestamptz not null,
  primary key (supplier_id, stock_item_id)
);
comment on table purchasing.supplier_items is 'Supplier price list per company stock item';
create index on purchasing.supplier_items (stock_item_id) where preferred;
create table purchasing.supplier_performance (
  supplier_id uuid primary key,
  window_days int not null,
  on_time_pct numeric(5,2),
  avg_lead_time_days numeric(6,2),
  shortage_rate_pct numeric(5,2),
  damage_rate_pct numeric(5,2),
  deliveries int not null,
  computed_at timestamptz not null
);
comment on table purchasing.supplier_performance is 'Nightly figures per supplier';
create table purchasing.purchase_orders (
  id uuid primary key,
  ref text not null unique,
  supplier_id uuid not null,
  ship_to_location_id uuid not null,
  status text not null,
  payment_terms text not null,
  expected_date date,
  freight_amount bigint not null,
  currency char(3) not null,
  total_amount bigint not null,
  approval_request_id uuid,
  approval_state text check (approval_state in ('pending', 'approved', 'rejected')),
  notes text,
  attachment_media_ids jsonb not null,
  created_by text not null,
  created_at timestamptz not null,
  sent_at timestamptz,
  closed_at timestamptz,
  close_reason text
);
create index on purchasing.purchase_orders (status, expected_date);
create index on purchasing.purchase_orders (supplier_id, created_at);
create index on purchasing.purchase_orders (approval_request_id);
create table purchasing.purchase_order_lines (
  id uuid primary key,
  purchase_order_id uuid not null,
  stock_item_id uuid not null,
  sku text not null,
  label text not null,
  qty_ordered int not null,
  qty_received int not null,
  qty_damaged int not null,
  qty_closed int not null,
  unit_cost_amount bigint not null,
  expected_date date
);
create index on purchasing.purchase_order_lines (purchase_order_id);
create index on purchasing.purchase_order_lines (stock_item_id);
create table purchasing.purchase_order_events (
  id uuid primary key,
  purchase_order_id uuid not null,
  label text not null,
  detail text,
  actor_kind text not null,
  actor_id text,
  at timestamptz not null
);
comment on table purchasing.purchase_order_events is 'PO timeline (created, sent, approval, backorder, received, closed)';
create index on purchasing.purchase_order_events (purchase_order_id, at);
create table purchasing.deliveries (
  id uuid primary key,
  purchase_order_id uuid not null,
  carrier text,
  tracking_ref text,
  window_from timestamptz not null,
  window_to timestamptz not null,
  units int not null,
  status text not null,
  delay_reason text,
  arrived_at timestamptz,
  dock text
);
comment on table purchasing.deliveries is 'Expected inbound deliveries per purchase order';
create index on purchasing.deliveries (status, window_from);
create index on purchasing.deliveries (purchase_order_id);
create table purchasing.receipts (
  id uuid primary key,
  ref text not null unique,
  purchase_order_id uuid not null,
  delivery_id uuid not null,
  location_id uuid not null,
  status text not null,
  note text,
  received_by text not null,
  started_at timestamptz not null,
  submitted_at timestamptz,
  confirmed_by text,
  confirmed_at timestamptz
);
create index on purchasing.receipts (status, started_at);
create unique index on purchasing.receipts (delivery_id) where status = 'in_progress';
create table purchasing.receipt_lines (
  receipt_id uuid not null,
  purchase_order_line_id uuid not null,
  stock_item_id uuid not null,
  expected int not null,
  received int not null,
  damaged int not null,
  bin_code text,
  photo_media_ids jsonb not null,
  note text,
  primary key (receipt_id, purchase_order_line_id)
);
create table purchasing.supplier_claims (
  id uuid primary key,
  ref text not null unique,
  supplier_id uuid not null,
  purchase_order_id uuid not null,
  receipt_id uuid,
  kind text not null,
  lines jsonb not null,
  amount bigint not null,
  currency char(3) not null,
  status text not null,
  settlement text,
  settled_amount bigint,
  owner_id text not null,
  notes text,
  created_at timestamptz not null,
  decided_at timestamptz
);
create index on purchasing.supplier_claims (status, created_at);
create index on purchasing.supplier_claims (supplier_id);
alter table purchasing.supplier_items add foreign key (supplier_id) references purchasing.suppliers (id);
alter table purchasing.supplier_performance add foreign key (supplier_id) references purchasing.suppliers (id);
alter table purchasing.purchase_orders add foreign key (supplier_id) references purchasing.suppliers (id);
alter table purchasing.purchase_order_lines add foreign key (purchase_order_id) references purchasing.purchase_orders (id);
alter table purchasing.purchase_order_events add foreign key (purchase_order_id) references purchasing.purchase_orders (id);
alter table purchasing.deliveries add foreign key (purchase_order_id) references purchasing.purchase_orders (id);
alter table purchasing.receipts add foreign key (purchase_order_id) references purchasing.purchase_orders (id);
alter table purchasing.receipts add foreign key (delivery_id) references purchasing.deliveries (id);
alter table purchasing.receipt_lines add foreign key (receipt_id) references purchasing.receipts (id);
alter table purchasing.receipt_lines add foreign key (purchase_order_line_id) references purchasing.purchase_order_lines (id);
alter table purchasing.supplier_claims add foreign key (supplier_id) references purchasing.suppliers (id);
alter table purchasing.supplier_claims add foreign key (purchase_order_id) references purchasing.purchase_orders (id);
alter table purchasing.supplier_claims add foreign key (receipt_id) references purchasing.receipts (id);
`,
};
