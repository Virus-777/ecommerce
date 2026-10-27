/**
 * The MySQL job queue (jobs/mysql.ts, `kernel_jobs`): what several instances on one database rely on.
 *
 * The first half mirrors mongo-jobs.test.ts test for test, because the promises the two runners make are the
 * same ones and the modules above them cannot tell which is underneath. The last two are MySQL's own: they
 * are about `SKIP LOCKED` and about a duplicate key that means "someone else has it", neither of which the
 * MongoDB runner has an equivalent for.
 */
import type { FastifyBaseLogger } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import { testMysql } from '../../testing/mysql.js';
import type { MysqlStore } from '../mysql/index.js';
import { MysqlScheduler, type MysqlSchedulerOptions } from './mysql.js';

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

let store: MysqlStore;
const schedulers: MysqlScheduler[] = [];
const scheduler = (o: Partial<MysqlSchedulerOptions> = {}) => {
  const s = new MysqlScheduler(log, { store, timeZone: TZ, workers: true, deployId: 'd1', pollMs: 50, retry: { delaySeconds: 0.05, maxDelaySeconds: 0.2 }, ...o });
  schedulers.push(s);
  return s;
};

const rows = async <T extends RowDataPacket>(sql: string, params: unknown[] = []): Promise<T[]> => (await store.pool.query<T[]>(sql, params))[0];
const oneJob = async (name: string) => (await rows<RowDataPacket & { state: string; attempts: number }>('SELECT `state`, `attempts` FROM `kernel_jobs` WHERE `name` = ?', [name]))[0];

beforeAll(async () => {
  store = await testMysql();
});
afterEach(async () => {
  await Promise.all(schedulers.splice(0).map((s) => s.stop()));
  for (const t of ['kernel_jobs', 'kernel_job_schedules', 'kernel_job_boots']) await store.pool.query(`TRUNCATE TABLE \`${t}\``);
  errors.length = 0;
});
afterAll(async () => {
  await store?.close();
});

describe('MySQL job queue', () => {
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
    expect(await oneJob('q.one')).toMatchObject({ state: 'completed', attempts: 1 });
  });

  it('keeps one waiting and one running run per job (callers join the waiting one)', async () => {
    const s = scheduler();
    let running = 0;
    let most = 0;
    let runs = 0;
    let release = () => {};
    const held = new Promise<void>((r) => (release = r));
    s.declare(job('q.stately'));
    s.handle('test', 'q.stately', async () => {
      running++;
      most = Math.max(most, running);
      await held;
      running--;
      runs++;
    });
    const calls = [s.runNow('q.stately'), s.runNow('q.stately'), s.runNow('q.stately')];

    // The first run is held until the queue holds the two rows this is about — one running, one waiting — rather
    // than for a fixed 60 ms. Under load the first run finished before the third call was even made, so all three
    // ran and the test failed for the machine having been busy (found in a full-suite run, 2026-10-28). Waiting
    // for the state makes the count exact instead of an upper bound: two rows run, the third caller joins.
    await until(async () => (await rows('SELECT `state` FROM `kernel_jobs` WHERE `name` = ?', ['q.stately'])).length === 2);
    release();
    await Promise.all(calls);
    expect(most).toBe(1);
    expect(runs).toBe(2);
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

  it('starts the clock again when the schedule in the spec is edited', async () => {
    // the phrase is stored beside next_run_at for exactly this: without it an edited schedule would keep
    // firing on the old one until the row happened to be rewritten
    const first = scheduler();
    first.declare(job('q.edited', 'every 1 hour'));
    first.handle('test', 'q.edited', async () => {});
    await first.start();
    await until(async () => Boolean(await oneSchedule('q.edited')));
    const before = await oneSchedule('q.edited');
    expect(before!.schedule).toBe('every 1 hour');

    await Promise.all(schedulers.splice(0).map((s) => s.stop()));
    const second = scheduler();
    second.declare(job('q.edited', 'every 1 sec'));
    second.handle('test', 'q.edited', async () => {});
    await second.start();
    await until(async () => (await oneSchedule('q.edited'))!.schedule === 'every 1 sec');
    expect((await oneSchedule('q.edited'))!.next_run_at.getTime()).toBeLessThan(before!.next_run_at.getTime());
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
    await until(async () => (await oneJob('q.fail'))?.state === 'failed');
    expect(runs).toBe(3);
  });

  it('an instance without workers enqueues and waits for one that has them', async () => {
    let ranOn = '';
    const worker = scheduler();
    const web = scheduler({ workers: false });
    for (const [s, who] of [
      [worker, 'worker'],
      [web, 'web'],
    ] as const) {
      s.declare(job('q.split'));
      s.handle('test', 'q.split', async () => {
        ranOn = who;
      });
      await s.start();
    }
    await web.runNow('q.split');
    expect(ranOn).toBe('worker');
  });

  it('stop lets the run in progress finish, then nothing runs', async () => {
    const s = scheduler();
    let started = 0;
    let finished = 0;
    s.declare(job('q.slow', 'every 1 sec'));
    s.handle('test', 'q.slow', async () => {
      started++;
      await sleep(300);
      finished++;
    });
    await s.start();
    await until(() => started === 1);
    await s.stop();
    expect(finished).toBe(started);
    await sleep(1_500);
    expect(started).toBe(1);
  });

  it('takes a lost run again once its lease has expired', async () => {
    const s = scheduler({ leaseSeconds: 0.1 });
    let runs = 0;
    s.declare(job('q.lost', 'on boot'));
    s.handle('test', 'q.lost', async () => {
      runs++;
    });
    // a run another instance claimed and never finished
    await store.pool.query(
      "INSERT INTO `kernel_jobs` (`id`, `name`, `state`, `run_at`, `attempts`, `max_attempts`, `lease_until`, `created_at`) " +
        "VALUES (UUID(), 'q.lost', 'active', NOW(3), 1, 3, DATE_SUB(NOW(3), INTERVAL 1 MINUTE), NOW(3))",
    );
    await s.start();
    await until(() => runs >= 1);
  });
});

const oneSchedule = async (name: string) =>
  (await rows<RowDataPacket & { schedule: string; next_run_at: Date }>('SELECT `schedule`, `next_run_at` FROM `kernel_job_schedules` WHERE `job` = ?', [name]))[0];

/**
 * The two the MongoDB runner has no counterpart for.
 */
describe('what MySQL does that MongoDB did not', () => {
  it('skips a row another worker has locked instead of queueing behind it', async () => {
    // Without SKIP LOCKED the claim of q.blocked would wait on the held row for innodb_lock_wait_timeout
    // (10 s), and q.free — the very next job in the same pass — would wait with it. This is the test for
    // "one stuck row does not stop the queue".
    const s = scheduler();
    let freeRuns = 0;
    for (const name of ['q.blocked', 'q.free']) {
      s.declare(job(name, 'on boot'));
      s.handle('test', name, async () => {
        if (name === 'q.free') freeRuns++;
      });
    }
    const id = '00000000-0000-7000-8000-000000000001';
    await store.pool.query(
      "INSERT INTO `kernel_jobs` (`id`, `name`, `state`, `run_at`, `attempts`, `max_attempts`, `created_at`) VALUES (?, 'q.blocked', 'queued', NOW(3), 0, 1, NOW(3))",
      [id],
    );
    const holder = await store.pool.getConnection();
    try {
      await holder.query('START TRANSACTION');
      await holder.query('SELECT `id` FROM `kernel_jobs` WHERE `id` = ? FOR UPDATE', [id]);

      const started = Date.now();
      await s.start();
      await until(() => freeRuns >= 1, 5_000);
      expect(Date.now() - started).toBeLessThan(5_000);
      // and the locked one was left alone, not failed
      expect((await oneJob('q.blocked'))?.state).toBe('queued');
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
  }, 30_000);

  it('runs a statement again when InnoDB picks it as the deadlock victim', async () => {
    // A deadlock escaped from here in a full test run on 2026-10-27 and failed the call. It takes real
    // contention to produce one -- several instances inserting the same job name, racing on the
    // insert-intention locks of uq_kernel_jobs_queued -- so this test makes the server's answer instead of
    // the conditions, which is the only way to pin the behaviour down rather than wait for it to happen.
    const s = scheduler();
    let runs = 0;
    s.declare(job('q.deadlocked'));
    s.handle('test', 'q.deadlocked', async () => {
      runs++;
    });

    const real = store.pool.query.bind(store.pool);
    let thrown = 0;
    (store.pool as { query: unknown }).query = (...args: unknown[]) => {
      if (thrown === 0 && String(args[0]).startsWith('INSERT INTO \`kernel_jobs\`')) {
        thrown++;
        return Promise.reject(Object.assign(new Error('Deadlock found when trying to get lock; try restarting transaction'), { errno: 1213, code: 'ER_LOCK_DEADLOCK' }));
      }
      return (real as (...a: unknown[]) => unknown)(...args);
    };
    try {
      await s.runNow('q.deadlocked');
    } finally {
      (store.pool as { query: unknown }).query = real;
    }
    expect(thrown).toBe(1); // the enqueue really was refused once
    expect(runs).toBe(1); // and the job still ran
  });

  it('treats "another instance is already running it" as a duplicate key, not an error', async () => {
    // uq_kernel_jobs_active holds one active row per job. The claim's UPDATE is what runs into it, and a
    // 1062 there means someone else won the race — the run simply is not ours.
    const s = scheduler({ workers: false });
    s.declare(job('q.one-active'));
    s.handle('test', 'q.one-active', async () => {});
    await store.pool.query(
      "INSERT INTO `kernel_jobs` (`id`, `name`, `state`, `run_at`, `attempts`, `max_attempts`, `created_at`) VALUES " +
        "(UUID(), 'q.one-active', 'active', NOW(3), 1, 3, NOW(3)), (UUID(), 'q.one-active', 'queued', NOW(3), 0, 3, NOW(3))",
    );
    const worker = scheduler();
    worker.declare(job('q.one-active'));
    let runs = 0;
    worker.handle('test', 'q.one-active', async () => {
      runs++;
    });
    await worker.start();
    await sleep(400);
    expect(runs).toBe(0); // the queued row stays queued while the other run holds the active slot
    expect(errors).toEqual([]); // and nothing was logged as a failure
  });
});
