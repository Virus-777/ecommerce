/**
 * Access's data migrations (module.ts mongoMigrations): each runs once per database, after the collections from the
 * spec exist, and is recorded in the kernel's migrations collection.
 */
import { allSpecs } from '../../kernel/module-system/loader.js';
import type { MongoMigration } from '../../kernel/mongo/schema.js';
import { ANNOUNCEMENT_ROLES, ANNOUNCEMENTS_SEND, BUSINESS_OWNER, DEPARTMENTS_MANAGE, MARKETING_OFFERS_VIEW, PHASE3_MANAGE, PHASE3_SUPPORT, PHASE4_MANAGE, PHASE4_SUPPORT, SERVICES_MANAGE, SERVICES_REQUESTS, NEWS_MANAGE, NEWS_PUBLISH, PLATFORM_ADMINISTRATOR, STAFF_UPLOADS, SYSTEM_ROLES, viewCompanions } from './domain/seed.js';

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

/**
 * News for customers (docs/06-news.md, 2026-10-18): the new keys reach roles seeded before them. The Content Manager
 * (content.* in the seed) writes and publishes news; the Marketing Manager writes it. Roles holding
 * content.pages.publish (custom roles included) get news publish too, and content.pages.manage news manage, so whoever
 * runs campaign pages can run news. It runs once, so a key the owner removes afterwards stays removed.
 */
export const newsKeys: MongoMigration = {
  id: '2026-10-18-news-keys',
  async up(db) {
    const roles = await db.collection('access.roles').find({ archived_at: null }).toArray();
    if (!roles.length) return; // a new install: the registry sync seeds the roles with the keys
    const now = new Date();
    const grant = (roleId: unknown, key: string) =>
      db.collection('access.role_permissions').updateOne({ role_id: roleId, permission_key: key }, { $setOnInsert: { granted_by: 'system', granted_at: now } }, { upsert: true });
    const holders = async (key: string) => new Set((await db.collection('access.role_permissions').find({ permission_key: key }).toArray()).map((p) => String(p.role_id)));
    const [pagePublishers, pageManagers] = await Promise.all([holders('content.pages.publish'), holders('content.pages.manage')]);
    for (const role of roles) {
      const id = String(role._id);
      const contentManager = role.system && role.key === 'content_manager';
      if (contentManager || pagePublishers.has(id)) await grant(role._id, NEWS_PUBLISH);
      if (contentManager || pageManagers.has(id) || (role.system && role.key === 'marketing_manager')) await grant(role._id, NEWS_MANAGE);
    }
  },
};

/**
 * Announcements to sellers (notifications, live topics 2026-10-20): the seeded Seller Manager and Platform
 * Administrator roles of an install seeded before the key get notifications.announcements.send once; new installs get
 * it from the seed (ANNOUNCEMENTS_SEND in domain/seed.ts). It runs once, so a key the owner removes stays removed.
 */
export const announcementKeys: MongoMigration = {
  id: '2026-10-20-announcement-keys',
  async up(db) {
    const roles = await db.collection('access.roles').find({ key: { $in: [...ANNOUNCEMENT_ROLES] }, system: true, archived_at: null }).toArray();
    const now = new Date();
    for (const role of roles) {
      await db
        .collection('access.role_permissions')
        .updateOne({ role_id: role._id, permission_key: ANNOUNCEMENTS_SEND }, { $setOnInsert: { granted_by: 'system', granted_at: now } }, { upsert: true });
    }
  },
};

/**
 * Department pages of the app (departments module, 2026-10-21): the new keys reach roles seeded before them. The
 * seeded Content Manager gets every departments key, the Marketing Manager the manage keys, and every role holding one
 * of them departments.view (VIEW_COMPANIONS); the Business Owner gets departments.view from the registry sync like any
 * new view key. It runs once, so a key the owner removes afterwards stays removed.
 */
export const departmentsKeys: MongoMigration = {
  id: '2026-10-21-departments-keys',
  async up(db) {
    const roles = await db.collection('access.roles').find({ system: true, key: { $in: ['content_manager', 'marketing_manager'] }, archived_at: null }).toArray();
    if (!roles.length) return; // a new install: the registry sync seeds the roles with the keys
    const now = new Date();
    const grant = (roleId: unknown, key: string) =>
      db.collection('access.role_permissions').updateOne({ role_id: roleId, permission_key: key }, { $setOnInsert: { granted_by: 'system', granted_at: now } }, { upsert: true });
    for (const role of roles) {
      for (const key of ['departments.view', ...DEPARTMENTS_MANAGE]) await grant(role._id, key);
    }
  },
};

/**
 * Services, requests and bookings (services module, 2026-10-22) and Farm machines (departments.farm.manage): the new
 * keys reach roles seeded before them, as in the seed (Content Manager all of them, Marketing Manager the manage keys,
 * Customer Support Manager and Support Agent the requests). A Business Owner role that staff already gave the
 * department manage keys (departments.blogs.manage) gets these manage keys too, so the people who edit the department
 * pages keep doing so. It runs once.
 */
export const servicesKeys: MongoMigration = {
  id: '2026-10-22-services-keys',
  async up(db) {
    const roles = await db.collection('access.roles').find({ system: true, key: { $in: ['content_manager', 'marketing_manager', 'customer_support_manager', 'support_agent', BUSINESS_OWNER] }, archived_at: null }).toArray();
    if (!roles.length) return; // a new install: the registry sync seeds the roles with the keys
    const now = new Date();
    const perms = db.collection('access.role_permissions');
    const grant = (roleId: unknown, key: string) => perms.updateOne({ role_id: roleId, permission_key: key }, { $setOnInsert: { granted_by: 'system', granted_at: now } }, { upsert: true });
    const keys: Record<string, string[]> = {
      content_manager: ['services.view', SERVICES_MANAGE, 'services.requests.manage', 'departments.farm.manage'],
      marketing_manager: ['services.view', SERVICES_MANAGE, 'departments.farm.manage'],
      customer_support_manager: [...SERVICES_REQUESTS],
      support_agent: [...SERVICES_REQUESTS],
    };
    for (const role of roles) {
      let list = keys[String(role.key)] ?? [];
      if (role.key === BUSINESS_OWNER) list = (await perms.countDocuments({ role_id: role._id, permission_key: 'departments.blogs.manage' }, { limit: 1 })) ? [SERVICES_MANAGE, 'services.requests.manage', 'departments.farm.manage'] : [];
      for (const key of list) await grant(role._id, key);
    }
  },
};

/**
 * Softwares, Food delivery and Daily rewards (software, food and rewards modules, 2026-10-23): the new keys reach roles
 * seeded before them, as in the seed (Content Manager all of them, Marketing Manager the manage keys with their view
 * keys, Customer Support Manager and Support Agent the view keys and food orders). The Business Owner gets the view keys
 * from the registry sync (*.view); one that staff already gave the department manage keys (departments.blogs.manage)
 * gets the manage keys and food.orders.manage too, as in 2026-10-22-services-keys. It runs once.
 */
export const phase3Keys: MongoMigration = {
  id: '2026-10-23-phase3-keys',
  async up(db) {
    const roles = await db.collection('access.roles').find({ system: true, key: { $in: ['content_manager', 'marketing_manager', 'customer_support_manager', 'support_agent', BUSINESS_OWNER] }, archived_at: null }).toArray();
    if (!roles.length) return; // a new install: the registry sync seeds the roles with the keys
    const now = new Date();
    const perms = db.collection('access.role_permissions');
    const grant = (roleId: unknown, key: string) => perms.updateOne({ role_id: roleId, permission_key: key }, { $setOnInsert: { granted_by: 'system', granted_at: now } }, { upsert: true });
    const keys: Record<string, string[]> = {
      content_manager: [...PHASE3_SUPPORT, ...PHASE3_MANAGE],
      marketing_manager: ['software.view', 'food.view', 'rewards.view', ...PHASE3_MANAGE],
      customer_support_manager: [...PHASE3_SUPPORT],
      support_agent: [...PHASE3_SUPPORT],
    };
    for (const role of roles) {
      let list = keys[String(role.key)] ?? [];
      if (role.key === BUSINESS_OWNER) list = (await perms.countDocuments({ role_id: role._id, permission_key: 'departments.blogs.manage' }, { limit: 1 })) ? [...PHASE3_MANAGE, 'food.orders.manage'] : [];
      for (const key of list) await grant(role._id, key);
    }
  },
};

/**
 * Phase 4 of the department pages (farm module, Post-sale devices, game server keys and review moderation,
 * 2026-10-24): the new keys reach roles seeded before them, as in the seed (Content Manager all of them, Marketing
 * Manager the manage keys with farm.view, Customer Support Manager and Support Agent farm.view, farm orders and
 * registered devices). The Business Owner gets farm.view from the registry sync (*.view); one that staff already gave
 * the department manage keys (departments.blogs.manage) gets every other new key too, as in 2026-10-23-phase3-keys.
 * It runs once.
 */
export const phase4Keys: MongoMigration = {
  id: '2026-10-24-phase4-keys',
  async up(db) {
    const roles = await db.collection('access.roles').find({ system: true, key: { $in: ['content_manager', 'marketing_manager', 'customer_support_manager', 'support_agent', BUSINESS_OWNER] }, archived_at: null }).toArray();
    if (!roles.length) return; // a new install: the registry sync seeds the roles with the keys
    const now = new Date();
    const perms = db.collection('access.role_permissions');
    const grant = (roleId: unknown, key: string) => perms.updateOne({ role_id: roleId, permission_key: key }, { $setOnInsert: { granted_by: 'system', granted_at: now } }, { upsert: true });
    const keys: Record<string, string[]> = {
      content_manager: [...PHASE4_SUPPORT, ...PHASE4_MANAGE],
      marketing_manager: ['farm.view', ...PHASE4_MANAGE],
      customer_support_manager: [...PHASE4_SUPPORT],
      support_agent: [...PHASE4_SUPPORT],
    };
    for (const role of roles) {
      let list = keys[String(role.key)] ?? [];
      if (role.key === BUSINESS_OWNER) list = (await perms.countDocuments({ role_id: role._id, permission_key: 'departments.blogs.manage' }, { limit: 1 })) ? [...PHASE4_MANAGE, 'farm.orders.manage', 'services.devices.manage'] : [];
      for (const key of list) await grant(role._id, key);
    }
  },
};

export const mongoMigrations: readonly MongoMigration[] = [businessOwnerViewKeys, staffWorkUploads, platformAdminAccountActions, newsKeys, announcementKeys, departmentsKeys, servicesKeys, phase3Keys, phase4Keys];
