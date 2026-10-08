import type { Migration } from '../../../../../kernel/migrations/index.js';

/** Tables, constraints and indexes from docs/api/spec/modules/audit.json (spec "tables"). */
export const m0001Init: Migration = {
  id: '0001_init',
  sql: /* sql */ `
create table audit.entries (
  id uuid primary key,
  seq bigint generated always as identity not null unique,
  at timestamptz not null,
  actor_kind text not null,
  actor_id text,
  actor_name text,
  actor_roles jsonb not null,
  action text not null,
  action_label text not null,
  module text not null,
  category text not null,
  target_type text not null,
  target_id text not null,
  target_ref text,
  target_label text,
  target_screen text,
  seller_id uuid,
  reason text,
  before jsonb,
  after jsonb,
  before_text text,
  after_text text,
  evidence jsonb not null,
  approval_request_id uuid,
  approval_note text,
  request_id text,
  ip inet,
  visible_to_seller bool not null,
  search tsvector,
  prev_hash bytea not null,
  hash bytea not null
);
comment on table audit.entries is 'Append-only (no UPDATE/DELETE grants for the app role). Partitioned by month on at. hash = sha256(prev_hash || canonical row).';
comment on column audit.entries.search is 'generated: refs, labels, reason, names';
create index on audit.entries (at desc, id);
create index on audit.entries (target_type, target_id, at desc);
create index on audit.entries (actor_id, at desc);
create index on audit.entries (category, at desc);
create index on audit.entries (seller_id, at desc) where visible_to_seller;
create index on audit.entries (approval_request_id);
create index on audit.entries using gin (search);
create table audit.entry_targets (
  entry_id uuid not null,
  target_type text not null,
  target_id text not null,
  at timestamptz not null
);
comment on table audit.entry_targets is 'Related targets for history lookups (an order item entry also appears under its order and seller)';
create index on audit.entry_targets (target_type, target_id, at desc);
create table audit.approval_states (
  approval_request_id uuid primary key,
  state text not null,
  approvers jsonb not null,
  steps jsonb not null,
  awaiting text,
  decided_at timestamptz,
  updated_at timestamptz not null
);
comment on table audit.approval_states is 'Projection of access approval requests referenced by entries; updated from access events, so entries stay immutable';
create index on audit.approval_states (state);
create table audit.retention (
  id int primary key check (id = 1),
  retain_years int not null,
  pending_years int,
  pending_reason text,
  pending_approval_request_id uuid,
  pending_requested_by text,
  updated_by text,
  updated_at timestamptz,
  last_purge_at timestamptz,
  last_purge_removed bigint,
  last_purge_through timestamptz
);
comment on table audit.retention is 'Single row';
create table audit.integrity_checks (
  id uuid primary key,
  started_at timestamptz not null,
  finished_at timestamptz,
  from_seq bigint not null,
  to_seq bigint not null,
  ok bool,
  broken_at_seq bigint
);
create index on audit.integrity_checks (started_at desc);
alter table audit.entry_targets add foreign key (entry_id) references audit.entries (id);
`,
};
