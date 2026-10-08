import type { Migration } from '../../../../../kernel/migrations/index.js';

/** Tables, constraints and indexes from docs/api/spec/modules/returns.json (spec "tables"). */
export const m0001Init: Migration = {
  id: '0001_init',
  sql: /* sql */ `
create table returns.policy_versions (
  id uuid primary key,
  version text not null,
  status text not null,
  window_days int not null,
  seller_response_business_days int not null,
  info_reply_days int not null,
  drop_off_days int not null,
  inspection_target_business_days int not null,
  refund_target_business_days int not null,
  responsibilities jsonb not null,
  effective_from timestamptz,
  change_reason text,
  approval_request_id uuid,
  created_by text not null,
  created_at timestamptz not null
);
comment on table returns.policy_versions is 'Platform baseline versions with effective dates; orders keep the version accepted at purchase';
create index on returns.policy_versions (status, effective_from);
create table returns.category_exceptions (
  id uuid primary key,
  category_id uuid not null,
  window_days int,
  change_of_mind_allowed bool not null,
  condition text not null,
  fault_returns_window_days int not null,
  shown_on jsonb not null,
  effective_from timestamptz not null,
  effective_to timestamptz,
  apply_scope text not null,
  status text not null,
  approval_request_id uuid,
  reason text not null,
  created_by text not null,
  created_at timestamptz not null
);
create index on returns.category_exceptions (category_id, effective_from);
create table returns.seller_terms (
  id uuid primary key,
  seller_id uuid not null,
  version int not null,
  window_days int not null,
  change_of_mind_paid_by text not null,
  free_returns bool not null,
  remedies jsonb not null,
  return_address jsonb not null,
  return_contact_email text,
  receiving_hours text,
  response_target_business_days int not null,
  refund_target_days int not null,
  effective_from timestamptz not null,
  superseded_at timestamptz,
  created_by text not null
);
comment on table returns.seller_terms is 'Seller return terms, one active version per seller; validated against the baseline';
create index on returns.seller_terms (seller_id, effective_from desc);
create table returns.returns (
  id uuid primary key,
  ref text not null unique,
  order_id uuid not null,
  order_ref text not null,
  customer_id uuid,
  guest_session_id text,
  owner_type text not null check (owner_type in ('official', 'seller')),
  seller_id uuid,
  status text not null,
  reason text not null,
  details text not null,
  media_ids jsonb not null,
  remedy text not null,
  exchange_variant_id uuid,
  handled_by text not null,
  terms_snapshot jsonb not null,
  shipping_paid_by text not null,
  response_due_at timestamptz,
  info_request jsonb,
  decision jsonb,
  platform_handling bool not null,
  escalation jsonb,
  owner_staff_id uuid,
  case_id uuid,
  conversation_id uuid,
  exception jsonb,
  inspector jsonb,
  inspection_started_at timestamptz,
  requested_at timestamptz not null,
  completed_at timestamptz,
  updated_at timestamptz not null
);
comment on table returns.returns is 'One return per seller per request. Terms snapshot copied from the order item.';
create index on returns.returns (seller_id, status, response_due_at);
create index on returns.returns (customer_id, requested_at desc);
create index on returns.returns (order_id);
create index on returns.returns (status, response_due_at);
create index on returns.returns (owner_staff_id, status);
create table returns.return_items (
  id uuid primary key,
  return_id uuid not null,
  order_item_id uuid not null,
  product_id uuid not null,
  variant_id uuid not null,
  title text not null,
  options jsonb not null,
  sku text,
  quantity int not null,
  unit_price bigint not null,
  currency text not null
);
create index on returns.return_items (order_item_id);
create table returns.return_shipments (
  id uuid primary key,
  return_id uuid not null,
  status text not null,
  method text not null,
  carrier text,
  service text,
  tracking_number text,
  label_url text,
  qr_code_url text,
  drop_off_by timestamptz,
  from_address jsonb,
  to_address jsonb not null,
  cost bigint,
  paid_by text not null,
  shipping_shipment_id uuid,
  created_at timestamptz not null,
  delivered_at timestamptz
);
comment on table returns.return_shipments is 'Return parcels, separate from the original delivery';
create index on returns.return_shipments (return_id);
create index on returns.return_shipments (tracking_number);
create index on returns.return_shipments (status, drop_off_by);
create table returns.inspection_drafts (
  return_id uuid primary key,
  inspection jsonb not null,
  remedy jsonb,
  saved_by jsonb not null,
  saved_at timestamptz not null
);
comment on table returns.inspection_drafts is 'One unsent inspection and remedy draft per return';
create table returns.return_evidence (
  id uuid primary key,
  return_id uuid not null,
  kind text not null,
  media_ids jsonb not null,
  note text,
  party text not null,
  added_by jsonb not null,
  added_at timestamptz not null,
  case_id uuid
);
comment on table returns.return_evidence is 'Evidence added to a return before a support case exists';
create index on returns.return_evidence (return_id, added_at);
create table returns.inspections (
  id uuid primary key,
  return_id uuid not null,
  inspected_by text not null,
  inspected_at timestamptz not null,
  condition_outcome text not null,
  grade text not null,
  checks jsonb not null,
  missing_parts jsonb not null,
  notes text,
  media_ids jsonb not null,
  proposed_stock_outcome text not null,
  regrade_condition text,
  stock_outcome_recorded_by text,
  stock_outcome_recorded_at timestamptz
);
create index on returns.inspections (return_id);
create table returns.refund_requests (
  id uuid primary key,
  ref text not null unique,
  source text not null,
  return_id uuid,
  case_id uuid,
  order_id uuid not null,
  order_item_ids jsonb not null,
  owner_type text not null check (owner_type in ('official', 'seller')),
  seller_id uuid,
  status text not null,
  item_amount bigint not null,
  discount_share bigint not null,
  shipping_refund bigint not null,
  return_shipping_deduction bigint not null,
  deductions jsonb not null,
  total bigint not null,
  currency text not null,
  funded_by text not null,
  seller_share bigint,
  platform_share bigint,
  reason_code text,
  reason text,
  trust_report_id uuid,
  approval_request_id uuid,
  proposed_by text not null,
  approved_by text,
  decline_reason text,
  payment_refund_id uuid,
  failed_reason text,
  idempotency_key text unique,
  created_at timestamptz not null,
  updated_at timestamptz not null
);
comment on table returns.refund_requests is 'Customer refund decisions waiting for or past Finance approval. Money movement is in payments.';
create index on returns.refund_requests (status, created_at);
create index on returns.refund_requests (order_id);
create index on returns.refund_requests (return_id);
create index on returns.refund_requests (case_id);
create table returns.replacements (
  id uuid primary key,
  return_id uuid not null,
  kind text not null,
  status text not null,
  order_item_id uuid not null,
  variant_id uuid not null,
  offer_id uuid not null,
  quantity int not null,
  reservation_id uuid,
  shipping_shipment_id uuid,
  cancel_reason text,
  created_at timestamptz not null,
  shipped_at timestamptz,
  delivered_at timestamptz
);
comment on table returns.replacements is 'Replacement or exchange units with their own shipment; the original order is not changed';
create index on returns.replacements (return_id);
create index on returns.replacements (status);
create table returns.return_events (
  id uuid primary key,
  return_id uuid not null,
  kind text not null,
  label text not null,
  detail text,
  visibility text not null check (visibility in ('customer', 'seller', 'staff')),
  actor_kind text not null,
  actor_id text,
  at timestamptz not null
);
comment on table returns.return_events is 'Timeline and action history per return (who, what, reason)';
create index on returns.return_events (return_id, at);
alter table returns.return_items add foreign key (return_id) references returns.returns (id);
alter table returns.return_shipments add foreign key (return_id) references returns.returns (id);
alter table returns.inspection_drafts add foreign key (return_id) references returns.returns (id);
alter table returns.return_evidence add foreign key (return_id) references returns.returns (id);
alter table returns.inspections add foreign key (return_id) references returns.returns (id);
alter table returns.refund_requests add foreign key (return_id) references returns.returns (id);
alter table returns.replacements add foreign key (return_id) references returns.returns (id);
alter table returns.return_events add foreign key (return_id) references returns.returns (id);
`,
};
