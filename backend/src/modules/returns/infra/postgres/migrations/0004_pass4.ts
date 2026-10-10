import type { Migration } from '../../../../../kernel/migrations/index.js';

const UUID_RE = `'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'`;

/**
 * Gap pass 4: what pass 3 kept in jsonb and marker rows gets columns and tables, backfilled.
 *
 * - returns.received_at: from the 'received_at' marker rows of return_events (the receipt time), which are deleted.
 * - refund_requests: destination, destination_label, max_refundable, remedy_kind, tax_refund, customer_id,
 *   contact_email, customer_name, seller_name, order_ref, note, approved_at and sent_at come out of the
 *   deductions jsonb, which keeps only the deductions list.
 * - refund_request_items: from order_item_ids (order kept as position) with the per-item split (perItem;
 *   without one the total on the first item) and the refunded quantities (items); order_item_ids is dropped.
 * - refund_request_events: the request history (deductions.history), ids derived from the request id and position.
 */
export const m0004Pass4: Migration = {
  id: '0004_pass4',
  sql: /* sql */ `
-- ---------------------------------------------------------------- returns.received_at
alter table returns.returns add column received_at timestamptz;
update returns.returns r set received_at = e.at
from (select distinct on (return_id) return_id, at from returns.return_events where kind = 'received_at' order by return_id, at desc) e
where e.return_id = r.id;
delete from returns.return_events where kind = 'received_at';

-- ---------------------------------------------------------------- refund request columns
alter table returns.refund_requests
  add column customer_id uuid,
  add column contact_email text,
  add column customer_name text,
  add column seller_name text,
  add column order_ref text,
  add column tax_refund bigint,
  add column max_refundable bigint,
  add column destination text,
  add column destination_label text,
  add column remedy_kind text,
  add column approved_at timestamptz,
  add column sent_at timestamptz,
  add column note text;

update returns.refund_requests set
  customer_id = case when deductions ->> 'customerId' ~ ${UUID_RE} then (deductions ->> 'customerId')::uuid end,
  contact_email = deductions ->> 'contactEmail',
  customer_name = deductions ->> 'customerName',
  seller_name = deductions ->> 'sellerName',
  order_ref = deductions ->> 'orderRef',
  tax_refund = nullif(deductions ->> 'taxRefund', '')::bigint,
  max_refundable = coalesce(nullif(deductions ->> 'maxRefundable', '')::bigint, total),
  destination = case when deductions ->> 'destination' = 'store_credit' then 'store_credit' else 'original_method' end,
  destination_label = coalesce(deductions ->> 'destinationLabel', case when deductions ->> 'destination' = 'store_credit' then 'Marketly store credit' else 'Original payment method' end),
  remedy_kind = coalesce(deductions ->> 'kind', source),
  approved_at = nullif(deductions ->> 'approvedAt', '')::timestamptz,
  sent_at = nullif(deductions ->> 'sentAt', '')::timestamptz,
  note = deductions ->> 'note'
where jsonb_typeof(deductions) = 'object';
update returns.refund_requests set max_refundable = total where max_refundable is null;
update returns.refund_requests set destination = 'original_method' where destination is null;
update returns.refund_requests set destination_label = 'Original payment method' where destination_label is null;
update returns.refund_requests set remedy_kind = source where remedy_kind is null;
-- a request made on a return: the customer of the return
update returns.refund_requests q set customer_id = r.customer_id
from returns.returns r where r.id = q.return_id and q.customer_id is null and r.customer_id is not null;

-- ---------------------------------------------------------------- refund request items
create table returns.refund_request_items (
  refund_request_id uuid not null,
  order_item_id uuid not null,
  position int not null,
  quantity int,
  amount bigint not null,
  primary key (refund_request_id, order_item_id)
);
comment on table returns.refund_request_items is 'The order items a refund request covers, with the amount refunded on each and the refunded quantity';
create index on returns.refund_request_items (order_item_id);
alter table returns.refund_request_items add foreign key (refund_request_id) references returns.refund_requests (id);

insert into returns.refund_request_items (refund_request_id, order_item_id, position, quantity, amount)
select q.id, (e.value #>> '{}')::uuid, (e.n - 1)::int,
  (select (x ->> 'quantity')::int from jsonb_array_elements(case when jsonb_typeof(q.deductions -> 'items') = 'array' then q.deductions -> 'items' else '[]'::jsonb end) x where x ->> 'orderItemId' = e.value #>> '{}' limit 1),
  case
    when jsonb_typeof(q.deductions -> 'perItem') = 'array' and jsonb_array_length(q.deductions -> 'perItem') > 0
      then coalesce((select (p ->> 'amount')::bigint from jsonb_array_elements(q.deductions -> 'perItem') p where p ->> 'orderItemId' = e.value #>> '{}' limit 1), 0)
    when e.n = 1 then q.total
    else 0
  end
from returns.refund_requests q, jsonb_array_elements(q.order_item_ids) with ordinality e(value, n)
where jsonb_typeof(q.order_item_ids) = 'array' and (e.value #>> '{}') ~ ${UUID_RE}
on conflict do nothing;

-- ---------------------------------------------------------------- refund request history
create table returns.refund_request_events (
  id uuid primary key,
  refund_request_id uuid not null,
  at timestamptz not null,
  label text not null,
  detail text,
  actor_kind text,
  actor_id text,
  actor_name text
);
comment on table returns.refund_request_events is 'History of a refund request (RefundRequest.history)';
create index on returns.refund_request_events (refund_request_id, at);
alter table returns.refund_request_events add foreign key (refund_request_id) references returns.refund_requests (id);

insert into returns.refund_request_events (id, refund_request_id, at, label, detail, actor_kind, actor_id, actor_name)
select md5(q.id::text || ':history:' || h.n)::uuid, q.id, coalesce(nullif(h.value ->> 'at', '')::timestamptz, q.created_at), coalesce(h.value ->> 'label', 'Refund updated'), h.value ->> 'detail',
  h.value -> 'actor' ->> 'kind', h.value -> 'actor' ->> 'id', h.value -> 'actor' ->> 'name'
from returns.refund_requests q, jsonb_array_elements(q.deductions -> 'history') with ordinality h(value, n)
where jsonb_typeof(q.deductions) = 'object' and jsonb_typeof(q.deductions -> 'history') = 'array';

-- ---------------------------------------------------------------- deductions keeps the list only
update returns.refund_requests set deductions = case when jsonb_typeof(deductions -> 'list') = 'array' then deductions -> 'list' else '[]'::jsonb end
where jsonb_typeof(deductions) = 'object';
alter table returns.refund_requests drop column order_item_ids;
alter table returns.refund_requests
  alter column max_refundable set not null,
  alter column destination set not null,
  alter column destination_label set not null,
  alter column remedy_kind set not null,
  add constraint refund_requests_destination check (destination in ('original_method', 'store_credit'));
create index on returns.refund_requests (customer_id, created_at);
`,
};
