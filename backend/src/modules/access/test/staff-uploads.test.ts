/**
 * Fix round 2026-10-17 (Ops photo uploads): staff uploads need media.uploads.create, which every role whose work
 * attaches files holds, on new installs (seed) and on installs seeded before it (migration 2026-10-17-staff-work-uploads).
 * Editing, deleting and moderating files stay with the media.assets.* keys. The same migration gives the Marketing
 * Manager offers.offers.view (flash-sale item search in Admin › Promotions).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { platformAdminAccountActions, staffWorkUploads } from '../migrations.js';
import { STAFF_UPLOADS } from '../domain/seed.js';
import { accessFixture, type Fixture } from './fixture.js';
import { mysqlModulesUnderTest } from '../../../testing/app.js';
/**
 * The tests of this module's MongoDB **data migrations** (migrations.ts) run on MongoDB only.
 *
 * A migration like `businessOwnerViewKeys.up(db)` takes the MongoDB driver and writes collections directly,
 * to upgrade an install that already has roles. A MySQL database starts empty (D10: no ETL), so there is
 * nothing for one to upgrade and no MySQL counterpart to write, and they go with MongoDB in Y4. Skipping them
 * when this run keeps access's data in MySQL is not avoiding a failure: the subject of the test is not there.
 */
const onMongo = mysqlModulesUnderTest().includes('access') ? it.skip : it;

/** The seeded roles whose work attaches files (photos, evidence, Official Store, content and ad files) */
const UPLOADERS = [
  'business_owner',
  'official_store_manager',
  'purchasing_manager',
  'warehouse_manager',
  'warehouse_worker',
  'shipping_manager',
  'returns_manager',
  'catalog_manager',
  'customer_support_manager',
  'finance_manager',
  'marketing_manager',
  'advertising_manager',
  'content_manager',
  'trust_and_risk_manager',
  'support_agent',
];

let f: Fixture;
beforeAll(async () => {
  f = await accessFixture();
});
afterAll(async () => {
  await f?.close();
});

const keysOf = async (roleKey: string) => (await f.table('role_permissions').find({ role_id: await f.roleId(roleKey) })).map((r) => r.permission_key as string);

describe('staff uploads (media.uploads.create)', () => {
  it('a new install: the Ops, catalog, content and evidence roles may upload, without file editing or moderation', async () => {
    for (const key of UPLOADERS) expect(await keysOf(key), key).toContain(STAFF_UPLOADS);
    expect(await keysOf('marketing_manager')).toContain('offers.offers.view');
    for (const key of ['platform_administrator', 'reports_analyst', 'finance_staff', 'order_manager', 'seller_manager', 'inventory_manager']) expect(await keysOf(key), key).not.toContain(STAFF_UPLOADS);
    const worker = await keysOf('warehouse_worker');
    expect(worker.filter((k) => k.startsWith('media.'))).toEqual([STAFF_UPLOADS]);
    // the Catalog Manager's media.assets.* does not cover it: the seed names it
    expect(await keysOf('catalog_manager')).toEqual(expect.arrayContaining([STAFF_UPLOADS, 'media.assets.manage', 'media.assets.moderate']));
    const id = await f.staff('Wes Worker', ['warehouse_worker']);
    expect(await f.svc.hasPermission(f.principal(id), STAFF_UPLOADS)).toBe(true);
    expect(await f.svc.hasPermission(f.principal(id), 'media.assets.manage')).toBe(false);
  });

  onMongo('an existing install: the migration grants it to the seeded roles and to every role holding media.assets.manage, once', async () => {
    const now = new Date();
    // a role the owner made, which could upload before (media.assets.manage)
    const custom = newId();
    await f.table('roles').insert({ id: custom, key: 'web_editor', name: 'Web editor', kind: 'task', work_area: 'Marketing and content', description: 'Edits pages', system: false, escalation_role_id: null, archived_at: null, created_at: now, updated_at: now, version: 1 } as never);
    await f.table('role_permissions').insert({ role_id: custom, permission_key: 'media.assets.manage', granted_by: 'test', granted_at: now } as never);
    // as if the roles were seeded before the key existed
    await f.table('role_permissions').deleteMany({ permission_key: STAFF_UPLOADS });
    await f.table('role_permissions').deleteMany({ role_id: await f.roleId('marketing_manager'), permission_key: 'offers.offers.view' });
    expect(await keysOf('warehouse_worker')).not.toContain(STAFF_UPLOADS);

    await staffWorkUploads.up(f.app.kernel.mongo.db);
    await staffWorkUploads.up(f.app.kernel.mongo.db); // safe to run again
    for (const key of UPLOADERS) expect(await keysOf(key), key).toContain(STAFF_UPLOADS);
    expect(await keysOf('reports_analyst')).not.toContain(STAFF_UPLOADS);
    // same fix round: the Marketing Manager searches offers for flash-sale items
    expect(await keysOf('marketing_manager')).toContain('offers.offers.view');
    expect(await keysOf('content_manager')).not.toContain('offers.offers.view');
    expect((await f.table('role_permissions').find({ role_id: custom })).map((r) => r.permission_key)).toEqual(expect.arrayContaining(['media.assets.manage', STAFF_UPLOADS]));
    expect(await f.table('role_permissions').find({ role_id: await f.roleId('warehouse_worker'), permission_key: STAFF_UPLOADS })).toHaveLength(1);
  });
});

describe('staff account actions (identity.accounts.manage)', () => {
  onMongo('the Platform Administrator may lock, unlock, sign out and force a password reset: seed, and migration once', async () => {
    expect(await keysOf('platform_administrator')).toContain('identity.accounts.manage');
    await f.table('role_permissions').deleteMany({ role_id: await f.roleId('platform_administrator'), permission_key: 'identity.accounts.manage' });
    await platformAdminAccountActions.up(f.app.kernel.mongo.db);
    await platformAdminAccountActions.up(f.app.kernel.mongo.db); // safe to run again
    expect(await f.table('role_permissions').find({ role_id: await f.roleId('platform_administrator'), permission_key: 'identity.accounts.manage' })).toHaveLength(1);
    expect(await keysOf('reports_analyst')).not.toContain('identity.accounts.manage');
  });
});
