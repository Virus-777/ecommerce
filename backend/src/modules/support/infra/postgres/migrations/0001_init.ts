import type { Migration } from '../../../../../kernel/migrations/index.js';

/** Tables, constraints and indexes from docs/api/spec/modules/support.json (spec "tables"). */
export const m0001Init: Migration = {
  id: '0001_init',
  sql: /* sql */ `
create table support.case_categories (
  key text primary key,
  label text not null,
  audience text not null,
  group_key text not null,
  default_priority text not null,
  team text not null,
  seller_handles_first bool not null,
  first_response_business_hours int not null,
  next_response_business_hours int not null,
  resolution_business_days int not null,
  active bool not null,
  updated_by text not null,
  updated_at timestamptz not null
);
comment on table support.case_categories is 'Categories with default priority, team and SLA targets';
create table support.cases (
  id uuid primary key,
  ref text not null unique,
  kind text not null,
  category_key text not null,
  priority text not null,
  status text not null,
  subject text not null,
  customer_id uuid,
  guest_session_id text,
  seller_id uuid,
  order_id uuid,
  return_id uuid,
  handler_kind text not null,
  owner_staff_id uuid,
  team text not null,
  support_following bool not null,
  next_action jsonb not null,
  first_response_due_at timestamptz,
  next_response_due_at timestamptz,
  resolution_due_at timestamptz,
  waiting_on text,
  reply_channel text,
  decision jsonb,
  decision_draft jsonb,
  appeal_deadline timestamptz,
  reopen_until timestamptz,
  reopen_count int not null,
  opened_by text not null,
  opened_at timestamptz not null,
  first_replied_at timestamptz,
  resolved_at timestamptz,
  closed_at timestamptz,
  updated_at timestamptz not null
);
create index on support.cases (status, next_response_due_at);
create index on support.cases (owner_staff_id, status);
create index on support.cases (customer_id, opened_at desc);
create index on support.cases (seller_id, status);
create index on support.cases (order_id);
create index on support.cases (kind, status);
create table support.case_items (
  case_id uuid not null,
  order_item_id uuid not null,
  snapshot jsonb not null
);
create unique index on support.case_items (case_id, order_item_id);
create index on support.case_items (order_item_id);
create table support.case_messages (
  id uuid primary key,
  case_id uuid not null,
  author_kind text not null,
  author_id text,
  author_label text not null,
  role text not null,
  audience text not null,
  body text not null,
  media_ids jsonb not null,
  at timestamptz not null
);
comment on table support.case_messages is 'The formal case thread; audience controls who sees each message';
create index on support.case_messages (case_id, at);
create table support.case_evidence (
  id uuid primary key,
  case_id uuid not null,
  party text not null,
  kind text not null,
  media_ids jsonb not null,
  note text,
  added_by text not null,
  at timestamptz not null
);
create index on support.case_evidence (case_id);
create table support.case_offers (
  id uuid primary key,
  case_id uuid not null,
  from_party text not null,
  kind text not null,
  amount bigint,
  currency text,
  ship_by date,
  note text,
  status text not null,
  respond_by timestamptz,
  created_at timestamptz not null,
  responded_at timestamptz
);
create index on support.case_offers (case_id);
create index on support.case_offers (status, respond_by);
create table support.case_remedies (
  id uuid primary key,
  case_id uuid not null,
  kind text not null,
  amount bigint,
  currency text,
  charged_to text,
  order_item_ids jsonb not null,
  status text not null,
  refund_request_id uuid,
  replacement_id uuid,
  due_at timestamptz,
  note text,
  created_by text not null,
  created_at timestamptz not null,
  updated_at timestamptz not null
);
comment on table support.case_remedies is 'Promised remedies; the case cannot be resolved until all are completed, failed-and-handled or cancelled';
create index on support.case_remedies (case_id);
create index on support.case_remedies (refund_request_id);
create index on support.case_remedies (status);
create table support.case_appeals (
  id uuid primary key,
  case_id uuid not null,
  by_kind text not null,
  by_id text not null,
  reason text not null,
  media_ids jsonb not null,
  status text not null,
  reviewer_staff_id uuid,
  submitted_at timestamptz not null,
  decided_at timestamptz,
  outcome text
);
create index on support.case_appeals (case_id);
create index on support.case_appeals (status);
create table support.case_events (
  id uuid primary key,
  case_id uuid not null,
  kind text not null,
  label text not null,
  detail text,
  visibility text not null check (visibility in ('customer', 'seller', 'all', 'staff')),
  actor_kind text not null,
  actor_id text,
  reason text,
  at timestamptz not null
);
comment on table support.case_events is 'Timeline and action history (assignments, escalations, status changes, deadlines)';
create index on support.case_events (case_id, at);
alter table support.cases add foreign key (category_key) references support.case_categories (key);
alter table support.case_items add foreign key (case_id) references support.cases (id);
alter table support.case_messages add foreign key (case_id) references support.cases (id);
alter table support.case_evidence add foreign key (case_id) references support.cases (id);
alter table support.case_offers add foreign key (case_id) references support.cases (id);
alter table support.case_remedies add foreign key (case_id) references support.cases (id);
alter table support.case_appeals add foreign key (case_id) references support.cases (id);
alter table support.case_events add foreign key (case_id) references support.cases (id);
`,
};
