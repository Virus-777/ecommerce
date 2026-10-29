/**
 * Rate-limit stores: the same contract in memory, in MongoDB (kernel.rate_limits) and in MySQL
 * (kernel_rate_limits), and two app instances on one database sharing the middleware's limits.
 */
import type { FastifyInstance } from 'fastify';
import type { RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { TEST_JWK } from '../../testing/app.js';
import { testMongo } from '../../testing/mongo.js';
import { testMysql } from '../../testing/mysql.js';
import type { MongoStore } from '../mongo/index.js';
import type { MysqlStore } from '../mysql/index.js';
import { migrateMongo } from '../mongo/schema.js';
import { IP_LIMIT, memoryRateLimitStore, mongoRateLimitStore, mysqlRateLimitStore, type RateLimitStore } from './rate-limit.js';

const HOUR = 3_600_000;
let now = Date.parse('2026-05-04T10:15:00Z');
const clock = { now: () => new Date(now) };

let mongo: MongoStore;
let mysql: MysqlStore;
beforeAll(async () => {
  mongo = await testMongo();
  await migrateMongo(mongo, []);
  mysql = await testMysql();
});
afterAll(async () => {
  await mongo?.close();
  await mysql?.close();
});

describe.each([
  ['memory', () => memoryRateLimitStore(clock)],
  ['mongo', () => mongoRateLimitStore(mongo, clock)],
  ['mysql', () => mysqlRateLimitStore(mysql, clock)],
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

  it('takes the longest key a limit class can produce', async () => {
    now = Date.parse('2026-05-04T14:30:00Z');
    // `password-reset:email:<address>`, and an address is 254 characters at the RFC maximum while `z.email()`
    // sets no shorter limit: 275 in all. The MySQL column is sized from this arithmetic
    const key = `password-reset:email:${'a'.repeat(64)}@${'b'.repeat(181)}.example`;
    expect(key.length).toBe(275);
    const l = { limit: 1, windowMs: HOUR };
    expect((await store.hit('http', key, l)).allowed).toBe(true);
    expect((await store.hit('http', key, l)).allowed).toBe(false);
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

/**
 * MySQL answers "allowed?" with LAST_INSERT_ID, which is per connection and survives between statements.
 * The first request of a new window therefore has to set it itself — `LAST_INSERT_ID(1)` in the VALUES —
 * or it is judged by whatever the previous statement on that pooled connection left behind.
 */
describe('the MySQL store and its one statement', () => {
  it('allows the first request of a new window right after a refusal', async () => {
    const store = mysqlRateLimitStore(mysql, clock);
    const l = { limit: 1, windowMs: HOUR };
    now = Date.parse('2026-06-01T10:00:00Z');
    expect((await store.hit('trap', 'x', l)).allowed).toBe(true);
    expect((await store.hit('trap', 'x', l)).allowed).toBe(false); // leaves last_insert_id at 0
    // a key never seen before, on the same pooled connection: this is the one that would be refused
    expect((await store.hit('trap', 'fresh', l)).allowed).toBe(true);
    now = Date.parse('2026-06-01T11:00:00Z');
    expect((await store.hit('trap', 'x', l)).allowed).toBe(true); // a new window of a key that was refused
  });

  it('counts an allowed attempt and leaves a refused one alone', async () => {
    const store = mysqlRateLimitStore(mysql, clock);
    const l = { limit: 2, windowMs: HOUR };
    now = Date.parse('2026-06-01T12:00:00Z');
    for (let i = 0; i < 5; i++) await store.hit('trap', 'counted', l);
    const [rows] = await mysql.pool.query<RowDataPacket[]>('SELECT `count` FROM `kernel_rate_limits` WHERE `scope` = ? AND `key` = ?', ['trap', 'counted']);
    expect(Number(rows[0]!.count)).toBe(2); // not 5: the three refused attempts added nothing
  });
});

describe('two app instances on one database', () => {
  const apps: FastifyInstance[] = [];

  // One fixed instant for both apps, so their requests fall in one minute window -- but a day AHEAD of real
  // time, not the fixed past date the rest of this file uses. kernel.rate_limits carries the TTL index
  // window_end_ttl (expireAfterSeconds: 0), so a window stamped in the past is already expired, and MongoDB's TTL
  // monitor, which sweeps every 60 s, deletes the counter mid-test whenever the 601-request loop runs long enough
  // to meet a sweep. The count then restarts and the request that should be refused is allowed.
  const shared = new Date(Date.now() + 86_400_000);

  beforeAll(async () => {
    // both apps are given the same MongoDB database, as two servers on one replica set
    for (let i = 0; i < 2; i++) {
      const fixed = { now: () => shared };
      const app = await buildApp({ env: { NODE_ENV: 'test' }, mongo, clock: fixed, modules: [], config: { rateLimitStore: 'mongo', migrateOnStart: false, devTokens: true, devSigning: { file: '', jwk: TEST_JWK } } });
      await app.ready();
      apps.push(app);
    }
  });
  afterAll(async () => {
    for (const app of apps) await app.close();
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
