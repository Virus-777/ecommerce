/**
 * Test helpers: boot the app (or a few modules) on the in-memory MongoDB (testing/mongo.ts) and sign requests with
 * development tokens (EdDSA JWTs, the same format identity issues) for any kind of caller.
 *
 * `TEST_MYSQL_MODULES=settings` runs those modules' data on MySQL instead, in every app a test builds
 * (docs/10-mysql-migration.md §10.5a). A store-neutral module must pass its own tests either way, and the way to
 * know it does is to run them both ways rather than to read the repository again: `npm run test:mysql-modules`.
 */
import type { FastifyInstance } from 'fastify';
import { buildApp, type BuildOptions } from '../app.js';
import { devClaims, type DevClaims, type DevOptions } from '../kernel/auth/dev.js';
import { devSigner, newDevJwk, signAccessToken } from '../kernel/auth/tokens.js';
import { dateInZone } from '../kernel/lib/clock.js';
import { withDependencies } from '../kernel/module-system/loader.js';
import { testMongo } from './mongo.js';
import { testMysql } from './mysql.js';

/** Modules whose data this run puts in MySQL (TEST_MYSQL_MODULES), for the apps every test builds */
export const mysqlModulesUnderTest = (env: Record<string, string | undefined> = process.env): string[] =>
  (env.TEST_MYSQL_MODULES ?? '')
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);

/** One dev key per test process */
export const TEST_JWK = newDevJwk();
const signer = devSigner({ jwk: TEST_JWK });
export const ISSUER = 'marketly-identity';
export { signWebhook } from '../kernel/http/webhooks.js';

export async function buildTestApp(opts: BuildOptions & { only?: string[] } = {}): Promise<FastifyInstance> {
  const mongo = opts.mongo ?? (await testMongo());
  // the modules this run keeps in MySQL, minus any the test is not running: naming a module that is not here
  // would stop the boot, and a test that runs a few modules should not have to know about the setting at all
  const modules = opts.modules ?? (opts.only ? withDependencies(opts.only) : undefined);
  const onMysql = mysqlModulesUnderTest().filter((m) => !modules || modules.includes(m));
  const mysql = opts.mysql ?? (onMysql.length ? await testMysql() : undefined);
  const app = await buildApp({
    env: { NODE_ENV: 'test' },
    ...opts,
    mongo,
    ...(mysql ? { mysql } : {}),
    modules,
    config: { devTokens: true, devSigning: { file: '', jwk: TEST_JWK }, migrateOnStart: true, responseValidation: true, ...(onMysql.length ? { mysqlModules: onMysql } : {}), ...opts.config },
  }).catch(async (err) => {
    await Promise.all([opts.mongo ? undefined : mongo.close(), opts.mysql || !mysql ? undefined : mysql.close()]);
    throw err;
  });
  if (!opts.mongo) app.addHook('onClose', () => mongo.close());
  if (mysql && !opts.mysql) app.addHook('onClose', () => mysql.close());
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
