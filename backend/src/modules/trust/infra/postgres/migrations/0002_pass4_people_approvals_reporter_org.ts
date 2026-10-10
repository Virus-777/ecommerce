import type { Migration } from '../../../../../kernel/migrations/index.js';

/**
 * Pass 4 (spec tables reports, recommendations, enforcements):
 *  1. recommendations.created_by / routed_by: who drafted and who last routed a recommendation (separate duties),
 *     backfilled from the report timeline (recommendation_drafted / recommendation_routed events).
 *  2. recommendations.approval_request_id / enforcements.reversal_request_id: an accept or reversal waiting for
 *     approval (the call now answers 200 with `approval`). Backfilled with the last approval_requested event of the
 *     record when no approval_decided event names it and the record can still move (sent_to_owner; not reversed).
 *  3. reports.reporter_org: the brand a rights owner reports for. reporter_name held "Contact Name (Brand)"; the
 *     brand moves to reporter_org and reporter_name keeps the contact.
 */
export const m0002Pass4PeopleApprovalsReporterOrg: Migration = {
  id: '0002_pass4_people_approvals_reporter_org',
  sql: /* sql */ `
alter table trust.recommendations add column created_by text, add column routed_by text, add column approval_request_id uuid;
comment on column trust.recommendations.created_by is 'staff id who drafted it';
comment on column trust.recommendations.routed_by is 'staff id who last routed it';
comment on column trust.recommendations.approval_request_id is 'pending access approval to accept it';
create index on trust.recommendations (approval_request_id) where approval_request_id is not null;
alter table trust.enforcements add column reversal_request_id uuid;
comment on column trust.enforcements.reversal_request_id is 'pending access approval to reverse it';
create index on trust.enforcements (reversal_request_id) where reversal_request_id is not null;
alter table trust.reports add column reporter_org text;
comment on column trust.reports.reporter_name is 'the reporter or, for rights owners, the contact person';
comment on column trust.reports.reporter_org is 'rights owner''s brand or organisation';

update trust.recommendations r set
  created_by = (select e.actor_id from trust.report_events e where e.kind = 'recommendation_drafted' and e.detail->>'recommendationId' = r.id::text order by e.at asc limit 1),
  routed_by = (select e.actor_id from trust.report_events e where e.kind = 'recommendation_routed' and e.detail->>'recommendationId' = r.id::text order by e.at desc limit 1);

with last as (
  select distinct on (e.detail->>'recommendationId') e.detail->>'recommendationId' as rec_id, e.detail->>'approvalRequestId' as request_id
  from trust.report_events e
  where e.kind = 'approval_requested' and e.detail ? 'recommendationId' and e.detail->>'approvalRequestId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  order by e.detail->>'recommendationId', e.at desc
)
update trust.recommendations r set approval_request_id = last.request_id::uuid
from last
where last.rec_id = r.id::text and r.state = 'sent_to_owner'
  and not exists (select 1 from trust.report_events d where d.kind = 'approval_decided' and d.detail->>'approvalRequestId' = last.request_id);

with last as (
  select distinct on (e.detail->>'enforcementId') e.detail->>'enforcementId' as enf_id, e.detail->>'approvalRequestId' as request_id
  from trust.report_events e
  where e.kind = 'approval_requested' and e.detail ? 'enforcementId' and e.detail->>'approvalRequestId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  order by e.detail->>'enforcementId', e.at desc
)
update trust.enforcements x set reversal_request_id = last.request_id::uuid
from last
where last.enf_id = x.id::text and x.execution_state <> 'reversed'
  and not exists (select 1 from trust.report_events d where d.kind = 'approval_decided' and d.detail->>'approvalRequestId' = last.request_id);

update trust.reports set
  reporter_org = substring(reporter_name from '\\(([^()]*)\\)\\s*$'),
  reporter_name = nullif(trim(regexp_replace(reporter_name, '\\s*\\([^()]*\\)\\s*$', '')), '')
where reporter_kind = 'brand_owner' and reporter_name ~ '\\([^()]*\\)\\s*$';
`,
};
