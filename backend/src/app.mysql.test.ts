/**
 * The kernel's own data in MySQL (docs/10-mysql-migration.md §12). The stores themselves are held to one
 * contract on both databases by their own tests (idempotency.test.ts, webhook-log.test.ts, rate-limit.test.ts,
 * refs.test.ts); what is checked here is the choice `buildApp` makes — that `KERNEL_STORE=mysql` really puts
 * every one of them in MySQL and leaves nothing of the kernel's writing behind in MongoDB. Nothing else can
 * check that: both stores work, so a line still wired to MongoDB passes every other test in the suite.
 */
import type { FastifyInstance } from 'fastify';
import type { RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { hashRequest } from './kernel/http/idempotency.js';
import { KERNEL_TABLES, type MysqlStore } from './kernel/mysql/index.js';
import { PURGE_EXPIRED_JOB } from './kernel/mysql/purge.js';
import { auth, buildTestApp, callers } from './testing/app.js';
import { testMysql } from './testing/mysql.js';

let app: FastifyInstance;
let mysql: MysqlStore;

/** Rows in a kernel table of this app's MySQL database */
async function rows<T>(store: MysqlStore, sql: string, params: unknown[] = []): Promise<T[]> {
  const [found] = await store.pool.query<RowDataPacket[]>(sql, params);
  return found as T[];
}
const count = async (table: string) => Number((await rows<{ n: number }>(mysql, `SELECT COUNT(*) AS n FROM \`${table}\``))[0]!.n);
/** The same kernel data in MongoDB, which must stay untouched */
const inMongo = (collection: 'ref_counters' | 'idempotency_keys' | 'webhook_events' | 'rate_limits') => app.kernel.mongo.kernel(collection).countDocuments({});
const kernelTablesIn = async (store: MysqlStore) =>
  (await rows<{ t: string }>(store, "SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE 'kernel\_%'")).map((r) => r.t).sort();

beforeAll(async () => {
  mysql = await testMysql();
  // the queue keeps the in-process timers the tests expect, as TEST_KERNEL_STORE does: see testing/app.ts
  app = await buildTestApp({ only: ['settings'], mysql, config: { kernelStore: 'mysql', rateLimitStore: 'mysql' } });
});
afterAll(async () => {
  await app?.close();
  await mysql?.close();
});

describe('KERNEL_STORE=mysql', () => {
  it('numbers references in MySQL', async () => {
    expect(await app.kernel.refs.next('MK')).toMatch(/^MK-\d{6}-00001$/);
    expect(await count('kernel_ref_counters')).toBe(1);
    expect(await inMongo('ref_counters')).toBe(0);
  });

  it('keeps Idempotency-Key rows in MySQL, and replays from them', async () => {
    const hash = hashRequest({ order: 'a-1' });
    expect(await app.kernel.idempotency.begin('demo.create', 'k1', hash)).toBeNull();
    await app.kernel.idempotency.complete('demo.create', 'k1', 201, { id: 'o-1' });
    expect(await app.kernel.idempotency.begin('demo.create', 'k1', hash)).toEqual({ status: 201, body: { id: 'o-1' } });
    expect(await count('kernel_idempotency_keys')).toBe(1);
    expect(await inMongo('idempotency_keys')).toBe(0);
  });

  it('logs provider events in MySQL, so a replayed webhook is still a duplicate', async () => {
    const log = app.kernel.auth.k.webhookEvents;
    expect(await log.seen('stripe', 'evt_1')).toBe(false);
    await log.record('stripe', 'evt_1');
    expect(await log.seen('stripe', 'evt_1')).toBe(true);
    expect(await count('kernel_webhook_events')).toBe(1);
    expect(await inMongo('webhook_events')).toBe(0);
  });

  it('counts rate-limit windows in MySQL, from the first request the server answers', async () => {
    expect((await app.inject({ url: '/api/store/nowhere', headers: auth(callers.visitor()) })).statusCode).toBe(404);
    expect(await count('kernel_rate_limits')).toBeGreaterThan(0);
    expect(await inMongo('rate_limits')).toBe(0);
  });

  it('runs kernel.purge-expired in place of the TTL monitors', async () => {
    expect(app.kernel.jobs.list()).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: PURGE_EXPIRED_JOB.name, module: 'kernel', schedule: 'every 10 min', handled: true })]),
    );
    const key = (k: string, at: Date) =>
      mysql.pool.query('INSERT INTO `kernel_idempotency_keys` (`scope`, `key`, `request_hash`, `status`, `created_at`) VALUES (?, ?, ?, ?, ?)', ['purge', k, 'h', 'completed', at]);
    await key('older-than-a-day', new Date(Date.now() - 48 * 3_600_000));
    await key('from-just-now', new Date());
    await app.kernel.jobs.runNow(PURGE_EXPIRED_JOB.name);
    expect((await rows<{ key: string }>(mysql, 'SELECT `key` FROM `kernel_idempotency_keys` WHERE `scope` = ?', ['purge'])).map((r) => r.key)).toEqual(['from-just-now']);
  });

  it('stops the boot when a setting points at MySQL and the process has none', async () => {
    // left alone, the boot fails further down with 'JOBS_BACKEND=mysql needs MySQL' — a consequence of the
    // setting that is missing rather than the setting itself (a module named in MYSQL_MODULES: wiring.test.ts)
    await expect(buildApp({ env: { NODE_ENV: 'test', KERNEL_STORE: 'mysql' }, mongo: app.kernel.mongo, modules: [] })).rejects.toThrow(/KERNEL_STORE=mysql.+MYSQL_URL is not set/);
  });

  it('creates its eleven tables at boot, whichever way MIGRATE_ON_START is set', async () => {
    // a database without them, to be sure the boot and not an earlier test file is what makes them
    const bare = await testMysql({ kernelTables: false });
    for (const table of KERNEL_TABLES) await bare.pool.query(`DROP TABLE IF EXISTS \`${table}\``);
    expect(await kernelTablesIn(bare)).toEqual([]);
    // a module's missing table means `npm run migrate` was not run; a missing kernel table means nothing works
    const other = await buildTestApp({ only: ['settings'], mysql: bare, config: { kernelStore: 'mysql', mysqlModules: [], migrateOnStart: false } });
    try {
      expect(await kernelTablesIn(bare)).toEqual([...KERNEL_TABLES].sort());
    } finally {
      await other.close();
      await bare.close();
    }
  });
});
