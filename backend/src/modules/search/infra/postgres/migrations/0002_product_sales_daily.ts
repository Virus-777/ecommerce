import type { Migration } from '../../../../../kernel/migrations/index.js';

/**
 * Units and orders per product per market day (decision S-D3): orders.order.placed adds, orders.order.cancelled
 * subtracts (both inbox-claimed), and search.sales-counts sums the last 30 days into search_documents.sales_30d.
 * Starts empty: the counts before it came from the decayed popularity, which the nightly job replaces.
 */
export const m0002ProductSalesDaily: Migration = {
  id: '0002_product_sales_daily',
  sql: /* sql */ `
create table search.product_sales_daily (
  product_id uuid not null,
  day date not null,
  units int not null,
  orders int not null,
  updated_at timestamptz not null,
  primary key (product_id, day)
);
comment on table search.product_sales_daily is 'Units and orders per product per market day (decision S-D3), fed idempotently by orders events through the inbox; the nightly job sums the last 30 days into search_documents.sales_30d. Rebuildable from orders';
comment on column search.product_sales_daily.day is 'market time zone';
create index on search.product_sales_daily (day);
`,
};
