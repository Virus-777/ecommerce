/**
 * Search's data migrations (module.ts mongoMigrations): each runs once per database, after the collections from the
 * spec exist, and is recorded in the kernel's migrations collection.
 */
import type { MongoMigration } from '../../kernel/mongo/schema.js';
import { STORE_CARDS } from './cards.js';
import { EMBED_OFFERS_PIPELINE } from './repository.js';

/**
 * Search documents keep their offers (`offers`, docs/07-search-speed-plan.md): fills the column on documents written
 * before it, from search_offers, in one pass. Safe to run again: it rewrites every document's offers from the rows.
 */
export const embedOffers: MongoMigration = {
  id: '2026-10-20-embed-offers',
  async up(db) {
    await db.collection('search.search_documents').aggregate([...EMBED_OFFERS_PIPELINE]).toArray();
  },
};

/**
 * Search documents keep their card offers for the two usual offer filters (cards.ts, docs/07 step 5): fills them on
 * documents written before, from their offers and featured offer; the stored ranks follow on the first listing.
 */
export const storeCards: MongoMigration = {
  id: '2026-10-20-store-cards',
  async up(db) {
    await db.collection('search.search_documents').updateMany({}, [STORE_CARDS]);
  },
};

export const mongoMigrations: readonly MongoMigration[] = [embedOffers, storeCards];
