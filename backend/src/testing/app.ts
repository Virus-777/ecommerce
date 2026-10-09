/**
 * Test helpers: boot the app (or a few modules) on in-memory PostgreSQL and sign requests with
 * development tokens (EdDSA JWTs, the same format identity issues) for any kind of caller.
 */
import type { FastifyInstance } from 'fastify';
import { readFile } from 'node:fs/promises';
import { inject } from 'vitest';
import { buildApp, type BuildOptions } from '../app.js';
import { devClaims, type DevClaims, type DevOptions } from '../kernel/auth/dev.js';
import { devSigner, newDevJwk, signAccessToken } from '../kernel/auth/tokens.js';
import { createDatabase, type Database } from '../kernel/db/index.js';
import { withDependencies } from '../kernel/module-system/loader.js';

/** One dev key per test process */
export const TEST_JWK = newDevJwk();
const signer = devSigner({ jwk: TEST_JWK });
export const ISSUER = 'marketly-identity';
export { signWebhook } from '../kernel/http/webhooks.js';

/** A PGlite database with every module's tables, started from the dump made by global-setup.ts. */
export async function testDatabase(): Promise<Database> {
  return createDatabase({ pgliteDump: new Blob([await readFile(inject('pgliteDump'))]) });
}

export async function buildTestApp(opts: BuildOptions & { only?: string[] } = {}): Promise<FastifyInstance> {
  const database = opts.database ?? (await testDatabase());
  const app = await buildApp({
    env: { NODE_ENV: 'test' },
    ...opts,
    database,
    modules: opts.modules ?? (opts.only ? withDependencies(opts.only) : undefined),
    config: { devTokens: true, devSigning: { file: '', jwk: TEST_JWK }, migrateOnStart: true, responseValidation: true, ...opts.config },
  }).catch(async (err) => {
    if (!opts.database) await database.close();
    throw err;
  });
  if (!opts.database) app.addHook('onClose', () => database.close());
  await app.ready();
  return app;
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
