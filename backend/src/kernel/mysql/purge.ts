/**
 * `kernel.purge-expired` (docs/10-mysql-migration.md §12): the job that replaces MongoDB's TTL monitor.
 *
 * On MongoDB five collections expired their own rows — a TTL index on a timestamp and a background monitor the
 * server ran every minute. MySQL has nothing of the kind, so one kernel job deletes them instead, every ten
 * minutes, by the rules in kernel-tables.ts (`PURGE_RULES`). Each table's timestamp leads an index, which
 * kernel-tables.test.ts holds it to; without that this job would scan the very tables it exists to keep small.
 *
 * **Why batches and not one DELETE.** A single `DELETE FROM kernel_processed_events WHERE at < ?` on a table a
 * month behind would hold row locks on everything it deletes until it finished, write one enormous undo log,
 * and go down the replication stream as one statement. So each pass deletes at most `PURGE_BATCH` rows
 * (`ORDER BY` the indexed column, so it is always the oldest ones), commits, and the next pass starts fresh:
 * locks measured in milliseconds, and a purge that is interrupted has still done most of its work.
 *
 * A pass that deletes fewer rows than it asked for has reached the cut-off, and the table is done. `MAX_PASSES`
 * stops a single run from working for hours on a table that is years behind: it deletes a million rows and
 * leaves the rest to the run ten minutes later (`more: true` says so, and the log line names the table).
 */
import type { ResultSetHeader } from 'mysql2/promise';
import type { Clock } from '../lib/clock.js';
import { isRetryable } from './errors.js';
import { MAX_ATTEMPTS, retryDelayMs, type MysqlStore } from './index.js';
import { PURGE_RULES, type KernelTable } from './kernel-tables.js';
import { q } from './where.js';

/** Rows per pass. Small enough that the locks are brief, large enough that a busy table keeps up */
export const PURGE_BATCH = 5_000;
/** Passes per table per run: a million rows, then the next run continues */
export const MAX_PASSES = 200;

export const PURGE_EXPIRED_JOB = {
  name: 'kernel.purge-expired',
  module: 'kernel',
  schedule: 'every 10 min',
  does: 'Delete the kernel rows that used to expire by themselves: idempotency keys after 24 h, webhook events, job boots and processed event keys after 90 d, finished job runs after 7 d',
};

export interface PurgedTable {
  table: KernelTable;
  deleted: number;
  passes: number;
  /** The run hit MAX_PASSES: there is more to delete, and the next run will take it */
  more: boolean;
}

export interface PurgeOptions {
  batch?: number;
  maxPasses?: number;
  /** The rules to apply (the kernel's own, unless a test narrows them) */
  rules?: readonly { table: KernelTable; column: string; afterHours: number }[];
}

/**
 * Deletes what each rule says is expired, oldest first, in batches. One row per table it touched.
 *
 * The statements run on the pool, outside any transaction: each pass is its own, which is the point. They are
 * retried on a deadlock or a lock wait timeout for the reason §12 gives the job runner — "you were the victim,
 * run it again" — and a DELETE that is run twice deletes what is left, so running it again is always safe.
 */
export async function purgeExpired(store: MysqlStore, clock: Clock, o: PurgeOptions = {}): Promise<PurgedTable[]> {
  const batch = o.batch ?? PURGE_BATCH;
  const maxPasses = o.maxPasses ?? MAX_PASSES;
  const now = clock.now().getTime();
  const out: PurgedTable[] = [];

  for (const rule of o.rules ?? PURGE_RULES) {
    const before = new Date(now - rule.afterHours * 3_600_000);
    const sql = `DELETE FROM ${q(rule.table)} WHERE ${q(rule.column)} < ? ORDER BY ${q(rule.column)} LIMIT ${batch}`;
    let deleted = 0;
    let passes = 0;
    let more = false;
    for (;;) {
      const removed = await retrying(async () => (await store.pool.query<ResultSetHeader>(sql, [before]))[0].affectedRows);
      passes++;
      deleted += removed;
      if (removed < batch) break;
      if (passes >= maxPasses) {
        more = true;
        break;
      }
    }
    out.push({ table: rule.table, deleted, passes, more });
  }
  return out;
}

/** One log line: only the tables that lost rows, so a quiet run says "nothing expired" */
export function purgeSummary(purged: readonly PurgedTable[]): string {
  const touched = purged.filter((p) => p.deleted > 0);
  if (!touched.length) return 'purge-expired: nothing expired';
  return `purge-expired: ${touched.map((p) => `${p.deleted} from ${p.table}${p.more ? ' (more left)' : ''}`).join(', ')}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function retrying<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (err) {
      if (!isRetryable(err) || attempt >= MAX_ATTEMPTS) throw err;
      await sleep(retryDelayMs());
    }
  }
}
