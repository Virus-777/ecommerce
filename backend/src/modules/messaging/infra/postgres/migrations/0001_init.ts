import type { Migration } from '../../../../../kernel/migrations/index.js';

/** Tables, constraints and indexes from docs/api/spec/modules/messaging.json (spec "tables"). */
export const m0001Init: Migration = {
  id: '0001_init',
  sql: /* sql */ `
create table messaging.conversations (
  id uuid primary key,
  kind text not null,
  customer_id uuid,
  guest_session_id text,
  seller_id uuid,
  order_id uuid,
  order_item_id uuid,
  return_id uuid,
  case_id uuid,
  application_id uuid,
  started_by_staff_id uuid,
  subject jsonb not null,
  status text not null,
  locked_reason text,
  reply_state text not null,
  reply_due_at timestamptz,
  awaiting_since timestamptz,
  created_at timestamptz not null,
  last_message_at timestamptz not null,
  archive_after timestamptz
);
create index on messaging.conversations (customer_id, last_message_at desc);
create index on messaging.conversations (seller_id, reply_state, reply_due_at);
create index on messaging.conversations (order_id);
create index on messaging.conversations (case_id);
create unique index on messaging.conversations (customer_id, seller_id, order_id, order_item_id, return_id);
create table messaging.participants (
  conversation_id uuid not null,
  kind text not null,
  participant_id text not null,
  name text not null,
  label text not null,
  joined_at timestamptz not null,
  joined_from_case_id uuid,
  last_read_message_id uuid,
  unread_count int not null
);
create unique index on messaging.participants (conversation_id, kind, participant_id);
create index on messaging.participants (kind, participant_id, unread_count);
create table messaging.messages (
  id uuid primary key,
  conversation_id uuid not null,
  kind text not null,
  author_kind text,
  author_id text,
  author_label text not null,
  body text not null,
  original_body text,
  media_ids jsonb not null,
  redactions jsonb not null,
  hidden bool not null,
  hidden_reason text,
  client_message_id text,
  at timestamptz not null
);
comment on column messaging.messages.original_body is 'staff only, before masking';
create index on messaging.messages (conversation_id, at desc);
create unique index on messaging.messages (conversation_id, author_id, client_message_id);
create table messaging.message_reports (
  id uuid primary key,
  message_id uuid not null,
  conversation_id uuid not null,
  reporter_kind text not null,
  reporter_id text not null,
  reason text not null,
  note text,
  status text not null,
  outcome text,
  decided_by text,
  decided_at timestamptz,
  created_at timestamptz not null
);
create index on messaging.message_reports (status, created_at);
create table messaging.reply_templates (
  id uuid primary key,
  seller_id uuid not null,
  name text not null,
  body text not null,
  updated_at timestamptz not null
);
create index on messaging.reply_templates (seller_id);
create table messaging.staff_access_log (
  id uuid primary key,
  conversation_id uuid not null,
  staff_id uuid not null,
  reason text not null,
  case_id uuid,
  at timestamptz not null
);
comment on table messaging.staff_access_log is 'Each time staff open a private conversation, with the reason';
create index on messaging.staff_access_log (conversation_id, at);
alter table messaging.participants add foreign key (conversation_id) references messaging.conversations (id);
alter table messaging.messages add foreign key (conversation_id) references messaging.conversations (id);
alter table messaging.message_reports add foreign key (message_id) references messaging.messages (id);
alter table messaging.message_reports add foreign key (conversation_id) references messaging.conversations (id);
alter table messaging.staff_access_log add foreign key (conversation_id) references messaging.conversations (id);
`,
};
