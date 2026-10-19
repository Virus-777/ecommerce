/**
 * Content's data migrations (module.ts mongoMigrations): each runs once per database, after the collections from the
 * spec exist, and is recorded in the kernel's migrations collection.
 */
import { newId } from '../../kernel/lib/ids.js';
import type { MongoMigration } from '../../kernel/mongo/schema.js';

/**
 * News for customers (docs/06-news.md, 2026-10-18): the starting news categories. Staff rename, hide, reorder or
 * delete them in Admin › News; this only adds them to a database that has no news categories yet.
 */
export const newsCategories: MongoMigration = {
  id: '2026-10-18-news-categories',
  async up(db) {
    const col = db.collection('content.news_categories');
    if (await col.countDocuments({}, { limit: 1 })) return;
    const seed = [
      { slug: 'announcements', name: 'Announcements', icon: 'megaphone' },
      { slug: 'service-updates', name: 'Service updates', icon: 'truck' },
      { slug: 'events', name: 'Events', icon: 'calendar' },
      { slug: 'policy-changes', name: 'Policy changes', icon: 'shield-check' },
    ];
    await col.insertMany(seed.map((c, i) => ({ _id: newId(), ...c, position: i + 1, visible: true, previous_slugs: [] })) as never[]);
  },
};

export const mongoMigrations: readonly MongoMigration[] = [newsCategories];
