import type { Migration } from '../../../../../kernel/migrations/index.js';

/**
 * Conversations with the Official Store had no seller id (seller_id null, told apart from support by kind =
 * 'order'); they now store the spec constant OFFICIAL_STORE_ID (common.json), so the conversation key is unique
 * without naming an order item. Where two such rows share a key (possible while the seller id was null), the
 * oldest takes the id and the others keep null, which is still read as the Official Store.
 */
export const m0002OfficialStoreId: Migration = {
  id: '0002_official_store_id',
  sql: /* sql */ `
with ranked as (
  select id, row_number() over (partition by customer_id, order_id, order_item_id, return_id order by created_at, id) as n
  from messaging.conversations
  where kind = 'order' and seller_id is null
)
update messaging.conversations c set seller_id = '00000000-0000-7000-8000-000000000001'
  from ranked r
  where c.id = r.id and r.n = 1;
`,
};
