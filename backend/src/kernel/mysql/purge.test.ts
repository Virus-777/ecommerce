/**
 * `kernel.purge-expired` on a real server (purge.ts, docs/10-mysql-migration.md §12).
 *
 * This job is the whole of what MongoDB's TTL monitor used to do, so the two things that matter are that it
 * deletes exactly what the rules say and nothing else, and that it deletes in batches — a single DELETE over a
 * table a month behind would hold locks on every row it touched until it finished.
 */
import { afterEach, afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import type { RowDataPacket } from 'mysql2/promise';
import { fixedClock } from '../lib/clock.js';
import { MysqlScheduler } from '../jobs/mysql.js';
import { testMysql } from '../../testing/mysql.js';
import { KERNEL_TABLES, type MysqlStore } from './index.js';
import { PURGE_RULES } from './kernel-tables.js';
import { purgeExpired, purgeSummary, PURGE_EXPIRED_JOB } from './purge.js';

const NOW = '2026-10-28T12:00:00.000Z';
const clock = fixedClock(NOW);
const hoursAgo = (h: number) => new Date(new Date(NOW).getTime() - h * 3_600_000);

let store: MysqlStore;
const rows = async <T extends RowDataPacket>(sql: string, params: unknown[] = []): Promise<T[]> => (await store.pool.query<T[]>(sql, params))[0];
const countIn = async (table: string) => Number((await rows<RowDataPacket & { n: number }>(`SELECT COUNT(*) n FROM \`${table}\``))[0]!.n);

/** One row in each purged table, stamped at `at` on the column its rule watches */
async function rowsAt(at: Date, tag: string): Promise<void> {
  await store.pool.query('INSERT INTO `kernel_idempotency_keys` (`scope`, `key`, `request_hash`, `status`, `created_at`) VALUES (?, ?, ?, ?, ?)', ['checkout', tag, 'h', 'done', at]);
  await store.pool.query('INSERT INTO `kernel_webhook_events` (`provider`, `event_id`, `received_at`) VALUES (?, ?, ?)', ['stripe', tag, at]);
  await store.pool.query('INSERT INTO `kernel_job_boots` (`job_deploy`, `at`) VALUES (?, ?)', [tag, at]);
  await store.pool.query('INSERT INTO `kernel_processed_events` (`module`, `key`, `at`) VALUES (?, ?, ?)', ['orders', tag, at]);
  await finishedJob(tag, at);
}

/** A finished run of a job (the state matters: a queued or active row is one the queue still owns) */
const finishedJob = (tag: string, finishedAt: Date | null, state = 'completed') =>
  store.pool.query('INSERT INTO `kernel_jobs` (`id`, `name`, `state`, `run_at`, `finished_at`, `created_at`) VALUES (UUID(), ?, ?, ?, ?, ?)', [
    `test.${tag}`,
    state,
    hoursAgo(1),
    finishedAt,
    hoursAgo(1),
  ]);

beforeAll(async () => {
  store = await testMysql();
}, 180_000);

afterEach(async () => {
  for (const t of KERNEL_TABLES) await store.pool.query(`TRUNCATE TABLE \`${t}\``);
});

afterAll(async () => {
  await store?.close();
});

describe('kernel.purge-expired', () => {
  it('deletes what is past each rule and leaves what is not', async () => {
    // one row past the longest window (90 days) and one inside the shortest (24 h), in every purged table
    await rowsAt(hoursAgo(24 * 90 + 1), 'ancient');
    await rowsAt(hoursAgo(23), 'fresh');

    const purged = await purgeExpired(store, clock);
    expect(purged.map((p) => p.table)).toEqual(PURGE_RULES.map((r) => r.table));

    // every table loses the ancient row; the fresh one is inside all five windows, so it stays
    for (const p of purged) {
      expect(p.deleted, `${p.table} should have lost its expired row`).toBe(1);
      expect(await countIn(p.table), `${p.table} should have kept its recent row`).toBe(1);
    }
    expect(purgeSummary(purged)).toBe(
      'purge-expired: 1 from kernel_idempotency_keys, 1 from kernel_webhook_events, 1 from kernel_jobs, 1 from kernel_job_boots, 1 from kernel_processed_events',
    );
  });

  it('keeps an idempotency key that is still inside its day, and drops the one that is not', async () => {
    // the shortest window of the five, and the one a customer can feel: a key purged early turns a retried
    // payment into a second payment
    await rowsAt(hoursAgo(23), 'kept');
    await rowsAt(hoursAgo(25), 'gone');
    await purgeExpired(store, clock);
    const left = await rows<RowDataPacket & { key: string }>('SELECT `key` FROM `kernel_idempotency_keys`');
    expect(left.map((r) => r.key)).toEqual(['kept']);
    // the other four windows are 90 and 7 days, so both of those rows are still there
    expect(await countIn('kernel_webhook_events')).toBe(2);
  });

  it('never touches a job run the queue still owns', async () => {
    // finished_at is null until a run ends, and `col < ?` excludes nulls — a queued job is not "a run from
    // eight days ago" however long it has been waiting
    await finishedJob('queued-for-ages', null, 'queued');
    await finishedJob('running-for-ages', null, 'active');
    await finishedJob('finished-long-ago', hoursAgo(24 * 8));
    const [jobs] = await purgeExpired(store, clock, { rules: PURGE_RULES.filter((r) => r.table === 'kernel_jobs') });
    expect(jobs!.deleted).toBe(1);
    const left = await rows<RowDataPacket & { name: string }>('SELECT `name` FROM `kernel_jobs` ORDER BY `name`');
    expect(left.map((r) => r.name)).toEqual(['test.queued-for-ages', 'test.running-for-ages']);
  });

  it('deletes in batches of its own size, oldest first', async () => {
    for (let i = 0; i < 12; i++) {
      await store.pool.query('INSERT INTO `kernel_webhook_events` (`provider`, `event_id`, `received_at`) VALUES (?, ?, ?)', ['stripe', `e${i}`, hoursAgo(24 * 100 + i)]);
    }
    const [webhooks] = await purgeExpired(store, clock, { batch: 5, rules: PURGE_RULES.filter((r) => r.table === 'kernel_webhook_events') });
    // 5, 5, 2: the short pass is how the job knows it has reached the cut-off
    expect(webhooks).toMatchObject({ deleted: 12, passes: 3, more: false });
    expect(await countIn('kernel_webhook_events')).toBe(0);
  });

  it('stops at its pass limit and says there is more', async () => {
    for (let i = 0; i < 12; i++) {
      await store.pool.query('INSERT INTO `kernel_processed_events` (`module`, `key`, `at`) VALUES (?, ?, ?)', ['orders', `k${i}`, hoursAgo(24 * 100 + i)]);
    }
    const rules = PURGE_RULES.filter((r) => r.table === 'kernel_processed_events');
    const [first] = await purgeExpired(store, clock, { batch: 5, maxPasses: 2, rules });
    expect(first).toMatchObject({ deleted: 10, passes: 2, more: true });
    // what it left is the newest of them, because every pass takes the oldest rows first
    const left = await rows<RowDataPacket & { key: string }>('SELECT `key` FROM `kernel_processed_events` ORDER BY `at`');
    expect(left.map((r) => r.key)).toEqual(['k1', 'k0']);
    // and the next run finishes the job, which is why MAX_PASSES is safe to have at all
    const [second] = await purgeExpired(store, clock, { batch: 5, maxPasses: 2, rules });
    expect(second).toMatchObject({ deleted: 2, more: false });
  });

  it('says so when nothing has expired, and asks the server once per table', async () => {
    await rowsAt(hoursAgo(1), 'new');
    const purged = await purgeExpired(store, clock);
    expect(purged.every((p) => p.deleted === 0 && p.passes === 1)).toBe(true);
    expect(purgeSummary(purged)).toBe('purge-expired: nothing expired');
  });

  it('runs as the kernel job it is declared as', async () => {
    // the schedule phrase has to be one the scheduler can time, and the job has to be callable by name: both
    // are things this job gets wrong exactly once, at the deploy that enables it
    const log = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {}, trace: () => {}, fatal: () => {}, child: () => log } as unknown as FastifyBaseLogger;
    const scheduler = new MysqlScheduler(log, { store, timeZone: 'America/Los_Angeles', workers: true, deployId: 'd1', pollMs: 50, clock });
    try {
      scheduler.declare(PURGE_EXPIRED_JOB);
      let purged: Awaited<ReturnType<typeof purgeExpired>> = [];
      scheduler.handle('kernel', PURGE_EXPIRED_JOB.name, async () => {
        purged = await purgeExpired(store, clock);
      });
      await rowsAt(hoursAgo(24 * 91), 'ancient');
      await scheduler.runNow(PURGE_EXPIRED_JOB.name);
      expect(purged.map((p) => p.deleted)).toEqual([1, 1, 1, 1, 1]);
      expect(await countIn('kernel_webhook_events')).toBe(0);
    } finally {
      await scheduler.stop();
    }
  });
});
