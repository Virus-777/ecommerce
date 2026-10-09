/**
 * Background jobs (payout runs, deadlines, ad schedules, payment checks). Each job is declared in its
 * module's spec with a schedule; the module supplies the handler with ctx.jobs.handle().
 *
 * This in-process scheduler understands the spec's schedule phrases ("every 10 min", "hourly",
 * "daily 02:00 market time", "nightly 03:00 PT", "on boot"). Phrases it can't time
 * ("per payoutSchedule at cutoff", "queue worker", "on demand") run only through runNow().
 * A Postgres-backed queue (pg-boss) can replace it behind the same interface.
 */
import type { FastifyBaseLogger } from 'fastify';
import { isNotImplemented } from '../errors/index.js';
import { dateInZone, systemClock, zonedTimeToUtc, type Clock } from '../lib/clock.js';

export type Schedule =
  | { kind: 'interval'; ms: number; window?: 'business-hours' }
  | { kind: 'daily'; time: string }
  | { kind: 'weekly'; time: string }
  | { kind: 'monthly'; time: string }
  | { kind: 'boot' }
  | { kind: 'manual'; note: string };

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
  return { kind: 'manual', note: text };
}

export interface JobDefinition {
  name: string;
  module: string;
  schedule: string;
  does: string;
}

interface Registered extends JobDefinition {
  parsed: Schedule;
  run?: () => Promise<unknown>;
  /** The run in progress, if any */
  current?: Promise<void>;
  lastRunAt?: Date;
  lastError?: string;
}

export class JobScheduler {
  readonly #jobs = new Map<string, Registered>();
  readonly #timers = new Set<NodeJS.Timeout>();
  readonly #log: FastifyBaseLogger;
  readonly #timeZone: string;
  readonly #clock: Clock;
  #started = false;

  constructor(log: FastifyBaseLogger, timeZone: string, clock: Clock = systemClock) {
    this.#log = log;
    this.#timeZone = timeZone;
    this.#clock = clock;
  }

  declare(def: JobDefinition) {
    this.#jobs.set(def.name, { ...def, parsed: parseSchedule(def.schedule) });
  }

  handle(module: string, name: string, run: () => Promise<unknown>) {
    const job = this.#jobs.get(name);
    if (!job || job.module !== module) throw new Error(`Module ${module} handles job ${name}, which is not in its spec jobs`);
    job.run = run;
  }

  list() {
    return [...this.#jobs.values()].map(({ run, current: _current, ...job }) => ({ ...job, handled: Boolean(run) }));
  }

  /**
   * Runs the job and resolves when that run is done. A job never overlaps itself: when a run is in
   * progress, this waits for it and then runs again, so the caller always gets a run that started after it asked.
   */
  async runNow(name: string): Promise<void> {
    const job = this.#jobs.get(name);
    if (!job?.run) throw new Error(`Job ${name} has no handler`);
    while (job.current) await job.current.catch(() => {});
    const run = job.run;
    job.current = (async () => {
      try {
        await run();
        job.lastError = undefined;
      } catch (err) {
        job.lastError = (err as Error).message;
        const level = isNotImplemented(err) ? 'debug' : 'error';
        this.#log[level]({ err, job: name }, `job ${name} failed`);
      } finally {
        job.lastRunAt = this.#clock.now();
      }
    })();
    try {
      await job.current;
    } finally {
      job.current = undefined;
    }
  }

  start() {
    if (this.#started) return;
    this.#started = true;
    for (const job of this.#jobs.values()) {
      if (!job.run) continue;
      const p = job.parsed;
      if (p.kind === 'boot') void this.runNow(job.name);
      else if (p.kind === 'interval') {
        const t = setInterval(() => void this.runNow(job.name), p.ms);
        t.unref();
        this.#timers.add(t);
      } else if ('time' in p) this.#scheduleAt(job, p);
    }
  }

  #scheduleAt(job: Registered, p: Extract<Schedule, { time: string }>) {
    const now = this.#clock.now();
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
      void this.runNow(job.name).finally(() => this.#started && this.#scheduleAt(job, p));
    }, Math.min(next.getTime() - now.getTime(), 2 ** 31 - 1));
    t.unref();
    this.#timers.add(t);
  }

  stop() {
    this.#started = false;
    for (const t of this.#timers) clearTimeout(t);
    this.#timers.clear();
  }
}
