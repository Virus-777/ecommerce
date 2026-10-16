/**
 * Test helpers: boot the app (or a few modules) on the in-memory MongoDB (testing/mongo.ts) and sign requests with
 * development tokens (EdDSA JWTs, the same format identity issues) for any kind of caller.
 */
import type { FastifyInstance } from 'fastify';
import { buildApp, type BuildOptions } from '../app.js';
import { devClaims, type DevClaims, type DevOptions } from '../kernel/auth/dev.js';
import { devSigner, newDevJwk, signAccessToken } from '../kernel/auth/tokens.js';
import { dateInZone } from '../kernel/lib/clock.js';
import { withDependencies } from '../kernel/module-system/loader.js';
import { testMongo } from './mongo.js';

/** One dev key per test process */
export const TEST_JWK = newDevJwk();
const signer = devSigner({ jwk: TEST_JWK });
export const ISSUER = 'marketly-identity';
export { signWebhook } from '../kernel/http/webhooks.js';

export async function buildTestApp(opts: BuildOptions & { only?: string[] } = {}): Promise<FastifyInstance> {
  const mongo = opts.mongo ?? (await testMongo());
  const app = await buildApp({
    env: { NODE_ENV: 'test' },
    ...opts,
    mongo,
    modules: opts.modules ?? (opts.only ? withDependencies(opts.only) : undefined),
    config: { devTokens: true, devSigning: { file: '', jwk: TEST_JWK }, migrateOnStart: true, responseValidation: true, ...opts.config },
  }).catch(async (err) => {
    if (!opts.mongo) await mongo.close();
    throw err;
  });
  if (!opts.mongo) app.addHook('onClose', () => mongo.close());
  await app.ready();
  return app;
}

/**
 * The market's calendar date `days` from `at` (YYYY-MM-DD), which is what modules mean by "today". A UTC date
 * (`toISOString().slice(0, 10)`) is a day off for part of every day, so tests comparing with module dates use this.
 */
export const marketDate = (at: Date, days = 0, timeZone = 'America/Los_Angeles') => dateInZone(new Date(at.getTime() + days * 86_400_000), timeZone);

/**
 * A clock that follows real time and can be moved ahead (deadlines, expiry jobs) while dev tokens,
 * signed at real time, stay valid. Pass it as `clock` to buildTestApp.
 */
export function movingClock(): { now(): Date; advance(ms: number): void; set(at: Date | string): void } {
  let offset = 0;
  return {
    now: () => new Date(Date.now() + offset),
    advance: (ms) => {
      offset += ms;
    },
    set: (at) => {
      offset = new Date(at).getTime() - Date.now();
    },
  };
}

/**
 * How test tokens are signed. Apps on a fixed clock set `tokenClock.now = () => clock.now()` (and a longer
 * `ttlSeconds` when the test moves the clock far ahead) so every `callers.*` token is valid at the app's time.
 */
export const tokenClock: { now?: () => Date; ttlSeconds: number } = { ttlSeconds: 900 };

/** Signs claims with the test dev key (ttl in seconds, default tokenClock.ttlSeconds; `now` overrides tokenClock.now) */
export const token = (claims: DevClaims, ttlSeconds = tokenClock.ttlSeconds, now?: Date): string =>
  signAccessToken(signer, claims, { issuer: ISSUER, ttlSeconds, now: now ?? tokenClock.now?.() });

/** A signed-in caller of each kind; `over` replaces claims (e.g. a seller member without permissions). */
export const callers = {
  visitor: (o: DevOptions = {}, over: Partial<DevClaims> = {}) => token({ ...devClaims('visitor', o), ...over }),
  customer: (o: DevOptions = {}, over: Partial<DevClaims> = {}) => token({ ...devClaims('customer', o), ...over }),
  seller: (o: DevOptions = {}, over: Partial<DevClaims> = {}) => token({ ...devClaims('seller', o), ...over }),
  staff: (permissions?: string[], over: Partial<DevClaims> = {}) => token({ ...devClaims('staff', { permissions }), ...over }),
};

export const auth = (t: string) => ({ authorization: `Bearer ${t}` });
