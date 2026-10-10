/**
 * Jobs on pg-boss (PostgreSQL), for production and for several server instances on one database.
 *
 *   - every declared job is a pg-boss queue of the same name, policy "stately": at most one run queued and one
 *     active, so a job never overlaps itself across instances and missed ticks don't pile up;
 *   - interval, daily, weekly and monthly schedules are pg-boss cron schedules in the market time zone; pg-boss
 *     sends one job per occurrence whatever the number of instances. Intervals cron can't express (under a
 *     minute) are sent throttled from each worker instance: one job per slot across instances;
 *   - "on boot" jobs are sent once per deploy: the job id is derived from the deploy id, so the second
 *     instance's send is a no-op;
 *   - a failed run is retried with exponential backoff (RetryPolicy); a NOT_IMPLEMENTED dependency is not;
 *   - runNow enqueues a run and waits until it has finished (on whichever instance worked it).
 *
 * Instances with JOBS_ENABLED work the queues and keep the schedules; the others only enqueue (runNow).
 * pg-boss keeps its own tables in the `pgboss` schema and migrates them when it starts.
 */
import type { FastifyBaseLogger } from 'fastify';
import { createHash } from 'node:crypto';
import { PgBoss, type ConstructorOptions, type Queue } from 'pg-boss';
import { systemClock, type Clock } from '../lib/clock.js';
import { JobRegistry, type JobScheduler, type Schedule } from './index.js';

export interface RetryPolicy {
  /** Retries after the first failure */
  limit: number;
  /** First delay; doubles each retry (with jitter) */
  delaySeconds: number;
  maxDelaySeconds: number;
}

export interface PgBossSchedulerOptions {
  connectionString: string;
  timeZone: string;
  clock?: Clock;
  /** Work the queues and keep the schedules in this process */
  workers: boolean;
  /** Identifies the deployment: "on boot" jobs run once per value */
  deployId: string;
  retry?: Partial<RetryPolicy>;
  /** How long a run may take before pg-boss counts it as failed and retries it */
  expireInSeconds?: number;
  /** Worker poll interval when no notification arrives */
  pollingIntervalSeconds?: number;
  /** pg-boss schema (default pgboss) */
  schema?: string;
  /** Wake workers with LISTEN/NOTIFY instead of waiting for the next poll (default on) */
  listenNotify?: boolean;
  /** Tests: pg-boss constructor options (a TestClock, faster cron passes) */
  boss?: Partial<ConstructorOptions>;
}

const RETRY: RetryPolicy = { limit: 3, delaySeconds: 30, maxDelaySeconds: 15 * 60 };
const DONE = new Set(['completed', 'failed', 'cancelled']);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const hhmm = (time: string) => {
  const [h, m] = time.split(':').map(Number);
  return { h: String(h), m: String(m) };
};

/**
 * The cron expression for a schedule, or undefined when cron can't express it (boot, intervals under a
 * minute or that don't divide an hour or a day). Weekly runs on Monday, monthly on the 1st.
 * The "business hours" window of an interval is the handler's to apply, as with the in-process runner.
 */
export function cronOf(s: Schedule): string | undefined {
  if (s.kind === 'boot') return undefined;
  if (s.kind === 'interval') {
    if (s.ms % 60_000) return undefined;
    const min = s.ms / 60_000;
    if (min < 60 && 60 % min === 0) return min === 1 ? '* * * * *' : `*/${min} * * * *`;
    if (min % 60 === 0 && 24 % (min / 60) === 0) return min === 60 ? '0 * * * *' : min === 1440 ? '0 0 * * *' : `0 */${min / 60} * * *`;
    return undefined;
  }
  const { h, m } = hhmm(s.time);
  if (s.kind === 'daily') return `${m} ${h} * * *`;
  if (s.kind === 'weekly') return `${m} ${h} * * 1`;
  return `${m} ${h} 1 * *`;
}

/** Installs or upgrades pg-boss's tables (npm run migrate), so servers don't need to on start */
export async function migrateJobQueue(connectionString: string, schema = 'pgboss'): Promise<void> {
  const boss = new PgBoss({ connectionString, schema, schedule: false, supervise: false, max: 1 });
  await boss.start();
  await boss.stop({ graceful: false, close: true });
}

/** A stable UUID for a name (pg-boss job ids are uuids) */
function uuidOf(text: string): string {
  const h = createHash('sha256').update(text).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export class PgBossScheduler extends JobRegistry implements JobScheduler {
  readonly backend = 'pgboss' as const;
  readonly #o: PgBossSchedulerOptions;
  readonly #retry: RetryPolicy;
  #booting?: Promise<PgBoss>;
  readonly #workers = new Map<string, string>();
  readonly #timers = new Set<NodeJS.Timeout>();
  #started = false;
  #stopping = false;

  constructor(log: FastifyBaseLogger, o: PgBossSchedulerOptions) {
    super(log, o.clock ?? systemClock);
    this.#o = o;
    this.#retry = { ...RETRY, ...o.retry };
  }

  /** Starts pg-boss (once) and makes sure every declared job has its queue. */
  #ready(): Promise<PgBoss> {
    this.#booting ??= (async () => {
      const o = this.#o;
      const boss = new PgBoss({
        connectionString: o.connectionString,
        schema: o.schema ?? 'pgboss',
        application_name: 'marketly-jobs',
        max: 5,
        // only working instances keep schedules and maintain the tables
        schedule: o.workers,
        supervise: o.workers,
        useListenNotify: o.workers && (o.listenNotify ?? true),
        ...o.boss,
      });
      boss.on('error', (err) => this.log.error({ err }, 'job queue error'));
      boss.on('warning', (w) => this.log.warn({ warning: w }, `job queue: ${w.message}`));
      await boss.start();
      const queue = (): Omit<Queue, 'name'> => ({
        policy: 'stately',
        retryLimit: this.#retry.limit,
        retryDelay: this.#retry.delaySeconds,
        retryBackoff: true,
        retryDelayMax: this.#retry.maxDelaySeconds,
        expireInSeconds: o.expireInSeconds ?? 3600,
        notify: o.listenNotify ?? true,
      });
      const names = [...this.jobs.keys()];
      const existing = new Set((await boss.getQueues(names)).map((q) => q.name));
      for (const name of names) {
        if (existing.has(name)) {
          const { policy: _policy, ...settings } = queue();
          await boss.updateQueue(name, settings);
        } else await boss.createQueue(name, queue());
      }
      return boss;
    })();
    return this.#booting;
  }

  async start() {
    if (this.#started) return;
    this.#started = true;
    const boss = await this.#ready();
    if (!this.#o.workers) return;
    const polling = this.#o.pollingIntervalSeconds ?? 2;
    for (const job of this.jobs.values()) {
      if (!job.run) continue;
      const handled = this.handled(job.name);
      const id = await boss.work(job.name, { pollingIntervalSeconds: polling, notifyPollingIntervalSeconds: 30, localConcurrency: 1, batchSize: 1 }, async () => {
        await this.execute(handled, true);
      });
      this.#workers.set(job.name, id);
    }
    for (const job of this.jobs.values()) {
      if (!job.run) continue;
      const p = job.parsed;
      const cron = cronOf(p);
      if (cron) {
        await boss.schedule(job.name, cron, null, { tz: this.#o.timeZone });
        continue;
      }
      // no cron expression: drop a schedule an earlier phrase left behind
      await boss.unschedule(job.name);
      if (p.kind === 'boot') {
        // the id is the same on every instance of this deploy; the key keeps it clear of a queued manual run
        await boss.send(job.name, null, { id: uuidOf(`${job.name}@${this.#o.deployId}`), singletonKey: 'boot', deleteAfterSeconds: 90 * 86_400 });
      } else if (p.kind === 'interval') {
        const seconds = Math.max(1, Math.round(p.ms / 1000));
        const tick = () => void boss.sendThrottled(job.name, null, null, seconds).catch((err) => this.log.error({ err, job: job.name }, 'job queue: send failed'));
        // several sends per slot from each instance; the throttle keeps one job per slot
        const t = setInterval(tick, Math.max(1000, p.ms / 3));
        t.unref();
        this.#timers.add(t);
        tick();
      }
    }
  }

  async runNow(name: string): Promise<void> {
    this.handled(name);
    const boss = await this.#ready();
    // a manual run is not retried: the caller gets its answer, the next scheduled run tries again
    let id = await boss.send(name, null, { retryLimit: 0 });
    while (!id) {
      // a run is already queued (stately queue): it starts after this call, so it is the one to wait for
      id = (await boss.findJobs(name, { queued: true })).find((j) => j.state === 'created')?.id ?? (await boss.send(name, null, { retryLimit: 0 }));
    }
    const worker = this.#workers.get(name);
    if (worker) boss.notifyWorker(worker);
    for (let wait = 50; !this.#stopping; wait = Math.min(wait * 2, 1000)) {
      const [job] = await boss.findJobs(name, { id });
      // done: finished, waiting for a retry (the attempt we waited for failed), or already removed
      if (!job || DONE.has(job.state) || job.state === 'retry') return;
      await sleep(wait);
    }
  }

  async stop() {
    if (this.#stopping) return;
    this.#stopping = true;
    for (const t of this.#timers) clearInterval(t);
    this.#timers.clear();
    const boss = this.#booting ? await this.#booting.catch(() => undefined) : undefined;
    // graceful: runs in progress finish before the connections close
    await boss?.stop({ graceful: true, timeout: 60_000, close: true });
  }
}
