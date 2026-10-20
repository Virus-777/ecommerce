/**
 * Finance's data migrations (module.ts mongoMigrations): each runs once per database, after the collections from
 * the spec exist, and is recorded in the kernel's migrations collection.
 */
import type { MongoMigration } from '../../kernel/mongo/schema.js';

/**
 * fee_charges.changed_at (2026-10-21, docs/09 §3.2): reports pulls the fees changed since its last run by this
 * column. Charges written before it existed get their created_at, so a full pull (a rebuild) reads them too.
 *
 * Safe to run again: it only touches charges that still have no changed_at.
 */
export const feeChargesChangedAt: MongoMigration = {
  id: '2026-10-21-fee-charges-changed-at',
  async up(db) {
    await db.collection('finance.fee_charges').updateMany({ changed_at: null }, [{ $set: { changed_at: '$created_at' } }]);
  },
};

export const mongoMigrations: readonly MongoMigration[] = [feeChargesChangedAt];
