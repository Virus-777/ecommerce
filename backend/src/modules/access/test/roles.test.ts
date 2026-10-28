import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { accessFixture, usd, type Fixture } from './fixture.js';

let f: Fixture;
let admin: string; // platform administrator: access.roles.manage
let admin2: string;
let owner: string;
let owner2: string;
beforeAll(async () => {
  f = await accessFixture();
  admin = await f.staff('Pat Admin', ['platform_administrator']);
  admin2 = await f.staff('Quinn Admin', ['platform_administrator']);
  owner = await f.staff('Bea Owner', ['business_owner']);
  owner2 = await f.staff('Ben Owner', ['business_owner']);
});
afterAll(async () => {
  await f?.close();
});

describe('roles', () => {
  it('lists roles with people, lead, backups and limit summary', async () => {
    const res = await f.call('GET', '/roles', f.token(admin));
    expect(res.status).toBe(200);
    const finance = res.body.find((r: any) => r.key === 'finance_manager');
    expect(finance).toMatchObject({ kind: 'management', system: true, archived: false, escalationRole: { key: 'business_owner' } });
    expect(finance.limitSummary).toContain('Payouts: up to $250,000.00');
    expect(res.body.find((r: any) => r.key === 'order_manager').limitSummary).toBe('No financial authority');
    const pa = res.body.find((r: any) => r.key === 'platform_administrator');
    expect(pa.people.map((p: any) => p.name).sort()).toEqual(['Pat Admin', 'Quinn Admin']);
    expect(res.body[0].key).toBe('business_owner');
    const filtered = await f.call('GET', '/roles?q=finance', f.token(admin));
    expect(filtered.body.map((r: any) => r.key).sort()).toEqual(['finance_manager', 'finance_staff']);
  });

  it('creates, renames and archives a custom role', async () => {
    const created = await f.call('POST', '/roles', f.token(admin), { name: 'Night Shift Lead', workArea: 'Orders and shipping', reason: 'New shift' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ key: 'night_shift_lead', kind: 'custom', system: false, permissionCount: 0, limitSummary: 'No financial authority' });
    const dup = await f.call('POST', '/roles', f.token(admin), { name: 'Night shift lead', workArea: 'Orders and shipping', reason: 'Twin' });
    expect(dup.body.key).toBe('night_shift_lead_2');
    const bad = await f.call('POST', '/roles', f.token(admin), { name: 'X', workArea: 'Y', escalationRoleId: newId(), reason: 'r' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('VALIDATION_FAILED');
    const renamed = await f.call('PATCH', `/roles/${created.body.id}`, f.token(admin), { name: 'Night Shift Supervisor', escalationRoleId: await f.roleId('order_manager'), reason: 'Rename' });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ key: 'night_shift_lead', name: 'Night Shift Supervisor', escalationRole: { key: 'order_manager' } });
    const archived = await f.call('POST', `/roles/${created.body.id}/archive`, f.token(admin), { reason: 'Not needed' });
    expect(archived.body.archived).toBe(true);
    const system = await f.call('POST', `/roles/${await f.roleId('order_manager')}/archive`, f.token(admin), { reason: 'x' });
    expect(system.status).toBe(409);
    expect(system.body.error.code).toBe('SYSTEM_ROLE');
    await f.drain();
    expect(f.eventsNamed('access.role.changed').filter((e) => e.roleId === created.body.id).map((e) => e.change)).toEqual(['created', 'updated', 'archived']);
    expect(f.audits.find((a) => a.action === 'access.role.create')).toMatchObject({ reason: 'New shift', target: { type: 'role', id: created.body.id } });
  });

  it('refuses to archive a role still held by someone', async () => {
    const role = await f.call('POST', '/roles', f.token(admin), { name: 'Packers', workArea: 'Inventory and warehouse', kind: 'task', reason: 'r' });
    const member = await f.staff('Pia Packer', []);
    const given = await f.call('POST', '/role-assignments', f.token(admin), { accountId: member, roleId: role.body.id, reason: 'New hire' });
    expect(given.status, JSON.stringify(given.body)).toBe(201);
    expect(given.body.status).toBe('active');
    const res = await f.call('POST', `/roles/${role.body.id}/archive`, f.token(admin), { reason: 'x' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ROLE_IN_USE');
  });
});

describe('role permissions', () => {
  it('rejects unknown keys and applies non-sensitive changes at once', async () => {
    const role = await f.call('POST', '/roles', f.token(admin), { name: 'Catalog Helper', workArea: 'Catalog', reason: 'r' });
    const unknown = await f.call('PUT', `/roles/${role.body.id}/permissions`, f.token(admin), { permissionKeys: ['catalog.products.review', 'nope.x.y', 'finance.balances.view'], reason: 'r' });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toMatchObject({ code: 'UNKNOWN_PERMISSION', details: { keys: ['nope.x.y', 'finance.balances.view'] } });
    const ok = await f.call('PUT', `/roles/${role.body.id}/permissions`, f.token(admin), { permissionKeys: ['catalog.products.review', 'media.assets.view'], reason: 'Help with reviews' });
    expect(ok.status).toBe(200);
    expect(ok.body.role.permissionCount).toBe(2);
    expect(ok.body.pendingPermissionApproval).toBeNull();
    const granted = ok.body.permissions.flatMap((g: any) => g.permissions.filter((p: any) => p.granted).map((p: any) => p.permission.key));
    expect(granted.sort()).toEqual(['catalog.products.review', 'media.assets.view']);
  });

  it('keeps held keys of a module that is off when the role detail is sent back, but never adds one', async () => {
    const roleId = await f.roleId('support_agent'); // seeded with wallet.credit.view; wallet is off at launch
    const detail = await f.call('GET', `/roles/${roleId}`, f.token(admin));
    const held = detail.body.permissions.flatMap((g: any) => g.permissions.filter((p: any) => p.granted).map((p: any) => p.permission));
    expect(held.find((p: any) => p.key === 'wallet.credit.view')).toMatchObject({ available: false });
    const keys = held.map((p: any) => p.key).filter((k: string) => k !== 'customers.notes.write');
    const ok = await f.call('PUT', `/roles/${roleId}/permissions`, f.token(admin), { permissionKeys: keys, reason: 'Notes move to leads' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const after = ok.body.permissions.flatMap((g: any) => g.permissions.filter((p: any) => p.granted).map((p: any) => p.permission.key));
    expect(after).toContain('wallet.credit.view');
    expect(after).not.toContain('customers.notes.write');
    const role = await f.call('POST', '/roles', f.token(admin), { name: 'Credit Viewer', workArea: 'Customers and support', reason: 'r' });
    const add = await f.call('PUT', `/roles/${role.body.id}/permissions`, f.token(admin), { permissionKeys: ['wallet.credit.view'], reason: 'r' });
    expect(add.status).toBe(400);
    expect(add.body.error).toMatchObject({ code: 'UNKNOWN_PERMISSION', details: { keys: ['wallet.credit.view'] } });
  });

  it('holds sensitive permissions for a second staff member with access.roles.manage', async () => {
    const role = await f.call('POST', '/roles', f.token(admin), { name: 'Payout Clerk', workArea: 'Finance', reason: 'r' });
    const res = await f.call('PUT', `/roles/${role.body.id}/permissions`, f.token(admin), { permissionKeys: ['finance.ledger.view', 'workqueues.items.view'], reason: 'Clerk duties' });
    expect(res.status).toBe(200);
    expect(res.body.role.permissionCount).toBe(1); // workqueues.items.view applied, finance.ledger.view waits
    expect(res.body.pendingPermissionApproval).toMatchObject({ required: true });
    const requestId = res.body.pendingPermissionApproval.approvalRequestId;
    await expect(f.svc.decide(requestId, f.principal(admin), { kind: 'approve' })).rejects.toMatchObject({ code: 'SELF_APPROVAL_NOT_ALLOWED' });
    const approved = await f.svc.decide(requestId, f.principal(admin2), { kind: 'approve' });
    expect(approved.status).toBe('approved');
    const detail = await f.call('GET', `/roles/${role.body.id}`, f.token(admin));
    expect(detail.body.role.permissionCount).toBe(2);
    expect(detail.body.pendingPermissionApproval).toBeNull();
  });
});

describe('role assignments', () => {
  it('gives a plain role at once, and a role carrying sensitive permissions after a second reviewer', async () => {
    const member = await f.staff('Mia Member', []);
    const plain = await f.call('POST', '/role-assignments', f.token(admin), { accountId: member, roleId: await f.roleId('order_manager'), reason: 'Promotion' });
    expect(plain.status).toBe(201);
    expect(plain.body).toMatchObject({ status: 'active', role: { key: 'order_manager' }, grantedBy: { kind: 'staff', id: admin } });
    expect(await f.svc.hasPermission(f.principal(member), 'orders.orders.manage')).toBe(true);

    const dup = await f.call('POST', '/role-assignments', f.token(admin), { accountId: member, roleId: await f.roleId('order_manager'), reason: 'Again' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('CONFLICT');

    const sensitive = await f.call('POST', '/role-assignments', f.token(admin), { accountId: member, roleId: await f.roleId('finance_staff'), reason: 'Cover finance' });
    expect(sensitive.body).toMatchObject({ status: 'pending_approval', approval: { required: true } });
    expect(await f.svc.hasPermission(f.principal(member), 'finance.ledger.view')).toBe(false);
    const done = await f.svc.decide(sensitive.body.approval.approvalRequestId, f.principal(admin2), { kind: 'approve' });
    expect(done.status).toBe('approved');
    expect(await f.svc.hasPermission(f.principal(member), 'finance.ledger.view')).toBe(true);
    await f.drain();
    expect(f.eventsNamed('access.role.changed').filter((e) => e.accountId === member).map((e) => e.change)).toEqual(['assigned', 'assigned']);

    const revoked = await f.call('POST', `/role-assignments/${plain.body.id}/revoke`, f.token(admin), { reason: 'Moved team' });
    expect(revoked.body).toMatchObject({ status: 'revoked', revokeReason: 'Moved team', revokedBy: { kind: 'staff', id: admin } });
    const twice = await f.call('POST', `/role-assignments/${plain.body.id}/revoke`, f.token(admin), { reason: 'again' });
    expect(twice.status).toBe(409);
    expect(twice.body.error.code).toBe('ILLEGAL_TRANSITION');
  });

  it('sends a role for yourself and the Business Owner role to the Business Owner only', async () => {
    const self = await f.call('POST', '/role-assignments', f.token(admin), { accountId: admin, roleId: await f.roleId('order_manager'), reason: 'Self' });
    expect(self.body.status).toBe('pending_approval');
    const reqId = self.body.approval.approvalRequestId;
    await expect(f.svc.decide(reqId, f.principal(admin2), { kind: 'approve' })).rejects.toMatchObject({ code: 'NOT_ELIGIBLE_APPROVER' });
    const rejected = await f.svc.decide(reqId, f.principal(owner), { kind: 'reject' });
    expect(rejected.status).toBe('rejected');
    const member = await f.svc.members.getMember(f.principal(owner) as never, admin);
    expect(member.assignments.find((a) => a.id === self.body.id)).toMatchObject({ status: 'revoked' });
  });

  it('keeps at least one Business Owner', async () => {
    const solo = await accessFixture();
    try {
      const only = await solo.staff('Only Owner', ['business_owner']);
      const pa = await solo.staff('Admin', ['platform_administrator']);
      const assignment = (await solo.table('role_assignments').findOne({ account_id: only }))!;
      const res = await solo.call('POST', `/role-assignments/${assignment.id}/revoke`, solo.token(pa), { reason: 'Leaving' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('LAST_BUSINESS_OWNER');
    } finally {
      await solo.close();
    }
    // this one boots an app of its own, which is more than the 60 s a test gets once the workers are all busy
  }, 180_000);

  it('invites staff with roles and returns the link and pass code; assignments start when the invitation is accepted', async () => {
    const res = await f.call('POST', '/staff-invitations', f.token(admin), { email: 'new.hire@marketly.test', name: 'Nina Hire', roleIds: [await f.roleId('support_agent')], reason: 'New agent', requestLimitReview: true });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ member: { status: 'invited', roles: [{ key: 'support_agent' }], limitReview: { required: true } }, passCode: 'ABCD-EFGH' });
    expect(res.body.acceptUrl).toContain('/invitation#token=');
    expect(res.body.expiresAt).toBeTruthy();
    expect(f.invitations.map((i) => i.email)).toContain('new.hire@marketly.test');
    const id = res.body.member.account.id;
    expect(await f.svc.hasPermission(f.principal(id), 'support.cases.view')).toBe(false);
    f.accounts.set(id, { ...f.accounts.get(id)!, status: 'active' });
    await f.svc.onInvitationAcceptedFromIdentity({ invitationId: newId(), accountId: id, purpose: 'staff' });
    await f.svc.onInvitationAcceptedFromIdentity({ invitationId: newId(), accountId: id, purpose: 'staff' }); // twice: same result
    expect(await f.svc.hasPermission(f.principal(id), 'support.cases.view')).toBe(true);
    // limits wait for the Business Owner's review: the new agent may prepare but not approve
    expect((await f.svc.check(f.principal(id), 'support.remedies.approve', { money: usd(10) })).decision).toBe('approval_required');
    const review = await f.svc.getApproval(res.body.member.limitReview.approvalRequestId);
    expect(review).toMatchObject({ action: { key: 'access.limits.change' }, target: { type: 'staff_member', id } });
    await expect(f.svc.decide(review!.id, f.principal(admin2), { kind: 'approve' })).rejects.toMatchObject({ code: 'NOT_ELIGIBLE_APPROVER' });
    await f.svc.decide(review!.id, f.principal(owner), { kind: 'approve' });
    expect((await f.svc.check(f.principal(id), 'support.remedies.approve', { money: usd(10) })).decision).toBe('allowed');
  });

  it('an approved sensitive grant for someone still invited waits for acceptance (guarded approve)', async () => {
    const invite = async (email: string, name: string) => {
      const res = await f.call('POST', '/staff-invitations', f.token(admin), { email, name, roleIds: [await f.roleId('finance_staff')], reason: 'Finance hire' });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const id = res.body.member.account.id as string;
      const assignment = (await f.svc.members.getMember(f.principal(owner) as never, id)).assignments[0]!;
      expect(assignment.status).toBe('pending_approval');
      return { id, assignmentId: assignment.id, requestId: assignment.approval!.approvalRequestId! };
    };
    const statusOf = async (id: string, assignmentId: string) => (await f.svc.members.getMember(f.principal(owner) as never, id)).assignments.find((a) => a.id === assignmentId)!.status;
    const accept = async (id: string) => {
      f.accounts.set(id, { ...f.accounts.get(id)!, status: 'active' });
      await f.svc.onInvitationAcceptedFromIdentity({ invitationId: newId(), accountId: id, purpose: 'staff' });
    };

    // approved before the person accepts: pending_acceptance, no permissions, no role event yet
    const fay = await invite('fay.finance@marketly.test', 'Fay Finance');
    await f.svc.decide(fay.requestId, f.principal(admin2), { kind: 'approve' });
    expect(await statusOf(fay.id, fay.assignmentId)).toBe('pending_acceptance');
    expect(await f.svc.hasPermission(f.principal(fay.id), 'finance.ledger.view')).toBe(false);
    await f.drain();
    expect(f.eventsNamed('access.role.changed').filter((e) => e.accountId === fay.id)).toEqual([]);
    // accepting activates it (twice: same result)
    await accept(fay.id);
    await f.svc.onInvitationAcceptedFromIdentity({ invitationId: newId(), accountId: fay.id, purpose: 'staff' });
    expect(await statusOf(fay.id, fay.assignmentId)).toBe('active');
    expect(await f.svc.hasPermission(f.principal(fay.id), 'finance.ledger.view')).toBe(true);
    await f.drain();
    expect(f.eventsNamed('access.role.changed').filter((e) => e.accountId === fay.id).map((e) => e.change)).toEqual(['assigned']);

    // accepted before the approval: the grant keeps waiting for its approval, then goes straight to active
    const finn = await invite('finn.finance@marketly.test', 'Finn Finance');
    await accept(finn.id);
    expect(await statusOf(finn.id, finn.assignmentId)).toBe('pending_approval');
    await f.svc.decide(finn.requestId, f.principal(admin2), { kind: 'approve' });
    expect(await statusOf(finn.id, finn.assignmentId)).toBe('active');
    expect(await f.svc.hasPermission(f.principal(finn.id), 'finance.ledger.view')).toBe(true);
  });

  it('revokes everything and removes cover when identity disables an account', async () => {
    const lead = await f.staff('Lou Lead', ['shipping_manager']);
    const backup = await f.staff('Bo Backup', ['shipping_manager']);
    const roleId = await f.roleId('shipping_manager');
    const cov = await f.call('PUT', `/roles/${roleId}/coverage`, f.token(admin), { leadAccountId: lead, backupAccountIds: [backup], reason: 'Set up' });
    expect(cov.status).toBe(200);
    expect(cov.body).toMatchObject({ lead: { accountId: lead }, receivingNow: [{ accountId: lead }], viaBackup: false });
    f.events.length = 0;
    await f.svc.onAccountDisabledFromIdentity({ accountId: lead, realm: 'staff', reason: 'Left the company', by: { kind: 'staff', id: owner } });
    await f.svc.onAccountDisabledFromIdentity({ accountId: lead, realm: 'staff', reason: 'Left the company', by: { kind: 'staff', id: owner } });
    await f.drain();
    expect(await f.svc.rolesOf(lead)).toEqual([]);
    const coverage = await f.svc.coverageNow({});
    expect(coverage.find((c) => c.role.key === 'shipping_manager')).toMatchObject({ lead: null, receivingNow: [{ accountId: backup }] });
    expect(f.eventsNamed('access.role.changed').filter((e) => e.accountId === lead).map((e) => e.change)).toEqual(['unassigned']);
    expect(f.eventsNamed('access.coverage.changed').some((e) => e.roleId === roleId)).toBe(true);
  });

  it('expires temporary assignments (job)', async () => {
    const temp = await f.staff('Tia Temp', []);
    const res = await f.call('POST', '/role-assignments', f.token(admin), { accountId: temp, roleId: await f.roleId('reports_analyst'), reason: 'Quarter close', expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    expect(res.body.status).toBe('active');
    f.clock.advance(2 * 3_600_000);
    try {
      expect(await f.svc.hasPermission(f.principal(temp), 'reports.library.view')).toBe(false); // read-time expiry
      await f.app.kernel.jobs.runNow('access.expire-assignments');
      const row = (await f.table('role_assignments').get(res.body.id))!;
      expect(row.status).toBe('expired');
    } finally {
      f.clock.reset();
    }
  });
});

describe('members', () => {
  it('lists and shows staff members with roles, duties and effective permissions', async () => {
    const list = await f.call('GET', '/members?q=pat', f.token(admin));
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({ account: { id: admin, displayName: 'Pat Admin' }, roles: [{ key: 'platform_administrator' }], status: 'active' });
    const byRole = await f.call('GET', `/members?roleId=${await f.roleId('business_owner')}`, f.token(admin));
    expect(byRole.body.items.map((m: any) => m.account.id).sort()).toEqual([owner, owner2].sort());
    const one = await f.call('GET', `/members/${admin}`, f.token(admin));
    expect(one.status).toBe(200);
    expect(one.body.effectivePermissions).toContain('access.roles.manage');
    expect(one.body.effectiveLimits.map((l: any) => l.action.key)).toContain('access.roles.sensitive-grant');
    expect((await f.call('GET', `/members/${newId()}`, f.token(admin))).status).toBe(404);
    const me = await f.call('GET', '/me', f.token(owner));
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ account: { id: owner }, roles: [{ key: 'business_owner' }] });
    expect(me.body.permissions).toContain('access.limits.approve');
    expect(await f.svc.membersOfRole('business_owner')).toHaveLength(2);
    expect(await f.svc.getStaffRef(admin)).toMatchObject({ name: 'Pat Admin', roleLabel: 'Platform Administrator', away: false });
    expect(await f.svc.getStaffRef(newId())).toBeNull();
  });
});
