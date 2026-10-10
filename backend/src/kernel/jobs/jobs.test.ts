/**
 * The two job runners: the same contract for runNow, then what only pg-boss does (several instances on
 * one database, retries, once-per-deploy boot jobs), on PGlite behind a socket server.
 */
import type { FastifyBaseLogger } from 'fastify';
import { TestClock } from 'pg-boss';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { pgliteServer, type PgServer } from '../../testing/pg-server.js';
import { InProcessScheduler, type JobScheduler } from './index.js';
import { cronOf, PgBossScheduler, type PgBossSchedulerOptions } from './pgboss.js';
import { parseSchedule } from './index.js';

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

let server: PgServer;
const open: JobScheduler[] = [];
beforeAll(async () => {
  server = await pgliteServer();
});
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.stop()));
});
afterAll(async () => {
  await server?.close();
});

let schemaSeq = 0;
/** pg-boss on its own schema per test, so tests don't see each other's queues */
function pgboss(o: Partial<PgBossSchedulerOptions> & { schema?: string } = {}): PgBossScheduler {
  const s = new PgBossScheduler(log, {
    connectionString: server.url,
    timeZone: TZ,
    workers: true,
    deployId: 'deploy-1',
    pollingIntervalSeconds: 0.5,
    listenNotify: false,
    retry: { limit: 2, delaySeconds: 1, maxDelaySeconds: 1 },
    ...o,
    schema: o.schema ?? `jobs_${++schemaSeq}`,
  });
  open.push(s);
  return s;
}
const inprocess = () => {
  const s = new InProcessScheduler(log, TZ);
  open.push(s);
  return s;
};

describe.each([
  ['in process', inprocess],
  ['pg-boss', () => pgboss()],
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

describe('pg-boss runner', () => {
  it('maps spec schedules to cron in the market time zone', () => {
    const cron = (text: string) => cronOf(parseSchedule(text));
    expect(cron('every 1 min')).toBe('* * * * *');
    expect(cron('every 15 min')).toBe('*/15 * * * *');
    expect(cron('hourly')).toBe('0 * * * *');
    expect(cron('daily 02:30 market time')).toBe('30 2 * * *');
    expect(cron('nightly 03:00 PT')).toBe('0 3 * * *');
    expect(cron('weekly')).toBe('0 0 * * 1');
    expect(cron('monthly, 1st 03:00 market time')).toBe('0 3 1 * *');
    expect(cron('every 30 s')).toBeUndefined(); // sent throttled instead
    expect(cron('on boot')).toBeUndefined();
  });

  it('two instances on one database run a scheduled job once per tick', async () => {
    const clock = new TestClock(new Date('2026-03-02T20:00:50Z'));
    const schema = 'jobs_cron';
    const runs: string[] = [];
    const make = (who: string) => {
      const s = pgboss({ schema, boss: { clock, cronMonitorIntervalSeconds: 5 } });
      s.declare(job('t.minutely', 'every 1 min'));
      s.handle('test', 't.minutely', async () => {
        runs.push(who);
      });
      return s;
    };
    const a = make('a');
    const b = make('b');
    await a.start();
    await b.start();
    // 20:00:50 → 20:03:10: the occurrences 20:00 (still due at start), 20:01, 20:02, 20:03
    for (let i = 0; i < 28; i++) {
      await clock.tick(5000);
      await sleep(20);
    }
    await until(() => runs.length >= 4);
    await clock.tick(1000);
    await sleep(500);
    expect(runs).toHaveLength(4);
  });

  it('retries a failing run with backoff', async () => {
    const s = pgboss();
    let attempts = 0;
    s.declare(job('t.flaky', 'on boot'));
    s.handle('test', 't.flaky', async () => {
      attempts++;
      if (attempts < 3) throw new Error(`attempt ${attempts} failed`);
    });
    await s.start();
    await until(() => attempts >= 3);
    await sleep(1500);
    expect(attempts).toBe(3);
  });

  it('runs an "on boot" job once per deploy across instances', async () => {
    const schema = 'jobs_boot';
    let runs = 0;
    const make = (deployId: string) => {
      const s = pgboss({ schema, deployId });
      s.declare(job('t.sync', 'on boot'));
      s.handle('test', 't.sync', async () => {
        runs++;
      });
      return s;
    };
    await Promise.all([make('deploy-1').start(), make('deploy-1').start()]);
    await until(() => runs >= 1);
    await sleep(1500);
    expect(runs).toBe(1);
    await make('deploy-1').start(); // a restart of the same deploy
    await sleep(1500);
    expect(runs).toBe(1);
    await make('deploy-2').start();
    await until(() => runs >= 2);
  });

  it('sends sub-minute intervals once per slot across instances', async () => {
    const schema = 'jobs_throttle';
    let runs = 0;
    const make = () => {
      const s = pgboss({ schema });
      s.declare(job('t.fast', 'every 2 s'));
      s.handle('test', 't.fast', async () => {
        runs++;
      });
      return s;
    };
    const started = Date.now();
    await Promise.all([make().start(), make().start()]);
    await sleep(6000);
    const slots = Math.ceil((Date.now() - started) / 2000) + 1;
    expect(runs).toBeGreaterThanOrEqual(2);
    expect(runs).toBeLessThanOrEqual(slots); // two instances each sending every slot would run twice as often
  });

  it('an instance without workers enqueues and waits for one that has them', async () => {
    const schema = 'jobs_split';
    let ranOn = '';
    const worker = pgboss({ schema });
    const web = pgboss({ schema, workers: false });
    for (const [s, who] of [
      [worker, 'worker'],
      [web, 'web'],
    ] as const) {
      s.declare(job('t.split'));
      s.handle('test', 't.split', async () => {
        ranOn = who;
      });
    }
    await worker.start();
    await web.start();
    await web.runNow('t.split');
    expect(ranOn).toBe('worker');
  });

  it('stop lets the run in progress finish, then nothing runs', async () => {
    const s = pgboss();
    let finished = 0;
    let started = 0;
    s.declare(job('t.slow', 'every 2 s'));
    s.handle('test', 't.slow', async () => {
      started++;
      await sleep(700);
      finished++;
    });
    await s.start();
    await until(() => started === 1);
    await s.stop();
    expect(finished).toBe(started);
    const after = started;
    await sleep(2500);
    expect(started).toBe(after);
  });
});
