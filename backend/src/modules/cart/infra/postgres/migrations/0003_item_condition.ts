import type { Migration } from '../../../../../kernel/migrations/index.js';

/**
 * Gap pass 4: cart_items.condition, the offer's condition when the line was added (or switched), so a seller
 * restriction scoped by condition is decided on the line without reading offers, and the line still shows its
 * condition when offers cannot answer.
 *
 * Backfill: the condition lives only in offers (another module's schema), so existing lines start null and are
 * filled by the next check of the line (every GET /cart re-checks all lines; the recheck job checks queued ones).
 * Until then a condition-scoped restriction re-checks such lines through offers, as before.
 */
export const m0003ItemCondition: Migration = {
  id: '0003_item_condition',
  sql: /* sql */ `
alter table cart.cart_items add column condition text check (condition in ('new', 'used_like_new', 'used_good', 'used_acceptable', 'refurbished'));
comment on column cart.cart_items.condition is 'offer condition at add; null only for lines added before it was kept, until their next check';
`,
};
