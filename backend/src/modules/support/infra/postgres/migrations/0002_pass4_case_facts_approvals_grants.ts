import type { Migration } from '../../../../../kernel/migrations/index.js';

/**
 * Pass 4 (spec tables cases, case_remedies):
 *  1. Case facts move out of cases.next_action->'facts' (jsonb) into columns: order and return references, names,
 *     owner type, what the customer asked for (problem type, desired remedy, callback phone), the seller request
 *     reference, the Trust and Risk report, the open information request, the last escalation, the first seller
 *     reply, the dispatch warning and the job markers (overdue deadline announced, appeal window closed). Existing
 *     rows are backfilled from the jsonb and next_action keeps only the stored next action.
 *  2. A decision waiting for support.remedies.approve moves out of cases.decision_draft->'pending' into
 *     approval_request_id + pending_decision; a draft object that only carried the pending decision is cleared.
 *  3. case_remedies.goodwill_grant_id: the wallet goodwill grant behind a goodwill credit remedy (wallet.goodwill.decided
 *     is matched on it). Earlier remedies kept no grant id (none to backfill); they are still matched by case, kind
 *     and amount.
 */
export const m0002Pass4CaseFactsApprovalsGrants: Migration = {
  id: '0002_pass4_case_facts_approvals_grants',
  sql: /* sql */ `
alter table support.cases
  add column order_ref text,
  add column placed_at timestamptz,
  add column return_ref text,
  add column customer_name text,
  add column contact_email text,
  add column city text,
  add column seller_name text,
  add column owner_type text check (owner_type in ('official', 'seller')),
  add column reference text,
  add column trust_report_id uuid,
  add column problem_type text check (problem_type in ('missing_item', 'damaged', 'wrong_item', 'not_arrived', 'other')),
  add column desired_remedy text check (desired_remedy in ('refund', 'keep_waiting', 'replacement', 'other')),
  add column callback_phone text,
  add column info_request_from text check (info_request_from in ('customer', 'seller')),
  add column info_request_question text,
  add column info_request_due_at timestamptz,
  add column info_requested_at timestamptz,
  add column info_requested_by text,
  add column escalated_at timestamptz,
  add column escalated_by text,
  add column escalation_reason text,
  add column escalated_to text,
  add column escalation_note text,
  add column seller_replied_at timestamptz,
  add column dispatch_overdue_due_at timestamptz,
  add column dispatch_overdue_noted_at timestamptz,
  add column overdue_notified_for timestamptz,
  add column appeal_window_closed bool not null default false,
  add column approval_request_id uuid,
  add column pending_decision jsonb;
comment on column support.cases.order_ref is 'order reference kept for search and lists';
comment on column support.cases.customer_name is 'order contact or customer display name when opened';
comment on column support.cases.contact_email is 'order contact email, for guests';
comment on column support.cases.reference is 'seller request reference: MK-, RT-, PO-, RS- or a SKU';
comment on column support.cases.trust_report_id is 'Trust and Risk report the case acts on';
comment on column support.cases.info_requested_by is 'actor';
comment on column support.cases.escalated_at is 'last escalation';
comment on column support.cases.escalated_by is 'actor';
comment on column support.cases.seller_replied_at is 'first seller reply on a customer case';
comment on column support.cases.dispatch_overdue_due_at is 'shipping.dispatch.overdue noted on the case';
comment on column support.cases.overdue_notified_for is 'the response deadline support.case.overdue was published for';
comment on column support.cases.appeal_window_closed is 'the auto-close job recorded the end of the appeal window';
comment on column support.cases.approval_request_id is 'access approval request of a decision waiting for support.remedies.approve';
comment on column support.cases.pending_decision is '{ kind: decision|appeal, ref, decision | appeal, requestedBy, principal, requestedAt }: the decision published when the request is approved';
create index on support.cases (approval_request_id) where approval_request_id is not null;
create index on support.cases (trust_report_id) where trust_report_id is not null;

-- 1. facts out of next_action
with f as (select id, next_action->'facts' as x from support.cases where jsonb_typeof(next_action->'facts') = 'object')
update support.cases c set
  order_ref = nullif(f.x->>'orderRef', ''),
  placed_at = case when f.x->>'placedAt' ~ '^\\d{4}-\\d{2}-\\d{2}' then (f.x->>'placedAt')::timestamptz end,
  return_ref = nullif(f.x->>'returnRef', ''),
  customer_name = nullif(f.x->>'customerName', ''),
  contact_email = nullif(f.x->>'contactEmail', ''),
  city = nullif(f.x->>'city', ''),
  seller_name = nullif(f.x->>'sellerName', ''),
  owner_type = case when f.x->>'ownerType' in ('official', 'seller') then f.x->>'ownerType' end,
  reference = nullif(f.x->>'reference', ''),
  trust_report_id = case when f.x->>'trustReportId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then (f.x->>'trustReportId')::uuid end,
  problem_type = case when f.x->>'problemType' in ('missing_item', 'damaged', 'wrong_item', 'not_arrived', 'other') then f.x->>'problemType' end,
  desired_remedy = case when f.x->>'desiredRemedy' in ('refund', 'keep_waiting', 'replacement', 'other') then f.x->>'desiredRemedy' end,
  callback_phone = nullif(f.x->>'callbackPhone', ''),
  info_request_from = case when f.x->'infoRequest'->>'from' in ('customer', 'seller') then f.x->'infoRequest'->>'from' end,
  info_request_question = f.x->'infoRequest'->>'question',
  info_request_due_at = case when f.x->'infoRequest'->>'dueAt' ~ '^\\d{4}-\\d{2}-\\d{2}' then (f.x->'infoRequest'->>'dueAt')::timestamptz end,
  info_requested_at = case when f.x->'infoRequest'->>'askedAt' ~ '^\\d{4}-\\d{2}-\\d{2}' then (f.x->'infoRequest'->>'askedAt')::timestamptz end,
  info_requested_by = case when jsonb_typeof(f.x->'infoRequest'->'askedBy') = 'object' then (f.x->'infoRequest'->'askedBy')::text end,
  escalated_at = case when f.x->'escalation'->>'at' ~ '^\\d{4}-\\d{2}-\\d{2}' then (f.x->'escalation'->>'at')::timestamptz end,
  escalated_by = case when jsonb_typeof(f.x->'escalation'->'by') = 'object' then (f.x->'escalation'->'by')::text end,
  escalation_reason = f.x->'escalation'->>'reason',
  escalated_to = f.x->'escalation'->>'to',
  escalation_note = f.x->'escalation'->>'note',
  seller_replied_at = case when f.x->>'sellerRepliedAt' ~ '^\\d{4}-\\d{2}-\\d{2}' then (f.x->>'sellerRepliedAt')::timestamptz end,
  dispatch_overdue_due_at = case when f.x->'dispatchOverdue'->>'dueAt' ~ '^\\d{4}-\\d{2}-\\d{2}' then (f.x->'dispatchOverdue'->>'dueAt')::timestamptz end,
  dispatch_overdue_noted_at = case when f.x->'dispatchOverdue'->>'at' ~ '^\\d{4}-\\d{2}-\\d{2}' then (f.x->'dispatchOverdue'->>'at')::timestamptz end,
  overdue_notified_for = case when f.x->>'overdueNotified' ~ '^\\d{4}-\\d{2}-\\d{2}' then (f.x->>'overdueNotified')::timestamptz end,
  appeal_window_closed = coalesce((f.x->>'appealWindowClosed')::bool, false)
from f where f.id = c.id;
update support.cases set next_action = next_action - 'facts' where next_action ? 'facts';

-- 2. the decision waiting for approval
update support.cases set
  approval_request_id = case when decision_draft->'pending'->>'requestId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then (decision_draft->'pending'->>'requestId')::uuid end,
  pending_decision = (decision_draft->'pending') - 'requestId'
where jsonb_typeof(decision_draft->'pending') = 'object';
update support.cases set decision_draft = case when jsonb_typeof(decision_draft->'draft') = 'object' then decision_draft - 'pending' end
where decision_draft is not null and decision_draft ? 'pending';

-- 3. goodwill grants
alter table support.case_remedies add column goodwill_grant_id uuid;
comment on column support.case_remedies.goodwill_grant_id is 'wallet goodwill grant behind a goodwill credit remedy; wallet.goodwill.decided is matched on it';
create index on support.case_remedies (replacement_id);
create index on support.case_remedies (goodwill_grant_id);
`,
};
