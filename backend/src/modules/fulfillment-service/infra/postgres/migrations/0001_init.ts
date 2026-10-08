import type { Migration } from '../../../../../kernel/migrations/index.js';

/** Tables, constraints and indexes from docs/api/spec/modules/fulfillment-service.json (spec "tables"). */
export const m0001Init: Migration = {
  id: '0001_init',
  sql: /* sql */ `
create table fulfillment_service.enrollments (
  id uuid primary key,
  seller_id uuid not null unique,
  state text not null,
  terms_version text not null,
  fee_schedule_version text not null,
  accepted_at timestamptz,
  accepted_by text,
  max_cubic_feet numeric not null,
  max_skus int not null,
  reason text,
  reviewer_id text,
  created_at timestamptz not null,
  decided_at timestamptz
);
create table fulfillment_service.sku_enrollments (
  id uuid primary key,
  seller_id uuid not null,
  offer_id uuid not null unique,
  product_id uuid not null,
  sku text not null,
  dimensions jsonb not null,
  weight_grams int not null,
  size_tier text not null,
  barcode text,
  label_required bool not null,
  restricted bool not null,
  restriction_reason text,
  state text not null,
  inventory_item_id uuid
);
create index on fulfillment_service.sku_enrollments (seller_id, state);
create table fulfillment_service.inbound_shipments (
  id uuid primary key,
  ref text not null unique,
  seller_id uuid not null,
  state text not null,
  ship_from jsonb not null,
  destination jsonb not null,
  boxes int not null,
  carrier text,
  tracking text,
  expected_arrival date,
  arrived_at timestamptz,
  received_at timestamptz,
  warehouse_receipt_id uuid,
  created_at timestamptz not null
);
create index on fulfillment_service.inbound_shipments (seller_id, state);
create index on fulfillment_service.inbound_shipments (state, expected_arrival);
create table fulfillment_service.inbound_lines (
  inbound_id uuid not null,
  sku_enrollment_id uuid not null,
  expected int not null,
  received int not null,
  damaged int not null
);
create table fulfillment_service.discrepancies (
  id uuid primary key,
  inbound_id uuid not null,
  summary text not null,
  evidence_media_ids jsonb not null,
  seller_response text not null,
  claim_note text,
  decision text,
  decided_by text,
  decided_at timestamptz
);
create table fulfillment_service.ownership_ledger (
  id uuid primary key,
  seller_id uuid not null,
  sku_enrollment_id uuid not null,
  movement text not null,
  quantity int not null,
  from_group text,
  to_group text,
  reference text,
  actor_kind text not null,
  actor_id text,
  reason text,
  at timestamptz not null
);
comment on table fulfillment_service.ownership_ledger is 'Every movement of seller-owned units in our warehouse (received, reserved, shipped, returned, unsellable, removed, disposed, adjusted) with reason; reconciles with inventory';
create index on fulfillment_service.ownership_ledger (seller_id, at);
create index on fulfillment_service.ownership_ledger (sku_enrollment_id, at);
create table fulfillment_service.fulfillment_requests (
  id uuid primary key,
  order_id uuid not null,
  seller_group_id uuid not null unique,
  seller_id uuid not null,
  state text not null,
  items jsonb not null,
  warehouse_task_id uuid,
  shipment_id uuid,
  dispatch_by timestamptz not null,
  created_at timestamptz not null
);
create table fulfillment_service.service_returns (
  id uuid primary key,
  return_id uuid not null,
  seller_id uuid not null,
  sku_enrollment_id uuid not null,
  quantity int not null,
  outcome text not null,
  inspection_note text,
  evidence_media_ids jsonb not null,
  inspected_at timestamptz
);
create table fulfillment_service.removal_orders (
  id uuid primary key,
  ref text not null unique,
  seller_id uuid not null,
  kind text not null,
  state text not null,
  lines jsonb not null,
  ship_to jsonb,
  tracking text,
  created_at timestamptz not null
);
create table fulfillment_service.fee_schedules (
  id uuid primary key,
  version text not null unique,
  effective_at timestamptz not null,
  rates jsonb not null,
  state text not null,
  approval_request_id uuid
);
create table fulfillment_service.fee_charges (
  id uuid primary key,
  seller_id uuid not null,
  type text not null,
  period text,
  reference text,
  units numeric not null,
  rate bigint not null,
  amount bigint not null,
  currency text not null,
  state text not null,
  posted_at timestamptz,
  reason text,
  idempotency_key text not null unique
);
create index on fulfillment_service.fee_charges (seller_id, state);
create index on fulfillment_service.fee_charges (type, period);
create table fulfillment_service.storage_snapshots (
  day date not null,
  seller_id uuid not null,
  sku_enrollment_id uuid not null,
  units int not null,
  cubic_feet numeric not null,
  aged_units jsonb not null
);
comment on table fulfillment_service.storage_snapshots is 'Daily volume per seller and SKU for storage billing';
create unique index on fulfillment_service.storage_snapshots (day, sku_enrollment_id);
alter table fulfillment_service.inbound_lines add foreign key (inbound_id) references fulfillment_service.inbound_shipments (id);
alter table fulfillment_service.inbound_lines add foreign key (sku_enrollment_id) references fulfillment_service.sku_enrollments (id);
alter table fulfillment_service.discrepancies add foreign key (inbound_id) references fulfillment_service.inbound_shipments (id);
alter table fulfillment_service.ownership_ledger add foreign key (sku_enrollment_id) references fulfillment_service.sku_enrollments (id);
`,
};
