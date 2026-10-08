import type { Migration } from '../../../../../kernel/migrations/index.js';

/** Tables, constraints and indexes from docs/api/spec/modules/sellers.json (spec "tables"). */
export const m0001Init: Migration = {
  id: '0001_init',
  sql: /* sql */ `
create table sellers.sellers (
  id uuid primary key,
  ref text not null unique,
  slug text not null unique,
  store_name text not null,
  legal_name text not null,
  seller_type text not null,
  business_type text not null,
  state_of_registration text,
  registry_number text,
  tax_id_type text not null,
  tax_id_encrypted bytea not null,
  tax_id_last4 text not null,
  business_address jsonb not null,
  phone text not null,
  website text,
  contact jsonb not null,
  market text not null,
  status text not null,
  status_since timestamptz not null,
  closed_reason text,
  verification_state text not null,
  verification_checked jsonb not null,
  verified_at timestamptz,
  verification_expires_at timestamptz,
  launch_review jsonb not null,
  payout_readiness text not null,
  payout_destination_label text,
  account_manager_id uuid,
  application_id uuid,
  approved_at timestamptz,
  created_at timestamptz not null,
  updated_at timestamptz not null
);
comment on table sellers.sellers is 'One row per seller account, created when an application is submitted. The Official Store is not a seller row: other modules use ownerType official with sellerId null';
create index on sellers.sellers (status, id);
create index on sellers.sellers (verification_state);
create index on sellers.sellers using gin ((to_tsvector('simple', store_name || ' ' || legal_name)));
create table sellers.applications (
  id uuid primary key,
  ref text not null unique,
  applicant_account_id uuid not null,
  seller_id uuid,
  invitation_id uuid,
  state text not null,
  current_step text not null,
  completed_steps jsonb not null,
  account jsonb not null,
  business jsonb not null,
  verification jsonb not null,
  payout jsonb not null,
  return_address jsonb not null,
  decision jsonb,
  reviewer_id uuid,
  submitted_at timestamptz,
  decision_target_at timestamptz,
  can_reapply_from date,
  draft_saved_at timestamptz not null,
  created_at timestamptz not null
);
comment on column sellers.applications.verification is 'tax id encrypted separately';
comment on column sellers.applications.payout is 'holder, type, label, provider token';
create index on sellers.applications (state, decision_target_at);
create index on sellers.applications (applicant_account_id);
create index on sellers.applications (reviewer_id, state);
create table sellers.application_documents (
  id uuid primary key,
  application_id uuid not null,
  seller_id uuid,
  kind text not null,
  media_id uuid not null,
  file_name text not null,
  size_bytes int not null,
  status text not null,
  note text,
  delete_after date,
  uploaded_at timestamptz not null
);
create index on sellers.application_documents (application_id);
create index on sellers.application_documents (delete_after);
create table sellers.verification_checks (
  id uuid primary key,
  application_id uuid,
  seller_id uuid,
  kind text not null,
  result text not null,
  summary text not null,
  source text not null,
  provider text,
  provider_ref text,
  accepted_note text,
  checked_by text,
  checked_at timestamptz
);
create index on sellers.verification_checks (application_id);
create index on sellers.verification_checks (seller_id, kind);
create unique index on sellers.verification_checks (provider, provider_ref);
create table sellers.information_requests (
  id uuid primary key,
  application_id uuid not null,
  items jsonb not null,
  message text not null,
  due_at timestamptz not null,
  reminder text not null,
  reminded_at timestamptz,
  requested_by text not null,
  requested_at timestamptz not null,
  responded_at timestamptz,
  state text not null check (state in ('open', 'answered', 'expired'))
);
create index on sellers.information_requests (state, due_at);
create table sellers.risk_reviews (
  id uuid primary key,
  application_id uuid not null,
  trust_report_id uuid,
  state text not null,
  level text,
  flags jsonb not null,
  recommendation text,
  reviewed_by text,
  reviewed_at timestamptz
);
create table sellers.agreement_acceptances (
  id uuid primary key,
  seller_id uuid,
  application_id uuid,
  policy_key text not null,
  version_label text not null,
  policy_version_id uuid,
  signed_name text not null,
  accepted_by text not null,
  ip inet,
  accepted_at timestamptz not null
);
comment on table sellers.agreement_acceptances is 'Which agreement version each seller accepted, by whom and when';
create index on sellers.agreement_acceptances (seller_id, policy_key, accepted_at desc);
create table sellers.store_profiles (
  seller_id uuid primary key,
  logo_media_id uuid,
  banner_media_id uuid,
  introduction text,
  location text,
  contact_options jsonb not null,
  warranty text,
  updated_at timestamptz not null,
  tagline text
);
create table sellers.featured_collections (
  id uuid primary key,
  seller_id uuid not null,
  title text not null,
  image_media_id uuid,
  offer_ids jsonb not null,
  position int not null,
  visible bool not null,
  updated_at timestamptz not null
);
create index on sellers.featured_collections (seller_id, position);
create table sellers.public_claims (
  id uuid primary key,
  seller_id uuid not null,
  kind text not null,
  text text not null,
  brand_id uuid,
  evidence_media_ids jsonb not null,
  state text not null,
  decision_reason text,
  decided_by text,
  submitted_at timestamptz not null,
  decided_at timestamptz,
  expires_at timestamptz
);
create index on sellers.public_claims (state, submitted_at);
create index on sellers.public_claims (seller_id, state);
create table sellers.change_requests (
  id uuid primary key,
  seller_id uuid not null,
  kind text not null,
  current jsonb,
  proposed jsonb not null,
  evidence_media_ids jsonb not null,
  state text not null,
  decision_reason text,
  impact text,
  submitted_by text not null,
  submitted_at timestamptz not null,
  decided_by text,
  decided_at timestamptz
);
comment on table sellers.change_requests is 'Store name, legal name, ownership, business address changes and new brand requests waiting for staff review';
create index on sellers.change_requests (state, submitted_at);
create index on sellers.change_requests (seller_id);
create table sellers.members (
  id uuid primary key,
  seller_id uuid not null,
  account_id uuid,
  name text not null,
  email text not null,
  role text not null,
  permissions jsonb not null,
  is_owner bool not null,
  status text not null,
  invitation_id uuid,
  invited_by text,
  invited_at timestamptz,
  invite_expires_at timestamptz,
  joined_at timestamptz,
  last_active_at timestamptz,
  removed_at timestamptz
);
create unique index on sellers.members (seller_id, email) where status in ('invited','active','suspended');
create index on sellers.members (account_id);
create unique index on sellers.members (seller_id) where is_owner and status = 'active';
create table sellers.performance_events (
  id uuid primary key,
  seller_id uuid not null,
  kind text not null check (kind in ('order_accepted', 'dispatched', 'dispatched_late', 'tracking_valid', 'tracking_missing', 'seller_cancelled', 'units_sold', 'return_requested', 'message_received', 'first_reply', 'case_opened', 'case_resolved', 'case_overdue', 'policy_violation')),
  subject_id uuid,
  value numeric,
  occurred_at timestamptz not null,
  category_id uuid
);
comment on table sellers.performance_events is 'Raw per-seller facts from other modules'' events (append-only, used to recompute windows)';
create index on sellers.performance_events (seller_id, kind, occurred_at);
create unique index on sellers.performance_events (kind, subject_id);
create table sellers.performance_snapshots (
  id uuid primary key,
  seller_id uuid not null,
  computed_at timestamptz not null,
  window_from date not null,
  window_to date not null,
  order_count int not null,
  metrics jsonb not null,
  overall text not null
);
create index on sellers.performance_snapshots (seller_id, computed_at desc);
create table sellers.performance_targets (
  id uuid primary key,
  metric text not null,
  category_id uuid,
  comparator text not null,
  threshold numeric not null,
  unit text not null,
  window_days int not null,
  is_example bool not null,
  effective_from date not null,
  set_by text not null,
  reason text not null
);
comment on table sellers.performance_targets is 'Targets with effective dates; category-specific rows override the default';
create index on sellers.performance_targets (metric, category_id, effective_from desc);
create table sellers.warnings (
  id uuid primary key,
  seller_id uuid not null,
  kind text not null,
  title text not null,
  detail text not null,
  state text not null,
  issued_by text not null,
  issued_at timestamptz not null,
  resolved_at timestamptz,
  resolution_note text
);
create index on sellers.warnings (seller_id, issued_at desc);
create table sellers.restrictions (
  id uuid primary key,
  ref text not null unique,
  seller_id uuid not null,
  state text not null,
  title text not null,
  reason_code text not null,
  reason text not null,
  rule_ref text,
  affected_activities jsonb not null,
  scope jsonb not null,
  affected_summary text not null,
  still_works jsonb not null,
  to_resolve text not null,
  appeal_route jsonb not null,
  review_date date not null,
  started_at timestamptz,
  ends_at timestamptz,
  set_by text not null,
  recommended_by text,
  trust_report_id uuid,
  trust_enforcement_id uuid,
  approval_request_id uuid,
  resolution_evidence jsonb not null,
  lifted_at timestamptz,
  lift_reason text
);
create index on sellers.restrictions (seller_id, state);
create index on sellers.restrictions (state, review_date);
create table sellers.suspensions (
  id uuid primary key,
  seller_id uuid not null,
  state text not null check (state in ('pending_approval', 'active', 'ended', 'cancelled')),
  reason_code text not null,
  reason text not null,
  review_date date not null,
  open_orders text not null,
  requested_by text not null,
  second_reviewer_id uuid not null,
  approval_request_id uuid,
  trust_report_id uuid,
  appeal_route jsonb not null,
  started_at timestamptz,
  ended_at timestamptz,
  end_reason text
);
comment on table sellers.suspensions is 'Suspension decisions (pending second review, active, ended)';
create index on sellers.suspensions (seller_id, state);
create table sellers.appeals (
  id uuid primary key,
  ref text not null unique,
  seller_id uuid not null,
  subject text not null,
  subject_id uuid not null,
  level int not null,
  argument text not null,
  evidence_media_ids jsonb not null,
  state text not null,
  reviewer_id uuid,
  original_decider_id text not null,
  decide_by timestamptz not null,
  decision jsonb,
  trust_report_id uuid,
  submitted_at timestamptz not null
);
create index on sellers.appeals (state, decide_by);
create index on sellers.appeals (seller_id);
create unique index on sellers.appeals (subject, subject_id, level);
create table sellers.seller_notes (
  id uuid primary key,
  seller_id uuid,
  application_id uuid,
  body text not null,
  author_id text not null,
  author_name text not null,
  created_at timestamptz not null
);
create table sellers.account_events (
  id uuid primary key,
  seller_id uuid not null,
  kind text not null,
  title text not null,
  detail text,
  visibility text not null check (visibility in ('seller', 'staff')),
  actor_kind text not null,
  actor_id text,
  ref text,
  at timestamptz not null
);
comment on table sellers.account_events is 'Seller-visible and staff timeline (approved, warnings, restrictions, appeals, holds reported by finance)';
create index on sellers.account_events (seller_id, at desc);
create table sellers.seller_invitations (
  id uuid primary key,
  email text not null,
  business_name text not null,
  message text,
  code_hash text not null unique,
  invited_by text not null,
  sent_at timestamptz not null,
  expires_at timestamptz not null,
  state text not null,
  application_id uuid
);
comment on table sellers.seller_invitations is 'Invitations to apply (invite-only launch)';
create index on sellers.seller_invitations (email);
create index on sellers.seller_invitations (state, expires_at);
alter table sellers.applications add foreign key (seller_id) references sellers.sellers (id);
alter table sellers.applications add foreign key (invitation_id) references sellers.seller_invitations (id);
alter table sellers.application_documents add foreign key (application_id) references sellers.applications (id);
alter table sellers.verification_checks add foreign key (application_id) references sellers.applications (id);
alter table sellers.verification_checks add foreign key (seller_id) references sellers.sellers (id);
alter table sellers.information_requests add foreign key (application_id) references sellers.applications (id);
alter table sellers.risk_reviews add foreign key (application_id) references sellers.applications (id);
alter table sellers.agreement_acceptances add foreign key (seller_id) references sellers.sellers (id);
alter table sellers.agreement_acceptances add foreign key (application_id) references sellers.applications (id);
alter table sellers.store_profiles add foreign key (seller_id) references sellers.sellers (id);
alter table sellers.featured_collections add foreign key (seller_id) references sellers.sellers (id);
alter table sellers.public_claims add foreign key (seller_id) references sellers.sellers (id);
alter table sellers.change_requests add foreign key (seller_id) references sellers.sellers (id);
alter table sellers.members add foreign key (seller_id) references sellers.sellers (id);
alter table sellers.performance_snapshots add foreign key (seller_id) references sellers.sellers (id);
alter table sellers.warnings add foreign key (seller_id) references sellers.sellers (id);
alter table sellers.restrictions add foreign key (seller_id) references sellers.sellers (id);
alter table sellers.suspensions add foreign key (seller_id) references sellers.sellers (id);
alter table sellers.appeals add foreign key (seller_id) references sellers.sellers (id);
alter table sellers.seller_notes add foreign key (seller_id) references sellers.sellers (id);
alter table sellers.seller_notes add foreign key (application_id) references sellers.applications (id);
alter table sellers.account_events add foreign key (seller_id) references sellers.sellers (id);
`,
};
