import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DAY, harness, inMs, newId, type Harness } from './helpers.js';

let h: Harness;
const owner = newId();
const editor = newId();
let policyId: string;

beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h?.app.close();
});

const versionBody = (over: Record<string, unknown> = {}) => ({
  body: '<h2>Returns</h2><p>Return most items within 30 days.</p>',
  changeSummary: null,
  notifyCustomers: true,
  ...over,
});

/** Draft → submitted → owner approved → Business Owner approved (event) → scheduled */
async function approveAndSchedule(versionId: string, effectiveAt: string) {
  expect((await h.admin('POST', `/policy-versions/${versionId}/submit`, undefined, h.staff(editor))).statusCode).toBe(200);
  const before = h.approvals.length;
  const approved = await h.admin('POST', `/policy-versions/${versionId}/approve`, { approve: true, note: 'Favors customers' }, h.staff(owner));
  expect(approved.statusCode).toBe(200);
  expect(approved.json().state).toBe('in_review');
  expect(h.approvals.length).toBe(before + 1);
  const req = h.approvals.at(-1)!;
  expect(req).toMatchObject({ action: 'content.policies.approve', target: { type: 'policy_version', id: versionId } });
  const requestId = approved.json().approval.approvalRequestId;
  await h.decide(requestId, 'content.policies.approve', { id: versionId }, 'approved');
  const v = (await h.admin('GET', `/policy-versions/${versionId}`)).json();
  expect(v.state).toBe('approved');
  expect(v.approvals.map((a: any) => [a.role, a.state])).toEqual([
    ['policy_owner', 'approved'],
    ['business_owner', 'approved'],
  ]);
  return h.admin('POST', `/policy-versions/${versionId}/schedule`, { effectiveAt }, h.staff(editor));
}

describe('policies', () => {
  it('creates a policy with its owner; the key is a unique URL slug and the kind says what it governs', async () => {
    const res = await h.admin('POST', '/policies', { key: 'returns', title: 'Returns policy', ownerStaffId: owner, editorStaffId: editor, audience: 'customer' });
    expect(res.statusCode).toBe(201);
    policyId = res.json().id;
    expect(res.json()).toMatchObject({ key: 'returns', kind: 'returns', owner: { staffId: owner, name: 'Dana Content' }, editor: { staffId: editor }, current: null, draft: null });
    expect((await h.admin('POST', '/policies', { key: 'returns', title: 'x', ownerStaffId: owner, audience: 'customer' })).statusCode).toBe(409);
    // any slug: kind defaults to other, and several policies may be of kind other
    const gift = await h.admin('POST', '/policies', { key: 'gift-cards', title: 'Gift card terms', ownerStaffId: owner, audience: 'customer' });
    expect(gift.statusCode, gift.body).toBe(201);
    expect(gift.json()).toMatchObject({ key: 'gift-cards', kind: 'other' });
    const loyalty = await h.admin('POST', '/policies', { key: 'loyalty_terms', kind: 'purchase_terms', title: 'Loyalty terms', ownerStaffId: owner, audience: 'customer' });
    expect(loyalty.json()).toMatchObject({ key: 'loyalty_terms', kind: 'purchase_terms' });
    expect((await h.admin('POST', '/policies', { key: 'Gift Cards!', title: 'x', ownerStaffId: owner, audience: 'customer' })).statusCode).toBe(400);
    expect((await h.admin('POST', '/policies', { key: 'warranty', kind: 'warranties', title: 'x', ownerStaffId: owner, audience: 'customer' })).statusCode).toBe(400);
  });

  it('runs version 1.0 through drafting, approvals, scheduling and taking effect', async () => {
    const v = await h.admin('POST', `/policies/${policyId}/versions`, {}, h.staff(editor));
    expect(v.statusCode).toBe(201);
    expect(v.json()).toMatchObject({ version: '1.0', state: 'draft', impact: 'new_orders_only' });
    const id = v.json().id;
    expect((await h.admin('POST', `/policies/${policyId}/versions`, {})).json().error.code).toBe('DRAFT_EXISTS');
    const edited = await h.admin('PATCH', `/policy-versions/${id}`, versionBody({ body: '<p>Return within 30 days.</p><iframe src="https://evil"></iframe>' }), h.staff(editor));
    expect(edited.json().body).toBe('<p>Return within 30 days.</p>');
    // only the policy owner approves
    await h.admin('POST', `/policy-versions/${id}/submit`, undefined, h.staff(editor));
    expect(h.eventsNamed('content.policy.submitted').at(-1)).toEqual({ policyVersionId: id, policyKey: 'returns' });
    expect((await h.admin('PATCH', `/policy-versions/${id}`, versionBody(), h.staff(editor))).json().error.code).toBe('ILLEGAL_TRANSITION');
    const stranger = await h.admin('POST', `/policy-versions/${id}/approve`, { approve: true }, h.staff(newId(), ['content.policies.approve']));
    expect(stranger.statusCode).toBe(403);
    // changes requested go back to draft
    const changes = await h.admin('POST', `/policy-versions/${id}/approve`, { approve: false, note: 'Name the exceptions' }, h.staff(owner));
    expect(changes.json().state).toBe('draft');
    expect(changes.json().approvals.find((a: any) => a.role === 'policy_owner')).toMatchObject({ state: 'changes_requested', note: 'Name the exceptions' });

    // the first version takes effect without the notice period
    const sched = await approveAndSchedule(id, inMs(h, 60_000));
    expect(sched.statusCode).toBe(200);
    expect(sched.json().state).toBe('scheduled');
    expect(h.eventsNamed('content.policy.scheduled').at(-1)).toMatchObject({ policyVersionId: id, policyKey: 'returns', version: '1.0', notifyCustomers: true });
    h.clock.advance(2 * 60_000);
    await h.app.kernel.jobs.runNow('content.policy-effective');
    await h.app.kernel.events.drain();
    expect(h.eventsNamed('content.policy.effective').at(-1)).toEqual({ policyVersionId: id, policyKey: 'returns', version: '1.0', supersededVersionId: null });
    expect((await h.admin('GET', `/policy-versions/${id}`)).json().state).toBe('current');
    const store = (await h.store('GET', '/policies/returns')).json();
    expect(store).toMatchObject({ key: 'returns', version: '1.0', body: '<p>Return within 30 days.</p>', previousVersion: null, upcoming: null, owner: 'Content Manager' });
  });

  it('a customer-facing change with short notice needs the Business Owner; the approved request schedules it', async () => {
    const v = (await h.admin('POST', `/policies/${policyId}/versions`, {}, h.staff(editor))).json();
    expect(v).toMatchObject({ version: '1.1', body: '<p>Return within 30 days.</p>' });
    await h.admin('PATCH', `/policy-versions/${v.id}`, versionBody({ body: '<p>Return within 45 days.</p>', impact: 'extend_open_orders' }), h.staff(editor));
    // a change needs a change summary before it is sent for approval
    const noSummary = await h.admin('POST', `/policy-versions/${v.id}/submit`, undefined, h.staff(editor));
    expect(noSummary.statusCode).toBe(400);
    await h.admin('PATCH', `/policy-versions/${v.id}`, versionBody({ body: '<p>Return within 45 days.</p>', changeSummary: 'Return window 30 → 45 days', impact: 'extend_open_orders' }), h.staff(editor));
    const diff = (await h.admin('GET', `/policy-versions/${v.id}/diff`)).json();
    expect(diff).toMatchObject({ fromVersion: '1.0', toVersion: '1.1', changeSummary: 'Return window 30 → 45 days' });
    expect(diff.html).toContain('<del>30</del>');
    expect(diff.html).toContain('<ins>45</ins>');

    const effectiveAt = inMs(h, 3 * DAY);
    const res = await approveAndSchedule(v.id, effectiveAt);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ state: 'approved', effectiveAt: new Date(effectiveAt).toISOString() });
    expect(res.json().approval.approvalRequestId).toBeTruthy();
    expect(h.approvals.at(-1)).toMatchObject({ action: 'content.policies.short-notice', target: { id: v.id } });
    // declined: stays approved and can be scheduled again
    await h.decide(res.json().approval.approvalRequestId, 'content.policies.short-notice', { id: v.id }, 'rejected');
    expect((await h.admin('GET', `/policy-versions/${v.id}`)).json()).toMatchObject({ state: 'approved', approval: null });
    const again = await h.admin('POST', `/policy-versions/${v.id}/schedule`, { effectiveAt }, h.staff(editor));
    await h.decide(again.json().approval.approvalRequestId, 'content.policies.short-notice', { id: v.id }, 'approved');
    // the same decision twice changes nothing
    await h.decide(again.json().approval.approvalRequestId, 'content.policies.short-notice', { id: v.id }, 'approved');
    expect(h.eventsNamed('content.policy.scheduled').filter((e: any) => e.policyVersionId === v.id)).toHaveLength(1);
    expect((await h.admin('GET', `/policy-versions/${v.id}`)).json().state).toBe('scheduled');

    const store = (await h.store('GET', '/policies/returns')).json();
    expect(store).toMatchObject({ version: '1.0', upcoming: { version: '1.1' }, upcomingSummary: 'Return window 30 → 45 days' });
    const before = h.clock.now().toISOString();
    h.clock.advance(3 * DAY + 60_000);
    // in force at its effective time even before the job runs
    expect((await h.service.currentPolicyVersions(['returns', 'privacy'])).map((r) => r.version)).toEqual(['1.1']);
    await h.app.kernel.jobs.runNow('content.policy-effective');
    await h.app.kernel.events.drain();
    expect(h.eventsNamed('content.policy.effective').at(-1)).toMatchObject({ policyVersionId: v.id, version: '1.1', supersededVersionId: expect.any(String) });
    // orders keep the version in force when they were placed
    const atOrder = await h.service.currentPolicyVersions(['returns'], before);
    expect(atOrder.map((r) => r.version)).toEqual(['1.0']);
    const old = (await h.store('GET', `/policy-versions/${atOrder[0]!.versionId}`)).json();
    expect(old).toMatchObject({ version: '1.0', upcoming: null });
    expect((await h.store('GET', `/policies/returns?at=${encodeURIComponent(before)}`)).json().version).toBe('1.0');
    const now = (await h.store('GET', '/policies/returns')).json();
    expect(now).toMatchObject({ version: '1.1', previousVersion: { version: '1.0' } });
    expect((await h.store('GET', '/policies/returns/versions')).json().map((r: any) => r.version)).toEqual(['1.1', '1.0']);
    expect((await h.service.getPolicyVersion(atOrder[0]!.versionId)).state).toBe('superseded');
    expect((await h.store('GET', '/policies')).json().map((p: any) => [p.key, p.current.version])).toEqual([['returns', '1.1']]);
  });

  it('withdraws an open version and cancels its approval request', async () => {
    const v = (await h.admin('POST', `/policies/${policyId}/versions`, { version: '2.0' }, h.staff(editor))).json();
    expect(v.version).toBe('2.0');
    await h.admin('PATCH', `/policy-versions/${v.id}`, versionBody({ changeSummary: 'Rewrite' }), h.staff(editor));
    await h.admin('POST', `/policy-versions/${v.id}/submit`, undefined, h.staff(editor));
    const approved = (await h.admin('POST', `/policy-versions/${v.id}/approve`, { approve: true }, h.staff(owner))).json();
    const res = await h.admin('POST', `/policy-versions/${v.id}/withdraw`, { reason: 'Legal review pending' }, h.staff(editor));
    expect(res.json().state).toBe('withdrawn');
    expect(h.cancelled).toContain(approved.approval.approvalRequestId);
    // a late decision for the withdrawn version is ignored
    await h.decide(approved.approval.approvalRequestId, 'content.policies.approve', { id: v.id }, 'approved');
    expect((await h.admin('GET', `/policy-versions/${v.id}`)).json().state).toBe('withdrawn');
    expect((await h.admin('POST', `/policy-versions/${v.id}/withdraw`, { reason: 'again' })).json().error.code).toBe('ILLEGAL_TRANSITION');
    const all = (await h.admin('GET', `/policies/${policyId}/versions`)).json();
    expect(all.map((x: any) => [x.version, x.state])).toEqual([
      ['2.0', 'withdrawn'],
      ['1.1', 'current'],
      ['1.0', 'superseded'],
    ]);
    const list = (await h.admin('GET', '/policies')).json();
    expect(list.find((x: any) => x.key === 'returns')).toMatchObject({ current: { version: '1.1' }, scheduled: null, draft: null });
    expect(h.audits.some((a) => a.action === 'content.policy.version.withdraw' && a.reason === 'Legal review pending')).toBe(true);
  });

  it('within the Business Owner authority the approval completes at once', async () => {
    const p = (await h.admin('POST', '/policies', { key: 'privacy', title: 'Privacy policy', ownerStaffId: owner, audience: 'both' })).json();
    const v = (await h.admin('POST', `/policies/${p.id}/versions`, {})).json();
    await h.admin('PATCH', `/policy-versions/${v.id}`, versionBody({ body: '<p>We keep your data safe.</p>' }));
    await h.admin('POST', `/policy-versions/${v.id}/submit`);
    h.decision = 'allowed';
    try {
      const res = await h.admin('POST', `/policy-versions/${v.id}/approve`, { approve: true }, h.staff(owner));
      expect(res.json()).toMatchObject({ state: 'approved', approval: null });
    } finally {
      h.decision = 'approval_required';
    }
    expect((await h.store('GET', '/policies/privacy')).statusCode).toBe(404);
    expect((await h.store('GET', `/policy-versions/${v.id}`)).statusCode).toBe(404);
  });
});
