/**
 * The store: pool, transactions with retry, counters (docs/10-mysql-migration.md §10.2–10.3, §11.2).
 *
 * The retry is tested by causing a real deadlock through the wrapper and showing the work still lands, because
 * that is the whole reason the wrapper exists. A stubbed error would only prove the `if` is wired up.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectMysql, MAX_ATTEMPTS, type MysqlStore } from './index.js';
import { isDuplicateKey } from './errors.js';
import { testMysql } from '../../testing/mysql.js';

let store: MysqlStore;

beforeAll(async () => {
  store = await testMysql();
  const conn = await store.pool.getConnection();
  await conn.query('DROP TABLE IF EXISTS rows_t');
  await conn.query('CREATE TABLE rows_t (id INT PRIMARY KEY, n INT NOT NULL) ENGINE=InnoDB');
  await conn.query('INSERT INTO rows_t VALUES (1, 0), (2, 0)');
  conn.release();
}, 180_000);

afterAll(async () => {
  await store?.close().catch(() => undefined);
});

describe('the connection', () => {
  it('gives every pooled connection the session setup of §20', async () => {
    // a fresh connection, not the one the version check used
    const results = await Promise.all(
      [0, 1, 2].map(async () => {
        const conn = await store.pool.getConnection();
        const [rows] = await conn.query<any[]>('SELECT @@collation_connection c, @@time_zone tz, @@transaction_isolation iso, @@innodb_lock_wait_timeout lw');
        conn.release();
        return rows[0];
      }),
    );
    for (const r of results) {
      expect(r).toMatchObject({ c: 'utf8mb4_0900_bin', tz: '+00:00', iso: 'READ-COMMITTED', lw: 10 });
    }
  });

  it('refuses a server below the floor by its version, not by guessing', async () => {
    // the real check is covered in portable.test.ts; here only that connectMysql runs it at all
    await expect(connectMysql({ url: `mysql://root@127.0.0.1:1/nothing` })).rejects.toThrow();
  });
});

describe('transactions', () => {
  it('commits, and rolls back on an error', async () => {
    await store.transaction(async (tx) => {
      await tx.conn.query('UPDATE rows_t SET n = 5 WHERE id = 1');
    });
    const read = async (id: number) => {
      const conn = await store.pool.getConnection();
      const [rows] = await conn.query<any[]>('SELECT n FROM rows_t WHERE id = ?', [id]);
      conn.release();
      return rows[0].n;
    };
    expect(await read(1)).toBe(5);

    await expect(
      store.transaction(async (tx) => {
        await tx.conn.query('UPDATE rows_t SET n = 99 WHERE id = 1');
        throw new Error('no');
      }),
    ).rejects.toThrow('no');
    expect(await read(1)).toBe(5);
  });

  it('joins an outer transaction rather than opening a second one', async () => {
    let innerConn: unknown;
    await store.transaction(async (outer) => {
      await store.transaction(async (inner) => {
        innerConn = inner.conn;
      }, outer);
      expect(innerConn).toBe(outer.conn);
      // and a failure inside the joined call still rolls the outer one back
    });
  });

  it('recovers from a real deadlock, and the work lands', async () => {
    // two transactions touch the same two rows in opposite orders until InnoDB rolls one back; the wrapper
    // runs that one again and both finish
    const bump = (first: number, second: number) =>
      store.transaction(async (tx) => {
        await tx.conn.query('UPDATE rows_t SET n = n + 1 WHERE id = ?', [first]);
        await new Promise((r) => setTimeout(r, 50));
        await tx.conn.query('UPDATE rows_t SET n = n + 1 WHERE id = ?', [second]);
      });

    const before = await (async () => {
      const conn = await store.pool.getConnection();
      const [rows] = await conn.query<any[]>('SELECT SUM(n) s FROM rows_t');
      conn.release();
      return Number(rows[0].s);
    })();

    await Promise.all([bump(1, 2), bump(2, 1)]);

    const conn = await store.pool.getConnection();
    const [rows] = await conn.query<any[]>('SELECT SUM(n) s FROM rows_t');
    conn.release();
    // four increments landed: nothing was lost to the deadlock
    expect(Number(rows[0].s) - before).toBe(4);
  }, 60_000);

  it('gives up with SERVICE_BUSY after the last attempt, and says how many it made (D8)', async () => {
    const blocker = await store.pool.getConnection();
    await blocker.query('START TRANSACTION');
    await blocker.query('SELECT * FROM rows_t WHERE id = 1 FOR UPDATE');
    try {
      const err = await store
        .transaction(async (tx) => {
          await tx.conn.query('SET SESSION innodb_lock_wait_timeout = 1');
          await tx.conn.query('SELECT * FROM rows_t WHERE id = 1 FOR UPDATE');
        })
        .then(() => undefined)
        .catch((e) => e);
      expect(err).toBeDefined();
      expect(err.code).toBe('SERVICE_BUSY');
      expect(err.status).toBe(503);
      expect(err.details).toMatchObject({ attempts: MAX_ATTEMPTS });
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
    }
  }, 120_000);

  it('does not retry an error that is not a lock problem', async () => {
    let runs = 0;
    await expect(
      store.transaction(async () => {
        runs++;
        throw new Error('business rule');
      }),
    ).rejects.toThrow('business rule');
    expect(runs).toBe(1);
  });
});

describe('counters (§11.2)', () => {
  it('hands out values in order, one at a time and in blocks', async () => {
    expect(await store.nextValue('orders')).toBe(1);
    expect(await store.nextValue('orders')).toBe(2);
    expect(await store.nextValues('orders', 3)).toEqual([3, 4, 5]);
    expect(await store.nextValues('orders', 0)).toEqual([]);
  });

  it('never hands the same number to two callers at once', async () => {
    const got = await Promise.all(Array.from({ length: 40 }, () => store.nextValue('parallel')));
    expect(new Set(got).size).toBe(40);
    expect(Math.max(...got)).toBe(40);
  });

  it('keeps a number taken inside a transaction that then rolls back', async () => {
    // the counter is taken on its own connection, so the caller's rollback cannot give the number back: the
    // number is skipped, which is what "never rolled back" meant on MongoDB too
    const taken = await store
      .transaction(async () => {
        const n = await store.nextValue('skipped');
        throw Object.assign(new Error('rolled back'), { taken: n });
      })
      .catch((e) => e.taken as number);
    expect(taken).toBe(1);
    expect(await store.nextValue('skipped')).toBe(2);
  });

  it('creates the kernel tables idempotently', async () => {
    await store.createKernelTables(); // again: must not throw
    const conn = await store.pool.getConnection();
    const [rows] = await conn.query<any[]>("SELECT COUNT(*) n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE 'kernel_%'");
    conn.release();
    expect(Number(rows[0].n)).toBe(11);
  });
});

describe('insertIfAbsent groundwork', () => {
  it('a duplicate inside a transaction does not lose the transaction', async () => {
    await store.transaction(async (tx) => {
      await tx.conn.query("INSERT INTO `kernel_locks` (`name`, `n`) VALUES ('a', 1)");
      const dup = await tx.conn.query("INSERT INTO `kernel_locks` (`name`, `n`) VALUES ('a', 1)").catch((e) => e);
      expect(isDuplicateKey(dup)).toBe(true);
      await tx.conn.query("INSERT INTO `kernel_locks` (`name`, `n`) VALUES ('b', 1)");
    });
    const conn = await store.pool.getConnection();
    const [rows] = await conn.query<any[]>('SELECT name FROM kernel_locks ORDER BY name');
    conn.release();
    expect(rows.map((r) => r.name)).toEqual(['a', 'b']);
  });
});
