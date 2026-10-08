import type { Migration } from '../../../../../kernel/migrations/index.js';

/** Tables, constraints and indexes from docs/api/spec/modules/trust.json (spec "tables"). */
export const m0001Init: Migration = {
  id: '0001_init',
  sql: /* sql */ `
create table trust.reports (
  id uuid primary key,
  ref text not null unique,
  type text not null,
  title text not null,
  description text not null,
  source text not null,
  reporter_kind text not null,
  reporter_id text,
  reporter_name text,
  reporter_contact text,
  reporter_count int not null,
  detector text,
  dedupe_key text,
  status text not null,
  risk_score int not null,
  risk_factors jsonb not null,
  risk_override jsonb,
  assignee_staff_id uuid,
  due_at timestamptz,
  resolution jsonb,
  reporter_outcome text,
  assessment jsonb,
  merged_into_id uuid,
  created_at timestamptz not null,
  updated_at timestamptz not null
);
create index on trust.reports (status, risk_score desc);
create index on trust.reports (type, status);
create index on trust.reports (assignee_staff_id, status);
create unique index on trust.reports (dedupe_key) where status in ('open','under_review','escalated');
create index on trust.reports (reporter_kind, reporter_id, created_at desc);
create table trust.report_subjects (
  report_id uuid not null,
  subject_type text not null,
  subject_id uuid not null,
  ref text,
  label text not null
);
create index on trust.report_subjects (subject_type, subject_id);
create unique index on trust.report_subjects (report_id, subject_type, subject_id);
create table trust.evidence (
  id uuid primary key,
  report_id uuid not null,
  kind text not null,
  result text,
  text text not null,
  media_ids jsonb not null,
  source text not null,
  visibility text not null,
  added_by_kind text not null,
  added_by_id text,
  added_at timestamptz not null
);
create index on trust.evidence (report_id, added_at);
create table trust.evidence_requests (
  id uuid primary key,
  report_id uuid not null,
  to_type text not null,
  to_id uuid not null,
  question text not null,
  due_at timestamptz not null,
  state text not null,
  answer text,
  answer_media_ids jsonb not null,
  answered_at timestamptz
);
create index on trust.evidence_requests (to_type, to_id, state);
create index on trust.evidence_requests (state, due_at);
create table trust.recommendations (
  id uuid primary key,
  report_id uuid not null,
  action text not null,
  label text not null,
  owner_team text not null,
  owner_role text not null,
  owner_staff_id uuid,
  targets jsonb not null,
  params jsonb not null,
  rationale text not null,
  state text not null,
  routed_at timestamptz,
  decided_at timestamptz,
  decided_by text,
  decision_reason text,
  enforcement_id uuid
);
create index on trust.recommendations (owner_team, state);
create index on trust.recommendations (report_id);
create table trust.enforcements (
  id uuid primary key,
  ref text not null unique,
  report_id uuid not null,
  recommendation_id uuid,
  action text not null,
  owner_team text not null,
  targets jsonb not null,
  reason text not null,
  params jsonb not null,
  effects jsonb not null,
  recorded_by text not null,
  recorded_at timestamptz not null,
  execution_state text not null,
  applied_ref text,
  applied_at timestamptz,
  failure text,
  appealable bool not null,
  appeal_deadline timestamptz,
  reversed_at timestamptz,
  reversal_reason text
);
create index on trust.enforcements (execution_state);
create index on trust.enforcements (owner_team, recorded_at desc);
create table trust.enforcement_targets (
  enforcement_id uuid not null,
  target_type text not null,
  target_id uuid not null
);
comment on table trust.enforcement_targets is 'Lookup of active enforcement by target';
create index on trust.enforcement_targets (target_type, target_id);
create table trust.appeals (
  id uuid primary key,
  ref text not null unique,
  source text not null check (source in ('trust', 'sellers')),
  external_appeal_id uuid,
  report_id uuid,
  enforcement_id uuid,
  appellant_kind text not null,
  appellant_id text not null,
  appellant_name text not null,
  decision_appealed text not null,
  argument text not null,
  evidence_media_ids jsonb not null,
  reviewer_staff_id uuid,
  original_decider_id text not null,
  decide_by timestamptz not null,
  state text not null,
  decision jsonb,
  filed_at timestamptz not null
);
create index on trust.appeals (state, decide_by);
create unique index on trust.appeals (source, external_appeal_id) where external_appeal_id is not null;
create index on trust.appeals (appellant_kind, appellant_id);
create table trust.report_notes (
  id uuid primary key,
  report_id uuid not null,
  body text not null,
  author_id text not null,
  author_name text not null,
  at timestamptz not null
);
create table trust.report_events (
  id uuid primary key,
  report_id uuid not null,
  kind text not null,
  detail jsonb not null,
  actor_kind text not null,
  actor_id text,
  at timestamptz not null
);
comment on table trust.report_events is 'Timeline: created, merged, assigned, escalated, evidence added, recommendation routed and decided, enforcement applied, resolved';
create index on trust.report_events (report_id, at);
create table trust.detection_rules (
  key text primary key,
  description text not null,
  type text not null,
  active bool not null,
  thresholds jsonb not null,
  base_score int not null,
  updated_by text not null,
  updated_at timestamptz not null,
  last_run_at timestamptz
);
create table trust.risk_signals (
  id uuid primary key,
  kind text not null,
  subject_type text not null,
  subject_id uuid not null,
  features jsonb not null,
  at timestamptz not null
);
comment on table trust.risk_signals is 'Raw signals from events used by detection rules (sliding windows)';
create index on trust.risk_signals (kind, at);
create index on trust.risk_signals (subject_type, subject_id, at);
alter table trust.reports add foreign key (merged_into_id) references trust.reports (id);
alter table trust.report_subjects add foreign key (report_id) references trust.reports (id);
alter table trust.evidence add foreign key (report_id) references trust.reports (id);
alter table trust.evidence_requests add foreign key (report_id) references trust.reports (id);
alter table trust.recommendations add foreign key (report_id) references trust.reports (id);
alter table trust.enforcements add foreign key (report_id) references trust.reports (id);
alter table trust.enforcements add foreign key (recommendation_id) references trust.recommendations (id);
alter table trust.enforcement_targets add foreign key (enforcement_id) references trust.enforcements (id);
alter table trust.appeals add foreign key (report_id) references trust.reports (id);
alter table trust.appeals add foreign key (enforcement_id) references trust.enforcements (id);
alter table trust.report_notes add foreign key (report_id) references trust.reports (id);
alter table trust.report_events add foreign key (report_id) references trust.reports (id);
`,
};
