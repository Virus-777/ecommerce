import type { Migration } from '../../../../../kernel/migrations/index.js';

/**
 * Gap pass 4.
 * 1. packages.carrier_service_id: the shipping service chosen at packing (only its carrier and service names were
 *    kept; existing packages keep matching by name until a service is chosen again).
 * 2. fulfillments.dispatch_overdue_at: from the scan_log rows the overdue consumer wrote (context overdue, code =
 *    order reference): the first one per order, on its fulfillments that were not dispatched or cancelled since.
 * 3. Idempotency through the kernel inbox instead of scan_log rows: the cancellations, overdue reports and at-risk
 *    flags already handled are claimed so they are not applied again.
 */
export const m0002Pass4Columns: Migration = {
  id: '0002_pass4_columns',
  sql: /* sql */ `
alter table warehouse.packages add column carrier_service_id uuid;
comment on column warehouse.packages.carrier_service_id is 'shipping carrier service chosen at packing';

alter table warehouse.fulfillments add column dispatch_overdue_at timestamptz;
comment on column warehouse.fulfillments.dispatch_overdue_at is 'shipping.dispatch.overdue: the dispatch deadline was missed';
update warehouse.fulfillments f set dispatch_overdue_at = s.at
  from (select code, min(at) as at from warehouse.scan_log where context = 'overdue' group by code) s
  where s.code = f.order_ref;

insert into kernel.processed_events (module, key)
  select distinct 'warehouse', 'dispatch-overdue:' || context_id from warehouse.scan_log where context = 'overdue' and context_id is not null
  on conflict do nothing;
insert into kernel.processed_events (module, key)
  select distinct 'warehouse', 'item-cancelled:' || context_id from warehouse.scan_log where context = 'order_cancel' and context_id is not null and result not like 'return %'
  on conflict do nothing;
insert into kernel.processed_events (module, key)
  select distinct 'warehouse', 'at-risk:' || context_id from warehouse.scan_log where context = 'at_risk' and context_id is not null
  on conflict do nothing;
`,
};
