/** Test helpers for identity: boot, capture events, and walk the real sign-in flows over HTTP. */
import type { FastifyInstance } from 'fastify';
import { expect } from 'vitest';
import type { EventEnvelope } from '../../../kernel/events/index.js';
import { fixedClock } from '../../../kernel/lib/clock.js';
import type { BuildOptions } from '../../../app.js';
import { auth, buildTestApp } from '../../../testing/app.js';
import { base32Decode, totpCode } from '../domain/crypto.js';

export type Clock = ReturnType<typeof fixedClock>;

export interface TestKit {
  app: FastifyInstance;
  clock: Clock;
  events: EventEnvelope[];
  /** Events of one name, payloads only */
  of(name: string): any[];
  last(name: string): any;
  /** Refresh the kernel's revocation list now (instead of waiting for the poll) */
  syncRevocations(): Promise<void>;
  call(method: string, url: string, o?: { token?: string; body?: unknown; headers?: Record<string, string> }): Promise<{ status: number; body: any; headers: Record<string, any> }>;
}

const WATCHED = [
  'identity.user.registered',
  'identity.user.verified',
  'identity.password.changed',
  'identity.verification.code_issued',
  'identity.password_reset.requested',
  'identity.session.new_device',
  'identity.account.locked',
  'identity.account.unlocked',
  'identity.account.disabled',
  'identity.account.enabled',
  'identity.account.closed',
  'identity.email.changed',
  'identity.two_step.changed',
  'identity.invitation.created',
  'identity.invitation.accepted',
  'identity.invitation.revoked',
  'identity.guest_session.claimed',
];

export async function boot(opts: BuildOptions & { only?: string[] } = {}): Promise<TestKit> {
  const clock = fixedClock(new Date());
  const app = await buildTestApp({ only: ['identity'], clock, ...opts, config: { rateLimits: false, ...opts.config } });
  const events: EventEnvelope[] = [];
  for (const name of WATCHED) app.kernel.events.subscribe('test', name, (e) => void events.push(e));
  const kit: TestKit = {
    app,
    clock,
    events,
    of: (name) => events.filter((e) => e.name === name).map((e) => e.payload),
    last: (name) => kit.of(name).at(-1),
    syncRevocations: () => app.kernel.auth.k.revocations.sync(),
    async call(method, url, o = {}) {
      const res = await app.inject({
        method: method as never,
        url,
        headers: { ...(o.token ? auth(o.token) : {}), ...o.headers },
        ...(o.body !== undefined ? { payload: o.body as never } : {}),
      });
      await app.kernel.events.drain();
      return { status: res.statusCode, body: res.body ? safeJson(res.body) : null, headers: res.headers };
    },
  };
  return kit;
}

const safeJson = (s: string) => {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
};

export const PUBLIC = '/api/public/identity';
export const STORE = '/api/store/identity';
export const SELLER = '/api/seller/identity';
export const ADMIN = '/api/admin/identity';

export const web = { kind: 'web' as const };
export const android = (installationId = `inst-${Math.random().toString(36).slice(2)}`) => ({ kind: 'android' as const, name: 'Marketly app on Pixel 8', appVersion: '1.4.2', installationId });

/** A visitor token from the bootstrap endpoint (Android: refresh token in the body) */
export async function visitor(kit: TestKit, audience: 'store' | 'seller' | 'admin' = 'store', device: object = android()) {
  const res = await kit.call('POST', `${PUBLIC}/app-sessions`, { headers: { 'x-app-proof': 'dev' }, body: { audience, device } });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { sessionId: string; accessToken: string; refreshToken: string; audience: string };
}

export const STRONG = 'Correct-Horse-42';

let seq = 0;
export const uniqueEmail = (prefix = 'user') => `${prefix}.${Date.now().toString(36)}${seq++}@example.com`;

/** Registers and confirms a customer; returns the store tokens and the account id */
export async function customer(kit: TestKit, o: { email?: string; password?: string; device?: object } = {}) {
  const email = o.email ?? uniqueEmail();
  const v = await visitor(kit);
  const reg = await kit.call('POST', `${PUBLIC}/registrations`, {
    token: v.accessToken,
    body: { email, password: o.password ?? STRONG, firstName: 'Ana', lastName: 'Lopez', marketingOptIn: false, acceptedTermsVersion: '2026-01', device: o.device ?? android() },
  });
  expect(reg.status, JSON.stringify(reg.body)).toBe(202);
  const code = kit.of('identity.verification.code_issued').filter((e) => e.challengeId === reg.body.id).at(-1).code as string;
  const conf = await kit.call('POST', `${PUBLIC}/verifications/${reg.body.id}/confirm`, { token: v.accessToken, body: { code, device: o.device ?? android() } });
  expect(conf.status, JSON.stringify(conf.body)).toBe(200);
  return { email, password: o.password ?? STRONG, accountId: conf.body.account.id as string, tokens: conf.body.tokens, visitor: v };
}

/** Password sign-in with a fresh visitor token */
export async function signIn(kit: TestKit, body: { email: string; password: string; audience?: string; device?: object; keepSignedIn?: boolean; sellerId?: string }, visitorAudience?: 'store' | 'seller' | 'admin') {
  const audience = body.audience ?? 'store';
  const v = await visitor(kit, visitorAudience ?? (audience as never));
  return kit.call('POST', `${PUBLIC}/sessions`, { token: v.accessToken, body: { keepSignedIn: false, device: android(), ...body, audience } });
}

/** The current TOTP code for a set-up's manual entry key */
export const totp = (manualEntryKey: string, at: Date) => totpCode(base32Decode(manualEntryKey), at);

/** Turns on authenticator 2-step for a signed-in account; returns the key and recovery codes */
export async function enableTotp(kit: TestKit, token: string, password: string) {
  const setup = await kit.call('POST', `${STORE}/two-step/setups`, { token, body: { method: 'totp', currentPassword: password } });
  expect(setup.status, JSON.stringify(setup.body)).toBe(201);
  const key = setup.body.manualEntryKey as string;
  const confirm = await kit.call('POST', `${STORE}/two-step/setups/${setup.body.setupId}/confirm`, { token, body: { code: totp(key, kit.clock.now()) } });
  expect(confirm.status, JSON.stringify(confirm.body)).toBe(200);
  kit.clock.advance(30_000); // the next code belongs to a later step (replay guard)
  return { key, recoveryCodes: confirm.body.codes as string[] };
}

export const cookieOf = (headers: Record<string, any>) => {
  const raw = headers['set-cookie'];
  const line = (Array.isArray(raw) ? raw[0] : raw) as string | undefined;
  const m = line && /^__Secure-mk_refresh_(store|seller|admin)=([^;]*)/.exec(line);
  return line ? { line, app: m ? m[1] : undefined, value: m ? m[2]! : '' } : null;
};
