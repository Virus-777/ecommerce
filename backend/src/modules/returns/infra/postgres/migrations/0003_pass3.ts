import type { Migration } from '../../../../../kernel/migrations/index.js';
import { defaultResponsibilities, SEEDED_POLICY_ID } from '../../../domain/rules.js';

/** SQL string literal */
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** Example values of the baseline (decision D-RT2): 30-day window, $7.99 change-of-mind return shipping */
const responsibilities = JSON.stringify(defaultResponsibilities({ amount: 799, currency: 'USD' }));
const system = JSON.stringify({ kind: 'system', id: null });

/**
 * Gap pass 3:
 * - return_shipments keep the shipping label id and its carrier service (void, drop-off points);
 * - replacements can exist without a return (support case remedies): return_id nullable, case_id, order_id
 *   (backfilled from the return), idempotency_key; reservation_id now holds an inventory allocation;
 * - baseline policy version 1.0 is seeded (active, effective at install) so resolveTerms, eligibility and
 *   terms snapshots always have a policy version and a policyVersionId. Nothing is inserted when a version exists.
 */
export const m0003Pass3: Migration = {
  id: '0003_pass3',
  sql: /* sql */ `
alter table returns.return_shipments add column label_id uuid;
alter table returns.return_shipments add column carrier_service_id uuid;
update returns.return_shipments set label_id = id where method <> 'customer_arranged' and label_id is null;

alter table returns.replacements alter column return_id drop not null;
alter table returns.replacements add column case_id uuid;
alter table returns.replacements add column order_id uuid;
alter table returns.replacements add column idempotency_key text unique;
update returns.replacements p set order_id = r.order_id from returns.returns r where r.id = p.return_id and p.order_id is null;
alter table returns.replacements alter column order_id set not null;
create index on returns.replacements (case_id);
create index on returns.replacements (order_id);
comment on table returns.replacements is 'Replacement or exchange units with their own shipment; the original order is not changed. return_id is null for replacements decided on a support case without a return (case_id set)';

insert into returns.policy_versions (id, version, status, window_days, seller_response_business_days, info_reply_days, drop_off_days,
  inspection_target_business_days, refund_target_business_days, responsibilities, effective_from, change_reason, approval_request_id, created_by, created_at)
select ${lit(SEEDED_POLICY_ID)}, '1.0', 'active', 30, 2, 7, 7, 2, 2, ${lit(responsibilities)}::jsonb, now(), 'Launch baseline', null, ${lit(system)}, now()
 where not exists (select 1 from returns.policy_versions);
`,
};
