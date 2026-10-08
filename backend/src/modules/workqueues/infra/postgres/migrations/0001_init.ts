import type { Migration } from '../../../../../kernel/migrations/index.js';

/** Tables, constraints and indexes from docs/api/spec/modules/workqueues.json (spec "tables"). */
export const m0001Init: Migration = {
  id: '0001_init',
  sql: /* sql */ `
create table workqueues.queues (
  key text primary key,
  name text not null,
  area text not null,
  owner_role text not null,
  lead_staff_id uuid not null,
  backup_staff_id uuid not null,
  escalation_route jsonb not null,
  escalation_label text not null,
  default_deadline_minutes int not null,
  business_hours_only bool not null,
  screen text not null,
  screen_filter text,
  visible_to_seller bool not null,
  active bool not null,
  updated_by text not null,
  updated_at timestamptz not null
);
create table workqueues.intake_rules (
  id uuid primary key,
  event text not null,
  queue_key text not null,
  kind text not null,
  title_template text not null,
  dedupe_key_template text not null,
  deadline_rule text not null,
  priority text not null,
  resolves_on jsonb not null,
  active bool not null
);
comment on table workqueues.intake_rules is 'Event → queue mapping, seeded per module and editable only by migration or admin with reason';
create index on workqueues.intake_rules (event) where active;
create table workqueues.items (
  id uuid primary key,
  ref text not null unique,
  queue_key text not null,
  kind text not null,
  title text not null,
  summary text,
  subject_type text not null,
  subject_id text not null,
  subject_ref text,
  subject_label text,
  related_subjects jsonb not null,
  seller_id uuid,
  seller_name text,
  customer_id uuid,
  amount_minor bigint,
  currency text,
  owner_role text not null,
  assignee_staff_id uuid,
  due_at timestamptz not null,
  deadline_state text not null check (deadline_state in ('on_time', 'due_soon', 'overdue')),
  priority text not null,
  state text not null,
  waiting_on text,
  escalation_level int not null,
  escalated_to text,
  dedupe_key text not null,
  source_module text not null,
  source_event text,
  links jsonb not null,
  visible_to_seller bool not null,
  opened_at timestamptz not null,
  updated_at timestamptz not null,
  resolved_at timestamptz,
  resolution jsonb
);
comment on column workqueues.items.related_subjects is 'WorkSubject[]';
create unique index on workqueues.items (dedupe_key) where state not in ('resolved','dismissed');
create index on workqueues.items (queue_key, state, due_at);
create index on workqueues.items (assignee_staff_id, state);
create index on workqueues.items (deadline_state, due_at) where state not in ('resolved','dismissed');
create index on workqueues.items (seller_id, state) where visible_to_seller;
create index on workqueues.items (subject_type, subject_id);
create table workqueues.item_events (
  id uuid primary key,
  item_id uuid not null,
  kind text not null,
  detail jsonb not null,
  actor_kind text not null,
  actor_id text,
  at timestamptz not null
);
comment on table workqueues.item_events is 'History: raised, refreshed, assigned, state changes, escalations, notes';
create index on workqueues.item_events (item_id, at);
create table workqueues.item_notes (
  id uuid primary key,
  item_id uuid not null,
  body text not null,
  author_id text not null,
  author_name text not null,
  at timestamptz not null
);
create table workqueues.saved_filters (
  id uuid primary key,
  owner_staff_id uuid not null,
  name text not null,
  shared bool not null,
  target text not null,
  screen text,
  screen_state text,
  filters jsonb not null,
  created_at timestamptz not null
);
create index on workqueues.saved_filters (owner_staff_id);
create index on workqueues.saved_filters (shared) where shared;
create table workqueues.day_end_reviews (
  id uuid primary key,
  date date not null unique,
  due_at timestamptz not null,
  state text not null,
  shared_with_roles jsonb not null,
  items jsonb not null,
  completed_by text,
  completed_at timestamptz,
  summary_sent_to jsonb not null
);
create table workqueues.routine_templates (
  id uuid primary key,
  title text not null,
  area_label text not null,
  owner_roles jsonb not null,
  due_time text not null,
  weekdays jsonb not null,
  active bool not null
);
create table workqueues.routine_checks (
  id uuid primary key,
  template_id uuid not null,
  date date not null,
  owner_staff_id uuid not null,
  due_at timestamptz not null,
  state text not null,
  done_at timestamptz,
  done_by text,
  note text,
  check_ins jsonb not null
);
create unique index on workqueues.routine_checks (template_id, date);
create index on workqueues.routine_checks (date, state);
create table workqueues.daily_counts (
  queue_key text not null,
  date date not null,
  open int not null,
  overdue int not null,
  opened int not null,
  resolved int not null,
  median_resolve_minutes int
);
comment on table workqueues.daily_counts is 'End-of-day snapshot per queue for ''more than yesterday'' deltas and trend reports';
create unique index on workqueues.daily_counts (queue_key, date);
alter table workqueues.intake_rules add foreign key (queue_key) references workqueues.queues (key);
alter table workqueues.items add foreign key (queue_key) references workqueues.queues (key);
alter table workqueues.item_events add foreign key (item_id) references workqueues.items (id);
alter table workqueues.item_notes add foreign key (item_id) references workqueues.items (id);
alter table workqueues.routine_checks add foreign key (template_id) references workqueues.routine_templates (id);
`,
};
