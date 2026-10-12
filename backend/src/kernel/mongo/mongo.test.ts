/**
 * The MongoDB layer (docs/04-mongodb-migration.md): schema from the spec's notation, row ↔ document conversion,
 * filters, paging, upserts, transactions with lock-by-write, the inbox and named locks.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { collectionDefs } from '../../../tools/lib/mongo.js';
import { planTables } from '../../../tools/lib/sql.js';
import type { ModuleSpec } from '../../../tools/lib/spec.js';
import { testMongo } from '../../testing/mongo.js';
import { newId } from '../lib/ids.js';
import type { CollectionDef } from '../spec/define.js';
import { Schema } from 'mongoose';
import type { ModuleSchemas, MongoStore } from './index.js';
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
  for (const [table, schema] of [['items', items], ['links', links]] as const) {
    for (const i of d[table]!.indexes) schema.index(i.key, { name: i.name, ...(i.unique ? { unique: true } : {}), ...(i.partial ? { partialFilterExpression: i.partial } : {}), ...(i.collation ? { collation: i.collation } : {}) });
  }
  return { items, links };
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

  it('keeps PostgreSQL null rules: several null values in a unique nullable column, a case-insensitive unique index', async () => {
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
    expect(defs.items!.indexes.find((i) => !i.unique && i.partial)!.partial).toEqual({ archived_at: { $type: 'null' } });
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
});
