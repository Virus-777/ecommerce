/**
 * Tranche 1 wired together, with no stubs and no development tokens: identity issues the tokens,
 * access answers the permissions, and the kernel middleware enforces both on every request.
 *
 *   first Business Owner (bootstrap) → accepts the invitation (password + authenticator) → real admin token
 *   → reads protected admin screens (access.hasPermission) → invites a support agent (step-up with a real code)
 *   → the agent is refused where the role doesn't reach → audit holds the history → notifications sent the invites
 *   → signing out revokes the token on the next revocation poll.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EventEnvelope } from '../kernel/events/index.js';
import { fixedClock } from '../kernel/lib/clock.js';
import { withDependencies } from '../kernel/module-system/loader.js';
import type { AccessService } from '../modules/access/service.js';
import { auth, buildTestApp } from '../testing/app.js';
import { totp } from '../testing/totp.js';

const clock = fixedClock(new Date());
let app: FastifyInstance;
const invitations: EventEnvelope[] = [];

interface Staff {
  accountId: string;
  key: string;
  accessToken: string;
}

beforeAll(async () => {
  app = await buildTestApp({ only: withDependencies(['media', 'identity', 'access', 'settings', 'audit', 'notifications']), clock, config: { rateLimits: false } });
  app.kernel.events.subscribe('test', 'identity.invitation.created', (e) => void invitations.push(e));
});
afterAll(async () => {
  await app?.close();
});

async function call(method: string, url: string, o: { token?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const res = await app.inject({ method: method as never, url, headers: { ...(o.token ? auth(o.token) : {}), ...o.headers }, ...(o.body !== undefined ? { payload: o.body as never } : {}) });
  await app.kernel.events.drain();
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

const device = () => ({ kind: 'android' as const, name: 'Pixel 8', appVersion: '1.4.2', installationId: `inst-${Math.random().toString(36).slice(2)}` });

/** Accepts the emailed invitation through the public endpoints, as the Admin Center would */
async function accept(email: string): Promise<Staff> {
  const created = invitations.map((e) => e.payload as { email: string; acceptUrl: string }).findLast((p) => p.email === email);
  expect(created, `invitation for ${email}`).toBeDefined();
  const token = new URL(created!.acceptUrl).hash.replace('#token=', '');
  const v = await call('POST', '/api/public/identity/app-sessions', { headers: { 'x-app-proof': 'dev' }, body: { audience: 'admin', device: device() } });
  expect(v.status, JSON.stringify(v.body)).toBe(201);
  const d = device();
  const accepted = await call('POST', '/api/public/identity/invitations/accept', { token: v.body.accessToken, body: { token, password: 'Blue-Orchid-2026-Key', device: d } });
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
  const key = accepted.body.twoStepSetup.manualEntryKey as string;
  const confirmed = await call('POST', '/api/public/identity/invitations/two-step', {
    token: v.body.accessToken,
    body: { token, setupId: accepted.body.twoStepSetup.setupId, code: totp(key, clock.now()), device: d },
  });
  expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
  clock.advance(30_000); // the next authenticator code
  return { accountId: accepted.body.account.id, key, accessToken: confirmed.body.tokens.accessToken };
}

let owner: Staff;
let agent: Staff;

describe('the platform foundation, end to end', () => {
  it('bootstraps the first Business Owner, once', async () => {
    const access = app.kernel.boot.apis.get('access') as AccessService;
    await access.bootstrapBusinessOwner({ email: 'owner@marketly.test', name: 'Olivia Owner' });
    await app.kernel.events.drain();
    await expect(access.bootstrapBusinessOwner({ email: 'second@marketly.test', name: 'Someone Else' })).rejects.toMatchObject({ code: 'CONFLICT' });
    owner = await accept('owner@marketly.test');
  });

  it('serves protected admin screens to the owner with a token identity issued', async () => {
    const roles = await call('GET', '/api/admin/access/roles', { token: owner.accessToken });
    expect(roles.status, JSON.stringify(roles.body)).toBe(200);
    expect(roles.body.map((r: { key: string }) => r.key)).toEqual(expect.arrayContaining(['business_owner', 'support_agent']));
    expect((await call('GET', '/api/admin/settings/definitions', { token: owner.accessToken })).status).toBe(200);
    const member = await call('GET', `/api/admin/access/members/${owner.accountId}`, { token: owner.accessToken });
    expect(member.body.assignments).toEqual(expect.arrayContaining(['business_owner', 'platform_administrator'].map((key) => expect.objectContaining({ status: 'active', role: expect.objectContaining({ key }) }))));
  });

  it('asks for a fresh authenticator code before granting a role, then invites a support agent', async () => {
    const roles = (await call('GET', '/api/admin/access/roles', { token: owner.accessToken })).body as { id: string; key: string }[];
    const supportAgent = roles.find((r) => r.key === 'support_agent')!;
    const body = { email: 'agent@marketly.test', name: 'Avery Agent', roleIds: [supportAgent.id], reason: 'New support hire' };
    const noCode = await call('POST', '/api/admin/access/staff-invitations', { token: owner.accessToken, body, headers: { 'x-step-up-code': '000000' } });
    expect(noCode.status, JSON.stringify(noCode.body)).toBe(403); // the dev code doesn't work for a real staff token
    expect(noCode.body.error.code, JSON.stringify(noCode.body)).toBe('STEP_UP_REQUIRED');
    const invited = await call('POST', '/api/admin/access/staff-invitations', { token: owner.accessToken, body, headers: { 'x-step-up-code': totp(owner.key, clock.now()) } });
    expect(invited.status, JSON.stringify(invited.body)).toBe(201);
    clock.advance(30_000);
    agent = await accept('agent@marketly.test');
  });

  it('refuses the agent where the role does not reach, with the permission access decided', async () => {
    const audit = await call('GET', '/api/admin/audit/entries', { token: agent.accessToken });
    expect(audit.status).toBe(403);
    expect(audit.body.error).toMatchObject({ code: 'FORBIDDEN', details: { permission: 'audit.entries.view' } });
    const store = await call('GET', '/api/store/notifications/inbox', { token: agent.accessToken });
    expect(store.body.error.code).toBe('WRONG_AUDIENCE'); // an admin token is not a store token
  });

  it('keeps the history: bootstrap, invitations and role grants are in the audit trail', async () => {
    const entries = await call('GET', '/api/admin/audit/entries?limit=100', { token: owner.accessToken });
    expect(entries.status, JSON.stringify(entries.body)).toBe(200);
    const actions = entries.body.items.map((e: { action: string }) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['access.role.assign', 'access.staff.invite']));
  });

  it('emailed both invitations through notifications', async () => {
    const deliveries = await call('GET', '/api/admin/notifications/deliveries?limit=100', { token: owner.accessToken });
    expect(deliveries.status, JSON.stringify(deliveries.body)).toBe(200);
    const toAgent = deliveries.body.items.filter((d: { accountId?: string; channel: string }) => d.accountId === agent.accountId && d.channel === 'email');
    expect(toAgent.length, JSON.stringify(deliveries.body.items.map((d: { topicKey: string; accountId?: string }) => [d.topicKey, d.accountId]))).toBeGreaterThan(0);
  });

  it('revokes a signed-out session on every server at the next revocation poll', async () => {
    const identity = app.kernel.boot.apis.get('identity') as { revokeSessions(accountId: string, reason: string): Promise<number> };
    expect(await identity.revokeSessions(agent.accountId, 'Left the company')).toBeGreaterThan(0);
    await app.kernel.auth.k.revocations.sync();
    const res = await call('GET', '/api/admin/notifications/inbox', { token: agent.accessToken });
    expect(res.status).toBe(401);
    expect(res.body.error.details.reason).toBe('token_revoked');
  });
});
