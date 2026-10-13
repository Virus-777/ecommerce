/**
 * Bootstrap with a deputy Business Owner, then the two-person rule between the two of them, with real
 * identity invitations and real admin tokens (no development tokens): the owner's sensitive grant is
 * approved by the deputy and the deputy's by the owner; nobody approves their own.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixedClock } from '../../../kernel/lib/clock.js';
import { withDependencies } from '../../../kernel/module-system/loader.js';
import type * as audit from '../../../spec/audit.js';
import { buildTestApp } from '../../../testing/app.js';
import { flows, type Flows, type Staff } from '../../../testing/flows.js';
import type { AccessService } from '../service.js';

const clock = fixedClock(new Date());
const audits: audit.RecordInput[] = [];
const requested: any[] = [];
let app: FastifyInstance;
let f: Flows;
let access: AccessService;

beforeAll(async () => {
  app = await buildTestApp({
    // finance runs so the Finance Manager role carries its (sensitive) finance permissions
    only: withDependencies(['identity', 'access', 'audit', 'finance']),
    clock,
    config: { rateLimits: false },
    apiStubs: { audit: { record: async (e: audit.RecordInput) => (audits.push(e), 'entry-id') } },
  });
  // the boot can take a while: start the app's time after it
  clock.set(new Date());
  f = flows(app, clock);
  access = app.kernel.boot.apis.get('access') as AccessService;
  app.kernel.events.subscribe('test', 'access.approval.requested', (e) => void requested.push(e.payload));
});
afterAll(async () => {
  await app?.close();
});

const ADMIN = '/api/admin/access';
let owner: Staff;
let deputy: Staff;
let ownerIds: { accountId: string; deputy: { accountId: string } | null };

async function roleIds(token: string, keys: string[]) {
  const roles = (await f.call('GET', `${ADMIN}/roles`, { token })).body as { id: string; key: string }[];
  return keys.map((k) => roles.find((r) => r.key === k)!.id);
}

async function assignmentsOf(token: string, accountId: string) {
  const member = await f.call('GET', `${ADMIN}/members/${accountId}`, { token });
  expect(member.status, JSON.stringify(member.body)).toBe(200);
  return member.body.assignments as { status: string; role: { key: string } }[];
}

/** Invites someone with a sensitive role; returns the approval request it waits for */
async function inviteFinanceManager(inviter: Staff, email: string, name: string) {
  const invited = await f.call('POST', `${ADMIN}/staff-invitations`, {
    token: inviter.accessToken,
    body: { email, name, roleIds: await roleIds(inviter.accessToken, ['finance_manager']), reason: 'New finance hire' },
    headers: { 'x-step-up-code': f.code(inviter) },
  });
  expect(invited.status, JSON.stringify(invited.body)).toBe(201);
  const request = requested.findLast((r) => r.actionKey === 'access.roles.sensitive-grant' && String(r.target.label).includes(name));
  expect(request, `approval request for ${name}`).toBeDefined();
  return { accountId: invited.body.account.id as string, request };
}

describe('bootstrap with a deputy Business Owner', () => {
  it('refuses a deputy who is the owner, and creates nothing', async () => {
    await expect(access.bootstrapBusinessOwner({ email: 'owner@marketly.test', name: 'Olivia Owner', deputy: { email: ' OWNER@marketly.test', name: 'Same Person' } })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { issues: [{ path: 'deputy.email' }] },
    });
    await expect(access.bootstrapBusinessOwner({ email: 'owner@marketly.test', name: 'Olivia Owner', deputy: { email: 'deputy@marketly.test', name: '' } })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(audits).toHaveLength(0);
  });

  it('invites both, gives both Business Owner and Platform Administrator, and audits each grant', async () => {
    const result = await access.bootstrapBusinessOwner({ email: 'owner@marketly.test', name: 'Olivia Owner', deputy: { email: 'deputy@marketly.test', name: 'Dev Deputy' } });
    await app.kernel.events.drain();
    expect(result).toEqual({ accountId: expect.any(String), invitationId: expect.any(String), deputy: { accountId: expect.any(String), invitationId: expect.any(String) } });
    expect(result.deputy!.accountId).not.toBe(result.accountId);
    ownerIds = result;
    expect(f.events('identity.invitation.created').map((e) => e.email)).toEqual(expect.arrayContaining(['owner@marketly.test', 'deputy@marketly.test']));
    const grants = audits.filter((a) => a.action === 'access.role.assign');
    expect(grants).toHaveLength(4);
    expect(grants.map((a) => `${a.target.id}:${(a.after as { roleKey: string }).roleKey}`).sort()).toEqual(
      [`${result.accountId}:business_owner`, `${result.accountId}:platform_administrator`, `${result.deputy!.accountId}:business_owner`, `${result.deputy!.accountId}:platform_administrator`].sort(),
    );
    expect(grants.every((a) => a.actor.kind === 'system')).toBe(true);
    expect(grants.filter((a) => a.target.id === result.deputy!.accountId).every((a) => a.reason === 'Deputy Business Owner (bootstrap)')).toBe(true);

    // once a Business Owner exists or is invited, the bootstrap is closed, with or without a deputy
    await expect(access.bootstrapBusinessOwner({ email: 'second@marketly.test', name: 'Someone Else' })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(access.bootstrapBusinessOwner({ email: 'third@marketly.test', name: 'Third', deputy: { email: 'fourth@marketly.test', name: 'Fourth' } })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('both roles become active when each person accepts', async () => {
    owner = await f.acceptStaffInvitation('owner@marketly.test');
    deputy = await f.acceptStaffInvitation('deputy@marketly.test');
    expect(owner.accountId).toBe(ownerIds.accountId);
    expect(deputy.accountId).toBe(ownerIds.deputy!.accountId);
    for (const s of [owner, deputy]) {
      const assignments = await assignmentsOf(owner.accessToken, s.accountId);
      expect(assignments).toEqual(expect.arrayContaining(['business_owner', 'platform_administrator'].map((key) => expect.objectContaining({ status: 'active', role: expect.objectContaining({ key }) }))));
    }
  });

  it("the deputy approves the owner's sensitive grant; the owner cannot approve it", async () => {
    const { accountId, request } = await inviteFinanceManager(owner, 'fiona@marketly.test', 'Fiona Finance');
    expect(request.eligibleAccountIds).toContain(deputy.accountId);
    expect(request.eligibleAccountIds).not.toContain(owner.accountId);
    expect((await assignmentsOf(owner.accessToken, accountId)).map((a) => a.status)).toEqual(['pending_approval']);

    const self = await f.call('POST', `${ADMIN}/approval-requests/${request.requestId}/approve`, { token: owner.accessToken, body: {} });
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe('SELF_APPROVAL_NOT_ALLOWED');

    const ok = await f.call('POST', `${ADMIN}/approval-requests/${request.requestId}/approve`, { token: deputy.accessToken, body: { note: 'Agreed', stepUpCode: f.code(deputy) } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.status).toBe('approved');
    await app.kernel.events.drain();
    const fiona = await f.acceptStaffInvitation('fiona@marketly.test');
    expect((await assignmentsOf(owner.accessToken, fiona.accountId)).map((a) => [a.role.key, a.status])).toEqual([['finance_manager', 'active']]);
  });

  it("and the owner approves the deputy's", async () => {
    const { accountId, request } = await inviteFinanceManager(deputy, 'felix@marketly.test', 'Felix Finance');
    expect(request.eligibleAccountIds).toContain(owner.accountId);
    expect(request.eligibleAccountIds).not.toContain(deputy.accountId);
    const self = await f.call('POST', `${ADMIN}/approval-requests/${request.requestId}/approve`, { token: deputy.accessToken, body: { stepUpCode: f.code(deputy) } });
    expect(self.body.error.code).toBe('SELF_APPROVAL_NOT_ALLOWED');
    const ok = await f.call('POST', `${ADMIN}/approval-requests/${request.requestId}/approve`, { token: owner.accessToken, body: { stepUpCode: f.code(owner) } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.status).toBe('approved');
    await app.kernel.events.drain();
    // approve is guarded: Felix hasn't accepted his invitation yet, so the approved grant waits for acceptance
    expect((await assignmentsOf(owner.accessToken, accountId)).map((a) => [a.role.key, a.status])).toEqual([['finance_manager', 'pending_acceptance']]);
    const felix = await f.acceptStaffInvitation('felix@marketly.test');
    expect(felix.accountId).toBe(accountId);
    expect((await assignmentsOf(owner.accessToken, accountId)).map((a) => [a.role.key, a.status])).toEqual([['finance_manager', 'active']]);
    expect((await f.call('GET', '/api/admin/access/me', { token: felix.accessToken })).status).toBe(200);
  });

  it('a third Business Owner needs the other Business Owner, too', async () => {
    const invited = await f.call('POST', `${ADMIN}/staff-invitations`, {
      token: owner.accessToken,
      body: { email: 'bea@marketly.test', name: 'Bea Owner', roleIds: await roleIds(owner.accessToken, ['business_owner']), reason: 'Co-founder' },
      headers: { 'x-step-up-code': f.code(owner) },
    });
    expect(invited.status, JSON.stringify(invited.body)).toBe(201);
    const request = requested.findLast((r) => r.actionKey === 'access.roles.sensitive-grant' && String(r.target.label).includes('Bea Owner'));
    expect(request.eligibleAccountIds).toEqual([deputy.accountId]);
    const ok = await f.call('POST', `${ADMIN}/approval-requests/${request.requestId}/approve`, { token: deputy.accessToken, body: { stepUpCode: f.code(deputy) } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.status).toBe('approved');
  });
});
