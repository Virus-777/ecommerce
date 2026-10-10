import type { Migration } from '../../../../../kernel/migrations/index.js';

/**
 * Gap pass 3: review of the homepage draft layout when content.reviewRequired.section is on
 * (submitHomepageDraft → reviewHomepageDraft → publishHomepage). Kept on the draft version row.
 */
export const m0002HomepageReview: Migration = {
  id: '0002_homepage_review',
  sql: /* sql */ `
alter table content.versions add column review_state text check (review_state in ('not_submitted', 'in_review', 'approved', 'changes_requested'));
alter table content.versions add column submitted_by text;
alter table content.versions add column submitted_at timestamptz;
alter table content.versions add column reviewed_by text;
alter table content.versions add column reviewed_at timestamptz;
alter table content.versions add column review_note text;
`,
};
