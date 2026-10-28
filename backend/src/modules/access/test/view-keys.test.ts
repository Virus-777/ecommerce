/**
 * G77: the Business Owner holds every `*.view` permission key (owner decision 2026-10-16), on new installs (seed),
 * for keys registered later (registry sync) and on installs seeded before the read-only view keys (migration).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { businessOwnerViewKeys, staffViewKeys } from '../migrations.js';
import { expandPermissions, SYSTEM_ROLES } from '../domain/seed.js';
import { accessFixture, type Fixture } from './fixture.js';
import { mysqlModulesUnderTest } from '../../../testing/app.js';

/**
 * The tests of this module's MongoDB **data migrations** (migrations.ts) run on MongoDB only.
 *
 * A migration like `businessOwnerViewKeys.up(db)` takes the MongoDB driver and writes collections directly, to
 * upgrade an install that already has roles. A MySQL database starts empty (D10: no ETL), so there is nothing
 * for one to upgrade and no MySQL counterpart to write, and they go with MongoDB in Y4. Skipping them when this
 * run keeps access's data in MySQL is not avoiding a failure: the subject of the test is not there.
 */
const onMongoDb = !mysqlModulesUnderTest().includes('access');
const onMongo = onMongoDb ? it : it.skip;

/** The read-only keys added in wave 2 by the modules that own those pages (catalog, content, offers, sellers, returns) */
const G77_KEYS = ['catalog.view', 'content.view', 'offers.official.view', 'sellers.applications.view', 'returns.inspections.view'];

let f: Fixture;
beforeAll(async () => {
  f = await accessFixture();
});
afterAll(async () => {
  await f?.close();
});

const ownerKeys = async () => (await f.table('role_permissions').find({ role_id: await f.roleId('business_owner') })).map((r) => r.permission_key as string);
const registryKeys = async () => (await f.table('permissions').find()).map((r) => r.key as string);

describe('Business Owner view keys (G77)', () => {
  it('the seed gives the Business Owner every view key, the wave 2 read-only keys included', () => {
    const seed = SYSTEM_ROLES.find((r) => r.key === 'business_owner')!;
    const expanded = expandPermissions(seed.permissions, [...G77_KEYS, 'catalog.products.manage', 'offers.official.manage', 'returns.inspections.perform']);
    expect(expanded).toEqual(expect.arrayContaining(G77_KEYS));
    expect(expanded).not.toContain('catalog.products.manage');
    expect(expanded).not.toContain('offers.official.manage');
  });

  it('a new install: the Business Owner holds every registered view key', async () => {
    const views = (await registryKeys()).filter((k) => k.endsWith('.view'));
    expect(views.length).toBeGreaterThan(20);
    expect(await ownerKeys()).toEqual(expect.arrayContaining(views));
    expect(views.sort()).toEqual(staffViewKeys());
    // the wave 2 keys, once their modules declare them
    const declared = G77_KEYS.filter((k) => views.includes(k));
    expect(await ownerKeys()).toEqual(expect.arrayContaining(declared));
  });

  onMongo('a view key registered after the role was seeded reaches it; one the owner removed stays removed', async () => {
    const roleId = await f.roleId('business_owner');
    const [late, removed] = (await registryKeys()).filter((k) => k.endsWith('.view')).slice(0, 2) as [string, string];
    // `late`: as if this version declares it for the first time (not in the registry, not on the role)
    await f.table('permissions').deleteMany({ key: late });
    await f.table('role_permissions').deleteMany({ role_id: roleId, permission_key: [late, removed] });
    // `removed`: still registered, taken off the role by the owner
    await f.svc.core.doSync();
    const keys = await ownerKeys();
    expect(keys).toContain(late);
    expect(keys).not.toContain(removed);
  });

  onMongo('a module added after the roles were seeded: its keys reach the system roles whose seed covers them', async () => {
    const BACKUPS = ['backups.view', 'backups.create', 'backups.download', 'backups.restore'];
    const keysOf = async (role: string) => (await f.table('role_permissions').find({ role_id: await f.roleId(role) })).map((r) => r.permission_key as string);
    // as if this version adds the backups module to an install whose roles were seeded before it
    await f.table('permissions').deleteMany({ key: BACKUPS });
    await f.table('role_permissions').deleteMany({ permission_key: BACKUPS });
    await f.svc.core.doSync();
    expect(await keysOf('business_owner')).toEqual(expect.arrayContaining(BACKUPS));
    const admin = await keysOf('platform_administrator');
    expect(admin).toEqual(expect.arrayContaining(['backups.view', 'backups.create']));
    expect(admin).not.toContain('backups.download');
    expect(admin).not.toContain('backups.restore');
    expect((await keysOf('support_agent')).filter((k) => k.startsWith('backups.'))).toEqual([]);
    // once registered, a key the owner takes off a role is not added back
    await f.table('role_permissions').deleteMany({ role_id: await f.roleId('platform_administrator'), permission_key: 'backups.create' });
    await f.svc.core.doSync();
    expect(await keysOf('platform_administrator')).not.toContain('backups.create');
  });

  it('roles holding a manage or record key of those pages get the matching view key in the seed', () => {
    const seed = (key: string) => SYSTEM_ROLES.find((r) => r.key === key)!.permissions;
    const registry = [...G77_KEYS, 'returns.inspections.record', 'returns.requests.view', 'catalog.products.review', 'catalog.products.manage-official', 'offers.official.manage', 'offers.official.price', 'sellers.applications.review', 'content.pages.manage', 'content.homepage.manage', 'support.cases.view'];
    expect(expandPermissions(seed('returns_manager'), registry)).toContain('returns.inspections.view');
    expect(expandPermissions(seed('catalog_manager'), registry)).toContain('catalog.view');
    expect(expandPermissions(seed('seller_manager'), registry)).toContain('sellers.applications.view');
    const official = SYSTEM_ROLES.find((r) => r.permissions.includes('offers.official.manage'))!;
    expect(expandPermissions(official.permissions, registry)).toEqual(expect.arrayContaining(['offers.official.view', 'catalog.view']));
    const content = SYSTEM_ROLES.find((r) => r.permissions.some((p) => p.startsWith('content.')))!;
    expect(expandPermissions(content.permissions, registry)).toContain('content.view');
    // no key under the prefix: no view key
    expect(expandPermissions(seed('support_agent'), registry)).not.toEqual(expect.arrayContaining(['catalog.view']));
    expect(expandPermissions(seed('support_agent'), registry).filter((k) => G77_KEYS.includes(k))).toEqual([]);
  });

  it.runIf(staffViewKeys().includes('returns.inspections.view') && onMongoDb)('an existing install: the Returns Manager gets returns.inspections.view when it is registered, and from the migration', async () => {
    const roleId = await f.roleId('returns_manager');
    const keys = async () => (await f.table('role_permissions').find({ role_id: roleId })).map((r) => r.permission_key as string);
    expect(await keys()).toContain('returns.inspections.view'); // new install (seed)
    await f.table('permissions').deleteMany({ key: 'returns.inspections.view' });
    await f.table('role_permissions').deleteMany({ permission_key: 'returns.inspections.view' });
    await f.svc.core.doSync();
    expect(await keys()).toContain('returns.inspections.view');
    expect(await ownerKeys()).toContain('returns.inspections.view');
    // the migration restores it once more
    await f.table('role_permissions').deleteMany({ role_id: roleId, permission_key: 'returns.inspections.view' });
    await businessOwnerViewKeys.up(f.app.kernel.mongo.db);
    expect(await keys()).toContain('returns.inspections.view');
    expect((await f.table('role_permissions').find({ role_id: await f.roleId('support_agent') })).map((r) => r.permission_key)).not.toContain('returns.inspections.view');
  });

  onMongo('the migration gives a role seeded before them every view key, the wave 2 keys included once declared', async () => {
    const roleId = await f.roleId('business_owner');
    const views = staffViewKeys();
    await f.table('role_permissions').deleteMany({ role_id: roleId, permission_key: views });
    expect((await ownerKeys()).filter((k) => k.endsWith('.view'))).toEqual([]);
    await businessOwnerViewKeys.up(f.app.kernel.mongo.db);
    await businessOwnerViewKeys.up(f.app.kernel.mongo.db); // safe to run again
    const keys = await ownerKeys();
    expect(keys.filter((k) => k.endsWith('.view')).sort()).toEqual(views);
    expect(keys).toEqual(expect.arrayContaining(G77_KEYS.filter((k) => views.includes(k))));
    // other roles are untouched
    expect((await f.table('role_permissions').find({ role_id: await f.roleId('support_agent') })).map((r) => r.permission_key)).not.toContain('finance.ledger.view');
  });
});
