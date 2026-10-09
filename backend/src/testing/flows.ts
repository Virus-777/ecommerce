/**
 * Real end-to-end flows for integration tests: nothing stubbed, no development tokens. Identity issues
 * every token; access, sellers and customers answer the middleware.
 */
import type { FastifyInstance } from 'fastify';
import { expect } from 'vitest';
import type { EventEnvelope } from '../kernel/events/index.js';
import type { AccessService } from '../modules/access/service.js';
import { auth } from './app.js';
import { totp } from './totp.js';

export interface Flows {
  app: FastifyInstance;
  call(method: string, url: string, o?: { token?: string; body?: unknown; headers?: Record<string, string> }): Promise<{ status: number; body: any }>;
  /** Payloads of an event published so far */
  events(name: string): any[];
  device(): { kind: 'android'; name: string; appVersion: string; installationId: string };
  visitor(audience?: 'store' | 'seller' | 'admin'): Promise<string>;
  /** First Business Owner (also Platform Administrator) through the bootstrap, signed in */
  bootstrapOwner(email?: string, name?: string): Promise<Staff>;
  /** Accepts the emailed staff invitation (password + authenticator) and returns the real admin session */
  acceptStaffInvitation(email: string): Promise<Staff>;
  /** Invites a staff member with roles (the inviter confirms with an authenticator code) and signs them in */
  staffWithRoles(inviter: Staff, email: string, name: string, roleKeys: string[]): Promise<Staff>;
  /** A fresh authenticator code for a staff member (each code works once) */
  code(s: Staff): string;
  /** Registers and confirms a customer; returns the store session */
  customer(email: string): Promise<{ accountId: string; accessToken: string; email: string; password: string }>;
  /** Password sign-in to an app (seller: optionally for a seller) */
  signIn(body: { email: string; password: string; audience: 'store' | 'seller' | 'admin'; sellerId?: string }): Promise<{ status: number; body: any }>;
}

export interface Staff {
  accountId: string;
  key: string;
  accessToken: string;
}

const PASSWORD = 'Blue-Orchid-2026-Key';

export function flows(app: FastifyInstance, clock: { now(): Date; advance(ms: number): void }): Flows {
  const seen: EventEnvelope[] = [];
  for (const name of ['identity.invitation.created', 'identity.verification.code_issued', 'identity.user.registered']) {
    app.kernel.events.subscribe('flows', name, (e) => void seen.push(e));
  }
  const call: Flows['call'] = async (method, url, o = {}) => {
    const res = await app.inject({ method: method as never, url, headers: { ...(o.token ? auth(o.token) : {}), ...o.headers }, ...(o.body !== undefined ? { payload: o.body as never } : {}) });
    await app.kernel.events.drain();
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
  };
  const events = (name: string) => seen.filter((e) => e.name === name).map((e) => e.payload as any);
  const device = () => ({ kind: 'android' as const, name: 'Pixel 8', appVersion: '1.4.2', installationId: `inst-${Math.random().toString(36).slice(2)}` });
  const visitor = async (audience: 'store' | 'seller' | 'admin' = 'store') => {
    const v = await call('POST', '/api/public/identity/app-sessions', { headers: { 'x-app-proof': 'dev' }, body: { audience, device: device() } });
    expect(v.status, JSON.stringify(v.body)).toBe(201);
    return v.body.accessToken as string;
  };
  const code = (s: Staff) => {
    const c = totp(s.key, clock.now());
    clock.advance(30_000); // one code per 30-second step
    return c;
  };

  const self: Flows = {
    app,
    call,
    events,
    device,
    visitor,
    code,
    async acceptStaffInvitation(email) {
      const created = events('identity.invitation.created').findLast((p) => p.email === email);
      expect(created, `invitation for ${email}`).toBeDefined();
      const token = new URL(created.acceptUrl).hash.replace('#token=', '');
      const v = await visitor('admin');
      const d = device();
      const accepted = await call('POST', '/api/public/identity/invitations/accept', { token: v, body: { token, password: PASSWORD, device: d } });
      expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
      const key = accepted.body.twoStepSetup.manualEntryKey as string;
      const confirmed = await call('POST', '/api/public/identity/invitations/two-step', { token: v, body: { token, setupId: accepted.body.twoStepSetup.setupId, code: totp(key, clock.now()), device: d } });
      expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
      clock.advance(30_000);
      return { accountId: accepted.body.account.id, key, accessToken: confirmed.body.tokens.accessToken };
    },
    async bootstrapOwner(email = 'owner@marketly.test', name = 'Olivia Owner') {
      await (app.kernel.boot.apis.get('access') as AccessService).bootstrapBusinessOwner({ email, name });
      await app.kernel.events.drain();
      return self.acceptStaffInvitation(email);
    },
    async staffWithRoles(inviter, email, name, roleKeys) {
      const roles = (await call('GET', '/api/admin/access/roles', { token: inviter.accessToken })).body as { id: string; key: string }[];
      const roleIds = roleKeys.map((k) => roles.find((r) => r.key === k)!.id);
      const invited = await call('POST', '/api/admin/access/staff-invitations', {
        token: inviter.accessToken,
        body: { email, name, roleIds, reason: 'New hire' },
        headers: { 'x-step-up-code': code(inviter) },
      });
      expect(invited.status, JSON.stringify(invited.body)).toBe(201);
      return self.acceptStaffInvitation(email);
    },
    async customer(email) {
      const v = await visitor();
      const reg = await call('POST', '/api/public/identity/registrations', {
        token: v,
        body: { email, password: PASSWORD, firstName: 'Ana', lastName: 'Lopez', marketingOptIn: false, acceptedTermsVersion: '2026-01', device: device() },
      });
      expect(reg.status, JSON.stringify(reg.body)).toBe(202);
      const issued = events('identity.verification.code_issued').findLast((e) => e.challengeId === reg.body.id);
      const conf = await call('POST', `/api/public/identity/verifications/${reg.body.id}/confirm`, { token: v, body: { code: issued.code, device: device() } });
      expect(conf.status, JSON.stringify(conf.body)).toBe(200);
      return { accountId: conf.body.account.id, accessToken: conf.body.tokens.accessToken, email, password: PASSWORD };
    },
    async signIn(body) {
      const v = await visitor(body.audience);
      return call('POST', '/api/public/identity/sessions', { token: v, body: { keepSignedIn: false, device: device(), ...body } });
    },
  };
  return self;
}
