/**
 * MySQL for tests: global-setup.ts starts one server per run (kernel/mysql/portable.ts, or TEST_MYSQL_URL);
 * every test file gets a database of its own from it.
 *
 * One server, not one per file. Each MySQL test file used to start its own `mysqld` on a port of its own —
 * seven servers for seven files, all running at once beside the MongoDB replica set and four hundred other
 * test files. That is a lot of memory and buffer pool on a machine that is also running the tests, and the
 * fixed ports meant two of those files could never run at the same time.
 *
 * Databases are reused the way testing/mongo.ts reuses them: named after the vitest worker slot, which runs
 * one file at a time, so the next file in that slot finds the kernel tables already made. A database is
 * emptied when a store takes it and when that store closes.
 */
import { createConnection, createPool, type Pool, type RowDataPacket } from 'mysql2/promise';
import { inject } from 'vitest';
import { mysqlStore, SESSION_SETUP, type MysqlStore } from '../kernel/mysql/index.js';
import { CLIENT_OPTIONS } from '../kernel/mysql/portable.js';

const free: string[] = [];
/** The databases this process has already set up in this run (see testMysql) */
const prepared = new Set<string>();
let made = 0;

/** The databases this file creates; global-setup drops them at the end of a run on a real server */
export const TEST_DATABASE = /^t\d+_\d+$/;

/** The run's server, or the reason there is none (so only the MySQL tests fail, not the whole suite) */
function baseUrl(): URL {
  const base = inject('mysqlUrl');
  if (!base) throw new Error(inject('mysqlError') || 'global-setup provided no MySQL for the tests');
  return new URL(base);
}

const connectionOf = (u: URL, database?: string) => ({
  host: u.hostname,
  port: Number(u.port || 3306),
  user: decodeURIComponent(u.username || 'root'),
  password: decodeURIComponent(u.password || ''),
  ...(database ? { database } : {}),
  ...CLIENT_OPTIONS,
});

/**
 * Creates the database, on a connection of its own that is closed again straight away. A kept-open admin pool
 * would be one per worker process with nothing to close it — vitest's global teardown runs in the main
 * process, not the workers — and the run then ends with "something prevents N Vite servers from exiting".
 */
async function createDatabase(u: URL, name: string, o: { fresh?: boolean } = {}): Promise<void> {
  const conn = await createConnection(connectionOf(u));
  try {
    // `fresh`: a slot's name comes round again in the next run, and what the last run left in it was built
    // from the spec as it was then. A changed column is not something migrate will rewrite by itself (§17.3,
    // and rightly: on a real server that is a migration), so it refuses at start-up and every test file in
    // that slot fails to boot — which is how `bigserial` gaining AUTO_INCREMENT turned eight files red.
    // One statement rather than a sweep of DROPs: a database with all forty modules in it holds 483 tables.
    if (o.fresh) await conn.query(`DROP DATABASE IF EXISTS \`${name}\``);
    await conn.query(`CREATE DATABASE IF NOT EXISTS \`${name}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin`);
  } finally {
    await conn.end();
  }
}

/**
 * Empties every table; the tables themselves stay, so the next file in this slot reuses them.
 *
 * **`DELETE`, not `TRUNCATE`.** A slot's database accumulates the tables of every file that ran in it, and once
 * some file has migrated all forty modules that is 483 of them. InnoDB's TRUNCATE drops and recreates a
 * tablespace per table, which costs **23 s** for 483 tables, measured; the same wipe by DELETE costs **0.5 s**,
 * because a DELETE on an empty table does almost nothing. This runs twice for every database a test file takes
 * (here, and again when the store closes), so it was about 46 s of every file that wanted MySQL — enough to
 * expire a 120 s `beforeAll` when several workers ask for one at the same time, which is what the suite's
 * "timeout waiting for a database" turned out to be.
 *
 * What TRUNCATE gave and DELETE does not is resetting AUTO_INCREMENT, so the tables that have one are rewound
 * by hand (24 of the 483; 188 ms). **No test depends on that**, and breaking it on purpose proved as much: the
 * contract suite's identity test asserts `second.seq === first.seq + 1` rather than 1 and 2, deliberately, and
 * nothing else in the suite reads an absolute identity value. It is kept because a database this says it has
 * emptied should also look empty, and a counter drifting upward between files is the kind of thing that fails a
 * module's test in Y2 for a reason nobody can see.
 */
async function empty(pool: Pool, database: string): Promise<void> {
  // BASE TABLE only: a view has no rows of its own. AUTO_INCREMENT is null for a table without one, and
  // otherwise holds the *next* value, so above 1 means rows were numbered and the counter needs rewinding
  const [tables] = await pool.query<(RowDataPacket & { TABLE_NAME: string; AUTO_INCREMENT: number | null })[]>(
    "SELECT TABLE_NAME, AUTO_INCREMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'",
    [database],
  );
  if (!tables.length) return;
  // `kernel_migrations` keeps its rows: they say which schema the tables that are *still here* were built
  // from, and every app a test file builds takes a database from this same slot. Wiping them made each boot
  // re-migrate every module it loads — migrate reads information_schema and diffs each table — which is why
  // a file that boots ten apps with the kernel and a dozen modules on MySQL was timing out at sixty seconds
  // a test, and why it got slower with every module the tranche converted. The database itself is dropped
  // once per run (testMysql), so a hash in here cannot outlive the tables it describes.
  const wipe = tables.filter((t) => t.TABLE_NAME !== 'kernel_migrations');
  const conn = await pool.getConnection();
  try {
    // the tables point at each other, so the order would matter; switching the checks off for the wipe is
    // both faster and the only way to do it without a topological sort
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');
    // an append-only table — audit's three, finance_ledger_entries, wallet_ledger — refuses DELETE unless the
    // session says it is that table's retention purge (docs/10 §6.3). Wiping a database between test files is
    // the one other thing that deletes from one, so it says so, per table, and hands the permission back.
    for (const t of wipe) {
      await conn.query('SET @marketly_purge = ?', [t.TABLE_NAME]);
      await conn.query(`DELETE FROM \`${t.TABLE_NAME}\``);
    }
    await conn.query('SET @marketly_purge = NULL');
    for (const t of wipe) if ((t.AUTO_INCREMENT ?? 1) > 1) await conn.query(`ALTER TABLE \`${t.TABLE_NAME}\` AUTO_INCREMENT = 1`);
    await conn.query('SET FOREIGN_KEY_CHECKS = 1');
  } finally {
    conn.release();
  }
}

export interface TestMysqlOptions {
  /** Create the `kernel_*` tables (default true) */
  kernelTables?: boolean;
}

/** A store on a database of its own; `close()` empties it for the next test file in this worker slot */
export async function testMysql(o: TestMysqlOptions = {}): Promise<MysqlStore> {
  const u = baseUrl();
  const name = free.pop() ?? `t${process.env.VITEST_POOL_ID ?? process.pid}_${++made}`;
  // the first file to take this name in this run starts from nothing; the rest reuse its tables
  await createDatabase(u, name, { fresh: !prepared.has(name) });

  const pool = createPool({ ...connectionOf(u, name), connectionLimit: 8 });
  pool.on('connection', (conn) => {
    for (const sql of SESSION_SETUP) void conn.query(sql);
  });

  // a database this process did not make may hold what an earlier file in this slot left behind
  await empty(pool, name);
  const store = mysqlStore(pool, {
    onClose: async () => {
      await empty(pool, name);
      await pool.end();
      free.push(name);
    },
  });
  // The database is new to this run (dropped above), so the kernel tables are made rather than kept: a
  // `CREATE TABLE IF NOT EXISTS` over an older kernel-tables.ts would keep them without a word, which is how
  // three kernel columns that were too short for what the middleware writes went on refusing writes after
  // the DDL was fixed.
  if (o.kernelTables !== false) await store.createKernelTables();
  prepared.add(name);
  return store;
}
