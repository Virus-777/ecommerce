import type { Migration } from '../../../../../kernel/migrations/index.js';

/**
 * Pass 4: staff balance corrections get their own table (spec table credit_corrections).
 *
 * Before, a correction above the caller's adjustment limit kept its details only in the access approval
 * request and the endpoint answered 409 APPROVAL_REQUIRED. Now the correction is saved pending_approval here
 * and the endpoint answers 201 with `approval` (FORMAT.md, Approval responses).
 *
 * Backfill: every correction already applied (ledger entries of kind correction keyed `correction:<key>`)
 * becomes an applied row. Corrections still waiting for approval live only in access (another module's
 * tables): the approval consumer creates their row when the approval is decided (legacy path in
 * service/staff-credit.ts).
 */
export const m0004CreditCorrections: Migration = {
  id: '0004_credit_corrections',
  sql: /* sql */ `
create table wallet.credit_corrections (
  id uuid primary key,
  customer_id uuid not null,
  amount bigint not null,
  currency text not null,
  reason text not null,
  reference text,
  state text not null,
  approval_request_id uuid,
  requested_by text not null,
  decided_by text,
  decided_at timestamptz,
  ledger_entry_id uuid,
  failure text,
  idempotency_key text not null unique,
  created_at timestamptz not null,
  constraint credit_corrections_state check (state in ('pending_approval', 'applied', 'rejected', 'failed')),
  constraint credit_corrections_amount check (amount <> 0)
);
create index on wallet.credit_corrections (customer_id, state, created_at);
create index on wallet.credit_corrections (approval_request_id) where approval_request_id is not null;

insert into wallet.credit_corrections (id, customer_id, amount, currency, reason, reference, state, approval_request_id, requested_by, decided_by, decided_at, ledger_entry_id, failure, idempotency_key, created_at)
select e.id, e.customer_id, e.amount, a.currency, coalesce(e.reason, 'Balance correction'), null, 'applied', null,
  json_build_object('kind', e.actor_kind, 'id', e.actor_id)::text, null, e.at, e.id, null,
  substr(e.idempotency_key, length('correction:') + 1), e.at
from wallet.ledger e
join wallet.accounts a on a.customer_id = e.customer_id
where e.kind = 'correction' and e.idempotency_key like 'correction:%' and e.amount <> 0
on conflict do nothing;
`,
};
