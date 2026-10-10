import type { Migration } from '../../../../../kernel/migrations/index.js';

/**
 * Gap pass 4: session facts out of jsonb into columns, backfilled from where they lived:
 * - email and contact_name from sessions.account (removed from the jsonb);
 * - payment_intent_id and payment_state from sessions.payment_selection (removed from the jsonb);
 * - quote_total from the stored quote (sessions.totals → totals.total.amount);
 * - order_attempt: the attempt number of the linked order (attempt_count, at least 1, as createOrder got it);
 * - visitor_key and personalization_allowed for guest ad attribution (unknown for existing sessions: null / false).
 */
const UUID = `'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'`;

export const m0002SessionColumns: Migration = {
  id: '0002_session_columns',
  sql: /* sql */ `
alter table checkout.sessions add column email text;
alter table checkout.sessions add column contact_name text;
alter table checkout.sessions add column visitor_key text;
alter table checkout.sessions add column personalization_allowed bool not null default false;
alter table checkout.sessions add column quote_total int not null default 0;
alter table checkout.sessions add column payment_intent_id uuid;
alter table checkout.sessions add column payment_state text check (payment_state in ('accepted', 'pending_check', 'failed', 'requires_action'));
alter table checkout.sessions add column order_attempt int;

update checkout.sessions set
  email = nullif(account->>'email', ''),
  contact_name = nullif(account->>'name', ''),
  account = account - 'email' - 'name',
  quote_total = coalesce(case when jsonb_typeof(totals->'totals'->'total'->'amount') = 'number' then (totals->'totals'->'total'->>'amount')::int end, 0),
  payment_intent_id = case when payment_selection->>'intentId' ~ ${UUID} then (payment_selection->>'intentId')::uuid end,
  payment_state = case when payment_selection->>'intentState' in ('accepted', 'pending_check', 'failed', 'requires_action') then payment_selection->>'intentState' end,
  payment_selection = case when payment_selection is null then null else payment_selection - 'intentId' - 'intentState' end,
  order_attempt = case when order_id is not null then greatest(1, attempt_count) end;

alter table checkout.sessions alter column personalization_allowed drop default;
alter table checkout.sessions alter column quote_total drop default;

comment on column checkout.sessions.account is 'kind, phone, createAccountAfter, marketingOptIn, hidePricesOnSlip; email and name are columns';
comment on column checkout.sessions.email is 'contact email: the customer''s, or the guest''s from the contact step; null until known';
comment on column checkout.sessions.contact_name is 'customer name, or the guest''s delivery address name';
comment on column checkout.sessions.visitor_key is 'the shopper''s app session id when the checkout started: the visitor id advertising keys ad clicks by';
comment on column checkout.sessions.personalization_allowed is 'the shopper allowed personalization: a signed-in customer''s personalizedRecommendations preference read at start; false for visitors, whose sessions carry no privacy choice';
comment on column checkout.sessions.quote_total is 'payable total of the quote at quote_version, minor units; Place order compares expectedTotal with it';
comment on column checkout.sessions.payment_selection is 'method kind, label, saved method id, decline, cancelled orders; the intent and its state are columns';
comment on column checkout.sessions.payment_intent_id is 'intent of the latest payment attempt';
comment on column checkout.sessions.order_attempt is 'payment attempt that order_id belongs to: the attemptNo passed to orders.createOrder';

create index on checkout.sessions (payment_intent_id);
create index on checkout.sessions using gin (email gin_trgm_ops);
create index on checkout.sessions using gin (contact_name gin_trgm_ops);
`,
};
