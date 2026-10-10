import type { Migration } from '../../../../../kernel/migrations/index.js';

/**
 * Gap pass 4.
 * 1. sellers.payout_blocked_reasons: copied from applications.payout jsonb (blockedReasons).
 * 2. suspensions.ref: new suspensions get SU-YYMMDD-NNNN; existing ones keep the reference they were shown with
 *    (SU- and the last 8 characters of the id).
 * 3. payout_changes: the payout destinations handed to finance, kept until now inside applications.payout jsonb
 *    (current = the verified destination, pendingChange = the one finance is verifying). Only accounts past the
 *    first destination hand-over are copied (an applied seller's payout jsonb is still application form data).
 * 4. pending_changes: closures, restriction changes and target changes waiting for a second reviewer. They lived in
 *    the access approval request (another module's table): requests already pending keep being applied from there.
 */
export const m0003Pass4: Migration = {
  id: '0003_pass4',
  sql: /* sql */ `
alter table sellers.sellers add column payout_blocked_reasons jsonb not null default '[]'::jsonb;
update sellers.sellers s set payout_blocked_reasons = a.payout->'blockedReasons'
  from sellers.applications a
  where a.id = s.application_id and jsonb_typeof(a.payout->'blockedReasons') = 'array';
alter table sellers.sellers alter column payout_blocked_reasons drop default;
comment on column sellers.sellers.payout_blocked_reasons is 'reasons shown to the seller while payout readiness is blocked; empty otherwise';

alter table sellers.suspensions add column ref text;
update sellers.suspensions set ref = 'SU-' || upper(right(replace(id::text, '-', ''), 8));
alter table sellers.suspensions alter column ref set not null;
alter table sellers.suspensions add constraint suspensions_ref_key unique (ref);

create table sellers.payout_changes (
  id uuid primary key,
  seller_id uuid not null references sellers.sellers (id),
  kind text not null check (kind in ('initial', 'change')),
  account_holder_name text not null,
  account_type text not null,
  label text not null,
  provider_destination_id text not null,
  previous_label text,
  state text not null check (state in ('pending', 'verified', 'rejected', 'replaced')),
  rejection_reason text,
  review_id text,
  requested_by jsonb not null,
  requested_at timestamptz not null,
  decided_at timestamptz
);
comment on table sellers.payout_changes is 'Payout destinations handed to finance for verification: the initial one at approval and each change by the owner (tokenised; raw numbers never stored)';
create index on sellers.payout_changes (seller_id, requested_at desc);
create unique index on sellers.payout_changes (seller_id) where state = 'pending';
create unique index on sellers.payout_changes (seller_id) where state = 'verified';

insert into sellers.payout_changes (id, seller_id, kind, account_holder_name, account_type, label, provider_destination_id, previous_label, state, rejection_reason, review_id, requested_by, requested_at, decided_at)
  select gen_random_uuid(), s.id, 'initial', c->>'accountHolderName', c->>'accountType', c->>'label', c->>'providerDestinationId', null, 'verified', null, null,
         '{"kind":"system"}'::jsonb, coalesce(s.approved_at, s.created_at), coalesce(s.approved_at, s.created_at)
  from sellers.sellers s
  join sellers.applications a on a.id = s.application_id
  cross join lateral (select a.payout->'current' as c) x
  where s.payout_readiness in ('verified', 'change_under_review', 'blocked') and jsonb_typeof(c) = 'object' and c->>'providerDestinationId' is not null;
insert into sellers.payout_changes (id, seller_id, kind, account_holder_name, account_type, label, provider_destination_id, previous_label, state, rejection_reason, review_id, requested_by, requested_at, decided_at)
  select coalesce((p->>'changeId')::uuid, gen_random_uuid()), s.id, case when s.payout_readiness = 'verification_pending' then 'initial' else 'change' end,
         p->>'accountHolderName', p->>'accountType', p->>'label', p->>'providerDestinationId', a.payout->'current'->>'label', 'pending', null, null,
         '{"kind":"system"}'::jsonb, coalesce((p->>'requestedAt')::timestamptz, s.updated_at), null
  from sellers.sellers s
  join sellers.applications a on a.id = s.application_id
  cross join lateral (select a.payout->'pendingChange' as p) x
  where s.payout_readiness in ('verification_pending', 'change_under_review') and jsonb_typeof(p) = 'object' and p->>'providerDestinationId' is not null;

create table sellers.pending_changes (
  id uuid primary key,
  kind text not null check (kind in ('closure', 'restriction_change', 'performance_targets')),
  seller_id uuid,
  target_id uuid,
  approval_request_id uuid not null unique,
  payload jsonb not null,
  reason text not null,
  requested_by jsonb not null,
  state text not null check (state in ('pending', 'applied', 'declined')),
  requested_at timestamptz not null,
  decided_at timestamptz
);
comment on table sellers.pending_changes is 'Staff changes waiting for a second reviewer (seller closure, restriction change, performance targets); applied or dropped on access.approval.decided';
create index on sellers.pending_changes (kind, state);
create index on sellers.pending_changes (seller_id, state);
`,
};
