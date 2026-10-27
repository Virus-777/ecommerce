/**
 * The error classifier (docs/10-mysql-migration.md §10.1), checked against errors a real MySQL produced rather
 * than against objects shaped by hand — the point of the file is to recognise what the server actually sends,
 * and a hand-made `{ errno: 1213 }` proves nothing about that.
 *
 * It also pins the three behaviours the transaction wrapper is built on: a duplicate key costs only its
 * statement, a deadlock rolls one side back, and a lock wait timeout rolls the whole transaction back.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Connection, PoolConnection } from 'mysql2/promise';
import {
  duplicateKeyName,
  isCheckViolation,
  isConnectionLost,
  isDeadlock,
  isDuplicateKey,
  isForeignKeyViolation,
  isLockTimeout,
  isRetryable,
  isValueTooLong,
} from './errors.js';
import { testMysql } from '../../testing/mysql.js';
import type { MysqlStore } from './index.js';

let store: MysqlStore;
let conn: PoolConnection;
const open = (): Promise<PoolConnection> => store.pool.getConnection();
/** Runs sql and answers the error it raised, or undefined */
const errorOf = async (c: Connection, sql: string): Promise<unknown> => {
  try {
    await c.query(sql);
    return undefined;
  } catch (err) {
    return err;
  }
};

beforeAll(async () => {
  store = await testMysql({ kernelTables: false });
  conn = await open();
  // the database is reused by the next test file in this worker slot, so make the tables from nothing
  for (const t of ['children', 'parents', 'narrow', 'named']) await conn.query(`DROP TABLE IF EXISTS \`${t}\``);
  await conn.query("CREATE TABLE parents (id CHAR(36) PRIMARY KEY, status VARCHAR(16) NOT NULL, CONSTRAINT ck CHECK (status IN ('a','b'))) ENGINE=InnoDB");
  await conn.query('CREATE TABLE children (id CHAR(36) PRIMARY KEY, parent_id CHAR(36) NOT NULL, CONSTRAINT fk FOREIGN KEY (parent_id) REFERENCES parents (id)) ENGINE=InnoDB');
  await conn.query("CREATE TABLE narrow (id INT PRIMARY KEY, code VARCHAR(4) NOT NULL) ENGINE=InnoDB");
  await conn.query("CREATE TABLE named (id INT PRIMARY KEY, slug VARCHAR(32) NOT NULL, UNIQUE KEY uq_named_slug (slug)) ENGINE=InnoDB");
}, 180_000);

afterAll(async () => {
  conn?.release();
  await store?.close();
});

describe('what the server actually sends', () => {
  it('recognises a duplicate key, and names the key that refused it', async () => {
    await conn.query("INSERT INTO named VALUES (1, 'one')");
    const err = await errorOf(conn, "INSERT INTO named VALUES (2, 'one')");
    expect(isDuplicateKey(err)).toBe(true);
    expect(duplicateKeyName(err)).toBe('uq_named_slug'); // the table prefix is stripped
    expect(isRetryable(err)).toBe(false); // a duplicate is an answer, not something to retry
  });

  it('recognises a CHECK violation', async () => {
    const err = await errorOf(conn, "INSERT INTO parents VALUES ('p1', 'nope')");
    expect(isCheckViolation(err)).toBe(true);
  });

  it('recognises both directions of a foreign key', async () => {
    await conn.query("INSERT INTO parents VALUES ('p1', 'a')");
    const orphan = await errorOf(conn, "INSERT INTO children VALUES ('c1', 'missing')");
    expect(isForeignKeyViolation(orphan)).toBe(true);
    await conn.query("INSERT INTO children VALUES ('c1', 'p1')");
    const stillUsed = await errorOf(conn, "DELETE FROM parents WHERE id = 'p1'");
    expect(isForeignKeyViolation(stillUsed)).toBe(true);
  });

  it('recognises a value that does not fit, which STRICT_TRANS_TABLES makes an error', async () => {
    const err = await errorOf(conn, "INSERT INTO narrow VALUES (1, 'far too long')");
    expect(isValueTooLong(err)).toBe(true);
  });

  it('does not mistake an ordinary error for a lost connection', async () => {
    const err = await errorOf(conn, 'SELECT * FROM no_such_table');
    expect(isConnectionLost(err)).toBe(false);
    expect(isRetryable(err)).toBe(false);
  });
});

describe('the three behaviours the transaction wrapper rests on', () => {
  it('a duplicate key costs only its own statement (§25)', async () => {
    await conn.query('START TRANSACTION');
    await conn.query("INSERT INTO named VALUES (10, 'ten')");
    expect(isDuplicateKey(await errorOf(conn, "INSERT INTO named VALUES (11, 'ten')"))).toBe(true);
    await conn.query("INSERT INTO named VALUES (12, 'twelve')"); // the transaction is still usable
    await conn.query('COMMIT');
    const [rows] = await conn.query<any[]>('SELECT id FROM named WHERE id IN (10, 11, 12) ORDER BY id');
    expect(rows.map((r) => r.id)).toEqual([10, 12]);
  });

  it('a lock wait timeout rolls the whole transaction back, so re-running fn is safe (§10.3)', async () => {
    const other = await open();
    await conn.query("INSERT INTO named VALUES (20, 'twenty')");
    await conn.query('START TRANSACTION');
    await conn.query('SELECT * FROM named WHERE id = 20 FOR UPDATE');

    await other.query('SET SESSION innodb_lock_wait_timeout = 1');
    await other.query('START TRANSACTION');
    await other.query("INSERT INTO named VALUES (21, 'twentyone')"); // work that must not survive the timeout
    const err = await errorOf(other, 'SELECT * FROM named WHERE id = 20 FOR UPDATE');
    expect(isLockTimeout(err)).toBe(true);
    expect(isRetryable(err)).toBe(true);

    await conn.query('ROLLBACK');
    await other.query('ROLLBACK').catch(() => undefined);
    const [rows] = await conn.query<any[]>('SELECT id FROM named WHERE id = 21');
    expect(rows, 'innodb_rollback_on_timeout must discard the whole transaction').toHaveLength(0);
    other.release();
  }, 60_000);

  it('a deadlock is reported to one side, and it is retryable', async () => {
    const a = await open();
    const b = await open();
    await conn.query("INSERT INTO named VALUES (30, 'thirty'), (31, 'thirtyone')");
    await a.query('START TRANSACTION');
    await b.query('START TRANSACTION');
    await a.query('SELECT * FROM named WHERE id = 30 FOR UPDATE');
    await b.query('SELECT * FROM named WHERE id = 31 FOR UPDATE');
    // each now reaches for the row the other holds: InnoDB picks a victim
    const [aErr, bErr] = await Promise.all([errorOf(a, 'SELECT * FROM named WHERE id = 31 FOR UPDATE'), errorOf(b, 'SELECT * FROM named WHERE id = 30 FOR UPDATE')]);
    const victim = [aErr, bErr].find((e) => e !== undefined);
    expect(victim, 'one side must be rolled back').toBeDefined();
    expect(isDeadlock(victim)).toBe(true);
    expect(isRetryable(victim)).toBe(true);
    await a.query('ROLLBACK').catch(() => undefined);
    await b.query('ROLLBACK').catch(() => undefined);
    a.release();
    b.release();
  }, 60_000);
});
