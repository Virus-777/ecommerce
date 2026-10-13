/**
 * npm run staff-link on a server without email: new invitation links, revoking a mistyped invitation (so the
 * Business Owner can be bootstrapped again), password reset links and 2-step resets, with real identity and access.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixedClock } from '../../src/kernel/lib/clock.js';
import { withDependencies } from '../../src/kernel/module-system/loader.js';
import type { AccessService } from '../../src/modules/access/service.js';
import type { IdentityService } from '../../src/modules/identity/service.js';
import { buildTestApp } from '../../src/testing/app.js';
import { flows, type Flows } from '../../src/testing/flows.js';
import { staffLink } from './staff-link.js';

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

  it('gives an invited person a new link; the old one stops working', async () => {
    const old = f.events('identity.invitation.created').findLast((e) => e.email === 'olivia@company.example')!.acceptUrl as string;
    clock.advance(1000); // a new expiry, as a later run would have
    const r = await staffLink(app, { email: 'OLIVIA@company.example ' });
    expect(r.link).toMatch(/\/invitation#token=/);
    expect(r.link).not.toBe(old);
    const v = await f.visitor('admin');
    const stale = await f.call('POST', '/api/public/identity/invitations/accept', { token: v, body: { token: tokenOf(old), password: 'Correct-Horse-42!', device: f.device() } });
    expect(stale.status).toBe(410);
    // the new link is the one acceptStaffInvitation uses (the latest sent)
    const owner = await f.acceptStaffInvitation('olivia@company.example');
    expect(owner.accountId).toBeDefined();
  });

  it('gives a person with an account a password reset link', async () => {
    const r = await staffLink(app, { email: 'olivia@company.example' });
    expect(r.link).toMatch(/\/reset-password#token=/);
    expect(await identity.passwords.getPasswordReset(tokenOf(r.link!))).toMatchObject({ valid: true, forced: true });
  });

  it('resets 2-step sign-in (lost phone)', async () => {
    const account = (await identity.core.repo.findAccountsByEmail('olivia@company.example')).find((a) => a.realm === 'staff')!;
    expect(await identity.core.repo.activeMethods([account.id])).not.toHaveLength(0);
    const r = await staffLink(app, { email: 'olivia@company.example', resetTwoStep: 'Lost phone, checked in person' });
    expect(r.done).toMatch(/Removed the 2-step methods/);
    expect(await identity.core.repo.activeMethods([account.id])).toHaveLength(0);
  });

  it('refuses what it cannot do, with a message that says what to do instead', async () => {
    await expect(staffLink(app, { email: 'nobody@company.example' })).rejects.toThrow(/No staff account/);
    await expect(staffLink(app, { email: 'olivia@company.example', revoke: 'Changed my mind' })).rejects.toThrow(/already accepted/);
  });
});
