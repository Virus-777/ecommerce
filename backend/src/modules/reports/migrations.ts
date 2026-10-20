/**
 * Reports' data migrations (module.ts mongoMigrations): each runs once per database, after the collections from the
 * spec exist, and is recorded in the kernel's migrations collection.
 */
import type { MongoMigration } from '../../kernel/mongo/schema.js';
import { LEDGER_COLUMN_DEFAULTS } from './repository.js';

/**
 * The ledger columns of fact_marketplace_finance_daily (2026-10-21, docs/09 §3.3) are required by the collection's
 * validator: rows written before they existed get zeros, so later updates of those rows pass the validator. The next
 * finance pull (or a rebuild of marketplace_finance) fills in the real figures.
 *
 * Safe to run again: it only touches rows that still miss a column.
 */
export const financeDailyLedgerColumns: MongoMigration = {
  id: '2026-10-21-finance-daily-ledger-columns',
  async up(db) {
    // all columns in one update: a row missing any of them fails the validator
    const columns = Object.keys(LEDGER_COLUMN_DEFAULTS);
    await db.collection('reports.fact_marketplace_finance_daily').updateMany({ $or: columns.map((c) => ({ [c]: { $exists: false } })) }, [{ $set: Object.fromEntries(columns.map((c) => [c, { $ifNull: [`$${c}`, 0] }])) }]);
  },
};

export const mongoMigrations: readonly MongoMigration[] = [financeDailyLedgerColumns];
