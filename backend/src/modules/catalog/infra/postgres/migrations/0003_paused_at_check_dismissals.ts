import type { Migration } from '../../../../../kernel/migrations/index.js';

/**
 * Gap pass 4.
 * - submissions.paused_at: a restriction or suspension of the seller pauses an open submission. Paused submissions
 *   used to be marked by a null review_due_at; those rows get paused_at now (the pause time is unknown) and keep the
 *   null deadline, which the reinstatement handler recomputes.
 * - check_dismissals: per-candidate "not a duplicate" dismissals, kept until now as a dismissedAt key inside the
 *   check's evidence jsonb. Copied out (dismissed by the check's dismissed_by, reason dismiss_reason) and the key is
 *   removed from the evidence.
 */
export const m0003PausedAtCheckDismissals: Migration = {
  id: '0003_paused_at_check_dismissals',
  sql: /* sql */ `
alter table catalog.submissions add column paused_at timestamptz;
comment on column catalog.submissions.paused_at is 'set while a seller restriction or suspension pauses the review; the queue leaves paused rows out';
update catalog.submissions set paused_at = now() where state = 'open' and review_due_at is null;

create table catalog.check_dismissals (
  check_id uuid not null,
  matched_product_id uuid not null,
  dismissed_at timestamptz not null,
  dismissed_by jsonb not null,
  reason text not null,
  primary key (check_id, matched_product_id)
);
comment on table catalog.check_dismissals is 'Per-candidate dismissals of a duplicate check: one row per matched product a reviewer marked not a duplicate. The check row''s dismissed_* columns record the latest dismissal; the finding counts as dismissed once every candidate has a row here';

insert into catalog.check_dismissals (check_id, matched_product_id, dismissed_at, dismissed_by, reason)
select c.id, (e.item->>'matchedProductId')::uuid, min((e.item->>'dismissedAt')::timestamptz),
       coalesce(c.dismissed_by, '{"kind":"system"}'::jsonb), coalesce(c.dismiss_reason, '')
from catalog.submission_checks c
cross join lateral jsonb_array_elements(case when jsonb_typeof(c.evidence) = 'array' then c.evidence else '[]'::jsonb end) as e(item)
where e.item->>'matchedProductId' is not null and e.item->>'dismissedAt' is not null
group by c.id, (e.item->>'matchedProductId')::uuid, c.dismissed_by, c.dismiss_reason
on conflict do nothing;

update catalog.submission_checks c
set evidence = (select coalesce(jsonb_agg(e.item - 'dismissedAt' order by e.n), '[]'::jsonb)
                from jsonb_array_elements(c.evidence) with ordinality as e(item, n))
where jsonb_typeof(c.evidence) = 'array'
  and exists (select 1 from jsonb_array_elements(c.evidence) as x(item) where x.item ? 'dismissedAt');
`,
};
