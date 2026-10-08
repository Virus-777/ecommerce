/**
 * Test helpers: boot the app (or a few modules) on in-memory PostgreSQL and sign requests with
 * development tokens for any area.
 */
import type { FastifyInstance } from 'fastify';
import { buildApp, type BuildOptions } from '../app.js';
import { issueDevToken, type DevTokenClaims } from '../kernel/auth/authenticators.js';
import { newId } from '../kernel/lib/ids.js';
import { withDependencies } from '../kernel/module-system/loader.js';

export const TEST_SECRET = 'marketly-test-secret';

export async function buildTestApp(opts: BuildOptions & { only?: string[] } = {}): Promise<FastifyInstance> {
  const app = await buildApp({
    env: { NODE_ENV: 'test' },
    ...opts,
    modules: opts.modules ?? (opts.only ? withDependencies(opts.only) : undefined),
    config: { devTokens: true, devTokenSecret: TEST_SECRET, migrateOnStart: true, responseValidation: true, ...opts.config },
  });
  await app.ready();
  return app;
}

export function token(claims: DevTokenClaims): string {
  return issueDevToken(TEST_SECRET, claims);
}

/** A signed-in caller for each kind of session. */
export const callers = {
  customer: (over: Partial<DevTokenClaims> = {}) => token({ kind: 'customer', accountId: newId(), sessionId: newId(), ...over }),
  seller: (over: Partial<DevTokenClaims> = {}) => token({ kind: 'seller', accountId: newId(), sessionId: newId(), sellerId: newId(), isOwner: true, ...over }),
  staff: (permissions: string[] = ['*'], over: Partial<DevTokenClaims> = {}) => token({ kind: 'staff', accountId: newId(), sessionId: newId(), permissions, ...over }),
};

export const auth = (t: string) => ({ authorization: `Bearer ${t}` });
