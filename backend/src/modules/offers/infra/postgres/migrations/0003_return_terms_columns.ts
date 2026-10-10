import type { Migration } from '../../../../../kernel/migrations/index.js';

/**
 * Gap pass 4:
 * - return_policy_id (uuid) becomes return_policy_version (text): returns.resolveTerms answers a policy version
 *   string (EffectiveTerms.policyVersion, e.g. '1.0'), which never fit a uuid column, so the old column was almost
 *   always null. Backfill: the old value as text when there was one.
 * - return_category_exception: the category exception summary returns gave at save, shown before purchase.
 *
 * Neither value lives anywhere in this schema for existing offers (they come from returns), so rows still null
 * after this migration are filled by the hourly offers.reevaluate-eligibility job while returns is on
 * (FeaturedPart.backfillReturnTerms, a bounded batch per run).
 */
export const m0003ReturnTermsColumns: Migration = {
  id: '0003_return_terms_columns',
  sql: /* sql */ `
alter table offers.offers add column return_policy_version text;
alter table offers.offers add column return_category_exception text;
update offers.offers set return_policy_version = return_policy_id::text where return_policy_id is not null;
alter table offers.offers drop column return_policy_id;
comment on column offers.offers.return_policy_version is 'returns EffectiveTerms.policyVersion at save';
comment on column offers.offers.return_category_exception is 'returns category exception summary at save';
`,
};
