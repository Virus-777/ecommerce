import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { accessFixture, usd, type Fixture } from './fixture.js';

let f: Fixture;
let admin: string;
let owner: string;
let owner2: string;
let staff: string;
let manager: string;
beforeAll(async () => {
  f = await accessFixture();
  admin = await f.staff('Pat Admin', ['platform_administrator']);
  owner = await f.staff('Bea Owner', ['business_owner']);
  owner2 = await f.staff('Ben Owner', ['business_owner']);
  staff = await f.staff('Ana Staff', ['finance_staff']);
  manager = await f.staff('Priya Manager', ['finance_manager']);
});
afterAll(async () => {
  await f?.close();
});
beforeEach(() => f.clock.reset());

const refundLimit = (dollars: number) => ({
  actionKey: 'returns.refunds.approve',
  value: { authority: 'permitted', limitMoney: usd(dollars), secondReviewerRoleKeys: ['finance_manager', 'business_owner'] },
});

describe('limit changes', () => {
  it('validates actions and values', async () => {
    const roleId = await f.roleId('finance_staff');
    const unknown = await f.call('POST', '/limit-changes', f.token(admin), { roleId, changes: [{ actionKey: 'nope.x.y', value: { authority: 'permitted', secondReviewerRoleKeys: [] } }], reason: 'r', effectiveFrom: new Date().toISOString() });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.code).toBe('UNKNOWN_APPROVAL_ACTION');
    const wrongKind = await f.call('POST', '/limit-changes', f.token(admin), {
      roleId,
      changes: [{ actionKey: 'inventory.adjustments.apply', value: { authority: 'permitted', limitMoney: usd(5), secondReviewerRoleKeys: ['nobody'] } }],
      reason: 'r',
      effectiveFrom: new Date().toISOString(),
    });
    expect(wrongKind.status).toBe(400);
    expect(wrongKind.body.error.code).toBe('VALIDATION_FAILED');
    expect(wrongKind.body.error.details.issues.map((i: any) => i.path)).toEqual(['changes.0.value.limitMoney', 'changes.0.value.secondReviewerRoleKeys.0']);
    expect((await f.call('POST', '/limit-changes', f.token(admin), { roleId: newId(), changes: [refundLimit(1)], reason: 'r', effectiveFrom: new Date().toISOString() })).status).toBe(404);
  });

  it('goes to the Business Owner, applies at effectiveFrom and leaves waiting requests on the old limit', async () => {
    const roleId = await f.roleId('finance_staff');
    // a request created under the old $2,000 limit
    const waiting = await f.svc.requestApproval({ action: 'returns.refunds.approve', target: { type: 'refund_request', id: newId() }, amount: usd(2500), summary: 'Refund $2,500', reason: 'Damaged', requestedBy: f.principal(manager) });

    const effectiveFrom = new Date(Date.now() + 3_600_000).toISOString();
    const proposed = await f.call('POST', '/limit-changes', f.token(admin), { roleId, changes: [refundLimit(3000)], reason: 'Busier season', effectiveFrom });
    expect(proposed.status).toBe(202);
    expect(proposed.body).toMatchObject({ status: 'pending_approval', role: { key: 'finance_staff' }, approval: { required: true, approvers: ['Business Owner'] } });
    expect(proposed.body.changes[0]).toMatchObject({ actionKey: 'returns.refunds.approve', before: { limitMoney: usd(2000) }, after: { limitMoney: usd(3000) } });
    const requestId = proposed.body.approval.approvalRequestId;
    // Platform Administrators propose but never approve
    await expect(f.svc.decide(requestId, f.principal(admin), { kind: 'approve' })).rejects.toMatchObject({ code: 'SELF_APPROVAL_NOT_ALLOWED' });
    await expect(f.svc.decide(requestId, f.principal(manager), { kind: 'approve' })).rejects.toMatchObject({ code: 'NOT_ELIGIBLE_APPROVER' });
    await f.svc.decide(requestId, f.principal(owner), { kind: 'approve' });
    const scheduled = await f.call('GET', `/limit-changes?roleId=${roleId}`, f.token(admin));
    expect(scheduled.body.items[0]).toMatchObject({ status: 'scheduled' });
    const role = await f.call('GET', `/roles/${roleId}`, f.token(admin));
    expect(role.body.pendingLimitChange).toMatchObject({ id: proposed.body.id, status: 'scheduled' });

    await f.app.kernel.jobs.runNow('access.apply-limit-changes');
    expect((await f.svc.check(f.principal(staff), 'returns.refunds.approve', { money: usd(2500) })).decision).toBe('approval_required'); // not yet in force
    f.clock.advance(2 * 3_600_000);
    await f.app.kernel.jobs.runNow('access.apply-limit-changes');
    await f.drain();
    expect(f.eventsNamed('access.limits.changed')).toEqual([expect.objectContaining({ roleId, roleKey: 'finance_staff', actionKeys: ['returns.refunds.approve'], limitChangeId: proposed.body.id })]);
    expect((await f.svc.check(f.principal(staff), 'returns.refunds.approve', { money: usd(2500) })).decision).toBe('allowed');
    const limits = await f.svc.listLimits({ roleId, actionKey: 'returns.refunds.approve' });
    expect(limits).toHaveLength(1);
    expect(limits[0]).toMatchObject({ value: { limitMoney: usd(3000) }, approvedBy: { kind: 'staff', id: owner } });
    // the request created before keeps the limits in force when it was created: $2,500 is above the old staff limit
    await expect(f.svc.decide(waiting.id, f.principal(staff), { kind: 'approve' })).rejects.toMatchObject({ code: 'NOT_ELIGIBLE_APPROVER' });
  });

  it('is approved on creation when the Business Owner changes another role, but not their own when another owner exists', async () => {
    const other = await f.call('POST', '/limit-changes', f.token(owner), { roleId: await f.roleId('support_agent'), changes: [{ actionKey: 'support.remedies.approve', value: { authority: 'permitted', limitMoney: usd(75), secondReviewerRoleKeys: [] } }], reason: 'Raise', effectiveFrom: new Date(Date.now() - 1000).toISOString() });
    expect(other.status).toBe(202);
    expect(other.body).toMatchObject({ status: 'applied', approval: { required: false } });
    const own = await f.call('POST', '/limit-changes', f.token(owner), { roleId: await f.roleId('business_owner'), changes: [{ actionKey: 'purchasing.orders.send', value: { authority: 'permitted', limitMoney: usd(1_000_000), secondReviewerRoleKeys: [] } }], reason: 'Cap', effectiveFrom: new Date().toISOString() });
    expect(own.body.status).toBe('pending_approval');
    const reqId = own.body.approval.approvalRequestId;
    await expect(f.svc.decide(reqId, f.principal(owner), { kind: 'approve' })).rejects.toMatchObject({ code: 'SELF_APPROVAL_NOT_ALLOWED' });
    const done = await f.svc.decide(reqId, f.principal(owner2), { kind: 'approve' });
    expect(done.status).toBe('approved');
  });

  it('can be withdrawn while pending or scheduled', async () => {
    const res = await f.call('POST', '/limit-changes', f.token(admin), { roleId: await f.roleId('finance_manager'), changes: [refundLimit(20_000)], reason: 'r', effectiveFrom: new Date(Date.now() + 86_400_000).toISOString() });
    const cancelled = await f.call('POST', `/limit-changes/${res.body.id}/cancel`, f.token(admin), { reason: 'Changed my mind' });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe('cancelled');
    expect((await f.svc.getApproval(res.body.approval.approvalRequestId))!.status).toBe('cancelled');
    const again = await f.call('POST', `/limit-changes/${res.body.id}/cancel`, f.token(admin), { reason: 'x' });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ILLEGAL_TRANSITION');
  });
});
