/**
 * Live topics (2026-10-20): announcements from Marketly to sellers need notifications.announcements.send, held by the
 * Seller Manager and the Platform Administrator on new installs (seed) and on installs seeded before it (migration
 * 2026-10-20-announcement-keys).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { announcementKeys } from '../migrations.js';
import { ANNOUNCEMENTS_SEND } from '../domain/seed.js';
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

const keysOf = async (roleKey: string) => (await f.table('role_permissions').find({ role_id: await f.roleId(roleKey) })).map((r) => r.permission_key as string);

describe('announcements to sellers (notifications.announcements.send)', () => {
  onMongo('seed and migration: the Seller Manager and Platform Administrator, once; nobody else', async () => {
    for (const key of ['seller_manager', 'platform_administrator']) expect(await keysOf(key), key).toContain(ANNOUNCEMENTS_SEND);
    for (const key of ['marketing_manager', 'customer_support_manager', 'reports_analyst']) expect(await keysOf(key), key).not.toContain(ANNOUNCEMENTS_SEND);

    // as if the roles were seeded before the key existed
    await f.table('role_permissions').deleteMany({ permission_key: ANNOUNCEMENTS_SEND });
    await announcementKeys.up(f.app.kernel.mongo.db);
    await announcementKeys.up(f.app.kernel.mongo.db); // safe to run again
    for (const key of ['seller_manager', 'platform_administrator']) {
      expect(await f.table('role_permissions').find({ role_id: await f.roleId(key), permission_key: ANNOUNCEMENTS_SEND }), key).toHaveLength(1);
    }
    expect(await keysOf('marketing_manager')).not.toContain(ANNOUNCEMENTS_SEND);
  });
});
