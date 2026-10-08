import type { Migration } from '../../../../../kernel/migrations/index.js';

/** Tables, constraints and indexes from docs/api/spec/modules/shipping.json (spec "tables"). */
export const m0001Init: Migration = {
  id: '0001_init',
  sql: /* sql */ `
create table shipping.carriers (
  id uuid primary key,
  code text not null unique,
  name text not null,
  account_label text,
  status text not null,
  tracking_mode text not null,
  credentials_ref text,
  contacts jsonb not null,
  last_event_at timestamptz,
  on_time_rate_30d numeric
);
comment on column shipping.carriers.credentials_ref is 'secret store key';
comment on column shipping.carriers.contacts is 'CarrierContact[]';
create table shipping.carrier_services (
  id uuid primary key,
  carrier_id uuid not null,
  code text not null,
  name text not null,
  transit_min int not null,
  transit_max int not null,
  enabled bool not null,
  label_supported bool not null,
  tracking_pattern text
);
create unique index on shipping.carrier_services (carrier_id, code);
create table shipping.methods (
  id uuid primary key,
  code text not null unique,
  name text not null,
  customer_label text not null,
  transit_min int not null,
  transit_max int not null,
  carrier_service_ids jsonb not null,
  active bool not null,
  position int not null
);
create table shipping.zones (
  id uuid primary key,
  name text not null,
  kind text not null,
  regions jsonb not null,
  postal_prefixes jsonb not null,
  address_kinds jsonb not null,
  transit_by_method jsonb not null,
  status text not null,
  customer_message text
);
create table shipping.profiles (
  id uuid primary key,
  lineage_id uuid not null,
  owner_type text not null,
  seller_id uuid,
  name text not null,
  is_default bool not null,
  methods jsonb not null,
  free_threshold int,
  free_method_code text,
  currency text not null,
  version int not null,
  status text not null,
  effective_from timestamptz not null,
  updated_by jsonb not null,
  updated_at timestamptz not null
);
comment on table shipping.profiles is 'Rate sets, versioned; a version becomes active at effective_from; orders keep the promise accepted at checkout';
comment on column shipping.profiles.lineage_id is 'stable id offers reference';
create index on shipping.profiles (lineage_id, status);
create index on shipping.profiles (seller_id, status);
create table shipping.seller_settings (
  id uuid primary key,
  owner_type text not null,
  seller_id uuid,
  coverage jsonb not null,
  handling_days int not null,
  same_day_cutoff text not null,
  business_days jsonb not null,
  buy_labels bool not null,
  status text not null check (status in ('scheduled', 'active', 'superseded')),
  effective_from timestamptz not null,
  updated_by jsonb not null,
  updated_at timestamptz not null,
  default_parcel jsonb
);
comment on table shipping.seller_settings is 'Coverage, dispatch schedule and label preference per seller (and the Official Store), versioned by effective date';
create index on shipping.seller_settings (seller_id, status);
create table shipping.closures (
  id uuid primary key,
  owner_type text not null,
  seller_id uuid,
  name text not null,
  from_date date not null,
  to_date date not null
);
create index on shipping.closures (seller_id, from_date);
create table shipping.dispatch_targets (
  id uuid primary key,
  official jsonb not null,
  seller_default jsonb not null,
  effective_from timestamptz not null,
  set_by jsonb not null,
  reason text not null
);
create table shipping.notices (
  id uuid primary key,
  title text not null,
  kind text not null,
  from_date date not null,
  to_date date not null,
  carrier_codes jsonb not null,
  carrier_service_ids uuid[] not null,
  regions jsonb not null,
  postal_prefixes text[] not null,
  zone_ids uuid[] not null,
  seller_scope text not null,
  effect jsonb not null,
  customer_message text not null,
  show_from timestamptz,
  surfaces jsonb not null,
  status text not null,
  created_by jsonb not null,
  updated_at timestamptz not null
);
create index on shipping.notices (status, from_date);
create table shipping.free_shipping_rules (
  id uuid primary key,
  name text not null,
  scope text not null,
  min_order_value int,
  method_code text not null,
  funded_by text not null,
  starts_on date,
  ends_on date,
  status text not null
);
create table shipping.shipments (
  id uuid primary key,
  kind text not null,
  order_id uuid not null,
  order_ref text not null,
  group_id uuid not null,
  return_id uuid,
  owner_type text not null,
  seller_id uuid,
  package_no int not null,
  carrier_code text,
  service_name text,
  tracking_number text,
  tracking_state text not null,
  status text not null,
  ship_from text not null,
  to_address jsonb not null,
  shipped_at timestamptz,
  dispatch_due_at timestamptz,
  dispatched_on_time bool,
  estimated_arrival jsonb,
  delivered_at timestamptz,
  failed_delivery jsonb,
  recorded_by jsonb not null,
  created_at timestamptz not null
);
create index on shipping.shipments (order_id);
create index on shipping.shipments (group_id);
create index on shipping.shipments (carrier_code, tracking_number);
create index on shipping.shipments (seller_id, status);
create index on shipping.shipments (status, shipped_at);
create table shipping.shipment_lines (
  shipment_id uuid not null,
  order_item_id uuid not null,
  title text not null,
  variant_label text not null,
  quantity int not null
);
create index on shipping.shipment_lines (order_item_id);
create table shipping.tracking_events (
  id uuid primary key,
  shipment_id uuid not null,
  code text not null,
  label text not null,
  detail text,
  location text,
  source text not null,
  carrier_event_id text,
  at timestamptz not null
);
create index on shipping.tracking_events (shipment_id, at);
create unique index on shipping.tracking_events (shipment_id, carrier_event_id);
create table shipping.tracking_corrections (
  id uuid primary key,
  shipment_id uuid not null,
  from_value text not null,
  to_value text not null,
  reason text not null,
  by jsonb not null,
  customer_notified bool not null,
  at timestamptz not null
);
create table shipping.labels (
  id uuid primary key,
  shipment_id uuid,
  group_id uuid not null,
  carrier_service_id uuid not null,
  cost int not null,
  currency text not null,
  billed_to text not null check (billed_to in ('seller', 'company', 'platform')),
  tracking_number text not null,
  storage_key text not null,
  format text not null,
  status text not null,
  idempotency_key text not null unique,
  purchased_by jsonb not null,
  purchased_at timestamptz not null,
  voided_at timestamptz
);
create table shipping.label_quotes (
  id uuid primary key,
  group_id uuid not null,
  carrier_service_id uuid not null,
  cost int not null,
  parcel jsonb not null,
  estimated_arrival jsonb not null,
  keeps_promise bool not null,
  expires_at timestamptz not null
);
create table shipping.dispatch_watch (
  group_id uuid primary key,
  order_id uuid not null,
  owner_type text not null,
  seller_id uuid,
  due_at timestamptz not null,
  open_item_ids jsonb not null,
  overdue_since timestamptz
);
comment on table shipping.dispatch_watch is 'Open seller groups and their deadline, for overdue detection';
create index on shipping.dispatch_watch (due_at) where overdue_since is null;
create table shipping.exceptions (
  id uuid primary key,
  kind text not null,
  order_id uuid not null,
  order_ref text not null,
  group_id uuid not null,
  shipment_id uuid,
  owner_type text not null,
  seller_id uuid,
  items_summary text not null,
  situation text not null,
  next_step text not null,
  status text not null,
  owner_staff_id uuid,
  owner_name text,
  due_at timestamptz not null,
  customer_notified_at timestamptz,
  seller_notified_at timestamptz,
  escalated_to text,
  seller_response jsonb,
  resolution jsonb,
  claim_id uuid,
  case_ref text,
  opened_by jsonb not null,
  opened_at timestamptz not null
);
create index on shipping.exceptions (kind, status, due_at);
create index on shipping.exceptions (seller_id, status);
create index on shipping.exceptions (group_id);
create unique index on shipping.exceptions (group_id, kind) where status in ('open','in_progress','escalated');
create table shipping.exception_log (
  id uuid primary key,
  exception_id uuid not null,
  action text not null,
  detail text,
  actor jsonb not null,
  at timestamptz not null
);
create table shipping.claims (
  id uuid primary key,
  claim_number text,
  carrier_code text not null,
  order_id uuid not null,
  shipment_id uuid not null,
  exception_id uuid,
  amount int not null,
  currency text not null,
  filed_by text not null,
  seller_id uuid,
  filed_at date,
  status text not null,
  owner text not null,
  evidence_ids jsonb not null,
  approval_request_id uuid,
  paid_amount int,
  decided_at timestamptz,
  note text
);
create index on shipping.claims (status);
create index on shipping.claims (order_id);
create table shipping.webhook_events (
  id uuid primary key,
  carrier_code text not null,
  external_id text not null,
  payload jsonb not null,
  received_at timestamptz not null,
  processed_at timestamptz,
  error text
);
comment on table shipping.webhook_events is 'Raw carrier webhook payloads, deduplicated';
create unique index on shipping.webhook_events (carrier_code, external_id);
alter table shipping.carrier_services add foreign key (carrier_id) references shipping.carriers (id);
alter table shipping.shipment_lines add foreign key (shipment_id) references shipping.shipments (id);
alter table shipping.tracking_events add foreign key (shipment_id) references shipping.shipments (id);
alter table shipping.tracking_corrections add foreign key (shipment_id) references shipping.shipments (id);
alter table shipping.labels add foreign key (shipment_id) references shipping.shipments (id);
alter table shipping.labels add foreign key (carrier_service_id) references shipping.carrier_services (id);
alter table shipping.exception_log add foreign key (exception_id) references shipping.exceptions (id);
alter table shipping.claims add foreign key (shipment_id) references shipping.shipments (id);
alter table shipping.claims add foreign key (exception_id) references shipping.exceptions (id);
`,
};
