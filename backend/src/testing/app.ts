/**
 * Test helpers: boot the app (or a few modules) on in-memory PostgreSQL and sign requests with
 * development tokens for any area.
 */
import type { FastifyInstance } from 'fastify';
import { readFile } from 'node:fs/promises';
import { inject } from 'vitest';
import { buildApp, type BuildOptions } from '../app.js';
import { devClaims, issueDevToken, type DevTokenClaims } from '../kernel/auth/authenticators.js';
import { createDatabase, type Database } from '../kernel/db/index.js';
import { withDependencies } from '../kernel/module-system/loader.js';

export const TEST_SECRET = 'marketly-test-secret';

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
    config: { devTokens: true, devTokenSecret: TEST_SECRET, migrateOnStart: true, responseValidation: true, ...opts.config },
  }).catch(async (err) => {
    if (!opts.database) await database.close();
    throw err;
  });
  if (!opts.database) app.addHook('onClose', () => database.close());
  await app.ready();
  return app;
}

export const token = (claims: DevTokenClaims): string => issueDevToken(TEST_SECRET, claims);

/** A signed-in caller for each kind of session; `over` replaces claims (e.g. a seller member without permissions). */
export const callers = {
  customer: (over: Partial<DevTokenClaims> = {}) => token({ ...devClaims('customer'), ...over }),
  seller: (over: Partial<DevTokenClaims> = {}) => token({ ...devClaims('seller'), ...over }),
  staff: (permissions?: string[], over: Partial<DevTokenClaims> = {}) => token({ ...devClaims('staff', { permissions }), ...over }),
};

export const auth = (t: string) => ({ authorization: `Bearer ${t}` });
