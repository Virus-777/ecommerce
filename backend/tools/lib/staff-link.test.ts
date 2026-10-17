/**
 * npm run staff-link on a server without email: new invitation links with pass codes, revoking a mistyped invitation
 * (so the Business Owner can be bootstrapped again) and password reset links, with real identity and access.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixedClock } from '../../src/kernel/lib/clock.js';
import { withDependencies } from '../../src/kernel/module-system/loader.js';
import type { AccessService } from '../../src/modules/access/service.js';
import type { IdentityService } from '../../src/modules/identity/service.js';
import { buildTestApp } from '../../src/testing/app.js';
import { flows, type Flows } from '../../src/testing/flows.js';
import { staffAccountAction, staffLink } from './staff-link.js';

const clock = fixedClock(new Date());
let app: FastifyInstance;
let f: Flows;
let access: AccessService;
let identity: IdentityService;

beforeAll(async () => {
  app = await buildTestApp({ only: withDependencies(['identity', 'access']), clock, config: { rateLimits: false } });
  // the boot can take a while: start the app's time after it
  clock.set(new Date());
  f = flows(app, clock);
  access = app.kernel.boot.apis.get('access') as AccessService;
  identity = app.kernel.boot.apis.get('identity') as IdentityService;
});
afterAll(async () => {
  await app?.close();
});

const tokenOf = (url: string) => new URL(url).hash.replace('#token=', '');

describe('npm run staff-link', () => {
  it('revokes a mistyped Business Owner invitation, so the bootstrap can run again', async () => {
    await access.bootstrapBusinessOwner({ email: 'olivia@compnay.example', name: 'Olivia Hart' });
    await expect(access.bootstrapBusinessOwner({ email: 'olivia@company.example', name: 'Olivia Hart' })).rejects.toMatchObject({ code: 'CONFLICT' });
    const r = await staffLink(app, { email: 'olivia@compnay.example', revoke: 'Mistyped email' });
    expect(r.link).toBeUndefined();
    await access.bootstrapBusinessOwner({ email: 'olivia@company.example', name: 'Olivia Hart' });
    await app.kernel.events.drain();
  });

  it('gives an invited person a new link and pass code; the old ones stop working', async () => {
    const old = f.events('identity.invitation.created').findLast((e) => e.email === 'olivia@company.example')!.acceptUrl as string;
    clock.advance(1000); // a new expiry, as a later run would have
    const r = await staffLink(app, { email: 'OLIVIA@company.example ' });
    expect(r.link).toMatch(/\/invitation#token=/);
    expect(r.link).not.toBe(old);
    expect(r.passCode).toMatch(/^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
    // the pass code reached only the operator: not in the event the run published
    expect(JSON.stringify(f.events('identity.invitation.created'))).not.toContain(r.passCode);
    const v = await f.visitor('admin');
    const stale = await f.call('POST', '/api/public/identity/invitations/accept', { token: v, body: { token: tokenOf(old), passCode: r.passCode, password: 'Correct-Horse-42!', device: f.device() } });
    expect(stale.status).toBe(410);
    const owner = await f.acceptStaffInvitation('olivia@company.example', { acceptUrl: r.link!, passCode: r.passCode! });
    expect(owner.accountId).toBeDefined();
  });

  it('gives a person with an account a password reset link', async () => {
    const r = await staffLink(app, { email: 'olivia@company.example' });
    expect(r.link).toMatch(/\/reset-password#token=/);
    expect(await identity.passwords.getPasswordReset(tokenOf(r.link!))).toMatchObject({ valid: true, forced: true });
  });

  it('refuses what it cannot do, with a message that says what to do instead', async () => {
    await expect(staffLink(app, { email: 'nobody@company.example' })).rejects.toThrow(/No staff account/);
    await expect(staffLink(app, { email: 'olivia@company.example', revoke: 'Changed my mind' })).rejects.toThrow(/already accepted/);
  });
});

describe('npm run staff-link: account actions for a leaver', () => {
  const email = 'olivia@company.example';
  const accountOf = async () => (await identity.core.repo.findAccountsByEmail(email)).find((a) => a.realm === 'staff')!;
  const signIn = async () => {
    const r = await f.signIn({ email, password: 'Blue-Orchid-2026-Key', audience: 'admin' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return { accountId: r.body.account.id as string, accessToken: r.body.tokens.accessToken as string, refreshToken: r.body.tokens.refreshToken as string };
  };
  const activity = async () => (await identity.accounts.getAccountAdmin((await accountOf()).id, async () => true)).recentActivity;

  it('signs out everywhere, locks and unlocks, as the server operator (security history)', async () => {
    const staff = await signIn();
    const me = () => f.call('GET', `/api/admin/identity/accounts/${staff.accountId}`, { token: staff.accessToken });
    expect((await me()).status).toBe(200);

    const out = await staffAccountAction(app, { email, action: 'sign-out-all', reason: 'Shared PC' });
    expect(out.done).toMatch(/Signed .* out everywhere \([1-9]\d* sessions\)/);
    // the session is revoked: its refresh token no longer works (the access token ends at the next revocation poll)
    expect((await f.call('POST', '/api/public/identity/sessions/refresh', { body: { refreshToken: staff.refreshToken } })).status).toBe(401);
    expect((await activity())[0]).toMatchObject({ kind: 'signed_out_everywhere', reason: 'Shared PC', actor: { kind: 'system' } });

    await staffAccountAction(app, { email, action: 'lock', reason: 'Laptop stolen' });
    expect((await accountOf()).status).toBe('locked');
    await expect(staffAccountAction(app, { email, action: 'lock', reason: 'Again' })).rejects.toThrow(/is locked: cannot lock/);
    await staffAccountAction(app, { email, action: 'unlock', reason: 'Laptop found' });
    expect((await accountOf()).status).toBe('active');
    expect((await activity()).map((e) => e.kind).slice(0, 2)).toEqual(['account_unlocked', 'account_locked']);
  });

  it('disables a leaver (sessions and roles end), even the last Business Owner, and enables them again without roles', async () => {
    const staff = await signIn();
    expect((await access.rolesOf(staff.accountId)).map((r) => r.key)).toContain('business_owner');
    const r = await staffAccountAction(app, { email, action: 'disable', reason: 'Left the company' });
    expect(r.done).toMatch(/^Disabled .* \(now disabled\)/);
    expect((await accountOf()).status).toBe('disabled');
    expect((await f.call('GET', `/api/admin/identity/accounts/${staff.accountId}`, { token: staff.accessToken })).status).toBe(401);
    expect(await access.rolesOf(staff.accountId)).toEqual([]);
    // no Business Owner is left: the bootstrap can invite a new one
    await access.bootstrapBusinessOwner({ email: 'nora@company.example', name: 'Nora Quinn' });
    await app.kernel.events.drain();

    await expect(staffAccountAction(app, { email, action: 'disable', reason: 'Twice' })).rejects.toThrow(/is disabled: cannot disable/);
    await staffAccountAction(app, { email, action: 'enable', reason: 'Rehired' });
    expect((await accountOf()).status).toBe('active');
    expect(await access.rolesOf(staff.accountId)).toEqual([]);
  });

  it('refuses an invitation not accepted yet, an unknown email and an empty reason', async () => {
    await expect(staffAccountAction(app, { email: 'nora@company.example', action: 'disable', reason: 'x' })).rejects.toThrow(/--revoke/);
    await expect(staffAccountAction(app, { email: 'nobody@company.example', action: 'lock', reason: 'x' })).rejects.toThrow(/No staff account/);
    await expect(staffAccountAction(app, { email, action: 'lock', reason: '  ' })).rejects.toThrow(/reason/);
  });
});
