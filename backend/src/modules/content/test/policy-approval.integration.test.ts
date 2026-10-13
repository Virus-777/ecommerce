/**
 * Policy approval with the real access module (no access stub, no development tokens): a Content Manager who
 * owns a policy approves a version as its owner. Content Managers hold no authority on content.policies.approve
 * (access answers denied or approval_required for them); the owner step must still go through, raising the
 * Business Owner's final approval as an access request (gap pass 3: before, the owner got FORBIDDEN).
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withDependencies } from '../../../kernel/module-system/loader.js';
import { buildTestApp, movingClock } from '../../../testing/app.js';
import { flows, type Flows, type Staff } from '../../../testing/flows.js';

const clock = movingClock();
let app: FastifyInstance;
let f: Flows;
let owner: Staff;
let cm: Staff;

const ADMIN = '/api/admin/content';

beforeAll(async () => {
  app = await buildTestApp({
    only: withDependencies(['identity', 'access', 'audit', 'media', 'notifications', 'settings', 'content']),
    clock,
    config: { rateLimits: false },
  });
  f = flows(app, clock);
  owner = await f.bootstrapOwner();
  cm = await f.staffWithRoles(owner, 'cleo@marketly.test', 'Cleo Content', ['content_manager']);
}, 120_000);
afterAll(async () => {
  await app?.close();
});

describe('policy approval by a Content Manager owner (real access)', () => {
  it('access does not give the Content Manager the final approval', async () => {
    const access = app.kernel.boot.apis.get('access') as { check(p: unknown, action: string): Promise<{ decision: string }> };
    const check = await access.check({ kind: 'staff', accountId: cm.accountId }, 'content.policies.approve');
    expect(check.decision).not.toBe('allowed');
  });

  it('the owner approves (200, in_review with a pending approval); the Business Owner finishes it in access', async () => {
    const created = await f.call('POST', `${ADMIN}/policies`, { token: cm.accessToken, body: { key: 'returns', title: 'Returns policy', ownerStaffId: cm.accountId, editorStaffId: cm.accountId, audience: 'customer' } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const version = await f.call('POST', `${ADMIN}/policies/${created.body.id}/versions`, { token: cm.accessToken, body: {} });
    expect(version.status, JSON.stringify(version.body)).toBe(201);
    const id = version.body.id as string;
    const edited = await f.call('PATCH', `${ADMIN}/policy-versions/${id}`, { token: cm.accessToken, body: { body: '<p>Return most items within 30 days.</p>', changeSummary: null, notifyCustomers: true } });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    const submitted = await f.call('POST', `${ADMIN}/policy-versions/${id}/submit`, { token: cm.accessToken });
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);

    const approved = await f.call('POST', `${ADMIN}/policy-versions/${id}/approve`, { token: cm.accessToken, body: { approve: true, note: 'Reviewed with legal' } });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body).toMatchObject({ state: 'in_review', approval: { required: true, approvalRequestId: expect.any(String) } });
    expect(approved.body.approvals.map((a: any) => [a.role, a.state])).toEqual([
      ['policy_owner', 'approved'],
      ['business_owner', 'waiting'],
    ]);

    const requestId = approved.body.approval.approvalRequestId as string;
    const decided = await f.call('POST', `/api/admin/access/approval-requests/${requestId}/approve`, { token: owner.accessToken, body: { note: 'Approved', reauthToken: await f.reauth(owner, 'approval') } });
    expect(decided.status, JSON.stringify(decided.body)).toBe(200);
    await app.kernel.events.drain();
    const after = await f.call('GET', `${ADMIN}/policy-versions/${id}`, { token: cm.accessToken });
    expect(after.body.state).toBe('approved');
    expect(after.body.approvals.map((a: any) => [a.role, a.state])).toEqual([
      ['policy_owner', 'approved'],
      ['business_owner', 'approved'],
    ]);
  });
});
