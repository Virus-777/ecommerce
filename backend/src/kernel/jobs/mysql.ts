/**
 * Jobs on MySQL (`kernel_jobs`), for production and for several server instances on one database
 * (docs/10-mysql-migration.md §12). The rules are the ones kernel/jobs/mongo.ts keeps, and the tests in
 * jobs.test.ts are shared by both runners:
 *
 *   - a job's queue holds at most one waiting run and one running run, so a job never overlaps itself across
 *     instances and missed ticks don't pile up;
 *   - schedules are kept in `kernel_job_schedules`: a tick is taken by advancing `next_run_at`, and only the
 *     instance whose UPDATE matched the old value enqueues it;
 *   - "on boot" jobs run once per deploy (`kernel_job_boots`, keyed by job and deploy id);
 *   - a failed run is retried with exponential backoff; a NOT_IMPLEMENTED dependency is not; a run whose
 *     instance died is taken again when its lease expires;
 *   - `runNow` enqueues a run (or joins the one already waiting) and resolves when it has finished.
 *
 * Two things are done differently from MongoDB, and both come from the same place — MySQL has no
 * `findOneAndUpdate`:
 *
 *  - **Claiming is a transaction: `SELECT … FOR UPDATE SKIP LOCKED`, then `UPDATE`.** `SKIP LOCKED` is what
 *    lets many workers claim at once without queueing behind each other; without it every worker would wait
 *    on the first worker's row and the poll would serialise across the whole deployment.
 *  - **"One running per job" is still a unique key, and it is still enforced by letting the write fail.** The
 *    UPDATE to `active` raises 1062 on `uq_kernel_jobs_active` when another instance got there first, which
 *    means "someone else is running it", not an error. On MongoDB that would have taken the transaction down
 *    with it; here it fails only the statement, and the claim rolls back and answers null.
 */
import type { FastifyBaseLogger } from 'fastify';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { systemClock, type Clock } from '../lib/clock.js';
import { newId } from '../lib/ids.js';
import { isDuplicateKey } from '../mysql/errors.js';
import type { MysqlStore } from '../mysql/index.js';
import { JobRegistry, nextOccurrence, type JobScheduler } from './index.js';

export interface MysqlSchedulerOptions {
  store: MysqlStore;
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

interface JobRow extends RowDataPacket {
  id: string;
  name: string;
  state: 'queued' | 'active' | 'completed' | 'failed';
  run_at: Date;
  attempts: number;
  max_attempts: number;
}

const RETRY = { limit: 3, delaySeconds: 30, maxDelaySeconds: 15 * 60 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Every column #claim and #failed read; the rest of the row is never needed in this file */
const JOB_COLUMNS = '`id`, `name`, `state`, `run_at`, `attempts`, `max_attempts`';

export class MysqlScheduler extends JobRegistry implements JobScheduler {
  readonly backend = 'mysql' as const;
  readonly #o: MysqlSchedulerOptions;
  readonly #retry: typeof RETRY;
  readonly #running = new Map<string, Promise<void>>();
  #timer?: NodeJS.Timeout;
  #started = false;
  #stopping = false;

  constructor(log: FastifyBaseLogger, o: MysqlSchedulerOptions) {
    super(log, o.clock ?? systemClock);
    this.#o = o;
    this.#retry = { ...RETRY, ...o.retry };
  }

  async #rows<T extends RowDataPacket>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    const [rows] = await this.#o.store.pool.query<T[]>(sql, [...params]);
    return rows;
  }

  async #write(sql: string, params: readonly unknown[] = []): Promise<ResultSetHeader> {
    const [res] = await this.#o.store.pool.query<ResultSetHeader>(sql, [...params]);
    return res;
  }

  /** Queues a run, or returns the id of the run already waiting (one per job) */
  async #enqueue(name: string, manual: boolean): Promise<string> {
    const now = this.clock.now();
    const id = newId();
    try {
      await this.#write(
        'INSERT INTO `kernel_jobs` (`id`, `name`, `state`, `run_at`, `attempts`, `max_attempts`, `created_at`) VALUES (?, ?, ' +
          "'queued', ?, 0, ?, ?)",
        [id, name, now, manual ? 1 : 1 + this.#retry.limit, now],
      );
      return id;
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
      const [waiting] = await this.#rows<JobRow>('SELECT `id` FROM `kernel_jobs` WHERE `name` = ? AND `state` = ? LIMIT 1', [name, 'queued']);
      // the waiting run may have been claimed between the insert and this read, so try again
      return waiting ? waiting.id : this.#enqueue(name, manual);
    }
  }

  /**
   * Takes a due run of the job (a given one, or the waiting one); null when none is due, one is already
   * running, or another worker is claiming the same row.
   */
  async #claim(name: string, id?: string): Promise<JobRow | null> {
    const now = this.clock.now();
    const lease = new Date(now.getTime() + (this.#o.leaseSeconds ?? 3600) * 1000);
    return this.#o.store.transaction(async (tx) => {
      const [rows] = await tx.conn.query<JobRow[]>(
        `SELECT ${JOB_COLUMNS} FROM \`kernel_jobs\` WHERE \`name\` = ? AND \`state\` = 'queued' AND \`run_at\` <= ?` +
          `${id ? ' AND `id` = ?' : ''} ORDER BY \`run_at\` LIMIT 1 FOR UPDATE SKIP LOCKED`,
        id ? [name, now, id] : [name, now],
      );
      const found = rows[0];
      if (!found) return null;
      try {
        await tx.conn.query(
          "UPDATE `kernel_jobs` SET `state` = 'active', `started_at` = ?, `lease_until` = ?, `attempts` = `attempts` + 1 WHERE `id` = ?",
          [now, lease, found.id],
        );
      } catch (err) {
        // uq_kernel_jobs_active: another instance is running this job. Only this statement failed, so the
        // transaction is still good and simply has nothing to commit.
        if (isDuplicateKey(err)) return null;
        throw err;
      }
      return { ...found, state: 'active', attempts: found.attempts + 1 } as JobRow;
    });
  }

  /** Runs a claimed job here and records how it ended */
  #run(job: JobRow): Promise<void> {
    const run = (async () => {
      const handled = this.handled(job.name);
      try {
        await this.execute(handled, true);
        await this.#write("UPDATE `kernel_jobs` SET `state` = 'completed', `finished_at` = ?, `lease_until` = NULL WHERE `id` = ?", [this.clock.now(), job.id]);
      } catch (err) {
        await this.#failed(job, (err as Error).message);
      }
    })();
    this.#running.set(job.name, run);
    return run.finally(() => this.#running.delete(job.name));
  }

  /** A failed (or lost) run: waits for its retry, or ends failed when out of attempts or another run is waiting */
  async #failed(job: JobRow, error: string) {
    const now = this.clock.now();
    if (job.attempts < job.max_attempts) {
      const delay = Math.min(this.#retry.delaySeconds * 2 ** (job.attempts - 1), this.#retry.maxDelaySeconds) * (0.8 + Math.random() * 0.4);
      try {
        await this.#write("UPDATE `kernel_jobs` SET `state` = 'queued', `run_at` = ?, `error` = ?, `lease_until` = NULL WHERE `id` = ?", [
          new Date(now.getTime() + delay * 1000),
          error,
          job.id,
        ]);
        return;
      } catch (err) {
        if (!isDuplicateKey(err)) throw err; // uq_kernel_jobs_queued: a newer run is already waiting, so this one ends here
      }
    }
    await this.#write("UPDATE `kernel_jobs` SET `state` = 'failed', `finished_at` = ?, `error` = ?, `lease_until` = NULL WHERE `id` = ?", [now, error, job.id]);
  }

  /**
   * One pass of a worker: lost runs, schedule ticks, due runs. It runs every pollMs with every job declared,
   * so it reads in bulk — all the schedules in one statement and the names with a due run in another — and
   * writes only for the ticks that are due and the runs there are to claim.
   */
  async #tick() {
    const now = this.clock.now();
    for (const lost of await this.#rows<JobRow>(`SELECT ${JOB_COLUMNS} FROM \`kernel_jobs\` WHERE \`state\` = 'active' AND \`lease_until\` < ?`, [now])) {
      if (this.#running.has(lost.name)) continue;
      await this.#failed(lost, 'the instance running it stopped (lease expired)').catch((err) => this.log.error({ err, job: lost.name }, 'job queue: could not recover a lost run'));
    }

    const handled = [...this.jobs.values()].filter((job) => job.run);
    const scheduled = handled.filter((job) => job.parsed.kind !== 'boot');
    if (scheduled.length) {
      const stored = new Map(
        (
          await this.#rows<RowDataPacket & { job: string; schedule: string; next_run_at: Date }>(
            `SELECT \`job\`, \`schedule\`, \`next_run_at\` FROM \`kernel_job_schedules\` WHERE \`job\` IN (${scheduled.map(() => '?').join(', ')})`,
            scheduled.map((job) => job.name),
          )
        ).map((s) => [s.job, s]),
      );
      for (const job of scheduled) {
        const schedule = job.parsed as Exclude<typeof job.parsed, { kind: 'boot' }>;
        const s = stored.get(job.name);
        // new, or the phrase in the spec has been edited: start its clock again rather than firing on the old one
        if (!s || s.schedule !== job.schedule) {
          await this.#write(
            'INSERT INTO `kernel_job_schedules` (`job`, `schedule`, `next_run_at`) VALUES (?, ?, ?) AS new ' +
              'ON DUPLICATE KEY UPDATE `schedule` = new.`schedule`, `next_run_at` = new.`next_run_at`',
            [job.name, job.schedule, nextOccurrence(schedule, now, this.#o.timeZone)],
          );
          continue;
        }
        if (s.next_run_at > now) continue;
        // the instance whose UPDATE matched the old next_run_at is the one that enqueues the tick
        const won = await this.#write('UPDATE `kernel_job_schedules` SET `next_run_at` = ? WHERE `job` = ? AND `next_run_at` = ?', [
          nextOccurrence(schedule, now, this.#o.timeZone),
          job.name,
          s.next_run_at,
        ]);
        if (won.affectedRows) await this.#enqueue(job.name, false);
      }
    }

    // read after the ticks above, so the runs they just enqueued are claimed in this pass
    if (!handled.length) return;
    const due = new Set(
      (
        await this.#rows<RowDataPacket & { name: string }>(
          `SELECT DISTINCT \`name\` FROM \`kernel_jobs\` WHERE \`state\` = 'queued' AND \`run_at\` <= ? AND \`name\` IN (${handled.map(() => '?').join(', ')})`,
          [this.clock.now(), ...handled.map((job) => job.name)],
        )
      ).map((r) => r.name),
    );
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
      // the instance that inserts the row is the one that runs it: once per job per deploy
      try {
        await this.#write('INSERT INTO `kernel_job_boots` (`job_deploy`, `at`) VALUES (?, ?)', [`${job.name}@${this.#o.deployId}`, this.clock.now()]);
      } catch (err) {
        if (isDuplicateKey(err)) continue;
        throw err;
      }
      await this.#enqueue(job.name, false);
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
      const [job] = await this.#rows<RowDataPacket & Pick<JobRow, 'state' | 'attempts'>>('SELECT `state`, `attempts` FROM `kernel_jobs` WHERE `id` = ?', [id]);
      // done: finished, waiting for a retry (the attempt we waited for failed), or already purged
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
