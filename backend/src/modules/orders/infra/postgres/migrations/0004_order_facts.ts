import type { Migration } from '../../../../../kernel/migrations/index.js';

/**
 * Gap pass 4: the event-fed facts kept in orders.flags (jsonb) move to orders.order_facts, one row per source
 * record (captures, chargebacks, cases, refunds sent, approved return refunds, delivery exceptions, seller
 * restrictions, resent confirmations), and the materialized flag kinds to orders.flag_kinds (text[]).
 * Existing orders are backfilled from the jsonb before it is dropped; values that are not ids are skipped.
 */
const UUID = `'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'`;
const ts = (expr: string) => `case when (${expr}) ~ '^\\d{4}-\\d{2}-\\d{2}' then (${expr})::timestamptz end`;
const ids = (expr: string) => `(select coalesce(array_agg(v::uuid), '{}') from jsonb_array_elements_text(coalesce(${expr}, '[]'::jsonb)) v where v ~ ${UUID})`;

export const m0004OrderFacts: Migration = {
  id: '0004_order_facts',
  sql: /* sql */ `
create table orders.order_facts (
  id uuid primary key,
  order_id uuid not null,
  kind text not null check (kind in ('capture', 'chargeback', 'case', 'refund_sent', 'refund_approval', 'delivery_issue', 'seller_restricted', 'confirmation_resent')),
  source_id uuid not null,
  group_id uuid,
  shipment_id uuid,
  ref text,
  status text,
  subkind text,
  customer_action text,
  amount int,
  item_ids uuid[],
  due_at timestamptz,
  at timestamptz not null
);
comment on table orders.order_facts is 'Event-fed facts about an order, one row per source record: payment captures, chargebacks, support cases, refunds sent, approved return refunds not sent yet, delivery exceptions, seller restrictions and resent confirmations. The flags, alerts, expected refunds and case references are derived from them';
comment on column orders.order_facts.source_id is 'the capture, dispute, case, refund, refund request, exception or seller group id; a new id for a resent confirmation';
comment on column orders.order_facts.ref is 'case ref, return ref, dispute ref';
comment on column orders.order_facts.status is 'case: open|resolved|closed…; refund_approval: approved|sent';
comment on column orders.order_facts.subkind is 'dispute kind, exception kind';
comment on column orders.order_facts.customer_action is 'delivery issue: what the customer is asked to do';
comment on column orders.order_facts.amount is 'capture, approved refund';
comment on column orders.order_facts.item_ids is 'case and approved refund items';
comment on column orders.order_facts.due_at is 'delivery issue due, case next update';
create unique index on orders.order_facts (order_id, kind, source_id);
create index on orders.order_facts (kind, source_id);
alter table orders.order_facts add foreign key (order_id) references orders.orders (id);

insert into orders.order_facts (id, order_id, kind, source_id, amount, at)
select gen_random_uuid(), o.id, 'capture', (c->>'captureId')::uuid, coalesce((c->>'amount')::int, 0), coalesce(${ts(`c->>'at'`)}, o.placed_at)
from orders.orders o, jsonb_array_elements(coalesce(o.flags->'captures', '[]'::jsonb)) c
where c->>'captureId' ~ ${UUID}
on conflict do nothing;

insert into orders.order_facts (id, order_id, kind, source_id, subkind, group_id, at)
select gen_random_uuid(), o.id, 'chargeback', (c->>'disputeId')::uuid, c->>'kind', case when c->>'groupId' ~ ${UUID} then (c->>'groupId')::uuid end, coalesce(${ts(`c->>'at'`)}, o.placed_at)
from orders.orders o, jsonb_array_elements(coalesce(o.flags->'chargebacks', '[]'::jsonb)) c
where c->>'disputeId' ~ ${UUID}
on conflict do nothing;

insert into orders.order_facts (id, order_id, kind, source_id, ref, item_ids, status, due_at, at)
select gen_random_uuid(), o.id, 'case', (c->>'caseId')::uuid, c->>'ref', ${ids(`c->'itemIds'`)}, coalesce(c->>'status', 'open'), ${ts(`c->>'nextUpdateBy'`)}, o.placed_at
from orders.orders o, jsonb_array_elements(coalesce(o.flags->'cases', '[]'::jsonb)) c
where c->>'caseId' ~ ${UUID}
on conflict do nothing;

insert into orders.order_facts (id, order_id, kind, source_id, at)
select gen_random_uuid(), o.id, 'refund_sent', v::uuid, o.placed_at
from orders.orders o, jsonb_array_elements_text(coalesce(o.flags->'refundsSent', '[]'::jsonb)) v
where v ~ ${UUID}
on conflict do nothing;

insert into orders.order_facts (id, order_id, kind, source_id, ref, amount, item_ids, status, at)
select gen_random_uuid(), o.id, 'refund_approval', (a->>'id')::uuid, a->>'returnRef', coalesce((a->>'amount')::int, 0), ${ids(`a->'itemIds'`)}, 'approved', o.placed_at
from orders.orders o, jsonb_array_elements(coalesce(o.flags->'refundApprovals', '[]'::jsonb)) a
where a->>'id' ~ ${UUID}
on conflict do nothing;

insert into orders.order_facts (id, order_id, kind, source_id, subkind, group_id, shipment_id, due_at, customer_action, at)
select gen_random_uuid(), o.id, 'delivery_issue', (d->>'exceptionId')::uuid, d->>'kind', case when d->>'groupId' ~ ${UUID} then (d->>'groupId')::uuid end,
  case when d->>'shipmentId' ~ ${UUID} then (d->>'shipmentId')::uuid end, ${ts(`d->>'dueAt'`)}, d->>'customerAction', coalesce(${ts(`d->>'at'`)}, o.placed_at)
from orders.orders o, jsonb_array_elements(coalesce(o.flags->'deliveryIssues', '[]'::jsonb)) d
where d->>'exceptionId' ~ ${UUID}
on conflict do nothing;

insert into orders.order_facts (id, order_id, kind, source_id, group_id, at)
select gen_random_uuid(), o.id, 'seller_restricted', v::uuid, v::uuid, o.placed_at
from orders.orders o, jsonb_array_elements_text(coalesce(o.flags->'restrictedGroups', '[]'::jsonb)) v
where v ~ ${UUID}
on conflict do nothing;

insert into orders.order_facts (id, order_id, kind, source_id, at)
select gen_random_uuid(), o.id, 'confirmation_resent', gen_random_uuid(), o.placed_at
from orders.orders o, generate_series(1, coalesce((o.flags->>'confirmationsResent')::int, 0))
where jsonb_typeof(o.flags->'confirmationsResent') = 'number';

alter table orders.orders add column flag_kinds text[] not null default '{}';
update orders.orders set flag_kinds = coalesce((select array_agg(k) from jsonb_array_elements_text(coalesce(flags->'kinds', '[]'::jsonb)) k), '{}');
alter table orders.orders alter column flag_kinds drop default;
comment on column orders.orders.flag_kinds is 'OrderFlag kinds in force, recomputed on every change and by orders.refresh-flags';
create index on orders.orders using gin (flag_kinds);
alter table orders.orders drop column flags;
`,
};
