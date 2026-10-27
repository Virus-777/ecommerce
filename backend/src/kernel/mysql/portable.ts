/**
 * A private `mysqld` for development without `MYSQL_URL` and for the test run (docs/10-mysql-migration.md §19, D9).
 * It is the MySQL counterpart of what mongodb-memory-server did: no installed service, no Windows service, nothing
 * to configure. The first run initialises a data directory; later runs reuse it.
 *
 * Where a server is looked for, in order:
 *   1. `MYSQLD_PATH`, when the owner points at one (this is also how the 8.0 and 8.4 test runs of §20.1 are made);
 *   2. an unzipped build under `~/.cache/mysql/<dir>/bin/mysqld` — the offline form: copy the zip across once;
 *   3. an installed server (`C:\Program Files\MySQL\MySQL Server <v>\bin`, or /usr/sbin on Linux).
 * The newest version wins where several are found.
 *
 * With `MYSQL_URL` (development) or `TEST_MYSQL_URL` (tests) set, none of this runs: the installed server is used.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'mysql2/promise';

/** The oldest server the backend supports, and the one release inside the range that is refused (§20.1) */
export const MYSQL_FLOOR = [8, 0, 36] as const;
export const MYSQL_REFUSED = '8.0.29';

/**
 * The charset a connection is opened with, and the collation it is then set to.
 *
 * These cannot be one step. The handshake carries the collation as a **single byte**, and `utf8mb4_0900_bin` has
 * id **309**, so `charset: 'utf8mb4_0900_bin'` — what §10.2 first asked for — makes mysql2 throw
 * `ERR_OUT_OF_RANGE` before it ever reaches the server. (`utf8mb4_0900_ai_ci` is 255 and fits, which is why the
 * default never shows the problem.) So: connect with `utf8mb4`, then set the session collation with a statement.
 * Every connection must run {@link SESSION_COLLATION}, or string literals compare case-insensitively and the
 * comparison rules of §5.2 quietly do not apply to them.
 */
export const CONNECT_CHARSET = 'utf8mb4';
export const SESSION_COLLATION = 'SET NAMES utf8mb4 COLLATE utf8mb4_0900_bin';

/**
 * The options every mysql2 connection is opened with — the pool, the tools and the tests alike, for the same
 * reason the charset constants live here: a connection that differs in any of them reads and writes different
 * values from the same bytes.
 *
 * `timezone: 'Z'` is the one that would have bitten hardest, and a round trip cannot see it. mysql2 turns a JS
 * Date into a DATETIME **in the host's local time** and reads it back the same way, so one connection always
 * agrees with itself. What is stored does not: on this machine (UTC+9) a 12:00Z timestamp was written as 21:00 —
 * nine hours in the future to `NOW()`, to every date function and to every report that groups by day, because
 * the session is `time_zone = '+00:00'` (§10.2). And two connections that disagree about the host's offset
 * disagree about the value: with `'Z'` that same row read back as 21:00Z. Found on 2026-10-27 by storing one
 * timestamp and printing `DATE_FORMAT` of it beside the Date.
 */
export const CLIENT_OPTIONS = {
  charset: CONNECT_CHARSET,
  /** Send and read DATETIME as UTC, whatever the host's offset is */
  timezone: 'Z',
  /** A DATE stays 'YYYY-MM-DD'; a DATETIME(3) becomes a Date (§10.2) */
  dateStrings: ['DATE'] as ('DATE')[],
  supportBigNumbers: true,
  /** DECIMAL stays exact, as a string, which is the shape the spec gives `numeric` columns */
  decimalNumbers: false,
  namedPlaceholders: false,
  multipleStatements: false,
};

const EXE = process.platform === 'win32' ? 'mysqld.exe' : 'mysqld';

/** "…Ver 8.4.13 for Win64…" → [8, 4, 13] */
export function parseVersion(text: string): [number, number, number] | undefined {
  const m = /\b(\d+)\.(\d+)\.(\d+)\b/.exec(text);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

const atLeast = (v: readonly [number, number, number], floor: readonly [number, number, number]) =>
  v[0] !== floor[0] ? v[0] > floor[0] : v[1] !== floor[1] ? v[1] > floor[1] : v[2] >= floor[2];

/**
 * Refuses a server outside the supported range, naming what was found (§20.1). 8.0 before 8.0.36 is too old for
 * the DDL this schema needs; 8.0.29 shipped a broken instant ADD COLUMN and is refused on its own.
 */
export function checkVersion(version: string, where: string): [number, number, number] {
  const v = parseVersion(version);
  if (!v) throw new Error(`${where}: could not read a MySQL version from "${version}"`);
  const text = v.join('.');
  if (text === MYSQL_REFUSED) throw new Error(`${where}: MySQL ${text} is not supported (its instant ADD COLUMN is broken); use 8.0.36 or later, or 8.4 LTS`);
  if (!atLeast(v, MYSQL_FLOOR)) throw new Error(`${where}: MySQL ${text} is too old; this backend needs ${MYSQL_FLOOR.join('.')} or later, or 8.4 LTS`);
  return v;
}

/** Directory names sorted newest-version first, so 8.4.13 wins over 8.0.36 */
const newestFirst = (names: string[]) => [...names].sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));

/** The mysqld this machine should use, or undefined when there is none */
export function findMysqld(): string | undefined {
  const fromEnv = process.env.MYSQLD_PATH;
  if (fromEnv) {
    if (!existsSync(fromEnv)) throw new Error(`MYSQLD_PATH is set to ${fromEnv}, which does not exist`);
    return fromEnv;
  }
  const cache = join(homedir(), '.cache', 'mysql');
  if (existsSync(cache)) {
    const unzipped = newestFirst(readdirSync(cache))
      .map((d) => join(cache, d, 'bin', EXE))
      .find((p) => existsSync(p));
    if (unzipped) return unzipped;
  }
  if (process.platform === 'win32') {
    const root = join(process.env.ProgramFiles ?? 'C:\\Program Files', 'MySQL');
    if (!existsSync(root)) return undefined;
    return newestFirst(readdirSync(root))
      .map((d) => join(root, d, 'bin', EXE))
      .find((p) => existsSync(p));
  }
  return ['/usr/sbin/mysqld', '/usr/local/mysql/bin/mysqld', '/opt/homebrew/opt/mysql/bin/mysqld'].find((p) => existsSync(p));
}

/** basedir is the unpacked server root: the directory above bin/ */
const basedirOf = (mysqld: string) => join(mysqld, '..', '..');

function run(exe: string, args: string[]): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(exe, args, { windowsHide: true });
    let output = '';
    p.stdout.on('data', (d) => (output += String(d)));
    p.stderr.on('data', (d) => (output += String(d)));
    p.on('error', reject);
    p.on('close', (code) => resolve({ code: code ?? 0, output }));
  });
}

export interface PortableMysql {
  /** mysql://root@127.0.0.1:<port> — no database, no password */
  readonly url: string;
  readonly port: number;
  readonly version: string;
  stop(): Promise<void>;
}

export interface PortableOptions {
  /** Where the server keeps its data; reused between runs */
  dataDir: string;
  port?: number;
  /** Test servers trade durability for speed: no binary log, no fsync per commit */
  forTests?: boolean;
}

/**
 * Starts a private server and answers once it accepts connections. The session defaults match §20 so that code
 * developed against this server behaves as it will in production: READ COMMITTED, utf8mb4_0900_bin, a 10 s lock
 * wait, and `innodb_rollback_on_timeout` — §10.3's retry assumes a timeout rolls the whole transaction back.
 */
export async function startPortableMysql(o: PortableOptions): Promise<PortableMysql> {
  const mysqld = findMysqld();
  if (!mysqld) {
    throw new Error(
      'No mysqld found. Unzip a MySQL 8.4 LTS "ZIP Archive" into ~/.cache/mysql (so that ~/.cache/mysql/<dir>/bin/mysqld exists), ' +
        'or set MYSQLD_PATH, or point MYSQL_URL / TEST_MYSQL_URL at an installed server.',
    );
  }
  const basedir = basedirOf(mysqld);
  const port = o.port ?? Number(process.env.MYSQL_PORT ?? 3307);
  const data = join(o.dataDir, 'd');

  const version = (await run(mysqld, ['--version'])).output;
  checkVersion(version, mysqld);

  if (!existsSync(join(data, 'mysql'))) {
    mkdirSync(o.dataDir, { recursive: true });
    const init = await run(mysqld, ['--initialize-insecure', `--basedir=${basedir}`, `--datadir=${data}`]);
    if (init.code !== 0) throw new Error(`mysqld --initialize-insecure failed (${init.code}):\n${init.output.slice(-2000)}`);
  }

  const args = [
    `--basedir=${basedir}`,
    `--datadir=${data}`,
    `--port=${port}`,
    '--bind-address=127.0.0.1',
    `--pid-file=${join(o.dataDir, 'mysqld.pid')}`,
    `--log-error=${join(o.dataDir, 'error.log')}`,
    '--mysqlx=0', // the X plugin would take another port (33060) for nothing
    '--character-set-server=utf8mb4',
    '--collation-server=utf8mb4_0900_bin',
    '--transaction-isolation=READ-COMMITTED',
    '--innodb-lock-wait-timeout=10',
    '--innodb-rollback-on-timeout=ON',
    '--sql-mode=ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION',
    ...(o.forTests ? ['--skip-log-bin', '--innodb-flush-log-at-trx-commit=2'] : []),
  ];
  const child = spawn(mysqld, args, { windowsHide: true, stdio: 'ignore', detached: false });
  // captured at spawn, not in stop(): registering the listener later can miss an exit that already happened
  const exited = new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once('exit', () => resolve());
  });

  const url = `mysql://root@127.0.0.1:${port}`;
  const started = Date.now();
  let lastError: unknown;
  // mysqld accepts TCP a moment before it will answer a query, so readiness is a successful SELECT
  while (Date.now() - started < 60_000) {
    try {
      const conn = await createConnection({ host: '127.0.0.1', port, user: 'root', charset: CONNECT_CHARSET, connectTimeout: 2000 });
      await conn.query(SESSION_COLLATION);
      await conn.query('SELECT 1');
      await conn.end();
      lastError = undefined;
      break;
    } catch (err) {
      lastError = err;
      if (child.exitCode !== null) throw new Error(`mysqld exited with ${child.exitCode}; see ${join(o.dataDir, 'error.log')}`);
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  if (lastError) {
    child.kill();
    throw new Error(`mysqld did not become ready on port ${port}: ${String(lastError)}`);
  }

  return {
    url,
    port,
    version: (parseVersion(version) ?? []).join('.'),
    /**
     * Stops the server and does not answer until the process has gone.
     *
     * Waiting for the port to stop answering is **not** enough: mysqld closes its listener before it finishes
     * closing InnoDB, so a second server started in that window fails with `ibdata1 must be writable`. The
     * caller's next move is usually exactly that — start another server on the same data directory — so what we
     * wait for is the child's `exit`, plus a moment for Windows to release the file handles.
     */
    async stop() {
      try {
        const conn = await createConnection({ host: '127.0.0.1', port, user: 'root', charset: CONNECT_CHARSET, connectTimeout: 2000 });
        // the SHUTDOWN statement lets InnoDB close cleanly, so the next start needs no crash recovery
        await conn.query('SHUTDOWN').catch(() => undefined);
        await conn.end().catch(() => undefined);
      } catch {
        // already gone, or never came up
      }
      // The loser of each race below is a timer nobody clears, so both are unref'd. A pending 30 s timer
      // holds the process open long after the work is done, which in the test run reads as "something
      // prevents N Vite servers from exiting" — found by vitest's hanging-process reporter on 2026-10-27.
      const after = <T>(ms: number, value: T) =>
        new Promise<T>((r) => {
          setTimeout(() => r(value), ms).unref();
        });
      if ((await Promise.race([exited.then(() => 'exited' as const), after(30_000, 'timeout' as const)])) === 'timeout') {
        child.kill();
        await Promise.race([exited, after(5_000, undefined)]);
      }
      await new Promise((r) => setTimeout(r, 300));
    },
  };
}
