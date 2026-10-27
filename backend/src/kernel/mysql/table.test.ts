/**
 * `Table<R>` against a real server (docs/10-mysql-migration.md §10.4).
 *
 * Reading this file cannot tell you whether the SQL is right; only the server can, and several of the things that
 * change between MongoDB and MySQL are silent when they are wrong — a timestamp nine hours out, a lost update, a
 * duplicate key that takes the transaction down with it. So every test here writes rows and reads them back, and
 * the ones at the end do it from two connections at once, because that is the only way to see a lock.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createConnection, type PoolConnection } from 'mysql2/promise';
import { connectMysql, type MysqlStore } from './index.js';
import { isLockTimeout } from './errors.js';
import { CLIENT_OPTIONS, startPortableMysql, type PortableMysql } from './portable.js';
import { Table, decToZero, inc, jsonAppend, raw, type TableContext } from './table.js';
import type { TableDef } from '../spec/define.js';
import { toPageRequest } from '../lib/pagination.js';

interface Item {
  id: number;
  sku: string;
  name: string | null;
  status: string;
  qty: number;
  price: string;
  tags: string[] | null;
  active: boolean;
  at: Date | null;
  day: string | null;
  digest: Uint8Array | null;
}

const ITEMS: TableDef = {
  table: 't_items',
  key: ['id'],
  idColumn: 'id',
  columns: ['id', 'sku', 'name', 'status', 'qty', 'price', 'tags', 'active', 'at', 'day', 'digest'],
  nullable: ['name', 'tags', 'at', 'day', 'digest'],
  decimal: ['price'],
  binary: ['digest'],
  dates: ['at'],
  json: ['tags'],
  booleans: ['active'],
  identity: 'id',
  uniqueKeys: [
    { name: 'PRIMARY', columns: ['id'] },
    { name: 'uq_items_sku', columns: ['sku'] },
  ],
};

interface Usage {
  owner: string;
  day: string;
  n: number;
  bytes: number;
  note: string | null;
}

/** A composite key and nothing else unique: the table `increment` and the one-statement upsert are for */
const USAGE: TableDef = {
  table: 't_usage',
  key: ['owner', 'day'],
  idColumn: null,
  columns: ['owner', 'day', 'n', 'bytes', 'note'],
  nullable: ['note'],
  decimal: [],
  binary: [],
  dates: [],
  json: [],
  booleans: [],
  identity: null,
  uniqueKeys: [{ name: 'PRIMARY', columns: ['owner', 'day'] }],
};

interface Person {
  id: number;
  email: string;
  phone: string;
  name: string;
}

/** Two unique keys besides nothing else: the table the one-statement upsert must refuse to use */
const PEOPLE: TableDef = {
  table: 't_people',
  key: ['id'],
  idColumn: 'id',
  columns: ['id', 'email', 'phone', 'name'],
  nullable: [],
  decimal: [],
  binary: [],
  dates: [],
  json: [],
  booleans: [],
  identity: 'id',
  uniqueKeys: [
    { name: 'PRIMARY', columns: ['id'] },
    { name: 'uq_people_email', columns: ['email'] },
    { name: 'uq_people_phone', columns: ['phone'] },
  ],
};

let server: PortableMysql;
let store: MysqlStore;
let items: Table<Item>;
let usage: Table<Usage>;
let people: Table<Person>;

/** What ModuleStore will hand a table outside a transaction: the pool, and a way to get one connection */
const poolContext = (): TableContext => ({
  conn: store.pool,
  inTransaction: false,
  transaction: (fn) => store.transaction((tx) => fn(tx.conn)),
});

/** A table pinned to one connection, as it is inside a transaction */
const on = <R extends object>(conn: PoolConnection, def: TableDef) => new Table<R>({ conn, inTransaction: true, transaction: (fn) => fn(conn) }, def);

const SEED: Partial<Item>[] = [
  { sku: 'a-1', name: 'Alpha', status: 'open', qty: 5, price: '10.50', tags: ['x', 'y'], active: true },
  { sku: 'a-2', name: 'Beta', status: 'open', qty: 1, price: '2.00', tags: ['y'], active: false },
  { sku: 'b-1', name: null, status: 'held', qty: 9, price: '7.25', tags: null, active: true },
  { sku: 'b-2', name: 'Delta', status: 'closed', qty: 0, price: '0.00', tags: [], active: false },
];

beforeAll(async () => {
  server = await startPortableMysql({ dataDir: join(tmpdir(), 'marketly-table-test'), port: 3393, forTests: true });
  const root = await createConnection({ host: '127.0.0.1', port: server.port, user: 'root', ...CLIENT_OPTIONS });
  await root.query('DROP DATABASE IF EXISTS tablecheck');
  await root.query('CREATE DATABASE tablecheck DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin');
  await root.end();

  store = await connectMysql({ url: `mysql://root@127.0.0.1:${server.port}/tablecheck`, poolSize: 6 });
  await store.pool.query(
    'CREATE TABLE `t_items` (' +
      '`id` BIGINT NOT NULL AUTO_INCREMENT, `sku` VARCHAR(32) NOT NULL, `name` VARCHAR(64) NULL, ' +
      '`status` VARCHAR(16) NOT NULL, `qty` INT NOT NULL, `price` DECIMAL(12,2) NOT NULL, `tags` JSON NULL, ' +
      '`active` TINYINT(1) NOT NULL, `at` DATETIME(3) NULL, `day` DATE NULL, `digest` BINARY(4) NULL, ' +
      'PRIMARY KEY (`id`), UNIQUE KEY `uq_items_sku` (`sku`)) ENGINE=InnoDB',
  );
  await store.pool.query(
    'CREATE TABLE `t_usage` (`owner` VARCHAR(32) NOT NULL, `day` DATE NOT NULL, `n` INT NOT NULL, ' +
      '`bytes` BIGINT NOT NULL, `note` VARCHAR(32) NULL, PRIMARY KEY (`owner`, `day`)) ENGINE=InnoDB',
  );
  await store.pool.query(
    'CREATE TABLE `t_people` (`id` BIGINT NOT NULL AUTO_INCREMENT, `email` VARCHAR(64) NOT NULL, ' +
      '`phone` VARCHAR(32) NOT NULL, `name` VARCHAR(64) NOT NULL, PRIMARY KEY (`id`), ' +
      'UNIQUE KEY `uq_people_email` (`email`), UNIQUE KEY `uq_people_phone` (`phone`)) ENGINE=InnoDB',
  );
  items = new Table<Item>(poolContext(), ITEMS);
  usage = new Table<Usage>(poolContext(), USAGE);
  people = new Table<Person>(poolContext(), PEOPLE);
}, 180_000);

afterAll(async () => {
  await store?.close();
  await server?.stop();
});

beforeEach(async () => {
  await store.pool.query('TRUNCATE TABLE `t_items`');
  await store.pool.query('TRUNCATE TABLE `t_usage`');
  await store.pool.query('TRUNCATE TABLE `t_people`');
});

const seed = () => items.insertMany(SEED);
const skus = (rows: Item[]) => rows.map((r) => r.sku);

describe('a row and what comes back', () => {
  it('keeps every type the spec gives a column', async () => {
    const at = new Date('2026-03-01T12:00:00.000Z');
    const digest = new Uint8Array([1, 2, 3, 4]);
    const written = await items.insert({ sku: 's', name: 'Name', status: 'open', qty: 3, price: '12.34', tags: ['a', 'b'], active: true, at, day: '2026-03-01', digest });
    const read = await items.get(written.id);

    expect(read).toEqual({ id: written.id, sku: 's', name: 'Name', status: 'open', qty: 3, price: '12.34', tags: ['a', 'b'], active: true, at, day: '2026-03-01', digest });
    expect(read!.at).toBeInstanceOf(Date);
    expect(read!.digest).toBeInstanceOf(Uint8Array);
    expect(typeof read!.price).toBe('string'); // a numeric stays exact; 12.34 as a float is not 12.34
    expect(read!.active).toBe(true); // TINYINT(1), which mysql2 reads as the number 1
  });

  it('stores a timestamp as UTC, not as the hour it is here', async () => {
    // the session is time_zone = '+00:00', so what SQL sees must be the UTC time. mysql2 would otherwise write
    // the host's local hour, and read it back the same way — right in a round trip, wrong in the database.
    const at = new Date('2026-03-01T12:00:00.000Z');
    const row = await items.insert({ sku: 's', status: 'open', qty: 0, price: '0.00', active: true, at });
    const [[stored]] = await store.pool.query<any[]>("SELECT DATE_FORMAT(`at`, '%Y-%m-%d %H:%i:%s') AS text FROM `t_items` WHERE `id` = ?", [row.id]);
    expect(stored.text).toBe('2026-03-01 12:00:00');
  });

  it('stores a JSON array as one value, not as a list of values', async () => {
    // mysql2 expands a bound array into `'a', 'b'`, which is a value too many for the statement; a JSON column's
    // value is text on the way in. The empty array is the case that would quietly become NULL.
    const row = await items.insert({ sku: 's', status: 'open', qty: 0, price: '0.00', active: true, tags: ['a', 'b'] });
    expect((await items.get(row.id))!.tags).toEqual(['a', 'b']);
    const empty = await items.insert({ sku: 'e', status: 'open', qty: 0, price: '0.00', active: true, tags: [] });
    expect((await items.get(empty.id))!.tags).toEqual([]);
  });

  it('fills in the nullable columns the caller left out, and numbers the row', async () => {
    const row = await items.insert({ sku: 's', status: 'open', qty: 0, price: '0.00', active: false });
    expect(row).toEqual({ id: row.id, sku: 's', name: null, status: 'open', qty: 0, price: '0.00', tags: null, active: false, at: null, day: null, digest: null });
    expect(row.id).toBeGreaterThan(0);
    expect(await items.get(row.id)).toEqual(row);
  });

  it('refuses a column the table does not have', async () => {
    await expect(items.insert({ sku: 's', status: 'open', qty: 0, price: '0', active: true, nope: 1 } as never)).rejects.toThrow(/no column nope/);
  });
});

describe('reads', () => {
  beforeEach(seed);

  it('get, findOne and find', async () => {
    const one = await items.findOne({ sku: 'a-1' });
    expect(one?.name).toBe('Alpha');
    expect(await items.get(one!.id)).toEqual(one);
    expect(await items.get(-1)).toBeUndefined();
    expect(skus(await items.find({ status: 'open' }, { sort: { sku: 1 } }))).toEqual(['a-1', 'a-2']);
    expect(skus(await items.find({}, { sort: { qty: -1 }, limit: 2 }))).toEqual(['b-1', 'a-1']);
    expect(skus(await items.find({}, { sort: { qty: -1 }, limit: 2, offset: 2 }))).toEqual(['a-2', 'b-2']);
  });

  it('sorts nulls last in either direction, which MySQL does not do on its own', async () => {
    expect(await items.find({}, { sort: { name: 1 } }).then((r) => r.map((x) => x.name))).toEqual([null, 'Alpha', 'Beta', 'Delta']);
    expect(await items.find({}, { sort: { name: 1 }, nullsLast: ['name'] }).then((r) => r.map((x) => x.name))).toEqual(['Alpha', 'Beta', 'Delta', null]);
    expect(await items.find({}, { sort: { name: -1 }, nullsLast: ['name'] }).then((r) => r.map((x) => x.name))).toEqual(['Delta', 'Beta', 'Alpha', null]);
    await expect(items.find({}, { sort: { qty: 1 }, nullsLast: ['name'] })).rejects.toThrow(/nullsLast names name/);
  });

  it('getMany, count, exists and distinct', async () => {
    const all = await items.find({}, { sort: { sku: 1 } });
    expect(skus(await items.getMany([all[0]!.id, all[2]!.id], { sort: { sku: 1 } }))).toEqual(['a-1', 'b-1']);
    expect(await items.getMany([])).toEqual([]);
    expect(await items.count()).toBe(4);
    expect(await items.count({ status: 'open' })).toBe(2);
    expect(await items.exists({ sku: 'a-1' })).toBe(true);
    expect(await items.exists({ sku: 'zzz' })).toBe(false);
    expect((await items.distinct<string>('status')).sort()).toEqual(['closed', 'held', 'open']);
  });

  it('takes an extra condition for what Where cannot say', async () => {
    // the shape the `$expr` caps become: a comparison between two columns
    expect(skus(await items.find({}, { and: raw('`qty` > `price`'), sort: { sku: 1 } }))).toEqual(['b-1']);
    expect(await items.count({ status: 'open' }, { and: raw('`qty` >= ?', [2]) })).toBe(1);
  });
});

describe('paging', () => {
  it('walks every row exactly once in cursor mode, even where the sort column ties', async () => {
    // the tie is the point: a keyset on the sort column alone would skip or repeat rows here
    const at = new Date('2026-03-01T00:00:00.000Z');
    await items.insertMany(Array.from({ length: 9 }, (_, i) => ({ sku: `s-${i}`, status: 'open', qty: i, price: '1.00', active: true, at: i < 6 ? at : new Date('2026-03-02T00:00:00.000Z') })));

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 10; guard++) {
      const page: Awaited<ReturnType<typeof items.page>> = await items.page({}, toPageRequest({ limit: 2, ...(cursor ? { cursor } : {}) }), { column: 'at', direction: 'asc' });
      seen.push(...skus(page.items));
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toHaveLength(9);
    expect(new Set(seen).size).toBe(9);
  });

  it('counts and offsets in page mode', async () => {
    await seed();
    const page = await items.page({}, toPageRequest({ page: 2, limit: 3 }), { column: 'sku', direction: 'asc' });
    expect(skus(page.items)).toEqual(['b-2']);
    expect(page).toMatchObject({ page: 2, totalPages: 2, total: 4, nextCursor: null });
  });

  it('pages on a value the query computes, not on a column', async () => {
    await seed();
    // "no day set" sorts after every day, as a far-future default rather than as null
    const sql = "SELECT `t_items`.*, COALESCE(`day`, '9999-12-31') AS `sort_day` FROM `t_items`";
    await items.updateMany({ sku: 'a-2' }, { day: '2026-01-01' });
    await items.updateMany({ sku: 'b-1' }, { day: '2026-05-05' });
    const page = await items.pageQuery({ sql, params: [] }, toPageRequest({ limit: 10 }), { key: 'sort_day', direction: 'asc' });
    expect(skus(page.items)).toEqual(['a-2', 'b-1', 'a-1', 'b-2']);
    expect(page.items[0]).not.toHaveProperty('sort_day'); // the computed key is not a column of the row
  });
});

describe('writes', () => {
  it('insertMany writes one statement and numbers a contiguous block', async () => {
    await seed();
    const all = await items.find({}, { sort: { id: 1 } });
    expect(skus(all)).toEqual(['a-1', 'a-2', 'b-1', 'b-2']);
    expect(all.map((r) => r.id)).toEqual([all[0]!.id, all[0]!.id + 1, all[0]!.id + 2, all[0]!.id + 3]);
    await expect(items.insertMany([{ sku: 'x', status: 'open', qty: 1, price: '1', active: true }, { sku: 'y', status: 'open', price: '1', active: true }])).rejects.toThrow(/row 1 leaves out qty/);
  });

  it('insertIfAbsent answers undefined instead of raising, and leaves the transaction standing', async () => {
    await seed();
    expect(await items.insertIfAbsent({ sku: 'a-1', status: 'open', qty: 0, price: '0', active: true })).toBeUndefined();
    expect((await items.insertIfAbsent({ sku: 'new', status: 'open', qty: 0, price: '0', active: true }))?.sku).toBe('new');

    // the rule that changed from MongoDB: a duplicate key costs the statement, not the transaction. On MongoDB
    // this transaction would have been aborted and the second insert would never have committed.
    await store.transaction(async (tx) => {
      const t = on<Item>(tx.conn, ITEMS);
      expect(await t.insertIfAbsent({ sku: 'a-1', status: 'open', qty: 0, price: '0', active: true })).toBeUndefined();
      await t.insert({ sku: 'after', status: 'open', qty: 0, price: '0', active: true });
    });
    expect(await items.exists({ sku: 'after' })).toBe(true);
  });

  it('insertIfAbsent with a key raises a clash on any other key', async () => {
    const row = await items.insert({ sku: 'a-1', status: 'open', qty: 0, price: '0', active: true });
    expect(await items.insertIfAbsent({ sku: 'a-1', status: 'open', qty: 0, price: '0', active: true }, ['sku'])).toBeUndefined();
    // the same sku is expected; the same id is not, and must not be swallowed
    await expect(items.insertIfAbsent({ id: row.id, sku: 'other', status: 'open', qty: 0, price: '0', active: true }, ['sku'])).rejects.toMatchObject({ errno: 1062 });
    await expect(items.insertIfAbsent({ sku: 'x', status: 'open', qty: 0, price: '0', active: true }, ['status'])).rejects.toThrow(/not a unique key/);
  });

  it('insertManyIfAbsent counts the rows that were new', async () => {
    await seed();
    expect(await items.insertManyIfAbsent([
      { sku: 'a-1', status: 'open', qty: 0, price: '0', active: true },
      { sku: 'c-1', status: 'open', qty: 0, price: '0', active: true },
      { sku: 'c-1', status: 'open', qty: 0, price: '0', active: true }, // clashes with the row just before it
    ])).toBe(1);
    expect(await items.count()).toBe(5);
  });

  it('upsert inserts, then updates, on a key that is the only one at risk', async () => {
    const first = await usage.upsert({ owner: 'o', day: '2026-01-01', n: 1, bytes: 10 });
    expect(first).toEqual({ owner: 'o', day: '2026-01-01', n: 1, bytes: 10, note: null });
    const again = await usage.upsert({ owner: 'o', day: '2026-01-01', n: 2, bytes: 20, note: 'second' });
    expect(again).toEqual({ owner: 'o', day: '2026-01-01', n: 2, bytes: 20, note: 'second' });
    expect(await usage.count()).toBe(1);
    // `update` says what an existing row gets, which need not be what a new row would hold
    await usage.upsert({ owner: 'o', day: '2026-01-01', n: 99, bytes: 99 }, { update: { note: 'third' } });
    expect(await usage.findOne({ owner: 'o' })).toEqual({ owner: 'o', day: '2026-01-01', n: 2, bytes: 20, note: 'third' });
  });

  it('an AUTO_INCREMENT key the row leaves blank is never the key that clashes', async () => {
    // t_items also has a primary key, but the row does not set it, so the number it gets is new and only
    // uq_items_sku can refuse the insert: one statement is still enough
    const made = await items.upsert({ sku: 'u-1', status: 'open', qty: 1, price: '1.00', active: true }, { key: ['sku'] });
    expect(made.sku).toBe('u-1');
    const updated = await items.upsert({ sku: 'u-1', status: 'closed', qty: 7, price: '2.00', active: false }, { key: ['sku'] });
    expect(updated).toMatchObject({ id: made.id, sku: 'u-1', status: 'closed', qty: 7 });
    expect(await items.count()).toBe(1);
    await expect(items.upsert({ status: 'open', qty: 1, price: '1', active: true }, { key: ['sku'] })).rejects.toThrow(/needs a value for sku/);
  });

  it('upsert finds and locks the row where another unique key could also clash', async () => {
    await people.insertMany([
      { email: 'a@x', phone: '111', name: 'Ann' },
      { email: 'b@x', phone: '222', name: 'Bo' },
    ]);
    // the key is email and the id is given, so the primary key could clash too: ON DUPLICATE KEY UPDATE would
    // act on whichever of the two refused the insert, which need not be the row the caller named
    const ann = await people.findOne({ email: 'a@x' });
    const updated = await people.upsert({ id: ann!.id, email: 'a@x', phone: '999', name: 'Ann B' }, { key: ['email'] });
    expect(updated).toEqual({ id: ann!.id, email: 'a@x', phone: '999', name: 'Ann B' });
    expect(await people.count()).toBe(2);
  });

  it('upsert raises a clash on a unique key the caller did not name', async () => {
    await people.insertMany([
      { email: 'a@x', phone: '111', name: 'Ann' },
      { email: 'b@x', phone: '222', name: 'Bo' },
    ]);
    // no row has this email, so it is an insert — and the phone is Bo's. Answering "done" here would be the
    // worst outcome: the caller's row was never written and nothing said so.
    await expect(people.upsert({ email: 'c@x', phone: '222', name: 'Cal' }, { key: ['email'] })).rejects.toMatchObject({ errno: 1062 });
    expect(await people.count()).toBe(2);
    expect((await people.findOne({ email: 'b@x' }))!.name).toBe('Bo');
  });

  it('refuses to upsert on columns that are not a unique key', async () => {
    await expect(people.upsert({ email: 'c@x', phone: '333', name: 'Cal' }, { key: ['name'] })).rejects.toThrow(/not a unique key/);
    await expect(usage.increment({ owner: 'o' }, { n: 1 })).rejects.toThrow(/not a unique key/);
  });

  it('upsertMany writes a batch and brings existing rows up to date', async () => {
    await usage.upsertMany([
      { owner: 'a', day: '2026-01-01', n: 1, bytes: 1 },
      { owner: 'b', day: '2026-01-01', n: 2, bytes: 2 },
    ]);
    await usage.upsertMany([
      { owner: 'b', day: '2026-01-01', n: 20, bytes: 20 },
      { owner: 'c', day: '2026-01-01', n: 3, bytes: 3 },
    ]);
    expect(await usage.find({}, { sort: { owner: 1 } })).toEqual([
      { owner: 'a', day: '2026-01-01', n: 1, bytes: 1, note: null },
      { owner: 'b', day: '2026-01-01', n: 20, bytes: 20, note: null },
      { owner: 'c', day: '2026-01-01', n: 3, bytes: 3, note: null },
    ]);
  });

  it('increment creates the row, then adds to it', async () => {
    expect(await usage.increment({ owner: 'o', day: '2026-01-01' }, { n: 1, bytes: 100 })).toEqual({ owner: 'o', day: '2026-01-01', n: 1, bytes: 100, note: null });
    expect(await usage.increment({ owner: 'o', day: '2026-01-01' }, { n: 1, bytes: 50 })).toMatchObject({ n: 2, bytes: 150 });
    expect(await usage.count()).toBe(1);
  });

  it('update, updateOne and updateMany', async () => {
    await seed();
    const one = await items.findOne({ sku: 'a-1' });
    expect((await items.update(one!.id, { status: 'closed', name: null }))).toMatchObject({ status: 'closed', name: null });
    expect(await items.update(-1, { status: 'x' })).toBeUndefined();
    // updateOne takes the first in the order it is given, and answers that row as it now is
    const first = await items.updateOne({ status: 'open' }, { qty: 42 }, { sort: { sku: 1 } });
    expect(first).toMatchObject({ sku: 'a-2', qty: 42 });
    expect(await items.updateMany({ status: 'open' }, { status: 'held' })).toBe(1);
    expect(await items.updateMany({ sku: 'nothing' }, { qty: 1 })).toBe(0);
  });

  it('updateMany counts the rows it matched, not the ones it changed', async () => {
    // CLIENT_FOUND_ROWS (§10.2): this is what matchedCount meant on MongoDB, and repositories read it that way
    await seed();
    expect(await items.updateMany({ status: 'open' }, { status: 'open' })).toBe(2);
  });

  it('computes in SQL with inc, decToZero and jsonAppend', async () => {
    await seed();
    const held = await items.findOne({ sku: 'b-1' });
    expect(await items.update(held!.id, { qty: inc('qty', 3) })).toMatchObject({ qty: 12 });
    expect(await items.update(held!.id, { qty: decToZero('qty', 100) })).toMatchObject({ qty: 0 });
    const alpha = await items.findOne({ sku: 'a-1' });
    expect((await items.update(alpha!.id, { tags: jsonAppend('tags', 'z') }))!.tags).toEqual(['x', 'y', 'z']);
  });

  it('delete and deleteMany', async () => {
    await seed();
    const one = await items.findOne({ sku: 'a-1' });
    expect(await items.delete(one!.id)).toBe(true);
    expect(await items.delete(one!.id)).toBe(false);
    expect(await items.deleteMany({ status: 'open' })).toBe(1);
    expect(await items.count()).toBe(2);
  });
});

/**
 * The part that cannot be seen from one connection. MongoDB aborted the second writer of a document, so a read
 * and a write with nothing between them was still safe; InnoDB makes the second writer wait and then overwrite.
 * These two tests are the difference, and the rule in §11.2 that follows from it.
 */
describe('two transactions at once', () => {
  it('loses the second update when the row was read without a lock', async () => {
    const row = await items.insert({ sku: 's', status: 'open', qty: 10, price: '1', active: true });
    const [a, b] = [await store.pool.getConnection(), await store.pool.getConnection()];
    try {
      await a.beginTransaction();
      await b.beginTransaction();
      const seenByA = await on<Item>(a, ITEMS).get(row.id);
      const seenByB = await on<Item>(b, ITEMS).get(row.id);
      expect(seenByA!.qty).toBe(10);
      expect(seenByB!.qty).toBe(10);

      await on<Item>(a, ITEMS).update(row.id, { qty: seenByA!.qty + 1 });
      await a.commit();
      await on<Item>(b, ITEMS).update(row.id, { qty: seenByB!.qty + 1 });
      await b.commit();
    } finally {
      a.release();
      b.release();
    }
    // both added one and the answer is eleven: B wrote the value it worked out from a row A had already changed
    expect((await items.get(row.id))!.qty).toBe(11);
  });

  it('keeps both when the server does the adding', async () => {
    const row = await items.insert({ sku: 's', status: 'open', qty: 10, price: '1', active: true });
    await Promise.all([
      store.transaction((tx) => on<Item>(tx.conn, ITEMS).updateMany({ id: row.id }, { qty: inc('qty', 1) })),
      store.transaction((tx) => on<Item>(tx.conn, ITEMS).updateMany({ id: row.id }, { qty: inc('qty', 1) })),
    ]);
    expect((await items.get(row.id))!.qty).toBe(12);
  });

  it('forUpdate holds the row until the transaction ends', async () => {
    const row = await items.insert({ sku: 's', status: 'open', qty: 10, price: '1', active: true });
    const holder = await store.pool.getConnection();
    const waiter = await store.pool.getConnection();
    try {
      await holder.beginTransaction();
      await on<Item>(holder, ITEMS).get(row.id, { forUpdate: true });

      await waiter.query('SET SESSION innodb_lock_wait_timeout = 1'); // the real one is 10 s (§10.2)
      await waiter.beginTransaction();
      const blocked = await on<Item>(waiter, ITEMS)
        .updateMany({ id: row.id }, { qty: 99 })
        .then(() => undefined)
        .catch((err: unknown) => err);
      expect(isLockTimeout(blocked)).toBe(true);
      await waiter.rollback();
      await holder.rollback();
    } finally {
      holder.release();
      waiter.release();
    }
    expect((await items.get(row.id))!.qty).toBe(10);
  });
});
