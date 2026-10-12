/**
 * The MongoDB job queue (jobs/mongo.ts): the guarantees pg-boss gave, on kernel.jobs.
 */
import type { FastifyBaseLogger } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { testMongo } from '../../testing/mongo.js';
import type { MongoStore } from '../mongo/index.js';
import { migrateMongo } from '../mongo/schema.js';
import { nextOccurrence, parseSchedule } from './index.js';
import { MongoScheduler, type MongoSchedulerOptions } from './mongo.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errors: unknown[] = [];
const log = {
  error: (o: unknown) => errors.push(o),
  warn: () => {},
  info: () => {},
  debug: () => {},
  trace: () => {},
  fatal: () => {},
  child: () => log,
} as unknown as FastifyBaseLogger;
const TZ = 'America/Los_Angeles';
const job = (name: string, schedule = 'hourly') => ({ name, module: 'test', schedule, does: 'test' });

async function until(cond: () => boolean | Promise<boolean>, ms = 15_000) {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('timed out');
    await sleep(25);
  }
}

let store: MongoStore;
const schedulers: MongoScheduler[] = [];
const scheduler = (o: Partial<MongoSchedulerOptions> = {}) => {
  const s = new MongoScheduler(log, { store, timeZone: TZ, workers: true, deployId: 'd1', pollMs: 50, retry: { delaySeconds: 0.05, maxDelaySeconds: 0.2 }, ...o });
  schedulers.push(s);
  return s;
};

beforeAll(async () => {
  store = await testMongo();
  await migrateMongo(store, []);
});
afterEach(async () => {
  await Promise.all(schedulers.splice(0).map((s) => s.stop()));
  await store.kernel('jobs').deleteMany({});
  await store.kernel('job_schedules').deleteMany({});
  await store.kernel('job_boots').deleteMany({});
  errors.length = 0;
});
afterAll(async () => {
  await store?.close();
});

describe('MongoDB job queue', () => {
  it('runNow runs the job here and resolves when it is done', async () => {
    const s = scheduler();
    let runs = 0;
    s.declare(job('q.one'));
    s.handle('test', 'q.one', async () => {
      await sleep(20);
      runs++;
    });
    await s.runNow('q.one');
    expect(runs).toBe(1);
    expect(await store.kernel('jobs').findOne({ name: 'q.one' })).toMatchObject({ state: 'completed', attempts: 1 });
  });

  it('keeps one waiting and one running run per job (callers join the waiting one)', async () => {
    const s = scheduler();
    let running = 0;
    let most = 0;
    let runs = 0;
    s.declare(job('q.stately'));
    s.handle('test', 'q.stately', async () => {
      running++;
      most = Math.max(most, running);
      await sleep(60);
      running--;
      runs++;
    });
    await Promise.all([s.runNow('q.stately'), s.runNow('q.stately'), s.runNow('q.stately')]);
    expect(most).toBe(1);
    expect(runs).toBeLessThanOrEqual(2);
  });

  it('runs each scheduled tick once across instances', async () => {
    let runs = 0;
    for (const s of [scheduler(), scheduler()]) {
      s.declare(job('q.tick', 'every 1 sec'));
      s.handle('test', 'q.tick', async () => {
        runs++;
      });
      await s.start();
    }
    await sleep(3_400);
    // the first pass of each instance only records the schedule; then one run per second, not two
    expect(runs).toBeGreaterThanOrEqual(2);
    expect(runs).toBeLessThanOrEqual(4);
  });

  it('runs an "on boot" job once per deploy', async () => {
    let runs = 0;
    const start = async (deployId: string) => {
      const s = scheduler({ deployId });
      s.declare(job('q.boot', 'on boot'));
      s.handle('test', 'q.boot', async () => {
        runs++;
      });
      await s.start();
    };
    await start('d1');
    await start('d1');
    await until(() => runs === 1);
    await sleep(300);
    expect(runs).toBe(1);
    await start('d2');
    await until(() => runs === 2);
  });

  it('retries a failed run with backoff, then gives up', async () => {
    const s = scheduler({ retry: { limit: 2, delaySeconds: 0.05, maxDelaySeconds: 0.1 } });
    let runs = 0;
    s.declare(job('q.fail', 'on boot'));
    s.handle('test', 'q.fail', async () => {
      runs++;
      throw new Error('provider down');
    });
    await s.start();
    await until(async () => (await store.kernel('jobs').findOne({ name: 'q.fail', state: 'failed' })) !== null);
    expect(runs).toBe(3);
  });

  it('computes the next run in the market time zone', () => {
    const now = new Date('2026-07-01T09:00:00Z'); // 02:00 PDT
    expect(nextOccurrence(parseSchedule('daily 02:30 market time') as never, now, TZ).toISOString()).toBe('2026-07-01T09:30:00.000Z');
    expect(nextOccurrence(parseSchedule('daily 02:30 market time') as never, new Date('2026-07-01T09:31:00Z'), TZ).toISOString()).toBe('2026-07-02T09:30:00.000Z');
    expect(nextOccurrence(parseSchedule('every 10 min') as never, new Date('2026-01-01T00:03:00Z'), TZ).toISOString()).toBe('2026-01-01T00:10:00.000Z');
    expect(nextOccurrence(parseSchedule('monthly 04:00') as never, new Date('2026-01-15T00:00:00Z'), TZ).toISOString()).toBe('2026-02-01T12:00:00.000Z');
  });
});
