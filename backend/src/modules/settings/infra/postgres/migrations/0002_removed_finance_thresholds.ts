import type { Migration } from '../../../../../kernel/migrations/index.js';

/**
 * Gap pass 4: finance's second-reviewer threshold settings were removed from its spec (approval limits come from
 * access only). Their stored values go too, and open changes no longer hold their keys.
 */
export const m0002RemovedFinanceThresholds: Migration = {
  id: '0002_removed_finance_thresholds',
  sql: /* sql */ `
delete from settings.values
 where key in ('finance.runSecondReviewerThreshold', 'finance.adjustmentSecondReviewerThreshold', 'finance.correctionSecondReviewerThreshold');
delete from settings.change_keys
 where key in ('finance.runSecondReviewerThreshold', 'finance.adjustmentSecondReviewerThreshold', 'finance.correctionSecondReviewerThreshold');
`,
};
