/**
 * Access's data migrations (module.ts mongoMigrations): each runs once per database, after the collections from the
 * spec exist, and is recorded in the kernel's migrations collection.
 */
import { allSpecs } from '../../kernel/module-system/loader.js';
import type { MongoMigration } from '../../kernel/mongo/schema.js';
import { BUSINESS_OWNER, MARKETING_OFFERS_VIEW, PLATFORM_ADMINISTRATOR, STAFF_UPLOADS, SYSTEM_ROLES, viewCompanions } from './domain/seed.js';

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

/**
 * Fix round 2026-10-17 (Ops photo uploads): staff uploads in the Admin Center need media.uploads.create instead of
 * media.assets.manage, which only the Catalog and Content Managers held, so warehouse, returns and other Ops staff
 * could not attach the photos Receiving, Pick & pack and Return inspection ask for. New installs get the key from the
 * seed (STAFF_UPLOADS in domain/seed.ts); this gives it once to the seeded roles that have it in the seed, and to every
 * role holding media.assets.manage (custom roles included), so nobody who could upload before loses it.
 * Same fix round: the seeded Marketing Manager also gets offers.offers.view (MARKETING_OFFERS_VIEW in domain/seed.ts),
 * to search offers when adding flash-sale items in Admin › Promotions.
 * It runs once, so a key the owner removes afterwards stays removed.
 */
export const staffWorkUploads: MongoMigration = {
  id: '2026-10-17-staff-work-uploads',
  async up(db) {
    const roles = await db.collection('access.roles').find({ archived_at: null }).toArray();
    if (!roles.length) return; // a new install: the registry sync seeds the roles with the key
    const now = new Date();
    const grant = (roleId: unknown, key: string) =>
      db.collection('access.role_permissions').updateOne({ role_id: roleId, permission_key: key }, { $setOnInsert: { granted_by: 'system', granted_at: now } }, { upsert: true });
    const seeded = new Set(SYSTEM_ROLES.filter((r) => r.permissions.includes(STAFF_UPLOADS)).map((r) => r.key));
    const managers = new Set((await db.collection('access.role_permissions').find({ permission_key: 'media.assets.manage' }).toArray()).map((p) => String(p.role_id)));
    for (const role of roles) {
      if (role.system && role.key === 'marketing_manager') await grant(role._id, MARKETING_OFFERS_VIEW);
      if ((role.system && seeded.has(String(role.key))) || managers.has(String(role._id))) await grant(role._id, STAFF_UPLOADS);
    }
  },
};

/**
 * Fix round 2026-10-17 (staff offboarding): locking, unlocking, signing out everywhere and requiring a new password
 * (identity.accounts.manage) were held by no seeded role, so no one could use them from Admin › Staff. The Platform
 * Administrator, who already disables staff accounts, gets the key once; new installs get it from the seed.
 */
export const platformAdminAccountActions: MongoMigration = {
  id: '2026-10-17-platform-admin-account-actions',
  async up(db) {
    const role = await db.collection('access.roles').findOne({ key: PLATFORM_ADMINISTRATOR, system: true, archived_at: null });
    if (!role) return; // a new install: the registry sync seeds the role with the key
    await db
      .collection('access.role_permissions')
      .updateOne({ role_id: role._id, permission_key: 'identity.accounts.manage' }, { $setOnInsert: { granted_by: 'system', granted_at: new Date() } }, { upsert: true });
  },
};

export const mongoMigrations: readonly MongoMigration[] = [businessOwnerViewKeys, staffWorkUploads, platformAdminAccountActions];
