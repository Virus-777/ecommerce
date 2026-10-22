/**
 * Services' data migrations (module.ts mongoMigrations): each runs once per database, after the collections from the
 * spec exist, and is recorded in the kernel's migrations collection.
 */
import type { MongoMigration } from '../../kernel/mongo/schema.js';

/**
 * Covered by warranty (2026-10-22): services saved before the flag existed are not covered, so the database validator
 * accepts their next change.
 */
export const warrantyFlag: MongoMigration = {
  id: '2026-10-22-services-warranty-flag',
  async up(db) {
    await db.collection('services.services').updateMany({ covered_by_warranty: { $exists: false } }, { $set: { covered_by_warranty: false } });
  },
};

export const mongoMigrations: readonly MongoMigration[] = [warrantyFlag];
