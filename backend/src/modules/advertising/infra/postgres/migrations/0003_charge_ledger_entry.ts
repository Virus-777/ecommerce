import type { Migration } from '../../../../../kernel/migrations/index.js';

/**
 * ad_charges.ledger_entry_id: the finance LedgerEntry returned by finance.recordAdCharge, needed to credit a
 * posted charge back through finance.creditSellerCharge (originalEntryId).
 */
export const m0003ChargeLedgerEntry: Migration = {
  id: '0003_charge_ledger_entry',
  sql: /* sql */ `
alter table advertising.ad_charges add column if not exists ledger_entry_id uuid;
`,
};
