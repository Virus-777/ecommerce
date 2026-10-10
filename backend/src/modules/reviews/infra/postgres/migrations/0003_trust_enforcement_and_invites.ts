import type { Migration } from '../../../../../kernel/migrations/index.js';

/**
 * Pass 3:
 *  1. moderation_decisions.trust_enforcement_id: the trust enforcement a decision executed (remove_reviews,
 *     keep_reviews), so reversing that enforcement reinstates what it removed (decision D-R1).
 *  2. review_invites: delivered items waiting for a review invitation (decision D-R2), replacing the in-memory list
 *     of customers the invites job used to look at.
 */
export const m0003TrustEnforcementAndInvites: Migration = {
  id: '0003_trust_enforcement_and_invites',
  sql: /* sql */ `
alter table reviews.moderation_decisions add column trust_enforcement_id uuid;
create index on reviews.moderation_decisions (trust_enforcement_id);

create table reviews.review_invites (
  order_item_id uuid primary key,
  order_id uuid not null,
  customer_id uuid not null,
  product_id uuid not null,
  seller_id uuid not null,
  delivered_at timestamptz not null,
  due_at timestamptz not null,
  state text not null,
  sent_at timestamptz,
  updated_at timestamptz not null
);
create index on reviews.review_invites (state, due_at);
create index on reviews.review_invites (customer_id);
`,
};
