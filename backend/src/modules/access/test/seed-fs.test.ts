/**
 * Fulfilled by Marketly (phase 4): the fulfillment-service staff keys are seeded for the roles that do the
 * service's work (fresh installs) and added by migration 0004 on installs seeded before them.
 */
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { m0004FsSeedPermissions } from '../infra/postgres/migrations/0004_fs_seed_permissions.js';
import { accessFixture, usd, type Fixture } from './fixture.js';

let f: Fixture;
beforeAll(async () => {
  f = await accessFixture();
});
afterAll(async () => {
  await f?.close();
});

async function permissionsOf(roleKey: string) {
  const roleId = await f.roleId(roleKey);
  return (await f.db.selectFrom('role_permissions').select('permission_key').where('role_id', '=', roleId).execute()).map((r) => r.permission_key);
}

const EXPECTED: [string, string[]][] = [
  ['seller_manager', ['fulfillment-service.enrollment.review']],
  ['warehouse_manager', ['fulfillment-service.inbound.receive', 'fulfillment-service.operations.view']],
  ['warehouse_worker', ['fulfillment-service.inbound.receive']],
  ['inventory_manager', ['fulfillment-service.operations.view']],
  ['order_manager', ['fulfillment-service.operations.view']],
  ['returns_manager', ['fulfillment-service.inbound.receive']],
  ['finance_manager', ['fulfillment-service.fees.manage']],
];

describe('Fulfilled by Marketly staff permissions', () => {
  it('seeds each role with exactly its fulfillment-service keys (never a seller-audience key)', async () => {
    for (const [role, keys] of EXPECTED) {
      const fs = (await permissionsOf(role)).filter((k) => k.startsWith('fulfillment-service.'));
      expect(fs.sort(), role).toEqual([...keys].sort());
    }
    // the Business Owner reads every view key, operations included; nobody else gets the FS keys
    expect(await permissionsOf('business_owner')).toContain('fulfillment-service.operations.view');
    for (const role of ['shipping_manager', 'catalog_manager', 'support_agent', 'finance_staff', 'platform_administrator']) {
      expect((await permissionsOf(role)).filter((k) => k.startsWith('fulfillment-service.')), role).toEqual([]);
    }
    for (const [role] of EXPECTED) {
      expect(await permissionsOf(role), role).not.toEqual(expect.arrayContaining(['fulfillment-service.inbound.manage']));
    }
  });

  it('keeps the seeded approval limits of the service actions (fulfillment-service is off here: the rows are what check() reads once it is on)', async () => {
    const limit = async (role: string, action: string) =>
      f.db.selectFrom('approval_limits').selectAll().where('role_id', '=', await f.roleId(role)).where('action_key', '=', action).executeTakeFirst();
    expect(await limit('warehouse_manager', 'fulfillment-service.reimbursements.approve')).toMatchObject({ authority: 'permitted', limit_amount_minor: usd(500).amount });
    expect(await limit('finance_manager', 'fulfillment-service.reimbursements.approve')).toMatchObject({ authority: 'permitted', limit_amount_minor: usd(10_000).amount });
    expect(await limit('finance_manager', 'fulfillment-service.charges.reverse')).toMatchObject({ authority: 'permitted', limit_amount_minor: usd(10_000).amount });
  });

  it('migration 0004 adds them on installs seeded before them, idempotently, and leaves other roles alone', async () => {
    for (const [role, keys] of EXPECTED) {
      const roleId = await f.roleId(role);
      await f.db.deleteFrom('role_permissions').where('role_id', '=', roleId).where('permission_key', 'in', keys).execute();
    }
    expect(await permissionsOf('seller_manager')).not.toContain('fulfillment-service.enrollment.review');
    await sql.raw(m0004FsSeedPermissions.sql!).execute(f.app.kernel.database.kysely);
    await sql.raw(m0004FsSeedPermissions.sql!).execute(f.app.kernel.database.kysely); // running it again changes nothing
    for (const [role, keys] of EXPECTED) expect(await permissionsOf(role), role).toEqual(expect.arrayContaining(keys));
    expect((await permissionsOf('shipping_manager')).filter((k) => k.startsWith('fulfillment-service.'))).toEqual([]);
  });

});
