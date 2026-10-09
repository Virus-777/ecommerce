import type { Migration } from '../../../../../kernel/migrations/index.js';

/**
 * The Official Store's seller id is now the spec constant OFFICIAL_STORE_ID (common.json) instead of the nil
 * uuid reviews used before. Rewrites stored seller ids (moderation_decisions.moderator_id keeps the nil uuid:
 * it stands for the system moderator, not a seller). The seller summary is recomputed by the summaries job.
 */
export const m0002OfficialStoreId: Migration = {
  id: '0002_official_store_id',
  sql: /* sql */ `
update reviews.product_reviews set seller_id = '00000000-0000-7000-8000-000000000001' where seller_id = '00000000-0000-0000-0000-000000000000';
update reviews.seller_feedback set seller_id = '00000000-0000-7000-8000-000000000001' where seller_id = '00000000-0000-0000-0000-000000000000';
update reviews.seller_responses set seller_id = '00000000-0000-7000-8000-000000000001' where seller_id = '00000000-0000-0000-0000-000000000000';
update reviews.answers set seller_id = '00000000-0000-7000-8000-000000000001' where seller_id = '00000000-0000-0000-0000-000000000000';
update reviews.answers set author_id = '00000000-0000-7000-8000-000000000001' where author_kind = 'seller' and author_id = '00000000-0000-0000-0000-000000000000';
update reviews.reports set reporter_id = '00000000-0000-7000-8000-000000000001' where reporter_kind = 'seller' and reporter_id = '00000000-0000-0000-0000-000000000000';
update reviews.appeals set by_id = '00000000-0000-7000-8000-000000000001' where by_kind = 'seller' and by_id = '00000000-0000-0000-0000-000000000000';
delete from reviews.seller_feedback_summaries
  where seller_id = '00000000-0000-0000-0000-000000000000'
    and exists (select 1 from reviews.seller_feedback_summaries s where s.seller_id = '00000000-0000-7000-8000-000000000001');
update reviews.seller_feedback_summaries set seller_id = '00000000-0000-7000-8000-000000000001' where seller_id = '00000000-0000-0000-0000-000000000000';
`,
};
