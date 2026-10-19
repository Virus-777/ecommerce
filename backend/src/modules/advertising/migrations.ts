/**
 * Advertising's data migrations (module.ts mongoMigrations): each runs once per database, after the collections from
 * the spec exist, and is recorded in the kernel's migrations collection.
 */
import type { MongoMigration } from '../../kernel/mongo/schema.js';

/**
 * The home banner carousel shows every live ad (owner decision 2026-10-18): the launch placement capped it at 3
 * (max_per_page 3, rotation.maxInRotation 3). On a database seeded before that, this clears both limits, but only
 * while they are still the seeded 3s: a limit staff set in Placements and rules is kept.
 *
 * Safe to run again: it only touches a home_banner placement that still has the old limits.
 */
export const homeBannerShowsAllAds: MongoMigration = {
  id: '2026-10-18-home-banner-shows-all-ads',
  async up(db) {
    await db
      .collection('advertising.placements')
      .updateOne(
        { key: 'home_banner', max_per_page: 3, 'rotation.maxInRotation': 3 },
        { $set: { max_per_page: null, 'rotation.maxInRotation': null, 'rotation.label': 'Carousel, 6 s each' } },
      );
  },
};

export const mongoMigrations: readonly MongoMigration[] = [homeBannerShowsAllAds];
