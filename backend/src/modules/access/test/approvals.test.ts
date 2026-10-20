import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { accessFixture, APPROVAL_REAUTH, usd, type Fixture } from './fixture.js';

let f: Fixture;
let staffA: string; // finance staff: refunds up to $2,000, second reviewer above $1,000
let staffB: string; // finance staff
let manager: string; // finance manager: payouts up to $250,000, second reviewer above $50,000
let manager2: string;
let owner: string;
let agent: string; // support agent: no refund authority
beforeAll(async () => {
  f = await accessFixture();
  staffA = await f.staff('Ana Staff', ['finance_staff']);
  staffB = await f.staff('Ben Staff', ['finance_staff']);
  manager = await f.staff('Priya Manager', ['finance_manager']);
  manager2 = await f.staff('Owen Manager', ['finance_manager']);
  owner = await f.staff('Bea Owner', ['business_owner']);
  agent = await f.staff('Sam Agent', ['support_agent']);
});
afterAll(async () => {
  await f?.close();
});
beforeEach(() => {
  f.clock.reset();
});

const refund = (by: string, dollars: number, extra: Record<string, unknown> = {}) =>
  f.svc.requestApproval({
    action: 'returns.refunds.approve',
    target: { type: 'refund_request', id: newId(), ref: 'RF-261009-0001', label: 'Refund for MK-261009-00001', screen: 'admin/order' },
    amount: usd(dollars),
    summary: `Refund of $${dollars}`,
    reason: 'Item arrived damaged',
    requestedBy: f.principal(by),
    ...extra,
  });

describe('check: authority for a person, action and amount', () => {
  it('allows within the limit, needs a second reviewer above the threshold, and an approver above the limit', async () => {
    const within = await f.svc.check(f.principal(staffA), 'returns.refunds.approve', { money: usd(500) });
    expect(within).toMatchObject({ decision: 'allowed', approvalsNeeded: 0, requiresSecondReviewer: false });
    expect(within.reason).toContain('$2,000.00');

    const second = await f.svc.check(f.principal(staffA), 'returns.refunds.approve', { money: usd(1500) });
    expect(second).toMatchObject({ decision: 'approval_required', requiresSecondReviewer: true, approvalsNeeded: 1 });
    expect(second.eligibleApproverRoles.map((r) => r.key).sort()).toEqual(['business_owner', 'finance_manager', 'finance_staff']);
    expect(second.eligibleApprovers.map((s) => s.accountId)).toContain(staffB);
    expect(second.eligibleApprovers.map((s) => s.accountId)).not.toContain(staffA);

    const above = await f.svc.check(f.principal(staffA), 'returns.refunds.approve', { money: usd(5000) });
    expect(above).toMatchObject({ decision: 'approval_required', approvalsNeeded: 1 });
    expect(above.reason).toMatch(/^Above your limit/);
    expect(above.eligibleApproverRoles.map((r) => r.key).sort()).toEqual(['business_owner', 'finance_manager']);
  });

  it('denies a role without authority: permissions alone never make a money action allowed', async () => {
    const res = await f.svc.check(f.principal(agent), 'returns.refunds.approve', { money: usd(10) });
    expect(res.decision).toBe('denied');
    // the platform administrator manages permissions but holds no financial authority
    const admin = await f.staff('Pat Admin', ['platform_administrator']);
    expect((await f.svc.check(f.principal(admin), 'finance.payouts.release', { money: usd(1) })).decision).toBe('denied');
  });

  it('refuses unknown actions over HTTP and answers the dialog check', async () => {
    const bad = await f.call('POST', '/authority-checks', f.token(staffA), { action: 'nope.nothing.do' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('UNKNOWN_APPROVAL_ACTION');
    const ok = await f.call('POST', '/authority-checks', f.token(manager), { action: 'finance.payouts.release', amount: { money: usd(10_000) } });
    expect(ok.status).toBe(200);
    expect(ok.body.decision).toBe('allowed');
    const always = await f.svc.check(f.principal(owner), 'access.limits.change');
    expect(always.decision).toBe('approval_required'); // secondReviewer always: never alone
  });

  it('shows my limit and the route above it', async () => {
    const mine = await f.svc.myLimitFor(f.principal(staffA), 'returns.refunds.approve');
    expect(mine.summary).toBe('Up to $2,000.00 · second reviewer above $1,000.00');
    expect(mine.needsSecondReviewer).toBe(true);
    expect(mine.route).toEqual(['Finance Manager', 'Business Owner']);
  });
});

describe('approval requests', () => {
  it('returns the open request for the same action and target, and announces new ones', async () => {
    const target = { type: 'refund_request', id: newId(), label: 'Refund' };
    const input = { action: 'returns.refunds.approve', target, amount: usd(5000), summary: 'Refund of $5,000', reason: 'Damaged', requestedBy: f.principal(staffA) };
    const a = await f.svc.requestApproval(input);
    const b = await f.svc.requestApproval(input);
    expect(b.id).toBe(a.id);
    expect(a.ref).toMatch(/^AP-\d{6}-\d{4}$/);
    expect(a).toMatchObject({ status: 'pending', requiredApprovals: 1, requesterCountsAsFirst: false });
    await f.drain();
    const ev = f.eventsNamed('access.approval.requested').filter((e) => e.requestId === a.id);
    expect(ev).toHaveLength(1);
    expect(ev[0].eligibleAccountIds.sort()).toEqual([manager, manager2, owner].sort());
    expect(ev[0].module).toBe('returns');
  });

  it('refuses the requester, people without authority, and a second approval by the same person', async () => {
    const req = await refund(staffA, 1500); // within staffA's limit, above the second-review threshold
    expect(req).toMatchObject({ requesterCountsAsFirst: true, requiredApprovals: 1 });
    await expect(f.svc.decide(req.id, f.principal(staffA), { kind: 'approve' })).rejects.toMatchObject({ code: 'SELF_APPROVAL_NOT_ALLOWED' });
    await expect(f.svc.decide(req.id, f.principal(agent), { kind: 'approve' })).rejects.toMatchObject({ code: 'NOT_ELIGIBLE_APPROVER' });
    const self = await f.call('POST', `/approval-requests/${req.id}/reject`, f.token(staffA), { reason: 'mine' });
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe('SELF_APPROVAL_NOT_ALLOWED');
    const done = await f.svc.decide(req.id, f.principal(staffB), { kind: 'approve', note: 'Checked the photos' });
    expect(done.status).toBe('approved');
    expect(done.approvals).toHaveLength(1);
    expect(done.approvals[0]).toMatchObject({ decision: 'approved', by: { id: staffB }, roles: [{ key: 'finance_staff' }], note: 'Checked the photos' });
    await f.drain();
    const decided = f.eventsNamed('access.approval.decided').find((e) => e.requestId === req.id);
    expect(decided).toMatchObject({ outcome: 'approved', approverIds: [staffB], requestedById: staffA, amount: usd(1500) });
    // decided requests take no more decisions
    const again = await f.call('POST', `/approval-requests/${req.id}/approve`, f.token(manager), {});
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ILLEGAL_TRANSITION');
  });

  it('needs two approvers above the approver threshold, with the password again above stepUpAbove', async () => {
    const run = await f.svc.requestApproval({
      action: 'finance.payouts.release',
      target: { type: 'payout_run', id: newId(), ref: 'PO-RUN-261009' },
      amount: usd(100_000),
      summary: 'Payout run of $100,000.00 for 12 sellers',
      reason: 'Weekly payouts',
      requestedBy: f.principal(staffA),
    });
    expect(run).toMatchObject({ requiredApprovals: 2, requesterCountsAsFirst: false });
    // above $10,000 the approver confirms with the password (a re-auth token, purpose approval)
    const noCode = await f.call('POST', `/approval-requests/${run.id}/approve`, f.token(manager), {});
    expect(noCode.status).toBe(403);
    expect(noCode.body.error).toMatchObject({ code: 'STEP_UP_REQUIRED', details: { kind: 'reauth', purpose: 'approval' } });
    const wrong = await f.call('POST', `/approval-requests/${run.id}/approve`, f.token(manager), { reauthToken: 'ra.-.not-issued' });
    expect(wrong.status).toBe(403);
    const first = await f.call('POST', `/approval-requests/${run.id}/approve`, f.token(manager), { reauthToken: APPROVAL_REAUTH });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body).toMatchObject({ status: 'partially_approved', requiredApprovals: 2 });
    const twice = await f.call('POST', `/approval-requests/${run.id}/approve`, f.token(manager), { reauthToken: APPROVAL_REAUTH });
    expect(twice.status).toBe(409);
    expect(twice.body.error.code).toBe('ALREADY_APPROVED_BY_YOU');
    await f.drain();
    expect(f.eventsNamed('access.approval.partially_approved').find((e) => e.requestId === run.id)).toMatchObject({ remainingApprovals: 1, eligibleAccountIds: expect.arrayContaining([manager2, owner]) });
    // finance staff are not second reviewers of payouts
    await expect(f.svc.decide(run.id, f.principal(staffB), { kind: 'approve', reauthToken: APPROVAL_REAUTH })).rejects.toMatchObject({ code: 'NOT_ELIGIBLE_APPROVER' });
    const second = await f.svc.decide(run.id, f.principal(manager2), { kind: 'approve', reauthToken: APPROVAL_REAUTH });
    expect(second.status).toBe('approved');
    expect(second.approvals.map((a) => a.by.id)).toEqual([manager, manager2]);
  });

  it("always needs the approver's password for an action declaring stepUp always (a backup restore), whatever the amount", async () => {
    const admin = await f.staff('Pat Admin', ['platform_administrator']);
    const req = await f.svc.requestApproval({ action: 'backups.restore', target: { type: 'backup_restore', id: newId() }, summary: 'Restore backup 2026-10-15_0230', reason: 'Disk failure', requestedBy: f.principal(owner) });
    expect(req).toMatchObject({ status: 'pending', requesterCountsAsFirst: true, requiredApprovals: 1 });
    expect(req.eligibleApprovers.map((s) => s.accountId)).toContain(admin);
    const noPassword = await f.call('POST', `/approval-requests/${req.id}/approve`, f.token(admin), {});
    expect(noPassword.status).toBe(403);
    expect(noPassword.body.error).toMatchObject({ code: 'STEP_UP_REQUIRED', details: { kind: 'reauth', purpose: 'approval' } });
    const ok = await f.call('POST', `/approval-requests/${req.id}/approve`, f.token(admin), { reauthToken: APPROVAL_REAUTH });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.status).toBe('approved');
  });

  it('lets the Business Owner approve alone above every limit', async () => {
    const run = await f.svc.requestApproval({ action: 'finance.payouts.release', target: { type: 'payout_run', id: newId() }, amount: usd(400_000), summary: 'Big run', reason: 'Quarter end', requestedBy: f.principal(manager) });
    expect(run.eligibleApprovers.map((s) => s.accountId)).toEqual([owner]);
    await expect(f.svc.decide(run.id, f.principal(manager2), { kind: 'approve', reauthToken: APPROVAL_REAUTH })).rejects.toMatchObject({ code: 'NOT_ELIGIBLE_APPROVER' });
    const done = await f.svc.decide(run.id, f.principal(owner), { kind: 'approve', reauthToken: APPROVAL_REAUTH });
    expect(done.status).toBe('approved');
  });

  it('returns, resubmits (clearing approvals), rejects and cancels', async () => {
    const req = await refund(staffA, 5000);
    const returned = await f.call('POST', `/approval-requests/${req.id}/return`, f.token(manager), { comment: 'Attach the courier report' });
    expect(returned.status).toBe(200);
    expect(returned.body.status).toBe('returned');
    expect((await f.call('POST', `/approval-requests/${req.id}/resubmit`, f.token(staffB), { note: 'x' })).status).toBe(403);
    const resubmitted = await f.call('POST', `/approval-requests/${req.id}/resubmit`, f.token(staffA), { note: 'Report attached' });
    expect(resubmitted.status).toBe(200);
    expect(resubmitted.body).toMatchObject({ status: 'pending', approvals: [] });
    expect(resubmitted.body.timeline.map((t: any) => t.label)).toEqual(expect.arrayContaining(['Approval requested', 'Returned for changes', 'Resubmitted']));
    const rejected = await f.call('POST', `/approval-requests/${req.id}/reject`, f.token(manager), { reason: 'Outside the return window' });
    expect(rejected.body).toMatchObject({ status: 'rejected', canDecide: false });

    const other = await refund(staffA, 5000);
    expect((await f.call('POST', `/approval-requests/${other.id}/cancel`, f.token(manager), { reason: 'no' })).status).toBe(403);
    const cancelled = await f.call('POST', `/approval-requests/${other.id}/cancel`, f.token(staffA), { reason: 'Customer withdrew' });
    expect(cancelled.body.status).toBe('cancelled');
    await f.drain();
    expect(f.eventsNamed('access.approval.returned').find((e) => e.requestId === req.id)).toMatchObject({ comment: 'Attach the courier report', requestedById: staffA });
    expect(f.eventsNamed('access.approval.decided').filter((e) => [req.id, other.id].includes(e.requestId)).map((e) => e.outcome).sort()).toEqual(['cancelled', 'rejected']);
    // the requesting module may withdraw a decided request without an error
    await f.svc.cancelApproval(req.id, { kind: 'system' }, 'Record deleted');
    expect((await f.svc.getApproval(req.id))!.status).toBe('rejected');
  });

  it('lists what I may decide, what I asked for, and hides requests from unrelated staff', async () => {
    const req = await refund(staffA, 3000);
    const toDecide = await f.call('GET', '/approval-requests?view=to_decide', f.token(manager));
    expect(toDecide.status).toBe(200);
    expect(toDecide.body.items.map((r: any) => r.id)).toContain(req.id);
    expect(toDecide.body.items.every((r: any) => r.canDecide)).toBe(true);
    const mine = await f.call('GET', '/approval-requests?view=requested_by_me', f.token(staffA));
    expect(mine.body.items.map((r: any) => r.id)).toContain(req.id);
    expect(mine.body.items.find((r: any) => r.id === req.id)).toMatchObject({ canDecide: false, cannotDecideReason: 'Your own request' });
    const agentView = await f.call('GET', `/approval-requests/${req.id}`, f.token(agent, []));
    expect(agentView.status).toBe(404);
    const auditor = await f.call('GET', `/approval-requests/${req.id}`, f.token(agent, ['access.approvals.view-all']));
    expect(auditor.status).toBe(200);
    expect(auditor.body).toMatchObject({ canDecide: false, cannotDecideReason: 'Your role has no authority for this action' });
    const all = await f.call('GET', '/approval-requests?view=all', f.token(agent, []));
    expect(all.status).toBe(403);
    const summary = await f.svc.approvalSummaryFor(f.principal(manager));
    expect(summary.toDecide).toBeGreaterThan(0);
    const page = await f.svc.listApprovalsToDecide(f.principal(manager), { module: 'returns' }, { limit: 50 });
    expect(page.items.map((r) => r.id)).toContain(req.id);
    expect((await f.svc.getApprovalForViewer(f.principal(agent), req.id))).toBeNull();
    expect((await f.svc.getApprovalForViewer(f.principal(manager), req.id))!.canDecide).toBe(true);
    const info = await f.svc.approvalInfo(req.id);
    expect(info).toMatchObject({ required: true, approvalRequestId: req.id, approvers: ['Finance Manager', 'Business Owner'] });
  });

  it('batches the current request per target and open requests per seller', async () => {
    const sellerId = newId();
    const hold = newId();
    const req = await f.svc.requestApproval({ action: 'finance.holds.place', target: { type: 'hold', id: hold, sellerId }, amount: usd(80_000), summary: 'Hold $80,000', reason: 'Chargeback spike', requestedBy: f.principal(manager) });
    const byTarget = await f.svc.approvalForTargets(f.principal(owner), 'hold', [hold, newId()]);
    expect(byTarget.get(hold)!.id).toBe(req.id);
    expect([...byTarget.values()].filter((v) => v === null)).toHaveLength(1);
    const bySeller = await f.svc.approvalsForSellers(f.principal(owner), [sellerId]);
    expect(bySeller.get(sellerId)!.map((r) => r.id)).toEqual([req.id]);
  });

  it('reminds reviewers at most once per interval', async () => {
    const req = await refund(staffA, 4000);
    const first = await f.call('POST', `/approval-requests/${req.id}/remind`, f.token(staffA), { message: 'Customer is waiting' });
    expect(first.status).toBe(200);
    expect(first.body.notified.map((s: any) => s.accountId).sort()).toEqual([manager, manager2, owner].sort());
    const again = await f.call('POST', `/approval-requests/${req.id}/remind`, f.token(staffA), {});
    expect(again.status).toBe(429);
    expect(again.body.error.code).toBe('REMINDER_TOO_SOON');
    expect(again.body.error.details.nextAllowedAt).toBeDefined();
    await f.drain();
    expect(f.eventsNamed('access.approval.reminder_sent').find((e) => e.requestId === req.id)).toMatchObject({ message: 'Customer is waiting', by: { kind: 'staff', id: staffA } });
  });

  it('expires open requests after the TTL and reminds before the due date (jobs)', async () => {
    const dueSoon = await refund(staffA, 4500, { dueAt: new Date(f.clock.now().getTime() + 2 * 3_600_000).toISOString() });
    const undated = await refund(staffA, 4600);
    await f.app.kernel.jobs.runNow('access.remind-approvals');
    await f.drain();
    expect(f.eventsNamed('access.approval.reminder_sent').some((e) => e.requestId === dueSoon.id && e.by.kind === 'system')).toBe(true);
    expect(f.eventsNamed('access.approval.reminder_sent').some((e) => e.requestId === undated.id)).toBe(false);
    f.clock.advance(73 * 3_600_000);
    await f.app.kernel.jobs.runNow('access.expire-approval-requests');
    await f.drain();
    expect((await f.svc.getApproval(undated.id))!.status).toBe('expired');
    expect((await f.svc.getApproval(dueSoon.id))!.status).toBe('expired');
    expect(f.eventsNamed('access.approval.decided').find((e) => e.requestId === undated.id)).toMatchObject({ outcome: 'expired', decidedBy: null });
  });

  it('records audit entries for decisions', async () => {
    const req = await refund(staffA, 2500);
    await f.svc.decide(req.id, f.principal(manager), { kind: 'approve' });
    const entry = f.audits.find((a) => a.action === 'access.approval.approve' && a.approvalRequestId === req.id);
    expect(entry).toMatchObject({ module: 'access', category: 'access', actor: { kind: 'staff', id: manager }, after: { status: 'approved' } });
  });
});

describe('GraphQL read layer', () => {
  it('serves the approval summary and one request with steps', async () => {
    const req = await refund(staffA, 3500);
    const res = await f.app.inject({
      method: 'POST',
      url: '/graphql/admin',
      headers: { authorization: `Bearer ${f.token(manager)}` },
      payload: {
        query: `query($id: UUID!) {
          myApprovalSummary { toDecide myOpenRequests }
          approvalRequest(id: $id) { ref status canDecide amount { formatted } approvalsRemaining steps { step state label } requestedBy { kind id } }
          myApprovalLimit(actionKey: "finance.payouts.release") { authority unit summary route }
          approvalsWaitingForMe(paging: { limit: 5 }) { items { id } }
          teamOnShift { role { key } }
        }`,
        variables: { id: req.id },
      },
    });
    const body = res.json();
    expect(body.errors, JSON.stringify(body.errors)).toBeUndefined();
    expect(body.data.approvalRequest).toMatchObject({ status: 'PENDING', canDecide: true, amount: { formatted: '$3,500.00' }, approvalsRemaining: 1, steps: [{ step: 1, state: 'WAITING' }], requestedBy: { kind: 'STAFF', id: staffA } });
    expect(body.data.myApprovalSummary.toDecide).toBeGreaterThan(0);
    expect(body.data.myApprovalLimit).toMatchObject({ authority: 'PERMITTED', unit: 'MONEY', route: ['Business Owner'] });
    expect(body.data.teamOnShift.length).toBeGreaterThan(0);
  });
});
