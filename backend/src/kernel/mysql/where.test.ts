/**
 * Where → SQL (docs/10-mysql-migration.md §10.5). Every condition is checked twice: the SQL it produces, and
 * **the rows a real server returns for it**.
 *
 * The second half is the one that matters. These conditions were written with SQL's reading of null, and the
 * ways MySQL and MongoDB disagree are all silent — a wrong translation returns the wrong rows and raises
 * nothing. So the table below has a null in every column and each test says which ids should come back.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createConnection, type Connection } from 'mysql2/promise';
import { allMembersOf, contains, equalsIgnoringCase, memberOf, startsWith, whereClause, whereSql, type Where } from './where.js';
import { CONNECT_CHARSET, SESSION_COLLATION, startPortableMysql, type PortableMysql } from './portable.js';

interface Row {
  id: number;
  status: string | null;
  n: number | null;
  name: string | null;
}

let server: PortableMysql;
let conn: Connection;

/** The ids a Where selects, in order */
async function ids(where: Where<Row> & { or?: Where<Row>[] }): Promise<number[]> {
  const w = whereClause(where);
  const [rows] = await conn.query<any[]>(`SELECT id FROM t ${w.sql} ORDER BY id`, w.params);
  return rows.map((r) => r.id);
}

beforeAll(async () => {
  server = await startPortableMysql({ dataDir: join(tmpdir(), 'marketly-where-test'), port: 3394, forTests: true });
  const root = await createConnection({ host: '127.0.0.1', port: server.port, user: 'root', charset: CONNECT_CHARSET });
  await root.query('DROP DATABASE IF EXISTS wherecheck');
  await root.query('CREATE DATABASE wherecheck DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin');
  await root.end();
  conn = await createConnection({ host: '127.0.0.1', port: server.port, user: 'root', database: 'wherecheck', charset: CONNECT_CHARSET });
  await conn.query(SESSION_COLLATION);
  await conn.query('CREATE TABLE t (id INT PRIMARY KEY, status VARCHAR(16) NULL, n INT NULL, name VARCHAR(64) NULL, tags JSON NULL) ENGINE=InnoDB');
  await conn.query(
    `INSERT INTO t (id, status, n, name, tags) VALUES
      (1, 'open',   10, 'Alice',  JSON_ARRAY('a','b')),
      (2, 'closed', 20, 'bob',    JSON_ARRAY('b')),
      (3, NULL,     30, 'Café',   JSON_ARRAY('c')),
      (4, 'open',   NULL, NULL,   JSON_ARRAY('a','c')),
      (5, 'held',   40, 'ALICE',  NULL)`,
  );
}, 180_000);

afterAll(async () => {
  await conn?.end().catch(() => undefined);
  await server?.stop();
});

describe('the SQL it writes', () => {
  it('ANDs the columns and binds every value', () => {
    const w = whereSql<Row>({ status: 'open', n: 10 });
    expect(w.sql).toBe('`status` = ? AND `n` = ?');
    expect(w.params).toEqual(['open', 10]);
  });

  it('writes an empty Where as everything, and an empty clause', () => {
    expect(whereSql<Row>({}).sql).toBe('1 = 1');
    expect(whereClause<Row>({}).sql).toBe('');
    expect(whereClause<Row>(undefined).sql).toBe('');
  });

  it('never puts a value in the SQL text', () => {
    const w = whereSql<Row>({ name: "O'Brien; DROP TABLE t" });
    expect(w.sql).toBe('`name` = ?');
    expect(w.params).toEqual(["O'Brien; DROP TABLE t"]);
  });

  it('quotes a column that is a reserved word', () => {
    expect(whereSql({ condition: 'new' } as never).sql).toBe('`condition` = ?');
  });

  it('refuses an operator it does not know rather than ignoring it', () => {
    expect(() => whereSql({ n: { op: '≈', value: 1 } } as never)).toThrow(/unsupported condition/);
  });
});

describe('the rows a real server returns', () => {
  it('equality, and null as IS NULL', async () => {
    expect(await ids({ status: 'open' })).toEqual([1, 4]);
    expect(await ids({ status: null })).toEqual([3]);
  });

  it('a list is IN, ignoring nulls in it; an empty list matches nothing', async () => {
    expect(await ids({ status: ['open', 'held'] })).toEqual([1, 4, 5]);
    expect(await ids({ status: ['open', null] as never })).toEqual([1, 4]);
    expect(await ids({ status: [] })).toEqual([]);
  });

  it('<> skips the null row — the difference from MongoDB $ne', async () => {
    // id 3 has status NULL and must NOT come back
    expect(await ids({ status: { op: '<>', value: 'open' } })).toEqual([2, 5]);
    expect(await ids({ status: { op: '<>', value: null } })).toEqual([]);
  });

  it('`is not` is "is distinct from", so it keeps the null row', async () => {
    // the mirror of the test above: here id 3 MUST come back
    expect(await ids({ status: { op: 'is not', value: 'open' } })).toEqual([2, 3, 5]);
    expect(await ids({ status: { op: 'is not', value: null } })).toEqual([1, 2, 4, 5]);
  });

  it('`not in` skips nulls; an empty list filters nothing; a list holding null matches nothing', async () => {
    expect(await ids({ status: { op: 'not in', value: ['open'] } })).toEqual([2, 5]);
    expect(await ids({ status: { op: 'not in', value: [] } })).toEqual([1, 2, 3, 4, 5]);
    expect(await ids({ status: { op: 'not in', value: ['open', null] } })).toEqual([]);
  });

  it('comparisons and between, and null bounds matching nothing', async () => {
    expect(await ids({ n: { op: '>', value: 20 } })).toEqual([3, 5]);
    expect(await ids({ n: { op: '<=', value: 20 } })).toEqual([1, 2]);
    expect(await ids({ n: { op: 'between', value: [20, 30] } })).toEqual([2, 3]);
    expect(await ids({ n: { op: '>', value: null } })).toEqual([]);
    expect(await ids({ n: { op: 'between', value: [null, 30] } })).toEqual([]);
  });

  it('like is a whole-string, case-sensitive pattern', async () => {
    expect(await ids({ name: { op: 'like', value: 'Ali%' } })).toEqual([1]);
    expect(await ids({ name: { op: 'like', value: '%li%' } })).toEqual([1]);
    expect(await ids({ name: { op: 'like', value: null } })).toEqual([]);
  });

  it('ANDs columns and ORs the alternatives', async () => {
    expect(await ids({ status: 'open', n: 10 })).toEqual([1]);
    expect(await ids({ or: [{ status: 'held' }, { n: 10 }] })).toEqual([1, 5]);
    expect(await ids({ n: { op: '>=', value: 10 }, or: [{ status: 'held' }, { status: 'closed' }] })).toEqual([2, 5]);
    expect(await ids({ or: [] })).toEqual([]);
  });
});

describe('the search-box helpers', () => {
  const rows = async (frag: { sql: string; params: unknown[] }) => {
    const [r] = await conn.query<any[]>(`SELECT id FROM t WHERE ${frag.sql} ORDER BY id`, frag.params);
    return r.map((x: any) => x.id);
  };

  it('contains and startsWith ignore case but not accents (§5.2)', async () => {
    expect(await rows(contains('name', 'ali'))).toEqual([1, 5]); // Alice and ALICE
    expect(await rows(startsWith('name', 'bo'))).toEqual([2]);
    expect(await rows(contains('name', 'cafe'))).toEqual([]); // 'Café' has an accent: as_ci keeps it distinct
    expect(await rows(contains('name', 'café'))).toEqual([3]);
  });

  it('treats a typed % or _ as the character, not as a pattern', async () => {
    await conn.query("INSERT INTO t (id, name) VALUES (6, '100% wool'), (7, 'a_b')");
    try {
      expect(await rows(contains('name', '100%'))).toEqual([6]);
      expect(await rows(contains('name', 'a_b'))).toEqual([7]);
      // without escaping, 'a_b' would also match 'axb'; prove the underscore is literal
      await conn.query("INSERT INTO t (id, name) VALUES (8, 'axb')");
      expect(await rows(contains('name', 'a_b'))).toEqual([7]);
    } finally {
      await conn.query('DELETE FROM t WHERE id IN (6, 7, 8)');
    }
  });

  it('equalsIgnoringCase matches the whole value', async () => {
    expect(await rows(equalsIgnoringCase('name', 'alice'))).toEqual([1, 5]);
  });

  it('memberOf and allMembersOf read a JSON array (§8.1)', async () => {
    expect(await rows(memberOf('tags', 'a'))).toEqual([1, 4]);
    expect(await rows(allMembersOf('tags', ['a', 'b']))).toEqual([1]);
    expect(await rows(allMembersOf('tags', ['a', 'c']))).toEqual([4]);
  });
});
