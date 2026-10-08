import type { Migration } from '../../../../../kernel/migrations/index.js';

/** Tables, constraints and indexes from docs/api/spec/modules/orders.json (spec "tables"). */
export const m0001Init: Migration = {
  id: '0001_init',
  sql: /* sql */ `
create table orders.orders (
  id uuid primary key,
  ref text not null unique,
  checkout_session_id uuid not null unique,
  customer_id uuid,
  contact_email text not null,
  contact_phone text,
  contact_name text not null,
  channel text not null,
  lifecycle text not null check (lifecycle in ('payment_pending', 'open', 'completed', 'cancelled')),
  display_status text not null,
  flags jsonb not null,
  currency text not null,
  items_total int not null,
  discount_total int not null,
  shipping_total int not null,
  tax_total int not null,
  total int not null,
  delivery_address jsonb not null,
  gift_note text,
  hide_prices bool not null,
  policy_versions jsonb not null,
  coupon_codes jsonb not null,
  payment_intent_id uuid not null,
  payment_state text not null,
  payment_method_label text not null,
  captured_total int not null,
  refunded_total int not null,
  placed_at timestamptz not null,
  accepted_at timestamptz,
  completed_at timestamptz,
  search tsvector
);
comment on table orders.orders is 'One per checkout';
comment on column orders.orders.ref is 'MK-YYMMDD-NNNNN';
comment on column orders.orders.policy_versions is 'AcceptedPolicyVersion[]';
comment on column orders.orders.search is 'ref, contact, product titles, tracking numbers';
create index on orders.orders (customer_id, placed_at desc);
create index on orders.orders ((lower(contact_email))) where customer_id is null;
create index on orders.orders (display_status, placed_at desc);
create index on orders.orders (lifecycle);
create index on orders.orders using gin (search);
create table orders.seller_groups (
  id uuid primary key,
  order_id uuid not null,
  position int not null,
  owner_type text not null,
  seller_id uuid,
  seller_name text not null,
  ships_from text not null,
  fulfilled_by text not null,
  delivery jsonb not null,
  dispatch_by timestamptz not null,
  dispatch_by_history jsonb not null,
  status text not null,
  return_terms_summary text not null,
  items_total int not null,
  discount_total int not null,
  shipping_total int not null,
  tax_total int not null,
  total int not null,
  shipped_at timestamptz,
  delivered_at timestamptz
);
comment on table orders.seller_groups is 'One per seller package; the seller''s fulfillment task';
comment on column orders.seller_groups.delivery is 'DeliveryPromise';
create index on orders.seller_groups (seller_id, status, dispatch_by);
create index on orders.seller_groups (order_id);
create index on orders.seller_groups (status, dispatch_by);
create table orders.order_items (
  id uuid primary key,
  order_id uuid not null,
  group_id uuid not null,
  offer_id uuid not null,
  product_id uuid not null,
  variant_id uuid not null,
  stock_item_id uuid not null,
  product_snapshot jsonb not null,
  offer_snapshot jsonb not null,
  return_terms jsonb not null,
  quantity int not null,
  unit_price int not null,
  discounts jsonb not null,
  shipping_share int not null,
  tax_share int not null,
  paid_amount int not null,
  refunded_amount int not null,
  refund_status text not null,
  state text not null,
  state_before_request text,
  shipment_id uuid,
  return_id uuid,
  return_ref text,
  delivered_at timestamptz,
  return_window_ends_at timestamptz,
  split_from_item_id uuid,
  replacement_of_item_id uuid,
  checkout_line_id text not null
);
comment on table orders.order_items is 'Item lines with state and frozen snapshots; partial actions split lines';
comment on column orders.order_items.product_snapshot is 'catalog.ProductSnapshot';
comment on column orders.order_items.offer_snapshot is 'offers.OfferSnapshot';
create index on orders.order_items (order_id);
create index on orders.order_items (group_id, state);
create index on orders.order_items (offer_id);
create index on orders.order_items (product_id);
create table orders.item_state_log (
  id uuid primary key,
  item_id uuid not null,
  from_state text not null,
  to_state text not null,
  event text not null,
  reason text,
  actor_kind text not null,
  actor_id text,
  at timestamptz not null
);
comment on table orders.item_state_log is 'Every item state change';
create index on orders.item_state_log (item_id, at);
create table orders.cancellations (
  id uuid primary key,
  order_id uuid not null,
  group_id uuid not null,
  initiated_by text not null,
  reason_code text not null,
  reason text,
  items jsonb not null,
  status text not null,
  respond_by timestamptz,
  decided_by jsonb,
  decided_at timestamptz,
  decline_reason text,
  refund_preview jsonb not null,
  refund_status text not null,
  payment_refund_id uuid,
  idempotency_key text,
  created_at timestamptz not null
);
comment on table orders.cancellations is 'Cancellation requests and direct cancellations';
create index on orders.cancellations (group_id, status);
create index on orders.cancellations (status, respond_by);
create unique index on orders.cancellations (order_id, idempotency_key);
create table orders.shipment_refs (
  shipment_id uuid primary key,
  order_id uuid not null,
  group_id uuid not null,
  package_label text not null,
  carrier text,
  service text,
  tracking_number text,
  tracking_url text,
  status text not null,
  estimated_arrival jsonb,
  shipped_at timestamptz,
  delivered_at timestamptz,
  item_ids jsonb not null
);
comment on table orders.shipment_refs is 'Projection of shipping events for display, search by tracking number and flags';
create index on orders.shipment_refs (order_id);
create index on orders.shipment_refs (tracking_number);
create table orders.timeline (
  id uuid primary key,
  order_id uuid not null,
  group_id uuid,
  item_id uuid,
  visibility text not null check (visibility in ('customer', 'seller', 'staff')),
  label text not null,
  detail text,
  reason text,
  actor_kind text not null,
  actor_id text,
  actor_name text,
  at timestamptz not null
);
comment on table orders.timeline is 'Customer-visible events and staff action history';
create index on orders.timeline (order_id, at desc);
create table orders.notes (
  id uuid primary key,
  order_id uuid not null,
  text text not null,
  author_id uuid not null,
  author_name text not null,
  at timestamptz not null
);
comment on table orders.notes is 'Internal staff notes';
create table orders.documents (
  id uuid primary key,
  order_id uuid not null,
  group_id uuid,
  kind text not null,
  number text not null unique,
  issued_at timestamptz not null
);
comment on table orders.documents is 'Issued receipt and invoice numbers; PDFs render from the frozen order on request';
create table orders.saved_filters (
  id uuid primary key,
  owner_staff_id uuid not null,
  name text not null,
  query jsonb not null,
  shared bool not null,
  cached_count int,
  counted_at timestamptz,
  created_at timestamptz not null
);
create table orders.ref_sequences (
  day date primary key,
  last_value int not null
);
comment on table orders.ref_sequences is 'Daily counters for MK-YYMMDD-NNNNN';
alter table orders.seller_groups add foreign key (order_id) references orders.orders (id);
alter table orders.order_items add foreign key (order_id) references orders.orders (id);
alter table orders.order_items add foreign key (group_id) references orders.seller_groups (id);
alter table orders.order_items add foreign key (split_from_item_id) references orders.order_items (id);
alter table orders.order_items add foreign key (replacement_of_item_id) references orders.order_items (id);
alter table orders.item_state_log add foreign key (item_id) references orders.order_items (id);
alter table orders.cancellations add foreign key (order_id) references orders.orders (id);
alter table orders.cancellations add foreign key (group_id) references orders.seller_groups (id);
alter table orders.shipment_refs add foreign key (order_id) references orders.orders (id);
alter table orders.shipment_refs add foreign key (group_id) references orders.seller_groups (id);
alter table orders.timeline add foreign key (order_id) references orders.orders (id);
alter table orders.notes add foreign key (order_id) references orders.orders (id);
alter table orders.documents add foreign key (order_id) references orders.orders (id);
`,
};
