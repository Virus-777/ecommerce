import type { Migration } from '../../../../../kernel/migrations/index.js';

/**
 * Fulfilled by Marketly (fulfillment-service, phase 4; reports spec tables and notes):
 *  1. fact_order_items.fulfilled_by: the group's PlacedGroup.fulfilledBy. Rows recorded before it was kept are filled
 *     from the owner: fulfillment-service could not run before this release, so an Official Store row was shipped by
 *     the official warehouse and a seller row by the seller.
 *  2. fact_marketplace_finance_daily.service_fees_minor: Fulfilled by Marketly fees charged less reversals (0 before).
 *  3. fact_marketly_fulfillment_daily: Marketly's dispatches for Fulfilled by Marketly groups, per seller of record and
 *     day (none before this release: nothing to move out of fact_service_daily).
 */
export const m0005FulfilledByMarketly: Migration = {
  id: '0005_fulfilled_by_marketly',
  sql: /* sql */ `
alter table reports.fact_order_items add column fulfilled_by text
  check (fulfilled_by in ('official_warehouse', 'seller', 'marketly_service'));
comment on column reports.fact_order_items.fulfilled_by is 'the group''s PlacedGroup.fulfilledBy from orders.order.placed (official_warehouse|seller|marketly_service)';
update reports.fact_order_items set fulfilled_by = case when owner_type = 'official' then 'official_warehouse' else 'seller' end
 where fulfilled_by is null;

alter table reports.fact_marketplace_finance_daily add column service_fees_minor bigint not null default 0;
alter table reports.fact_marketplace_finance_daily alter column service_fees_minor drop default;
comment on column reports.fact_marketplace_finance_daily.service_fees_minor is 'Fulfilled by Marketly fees charged less reversals (fulfillment-service.fee.charged / fee.reversed)';

create table reports.fact_marketly_fulfillment_daily (
  seller_id uuid not null,
  day date not null,
  dispatched int not null,
  dispatched_on_time int not null,
  overdue int not null
);
comment on table reports.fact_marketly_fulfillment_daily is 'Per seller of record and day: dispatches Marketly''s warehouse made for Fulfilled by Marketly groups (kept out of fact_service_daily so seller dispatch metrics only count what the seller shipped)';
create unique index on reports.fact_marketly_fulfillment_daily (seller_id, day);
`,
};
