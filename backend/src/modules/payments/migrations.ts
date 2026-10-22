/**
 * Payments' data migrations (module.ts mongoMigrations): each runs once per database, after the collections from the
 * spec are in place (kernel/mongo/schema.ts).
 */
import type { MongoMigration } from '../../kernel/mongo/schema.js';

/**
 * Purchase intents (2026-10-22, departments phase 3): intents gained purpose (checkout | purchase) and the purchase
 * columns. Every intent written before is a checkout payment; the backfill gives it purpose checkout and empty
 * purchase columns so the validator (purpose required) accepts later writes to it.
 */
const intentPurpose: MongoMigration = {
  id: '2026-10-22-intent-purpose',
  async up(db) {
    await db.collection('payments.intents').updateMany({ purpose: { $exists: false } }, { $set: { purpose: 'checkout', purchase_module: null, purchase_ref_id: null, purchase_ref: null } });
  },
};

export const mongoMigrations: readonly MongoMigration[] = [intentPurpose];
