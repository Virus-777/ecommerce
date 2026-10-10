import type { Migration } from '../../../../../kernel/migrations/index.js';

/** Gap pass 4: promotions.referencePriceDays was removed; promotions reads offers.wasPriceLookbackDays instead. */
export const m0003RemovedPromotionsReferenceDays: Migration = {
  id: '0003_removed_promotions_reference_days',
  sql: /* sql */ `
delete from settings.values where key = 'promotions.referencePriceDays';
delete from settings.change_keys where key = 'promotions.referencePriceDays';
`,
};
