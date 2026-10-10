import type { Migration } from '../../../../../kernel/migrations/index.js';

/**
 * Fulfilled by Marketly (fulfillment-service, phase 4): who physically ships a group, kept on the dispatch watch,
 * shipments and exceptions (official_warehouse | seller | marketly_service). Before this every warehouse package was
 * an Official Store one and every seller package the seller's, so existing rows are backfilled from owner_type.
 */
export const m0004FulfilledByMarketly: Migration = {
  id: '0004_fulfilled_by_marketly',
  sql: /* sql */ `
alter table shipping.shipments add column fulfilled_by text;
update shipping.shipments set fulfilled_by = case when owner_type = 'official' then 'official_warehouse' else 'seller' end where fulfilled_by is null;
alter table shipping.shipments alter column fulfilled_by set not null;
alter table shipping.shipments add constraint shipments_fulfilled_by_check check (fulfilled_by in ('official_warehouse', 'seller', 'marketly_service'));
comment on column shipping.shipments.fulfilled_by is 'who ships the package: marketly_service is a seller''s package Marketly''s warehouse ships (left out of the seller''s dispatch metrics)';

alter table shipping.dispatch_watch add column fulfilled_by text;
update shipping.dispatch_watch set fulfilled_by = case when owner_type = 'official' then 'official_warehouse' else 'seller' end where fulfilled_by is null;
alter table shipping.dispatch_watch alter column fulfilled_by set not null;
alter table shipping.dispatch_watch add constraint dispatch_watch_fulfilled_by_check check (fulfilled_by in ('official_warehouse', 'seller', 'marketly_service'));
comment on column shipping.dispatch_watch.fulfilled_by is 'marketly_service groups follow the Official schedule; overdue is the warehouse''s, not the seller''s';

alter table shipping.exceptions add column fulfilled_by text;
update shipping.exceptions set fulfilled_by = case when owner_type = 'official' then 'official_warehouse' else 'seller' end where fulfilled_by is null;
alter table shipping.exceptions alter column fulfilled_by set not null;
alter table shipping.exceptions add constraint exceptions_fulfilled_by_check check (fulfilled_by in ('official_warehouse', 'seller', 'marketly_service'));
comment on column shipping.exceptions.fulfilled_by is 'marketly_service: owned by the Shipping Manager, no seller notice and no seller response';
`,
};
