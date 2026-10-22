/**
 * Food's data migrations (module.ts mongoMigrations): each runs once per database, after the collections from the spec
 * exist, and is recorded in the kernel's migrations collection.
 */
import type { MongoMigration } from '../../kernel/mongo/schema.js';

/**
 * Restaurant points (2026-10-22): restaurants saved before points existed get the new address and point fields as
 * null (region, postal_code, lat, lng, point_source). A city written as "Portland, OR" is left as it is: the geocoder
 * input reads it as city and state (domain/rules.ts geocodeInputOf). The points themselves come from the
 * food.geocode-restaurants job on the next boot, which calls customers.geocodeAddress (a migration sees only the
 * database, not other modules).
 *
 * Safe to run again: it only fills fields that are missing.
 */
export const restaurantPoints: MongoMigration = {
  id: '2026-10-22-food-restaurant-points',
  async up(db) {
    const restaurants = db.collection('food.restaurants');
    for (const field of ['region', 'postal_code', 'lat', 'lng', 'point_source']) {
      await restaurants.updateMany({ [field]: { $exists: false } }, { $set: { [field]: null } });
    }
  },
};

export const mongoMigrations: readonly MongoMigration[] = [restaurantPoints];
