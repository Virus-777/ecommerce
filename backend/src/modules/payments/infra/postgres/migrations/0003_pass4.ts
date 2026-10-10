import type { Migration } from '../../../../../kernel/migrations/index.js';

/**
 * Gap pass 4: columns for what lived in jsonb or stood in for a missing column, each backfilled:
 * - intents.next_action: the bank challenge kept as method.pendingAction (removed from method);
 * - payments.dispute_log: the dispute history kept in evidence.history; disputes.approval_request_id and
 *   concession_reason from evidence.pendingConcession; disputes.due_soon_flagged_at from evidence.dueSoonFlagged
 *   (the time of the "Evidence due within 48 hours" entry); all three removed from evidence;
 * - refunds.checkout_session_id from the intent; refunds.order_id nullable: an orphan payment refund kept the
 *   checkout session id there, it becomes null;
 * - webhook_events.intent_id / refund_id from the event data (intentId or paymentRef, refundId or refundRef).
 */
const UUID = `'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'`;

export const m0003Pass4: Migration = {
  id: '0003_pass4',
  sql: /* sql */ `
alter table payments.intents add column next_action jsonb;
update payments.intents set next_action = case when status = 'requires_action' and jsonb_typeof(method->'pendingAction') = 'object' then method->'pendingAction' end,
  method = method - 'pendingAction'
where method ? 'pendingAction';
comment on column payments.intents.next_action is 'NextAction: the bank challenge waiting for the customer while the intent is requires_action; cleared when it ends';

create table payments.dispute_log (
  id uuid primary key,
  dispute_id uuid not null,
  label text not null,
  detail text,
  actor jsonb not null,
  at timestamptz not null
);
comment on table payments.dispute_log is 'Dispute history: opened, owner set, evidence saved and submitted, concession asked and decided, deadlines, outcome (Dispute.history)';
comment on column payments.dispute_log.actor is 'Actor';
create index on payments.dispute_log (dispute_id, at);
alter table payments.dispute_log add foreign key (dispute_id) references payments.disputes (id);

insert into payments.dispute_log (id, dispute_id, label, detail, actor, at)
select gen_random_uuid(), d.id, coalesce(h->>'label', 'Update'), h->>'detail', coalesce(h->'actor', '{"kind":"system","id":null}'::jsonb),
  case when h->>'at' ~ '^\\d{4}-\\d{2}-\\d{2}' then (h->>'at')::timestamptz else d.opened_at end
from payments.disputes d, jsonb_array_elements(case when jsonb_typeof(d.evidence->'history') = 'array' then d.evidence->'history' else '[]'::jsonb end) h;

alter table payments.disputes add column due_soon_flagged_at timestamptz;
alter table payments.disputes add column approval_request_id uuid;
alter table payments.disputes add column concession_reason text;
update payments.disputes d set
  approval_request_id = case when d.evidence->'pendingConcession'->>'approvalRequestId' ~ ${UUID} then (d.evidence->'pendingConcession'->>'approvalRequestId')::uuid end,
  concession_reason = d.evidence->'pendingConcession'->>'reason',
  due_soon_flagged_at = case when d.evidence->>'dueSoonFlagged' = 'true' then coalesce(
    (select max(l.at) from payments.dispute_log l where l.dispute_id = d.id and l.label = 'Evidence due within 48 hours'), d.opened_at) end,
  evidence = d.evidence - 'history' - 'pendingConcession' - 'dueSoonFlagged';
comment on column payments.disputes.due_soon_flagged_at is 'when payments.dispute-deadlines flagged the evidence due within 48 h; once per dispute';
comment on column payments.disputes.evidence is 'DisputeEvidence: text, file ids and refs, submitted at and by';
comment on column payments.disputes.approval_request_id is 'a concession waiting for approval: the access approval request; cleared when decided';
comment on column payments.disputes.concession_reason is 'reason given with the concession waiting for approval';
create index on payments.disputes (approval_request_id) where approval_request_id is not null;

alter table payments.refunds add column checkout_session_id uuid;
update payments.refunds r set checkout_session_id = i.checkout_session_id from payments.intents i where i.id = r.intent_id;
alter table payments.refunds alter column checkout_session_id set not null;
alter table payments.refunds alter column order_id drop not null;
update payments.refunds r set order_id = i.order_id from payments.intents i
where i.id = r.intent_id and r.origin = 'orphan_payment' and r.order_id = i.checkout_session_id and i.order_id is distinct from r.order_id;
comment on column payments.refunds.order_id is 'null for an orphan payment refund: money without an order';
comment on column payments.refunds.checkout_session_id is 'checkout session of the payment; what an orphan payment refund is found by';
create index on payments.refunds (checkout_session_id);

alter table payments.webhook_events add column intent_id uuid;
alter table payments.webhook_events add column refund_id uuid;
update payments.webhook_events w set refund_id = r.id, intent_id = r.intent_id
from payments.refunds r
where w.type like 'refund.%' and ((w.payload->'data'->>'refundId' ~ ${UUID} and r.id = (w.payload->'data'->>'refundId')::uuid) or (r.provider_ref is not null and r.provider_ref = w.payload->'data'->>'refundRef'));
update payments.webhook_events w set intent_id = i.id
from payments.intents i
where w.intent_id is null and i.provider = w.provider and ((w.payload->'data'->>'intentId' ~ ${UUID} and i.id = (w.payload->'data'->>'intentId')::uuid) or (i.provider_ref is not null and i.provider_ref = w.payload->'data'->>'paymentRef'));
update payments.webhook_events w set intent_id = d.intent_id
from payments.disputes d
where w.intent_id is null and w.type like 'dispute.%' and d.provider = w.provider and d.provider_case_id = w.payload->'data'->>'caseId';
comment on column payments.webhook_events.intent_id is 'the payment the event was applied to';
comment on column payments.webhook_events.refund_id is 'the refund the event was applied to';
create index on payments.webhook_events (intent_id, received_at);
create index on payments.webhook_events (refund_id, received_at);
`,
};
