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
async function createDatabase(u: URL, name: string): Promise<void> {
  const conn = await createConnection(connectionOf(u));
  try {
    await conn.query(`CREATE DATABASE IF NOT EXISTS \`${name}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin`);
  } finally {
    await conn.end();
  }
}

/** Empties every table that has rows; the tables themselves stay, so the next file reuses them */
async function empty(pool: Pool, database: string): Promise<void> {
  // BASE TABLE only: a view has no rows of its own, and TRUNCATE on one answers "table doesn't exist"
  const [tables] = await pool.query<RowDataPacket[]>("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'", [database]);
  if (!tables.length) return;
  const conn = await pool.getConnection();
  try {
    // the tables point at each other, so the order would matter; switching the checks off for the wipe is
    // both faster and the only way to do it without a topological sort
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const t of tables) await conn.query(`TRUNCATE TABLE \`${String(t.TABLE_NAME)}\``);
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
  await createDatabase(u, name);

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
  if (o.kernelTables !== false) await store.createKernelTables();
  return store;
}
