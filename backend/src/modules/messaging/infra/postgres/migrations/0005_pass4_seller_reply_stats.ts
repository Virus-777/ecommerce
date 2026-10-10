import type { Migration } from '../../../../../kernel/migrations/index.js';

/**
 * Pass 4 (spec table seller_reply_stats): the 30-day reply figures per seller move from an in-process cache into a
 * table rolled up by messaging.response-stats. The cache never reached the database, so there is nothing to copy:
 * a seller without a row is computed on first use (conversation views, Seller.replyStats) and by the hourly job.
 */
export const m0005Pass4SellerReplyStats: Migration = {
  id: '0005_pass4_seller_reply_stats',
  sql: /* sql */ `
create table messaging.seller_reply_stats (
  seller_id uuid primary key,
  period_from date not null,
  period_to date not null,
  average_reply_minutes int,
  median_reply_minutes int,
  replied int not null,
  replied_within_target int not null,
  decided int not null,
  computed_at timestamptz not null
);
comment on table messaging.seller_reply_stats is '30-day reply figures per seller, rolled up by messaging.response-stats (behind ''Usually replies within …'' on conversations and Seller.replyStats); computed on first use for a seller without a row';
comment on column messaging.seller_reply_stats.replied is 'reply rounds answered';
comment on column messaging.seller_reply_stats.decided is 'rounds answered or past the reply target';
create index on messaging.seller_reply_stats (computed_at);
`,
};
