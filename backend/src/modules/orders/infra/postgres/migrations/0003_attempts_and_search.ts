import type { Migration } from '../../../../../kernel/migrations/index.js';

/**
 * Gap pass 3:
 * - one order per payment attempt: createOrder is idempotent per (checkout_session_id, attempt_no), so a retry
 *   after a finally declined pending payment creates a new order (the cancelled one stays);
 * - the saved customer address the delivery address came from;
 * - order search without the tsvector (decision S-D2): trigram indexes on contact name and email;
 * - checkout_line_id optional (replacement lines have none) and split chains indexed.
 */
export const m0003AttemptsAndSearch: Migration = {
  id: '0003_attempts_and_search',
  sql: /* sql */ `
alter table orders.orders add column attempt_no int not null default 1;
alter table orders.orders add column delivery_address_id uuid;
alter table orders.orders drop constraint if exists orders_checkout_session_id_key;
create unique index orders_checkout_session_attempt_key on orders.orders (checkout_session_id, attempt_no);
alter table orders.orders drop column if exists search;
create index on orders.orders using gin (contact_name gin_trgm_ops);
create index on orders.orders using gin (contact_email gin_trgm_ops);
alter table orders.order_items alter column checkout_line_id drop not null;
create index on orders.order_items (split_from_item_id);
`,
};
