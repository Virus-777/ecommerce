/**
 * Background jobs (payout runs, deadlines, ad schedules, payment checks). Each job is declared in its
 * module's spec with a schedule; the module supplies the handler with ctx.jobs.handle().
 *
 * Two runners behind one interface (JOBS_BACKEND):
 *   - mongo (production, MONGODB_URI): a queue in MongoDB (kernel.jobs, mongo.ts). With several server instances
 *     each scheduled run happens once; failures are retried with backoff.
 *   - inprocess (development and tests on the embedded MongoDB): timers in this process. Every instance runs
 *     every job.
 *
 * Both understand the spec's schedule phrases ("every 10 min", "hourly", "daily 02:00 market time",
 * "nightly 03:00 PT", "on boot"). Any other phrase fails boot: a job the scheduler can't time would
 * silently never run (FORMAT.md lists the phrases). Words after the timing ("every 30 min during business
 * hours") are for the reader; a job limited to some hours checks them in its handler.
 */
import type { FastifyBaseLogger } from 'fastify';
import { isNotImplemented } from '../errors/index.js';
import { dateInZone, systemClock, zonedTimeToUtc, type Clock } from '../lib/clock.js';
import type { MongoStore } from '../mongo/index.js';
import type { MysqlStore } from '../mysql/index.js';

export type Schedule =
  | { kind: 'interval'; ms: number }
  | { kind: 'daily'; time: string }
  | { kind: 'weekly'; time: string }
  | { kind: 'monthly'; time: string }
  | { kind: 'boot' };

export function parseSchedule(text: string): Schedule {
  const s = text.toLowerCase();
  const every = /^every (\d+)?\s*(s|sec|second|seconds|min|minute|minutes|hour|hours)\b/.exec(s);
  if (every) {
    const n = Number(every[1] ?? 1);
    const unit = every[2]!;
    const ms = unit.startsWith('s') ? n * 1000 : unit.startsWith('m') ? n * 60_000 : n * 3_600_000;
    return { kind: 'interval', ms };
  }
  if (s === 'hourly') return { kind: 'interval', ms: 3_600_000 };
  if (s === 'on boot') return { kind: 'boot' };
  const at = /(\d{1,2}:\d{2})/.exec(s)?.[1];
  if (/^(daily|nightly)/.test(s) && !s.includes('start of business')) return { kind: 'daily', time: at ?? '00:00' };
  if (/^weekly/.test(s)) return { kind: 'weekly', time: at ?? '00:00' };
  if (/^monthly/.test(s)) return { kind: 'monthly', time: at ?? '00:00' };
  throw new Error(`Job schedule "${text}" is not one the scheduler can time (see "jobs" in docs/api/spec/FORMAT.md)`);
}

export interface JobDefinition {
  name: string;
  module: string;
  schedule: string;
  does: string;
}

export interface JobInfo extends JobDefinition {
  parsed: Schedule;
  handled: boolean;
  /** Last run in this process */
  lastRunAt?: Date;
  lastError?: string;
}

export interface JobScheduler {
  readonly backend: 'inprocess' | 'mongo' | 'mysql';
  /** A job from a module spec (or the kernel's own); the schedule phrase is checked here */
  declare(def: JobDefinition): void;
  handle(module: string, name: string, run: () => Promise<unknown>): void;
  list(): JobInfo[];
  /**
   * Runs the job and resolves when that run is done (a failed run is logged, not thrown). A job never
   * overlaps itself: when a run is in progress, this waits for it and then runs again, so the caller
   * always gets a run that started after it asked.
   */
  runNow(name: string): Promise<void>;
  /** Run the schedules in this process (JOBS_ENABLED) */
  start(): Promise<void>;
  /** Stop scheduling; resolves once runs in progress have finished */
  stop(): Promise<void>;
}

interface Registered extends JobDefinition {
  parsed: Schedule;
  run?: () => Promise<unknown>;
  lastRunAt?: Date;
  lastError?: string;
}

/** Declared jobs and their handlers, shared by both runners. */
export abstract class JobRegistry {
  protected readonly jobs = new Map<string, Registered>();

  constructor(
    protected readonly log: FastifyBaseLogger,
    protected readonly clock: Clock,
  ) {}

  declare(def: JobDefinition) {
    this.jobs.set(def.name, { ...def, parsed: parseSchedule(def.schedule) });
  }

  handle(module: string, name: string, run: () => Promise<unknown>) {
    const job = this.jobs.get(name);
    if (!job || job.module !== module) throw new Error(`Module ${module} handles job ${name}, which is not in its spec jobs`);
    job.run = run;
  }

  list(): JobInfo[] {
    return [...this.jobs.values()].map(({ run, ...job }) => ({ ...job, handled: Boolean(run) }));
  }

  protected handled(name: string): Registered & { run: () => Promise<unknown> } {
    const job = this.jobs.get(name);
    if (!job?.run) throw new Error(`Job ${name} has no handler`);
    return job as Registered & { run: () => Promise<unknown> };
  }

  /**
   * One run of the handler, recorded on the job. A failure is logged; `rethrow` passes it on (the queue
   * retries it). A job whose dependency is not built yet (NOT_IMPLEMENTED) is a quiet no-op, never retried.
   */
  protected async execute(job: Registered & { run: () => Promise<unknown> }, rethrow = false): Promise<void> {
    try {
      await job.run();
      job.lastError = undefined;
    } catch (err) {
      job.lastError = (err as Error).message;
      const quiet = isNotImplemented(err);
      this.log[quiet ? 'debug' : 'error']({ err, job: job.name }, `job ${job.name} failed`);
      if (rethrow && !quiet) throw err;
    } finally {
      job.lastRunAt = this.clock.now();
    }
  }
}

/**
 * The first run of a clock schedule after `now`, in the market time zone. Weekly runs keep the weekday of the
 * day it was first computed on; monthly runs are on the 1st. Intervals: the next slot boundary (slots aligned to
 * the epoch, so every instance agrees).
 */
export function nextOccurrence(p: Exclude<Schedule, { kind: 'boot' }>, now: Date, timeZone: string): Date {
  if (p.kind === 'interval') return new Date((Math.floor(now.getTime() / p.ms) + 1) * p.ms);
  let date = dateInZone(now, timeZone);
  if (p.kind === 'monthly') date = `${date.slice(0, 8)}01`;
  let next = zonedTimeToUtc(date, p.time, timeZone);
  while (next <= now) {
    const d = new Date(`${date}T12:00:00Z`);
    if (p.kind === 'daily') d.setUTCDate(d.getUTCDate() + 1);
    else if (p.kind === 'weekly') d.setUTCDate(d.getUTCDate() + 7);
    else d.setUTCMonth(d.getUTCMonth() + 1, 1);
    date = d.toISOString().slice(0, 10);
    next = zonedTimeToUtc(date, p.time, timeZone);
  }
  return next;
}

/** Timers in this process: every instance runs every job (development and tests). */
export class InProcessScheduler extends JobRegistry implements JobScheduler {
  readonly backend = 'inprocess' as const;
  readonly #current = new Map<string, Promise<void>>();
  readonly #timers = new Set<NodeJS.Timeout>();
  readonly #timeZone: string;
  #started = false;

  constructor(log: FastifyBaseLogger, timeZone: string, clock: Clock = systemClock) {
    super(log, clock);
    this.#timeZone = timeZone;
  }

  async runNow(name: string): Promise<void> {
    const job = this.handled(name);
    while (this.#current.has(name)) await this.#current.get(name)!.catch(() => {});
    const current = this.execute(job);
    this.#current.set(name, current);
    try {
      await current;
    } finally {
      this.#current.delete(name);
    }
  }

  async start() {
    if (this.#started) return;
    this.#started = true;
    for (const job of this.jobs.values()) {
      if (!job.run) continue;
      const p = job.parsed;
      if (p.kind === 'boot') void this.runNow(job.name);
      else if (p.kind === 'interval') {
        const t = setInterval(() => void this.runNow(job.name), p.ms);
        t.unref();
        this.#timers.add(t);
      } else this.#scheduleAt(job.name, p);
    }
  }

  #scheduleAt(name: string, p: Extract<Schedule, { time: string }>) {
    const now = this.clock.now();
    const next = nextOccurrence(p, now, this.#timeZone);
    const t = setTimeout(() => {
      this.#timers.delete(t);
      void this.runNow(name).finally(() => this.#started && this.#scheduleAt(name, p));
    }, Math.min(next.getTime() - now.getTime(), 2 ** 31 - 1));
    t.unref();
    this.#timers.add(t);
  }

  async stop() {
    this.#started = false;
    for (const t of this.#timers) clearTimeout(t);
    this.#timers.clear();
    await Promise.allSettled(this.#current.values());
  }
}

export interface SchedulerOptions {
  backend: 'inprocess' | 'mongo' | 'mysql';
  timeZone: string;
  /** mongo: the store whose kernel.jobs collection is the queue */
  mongo?: MongoStore;
  /** mysql: the store whose kernel_jobs table is the queue */
  mysql?: MysqlStore;
  clock?: Clock;
  /** mongo, mysql: whether this instance works jobs (JOBS_ENABLED); otherwise it only enqueues */
  workers?: boolean;
  /** mongo, mysql: identifies the deployment, so "on boot" jobs run once per deploy */
  deployId?: string;
}

/** The runner the config asks for */
export async function createJobScheduler(log: FastifyBaseLogger, o: SchedulerOptions): Promise<JobScheduler> {
  if (o.backend === 'inprocess') return new InProcessScheduler(log, o.timeZone, o.clock);
  const shared = { timeZone: o.timeZone, clock: o.clock, workers: o.workers ?? true, deployId: o.deployId ?? 'unversioned' };
  // imported here, not at the top: both extend this file's JobRegistry
  if (o.backend === 'mysql') {
    if (!o.mysql) throw new Error('JOBS_BACKEND=mysql needs MySQL');
    const { MysqlScheduler } = await import('./mysql.js');
    return new MysqlScheduler(log, { store: o.mysql, ...shared });
  }
  if (!o.mongo) throw new Error('JOBS_BACKEND=mongo needs MongoDB');
  const { MongoScheduler } = await import('./mongo.js');
  return new MongoScheduler(log, { store: o.mongo, ...shared });
}
