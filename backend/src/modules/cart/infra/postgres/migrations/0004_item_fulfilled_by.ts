import type { Migration } from '../../../../../kernel/migrations/index.js';

/**
 * Fulfilled by Marketly: cart_items.fulfilled_by, who ships the line (offers Offer.shipping.fulfilledBy) at its last
 * check. It is part of the package key, so a seller's Marketly-fulfilled and self-shipped items are separate packages.
 *
 * Backfill: until this version no line could be Marketly-fulfilled (fulfillment-service was never enabled), so
 * Official Store lines are official_warehouse and seller lines seller. The next check of a line keeps it current.
 */
export const m0004ItemFulfilledBy: Migration = {
  id: '0004_item_fulfilled_by',
  sql: /* sql */ `
alter table cart.cart_items add column fulfilled_by text check (fulfilled_by in ('official_warehouse', 'seller', 'marketly_service'));
update cart.cart_items set fulfilled_by = case when owner_type = 'official' then 'official_warehouse' else 'seller' end where fulfilled_by is null;
comment on column cart.cart_items.fulfilled_by is 'Offer.shipping.fulfilledBy at the last check; null only for lines added before it was kept, until their next check';
`,
};
