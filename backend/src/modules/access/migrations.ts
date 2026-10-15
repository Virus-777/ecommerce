/**
 * Access's data migrations (module.ts mongoMigrations): each runs once per database, after the collections from the
 * spec exist, and is recorded in the kernel's migrations collection.
 */
import { allSpecs } from '../../kernel/module-system/loader.js';
import type { MongoMigration } from '../../kernel/mongo/schema.js';
import { BUSINESS_OWNER, viewCompanions } from './domain/seed.js';

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
 * keys from the registry sync (service/core.ts); this gives a role seeded before them every view key once. Roles
 * holding a manage or record key of those pages get the matching view key (VIEW_COMPANIONS in domain/seed.ts), e.g.
 * the Returns Manager gets returns.inspections.view. It runs once, so a view key the owner removes afterwards stays
 * removed.
 */
export const businessOwnerViewKeys: MongoMigration = {
  id: '2026-10-16-business-owner-view-keys',
  async up(db) {
    const roles = await db.collection('access.roles').find({ archived_at: null }).toArray();
    if (!roles.length) return; // a new install: the registry sync seeds the roles (seed.ts expandPermissions adds the companions)
    const now = new Date();
    const grant = (roleId: unknown, key: string) =>
      db.collection('access.role_permissions').updateOne({ role_id: roleId, permission_key: key }, { $setOnInsert: { granted_by: 'system', granted_at: now } }, { upsert: true });
    const views = staffViewKeys();
    const owner = roles.find((r) => r.key === BUSINESS_OWNER && r.system);
    if (owner) for (const key of views) await grant(owner._id, key);
    // every role holding a key under a companion prefix (e.g. returns.inspections.record) reads that page too
    for (const role of roles) {
      const held = (await db.collection('access.role_permissions').find({ role_id: role._id }).toArray()).map((p) => String(p.permission_key));
      for (const key of viewCompanions(held, views)) await grant(role._id, key);
    }
  },
};

export const mongoMigrations: readonly MongoMigration[] = [businessOwnerViewKeys];
