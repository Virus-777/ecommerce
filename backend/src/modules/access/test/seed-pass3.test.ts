/**
 * Gap pass 3: seeded recommend_only limits (proposers of Business-Owner-only actions get approval_required,
 * not denied), the settings.changes.apply-owner route, audit.retention.manage and offers.offers.remove seeds
 * (also for existing installs), AuthorityCheck.stepUpRequired and staffWithPermission.
 */
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { m0002Pass3SeedPermissions } from '../infra/postgres/migrations/0002_pass3_seed_permissions.js';
import { m0003Pass4SeedAuditView } from '../infra/postgres/migrations/0003_pass4_seed_audit_view.js';
import { accessFixture, usd, type Fixture } from './fixture.js';

let f: Fixture;
let admin: string;
let owner: string;
let finance: string;
let returnsMgr: string;
beforeAll(async () => {
  f = await accessFixture();
  admin = await f.staff('Pat Admin', ['platform_administrator']);
  owner = await f.staff('Bea Owner', ['business_owner']);
  finance = await f.staff('Fin Manager', ['finance_manager']);
  returnsMgr = await f.staff('Ray Returns', ['returns_manager']);
});
afterAll(async () => {
  await f?.close();
});
beforeEach(() => f.clock.reset());

async function limitOf(roleKey: string, actionKey: string) {
  const roleId = await f.roleId(roleKey);
  return f.db.selectFrom('approval_limits').selectAll().where('role_id', '=', roleId).where('action_key', '=', actionKey).executeTakeFirst();
}

async function permissionsOf(roleKey: string) {
  const roleId = await f.roleId(roleKey);
  return (await f.db.selectFrom('role_permissions').select('permission_key').where('role_id', '=', roleId).execute()).map((r) => r.permission_key);
}

describe('seeded recommend_only limits', () => {
  it('lets the roles that prepare Business-Owner-only actions propose them (approval_required, Business Owner decides)', async () => {
    for (const [roleKey, actionKey] of [
      ['advertising_manager', 'advertising.rules.change'],
      ['finance_manager', 'finance.fees.change'],
      ['returns_manager', 'returns.baseline.change'],
      ['returns_manager', 'returns.policies.shorten-window'],
      ['content_manager', 'content.policies.approve'],
      ['content_manager', 'content.policies.short-notice'],
      ['platform_administrator', 'settings.changes.apply-owner'],
      ['platform_administrator', 'audit.retention.change'],
      ['platform_administrator', 'access.limits.change'],
      ['platform_administrator', 'access.delegations.approve'],
    ] as const) {
      expect(await limitOf(roleKey, actionKey), `${roleKey} ${actionKey}`).toMatchObject({ authority: 'recommend_only' });
    }
    const fees = await f.svc.check(f.principal(finance), 'finance.fees.change');
    expect(fees).toMatchObject({ decision: 'approval_required', reason: 'Your role can recommend only', eligibleApproverRoles: [{ key: 'business_owner' }], stepUpRequired: false });
    expect(fees.eligibleApprovers.map((s) => s.accountId)).toEqual([owner]);
    expect(await f.svc.check(f.principal(returnsMgr), 'returns.baseline.change')).toMatchObject({ decision: 'approval_required' });
    // a role without the seed still may not even propose it
    expect(await f.svc.check(f.principal(returnsMgr), 'finance.fees.change')).toMatchObject({ decision: 'denied' });
  });

  it('routes Business Owner setting rules to the Business Owner only; ordinary changes to a second reviewer', async () => {
    const ownerRule = await f.svc.check(f.principal(admin), 'settings.changes.apply-owner');
    expect(ownerRule).toMatchObject({ decision: 'approval_required', eligibleApproverRoles: [{ key: 'business_owner' }] });
    expect(ownerRule.eligibleApprovers.map((s) => s.accountId)).toEqual([owner]);
    const second = await f.svc.check(f.principal(admin), 'settings.changes.apply');
    expect(second).toMatchObject({ decision: 'approval_required', requiresSecondReviewer: true });
    expect(second.eligibleApproverRoles.map((r) => r.key).sort()).toEqual(['business_owner', 'platform_administrator']);
  });

  it('adds seeded limits a system role never had on later syncs (existing installs), never over a changed one', async () => {
    const roleId = await f.roleId('finance_manager');
    await f.db.deleteFrom('approval_limits').where('role_id', '=', roleId).where('action_key', '=', 'finance.fees.change').execute();
    await f.svc.syncRegistry();
    expect(await limitOf('finance_manager', 'finance.fees.change')).toMatchObject({ authority: 'recommend_only' });
    // a limit the Business Owner set differently stays as it is
    await f.db.updateTable('approval_limits').set({ authority: 'not_permitted' }).where('role_id', '=', roleId).where('action_key', '=', 'finance.fees.change').execute();
    await f.svc.syncRegistry();
    const rows = await f.db.selectFrom('approval_limits').selectAll().where('role_id', '=', roleId).where('action_key', '=', 'finance.fees.change').execute();
    expect(rows.map((r) => r.authority)).toEqual(['not_permitted']);
  });
});

describe('seeded permissions', () => {
  it('gives audit.retention.manage to the Business Owner and Platform Administrator, offers.offers.remove to the Catalog Manager', async () => {
    expect(await permissionsOf('business_owner')).toContain('audit.retention.manage');
    expect(await permissionsOf('platform_administrator')).toContain('audit.retention.manage');
    expect(await permissionsOf('catalog_manager')).toEqual(expect.arrayContaining(['offers.offers.remove', 'offers.offers.view']));
  });

  it('migration 0002 adds them on installs seeded before pass 3', async () => {
    const bo = await f.roleId('business_owner');
    const cat = await f.roleId('catalog_manager');
    await f.db.deleteFrom('role_permissions').where('role_id', '=', bo).where('permission_key', '=', 'audit.retention.manage').execute();
    await f.db.deleteFrom('role_permissions').where('role_id', '=', cat).where('permission_key', '=', 'offers.offers.remove').execute();
    await sql.raw(m0002Pass3SeedPermissions.sql!).execute(f.app.kernel.database.kysely);
    expect(await permissionsOf('business_owner')).toContain('audit.retention.manage');
    expect(await permissionsOf('catalog_manager')).toContain('offers.offers.remove');
    // running it again changes nothing
    await sql.raw(m0002Pass3SeedPermissions.sql!).execute(f.app.kernel.database.kysely);
  });

  it('pass 4: the Platform Administrator reads the action history (fresh seed and migration 0003 on older installs)', async () => {
    expect(await permissionsOf('platform_administrator')).toContain('audit.entries.view');
    expect(await permissionsOf('business_owner')).toContain('audit.entries.view');
    expect(await permissionsOf('finance_manager')).not.toContain('audit.entries.view');
    const pa = await f.roleId('platform_administrator');
    await f.db.deleteFrom('role_permissions').where('role_id', '=', pa).where('permission_key', '=', 'audit.entries.view').execute();
    await sql.raw(m0003Pass4SeedAuditView.sql).execute(f.app.kernel.database.kysely);
    expect(await permissionsOf('platform_administrator')).toContain('audit.entries.view');
    await sql.raw(m0003Pass4SeedAuditView.sql).execute(f.app.kernel.database.kysely); // idempotent
  });
});

describe('AuthorityCheck.stepUpRequired', () => {
  it('is true when the amount is above stepUpAbove ($10,000 by default)', async () => {
    expect(await f.svc.check(f.principal(finance), 'finance.payouts.release', { money: usd(20_000) })).toMatchObject({ decision: 'allowed', stepUpRequired: true });
    expect(await f.svc.check(f.principal(finance), 'finance.payouts.release', { money: usd(5_000) })).toMatchObject({ decision: 'allowed', stepUpRequired: false });
    expect(await f.svc.check(f.principal(finance), 'inventory.adjustments.apply', { number: 50_000 })).toMatchObject({ stepUpRequired: false });
  });
});

describe('staffWithPermission', () => {
  it('lists active holders, leaves out disabled accounts, shows locked ones away and adds away-period cover on request', async () => {
    const fs = await f.staff('Fay Staff', ['finance_staff']);
    const gone = await f.staff('Dee Disabled', ['finance_staff'], 'disabled');
    const locked = await f.staff('Lou Locked', ['finance_staff'], 'locked');
    const helper = await f.staff('Hal Helper', ['support_agent']);
    const holders = await f.svc.staffWithPermission('finance.reconciliation.work');
    const ids = holders.map((s) => s.accountId);
    expect(ids).toEqual(expect.arrayContaining([fs, locked, finance]));
    expect(ids).not.toContain(gone);
    expect(ids).not.toContain(helper);
    expect(holders.find((s) => s.accountId === locked)).toMatchObject({ away: true });
    expect(holders.find((s) => s.accountId === fs)).toMatchObject({ away: false, roleLabel: 'Finance Staff' });

    // Fay is away and Hal covers her finance_staff role (no delegation): only includeCovering lists Hal
    const from = new Date(f.clock.now().getTime() + 60_000).toISOString();
    const to = new Date(f.clock.now().getTime() + 48 * 3_600_000).toISOString();
    const away = await f.call('POST', '/away-periods', f.token(fs), { from, to, coverage: [{ roleId: await f.roleId('finance_staff'), coveredByAccountId: helper }], delegateApprovals: false, reason: 'Holiday' });
    expect(away.status, JSON.stringify(away.body)).toBe(201);
    f.clock.advance(5 * 60_000);
    expect((await f.svc.staffWithPermission('finance.reconciliation.work')).map((s) => s.accountId)).not.toContain(helper);
    expect((await f.svc.staffWithPermission('finance.reconciliation.work', { includeCovering: true })).map((s) => s.accountId)).toContain(helper);
    expect(await f.svc.staffWithPermission('nope.nothing.here')).toEqual([]);
  });
});

describe('rolesOf', () => {
  it('answers the reviewer roles advertising checks (advertising, content and marketing managers)', async () => {
    const ads = await f.staff('Ada Ads', ['advertising_manager']);
    const both = await f.staff('Cora Content', ['content_manager', 'marketing_manager']);
    expect((await f.svc.rolesOf(ads)).map((r) => r.key)).toEqual(['advertising_manager']);
    expect((await f.svc.rolesOf(both)).map((r) => r.key).sort()).toEqual(['content_manager', 'marketing_manager']);
  });
});
