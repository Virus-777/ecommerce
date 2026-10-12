import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { accessFixture, usd, type Fixture } from './fixture.js';

let f: Fixture;
let admin: string;
let owner: string;
let lead: string; // finance manager leading the role
let backup: string; // finance manager, first backup
let backup2: string;
let staff: string;
let roleId: string;
const H = 3_600_000;
beforeAll(async () => {
  f = await accessFixture();
  admin = await f.staff('Pat Admin', ['platform_administrator']);
  owner = await f.staff('Bea Owner', ['business_owner']);
  lead = await f.staff('Lena Lead', ['finance_manager']);
  backup = await f.staff('Bo Backup', ['finance_manager']);
  backup2 = await f.staff('Cy Backup', ['finance_manager']);
  staff = await f.staff('Ana Staff', ['finance_staff']);
  roleId = await f.roleId('finance_manager');
  const res = await f.call('PUT', `/roles/${roleId}/coverage`, f.token(admin), { leadAccountId: lead, backupAccountIds: [backup, backup2], reason: 'Set up' });
  expect(res.status).toBe(200);
});
afterAll(async () => {
  await f?.close();
});
beforeEach(() => f.clock.reset());

describe('coverage', () => {
  it('validates the lead and backups', async () => {
    const outsider = await f.staff('Otto', ['support_agent']);
    const res = await f.call('PUT', `/roles/${roleId}/coverage`, f.token(admin), { leadAccountId: outsider, backupAccountIds: [backup, backup, outsider], reason: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('COVERAGE_INVALID');
    expect(res.body.error.details.issues.map((i: any) => i.path)).toEqual(['leadAccountId', 'backupAccountIds.1', 'backupAccountIds.2']);
  });

  it('routes work to the lead and reports gaps', async () => {
    expect(await f.svc.resolveRecipients('finance_manager')).toMatchObject({ leadAccountId: lead, accountIds: [lead], ccAccountIds: [], viaBackup: false, escalationRoleKey: 'business_owner' });
    expect(await f.svc.resolveRecipients('nope')).toMatchObject({ accountIds: [] });
    const cov = await f.call('GET', '/coverage', f.token(staff));
    expect(cov.status).toBe(200);
    expect(cov.body.roles.find((r: any) => r.role.key === 'finance_manager')).toMatchObject({ lead: { accountId: lead }, backups: [{ accountId: backup }, { accountId: backup2 }], receivingNow: [{ accountId: lead }] });
    expect(cov.body.gaps.find((g: any) => g.kind === 'no_lead' && g.roles[0].key === 'finance_staff')).toMatchObject({ severity: 'review' });
  });

  it('treats a locked lead as unavailable until unlocked', async () => {
    f.events.length = 0;
    f.accounts.set(lead, { ...f.accounts.get(lead)!, status: 'locked' });
    await f.svc.onAccountLockedFromIdentity({ accountId: lead, realm: 'staff', cause: 'failed_sign_ins' });
    await f.drain();
    expect(await f.svc.resolveRecipients('finance_manager')).toMatchObject({ accountIds: [backup], ccAccountIds: [lead], viaBackup: true });
    expect(f.eventsNamed('access.coverage.changed').find((e) => e.roleId === roleId)).toMatchObject({ receivingAccountIds: [backup], viaBackup: true });
    f.accounts.set(lead, { ...f.accounts.get(lead)!, status: 'active' });
    await f.svc.onAccountUnlockedFromIdentity({ accountId: lead, by: { kind: 'system' } });
    await f.drain();
    expect(await f.svc.resolveRecipients('finance_manager')).toMatchObject({ accountIds: [lead], viaBackup: false });
    expect(f.eventsNamed('access.coverage.changed').at(-1)).toMatchObject({ receivingAccountIds: [lead], viaBackup: false });
  });
});

describe('away periods', () => {
  it('needs cover for every led role, refuses overlaps and others without access.away.manage', async () => {
    const from = new Date(Date.now() + 2 * H).toISOString();
    const to = new Date(Date.now() + 50 * H).toISOString();
    const noCover = await f.call('POST', '/away-periods', f.token(lead), { from, to, coverage: [], delegateApprovals: false });
    expect(noCover.status).toBe(400);
    expect(noCover.body.error.code).toBe('COVERAGE_INVALID');
    const wrongCover = await f.call('POST', '/away-periods', f.token(lead), { from, to, coverage: [{ roleId, coveredByAccountId: staff }], delegateApprovals: false });
    expect(wrongCover.body.error.code).toBe('COVERAGE_INVALID');
    const backwards = await f.call('POST', '/away-periods', f.token(lead), { from: to, to: from, coverage: [{ roleId, coveredByAccountId: backup }], delegateApprovals: false });
    expect(backwards.status).toBe(400);
    const forOther = await f.call('POST', '/away-periods', f.token(staff, ['access.roles.view']), { accountId: lead, from, to, coverage: [{ roleId, coveredByAccountId: backup }], delegateApprovals: false });
    expect(forOther.status).toBe(403);
    expect(forOther.body.error).toMatchObject({ code: 'FORBIDDEN', details: { permission: 'access.away.manage' } });

    const ok = await f.call('POST', '/away-periods', f.token(lead), { from, to, coverage: [{ roleId, coveredByAccountId: backup }], delegateApprovals: false, reason: 'Holiday' });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ status: 'scheduled', account: { accountId: lead }, coverage: [{ role: { key: 'finance_manager' }, coveredBy: { accountId: backup } }] });
    const overlap = await f.call('POST', '/away-periods', f.token(lead), { from, to, coverage: [{ roleId, coveredByAccountId: backup2 }], delegateApprovals: false });
    expect(overlap.status).toBe(409);
    expect(overlap.body.error.code).toBe('AWAY_OVERLAP');
    const list = await f.call('GET', `/away-periods?accountId=${lead}`, f.token(admin));
    expect(list.body.items.map((p: any) => p.id)).toEqual([ok.body.id]);
    const cancelled = await f.call('POST', `/away-periods/${ok.body.id}/cancel`, f.token(lead), { reason: 'Trip off' });
    expect(cancelled.body.status).toBe('cancelled');
    const endCancelled = await f.call('POST', `/away-periods/${ok.body.id}/end`, f.token(lead));
    expect(endCancelled.status).toBe(409);
  });

  it('starts and ends on time (job), re-routing work to the covering person', async () => {
    const from = new Date(Date.now() + H);
    const to = new Date(Date.now() + 10 * H);
    const res = await f.call('POST', '/away-periods', f.token(lead), { from: from.toISOString(), to: to.toISOString(), coverage: [{ roleId, coveredByAccountId: backup2 }], delegateApprovals: false });
    expect(res.status).toBe(201);
    f.events.length = 0;
    f.clock.advance(2 * H);
    await f.app.kernel.jobs.runNow('access.run-away-periods');
    await f.drain();
    expect(f.eventsNamed('access.away.started')).toEqual([expect.objectContaining({ awayPeriodId: res.body.id, accountId: lead, coverage: [{ roleId, coveredByAccountId: backup2 }], delegateApprovals: false })]);
    expect(f.eventsNamed('access.coverage.changed').find((e) => e.roleId === roleId)).toMatchObject({ receivingAccountIds: [backup2], viaBackup: true });
    expect(await f.svc.resolveRecipients('finance_manager')).toMatchObject({ accountIds: [backup2], ccAccountIds: [lead], viaBackup: true });
    expect((await f.svc.getStaffRef(lead))!.away).toBe(true);
    // coverage only re-routes work: the backup uses their own limits, not the away person's
    f.clock.advance(10 * H);
    await f.app.kernel.jobs.runNow('access.run-away-periods');
    await f.drain();
    expect(f.eventsNamed('access.away.ended')).toEqual([{ awayPeriodId: res.body.id, accountId: lead }]);
    expect(await f.svc.resolveRecipients('finance_manager')).toMatchObject({ accountIds: [lead], viaBackup: false });
  });

  it('ends early when the person is back', async () => {
    const res = await f.call('POST', '/away-periods', f.token(lead), { from: new Date(Date.now() - 1000).toISOString(), to: new Date(Date.now() + 5 * H).toISOString(), coverage: [{ roleId, coveredByAccountId: backup }], delegateApprovals: false });
    expect(res.body.status).toBe('active');
    const other = await f.call('POST', `/away-periods/${res.body.id}/end`, f.token(staff, []));
    expect(other.status).toBe(403);
    const ended = await f.call('POST', `/away-periods/${res.body.id}/end`, f.token(lead));
    expect(ended.status).toBe(200);
    expect(ended.body.status).toBe('ended');
  });

  it('delegates approval authority only after the Business Owner approves, and never above the away person', async () => {
    const holder = await f.staff('Hal Holder', ['finance_staff']); // $2,000 refunds, away
    const coverer = await f.staff('Cora Cover', ['finance_staff', 'support_agent']);
    const from = new Date(Date.now() + H);
    const to = new Date(Date.now() + 30 * H);
    const res = await f.call('POST', '/away-periods', f.token(holder), {
      from: from.toISOString(),
      to: to.toISOString(),
      coverage: [{ roleId: await f.roleId('finance_staff'), coveredByAccountId: coverer }],
      delegateApprovals: true,
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'pending_approval', delegateApprovals: true, approval: { required: true, approvers: ['Business Owner'] } });
    await expect(f.svc.decide(res.body.approval.approvalRequestId, f.principal(admin), { kind: 'approve' })).rejects.toMatchObject({ code: 'NOT_ELIGIBLE_APPROVER' });
    await f.svc.decide(res.body.approval.approvalRequestId, f.principal(owner), { kind: 'approve' });
    const approved = (await f.call('GET', `/away-periods?accountId=${holder}`, f.token(admin))).body.items[0];
    expect(approved.status).toBe('scheduled');

    // Cora holds finance staff herself: her own limits apply
    const requester = await f.staff('Rex Requester', ['support_agent']);
    const refund = (dollars: number) =>
      f.svc.requestApproval({ action: 'returns.refunds.approve', target: { type: 'refund_request', id: newId() }, amount: usd(dollars), summary: `Refund $${dollars}`, reason: 'Late', requestedBy: f.principal(requester) });
    f.clock.advance(2 * H);
    await f.app.kernel.jobs.runNow('access.run-away-periods');
    expect((await f.svc.decide((await refund(500)).id, f.principal(coverer), { kind: 'approve' })).approvals[0]!.viaDelegationFrom).toBeNull();
  });

  it('lets a covering person without the role use the away person’s limits, never above them', async () => {
    const holder = await f.staff('Hal Holder', ['finance_staff']); // refunds up to $2,000
    const coverer = await f.staff('Sue Support', ['support_agent']); // no refund authority of her own
    const requester = await f.staff('Rex Requester', ['support_agent']);
    const refund = (dollars: number) =>
      f.svc.requestApproval({ action: 'returns.refunds.approve', target: { type: 'refund_request', id: newId() }, amount: usd(dollars), summary: `Refund $${dollars}`, reason: 'Late', requestedBy: f.principal(requester) });
    const early = await refund(800);
    await expect(f.svc.decide(early.id, f.principal(coverer), { kind: 'approve' })).rejects.toMatchObject({ code: 'NOT_ELIGIBLE_APPROVER' });

    const res = await f.call('POST', '/away-periods', f.token(holder), {
      from: new Date(Date.now() - 1000).toISOString(),
      to: new Date(Date.now() + 5 * H).toISOString(),
      coverage: [{ roleId: await f.roleId('finance_staff'), coveredByAccountId: coverer }],
      delegateApprovals: true,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(await f.svc.hasPermission(f.principal(coverer), 'finance.ledger.view')).toBe(false); // waits for the Business Owner
    await f.svc.decide(res.body.approval.approvalRequestId, f.principal(owner), { kind: 'approve' });
    const row = (await f.table('away_periods').get(res.body.id))!;
    expect(row.status).toBe('active');
    expect(await f.svc.hasPermission(f.principal(coverer), 'finance.ledger.view')).toBe(true);
    const decided = await f.svc.decide(early.id, f.principal(coverer), { kind: 'approve' });
    expect(decided.status).toBe('approved');
    expect(decided.approvals[0]).toMatchObject({ roles: [{ key: 'finance_staff' }], viaDelegationFrom: { accountId: holder } });
    const big = await refund(2500);
    await expect(f.svc.decide(big.id, f.principal(coverer), { kind: 'approve' })).rejects.toMatchObject({ code: 'NOT_ELIGIBLE_APPROVER' });
    expect((await f.svc.check(f.principal(coverer), 'returns.refunds.approve', { money: usd(500) })).decision).toBe('allowed');

    const ended = await f.call('POST', `/away-periods/${res.body.id}/end`, f.token(holder));
    expect(ended.body.status).toBe('ended');
    expect(await f.svc.hasPermission(f.principal(coverer), 'finance.ledger.view')).toBe(false);
  });
});
