/**
 * G77: the Business Owner holds every `*.view` permission key (owner decision 2026-10-16), on new installs (seed),
 * for keys registered later (registry sync) and on installs seeded before the read-only view keys (migration).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { businessOwnerViewKeys, staffViewKeys } from '../migrations.js';
import { expandPermissions, SYSTEM_ROLES } from '../domain/seed.js';
import { accessFixture, type Fixture } from './fixture.js';

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

  it('a view key registered after the role was seeded reaches it; one the owner removed stays removed', async () => {
    const roleId = await f.roleId('business_owner');
    const [late, removed] = (await registryKeys()).filter((k) => k.endsWith('.view')).slice(0, 2) as [string, string];
    // `late`: as if this version declares it for the first time (not in the registry, not on the role)
    await f.table('permissions').deleteMany({ key: late });
    await f.table('role_permissions').deleteMany({ role_id: roleId, permission_key: { $in: [late, removed] } });
    // `removed`: still registered, taken off the role by the owner
    await f.svc.core.doSync();
    const keys = await ownerKeys();
    expect(keys).toContain(late);
    expect(keys).not.toContain(removed);
  });

  it('the migration gives a role seeded before them every view key, the wave 2 keys included once declared', async () => {
    const roleId = await f.roleId('business_owner');
    const views = staffViewKeys();
    await f.table('role_permissions').deleteMany({ role_id: roleId, permission_key: { $in: views } });
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
