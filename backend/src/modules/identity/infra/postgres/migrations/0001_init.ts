import type { Migration } from '../../../../../kernel/migrations/index.js';

/** Tables, constraints and indexes from docs/api/spec/modules/identity.json (spec "tables"). */
export const m0001Init: Migration = {
  id: '0001_init',
  sql: /* sql */ `
create table identity.accounts (
  id uuid primary key,
  realm text not null check (realm in ('member', 'staff')),
  email text not null,
  email_normalized text not null,
  email_verified_at timestamptz,
  display_name text not null,
  status text not null,
  password_hash text,
  password_changed_at timestamptz,
  must_reset_password bool not null,
  failed_sign_ins int not null,
  failed_window_started_at timestamptz,
  locked_until timestamptz,
  lock_reason text,
  locked_by text,
  closed_at timestamptz,
  accepted_terms_version text,
  created_at timestamptz not null,
  last_sign_in_at timestamptz,
  last_active_at timestamptz,
  version int not null,
  tokens_valid_after timestamptz
);
comment on table identity.accounts is 'One row per account. Email is unique per realm (the same person can have a member account and a staff account).';
comment on column identity.accounts.password_hash is 'argon2id';
create unique index on identity.accounts (realm, email_normalized);
create index on identity.accounts (status, id);
create index on identity.accounts (realm, created_at);
create table identity.password_history (
  id uuid primary key,
  account_id uuid not null,
  password_hash text not null,
  created_at timestamptz not null
);
comment on table identity.password_history is 'Last N hashes to block reuse';
create index on identity.password_history (account_id, created_at desc);
create table identity.two_step_methods (
  id uuid primary key,
  account_id uuid not null,
  method text not null check (method in ('totp', 'sms')),
  secret_encrypted bytea,
  phone_e164_encrypted bytea,
  phone_masked text,
  confirmed_at timestamptz,
  last_used_at timestamptz,
  last_used_step bigint,
  removed_at timestamptz
);
comment on column identity.two_step_methods.last_used_step is 'TOTP replay guard';
create index on identity.two_step_methods (account_id) where removed_at is null;
create table identity.recovery_codes (
  id uuid primary key,
  account_id uuid not null,
  code_hash text not null,
  batch_id uuid not null,
  used_at timestamptz
);
create index on identity.recovery_codes (account_id, batch_id);
create table identity.challenges (
  id uuid primary key,
  account_id uuid,
  purpose text not null check (purpose in ('email_verification', 'email_change', 'phone_verification', 'sign_in_second_factor', 'two_step_setup')),
  target_email text,
  code_hash text,
  payload jsonb not null,
  attempts int not null,
  max_attempts int not null,
  status text not null,
  expires_at timestamptz not null,
  resend_available_at timestamptz,
  created_at timestamptz not null,
  completed_at timestamptz,
  target_phone_encrypted bytea
);
comment on table identity.challenges is 'Email verification, email change, phone verification, 2-step sign-in and 2-step setup challenges';
comment on column identity.challenges.payload is 'setup secret, pending session request';
create index on identity.challenges (account_id, purpose, status);
create index on identity.challenges (expires_at);
create table identity.password_resets (
  id uuid primary key,
  account_id uuid not null,
  token_hash text not null unique,
  forced_by text,
  forced_reason text,
  expires_at timestamptz not null,
  used_at timestamptz,
  requested_ip inet,
  created_at timestamptz not null
);
create index on identity.password_resets (account_id, created_at desc);
create table identity.devices (
  id uuid primary key,
  account_id uuid not null,
  kind text not null check (kind in ('web', 'android')),
  label text not null,
  installation_id text,
  user_agent text,
  app_version text,
  last_ip inet,
  last_location text,
  two_step_trusted_until timestamptz,
  first_seen_at timestamptz not null,
  last_active_at timestamptz not null
);
comment on table identity.devices is 'A browser or app install seen for an account';
create index on identity.devices (account_id, last_active_at desc);
create unique index on identity.devices (account_id, installation_id) where installation_id is not null;
create table identity.sessions (
  id uuid primary key,
  account_id uuid not null,
  device_id uuid not null,
  audience text not null check (audience in ('store', 'seller', 'admin')),
  seller_id uuid,
  seller_member_id uuid,
  refresh_token_hash text not null unique,
  previous_token_hash text,
  keep_signed_in bool not null,
  two_step_verified_at timestamptz,
  created_at timestamptz not null,
  last_refreshed_at timestamptz not null,
  expires_at timestamptz not null,
  absolute_expires_at timestamptz not null,
  revoked_at timestamptz,
  revoke_reason text
);
comment on table identity.sessions is 'One per sign-in. Refresh tokens rotate inside a session (family); reuse of a rotated token revokes the session.';
create index on identity.sessions (account_id) where revoked_at is null;
create index on identity.sessions (device_id);
create index on identity.sessions (seller_id) where revoked_at is null;
create table identity.seller_access (
  account_id uuid not null,
  seller_id uuid not null,
  seller_member_id uuid not null,
  seller_name text not null,
  role_label text not null,
  is_owner bool not null,
  granted_at timestamptz not null,
  revoked_at timestamptz,
  last_used_at timestamptz,
  primary key (account_id, seller_id)
);
comment on table identity.seller_access is 'Sellers an account may act for. Written only by the sellers module through grantSellerContext / revokeSellerContext.';
create index on identity.seller_access (seller_id);
create table identity.invitations (
  id uuid primary key,
  realm text not null,
  purpose text not null check (purpose in ('staff', 'seller_member')),
  email text not null,
  name text not null,
  account_id uuid,
  context_ref text,
  context_label text,
  token_hash text not null unique,
  invited_by_kind text not null,
  invited_by_id text not null,
  status text not null,
  sent_at timestamptz not null,
  expires_at timestamptz not null,
  accepted_at timestamptz,
  revoked_at timestamptz,
  revoke_reason text
);
create index on identity.invitations (status, expires_at);
create index on identity.invitations (email);
create table identity.guest_sessions (
  id uuid primary key,
  device_kind text not null,
  created_at timestamptz not null,
  last_seen_at timestamptz not null,
  expires_at timestamptz not null,
  claimed_by_account_id uuid,
  claimed_at timestamptz,
  audience text not null check (audience in ('store', 'seller', 'admin')),
  refresh_token_hash text not null unique,
  previous_token_hash text,
  rotated_at timestamptz
);
comment on table identity.guest_sessions is 'Visitor sessions (auth v3): one per app install before sign-in; in the store also the guest session';
create index on identity.guest_sessions (expires_at);
create table identity.guest_order_grants (
  guest_session_id uuid not null,
  order_id uuid not null,
  email_normalized text not null,
  via text not null check (via in ('checkout', 'lookup', 'link')),
  granted_at timestamptz not null,
  expires_at timestamptz not null,
  primary key (guest_session_id, order_id)
);
comment on table identity.guest_order_grants is 'Orders a guest session may open';
create index on identity.guest_order_grants (email_normalized);
create table identity.order_links (
  id uuid primary key,
  token_hash text not null unique,
  order_id uuid not null,
  email_normalized text not null,
  expires_at timestamptz not null,
  last_redeemed_at timestamptz,
  redeem_count int not null
);
comment on table identity.order_links is 'Emailed order links (token hash only)';
create index on identity.order_links (order_id);
create table identity.security_events (
  id uuid primary key,
  account_id uuid not null,
  kind text not null,
  result text not null,
  audience text,
  device_id uuid,
  device_label text,
  ip inet,
  location text,
  actor_kind text,
  actor_id text,
  reason text,
  detail jsonb not null,
  at timestamptz not null
);
comment on table identity.security_events is 'Per-account security activity (append-only)';
create index on identity.security_events (account_id, at desc);
create index on identity.security_events (kind, at);
create table identity.sign_in_attempts (
  id bigserial primary key,
  email_normalized text not null,
  ip inet not null,
  succeeded bool not null,
  at timestamptz not null
);
comment on table identity.sign_in_attempts is 'Rate limiting by email and IP, including unknown emails';
create index on identity.sign_in_attempts (email_normalized, at);
create index on identity.sign_in_attempts (ip, at);
create table identity.reauth_tokens (
  token_hash text primary key,
  account_id uuid not null,
  session_id uuid not null,
  expires_at timestamptz not null,
  used_at timestamptz
);
comment on table identity.reauth_tokens is 'Short-lived proof of a recent password or 2-step check';
create index on identity.reauth_tokens (expires_at);
alter table identity.password_history add foreign key (account_id) references identity.accounts (id);
alter table identity.two_step_methods add foreign key (account_id) references identity.accounts (id);
alter table identity.recovery_codes add foreign key (account_id) references identity.accounts (id);
alter table identity.challenges add foreign key (account_id) references identity.accounts (id);
alter table identity.password_resets add foreign key (account_id) references identity.accounts (id);
alter table identity.devices add foreign key (account_id) references identity.accounts (id);
alter table identity.sessions add foreign key (account_id) references identity.accounts (id);
alter table identity.sessions add foreign key (device_id) references identity.devices (id);
alter table identity.seller_access add foreign key (account_id) references identity.accounts (id);
alter table identity.invitations add foreign key (account_id) references identity.accounts (id);
alter table identity.guest_order_grants add foreign key (guest_session_id) references identity.guest_sessions (id);
alter table identity.security_events add foreign key (account_id) references identity.accounts (id);
alter table identity.reauth_tokens add foreign key (account_id) references identity.accounts (id);
alter table identity.reauth_tokens add foreign key (session_id) references identity.sessions (id);
`,
};
