import type { Migration } from '../../../../../kernel/migrations/index.js';

/**
 * Fulfilled by Marketly (fulfillment-service, phase 4): who ships the offer.
 * - official_warehouse for Official Store offers, seller for seller offers (backfilled from owner_type);
 * - marketly_service while fulfillment-service fulfils the offer (set by fulfillment-service.offer.service_changed).
 * Every existing offer was shipped by its owner, so the backfill is exact.
 */
export const m0004FulfilledBy: Migration = {
  id: '0004_fulfilled_by',
  sql: /* sql */ `
alter table offers.offers add column fulfilled_by text;
update offers.offers set fulfilled_by = case when owner_type = 'official' then 'official_warehouse' else 'seller' end;
alter table offers.offers alter column fulfilled_by set not null;
alter table offers.offers add constraint offers_fulfilled_by_check check (fulfilled_by in ('official_warehouse', 'seller', 'marketly_service'));
comment on column offers.offers.fulfilled_by is 'official_warehouse | seller | marketly_service (follows fulfillment-service.offer.service_changed)';
`,
};
