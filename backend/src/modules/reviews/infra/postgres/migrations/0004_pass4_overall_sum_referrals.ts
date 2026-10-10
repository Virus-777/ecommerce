import type { Migration } from '../../../../../kernel/migrations/index.js';

/**
 * Pass 4 (spec tables seller_feedback_summaries, referrals):
 *  1. seller_feedback_summaries.overall_sum: the sum of overall ratings in the period, so the average is read from the
 *     summary row (it was computed live from seller_feedback). Backfilled with the published, visible feedback of the
 *     last 12 months (the sellerRatingPeriodMonths default); the reviews.summaries job recomputes every row with the
 *     period in force.
 *  2. referrals: referrals to Trust and Risk were stored as moderation_decisions rows with decision 'refer' (filtered
 *     out everywhere). They move to their own table and the fake decision rows are removed.
 */
export const m0004Pass4OverallSumReferrals: Migration = {
  id: '0004_pass4_overall_sum_referrals',
  sql: /* sql */ `
alter table reviews.seller_feedback_summaries add column overall_sum int not null default 0;
comment on column reviews.seller_feedback_summaries.overall_sum is 'sum of overall ratings in the period: average = overall_sum / count';
update reviews.seller_feedback_summaries s set overall_sum = coalesce((
  select sum(f.overall) from reviews.seller_feedback f
  where f.seller_id = s.seller_id and f.status = 'published' and f.visible and f.created_at >= now() - interval '12 months'
), 0);
alter table reviews.seller_feedback_summaries alter column overall_sum drop default;

create table reviews.referrals (
  id uuid primary key,
  moderation_item_id uuid not null references reviews.moderation_items (id),
  content_type text not null,
  content_id uuid not null,
  author_id text not null,
  note text not null,
  referred_by uuid not null,
  referred_at timestamptz not null
);
comment on table reviews.referrals is 'Content referred to Trust and Risk from moderation (referToTrust; reviews.content.referred). Not a moderation decision: the item stays open';
comment on column reviews.referrals.referred_by is 'staff id';
create index on reviews.referrals (moderation_item_id);
create index on reviews.referrals (content_type, content_id);

insert into reviews.referrals (id, moderation_item_id, content_type, content_id, author_id, note, referred_by, referred_at)
select d.id, d.moderation_item_id, i.content_type, i.content_id,
  coalesce(
    case i.content_type
      when 'product_review' then (select r.customer_id::text from reviews.product_reviews r where r.id = i.content_id)
      when 'seller_feedback' then (select f.customer_id::text from reviews.seller_feedback f where f.id = i.content_id)
      when 'question' then (select q.customer_id::text from reviews.questions q where q.id = i.content_id)
      when 'answer' then (select coalesce(a.seller_id::text, a.author_id) from reviews.answers a where a.id = i.content_id)
      when 'seller_response' then (select sr.seller_id::text from reviews.seller_responses sr where sr.id = i.content_id)
    end, ''),
  coalesce(d.message_to_reporter, ''), d.moderator_id, d.decided_at
from reviews.moderation_decisions d join reviews.moderation_items i on i.id = d.moderation_item_id
where d.decision = 'refer'
on conflict (id) do nothing;
delete from reviews.moderation_decisions d
where d.decision = 'refer' and not exists (select 1 from reviews.appeals a where a.decision_id = d.id);
`,
};
