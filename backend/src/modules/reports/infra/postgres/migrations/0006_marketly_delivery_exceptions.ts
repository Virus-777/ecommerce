import type { Migration } from '../../../../../kernel/migrations/index.js';

/**
 * Fulfilled by Marketly: delivery issues (shipping.shipment.exception) of packages Marketly's warehouse shipped count
 * in fact_marketly_fulfillment_daily.delivery_exceptions, no longer in the seller's fact_service_daily row. Issues
 * recorded before stay where they were counted (the event carried fulfilledBy, but the claim does not say which row
 * took it): fulfillment-service ran in tests only before this release, so there is nothing to move.
 */
export const m0006MarketlyDeliveryExceptions: Migration = {
  id: '0006_marketly_delivery_exceptions',
  sql: /* sql */ `
alter table reports.fact_marketly_fulfillment_daily add column delivery_exceptions int not null default 0;
alter table reports.fact_marketly_fulfillment_daily alter column delivery_exceptions drop default;
comment on column reports.fact_marketly_fulfillment_daily.delivery_exceptions is 'shipping.shipment.exception on marketly_service packages (kept out of the seller''s fact_service_daily row)';
`,
};
