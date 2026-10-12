/**
 * The two job runners hold the same contract for runNow. What only the MongoDB queue does (several instances on one
 * database, retries, once-per-deploy boot jobs) is in mongo-jobs.test.ts.
 */
import type { FastifyBaseLogger } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { testMongo } from '../../testing/mongo.js';
import type { MongoStore } from '../mongo/index.js';
import { migrateMongo } from '../mongo/schema.js';
import { InProcessScheduler, type JobScheduler } from './index.js';
import { MongoScheduler } from './mongo.js';

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
    if (Date.now() > end) throw new Error('timed out waiting');
    await sleep(25);
  }
}

let store: MongoStore;
const open: JobScheduler[] = [];
beforeAll(async () => {
  store = await testMongo();
  await migrateMongo(store, []);
});
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.stop()));
  await store.kernel('jobs').deleteMany({});
  await store.kernel('job_schedules').deleteMany({});
});
afterAll(async () => {
  await store?.close();
});

const inprocess = () => {
  const s = new InProcessScheduler(log, TZ);
  open.push(s);
  return s;
};
const mongo = () => {
  const s = new MongoScheduler(log, { store, timeZone: TZ, workers: true, deployId: 'deploy-1', pollMs: 50 });
  open.push(s);
  return s;
};

describe.each([
  ['in process', inprocess],
  ['MongoDB', mongo],
])('%s runner', (_name, make) => {
  it('runNow resolves once the run is done', async () => {
    const s = make();
    let done = 0;
    s.declare(job('t.one'));
    s.handle('test', 't.one', async () => {
      await sleep(100);
      done++;
    });
    await s.start();
    await s.runNow('t.one');
    expect(done).toBe(1);
  });

  it('runNow during a run waits for it, then runs again', async () => {
    const s = make();
    const runs: { start: number; end: number }[] = [];
    let started = 0;
    s.declare(job('t.two'));
    s.handle('test', 't.two', async () => {
      started++;
      const start = Date.now();
      await sleep(300);
      runs.push({ start, end: Date.now() });
    });
    await s.start();
    const first = s.runNow('t.two');
    await until(() => started > 0);
    const asked = Date.now();
    await s.runNow('t.two');
    await first;
    expect(runs).toHaveLength(2);
    expect(runs[1]!.start).toBeGreaterThanOrEqual(runs[0]!.end);
    expect(runs[1]!.start).toBeGreaterThanOrEqual(asked);
  });

  it('a failing run is logged, not thrown, and a job without a handler is refused', async () => {
    const s = make();
    s.declare(job('t.fail'));
    s.declare(job('t.none'));
    s.handle('test', 't.fail', async () => {
      throw new Error('boom');
    });
    await s.start();
    errors.length = 0;
    await s.runNow('t.fail');
    expect(errors.length).toBeGreaterThan(0);
    expect(s.list().find((j) => j.name === 't.fail')).toMatchObject({ handled: true, lastError: 'boom' });
    await expect(s.runNow('t.none')).rejects.toThrow(/no handler/);
  });
});
