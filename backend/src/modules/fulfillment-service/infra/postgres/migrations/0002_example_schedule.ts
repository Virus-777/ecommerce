import type { Migration } from '../../../../../kernel/migrations/index.js';
import { EXAMPLE_SCHEDULE } from '../../../domain/rules.js';

const q = (v: string) => `'${v.replace(/'/g, "''")}'`;

/**
 * The example fee schedule in force until staff publish a real one (FeeSchedule.isExample), and lookup indexes
 * for fulfillment requests, service returns, removals, ledger references and fee statements.
 */
export const m0002ExampleSchedule: Migration = {
  id: '0002_example_schedule',
  sql: /* sql */ `
insert into fulfillment_service.fee_schedules (id, version, effective_at, rates, state, approval_request_id)
values (${q(EXAMPLE_SCHEDULE.id)}, ${q(EXAMPLE_SCHEDULE.version)}, ${q(EXAMPLE_SCHEDULE.effectiveAt)}, ${q(JSON.stringify(EXAMPLE_SCHEDULE.rates))}::jsonb, 'current', null)
on conflict (version) do nothing;
create index on fulfillment_service.fulfillment_requests (seller_id, state);
create index on fulfillment_service.fulfillment_requests (order_id);
create index on fulfillment_service.service_returns (seller_id, outcome);
create index on fulfillment_service.service_returns (return_id);
create index on fulfillment_service.removal_orders (seller_id, state);
create index on fulfillment_service.inbound_lines (inbound_id);
create index on fulfillment_service.discrepancies (inbound_id);
create index on fulfillment_service.fee_charges (seller_id, period);
create index on fulfillment_service.fee_charges (reference);
create index on fulfillment_service.storage_snapshots (seller_id, day);
`,
};
