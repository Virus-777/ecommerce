/**
 * MySQL through mysql2 (docs/10-mysql-migration.md §10), the counterpart of kernel/mongo/index.ts. One database,
 * each module's tables named `<module>_<table>`, kernel tables `kernel_*`.
 *
 * `store.transaction(fn)` runs fn between START TRANSACTION and COMMIT and runs it again when InnoDB rolls it
 * back — a deadlock or a lock wait timeout. The rules are the same as they were on MongoDB, and one is new:
 *
 *   - fn only reads and writes the database: no events (publish after the commit), no provider calls;
 *   - one statement at a time on the transaction's connection, so no Promise.all inside fn;
 *   - a nested transaction() joins the one already running;
 *   - **InnoDB waits instead of aborting.** MongoDB aborted the second writer of a document and the wrapper
 *     retried, so an unlocked read-then-write was still safe. Here the second writer waits, then overwrites.
 *     A value read inside a transaction and written back must be locked first (§11.2), or made atomic in SQL.
 */
import { createPool, type Pool, type PoolConnection, type ResultSetHeader, type RowDataPacket } from 'mysql2/promise';
import { AppError } from '../errors/index.js';
import { beginScope, endScope } from './detect.js';
import { isConnectionLost, isRetryable } from './errors.js';
import { KERNEL_TABLES, kernelDdl, type KernelTable } from './kernel-tables.js';
import { ModuleStore, type ModuleTables } from './module-store.js';
import { CLIENT_OPTIONS, SESSION_COLLATION } from './portable.js';

export { KERNEL_TABLES, type KernelTable };
export { ModuleStore, type ModuleTables };
export { setDetector, UnlockedReadModifyWrite, UNLOCKED_READ_MODIFY_WRITE } from './detect.js';
export { Table } from './table.js';
export type { Sort, Patch, FindOptions, ReadOptions, ComputedOrder, TableContext } from './table.js';
export { decToZero, expr, inc, jsonAppend, q, raw } from './table.js';
export type { Cond, Where } from './where.js';
export { allMembersOf, contains, equalsIgnoringCase, memberOf, startsWith } from './where.js';

/** §10.3: five attempts, then the caller is told to try again (D8) */
export const MAX_ATTEMPTS = 5;
const BACKOFF_MIN_MS = 20;
const BACKOFF_MAX_MS = 200;

/** Every connection starts like this, so the session behaves as §20 configures the server */
export const SESSION_SETUP = [
  SESSION_COLLATION,
  "SET time_zone = '+00:00'",
  "SET SESSION transaction_isolation = 'READ-COMMITTED'",
  'SET SESSION innodb_lock_wait_timeout = 10',
] as const;

/**
 * Logs a transaction that was slow or had to be run again, as the MongoDB store did — with the MySQL error that
 * caused the retry, so a contended row shows up in the log by name (§10.3 rule 5).
 */
export interface TransactionWatch {
  log: { warn(obj: object, msg: string): void };
  slowMs: number;
}

/** A connection inside a transaction; passing it to a nested call joins that transaction rather than opening one */
export interface Tx {
  readonly conn: PoolConnection;
}

export interface MysqlStore {
  readonly pool: Pool;
  /** A module's view: its own tables only (ctx.mysql), typed with the generated `<Module>Tables` */
  module<DB = Record<string, never>>(name: string, tables: ModuleTables): ModuleStore<DB>;
  /** fn in a transaction, retried when InnoDB rolls it back. Inside one already, fn simply runs in it. */
  transaction<T>(fn: (tx: Tx) => Promise<T>, outer?: Tx, module?: string): Promise<T>;
  /** Next value of a named counter; never rolled back, so a number taken by an aborted transaction is skipped */
  nextValue(counter: string): Promise<number>;
  /** The next n values in order, taken in one update (none for n = 0) */
  nextValues(counter: string, n: number): Promise<number[]>;
  /** Creates the kernel_* tables if they are not there yet */
  /** The eleven kernel tables. `dropFirst`: the test harness's disposable databases, see the implementation */
  createKernelTables(o?: { dropFirst?: boolean }): Promise<void>;
  close(): Promise<void>;
}

/** The wait before another attempt, jittered so two instances that collided do not collide again (§10.3) */
export const retryDelayMs = () => BACKOFF_MIN_MS + Math.floor(Math.random() * (BACKOFF_MAX_MS - BACKOFF_MIN_MS));
const jitter = retryDelayMs;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface MysqlOptions {
  /** mysql://user:pass@host:port/database */
  url: string;
  /** §10.2: the whole of every process's pools must stay under the server's max_connections */
  poolSize?: number;
  watch?: TransactionWatch;
  /** An acquire that waits longer than this logs "pool exhausted" (§10.2) */
  slowAcquireMs?: number;
}

export function mysqlStore(pool: Pool, o: { watch?: TransactionWatch; slowAcquireMs?: number; onClose?: () => Promise<void> } = {}): MysqlStore {
  const slowAcquireMs = o.slowAcquireMs ?? 5_000;

  const acquire = async (): Promise<PoolConnection> => {
    const started = Date.now();
    const conn = await pool.getConnection();
    const waited = Date.now() - started;
    if (o.watch && waited > slowAcquireMs) o.watch.log.warn({ ms: waited }, 'pool exhausted');
    return conn;
  };

  const store: MysqlStore = {
    pool,

    module: (name, tables) => new ModuleStore(store, name, tables),

    async transaction<T>(fn: (tx: Tx) => Promise<T>, outer?: Tx, module?: string): Promise<T> {
      if (outer) return fn(outer); // already inside one: join it, as the MongoDB store did
      const started = Date.now();
      let attempts = 0;
      let lastError: unknown;
      try {
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
          attempts = attempt;
          const conn = await acquire();
          try {
            await conn.beginTransaction();
            // §11.2 rule 2: from here until this transaction ends, what it reads unlocked is remembered
            beginScope(conn);
            const result = await fn({ conn });
            await conn.commit();
            return result;
          } catch (err) {
            lastError = err;
            // the rollback itself can fail when the connection is the thing that broke; the error we report is fn's
            await conn.rollback().catch(() => undefined);
            if (isRetryable(err) && attempt < MAX_ATTEMPTS) {
              await sleep(jitter());
              continue;
            }
            // §10.3 rule 3: a connection lost during COMMIT leaves the outcome unknown, so this is never retried
            // here — only a caller who knows fn is idempotent may run it again.
            if (isRetryable(err)) {
              throw new AppError(
                'SERVICE_BUSY',
                'The records this request needs are busy right now. Please try again.',
                { attempts, module: module ?? 'kernel' },
                503,
              );
            }
            throw err;
          } finally {
            endScope(conn);
            conn.release();
          }
        }
        throw lastError; // unreachable: the loop either returns or throws
      } finally {
        const ms = Date.now() - started;
        if (o.watch && (ms > o.watch.slowMs || attempts > 1)) {
          o.watch.log.warn(
            { module: module ?? 'kernel', ms, attempts, ...(lastError ? { mysql: (lastError as { code?: string }).code } : {}) },
            'slow or retried transaction',
          );
        }
      }
    },

    async nextValue(counter) {
      const [value] = await store.nextValues(counter, 1);
      return value!;
    },

    /**
     * §11.2: counters are taken on their own connection, outside any transaction the caller is in. The row lock
     * then lasts microseconds instead of until the caller commits, and a number taken by a transaction that
     * later rolls back is simply skipped — which is what "never rolled back" meant on MongoDB too.
     */
    async nextValues(counter, n) {
      if (n <= 0) return [];
      const conn = await acquire();
      try {
        const [res] = await conn.query<ResultSetHeader>(
          'INSERT INTO `kernel_counters` (`name`, `value`) VALUES (?, ?) AS new ' +
            'ON DUPLICATE KEY UPDATE `value` = LAST_INSERT_ID(`kernel_counters`.`value` + new.`value`)',
          [counter, n],
        );
        // affectedRows is 1 when the row was created and 2 when it was updated. The distinction matters:
        // LAST_INSERT_ID() is per connection and a plain INSERT does not set it, so on a pooled connection it
        // would still hold a value from an earlier counter — silently handing out numbers already given away.
        // On the update branch the value comes back on the result itself, so there is no second round trip:
        // the server puts what LAST_INSERT_ID(…) was handed into the same OK packet.
        const last = res.affectedRows === 1 ? n : Number(res.insertId);
        if (!Number.isFinite(last) || last < n) throw new Error(`kernel_counters: ${counter} answered ${String(last)} for ${n} values`);
        return Array.from({ length: n }, (_, i) => last - n + 1 + i);
      } finally {
        conn.release();
      }
    },

    /**
     * The eleven kernel tables, created where they are absent.
     *
     * **`IF NOT EXISTS` says nothing about a table that exists and differs**, so a change to kernel-tables.ts
     * reaches a new database and no other: it needs the ALTER the kernel change comes with (§12 — the modules'
     * tables get theirs from `alterTable`, and the kernel's do not have that yet). `dropFirst` is the test
     * harness's way out, for a database it did not create itself and whose contents are disposable either way.
     */
    async createKernelTables(o = {}) {
      const conn = await acquire();
      try {
        if (o.dropFirst) {
          await conn.query('SET FOREIGN_KEY_CHECKS = 0');
          for (const t of KERNEL_TABLES) await conn.query(`DROP TABLE IF EXISTS \`${t}\``);
          await conn.query('SET FOREIGN_KEY_CHECKS = 1');
        }
        for (const ddl of kernelDdl()) await conn.query(ddl.replace('CREATE TABLE', 'CREATE TABLE IF NOT EXISTS'));
      } finally {
        conn.release();
      }
    },

    async close() {
      if (o.onClose) return o.onClose();
      await pool.end();
    },
  };
  return store;
}

/** Opens the pool and checks the server is one this backend supports (§20.1) */
export async function connectMysql(o: MysqlOptions): Promise<MysqlStore> {
  const url = new URL(o.url);
  const pool = createPool({
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username || 'root'),
    password: decodeURIComponent(url.password || ''),
    database: decodeURIComponent(url.pathname.replace(/^\//, '')) || undefined,
    connectionLimit: o.poolSize ?? Number(process.env.MYSQL_POOL_SIZE ?? 30),
    waitForConnections: true,
    queueLimit: 0,
    connectTimeout: 10_000,
    ...CLIENT_OPTIONS,
  });

  // mysql2 has no per-connection init hook, so the setup runs on each new connection as the pool makes it
  pool.on('connection', (conn) => {
    for (const sql of SESSION_SETUP) void conn.query(sql);
  });

  const conn = await pool.getConnection();
  try {
    for (const sql of SESSION_SETUP) await conn.query(sql);
    const [rows] = await conn.query<RowDataPacket[]>('SELECT VERSION() AS v');
    const { checkVersion } = await import('./portable.js');
    checkVersion(String(rows[0]?.v ?? ''), o.url.replace(/\/\/[^@]*@/, '//'));
  } catch (err) {
    await pool.end().catch(() => undefined);
    if (isConnectionLost(err)) throw new Error(`cannot reach MySQL at ${o.url.replace(/\/\/[^@]*@/, '//')}: ${(err as Error).message}`);
    throw err;
  } finally {
    conn.release();
  }

  return mysqlStore(pool, { ...(o.watch ? { watch: o.watch } : {}), ...(o.slowAcquireMs !== undefined ? { slowAcquireMs: o.slowAcquireMs } : {}) });
}
