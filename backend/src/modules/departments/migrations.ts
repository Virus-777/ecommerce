/**
 * Departments' data migrations (module.ts mongoMigrations): each runs once per database, after the collections from
 * the spec exist, and is recorded in the kernel's migrations collection.
 */
import type { MongoMigration } from '../../kernel/mongo/schema.js';

/** Reply likes (2026-10-22): replies written before them start with no likes */
export const replyLikeCounts: MongoMigration = {
  id: '2026-10-22-departments-reply-like-counts',
  async up(db) {
    await db.collection('departments.blog_replies').updateMany({ like_count: { $exists: false } }, { $set: { like_count: 0 } });
  },
};

export const mongoMigrations: readonly MongoMigration[] = [replyLikeCounts];
