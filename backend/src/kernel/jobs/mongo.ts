/**
 * Jobs on MongoDB (kernel.jobs), for production and for several server instances on one replica set
 * (docs/04-mongodb-migration.md §4):
 *
 *   - a job's queue holds at most one waiting run and one running run (unique partial indexes on the job name), so a
 *     job never overlaps itself across instances and missed ticks don't pile up;
 *   - schedules (intervals, daily, weekly on the computed weekday, monthly on the 1st, market time zone) are kept in
 *     kernel.job_schedules: each tick is taken by advancing next_run_at atomically, so one instance enqueues it;
 *   - "on boot" jobs run once per deploy (kernel.job_boots, keyed by job and deploy id);
 *   - a failed run is retried with exponential backoff; a NOT_IMPLEMENTED dependency is not; a run whose instance
 *     died is taken again when its lease expires;
 *   - runNow enqueues a run (or joins the one already waiting) and resolves when it has finished.
 *
 * Instances with JOBS_ENABLED work the queues and keep the schedules; the others only enqueue (runNow waits for a
 * worker). Finished runs are kept 7 days (TTL index).
 */
import type { FastifyBaseLogger } from 'fastify';
import type { Model } from 'mongoose';
import { systemClock, type Clock } from '../lib/clock.js';
import { newId } from '../lib/ids.js';
import type { MongoStore } from '../mongo/index.js';
import { JobRegistry, nextOccurrence, type JobScheduler } from './index.js';

export interface MongoSchedulerOptions {
  store: MongoStore;
  timeZone: string;
  clock?: Clock;
  /** Work the queues and keep the schedules in this process */
  workers: boolean;
  /** Identifies the deployment: "on boot" jobs run once per value */
  deployId: string;
  retry?: Partial<{ limit: number; delaySeconds: number; maxDelaySeconds: number }>;
  /** How long a run may take before another instance counts it as lost and runs it again */
  leaseSeconds?: number;
  /** How often workers look for due runs and schedule ticks */
  pollMs?: number;
}

interface JobDoc {
  _id: string;
  name: string;
  state: 'queued' | 'active' | 'completed' | 'failed';
  run_at: Date;
  attempts: number;
  max_attempts: number;
  lease_until?: Date;
  started_at?: Date;
  finished_at?: Date;
  error?: string;
  created_at: Date;
}

const RETRY = { limit: 3, delaySeconds: 30, maxDelaySeconds: 15 * 60 };
const DUPLICATE = 11000;
const isDuplicate = (err: unknown) => (err as { code?: number })?.code === DUPLICATE;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class MongoScheduler extends JobRegistry implements JobScheduler {
  readonly backend = 'mongo' as const;
  readonly #o: MongoSchedulerOptions;
  readonly #retry: typeof RETRY;
  readonly #jobs: Model<JobDoc>;
  readonly #schedules: Model<{ _id: string; schedule: string; next_run_at: Date }>;
  readonly #boots: Model<{ _id: string; at: Date }>;
  readonly #running = new Map<string, Promise<void>>();
  #timer?: NodeJS.Timeout;
  #started = false;
  #stopping = false;

  constructor(log: FastifyBaseLogger, o: MongoSchedulerOptions) {
    super(log, o.clock ?? systemClock);
    this.#o = o;
    this.#retry = { ...RETRY, ...o.retry };
    this.#jobs = o.store.kernel('jobs');
    this.#schedules = o.store.kernel('job_schedules');
    this.#boots = o.store.kernel('job_boots');
  }

  /** Queues a run, or returns the run already waiting (one per job) */
  async #enqueue(name: string, manual: boolean): Promise<string> {
    const now = this.clock.now();
    const doc: JobDoc = { _id: newId(), name, state: 'queued', run_at: now, attempts: 0, max_attempts: manual ? 1 : 1 + this.#retry.limit, created_at: now };
    try {
      await this.#jobs.create(doc);
      return doc._id;
    } catch (err) {
      if (!isDuplicate(err)) throw err;
      const waiting = await this.#jobs.findOne({ name, state: 'queued' }).lean();
      return waiting ? waiting._id : this.#enqueue(name, manual);
    }
  }

  /** Takes a due run of the job (a given one, or the waiting one); null when none is due or one is running */
  async #claim(name: string, id?: string): Promise<JobDoc | null> {
    const now = this.clock.now();
    try {
      return await this.#jobs.findOneAndUpdate(
        { ...(id ? { _id: id } : {}), name, state: 'queued', run_at: { $lte: now } },
        { $set: { state: 'active', started_at: now, lease_until: new Date(now.getTime() + (this.#o.leaseSeconds ?? 3600) * 1000) }, $inc: { attempts: 1 } },
        { new: true, lean: true },
      );
    } catch (err) {
      if (isDuplicate(err)) return null; // a run of this job is already active
      throw err;
    }
  }

  /** Runs a claimed job here and records how it ended */
  #run(job: JobDoc): Promise<void> {
    const run = (async () => {
      const handled = this.handled(job.name);
      try {
        await this.execute(handled, true);
        await this.#jobs.updateOne({ _id: job._id }, { $set: { state: 'completed', finished_at: this.clock.now() }, $unset: { lease_until: '' } });
      } catch (err) {
        await this.#failed(job, (err as Error).message);
      }
    })();
    this.#running.set(job.name, run);
    return run.finally(() => this.#running.delete(job.name));
  }

  /** A failed (or lost) run: waits for its retry, or ends failed when out of attempts or another run is waiting */
  async #failed(job: JobDoc, error: string) {
    const now = this.clock.now();
    if (job.attempts < job.max_attempts) {
      const delay = Math.min(this.#retry.delaySeconds * 2 ** (job.attempts - 1), this.#retry.maxDelaySeconds) * (0.8 + Math.random() * 0.4);
      try {
        await this.#jobs.updateOne({ _id: job._id }, { $set: { state: 'queued', run_at: new Date(now.getTime() + delay * 1000), error }, $unset: { lease_until: '' } });
        return;
      } catch (err) {
        if (!isDuplicate(err)) throw err; // a newer run is already waiting: this one ends here
      }
    }
    await this.#jobs.updateOne({ _id: job._id }, { $set: { state: 'failed', finished_at: now, error }, $unset: { lease_until: '' } });
  }

  /**
   * One pass of a worker: lost runs, schedule ticks, due runs. It runs every pollMs with every job declared, so it
   * reads in bulk: all schedules in one query and the names of the jobs with a due run in another, then writes only
   * for the ticks that are due and the runs there are to claim (not one read and one claim per job each pass).
   */
  async #tick() {
    const now = this.clock.now();
    for (const lost of await this.#jobs.find({ state: 'active', lease_until: { $lt: now } }).lean()) {
      if (this.#running.has(lost.name)) continue;
      await this.#failed(lost, 'the instance running it stopped (lease expired)').catch((err) => this.log.error({ err, job: lost.name }, 'job queue: could not recover a lost run'));
    }
    const handled = [...this.jobs.values()].filter((job) => job.run);
    const scheduled = handled.filter((job) => job.parsed.kind !== 'boot');
    const schedules = new Map((await this.#schedules.find({ _id: { $in: scheduled.map((job) => job.name) } }).lean()).map((s) => [s._id, s]));
    for (const job of scheduled) {
      const schedule = job.parsed as Exclude<typeof job.parsed, { kind: 'boot' }>;
      const s = schedules.get(job.name);
      if (!s || s.schedule !== job.schedule) {
        await this.#schedules.updateOne({ _id: job.name }, { $set: { schedule: job.schedule, next_run_at: nextOccurrence(schedule, now, this.#o.timeZone) } }, { upsert: true });
        continue;
      }
      if (s.next_run_at > now) continue;
      // the instance that advances the tick enqueues it
      const won = await this.#schedules.updateOne({ _id: job.name, next_run_at: s.next_run_at }, { $set: { next_run_at: nextOccurrence(schedule, now, this.#o.timeZone) } });
      if (won.modifiedCount) await this.#enqueue(job.name, false);
    }
    // read after the ticks above, so the runs they just enqueued are claimed in this pass
    const due = new Set<string>(await this.#jobs.distinct('name', { state: 'queued', run_at: { $lte: this.clock.now() }, name: { $in: handled.map((job) => job.name) } }));
    for (const job of handled) {
      if (!due.has(job.name) || this.#running.has(job.name)) continue;
      const claimed = await this.#claim(job.name);
      if (claimed) void this.#run(claimed);
    }
  }

  async start() {
    if (this.#started) return;
    this.#started = true;
    if (!this.#o.workers) return;
    for (const job of this.jobs.values()) {
      if (!job.run || job.parsed.kind !== 'boot') continue;
      const r = await this.#boots.updateOne({ _id: `${job.name}@${this.#o.deployId}` }, { $setOnInsert: { at: this.clock.now() } }, { upsert: true });
      if (r.upsertedCount) await this.#enqueue(job.name, false);
    }
    const loop = async () => {
      if (this.#stopping) return;
      await this.#tick().catch((err) => this.log.error({ err }, 'job queue: worker pass failed'));
      if (!this.#stopping) this.#timer = setTimeout(loop, this.#o.pollMs ?? 1000);
    };
    void loop();
  }

  async runNow(name: string): Promise<void> {
    this.handled(name);
    const id = await this.#enqueue(name, true);
    for (let wait = 25; !this.#stopping; wait = Math.min(wait * 2, 500)) {
      if (this.#o.workers && !this.#running.has(name)) {
        const claimed = await this.#claim(name, id);
        if (claimed) {
          await this.#run(claimed);
          return;
        }
      }
      const job = await this.#jobs.findOne({ _id: id }).lean();
      // done: finished, waiting for a retry (the attempt we waited for failed), or already removed
      if (!job || job.state === 'completed' || job.state === 'failed' || (job.state === 'queued' && job.attempts > 0)) return;
      await (this.#running.get(name)?.catch(() => {}) ?? sleep(wait));
    }
  }

  async stop() {
    if (this.#stopping) return;
    this.#stopping = true;
    if (this.#timer) clearTimeout(this.#timer);
    await Promise.allSettled(this.#running.values());
  }
}
