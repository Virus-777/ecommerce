import type { Migration } from '../../../../../kernel/migrations/index.js';

/** Tables, constraints and indexes from docs/api/spec/modules/notifications.json (spec "tables"). */
export const m0001Init: Migration = {
  id: '0001_init',
  sql: /* sql */ `
create table notifications.topics (
  key text primary key,
  audience text not null,
  category text not null,
  group_key text not null,
  label text not null,
  description text not null,
  triggers jsonb not null,
  opens text not null,
  channels jsonb not null,
  action_required bool not null,
  staff_role_keys jsonb not null,
  seller_permission text,
  owner_only bool not null,
  frequency_label text,
  variables jsonb not null,
  phase int not null,
  updated_by text,
  updated_at timestamptz
);
comment on table notifications.topics is 'Topic catalogue seeded from module code; staff toggle channels';
comment on column notifications.topics.channels is 'channel → enabled';
create table notifications.templates (
  id uuid primary key,
  topic_key text not null,
  channel text not null,
  language text not null,
  live_version_id uuid,
  updated_at timestamptz not null
);
create unique index on notifications.templates (topic_key, channel, language);
create table notifications.template_versions (
  id uuid primary key,
  template_id uuid not null,
  version int not null,
  status text not null,
  content jsonb not null,
  note text,
  created_by text not null,
  created_at timestamptz not null,
  published_by text,
  published_at timestamptz
);
create unique index on notifications.template_versions (template_id, version);
create index on notifications.template_versions (template_id) where status = 'draft';
create table notifications.notices (
  id uuid primary key,
  topic_key text not null,
  audience text not null,
  address_kind text not null check (address_kind in ('customer', 'seller', 'role', 'staff')),
  address_id text not null,
  seller_id uuid,
  group_key text not null,
  title text not null,
  body text not null,
  icon text,
  tone text not null,
  link jsonb not null,
  linked_ref text,
  action_required bool not null,
  deadline_at timestamptz,
  dedupe_key text,
  resolved_at timestamptz,
  resolve_note text,
  created_at timestamptz not null,
  expires_at timestamptz not null
);
comment on table notifications.notices is 'In-app notices (one per addressed audience: a customer, a seller workspace, a staff role or member)';
create index on notifications.notices (address_kind, address_id, created_at desc);
create index on notifications.notices (dedupe_key);
create index on notifications.notices (expires_at);
create table notifications.notice_recipients (
  notice_id uuid not null,
  account_id uuid not null,
  reason text not null,
  covering_for text,
  read_at timestamptz,
  created_at timestamptz not null,
  primary key (notice_id, account_id)
);
comment on table notifications.notice_recipients is 'Fan-out with per-person read state (seller members, staff lead/backup)';
create index on notifications.notice_recipients (account_id, read_at, created_at desc);
create table notifications.scheduled_notifications (
  id uuid primary key,
  dedupe_key text not null,
  send_at timestamptz not null,
  input jsonb not null,
  status text not null check (status in ('pending', 'sent', 'cancelled')),
  created_by_module text not null,
  created_at timestamptz not null
);
create index on notifications.scheduled_notifications (status, send_at);
create index on notifications.scheduled_notifications (dedupe_key);
create table notifications.deliveries (
  id uuid primary key,
  notice_id uuid,
  topic_key text not null,
  channel text not null,
  recipient_kind text not null,
  account_id uuid,
  address_hash text not null,
  address_masked text not null,
  status text not null,
  skip_reason text,
  attempts int not null,
  last_error text,
  provider_message_id text,
  template_version_id uuid,
  subject text,
  linked_ref text,
  dedupe_key text,
  broadcast_id uuid,
  created_at timestamptz not null,
  sent_at timestamptz,
  delivered_at timestamptz,
  next_attempt_at timestamptz
);
create index on notifications.deliveries (status, next_attempt_at);
create index on notifications.deliveries (provider_message_id);
create index on notifications.deliveries (account_id, created_at desc);
create index on notifications.deliveries (address_hash, created_at desc);
create index on notifications.deliveries (topic_key, created_at desc);
create index on notifications.deliveries (linked_ref);
create table notifications.delivery_events (
  id uuid primary key,
  delivery_id uuid not null,
  type text not null,
  provider_event_id text unique,
  detail text,
  at timestamptz not null
);
create index on notifications.delivery_events (delivery_id, at);
create table notifications.member_preferences (
  seller_id uuid not null,
  member_id uuid not null,
  account_id uuid not null,
  groups jsonb not null,
  channel text not null,
  updated_by text not null,
  updated_at timestamptz not null,
  primary key (seller_id, member_id)
);
comment on table notifications.member_preferences is 'Seller member preferences, set by the owner or the member';
create index on notifications.member_preferences (account_id);
create table notifications.staff_preferences (
  account_id uuid primary key,
  email_by_area jsonb not null,
  email_for_mentions bool not null,
  daily_digest bool not null,
  updated_at timestamptz not null
);
create table notifications.push_devices (
  id uuid primary key,
  account_id uuid not null,
  audience text not null check (audience in ('customer', 'seller')),
  seller_id uuid,
  platform text not null,
  token_encrypted bytea not null,
  token_hash text not null unique,
  app_version text not null,
  installation_id text,
  enabled bool not null,
  created_at timestamptz not null,
  last_seen_at timestamptz not null,
  invalidated_at timestamptz
);
create index on notifications.push_devices (account_id) where invalidated_at is null;
create table notifications.suppressions (
  id uuid primary key,
  channel text not null,
  address_hash text not null,
  address_masked text not null,
  account_id uuid,
  reason text not null,
  source text not null,
  created_at timestamptz not null,
  removed_at timestamptz,
  removed_by text,
  remove_reason text
);
create unique index on notifications.suppressions (channel, address_hash) where removed_at is null;
create index on notifications.suppressions (account_id);
create table notifications.broadcasts (
  id uuid primary key,
  name text not null,
  audience text not null,
  topic_key text not null,
  template_version_id uuid not null,
  segment jsonb not null,
  status text not null,
  scheduled_at timestamptz,
  sent_at timestamptz,
  recipient_estimate int not null,
  stats jsonb not null,
  campaign_id uuid,
  created_by text not null,
  created_at timestamptz not null
);
create index on notifications.broadcasts (status, scheduled_at);
alter table notifications.templates add foreign key (topic_key) references notifications.topics (key);
alter table notifications.templates add foreign key (live_version_id) references notifications.template_versions (id);
alter table notifications.template_versions add foreign key (template_id) references notifications.templates (id);
alter table notifications.notice_recipients add foreign key (notice_id) references notifications.notices (id);
alter table notifications.deliveries add foreign key (notice_id) references notifications.notices (id);
alter table notifications.delivery_events add foreign key (delivery_id) references notifications.deliveries (id);
alter table notifications.broadcasts add foreign key (template_version_id) references notifications.template_versions (id);
`,
};
