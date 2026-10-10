/**
 * Rate-limit stores: the same contract in memory and in PostgreSQL (kernel.rate_limits), and two app
 * instances on one database sharing the middleware's limits.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { TEST_JWK, testDatabase } from '../../testing/app.js';
import { pgliteServer, type PgServer } from '../../testing/pg-server.js';
import { createDatabase, type Database } from '../db/index.js';
import { IP_LIMIT, memoryRateLimitStore, postgresRateLimitStore, type RateLimitStore } from './rate-limit.js';

const HOUR = 3_600_000;
let now = Date.parse('2026-05-04T10:15:00Z');
const clock = { now: () => new Date(now) };

let db: Database;
beforeAll(async () => {
  db = await testDatabase();
});
afterAll(async () => {
  await db?.close();
});

describe.each([
  ['memory', () => memoryRateLimitStore(clock)],
  ['postgres', () => postgresRateLimitStore(db.kysely, clock)],
])('%s store', (_name, make) => {
  let store: RateLimitStore;
  beforeAll(() => {
    store = make();
  });

  it('allows up to the limit in a fixed window, then refuses until the window ends', async () => {
    now = Date.parse('2026-05-04T10:15:00Z');
    const l = { limit: 3, windowMs: HOUR };
    const results = [];
    for (let i = 0; i < 5; i++) results.push(await store.hit('test', 'a', l));
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false, false]);
    expect(results[3]!.retryAfterMs).toBe(45 * 60_000); // the hour window ends at 11:00
    now = Date.parse('2026-05-04T11:00:00Z');
    expect((await store.hit('test', 'a', l)).allowed).toBe(true);
  });

  it('does not count refused attempts or peeks', async () => {
    now = Date.parse('2026-05-04T12:00:00Z');
    const l = { limit: 2, windowMs: HOUR };
    expect(await store.hit('test', 'b', l, { peek: true })).toEqual({ allowed: true, retryAfterMs: 0 });
    await store.hit('test', 'b', l);
    expect((await store.hit('test', 'b', l, { peek: true })).allowed).toBe(true);
    await store.hit('test', 'b', l);
    expect((await store.hit('test', 'b', l, { peek: true })).allowed).toBe(false);
    for (let i = 0; i < 3; i++) expect((await store.hit('test', 'b', l)).allowed).toBe(false);
    now = Date.parse('2026-05-04T13:00:00Z');
    expect((await store.hit('test', 'b', l)).allowed).toBe(true);
  });

  it('keeps scopes and keys apart', async () => {
    now = Date.parse('2026-05-04T14:00:00Z');
    const l = { limit: 1, windowMs: HOUR };
    expect((await store.hit('cart', 'k', l)).allowed).toBe(true);
    expect((await store.hit('cart', 'k', l)).allowed).toBe(false);
    expect((await store.hit('wallet', 'k', l)).allowed).toBe(true);
    expect((await store.hit('cart', 'other', l)).allowed).toBe(true);
  });

  it('purges windows that have ended', async () => {
    now = Date.parse('2026-05-04T15:00:00Z');
    await store.hit('test', 'p', { limit: 5, windowMs: 60_000 });
    await store.hit('test', 'q', { limit: 5, windowMs: HOUR });
    now = Date.parse('2026-05-04T15:01:00Z');
    expect(await store.purge()).toBeGreaterThanOrEqual(1);
    // the hour window is still running and still counts
    expect((await store.hit('test', 'q', { limit: 1, windowMs: HOUR })).allowed).toBe(false);
  });
});

describe('two app instances on one database', () => {
  let server: PgServer;
  const apps: FastifyInstance[] = [];
  const dbs: Database[] = [];

  beforeAll(async () => {
    server = await pgliteServer({ migrated: true });
    for (let i = 0; i < 2; i++) {
      const database = await createDatabase({ url: server.url });
      dbs.push(database);
      // one fixed time for both, so the requests fall in one minute window
      const fixed = { now: () => new Date('2026-05-04T10:00:30Z') };
      const app = await buildApp({ env: { NODE_ENV: 'test' }, database, clock: fixed, modules: [], config: { rateLimitStore: 'postgres', migrateOnStart: false, devTokens: true, devSigning: { file: '', jwk: TEST_JWK } } });
      await app.ready();
      apps.push(app);
    }
  });
  afterAll(async () => {
    for (const app of apps) await app.close();
    for (const d of dbs) await d.close();
    await server?.close();
  });

  it('share the per-IP limit', async () => {
    const statuses: number[] = [];
    // alternate between the instances: each alone would allow IP_LIMIT requests
    for (let i = 0; i < IP_LIMIT.limit + 1; i++) statuses.push((await apps[i % 2]!.inject({ method: 'GET', url: '/api/store/nothing', remoteAddress: '203.0.113.9' })).statusCode);
    expect(statuses.slice(0, IP_LIMIT.limit).every((s) => s === 401)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
    expect((await apps[0]!.inject({ method: 'GET', url: '/api/store/nothing', remoteAddress: '203.0.113.10' })).statusCode).toBe(401);
  });
});
