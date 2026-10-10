import type { Migration } from '../../../../../kernel/migrations/index.js';

/**
 * Fulfilled by Marketly (fulfillment-service, phase 4): a fulfillment is either an Official Store group
 * (official_warehouse) or a seller's group Marketly fulfils from seller-owned stock at the service location
 * (marketly_service, with the seller of record kept for the packing slip and the packed event).
 * Every fulfillment created before this migration is an Official Store one.
 */
export const m0003FulfilledByMarketly: Migration = {
  id: '0003_fulfilled_by_marketly',
  sql: /* sql */ `
alter table warehouse.fulfillments add column fulfilled_by text not null default 'official_warehouse';
alter table warehouse.fulfillments alter column fulfilled_by drop default;
alter table warehouse.fulfillments add constraint fulfillments_fulfilled_by_check check (fulfilled_by in ('official_warehouse', 'marketly_service'));
comment on column warehouse.fulfillments.fulfilled_by is 'official_warehouse|marketly_service';
alter table warehouse.fulfillments add column seller_id uuid;
comment on column warehouse.fulfillments.seller_id is 'seller of record of a marketly_service group';
alter table warehouse.fulfillments add column seller_name text;
comment on table warehouse.fulfillments is 'One per Official Store or Fulfilled by Marketly seller group of an accepted order';
`,
};
