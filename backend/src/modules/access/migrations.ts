/**
 * Access's data migrations (module.ts mongoMigrations): each runs once per database, after the collections from the
 * spec exist, and is recorded in the kernel's migrations collection.
 */
import { allSpecs } from '../../kernel/module-system/loader.js';
import type { MongoMigration } from '../../kernel/mongo/schema.js';
import { BUSINESS_OWNER } from './domain/seed.js';

/** Every staff permission key ending in `.view`, from every module's spec (enabled or not, like the registry) */
export function staffViewKeys(): string[] {
  return Object.values(allSpecs)
    .flatMap((s) => s.permissions.filter((p) => p.audience === 'staff' && p.key.endsWith('.view')).map((p) => p.key))
    .sort();
}

/**
 * G77 (owner decision 2026-10-16): the Business Owner holds every `*.view` key, including the read-only keys added
 * for pages that were gated by manage keys (catalog.view, content.view, offers.official.view,
 * sellers.applications.view, returns.inspections.view). New installs get them from the seed (domain/seed.ts) and later
 * keys from the registry sync (service/core.ts); this gives a role seeded before them every view key once. It runs
 * once, so a view key the owner removes from the role afterwards stays removed.
 */
export const businessOwnerViewKeys: MongoMigration = {
  id: '2026-10-16-business-owner-view-keys',
  async up(db) {
    const role = await db.collection('access.roles').findOne({ key: BUSINESS_OWNER, system: true, archived_at: null });
    if (!role) return; // a new install: the registry sync seeds the role with every view key
    const now = new Date();
    for (const key of staffViewKeys()) {
      await db.collection('access.role_permissions').updateOne({ role_id: role._id, permission_key: key }, { $setOnInsert: { granted_by: 'system', granted_at: now } }, { upsert: true });
    }
  },
};

export const mongoMigrations: readonly MongoMigration[] = [businessOwnerViewKeys];
