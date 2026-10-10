import type { Migration } from '../../../../../kernel/migrations/index.js';

/**
 * Fulfilled by Marketly end to end (decisions D1–D12):
 * - enrollments: the application's own columns (expected_skus, expected_monthly_units, categories, contact_note) and
 *   seller_suspension_id. Applications used to keep the expected SKU count in max_skus and the applicant's note in
 *   reason: an application still waiting (applied) moves its note to contact_note; expected_skus starts from max_skus.
 * - sku_enrollments: hazmat and notes declared at enrollment (an enrolled SKU was never hazardous: false).
 * - inbound_shipments: the unused warehouse_receipt_id goes; inbound_receipts holds each receiving record submitted to
 *   inventory as a service receipt.
 * - fulfillment_requests: order_ref (from the items' orderRef) and short_reported_at; every item gets `shipped`
 *   (shipped requests: every uncancelled unit, others 0).
 * - service_returns: return_ref (from the ledger movement that brought the units in, which carries the service
 *   return's id), order_item_id (unknown for rows made before returns named their items: the row's own id, which
 *   keeps unique (return_id, order_item_id) and matches no order item) and proposed_outcome.
 * - removal_orders: reason, fee_amount (the removal or disposal fees charged), approved_at and completed_at (from the
 *   ledger movements of the removal).
 * - stock_differences: the daily reconciliation's findings.
 */
export const m0004FulfilledByMarketly: Migration = {
  id: '0004_fulfilled_by_marketly',
  sql: /* sql */ `
alter table fulfillment_service.enrollments
  add column if not exists expected_skus int,
  add column if not exists expected_monthly_units int,
  add column if not exists categories jsonb,
  add column if not exists contact_note text,
  add column if not exists seller_suspension_id uuid;
update fulfillment_service.enrollments set expected_skus = max_skus where expected_skus is null;
update fulfillment_service.enrollments set expected_monthly_units = 0 where expected_monthly_units is null;
update fulfillment_service.enrollments set categories = '[]'::jsonb where categories is null;
update fulfillment_service.enrollments set contact_note = reason, reason = null where state = 'applied' and contact_note is null and reason is not null;
alter table fulfillment_service.enrollments
  alter column expected_skus set not null,
  alter column expected_monthly_units set not null,
  alter column categories set not null;

alter table fulfillment_service.sku_enrollments
  add column if not exists hazmat bool,
  add column if not exists notes text;
update fulfillment_service.sku_enrollments set hazmat = false where hazmat is null;
alter table fulfillment_service.sku_enrollments alter column hazmat set not null;

alter table fulfillment_service.inbound_shipments drop column if exists warehouse_receipt_id;

create table if not exists fulfillment_service.inbound_receipts (
  id uuid primary key,
  inbound_id uuid not null references fulfillment_service.inbound_shipments (id),
  seq int not null,
  inventory_receipt_id uuid,
  lines jsonb not null,
  state text not null,
  counted_by text not null,
  counted_at timestamptz not null,
  confirmed_by text,
  confirmed_at timestamptz
);
comment on table fulfillment_service.inbound_receipts is 'One row per receiving record of an inbound shipment, submitted to inventory as a service receipt and confirmed by the Inventory Manager';
create unique index if not exists inbound_receipts_inbound_seq on fulfillment_service.inbound_receipts (inbound_id, seq);
create index if not exists inbound_receipts_inventory on fulfillment_service.inbound_receipts (inventory_receipt_id);

alter table fulfillment_service.fulfillment_requests
  add column if not exists order_ref text,
  add column if not exists short_reported_at timestamptz;
update fulfillment_service.fulfillment_requests set order_ref = coalesce(items -> 0 ->> 'orderRef', '') where order_ref is null;
alter table fulfillment_service.fulfillment_requests alter column order_ref set not null;
update fulfillment_service.fulfillment_requests r set items = (
  select coalesce(jsonb_agg(
    case when i ? 'shipped' then i
    else i || jsonb_build_object('shipped', case when r.state = 'shipped' then greatest(0, coalesce((i ->> 'quantity')::int, 0) - coalesce((i ->> 'cancelled')::int, 0)) else 0 end)
    end order by n), '[]'::jsonb)
  from jsonb_array_elements(r.items) with ordinality as e(i, n)
) where jsonb_typeof(r.items) = 'array';

alter table fulfillment_service.service_returns
  add column if not exists return_ref text,
  add column if not exists order_item_id uuid,
  add column if not exists proposed_outcome text;
update fulfillment_service.service_returns s set return_ref = coalesce((select l.reference from fulfillment_service.ownership_ledger l where l.id = s.id), '') where return_ref is null;
update fulfillment_service.service_returns set order_item_id = id where order_item_id is null;
alter table fulfillment_service.service_returns
  alter column return_ref set not null,
  alter column order_item_id set not null;
create unique index if not exists service_returns_return_item on fulfillment_service.service_returns (return_id, order_item_id);

alter table fulfillment_service.removal_orders
  add column if not exists reason text,
  add column if not exists fee_amount bigint,
  add column if not exists approved_at timestamptz,
  add column if not exists completed_at timestamptz;
update fulfillment_service.removal_orders r set
  approved_at = (select min(l.at) from fulfillment_service.ownership_ledger l where l.reference = r.ref and l.seller_id = r.seller_id and l.movement = 'removal_reserved')
  where approved_at is null and state in ('approved', 'processing', 'shipped', 'completed');
update fulfillment_service.removal_orders r set
  completed_at = (select max(l.at) from fulfillment_service.ownership_ledger l where l.reference = r.ref and l.seller_id = r.seller_id and l.movement in ('removed', 'disposed')),
  fee_amount = (select sum(c.amount) from fulfillment_service.fee_charges c where c.reference = r.ref and c.seller_id = r.seller_id and c.type in ('removal', 'disposal') and c.state <> 'reversed')
  where completed_at is null and state = 'completed';

create table if not exists fulfillment_service.stock_differences (
  id uuid primary key,
  seller_id uuid not null,
  sku_enrollment_id uuid not null references fulfillment_service.sku_enrollments (id),
  day date not null,
  ledger jsonb not null,
  inventory jsonb not null,
  state text not null,
  decision text,
  reason text,
  amount bigint,
  approval_request_id uuid,
  decided_by text,
  decided_at timestamptz
);
comment on table fulfillment_service.stock_differences is 'Daily reconciliation differences between the ownership ledger and inventory at the service location, per SKU';
create unique index if not exists stock_differences_sku_day on fulfillment_service.stock_differences (sku_enrollment_id, day);
create index if not exists stock_differences_state_day on fulfillment_service.stock_differences (state, day);
create index if not exists stock_differences_seller on fulfillment_service.stock_differences (seller_id, state);
`,
};
