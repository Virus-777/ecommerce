import type { Migration } from '../../../../../kernel/migrations/index.js';

/**
 * Gap pass 3:
 * - captures.credit_amount: the store-credit share charged with a capture (a credit-only capture is a succeeded
 *   row with amount 0 and no provider call). Existing captures take it from the shares kept on the tender.
 * - intents (status, updated_at, id): the expiry sweep walks every live authorization in keyset pages.
 * - refunds: cancellations get one refund per item with origin_id = the cancellation id, so the (origin, origin_id)
 *   uniqueness no longer applies to them; a plain (origin, origin_id) index keeps the lookups.
 * - refunds.destination_ref (a customer-chosen destination, kept until sent or cancelled) and refunds.attempt_key
 *   (provider idempotency key of the attempt in flight), so checks and retries after a restart ask about, and
 *   resend to, the same attempt and destination.
 */
export const m0002Pass3: Migration = {
  id: '0002_pass3',
  sql: /* sql */ `
alter table payments.captures add column credit_amount int not null default 0;
update payments.captures c set credit_amount = coalesce((
  select (t->'captureCredits'->(c.id::text)->>'amount')::int
  from payments.intents i, jsonb_array_elements(i.tenders) t
  where i.id = c.intent_id and t->'captureCredits' ? c.id::text
  limit 1), 0);
alter table payments.captures add constraint captures_amounts check (amount >= 0 and credit_amount >= 0);

create index intents_status_updated_id on payments.intents (status, updated_at, id);

drop index if exists payments.refunds_origin_origin_id_idx;
create unique index refunds_one_per_origin on payments.refunds (origin, origin_id) where origin_id is not null and origin <> 'cancellation' and status <> 'cancelled';
create index refunds_origin_lookup on payments.refunds (origin, origin_id);

alter table payments.refunds add column destination_ref text;
alter table payments.refunds add column attempt_key text;
`,
};
