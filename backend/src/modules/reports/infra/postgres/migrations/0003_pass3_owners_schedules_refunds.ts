import type { Migration } from '../../../../../kernel/migrations/index.js';

/**
 * Pass 3:
 *  1. Metric and group owners are nullable (decision D10): the placeholder owner id becomes null ("no person
 *     named yet"); PUT /metrics/{key}/owner and PUT /groups/{key}/owner name one.
 *  2. Scheduled reports go to staff only, as CSV or XLSX (decision D2): schedules addressed to email addresses
 *     cannot be delivered any more and are stopped (their owner re-creates them with staff recipients); PDF becomes CSV.
 *  3. fact_refunds holds one row per refund and seller (decision D5): the Official Store's rows carry
 *     OFFICIAL_STORE_ID and the key is (refund_id, seller_id).
 */
export const m0003Pass3OwnersSchedulesRefunds: Migration = {
  id: '0003_pass3_owners_schedules_refunds',
  sql: /* sql */ `
alter table reports.metric_definitions alter column owner_staff_id drop not null;
alter table reports.report_groups alter column owner_staff_id drop not null;
update reports.metric_definitions set owner_staff_id = null where owner_staff_id = '00000000-0000-0000-0000-000000000000';
update reports.report_groups set owner_staff_id = null where owner_staff_id = '00000000-0000-0000-0000-000000000000';
update reports.metric_versions set snapshot = jsonb_set(snapshot, '{ownerId}', 'null'::jsonb) where snapshot->>'ownerId' = '00000000-0000-0000-0000-000000000000';

update reports.report_schedules set format = 'csv' where format not in ('csv', 'xlsx');
update reports.report_schedules s set active = false
where exists (select 1 from jsonb_array_elements_text(s.recipients) r(v) where v !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');

update reports.fact_refunds set seller_id = '00000000-0000-7000-8000-000000000001', owner_type = 'official' where seller_id is null;
alter table reports.fact_refunds alter column seller_id set not null;
alter table reports.fact_refunds drop constraint fact_refunds_pkey;
alter table reports.fact_refunds add primary key (refund_id, seller_id);
`,
};
