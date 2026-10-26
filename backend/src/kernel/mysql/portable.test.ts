/**
 * The portable mysqld of docs/10-mysql-migration.md §19 (D9): the version floor, where a server is looked for,
 * and that one actually starts, serves and stops. The start test is the one that matters — everything else in
 * kernel/mysql is built on it — so it runs against the real binary rather than a stub.
 */
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { checkVersion, CONNECT_CHARSET, findMysqld, MYSQL_FLOOR, parseVersion, SESSION_COLLATION, startPortableMysql, type PortableMysql } from './portable.js';

describe('version floor (§20.1)', () => {
  it('reads a version out of what mysqld --version prints', () => {
    expect(parseVersion('mysqld.exe  Ver 8.4.13 for Win64 on x86_64 (MySQL Community Server - GPL)')).toEqual([8, 4, 13]);
    expect(parseVersion('/usr/sbin/mysqld  Ver 8.0.36-0ubuntu0.22.04.1 for Linux')).toEqual([8, 0, 36]);
    expect(parseVersion('no version here')).toBeUndefined();
  });

  it('accepts the supported range', () => {
    for (const v of ['8.0.36', '8.0.40', '8.4.0', '8.4.13', '9.1.0', '26.10.0']) {
      expect(() => checkVersion(`Ver ${v} for Win64`, 'test')).not.toThrow();
    }
  });

  it('refuses anything below the floor, and says what it found', () => {
    for (const v of ['8.0.35', '8.0.11', '5.7.44']) {
      expect(() => checkVersion(`Ver ${v}`, 'test')).toThrow(new RegExp(`${v.replace(/\./g, '\\.')}.*too old`));
    }
    expect(() => checkVersion('Ver 8.0.35', 'test')).toThrow(MYSQL_FLOOR.join('.'));
  });

  it('refuses 8.0.29 on its own, even though it is above the floor', () => {
    // it shipped a broken instant ADD COLUMN, which 17.3's automatic migrations rely on
    expect(() => checkVersion('Ver 8.0.29', 'test')).toThrow(/8\.0\.29 is not supported/);
  });

  it('explains itself rather than throwing a parse error on nonsense', () => {
    expect(() => checkVersion('', 'db-setup')).toThrow(/db-setup: could not read a MySQL version/);
  });
});

describe('finding a server', () => {
  it('refuses a MYSQLD_PATH that points at nothing', () => {
    const was = process.env.MYSQLD_PATH;
    process.env.MYSQLD_PATH = join(tmpdir(), 'no-such-mysqld');
    try {
      expect(() => findMysqld()).toThrow(/does not exist/);
    } finally {
      if (was === undefined) delete process.env.MYSQLD_PATH;
      else process.env.MYSQLD_PATH = was;
    }
  });

  it('finds the unzipped build on this machine', () => {
    const found = findMysqld();
    expect(found, 'no mysqld found: unzip MySQL 8.4 into ~/.cache/mysql').toBeTruthy();
    expect(existsSync(found!)).toBe(true);
  });
});

describe('starting one', () => {
  const dataDir = join(tmpdir(), 'marketly-portable-test');
  let server: PortableMysql | undefined;

  afterAll(async () => {
    await server?.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('initialises, serves queries, and stops cleanly', async () => {
    rmSync(dataDir, { recursive: true, force: true });
    server = await startPortableMysql({ dataDir, port: 3399, forTests: true });
    expect(server.url).toBe('mysql://root@127.0.0.1:3399');
    expect(server.version).toMatch(/^\d+\.\d+\.\d+$/);

    const { createConnection } = await import('mysql2/promise');
    const conn = await createConnection({ host: '127.0.0.1', port: 3399, user: 'root', charset: CONNECT_CHARSET });
    await conn.query(SESSION_COLLATION);
    // the session defaults of §20 are what makes this server behave like production
    const [rows] = await conn.query<any[]>(
      'SELECT @@transaction_isolation iso, @@collation_server coll, @@innodb_lock_wait_timeout lock_wait, @@innodb_rollback_on_timeout rollback, @@log_bin log_bin',
    );
    expect(rows[0]).toMatchObject({ iso: 'READ-COMMITTED', coll: 'utf8mb4_0900_bin', lock_wait: 10, rollback: 1 });
    expect(Number(rows[0].log_bin)).toBe(0); // forTests: no binary log
    await conn.end();

    await server.stop();
    server = undefined;
  }, 180_000);

  it('cannot be connected with the collation as the handshake charset, which is why SESSION_COLLATION exists', async () => {
    server = await startPortableMysql({ dataDir, port: 3399, forTests: true });
    const { createConnection } = await import('mysql2/promise');
    // the handshake carries the collation in one byte and utf8mb4_0900_bin is id 309, so this never reaches the
    // server. If this test ever stops throwing, mysql2 has grown a wider field and §10.2 can be simplified.
    await expect(createConnection({ host: '127.0.0.1', port: 3399, user: 'root', charset: 'utf8mb4_0900_bin' })).rejects.toThrow(/out of range|ERR_OUT_OF_RANGE/i);

    // the two-step form gives the session the collation that §5.2 depends on
    const conn = await createConnection({ host: '127.0.0.1', port: 3399, user: 'root', charset: CONNECT_CHARSET });
    await conn.query(SESSION_COLLATION);
    const [rows] = await conn.query<any[]>("SELECT @@collation_connection coll, ('ABC' = 'abc') AS abc_eq");
    expect(rows[0]).toMatchObject({ coll: 'utf8mb4_0900_bin', abc_eq: 0 });
    await conn.end();
    await server.stop();
    server = undefined;
  }, 180_000);

  it('reuses the data directory on a second start, without initialising again', async () => {
    server = await startPortableMysql({ dataDir, port: 3399, forTests: true });
    const { createConnection } = await import('mysql2/promise');
    const conn = await createConnection({ host: '127.0.0.1', port: 3399, user: 'root' });
    await conn.query('CREATE DATABASE IF NOT EXISTS reuse_check');
    const [dbs] = await conn.query<any[]>("SHOW DATABASES LIKE 'reuse_check'");
    expect(dbs).toHaveLength(1);
    await conn.end();
  }, 180_000);
});
