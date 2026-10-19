/**
 * Disabling a staff account, with identity and access wired together: disabling ends every role, so a Business Owner
 * is disabled only by another Business Owner, and what the person left open (approval requests they asked for,
 * invitations they sent) does not outlive them.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixedClock } from '../kernel/lib/clock.js';
import { withDependencies } from '../kernel/module-system/loader.js';
import { buildTestApp } from '../testing/app.js';
import { flows, type Flows, type Staff } from '../testing/flows.js';

const clock = fixedClock(new Date());
let app: FastifyInstance;
let f: Flows;
let owner: Staff;
let deputy: Staff;
let pat: Staff;

beforeAll(async () => {
  app = await buildTestApp({ only: withDependencies(['media', 'identity', 'access', 'settings', 'audit', 'notifications']), clock, config: { rateLimits: false } });
  f = flows(app, clock);
  ({ owner, deputy } = await f.bootstrapOwners());
  pat = await f.staffWithSensitiveRoles(owner, deputy, 'pat@marketly.test', 'Pat Platform', ['platform_administrator']);
});
afterAll(async () => {
  await app?.close();
});

const disable = async (by: Staff, target: Staff) =>
  f.call('POST', `/api/admin/identity/accounts/${target.accountId}/disable`, { token: by.accessToken, body: { reason: 'Offboarding', reauthToken: await f.reauth(by, 'staff-account') } });
const toDecide = async (s: Staff) => (await f.call('GET', '/api/admin/access/approval-requests?view=to_decide', { token: s.accessToken })).body.items as { id: string }[];

describe('disabling a staff account', () => {
  it('lets only a Business Owner disable a Business Owner', async () => {
    const res = await disable(pat, owner);
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    const member = await f.call('GET', `/api/admin/access/members/${owner.accountId}`, { token: deputy.accessToken });
    expect(member.body.assignments).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'active', role: expect.objectContaining({ key: 'business_owner' }) })]));
  });

  it('cancels the approval requests and the invitations the person left open', async () => {
    // Pat invites a finance manager: the grant waits for a Business Owner, the invitation for its acceptance
    const roles = (await f.call('GET', '/api/admin/access/roles', { token: pat.accessToken })).body as { id: string; key: string }[];
    const finance = roles.find((r) => r.key === 'finance_manager')!;
    const invited = await f.call('POST', '/api/admin/access/staff-invitations', { token: pat.accessToken, body: { email: 'fin@marketly.test', name: 'Fin Hire', roleIds: [finance.id], reason: 'New hire', reauthToken: await f.reauth(pat, 'role-grant') } });
    expect(invited.status, JSON.stringify(invited.body)).toBe(201);
    await app.kernel.events.drain();
    const before = (await toDecide(owner)).length;
    expect(before).toBeGreaterThan(0);

    const res = await disable(owner, pat);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    await app.kernel.events.drain();
    expect(await toDecide(owner), 'nothing Pat asked for can be approved after he left').toHaveLength(before - 1);
    await expect(f.acceptStaffInvitation('fin@marketly.test')).rejects.toThrow();
  });

  it('lets a Business Owner disable another one while one remains', async () => {
    const res = await disable(owner, deputy);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });
});
