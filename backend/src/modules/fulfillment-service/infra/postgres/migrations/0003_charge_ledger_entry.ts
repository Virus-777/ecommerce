import type { Migration } from '../../../../../kernel/migrations/index.js';

/**
 * fee_charges.ledger_entry_id: the finance LedgerEntry of a posted charge (finance.recordServiceFee for a fee,
 * finance.creditSellerCharge for a reimbursement), needed to credit a posted fee back (originalEntryId).
 */
export const m0003ChargeLedgerEntry: Migration = {
  id: '0003_charge_ledger_entry',
  sql: /* sql */ `
alter table fulfillment_service.fee_charges add column if not exists ledger_entry_id uuid;
`,
};
