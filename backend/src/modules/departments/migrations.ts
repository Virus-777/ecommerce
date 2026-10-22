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

/** Phone advertisement images (2026-10-23): phones added before them have none */
export const phoneAdImages: MongoMigration = {
  id: '2026-10-23-departments-phone-ad-images',
  async up(db) {
    await db.collection('departments.phones').updateMany({ ad_images: { $exists: false } }, { $set: { ad_images: [] } });
  },
};

export const mongoMigrations: readonly MongoMigration[] = [replyLikeCounts, phoneAdImages];
