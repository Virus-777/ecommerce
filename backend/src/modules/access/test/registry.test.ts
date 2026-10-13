import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { allSpecs } from '../../../kernel/module-system/loader.js';
import { SYSTEM_ROLES } from '../domain/seed.js';
import { accessFixture, type Fixture } from './fixture.js';

let f: Fixture;
beforeAll(async () => {
  f = await accessFixture();
});
afterAll(async () => {
  await f?.close();
});

describe('registry sync and system roles', () => {
  it('registers every staff permission of every spec, and only staff keys', async () => {
    const rows = await f.table('permissions').find();
    const staffKeys = Object.values(allSpecs).flatMap((s) => s.permissions.filter((p) => p.audience === 'staff').map((p) => p.key));
    expect(rows.map((r) => r.key).sort()).toEqual([...staffKeys].sort());
    expect(rows.find((r) => r.key === 'finance.payouts.approve')!.sensitive).toBe(true);
    expect(rows.find((r) => r.key === 'access.roles.manage')!.sensitive).toBe(true);
    expect(rows.find((r) => r.key === 'catalog.products.review')!.sensitive).toBe(false);
    expect(rows.find((r) => r.key === 'finance.balances.view')).toBeUndefined(); // seller audience
  });

  it('marks permissions of modules that are off as unavailable (wallet is off at launch)', async () => {
    const wallet = await f.table('permissions').find({ module: 'wallet' });
    expect(wallet.length).toBeGreaterThan(0);
    expect(wallet.every((p) => p.unavailable_since)).toBe(true);
    const actions = await f.call('GET', '/approval-actions', f.token('00000000-0000-7000-8000-000000000001'));
    expect(actions.status).toBe(200);
    expect(actions.body.find((a: any) => a.key === 'wallet.goodwill.grant').available).toBe(false);
    expect(actions.body.find((a: any) => a.key === 'finance.payouts.release')).toMatchObject({ available: true, limit: 'money', secondReviewer: 'above-limit', defaultEligibleRoleKeys: ['finance_manager', 'business_owner'] });
  });

  it('seeds the system roles once, and syncing again changes nothing', async () => {
    const count = async () => ({
      roles: await f.table('roles').count(),
      perms: await f.table('role_permissions').count(),
      limits: await f.table('approval_limits').count(),
      registry: await f.table('permissions').count(),
    });
    const before = await count();
    expect(before.roles).toBe(SYSTEM_ROLES.length);
    await f.svc.syncRegistry();
    await f.app.kernel.jobs.runNow('access.sync-registry');
    expect(await count()).toEqual(before);
  });

  it('expands seed permission sets to explicit staff keys', async () => {
    const perms = async (key: string) =>
      (await f.table('role_permissions').find({ role_id: await f.roleId(key) })).map((r) => r.permission_key);
    const finance = await perms('finance_manager');
    expect(finance).toContain('finance.payouts.approve');
    expect(finance).toContain('payments.refunds.manage');
    expect(finance).toContain('workqueues.items.work');
    expect(finance).not.toContain('finance.balances.view');
    const support = await perms('customer_support_manager');
    expect(support).toContain('customers.accounts.view');
    expect(support).not.toContain('customers.accounts.export');
    const owner = await perms('business_owner');
    expect(owner).toContain('access.limits.approve');
    expect(owner).toContain('orders.orders.view');
    expect(owner).not.toContain('access.roles.manage');
  });

  it('lets every role that approves refunds see the refund requests (GET /api/admin/returns/refunds)', () => {
    const approvers = SYSTEM_ROLES.filter((r) => r.permissions.includes('returns.refunds.approve'));
    expect(approvers.map((r) => r.key)).toEqual(expect.arrayContaining(['finance_manager', 'finance_staff']));
    for (const r of approvers) expect(r.permissions.some((p) => p === 'returns.requests.view' || p === 'returns.requests.*'), r.key).toBe(true);
  });

  it('gives the Business Owner authority for every registered action, and seeds example limits', async () => {
    const actions = await f.table('approval_actions').find();
    const bo = await f.table('approval_limits').find({ role_id: await f.roleId('business_owner') });
    expect(bo.length).toBe(actions.length);
    expect(bo.every((l) => l.authority === 'permitted' && l.limit_amount_minor === null)).toBe(true);
    const limits = await f.call('GET', `/limits?roleId=${await f.roleId('finance_staff')}&actionKey=returns.refunds.approve`, f.token('00000000-0000-7000-8000-000000000001'));
    expect(limits.status).toBe(200);
    expect(limits.body).toHaveLength(1);
    expect(limits.body[0]).toMatchObject({ summary: 'Up to $2,000.00 · second reviewer above $1,000.00', value: { authority: 'permitted', limitMoney: { amount: 200000, currency: 'USD' } } });
  });
});

describe('hasPermission and permissionsOf', () => {
  it('answers from the roles a staff member holds, exact keys only', async () => {
    const ana = await f.staff('Ana Finance', ['finance_staff']);
    const p = f.principal(ana);
    expect(await f.svc.hasPermission(p, 'returns.refunds.approve')).toBe(true);
    expect(await f.svc.hasPermission(p, 'finance.payouts.approve')).toBe(false);
    expect(await f.svc.hasPermission(p, 'finance.ledger')).toBe(false);
    expect(await f.svc.hasPermission({ ...p, kind: 'customer' }, 'returns.refunds.approve')).toBe(false);
    expect(await f.svc.permissionsOf(ana)).toContain('finance.ledger.view');
    // the kernel guard asks access through the public API
    const api = f.app.kernel.boot.apis.get('access') as { hasPermission: typeof f.svc.hasPermission };
    expect(await api.hasPermission(p, 'finance.ledger.view')).toBe(true);
  });

  it('includes a covered role only where the away period grants it (approved delegation) and only while it is in force', async () => {
    const away = await f.staff('Wes Warehouse', ['warehouse_manager']);
    const owner = await f.staff('Owen Owner', ['business_owner']);
    const cover = await f.staff('Otto Cover', ['support_agent']);
    const plain = await f.staff('Pam Plain', ['support_agent']);
    const roleId = await f.roleId('warehouse_manager');
    const from = new Date(f.clock.now().getTime() + 3_600_000);
    const to = new Date(from.getTime() + 2 * 86_400_000);
    const period = (coveredBy: string, delegateApprovals: boolean, accountId = away) =>
      f.call('POST', '/away-periods', f.token(accountId), { from: from.toISOString(), to: to.toISOString(), coverage: [{ roleId, coveredByAccountId: coveredBy }], delegateApprovals });
    const delegated = await period(cover, true);
    expect(delegated.status, JSON.stringify(delegated.body)).toBe(201);
    expect(delegated.body.status).toBe('pending_approval');
    await f.svc.decide(delegated.body.approval.approvalRequestId, f.principal(owner), { kind: 'approve' });
    const other = await f.staff('Vic Warehouse', ['warehouse_manager']);
    expect((await period(plain, false, other)).status).toBe(201); // coverage without delegation only re-routes work
    expect(await f.svc.hasPermission(f.principal(cover), 'warehouse.bins.manage')).toBe(false);
    f.clock.advance(2 * 3_600_000);
    try {
      expect(await f.svc.hasPermission(f.principal(cover), 'warehouse.bins.manage')).toBe(true);
      expect(await f.svc.hasPermission(f.principal(plain), 'warehouse.bins.manage')).toBe(false);
      f.clock.advance(3 * 86_400_000);
      expect(await f.svc.hasPermission(f.principal(cover), 'warehouse.bins.manage')).toBe(false);
    } finally {
      f.clock.reset();
    }
  });
});
