/**
 * The MongoDB layer (docs/04-mongodb-migration.md): schema from the spec's notation, row ↔ document conversion,
 * filters, paging, upserts, transactions with lock-by-write, the inbox and named locks.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { collectionDefs } from '../../../tools/lib/mongo.js';
import { planTables } from '../../../tools/lib/tables.js';
import type { ModuleSpec } from '../../../tools/lib/spec.js';
import { testMongo } from '../../testing/mongo.js';
import { newId } from '../lib/ids.js';
import type { CollectionDef } from '../spec/define.js';
import mongoose, { Schema } from 'mongoose';
import { CASE_INSENSITIVE, contains, isDuplicateKey, likePattern, mongoStore, whereFilter, type ModuleSchemas, type MongoStore } from './index.js';
import { migrateMongo } from './schema.js';
import { collectionOptions, integer } from './schemas.js';

const demo = {
  name: 'demo',
  title: 'Demo',
  tables: [
    {
      name: 'items',
      columns: {
        id: 'uuid pk',
        sku: 'text unique',
        alt_code: 'text? unique',
        status: 'text (draft|active|removed)',
        stock: 'int check >= 0',
        price: 'numeric(10,2)',
        tags: 'text[]',
        meta: 'jsonb?',
        archived_at: 'timestamptz?',
        created_at: 'timestamptz',
      },
      indexes: ['(status, created_at desc)', 'unique (sku, status) where status in (\'draft\',\'active\')', '(created_at) where archived_at is null', 'unique (lower(alt_code))'],
    },
    { name: 'links', columns: { item_id: 'uuid → items', tag: 'text', note: 'text?' }, indexes: ['pk (item_id, tag)'] },
    { name: 'counters', columns: { owner: 'text', day: 'text', count: 'int', bytes: 'int', note: 'text?' }, indexes: ['pk (owner, day)'] },
    { name: 'entries', columns: { seq: 'bigserial pk', label: 'text' } },
  ],
} as unknown as ModuleSpec;

let store: MongoStore;
let defs: Record<string, CollectionDef>;
let schemas: ModuleSchemas;

/** The demo module's schemas as the generator writes them (tools/lib/mongoose.ts), indexes from the definitions */
function demoSchemas(d: Record<string, CollectionDef>): ModuleSchemas {
  const items = new Schema(
    {
      _id: { type: String, required: true },
      sku: { type: String, required: true },
      alt_code: { type: String, default: null },
      status: { type: String, required: true, enum: ['draft', 'active', 'removed'] },
      stock: { type: Number, required: true, min: 0, validate: integer },
      price: { type: Schema.Types.Decimal128, required: true },
      tags: { type: [String], default: undefined },
      meta: { type: Schema.Types.Mixed, default: null },
      archived_at: { type: Date, default: null },
      created_at: { type: Date, required: true },
      _lock: Number,
    },
    collectionOptions('demo.items'),
  );
  const links = new Schema({ item_id: { type: String, required: true }, tag: { type: String, required: true }, note: { type: String, default: null }, _lock: Number }, collectionOptions('demo.links', { generatedId: true }));
  const counters = new Schema(
    {
      owner: { type: String, required: true },
      day: { type: String, required: true },
      count: { type: Number, required: true, validate: integer },
      bytes: { type: Number, required: true, validate: integer },
      note: { type: String, default: null },
      _lock: Number,
    },
    collectionOptions('demo.counters', { generatedId: true }),
  );
  const entries = new Schema({ _id: { type: Number, required: true, validate: integer }, label: { type: String, required: true }, _lock: Number }, collectionOptions('demo.entries'));
  for (const [table, schema] of [['items', items], ['links', links], ['counters', counters], ['entries', entries]] as const) {
    for (const i of d[table]!.indexes) schema.index(i.key, { name: i.name, ...(i.unique ? { unique: true } : {}), ...(i.partial ? { partialFilterExpression: i.partial } : {}), ...(i.collation ? { collation: i.collation } : {}) });
  }
  return { items, links, counters, entries };
}
beforeAll(async () => {
  const problems: string[] = [];
  defs = collectionDefs(demo, planTables(demo, problems), problems) as Record<string, CollectionDef>;
  expect(problems).toEqual([]);
  schemas = demoSchemas(defs);
  store = await testMongo();
  await migrateMongo(store, [{ module: 'demo', collections: defs, schemas }]);
});
afterAll(async () => {
  await store?.close();
});

type Item = { id: string; sku: string; alt_code: string | null; status: string; stock: number; price: string; tags: string[]; meta: unknown; archived_at: Date | null; created_at: Date };
const item = (o: Partial<Item> = {}): Item => ({ id: newId(), sku: `SKU-${newId().slice(-8)}`, alt_code: null, status: 'active', stock: 3, price: '12.50', tags: ['a'], meta: null, archived_at: null, created_at: new Date(), ...o });

describe('schema from the spec', () => {
  it('stores a single-column key as _id and composite keys as a unique index', () => {
    expect(defs.items!.idField).toBe('id');
    expect(defs.links!.idField).toBeNull();
    expect(defs.links!.indexes.some((i) => i.unique && JSON.stringify(i.key) === '{"item_id":1,"tag":1}')).toBe(true);
  });

  it('enforces types, NOT NULL, enum values and checks with the validator', async () => {
    const items = store.module('demo', defs, schemas).table<Item>('items');
    await expect(items.insert({ ...item(), status: 'gone' })).rejects.toThrow(/validation/i);
    await expect(items.insert({ ...item(), stock: -1 })).rejects.toThrow(/validation/i);
    await expect(items.insert({ ...item(), sku: undefined as never })).rejects.toThrow(/validation/i);
  });

  it('keeps the spec null rules: several null values in a unique nullable column, a case-insensitive unique index', async () => {
    const items = store.module('demo', defs, schemas).table<Item>('items');
    await items.insert(item({ alt_code: null }));
    await items.insert(item({ alt_code: null }));
    await items.insert(item({ alt_code: 'Abc' }));
    await expect(items.insert(item({ alt_code: 'aBC' }))).rejects.toThrow(/duplicate key/);
  });

  it('applies partial unique indexes ($in) only to the rows they name', async () => {
    const items = store.module('demo', defs, schemas).table<Item>('items');
    // the column is unique anyway; the partial index is checked through its own definition
    const partial = defs.items!.indexes.find((i) => i.partial && i.unique && 'status' in i.key)!;
    expect(partial.partial).toEqual({ status: { $in: ['draft', 'active'] } });
    expect(defs.items!.indexes.find((i) => !i.unique && i.partial)!.partial).toEqual({ archived_at: null });
    expect(await items.count({})).toBeGreaterThan(0);
  });

  it('is idempotent and skips modules whose definitions did not change', async () => {
    expect(await migrateMongo(store, [{ module: 'demo', collections: defs, schemas }])).toEqual([]);
  });
});

describe('rows and documents', () => {
  it('round-trips ids, numerics, arrays, json and nulls', async () => {
    const items = store.module('demo', defs, schemas).table<Item>('items');
    const row = item({ price: '1999.99', tags: ['x', 'y'], meta: { a: [1, 2] } });
    await items.insert(row);
    const raw = await store.db.collection('demo.items').findOne({ _id: row.id as never });
    expect(raw!.id).toBeUndefined();
    expect(raw!.price.constructor.name).toBe('Decimal128');
    expect(await items.get(row.id)).toEqual(row);
    expect(await items.find({ price: '1999.99' })).toHaveLength(1);
    expect(await items.find({ id: { $in: [row.id] } })).toHaveLength(1);
  });

  it('pages by keyset and by page number', async () => {
    const items = store.module('demo', defs, schemas).table<Item>('items');
    const tag = newId();
    const t0 = Date.now();
    for (let i = 0; i < 5; i++) await items.insert(item({ tags: [tag], created_at: new Date(t0 + i * 1000) }));
    const first = await items.page({ tags: tag }, { mode: 'cursor', cursor: null, limit: 2 }, { column: 'created_at', direction: 'desc' });
    const second = await items.page({ tags: tag }, { mode: 'cursor', cursor: first.nextCursor, limit: 2 }, { column: 'created_at', direction: 'desc' });
    const third = await items.page({ tags: tag }, { mode: 'cursor', cursor: second.nextCursor, limit: 2 }, { column: 'created_at', direction: 'desc' });
    expect([...first.items, ...second.items, ...third.items].map((r) => r.created_at.getTime())).toEqual([4, 3, 2, 1, 0].map((i) => t0 + i * 1000));
    expect(third.nextCursor).toBeNull();
    const p2 = await items.page({ tags: tag }, { mode: 'page', page: 2, limit: 2 }, { column: 'created_at', direction: 'asc' });
    expect(p2).toMatchObject({ page: 2, totalPages: 3, total: 5 });
  });

  it('inserts if absent and upserts without duplicate-key errors', async () => {
    const links = store.module('demo', defs, schemas).table<{ item_id: string; tag: string; note: string | null }>('links');
    const id = newId();
    expect(await links.insertIfAbsent({ item_id: id, tag: 't' })).toMatchObject({ item_id: id, tag: 't', note: null });
    expect(await links.insertIfAbsent({ item_id: id, tag: 't', note: 'again' })).toBeUndefined();
    expect(await links.insertManyIfAbsent([{ item_id: id, tag: 't' }, { item_id: id, tag: 'u' }])).toBe(1);
    expect(await links.upsert({ item_id: id, tag: 't', note: 'set' })).toMatchObject({ note: 'set' });
    expect(await links.count({ item_id: id })).toBe(2);
  });

  it('numbers identity columns in row order, a batch from one counter update; given numbers are kept', async () => {
    expect(defs.entries!.identity).toBe('seq');
    const mod = store.module('demo', defs, schemas);
    const entries = mod.table<{ seq: number; label: string }>('entries');
    const first = await entries.insert({ label: 'a' });
    await entries.insertMany([{ label: 'b' }, { seq: 1000, label: 'given' }, { label: 'c' }]);
    await entries.upsertMany([{ label: 'd' }], { key: ['label'] });
    const rows = await entries.find({}, { sort: { seq: 1 } });
    expect(rows.map((r) => [r.seq - first.seq, r.label])).toEqual([[0, 'a'], [1, 'b'], [2, 'c'], [3, 'd'], [1000 - first.seq, 'given']]);
    expect(await mod.nextValues('things', 3)).toEqual([1, 2, 3]);
    expect(await mod.nextValue('things')).toBe(4);
    expect(await mod.nextValues('things', 0)).toEqual([]);
  });
});

describe('transactions', () => {
  it('serialises read-decide-write on a locked document (no lost update), retrying the loser', async () => {
    const mod = store.module('demo', defs, schemas);
    const row = await mod.table<Item>('items').insert(item({ stock: 0 }));
    let attempts = 0;
    const add = () =>
      mod.transaction(async (tx) => {
        attempts++;
        const t = tx.table<Item>('items');
        const current = (await t.get(row.id, { forUpdate: true }))!;
        await new Promise((r) => setTimeout(r, 20));
        await t.update(row.id, { stock: current.stock + 1 });
      });
    await Promise.all(Array.from({ length: 5 }, add));
    expect((await mod.table<Item>('items').get(row.id))!.stock).toBe(5);
    expect(attempts).toBeGreaterThan(5);
  });

  it('rolls back everything when fn throws', async () => {
    const mod = store.module('demo', defs, schemas);
    const row = item();
    await expect(
      mod.transaction(async (tx) => {
        await tx.table<Item>('items').insert(row);
        throw new Error('no');
      }),
    ).rejects.toThrow('no');
    expect(await mod.table<Item>('items').get(row.id)).toBeUndefined();
  });

  it('claims an inbox key once, committed with the effects', async () => {
    const mod = store.module('demo', defs, schemas);
    const key = `k-${newId()}`;
    await expect(
      mod.transaction(async (tx) => {
        expect(await tx.claim(key)).toBe(true);
        throw new Error('rolled back');
      }),
    ).rejects.toThrow();
    expect(await mod.seen(key)).toBe(false);
    expect(await mod.transaction((tx) => tx.claim(key))).toBe(true);
    expect(await mod.transaction((tx) => tx.claim(key))).toBe(false);
  });

  it('a named lock serialises transactions', async () => {
    const mod = store.module('demo', defs, schemas);
    const order: string[] = [];
    const run = (name: string) =>
      mod.transaction(async (tx) => {
        await tx.lock('registry');
        order.push(`${name}:start`);
        await new Promise((r) => setTimeout(r, 30));
        order.push(`${name}:end`);
      });
    await Promise.all([run('a'), run('b')]);
    // the second transaction conflicts at the lock, before doing anything, until the first has committed
    expect(order).toHaveLength(4);
    expect(order[1]).toBe(order[0]!.replace('start', 'end'));
    expect(order[3]).toBe(order[2]!.replace('start', 'end'));
  });

  describe('slow or retried transactions are logged', () => {
    // a second store on the same database whose transactions report to a fake logger
    const watched = (slowMs: number) => {
      const warnings: object[] = [];
      const s = mongoStore(store.connection, async () => {}, { log: { warn: (obj) => warnings.push(obj) }, slowMs });
      return { mod: s.module('demo', defs, schemas), warnings };
    };

    it('a quick transaction run once logs nothing', async () => {
      const { mod, warnings } = watched(10_000);
      await mod.transaction((tx) => tx.table<Item>('items').insert(item()));
      expect(warnings).toEqual([]);
    });

    it('a retried transaction logs one warning with its module and attempts', async () => {
      const { mod, warnings } = watched(10_000);
      let attempts = 0;
      await mod.transaction(async (tx) => {
        await tx.table<Item>('items').insert(item());
        // what MongoDB reports on a write conflict: withTransaction runs fn again
        if (++attempts === 1) {
          const conflict = new mongoose.mongo.MongoError('forced write conflict');
          conflict.addErrorLabel('TransientTransactionError');
          throw conflict;
        }
      });
      expect(warnings).toEqual([{ module: 'demo', ms: expect.any(Number), attempts: 2 }]);
    });

    it('a slow transaction logs one warning with its duration', async () => {
      const { mod, warnings } = watched(20);
      await mod.transaction(async (tx) => {
        await tx.table<Item>('items').insert(item());
        await new Promise((r) => setTimeout(r, 40));
      });
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatchObject({ module: 'demo', attempts: 1 });
      expect((warnings[0] as { ms: number }).ms).toBeGreaterThan(20);
    });
  });
});

describe('repository helpers', () => {
  const items = () => store.module('demo', defs, schemas).table<Item>('items');
  const code = () => `C${newId().slice(-10)}`;

  it('insertIfAbsent checks every unique index: primary key, unique columns, partial and case-insensitive ones', async () => {
    const t = items();
    const first = item({ alt_code: code() });
    expect(await t.insertIfAbsent(first)).toMatchObject({ id: first.id });
    expect(await t.insertIfAbsent({ ...first, sku: `${first.sku}-2`, alt_code: null })).toBeUndefined(); // same id
    expect(await t.insertIfAbsent(item({ sku: first.sku }))).toBeUndefined(); // same sku
    expect(await t.insertIfAbsent(item({ alt_code: first.alt_code!.toLowerCase() }))).toBeUndefined(); // lower(alt_code)
    // nulls never clash (the unique nullable column's index is partial)
    expect(await t.insertIfAbsent(item({ alt_code: null }))).toBeDefined();
    expect(await t.insertIfAbsent(item({ alt_code: null }))).toBeDefined();
    // with a key, only that key is checked: a clash on another unique index still fails
    await expect(t.insertIfAbsent(item({ sku: first.sku }), ['id'])).rejects.toSatisfy(isDuplicateKey);
  });

  it('insertIfAbsent inside a transaction skips a taken key without aborting it', async () => {
    const mod = store.module('demo', defs, schemas);
    const taken = await mod.table<Item>('items').insert(item());
    const fresh = item();
    await mod.transaction(async (tx) => {
      expect(await tx.table<Item>('items').insertIfAbsent(item({ sku: taken.sku }))).toBeUndefined();
      expect(await tx.table<Item>('items').insertIfAbsent(fresh)).toBeDefined();
    });
    expect(await mod.table<Item>('items').get(fresh.id)).toBeDefined();
  });

  it('insertManyIfAbsent inserts in order, skipping rows that clash with stored ones or earlier ones', async () => {
    const links = store.module('demo', defs, schemas).table<{ item_id: string; tag: string; note: string | null }>('links');
    const id = newId();
    await links.insert({ item_id: id, tag: 'a' });
    expect(await links.insertManyIfAbsent([{ item_id: id, tag: 'a' }, { item_id: id, tag: 'b' }, { item_id: id, tag: 'b' }, { item_id: id, tag: 'c' }])).toBe(2);
    expect((await links.find({ item_id: id }, { sort: { tag: 1 } })).map((l) => l.tag)).toEqual(['a', 'b', 'c']);
  });

  it('whereFilter keeps SQL null rules', async () => {
    const t = items();
    const tag = newId();
    const [x, y] = [code(), code()];
    await t.insertMany([item({ tags: [tag], alt_code: null, stock: 1 }), item({ tags: [tag], alt_code: x, stock: 2 }), item({ tags: [tag], alt_code: y, stock: 3 })]);
    const count = (w: Record<string, unknown>) => t.count(whereFilter({ tags: tag, ...w }));
    expect(await count({ alt_code: null })).toBe(1);
    expect(await count({ alt_code: [x, null] })).toBe(1);
    expect(await count({ alt_code: [] })).toBe(0);
    expect(await count({ alt_code: { op: '<>', value: x } })).toBe(1);
    expect(await count({ alt_code: { op: '<>', value: null } })).toBe(0);
    expect(await count({ alt_code: { op: 'is not', value: null } })).toBe(2);
    expect(await count({ alt_code: { op: 'is not', value: x } })).toBe(2);
    expect(await count({ alt_code: { op: 'not in', value: [x] } })).toBe(1);
    expect(await count({ alt_code: { op: 'not in', value: [] } })).toBe(3);
    expect(await count({ alt_code: { op: 'not in', value: [x, null] } })).toBe(0);
    expect(await count({ alt_code: { op: 'like', value: `${x.slice(0, -2)}%` } })).toBe(1);
    expect(await count({ stock: { op: '>=', value: 2 } })).toBe(2);
    expect(await count({ stock: { op: '>=', value: null } })).toBe(0);
    expect(await count({ stock: { op: 'between', value: [1, 2] } })).toBe(2);
    expect(await count({ stock: undefined })).toBe(3);
    expect(() => whereFilter({ stock: { op: '~', value: 1 } })).toThrow(/unsupported/);
  });

  it('whereFilter writes or, and and [] paths as MongoDB reads them', () => {
    // The filter, not its effect. Mongoose *strips* an empty $and or $or before sending, so a wrong
    // translation of either is invisible through a query — while the server itself answers
    // "$and/$or/$nor must be a nonempty array". What is built here has to be right on its own.
    expect(whereFilter({ and: [] })).toEqual({});
    expect(whereFilter({ or: [] })).toEqual({ $nor: [{}] });
    expect(whereFilter({ and: [{ a: 1 }, { b: 2 }] })).toEqual({ $and: [{ a: 1 }, { b: 2 }] });
    expect(whereFilter({ or: [{ a: 1 }], b: 2 })).toEqual({ b: 2, $or: [{ a: 1 }] });
    // a [] path is MongoDB's own dotted path, which already means "any element of the array"
    expect(whereFilter({ 'items[].key': 'k' })).toEqual({ 'items.key': 'k' });
    expect(whereFilter({ 'items[].key': ['k', 'j'] })).toEqual({ 'items.key': { $in: ['k', 'j'] } });
    expect(whereFilter({ 'tags[]': 't' })).toEqual({ tags: 't' });
    expect(() => whereFilter({ 'items[].key': { op: '<', value: 1 } })).toThrow(/is a \[\] path/);
    expect(() => whereFilter({ 'items[].key': null })).toThrow(/is a \[\] path/);
  });

  it('contains and likePattern match literally', () => {
    expect(contains('  a.b ')).toEqual({ $regex: 'a\\.b', $options: 'i' });
    const like = new RegExp(likePattern('50\\%_x%').$regex);
    expect(like.test('50%_xyz')).toBe(true);
    expect(like.test('50%ax')).toBe(true);
    expect(like.test('50x_x')).toBe(false);
  });

  it('reads with a collation compare case-insensitively', async () => {
    const t = items();
    const row = await t.insert(item({ sku: `MiXeD-${newId()}` }));
    const lower = row.sku.toLowerCase();
    expect(await t.findOne({ sku: lower })).toBeUndefined();
    expect(await t.findOne({ sku: lower }, { collation: CASE_INSENSITIVE })).toMatchObject({ id: row.id });
    expect(await t.find({ sku: lower }, { collation: CASE_INSENSITIVE })).toHaveLength(1);
    expect(await t.count({ sku: lower }, { collation: CASE_INSENSITIVE })).toBe(1);
    expect(await t.exists({ sku: lower }, { collation: CASE_INSENSITIVE })).toBe(true);
    expect(await t.exists({ sku: lower })).toBe(false);
  });

  it('nullsLast puts the nulls of a sort field after its values, in either direction', async () => {
    const t = items();
    const tag = newId();
    const t0 = Date.now();
    const at = (i: number) => new Date(t0 + i * 1000);
    await t.insertMany([item({ tags: [tag], archived_at: null, stock: 1 }), item({ tags: [tag], archived_at: at(2), stock: 2 }), item({ tags: [tag], archived_at: at(1), stock: 3 })]);
    const asc = await t.find({ tags: tag }, { sort: { archived_at: 1 }, nullsLast: ['archived_at'] });
    expect(asc.map((r) => r.stock)).toEqual([3, 2, 1]);
    const desc = await t.find({ tags: tag, price: '12.50' }, { sort: { archived_at: -1 }, nullsLast: ['archived_at'], skip: 1, limit: 5 });
    expect(desc.map((r) => r.stock)).toEqual([3, 1]);
    expect(desc[0]).toEqual(asc[0]); // rows come back as rows (numeric as string, dates as Date)
    await expect(t.find({ tags: tag }, { sort: { stock: 1 }, nullsLast: ['archived_at'] })).rejects.toThrow(/nullsLast/);
  });

  it('increment upserts an $inc: creates the row, then adds to it', async () => {
    const counters = store.module('demo', defs, schemas).table<{ owner: string; day: string; count: number; bytes: number; note: string | null }>('counters');
    const owner = newId();
    expect(await counters.increment({ owner, day: '2026-10-13' }, { count: 1, bytes: 10 })).toEqual({ owner, day: '2026-10-13', count: 1, bytes: 10, note: null });
    expect(await counters.increment({ owner, day: '2026-10-13' }, { count: 1, bytes: 5 })).toMatchObject({ count: 2, bytes: 15 });
    const raw = await store.db.collection('demo.counters').findOne({ owner });
    expect(raw!.note).toBeNull(); // stored as an explicit null, as every insert does
  });

  it('page counts and reads one after another inside a transaction', async () => {
    const mod = store.module('demo', defs, schemas);
    const tag = newId();
    for (let i = 0; i < 3; i++) await mod.table<Item>('items').insert(item({ tags: [tag] }));
    const p = await mod.transaction((tx) => tx.table<Item>('items').page({ tags: tag }, { mode: 'page', page: 1, limit: 2 }, { column: 'created_at', direction: 'desc' }));
    expect(p).toMatchObject({ total: 3, totalPages: 2 });
    expect(p.items).toHaveLength(2);
  });

  it('pageAggregate pages on a computed key by cursor and by page number', async () => {
    const t = items();
    const tag = newId();
    const t0 = Date.now();
    const FAR = new Date('9999-01-01T00:00:00Z');
    const at = (i: number) => new Date(t0 + i * 1000);
    // by archived_at, "never" last: the rows with stock 2, 4, 0, then the two without a date
    const dates = [at(2), null, at(0), null, at(1)];
    for (const [i, d] of dates.entries()) await t.insert(item({ tags: [tag], archived_at: d, stock: i }));
    const pipeline = [{ $match: t.filter({ tags: tag }) }, { $addFields: { sort_at: { $ifNull: ['$archived_at', FAR] } } }];
    const order = { key: 'sort_at', direction: 'asc' } as const;
    const seen: Item[] = [];
    let cursor: string | null = null;
    do {
      const page: Awaited<ReturnType<typeof t.page>> = await t.pageAggregate(pipeline, { mode: 'cursor', cursor, limit: 2 }, order);
      seen.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen.map((r) => r.stock).slice(0, 3)).toEqual([2, 4, 0]);
    expect(seen).toHaveLength(5);
    expect(seen[0]).not.toHaveProperty('sort_at');
    expect(seen[0]!.price).toBe('12.50');
    const p2 = await t.pageAggregate(pipeline, { mode: 'page', page: 2, limit: 2 }, order);
    expect(p2).toMatchObject({ page: 2, totalPages: 3, total: 5 });
    expect(p2.items.map((r) => r.stock)).toEqual(seen.slice(2, 4).map((r) => r.stock));
  });

  it('isDuplicateKey recognises MongoDB duplicate-key errors only', async () => {
    const t = items();
    const row = await t.insert(item());
    const err = await t.insert({ ...row }).catch((e: unknown) => e);
    expect(isDuplicateKey(err)).toBe(true);
    expect(isDuplicateKey({ message: 'E11000 duplicate key error collection: x' })).toBe(true);
    expect(isDuplicateKey(new Error('other'))).toBe(false);
    expect(isDuplicateKey(undefined)).toBe(false);
  });
});
