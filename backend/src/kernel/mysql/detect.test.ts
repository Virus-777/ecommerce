/**
 * The unlocked read-modify-write detector (detect.ts, docs/10-mysql-migration.md §11.2 rule 2).
 *
 * The bug it is for leaves no trace: two transactions read 5, both write 6, and the row holds 6 instead of 7.
 * Nothing fails, so the only proof the detector works is a test that performs the losing pattern and insists it
 * is refused — and, just as important, a test for each shape that is *not* a lost update, because a detector
 * that cries wolf gets turned off and then proves nothing at all.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { testMysql } from '../../testing/mysql.js';
import type { TableDef } from '../spec/define.js';
import { beginScope, endScope, keysFromWhere, readRows, rowKey, setDetector, UnlockedReadModifyWrite, writingRows } from './detect.js';
import { inc, type ModuleStore, type MysqlStore } from './index.js';

interface Row {
  id: string;
  n: number;
  note: string | null;
}

interface Pair {
  a: string;
  b: string;
  n: number;
}

const plain = { nullable: [], decimal: [], binary: [], dates: [], json: [], booleans: [] };
const ROWS: TableDef = { table: 't_rows', key: ['id'], idColumn: 'id', columns: ['id', 'n', 'note'], ...plain, nullable: ['note'], identity: null, uniqueKeys: [{ name: 'PRIMARY', columns: ['id'] }] };
const PAIRS: TableDef = { table: 't_pairs', key: ['a', 'b'], idColumn: null, columns: ['a', 'b', 'n'], ...plain, identity: null, uniqueKeys: [{ name: 'PRIMARY', columns: ['a', 'b'] }] };

let store: MysqlStore;
let demo: ModuleStore;

/** fn in a transaction; the error it throws, instead of taking the transaction down */
const failing = (fn: (tx: ModuleStore) => Promise<unknown>): Promise<unknown> => demo.transaction(async (tx) => fn(tx).then(() => undefined, (err: unknown) => err));

beforeAll(async () => {
  store = await testMysql();
  for (const t of ['t_rows', 't_pairs']) await store.pool.query(`DROP TABLE IF EXISTS \`${t}\``);
  await store.pool.query('CREATE TABLE `t_rows` (`id` VARCHAR(16) NOT NULL, `n` INT NOT NULL, `note` VARCHAR(32) NULL, PRIMARY KEY (`id`)) ENGINE=InnoDB');
  await store.pool.query('CREATE TABLE `t_pairs` (`a` VARCHAR(16) NOT NULL, `b` VARCHAR(16) NOT NULL, `n` INT NOT NULL, PRIMARY KEY (`a`, `b`)) ENGINE=InnoDB');
  demo = store.module('demo', { rows: ROWS, pairs: PAIRS });
}, 180_000);

afterEach(async () => {
  await store.pool.query('TRUNCATE TABLE `t_rows`');
  await store.pool.query('TRUNCATE TABLE `t_pairs`');
});

afterAll(async () => {
  await store?.close();
});

const seed = (id: string, n: number) => demo.table<Row>('rows').insert({ id, n, note: null });
const nOf = async (id: string) => (await demo.table<Row>('rows').get(id))!.n;

describe('what it refuses', () => {
  it('names the row and the line that read it', async () => {
    await seed('a', 5);
    const err = await failing(async (tx) => {
      const t = tx.table<Row>('rows');
      const row = await t.get('a');
      await t.update('a', { n: row!.n + 1 });
    });

    expect(err).toBeInstanceOf(UnlockedReadModifyWrite);
    const thrown = err as UnlockedReadModifyWrite;
    expect(thrown.code).toBe('UNLOCKED_READ_MODIFY_WRITE');
    expect(thrown.table).toBe('t_rows');
    expect(thrown.id).toBe('a');
    // the file:line of the read, not of the write: the read is what has to change
    expect(thrown.site).toMatch(/detect\.test\.ts:\d+:\d+$/);
    expect(thrown.message).toContain('forUpdate');
    // and the transaction it was thrown in is rolled back, so the lost update never happened
    expect(await nOf('a')).toBe(5);
  });

  it('counts a lock taken after the read as too late', async () => {
    // updateOne finds and locks the row before writing it, but the value being written was worked out from the
    // read above it. Locking a row does not make a value read before the lock current again.
    await seed('a', 5);
    const err = await failing(async (tx) => {
      const t = tx.table<Row>('rows');
      const row = await t.get('a');
      await t.updateOne({ id: 'a' }, { n: row!.n + 1 });
    });
    expect(err).toBeInstanceOf(UnlockedReadModifyWrite);
  });

  it('follows a composite key', async () => {
    await demo.table<Pair>('pairs').insert({ a: 'x', b: 'y', n: 1 });
    const err = await failing(async (tx) => {
      const t = tx.table<Pair>('pairs');
      const [row] = await t.find({ a: 'x' });
      await t.updateMany({ a: 'x', b: 'y' }, { n: row!.n + 1 });
    });
    expect((err as UnlockedReadModifyWrite).id).toBe('x|y');
  });

  it('catches an upsert that overwrites with what it read', async () => {
    await seed('a', 5);
    const err = await failing(async (tx) => {
      const t = tx.table<Row>('rows');
      const row = await t.get('a');
      await t.upsert({ id: 'a', n: row!.n + 1, note: 'again' });
    });
    expect(err).toBeInstanceOf(UnlockedReadModifyWrite);
  });

  it('is about the row, not the table', async () => {
    await seed('a', 5);
    await seed('b', 7);
    const err = await failing(async (tx) => {
      const t = tx.table<Row>('rows');
      await t.getMany(['a', 'b']);
      await t.update('b', { n: 99 }); // read without a lock, written with a value
    });
    expect((err as UnlockedReadModifyWrite).id).toBe('b');

    const fine = await failing(async (tx) => {
      const t = tx.table<Row>('rows');
      await t.get('a');
      await t.insert({ id: 'c', n: 1, note: null });
      await t.update('c', { n: 2 }); // a row this transaction has not read unlocked
    });
    expect(fine).toBeUndefined();
    expect(await nOf('c')).toBe(2);
  });
});

describe('what it allows', () => {
  it('a locked read', async () => {
    await seed('a', 5);
    const err = await failing(async (tx) => {
      const t = tx.table<Row>('rows');
      const row = await t.get('a', { forUpdate: true });
      await t.update('a', { n: row!.n + 1 });
    });
    expect(err).toBeUndefined();
    expect(await nOf('a')).toBe(6);
  });

  it('an expression, which the server computes from the stored row', async () => {
    await seed('a', 5);
    const err = await failing(async (tx) => {
      const t = tx.table<Row>('rows');
      await t.get('a');
      await t.update('a', { n: inc('n', 1) });
    });
    expect(err).toBeUndefined();
    expect(await nOf('a')).toBe(6);
  });

  it('increment, whose upsert adds rather than overwrites', async () => {
    await demo.table<Pair>('pairs').insert({ a: 'x', b: 'y', n: 1 });
    const err = await failing(async (tx) => {
      const t = tx.table<Pair>('pairs');
      await t.find({ a: 'x' });
      await t.increment({ a: 'x', b: 'y' }, { n: 2 });
    });
    expect(err).toBeUndefined();
    expect((await demo.table<Pair>('pairs').findOne({ a: 'x', b: 'y' }))!.n).toBe(3);
  });

  it('a row this transaction inserted, which it holds until it commits', async () => {
    const err = await failing(async (tx) => {
      const t = tx.table<Row>('rows');
      await t.insert({ id: 'a', n: 1, note: null });
      const row = await t.get('a');
      await t.update('a', { n: row!.n + 1 });
    });
    expect(err).toBeUndefined();
    expect(await nOf('a')).toBe(2);
  });

  it('a transaction serialised on lock(name)', async () => {
    // rule 5: every writer of these rows takes the same name, so the read-modify-write is deliberate
    await seed('a', 5);
    const err = await failing(async (tx) => {
      await tx.lock('rows');
      const t = tx.table<Row>('rows');
      const row = await t.get('a');
      await t.update('a', { n: row!.n + 1 });
    });
    expect(err).toBeUndefined();
    expect(await nOf('a')).toBe(6);
  });

  it('a read and a write with no transaction around them', async () => {
    // not because it is safe — three of the four worst cases the census found are exactly this — but because
    // there is no transaction to remember the read in. Those are found by reading the code (Appendix C).
    await seed('a', 5);
    const t = demo.table<Row>('rows');
    const row = await t.get('a');
    await t.update('a', { n: row!.n + 1 });
    expect(await nOf('a')).toBe(6);
  });

  it('a write whose filter names no row in particular', async () => {
    // the other blind spot: without the primary key in the filter there is no row to match the read against
    await seed('a', 5);
    const err = await failing(async (tx) => {
      const t = tx.table<Row>('rows');
      await t.get('a');
      await t.updateMany({ note: null }, { n: 99 });
    });
    expect(err).toBeUndefined();
  });

  it('anything at all once it is switched off', async () => {
    await seed('a', 5);
    const was = setDetector(false);
    try {
      const err = await failing(async (tx) => {
        const t = tx.table<Row>('rows');
        const row = await t.get('a');
        await t.update('a', { n: row!.n + 1 });
      });
      expect(err).toBeUndefined();
      expect(await nOf('a')).toBe(6);
    } finally {
      setDetector(was);
    }
  });
});

describe('the memory of one transaction', () => {
  const conn = {} as object;
  const key = rowKey('t_rows', ['a']);

  afterEach(() => endScope(conn));

  it('starts empty, however the transaction before it ended', () => {
    // a pooled connection is handed to the next transaction; a scope that outlived its own would accuse it of
    // what the one before read
    beginScope(conn);
    readRows(conn, [key], false);
    beginScope(conn);
    expect(() => writingRows(conn, 't_rows', [key])).not.toThrow();
  });

  it('is gone when the transaction is', () => {
    beginScope(conn);
    readRows(conn, [key], false);
    endScope(conn);
    expect(() => writingRows(conn, 't_rows', [key])).not.toThrow();
  });

  it('remembers where the read was, not where the write is', () => {
    beginScope(conn);
    readRows(conn, [key], false);
    try {
      writingRows(conn, 't_rows', [key]);
      expect.unreachable('the write should have been refused');
    } catch (err) {
      expect((err as UnlockedReadModifyWrite).site).toMatch(/detect\.test\.ts:\d+:\d+$/);
    }
  });
});

describe('the rows a filter names', () => {
  it('one row, a list of rows, or every column of a composite key', () => {
    expect(keysFromWhere('t', ['id'], { id: 'a' })).toEqual([rowKey('t', ['a'])]);
    expect(keysFromWhere('t', ['id'], { id: ['a', 'b'] })).toEqual([rowKey('t', ['a']), rowKey('t', ['b'])]);
    expect(keysFromWhere('t', ['a', 'b'], { a: 'x', b: 'y', n: 3 })).toEqual([rowKey('t', ['x', 'y'])]);
  });

  it('nothing it cannot be sure of', () => {
    expect(keysFromWhere('t', ['id'], { status: 'open' })).toBeUndefined(); // the key is not in the filter
    expect(keysFromWhere('t', ['id'], { id: { op: '<', value: 'm' } })).toBeUndefined(); // a range, not a row
    expect(keysFromWhere('t', ['id'], { id: 'a', or: [{ id: 'b' }] })).toBeUndefined(); // or: more rows than it says
    expect(keysFromWhere('t', ['a', 'b'], { a: 'x' })).toBeUndefined(); // half a composite key is a range too
    expect(keysFromWhere('t', ['a', 'b'], { a: ['x', 'y'], b: 'z' })).toBeUndefined();
  });
});
