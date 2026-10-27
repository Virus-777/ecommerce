/**
 * The kernel's own tables (docs/10-mysql-migration.md §12), created on a real server. The DDL is handwritten
 * rather than generated, so nothing else would catch a mistake in it.
 *
 * Two of them carry rules the rest of the kernel depends on and that are easy to get subtly wrong:
 * `kernel_jobs` must allow exactly one queued and one running row per job name while leaving finished rows
 * alone, and `kernel_rate_limits` must count and refuse in a single statement.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createConnection, type Connection } from 'mysql2/promise';
import { isDuplicateKey } from './errors.js';
import { kernelDdl, KERNEL_TABLES, PURGE_RULES } from './kernel-tables.js';
import { CONNECT_CHARSET, SESSION_COLLATION, startPortableMysql, type PortableMysql } from './portable.js';

let server: PortableMysql;
let conn: Connection;
const uuid = (n: number) => `0000000${n}`.slice(-8) + '-0000-7000-8000-000000000000';

beforeAll(async () => {
  server = await startPortableMysql({ dataDir: join(tmpdir(), 'marketly-kernel-tables-test'), port: 3396, forTests: true });
  const root = await createConnection({ host: '127.0.0.1', port: server.port, user: 'root', charset: CONNECT_CHARSET });
  await root.query('DROP DATABASE IF EXISTS kerncheck');
  await root.query('CREATE DATABASE kerncheck DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin');
  await root.end();
  conn = await createConnection({ host: '127.0.0.1', port: server.port, user: 'root', database: 'kerncheck', charset: CONNECT_CHARSET });
  await conn.query(SESSION_COLLATION);
  for (const ddl of kernelDdl()) await conn.query(ddl);
}, 180_000);

afterAll(async () => {
  await conn?.end().catch(() => undefined);
  await server?.stop();
});

describe('the kernel schema', () => {
  it('creates every table', async () => {
    const [rows] = await conn.query<any[]>("SELECT TABLE_NAME n FROM information_schema.TABLES WHERE TABLE_SCHEMA = 'kerncheck' ORDER BY TABLE_NAME");
    expect(rows.map((r) => r.n)).toEqual([...KERNEL_TABLES].sort());
  });

  it('gives every purge rule a real column to work on', async () => {
    for (const rule of PURGE_RULES) {
      const [rows] = await conn.query<any[]>(
        `SELECT COLUMN_NAME c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = 'kerncheck' AND TABLE_NAME = '${rule.table}' AND COLUMN_NAME = '${rule.column}'`,
      );
      expect(rows, `${rule.table}.${rule.column} must exist for kernel.purge-expired`).toHaveLength(1);
      // and it must be indexed, or the purge scans the table it is meant to trim
      const [idx] = await conn.query<any[]>(
        `SELECT INDEX_NAME i FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = 'kerncheck' AND TABLE_NAME = '${rule.table}' AND COLUMN_NAME = '${rule.column}' AND SEQ_IN_INDEX = 1`,
      );
      expect(idx.length, `${rule.table}.${rule.column} must lead an index`).toBeGreaterThan(0);
    }
  });
});

describe('kernel_jobs: one queued and one running per name', () => {
  const insert = (id: number, name: string, state: string) =>
    conn.query('INSERT INTO kernel_jobs (id, name, state, run_at, created_at) VALUES (?, ?, ?, NOW(3), NOW(3))', [uuid(id), name, state]);

  it('refuses a second queued row for the same job', async () => {
    await insert(1, 'catalog.reindex', 'queued');
    await expect(insert(2, 'catalog.reindex', 'queued')).rejects.toSatisfy(isDuplicateKey);
  });

  it('allows one running row beside the queued one', async () => {
    await insert(3, 'catalog.reindex', 'active');
    await expect(insert(4, 'catalog.reindex', 'active')).rejects.toSatisfy(isDuplicateKey);
  });

  it('leaves finished rows out of both keys, however many there are', async () => {
    // this is the half a partial index is for: history must not block the next run
    await insert(5, 'catalog.reindex', 'done');
    await insert(6, 'catalog.reindex', 'done');
    await insert(7, 'catalog.reindex', 'failed');
    const [rows] = await conn.query<any[]>("SELECT COUNT(*) n FROM kernel_jobs WHERE name = 'catalog.reindex'");
    expect(Number(rows[0].n)).toBe(5);
  });

  it('refuses a state outside the list', async () => {
    await expect(insert(8, 'catalog.reindex', 'sleeping')).rejects.toThrow(/Check constraint/i);
  });
});

describe('kernel_rate_limits: one statement counts and refuses', () => {
  it('counts up, and marks the window refused once it passes the limit (§12)', async () => {
    const bump = async (limit: number) => {
      await conn.query(
        'INSERT INTO kernel_rate_limits (scope, `key`, window_start, window_end, count) VALUES (?, ?, ?, ?, 1) AS new ' +
          'ON DUPLICATE KEY UPDATE count = LAST_INSERT_ID(IF(kernel_rate_limits.count < ?, kernel_rate_limits.count + 1, kernel_rate_limits.count + 1000000))',
        ['sign-in', 'a@b.c', '2026-10-27 00:00:00.000', '2026-10-27 01:00:00.000', limit],
      );
      const [[r]] = (await conn.query('SELECT LAST_INSERT_ID() v')) as any;
      return Number(r.v);
    };
    expect(await bump(3)).toBe(0); // the first insert sets no LAST_INSERT_ID
    expect(await bump(3)).toBe(2);
    expect(await bump(3)).toBe(3);
    expect(await bump(3)).toBeGreaterThan(1_000_000); // over the limit, in the same statement
  });
});
