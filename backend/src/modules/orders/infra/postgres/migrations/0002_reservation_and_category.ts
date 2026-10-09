import type { Migration } from '../../../../../kernel/migrations/index.js';

/**
 * Spec correctness pass: the checkout's stock hold on the order (carried on orders.order.accepted so inventory
 * can allocate from it) and the product category at purchase on each item (finance category fee rates,
 * returns category exceptions). Existing items take the category kept in their product snapshot.
 */
export const m0002ReservationAndCategory: Migration = {
  id: '0002_reservation_and_category',
  sql: /* sql */ `
alter table orders.orders add column reservation_id uuid;
alter table orders.order_items add column category_id uuid;
update orders.order_items set category_id = (product_snapshot->>'categoryId')::uuid
  where category_id is null and product_snapshot->>'categoryId' ~ '^[0-9a-fA-F-]{36}$';
create index on orders.order_items (category_id);
`,
};
