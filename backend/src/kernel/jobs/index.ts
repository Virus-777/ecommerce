/**
 * Background jobs (payout runs, deadlines, ad schedules, payment checks). Each job is declared in its
 * module's spec with a schedule; the module supplies the handler with ctx.jobs.handle().
 *
 * Two runners behind one interface (JOBS_BACKEND):
 *   - pgboss (production, DATABASE_URL): a pg-boss queue per job in PostgreSQL. Schedules are pg-boss
 *     schedules, so with several server instances each run happens once; failures are retried with backoff
 *     (pgboss.ts).
 *   - inprocess (development and tests on PGlite): timers in this process. Every instance runs every job.
 *
 * Both understand the spec's schedule phrases ("every 10 min", "hourly", "daily 02:00 market time",
 * "nightly 03:00 PT", "on boot"). Any other phrase fails boot: a job the scheduler can't time would
 * silently never run (FORMAT.md lists the phrases).
 */
import type { FastifyBaseLogger } from 'fastify';
import { isNotImplemented } from '../errors/index.js';
import { dateInZone, systemClock, zonedTimeToUtc, type Clock } from '../lib/clock.js';

export type Schedule =
  | { kind: 'interval'; ms: number; window?: 'business-hours' }
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
    return { kind: 'interval', ms, ...(s.includes('business hours') ? { window: 'business-hours' as const } : {}) };
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
  readonly backend: 'inprocess' | 'pgboss';
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
    let date = dateInZone(now, this.#timeZone);
    let next = zonedTimeToUtc(date, p.time, this.#timeZone);
    const step = () => {
      const d = new Date(`${date}T12:00:00Z`);
      if (p.kind === 'daily') d.setUTCDate(d.getUTCDate() + 1);
      else if (p.kind === 'weekly') d.setUTCDate(d.getUTCDate() + 7);
      else d.setUTCMonth(d.getUTCMonth() + 1, 1);
      date = d.toISOString().slice(0, 10);
      next = zonedTimeToUtc(date, p.time, this.#timeZone);
    };
    if (p.kind === 'monthly') {
      date = `${date.slice(0, 8)}01`;
      next = zonedTimeToUtc(date, p.time, this.#timeZone);
    }
    while (next <= now) step();
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
  backend: 'inprocess' | 'pgboss';
  timeZone: string;
  clock?: Clock;
  /** pgboss: the PostgreSQL connection string */
  connectionString?: string;
  /** pgboss: whether this instance works jobs (JOBS_ENABLED); otherwise it only enqueues */
  workers?: boolean;
  /** pgboss: identifies the deployment, so "on boot" jobs run once per deploy */
  deployId?: string;
}

/** The runner the config asks for; pg-boss is loaded only when used. */
export async function createJobScheduler(log: FastifyBaseLogger, o: SchedulerOptions): Promise<JobScheduler> {
  if (o.backend === 'inprocess') return new InProcessScheduler(log, o.timeZone, o.clock);
  if (!o.connectionString) throw new Error('JOBS_BACKEND=pgboss needs DATABASE_URL');
  const { PgBossScheduler } = await import('./pgboss.js');
  return new PgBossScheduler(log, {
    connectionString: o.connectionString,
    timeZone: o.timeZone,
    clock: o.clock,
    workers: o.workers ?? true,
    deployId: o.deployId ?? 'unversioned',
  });
}
