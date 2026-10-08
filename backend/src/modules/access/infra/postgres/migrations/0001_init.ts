import type { Migration } from '../../../../../kernel/migrations/index.js';

/** Tables, constraints and indexes from docs/api/spec/modules/access.json (spec "tables"). */
export const m0001Init: Migration = {
  id: '0001_init',
  sql: /* sql */ `
create table access.roles (
  id uuid primary key,
  key text not null unique,
  name text not null,
  kind text not null check (kind in ('owner', 'management', 'task', 'custom')),
  work_area text not null,
  description text,
  system bool not null,
  escalation_role_id uuid,
  archived_at timestamptz,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  version int not null
);
create table access.permissions (
  key text primary key,
  module text not null,
  area text not null,
  label text not null,
  description text not null,
  sensitive bool not null,
  registered_at timestamptz not null,
  unavailable_since timestamptz
);
comment on table access.permissions is 'Registry synced at boot from every enabled module''s manifest';
create index on access.permissions (module);
create table access.role_permissions (
  role_id uuid not null,
  permission_key text not null,
  granted_by text not null,
  granted_at timestamptz not null,
  primary key (role_id, permission_key)
);
create index on access.role_permissions (permission_key);
create table access.role_assignments (
  id uuid primary key,
  account_id uuid not null,
  role_id uuid not null,
  status text not null,
  granted_by_kind text not null,
  granted_by_id text not null,
  reason text not null,
  granted_at timestamptz not null,
  expires_at timestamptz,
  revoked_at timestamptz,
  revoked_by text,
  revoke_reason text,
  approval_request_id uuid
);
create index on access.role_assignments (account_id) where status = 'active';
create index on access.role_assignments (role_id) where status = 'active';
create unique index on access.role_assignments (account_id, role_id) where status in ('active','pending_acceptance','pending_approval');
create table access.role_coverage (
  role_id uuid primary key,
  lead_account_id uuid,
  backup_account_ids jsonb not null,
  updated_by text not null,
  updated_at timestamptz not null
);
comment on table access.role_coverage is 'Lead, ordered backups and escalation per role';
comment on column access.role_coverage.backup_account_ids is 'ordered uuid[]';
create table access.approval_actions (
  key text primary key,
  module text not null,
  label text not null,
  limit_kind text not null check (limit_kind in ('money', 'units', 'percent', 'none')),
  second_reviewer text not null check (second_reviewer in ('always', 'above-limit', 'never')),
  approvers text,
  default_eligible_role_keys jsonb not null,
  unavailable_since timestamptz
);
comment on table access.approval_actions is 'Registry synced at boot from module manifests (\`approvalActions\`)';
create table access.approval_limits (
  id uuid primary key,
  role_id uuid not null,
  action_key text not null,
  authority text not null,
  limit_amount_minor bigint,
  limit_currency text,
  limit_number numeric,
  second_above_amount_minor bigint,
  second_above_number numeric,
  second_reviewer_role_keys jsonb not null,
  effective_from timestamptz not null,
  effective_to timestamptz,
  limit_change_id uuid
);
comment on table access.approval_limits is 'Effective-dated; the row in force has effective_from <= now < effective_to';
create index on access.approval_limits (role_id, action_key, effective_from desc);
create table access.limit_changes (
  id uuid primary key,
  role_id uuid not null,
  changes jsonb not null,
  reason text not null,
  effective_from timestamptz not null,
  status text not null,
  proposed_by_kind text not null,
  proposed_by_id text not null,
  approval_request_id uuid,
  created_at timestamptz not null,
  applied_at timestamptz,
  cancel_reason text
);
create index on access.limit_changes (status, effective_from);
create table access.approval_requests (
  id uuid primary key,
  ref text not null unique,
  action_key text not null,
  module text not null,
  target_type text not null,
  target_id text not null,
  target_ref text,
  target_label text,
  target_screen text,
  seller_id uuid,
  amount_minor bigint,
  currency text,
  quantity numeric,
  summary text not null,
  details jsonb not null,
  reason text not null,
  requested_by_kind text not null,
  requested_by_id text not null,
  requester_roles jsonb not null,
  requester_counts_as_first bool not null,
  required_approvals int not null,
  status text not null,
  eligible_role_keys jsonb not null,
  nominated_reviewer_id uuid,
  limit_snapshot jsonb not null,
  due_at timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null,
  decided_at timestamptz,
  outcome_reason text,
  last_reminded_at timestamptz,
  version int not null
);
create index on access.approval_requests (status, created_at);
create index on access.approval_requests (module, target_type, target_id);
create index on access.approval_requests (requested_by_id, status);
create unique index on access.approval_requests (action_key, target_type, target_id) where status in ('pending','partially_approved','returned');
create table access.approval_decisions (
  id uuid primary key,
  request_id uuid not null,
  step int not null,
  decision text not null,
  by_account_id uuid not null,
  roles jsonb not null,
  note text,
  via_delegation_from uuid,
  at timestamptz not null
);
create index on access.approval_decisions (request_id, step);
create unique index on access.approval_decisions (request_id, by_account_id) where decision = 'approved';
create table access.away_periods (
  id uuid primary key,
  account_id uuid not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status text not null,
  delegate_approvals bool not null,
  reason text,
  approval_request_id uuid,
  created_by_kind text not null,
  created_by_id text not null,
  created_at timestamptz not null,
  ended_at timestamptz
);
create index on access.away_periods (account_id, starts_at);
create index on access.away_periods (status, starts_at);
create index on access.away_periods (status, ends_at);
create table access.away_coverage (
  away_period_id uuid not null,
  role_id uuid not null,
  covered_by_account_id uuid not null,
  primary key (away_period_id, role_id)
);
create index on access.away_coverage (covered_by_account_id);
alter table access.roles add foreign key (escalation_role_id) references access.roles (id);
alter table access.role_permissions add foreign key (role_id) references access.roles (id);
alter table access.role_permissions add foreign key (permission_key) references access.permissions (key);
alter table access.role_assignments add foreign key (role_id) references access.roles (id);
alter table access.role_assignments add foreign key (approval_request_id) references access.approval_requests (id);
alter table access.role_coverage add foreign key (role_id) references access.roles (id);
alter table access.approval_limits add foreign key (role_id) references access.roles (id);
alter table access.approval_limits add foreign key (action_key) references access.approval_actions (key);
alter table access.approval_limits add foreign key (limit_change_id) references access.limit_changes (id);
alter table access.limit_changes add foreign key (role_id) references access.roles (id);
alter table access.limit_changes add foreign key (approval_request_id) references access.approval_requests (id);
alter table access.approval_decisions add foreign key (request_id) references access.approval_requests (id);
alter table access.away_periods add foreign key (approval_request_id) references access.approval_requests (id);
alter table access.away_coverage add foreign key (away_period_id) references access.away_periods (id);
alter table access.away_coverage add foreign key (role_id) references access.roles (id);
`,
};
