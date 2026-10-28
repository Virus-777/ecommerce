/**
 * Phase 4 of the department pages (2026-10-24): the farm, registered device, game server key and review moderation keys
 * on new installs (seed) and on installs seeded before them (migration 2026-10-24-phase4-keys), mirroring Phase 3.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PHASE4_MANAGE, PHASE4_SUPPORT } from '../domain/seed.js';
import { phase4Keys } from '../migrations.js';
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

let f: Fixture;
beforeAll(async () => {
  f = await accessFixture();
});
afterAll(async () => {
  await f?.close();
});

const ALL = ['farm.view', 'farm.manage', 'farm.orders.manage', 'services.devices.manage', 'departments.play.keys', 'departments.reviews.manage'];
const keysOf = async (roleKey: string) => (await f.table('role_permissions').find({ role_id: await f.roleId(roleKey) })).map((r) => r.permission_key as string);
const phase4Of = async (roleKey: string) => (await keysOf(roleKey)).filter((k) => ALL.includes(k)).sort();

describe('farm, devices, game server keys and review moderation keys', () => {
  it('seed: the Content Manager runs them, Marketing keeps dealers, keys and reviews, support handles farm orders and devices', async () => {
    expect(await phase4Of('content_manager')).toEqual([...ALL].sort());
    expect(await phase4Of('marketing_manager')).toEqual(['departments.play.keys', 'departments.reviews.manage', 'farm.manage', 'farm.view']);
    for (const role of ['customer_support_manager', 'support_agent']) expect(await phase4Of(role), role).toEqual([...PHASE4_SUPPORT].sort());
    // the Business Owner reads every page (*.view)
    expect(await phase4Of('business_owner')).toEqual(['farm.view']);
    expect(await phase4Of('finance_manager')).toEqual([]);
  });

  onMongo('migration: roles seeded before the keys get them once, the Business Owner the manage keys only when it edits department pages', async () => {
    const roles = ['content_manager', 'marketing_manager', 'customer_support_manager', 'support_agent', 'business_owner'];
    const expected: Record<string, string[]> = {};
    for (const r of roles) expected[r] = await phase4Of(r);
    // as if the roles were seeded before the keys existed
    await f.table('role_permissions').deleteMany({ permission_key: ALL });
    await phase4Keys.up(f.app.kernel.mongo.db);
    for (const r of ['content_manager', 'marketing_manager', 'customer_support_manager', 'support_agent']) expect(await phase4Of(r), r).toEqual(expected[r]);
    expect(await phase4Of('business_owner')).toEqual([]); // view keys come from the registry sync

    const owner = await f.roleId('business_owner');
    if (!(await f.table('role_permissions').count({ role_id: owner, permission_key: 'departments.blogs.manage' }))) {
      await f.table('role_permissions').insert({ role_id: owner, permission_key: 'departments.blogs.manage', granted_by: 'system', granted_at: new Date() } as never);
    }
    await phase4Keys.up(f.app.kernel.mongo.db);
    await phase4Keys.up(f.app.kernel.mongo.db); // safe to run again
    expect(await phase4Of('business_owner')).toEqual([...PHASE4_MANAGE, 'farm.orders.manage', 'services.devices.manage'].sort());
    expect(await f.table('role_permissions').count({ role_id: owner, permission_key: 'departments.play.keys' })).toBe(1);
  });
});
