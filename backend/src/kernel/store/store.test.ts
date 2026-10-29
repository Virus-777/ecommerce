/**
 * The store contract (kernel/store/index.ts): **one** set of tests, run twice — once on MongoDB and once on
 * MySQL — over one spec. That is the whole claim of §23 Y1's "a module chooses store: 'mongo' | 'mysql'": a
 * repository written in the neutral vocabulary means the same thing on either database.
 *
 * Both sides are built from the same `demo` module spec by the generator's own libraries: the MongoDB
 * collections by `collectionDefs`, the MySQL tables and their runtime defs by `moduleDdl` and `mysqlTableDefs`.
 * So a difference between the two stores shows up here as a failing assertion, and a `TableDef` that disagrees
 * with the DDL beside it cannot pass either.
 */
import { Schema } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { collectionDefs } from '../../../tools/lib/mongo.js';
import { moduleDdl, mysqlTableDefs } from '../../../tools/lib/mysql.js';
import { planTables } from '../../../tools/lib/tables.js';
import type { ModuleSpec } from '../../../tools/lib/spec.js';
import { testMongo } from '../../testing/mongo.js';
import { testMysql } from '../../testing/mysql.js';
import type { CollectionDef } from '../spec/define.js';
import type { ModuleSchemas, MongoStore } from '../mongo/index.js';
import { migrateMongo } from '../mongo/schema.js';
import { collectionOptions, integer } from '../mongo/schemas.js';
import type { MysqlStore } from '../mysql/index.js';
import { migrateMysql } from '../mysql/schema.js';
import { decToZero, expr, inc, isDuplicateKey, type Store } from './index.js';
import { mongoStore } from './mongo.js';

/* ------------------------------------------------------------------ one spec, two stores */

const demo = {
  name: 'demo',
  tables: [
    {
      name: 'notes',
      columns: {
        id: 'uuid pk',
        owner: 'text',
        status: 'text (draft|live|gone)',
        version: 'int',
        title: 'text?',
        from_at: 'timestamptz',
        to_at: 'timestamptz?',
        tags: 'text[]',
        // a JSON array of objects, which is what an `items[].key` path asks of (settings.changes.items)
        items: 'jsonb?',
        // a JSON column that cannot be null, and so holds `null` as a JSON value (settings.definitions.default_value)
        meta: 'jsonb',
        // the four conversions a TableDef drives, which a def that mis-categorises a column gets wrong
        price: 'numeric(10,2)',
        pinned: 'bool',
        body_hash: 'bytea?',
        on_day: 'date?',
      },
      indexes: ['(owner, status)'],
    },
    { name: 'tallies', columns: { owner: 'text', day: 'text', n: 'int' }, indexes: ['pk (owner, day)'] },
    // the one shape audit.entries has: the server numbers seq, the row is keyed on a uuid
    { name: 'entries', columns: { id: 'uuid pk', seq: 'bigint unique (identity)', label: 'text' } },
  ],
} as unknown as ModuleSpec;

interface Note {
  id: string;
  owner: string;
  status: string;
  version: number;
  title: string | null;
  from_at: Date;
  to_at: Date | null;
  tags: string[];
  items: { key: string; n: number }[] | null;
  meta: unknown;
  price: string;
  pinned: boolean;
  body_hash: Uint8Array | null;
  on_day: string | null;
}
interface Tally {
  owner: string;
  day: string;
  n: number;
}
interface Entry {
  id: string;
  seq: number;
  label: string;
}

/** The demo module's Mongoose schemas, as the generator writes them */
function demoSchemas(d: Record<string, CollectionDef>): ModuleSchemas {
  const notes = new Schema(
    {
      _id: { type: String, required: true },
      owner: { type: String, required: true },
      status: { type: String, required: true, enum: ['draft', 'live', 'gone'] },
      version: { type: Number, required: true, validate: integer },
      title: { type: String, default: null },
      from_at: { type: Date, required: true },
      to_at: { type: Date, default: null },
      tags: { type: [String], default: undefined },
      items: { type: Schema.Types.Mixed, default: null },
      meta: { type: Schema.Types.Mixed },
      price: { type: Schema.Types.Decimal128, required: true },
      pinned: { type: Boolean, required: true },
      body_hash: { type: Buffer, default: null },
      on_day: { type: String, default: null },
      _lock: Number,
    },
    collectionOptions('demo.notes'),
  );
  const tallies = new Schema(
    { owner: { type: String, required: true }, day: { type: String, required: true }, n: { type: Number, required: true, validate: integer }, _lock: Number },
    collectionOptions('demo.tallies', { generatedId: true }),
  );
  const entries = new Schema({ _id: { type: String, required: true }, seq: { type: Number, required: true, validate: integer }, label: { type: String, required: true }, _lock: Number }, collectionOptions('demo.entries'));
  for (const [table, schema] of [
    ['notes', notes],
    ['tallies', tallies],
    ['entries', entries],
  ] as const) {
    for (const i of d[table]!.indexes) schema.index(i.key, { name: i.name, ...(i.unique ? { unique: true } : {}), ...(i.partial ? { partialFilterExpression: i.partial } : {}) });
  }
  return { notes, tallies, entries };
}

let mongo: MongoStore;
let mysql: MysqlStore;
const stores: Record<string, () => Store> = {};

const at = (iso: string) => new Date(iso);
const JAN = at('2026-01-10T00:00:00.000Z');
const FEB = at('2026-02-10T00:00:00.000Z');
const MAR = at('2026-03-10T00:00:00.000Z');

beforeAll(async () => {
  const problems: string[] = [];
  const plans = planTables(demo, problems);
  const collections = collectionDefs(demo, plans, problems) as Record<string, CollectionDef>;
  expect(problems, 'the demo spec itself').toEqual([]);
  const schemas = demoSchemas(collections);
  const tables = mysqlTableDefs(demo, plans);

  [mongo, mysql] = await Promise.all([testMongo(), testMysql()]);
  await migrateMongo(mongo, [{ module: 'demo', collections, schemas }]);
  // the slot's database outlives the run, and this spec is a fixture that changes: start from no demo tables
  await mysql.pool.query('SET FOREIGN_KEY_CHECKS = 0');
  for (const t of ['demo_notes', 'demo_tallies', 'demo_entries']) await mysql.pool.query(`DROP TABLE IF EXISTS \`${t}\``);
  await mysql.pool.query('SET FOREIGN_KEY_CHECKS = 1');
  await mysql.pool.query('DELETE FROM `kernel_migrations` WHERE `id` LIKE ?', ['demo/%']);
  const ddl = moduleDdl(demo);
  await migrateMysql(mysql, [{ module: 'demo', tables: ddl.tables.map((t) => t.schema) }]);

  stores.mongo = () => mongoStore(mongo.module('demo', collections, schemas));
  stores.mysql = () => mysql.module('demo', tables);
}, 120_000);

afterAll(async () => {
  await Promise.all([mongo?.close(), mysql?.close()]);
});

const note = (id: string, o: Partial<Note> = {}): Note => ({
  id,
  owner: 'ann',
  status: 'live',
  version: 1,
  title: null,
  from_at: JAN,
  to_at: null,
  tags: [],
  items: null,
  meta: { of: 'n1' },
  price: '12.50',
  pinned: false,
  body_hash: null,
  on_day: null,
  ...o,
});

/** Group rows in a stable order: neither store promises one, and the assertion needs to be readable */
const sortRows = <T extends object>(rows: readonly T[], column: string): T[] =>
  [...rows].sort((a, b) => String((a as Record<string, unknown>)[column]).localeCompare(String((b as Record<string, unknown>)[column])));

describe.each(['mongo', 'mysql'])('%s', (kind) => {
  let store: Store;
  const notes = () => store.table<Note>('notes');
  const tallies = () => store.table<Tally>('tallies');

  beforeEach(async () => {
    store = stores[kind]!();
    await notes().deleteMany({});
    await tallies().deleteMany({});
    await store.table<Entry>('entries').deleteMany({});
  });

  /* ---------------------------------------------------------------- filters */

  it('reads back what it wrote, with the types the spec gives', async () => {
    const written = await notes().insert(note('n1', { title: 'One', to_at: FEB, tags: ['a', 'b'], version: 3 }));
    expect(written).toMatchObject({ id: 'n1', owner: 'ann', status: 'live', version: 3, title: 'One', tags: ['a', 'b'] });
    expect(written.from_at.toISOString()).toBe(JAN.toISOString());
    expect(written.to_at?.toISOString()).toBe(FEB.toISOString());
    expect((await notes().get('n1'))?.title).toBe('One');
  });

  it('keeps the JS type of every column the def categorises', async () => {
    const digest = new Uint8Array(32).fill(7);
    await notes().insert(note('n1', { price: '1234.56', pinned: true, body_hash: digest, on_day: '2026-01-10', tags: ['x'] }));
    const row = (await notes().get('n1'))!;
    // a DECIMAL is exact, so a string both ways: 1234.56 as a float is not 1234.56
    expect(row.price).toBe('1234.56');
    expect(row.pinned).toBe(true);
    expect(row.body_hash).toBeInstanceOf(Uint8Array);
    expect([...(row.body_hash as Uint8Array)]).toEqual([...digest]);
    // a Buffer *is* a Uint8Array, so the instance check alone would pass on the driver's own buffer: the row
    // gets a copy, which is what stops a column keeping a view on memory the driver reuses
    expect(Buffer.isBuffer(row.body_hash)).toBe(false);
    // a DATE is a day, not an instant: it has no time zone to be read in
    expect(row.on_day).toBe('2026-01-10');
    expect(row.tags).toEqual(['x']);
    // and a row that leaves them out reads back as null, not undefined
    await notes().insert(note('n2'));
    expect(await notes().get('n2')).toMatchObject({ body_hash: null, on_day: null, pinned: false });
  });

  it('filters by value, list, null and an operator', async () => {
    await notes().insertMany([
      note('n1', { status: 'draft', version: 1 }),
      note('n2', { status: 'live', version: 5, title: 'Two', to_at: FEB }),
      note('n3', { status: 'gone', version: 9, owner: 'bo' }),
    ]);
    const ids = async (where: Record<string, unknown>) => (await notes().find(where as never, { sort: { id: 1 } })).map((r) => r.id);

    expect(await ids({ status: 'live' })).toEqual(['n2']);
    expect(await ids({ status: ['draft', 'gone'] })).toEqual(['n1', 'n3']);
    expect(await ids({ title: null })).toEqual(['n1', 'n3']);
    expect(await ids({ version: { op: '>=', value: 5 } })).toEqual(['n2', 'n3']);
    expect(await ids({ version: { op: 'between', value: [2, 8] } })).toEqual(['n2']);
    // `<>` skips nulls, which is what it has always meant here (SQL's reading)
    expect(await ids({ title: { op: '<>', value: 'Two' } })).toEqual([]);
    // and so do the four comparisons, on **both** stores: MongoDB's query operators are type-bracketed, so
    // `$lte: <a date>` never matches a document whose field is null. A conversion therefore does not need an
    // `is not null` beside a date comparison — which is worth having a test say, because the reverse was
    // written in a comment once and believed (§10.5e)
    expect(await ids({ to_at: { op: '<=', value: MAR } })).toEqual(['n2']);
    expect(await ids({ to_at: { op: '>', value: JAN } })).toEqual(['n2']);
    // "is distinct from" does match nulls
    expect(await ids({ title: { op: 'is not', value: 'Two' } })).toEqual(['n1', 'n3']);
    expect(await ids({ status: { op: 'not in', value: ['draft'] } })).toEqual(['n2', 'n3']);
    // an empty list matches nothing; an empty `not in` filters nothing
    expect(await ids({ status: [] })).toEqual([]);
    expect(await ids({ status: { op: 'not in', value: [] } })).toEqual(['n1', 'n2', 'n3']);
  });

  it('ors a list of alternatives, anded with the columns beside it', async () => {
    await notes().insertMany([
      note('n1', { status: 'draft', to_at: null }),
      note('n2', { status: 'live', to_at: MAR }),
      note('n3', { status: 'live', to_at: FEB, owner: 'bo' }),
    ]);
    const ids = async (where: Record<string, unknown>) => (await notes().find(where as never, { sort: { id: 1 } })).map((r) => r.id);

    // the shape every effective-dated read uses: in force at a moment
    expect(await ids({ from_at: { op: '<=', value: FEB }, or: [{ to_at: null }, { to_at: { op: '>', value: FEB } }] })).toEqual(['n1', 'n2']);
    // anded with the rest: owner narrows the or
    expect(await ids({ owner: 'ann', or: [{ status: 'draft' }, { status: 'gone' }] })).toEqual(['n1']);
    // an or of nothing can be satisfied by nothing
    expect(await ids({ or: [] })).toEqual([]);
  });

  it('asks a JSON array whether some element matches', async () => {
    await notes().insertMany([
      note('n1', { tags: ['red', 'blue'], items: [{ key: 'a.x', n: 1 }, { key: 'b.y', n: 2 }] }),
      note('n2', { tags: ['blue'], items: [{ key: 'c.z', n: 3 }], owner: 'bo' }),
      note('n3', { tags: [], items: [] }),
    ]);
    const ids = async (where: Record<string, unknown>) => (await notes().find(where as never, { sort: { id: 1 } })).map((r) => r.id);

    // a field of the objects in the array: "some item of this note is about that key"
    expect(await ids({ 'items[].key': 'a.x' })).toEqual(['n1']);
    expect(await ids({ 'items[].key': ['a.x', 'c.z'] })).toEqual(['n1', 'n2']);
    expect(await ids({ 'items[].key': 'nope' })).toEqual([]);
    // "any of none", as an empty list is everywhere else here
    expect(await ids({ 'items[].key': [] })).toEqual([]);
    // the array's own elements, which is what a path with no field asks
    expect(await ids({ 'tags[]': 'blue' })).toEqual(['n1', 'n2']);
    expect(await ids({ 'tags[]': ['red', 'none'] })).toEqual(['n1']);
    // anded with the ordinary columns beside it
    expect(await ids({ owner: 'ann', 'tags[]': 'blue' })).toEqual(['n1']);
    // a number reads back as one: the extraction is JSON, not text
    expect(await ids({ 'items[].n': 3 })).toEqual(['n2']);
    // an empty array, and a null column, hold no element that matches anything
    expect(await ids({ 'items[].key': 'a.x', or: [{ id: 'n1' }, { id: 'n3' }] })).toEqual(['n1']);

    // an operator and null mean nothing on a path, on either store, and say so rather than guessing
    await expect(notes().find({ 'items[].key': { op: '<', value: 'z' } } as never)).rejects.toThrow(/is a \[\] path/);
    await expect(notes().find({ 'items[].key': null } as never)).rejects.toThrow(/is a \[\] path/);
  });

  it('asks whether one element of a JSON array holds several fields', async () => {
    // the shape workqueues' related_subjects has: an array of {type, id} pairs, where both have to be true
    // of the *same* element — `items.type = t AND items.id = i` can be satisfied by two different elements
    await notes().insertMany([
      note('n1', { items: [{ key: 'a', n: 1 }, { key: 'b', n: 2 }] as never }),
      note('n2', { items: [{ key: 'a', n: 2 }] as never }),
      note('n3', { items: [] }),
    ]);
    const ids = async (where: Record<string, unknown>) => (await notes().find(where as never, { sort: { id: 1 } })).map((r) => r.id);

    expect(await ids({ 'items[]': { key: 'a', n: 1 } })).toEqual(['n1']);
    expect(await ids({ 'items[]': { key: 'b', n: 2 } })).toEqual(['n1']);
    // n2 has both values, in one element each, and neither element has both
    expect(await ids({ 'items[]': { key: 'a', n: 2 } })).toEqual(['n2']);
    expect(await ids({ 'items[]': { key: 'b', n: 1 } })).toEqual([]);
    // the two dotted paths would answer differently, which is the whole reason this exists
    expect(await ids({ and: [{ 'items[].key': 'b' }, { 'items[].n': 1 }] })).toEqual(['n1']);
    // a subset of an element's fields matches it, on both stores
    expect(await ids({ 'items[]': { key: 'a' } })).toEqual(['n1', 'n2']);
    // and an object on a path that already names one field is a mistake, not a second meaning
    await expect(notes().find({ 'items[].key': { key: 'a' } } as never)).rejects.toThrow(/takes a value and not an object/);
  });

  it('takes a dotted path only into a JSON column, on the store that has to know which', async () => {
    await notes().insert(note('n1', { meta: { passed: true } }));
    // MongoDB reads a dotted path on any field and cannot tell a typo from a document; MySQL is given the
    // table's JSON columns, so it refuses one rather than asking for a column nobody has
    const read = notes().find({ 'owner.passed': true } as never);
    if (kind === 'mysql') await expect(read).rejects.toThrow(/owner is not a JSON column/);
    else expect(await read).toEqual([]);
  });

  it('matches the text a search box was given, ignoring case', async () => {
    await notes().insertMany([
      note('n1', { title: 'Spring Sale' }),
      note('n2', { title: 'spring cleaning' }),
      note('n3', { title: 'Autumn' }),
      note('n4'),
      note('n5', { title: '50% off' }),
    ]);
    const ids = async (where: Record<string, unknown>) => (await notes().find(where as never, { sort: { id: 1 } })).map((r) => r.id);

    expect(await ids({ title: { op: 'contains', value: 'SPRING' } })).toEqual(['n1', 'n2']);
    // spaces around what was typed never mean anything
    expect(await ids({ title: { op: 'contains', value: '  sale ' } })).toEqual(['n1']);
    expect(await ids({ title: { op: 'starts with', value: 'spring' } })).toEqual(['n1', 'n2']);
    expect(await ids({ title: { op: 'starts with', value: 'ale' } })).toEqual([]);
    expect(await ids({ title: { op: 'equals ignoring case', value: 'autumn' } })).toEqual(['n3']);
    expect(await ids({ title: { op: 'equals ignoring case', value: 'autum' } })).toEqual([]);
    // a typed % is a per-cent sign and a typed . is a full stop: the term is matched literally
    expect(await ids({ title: { op: 'contains', value: '%' } })).toEqual(['n5']);
    expect(await ids({ title: { op: 'contains', value: '5_%' } })).toEqual([]);
    // and a title nobody set matches none of them
    expect(await ids({ title: { op: 'contains', value: 'a' } })).toEqual(['n1', 'n2', 'n3']);
    expect(await ids({ title: { op: 'contains', value: null } })).toEqual([]);
  });

  it('asks a path into a JSON object, with the null rules of the operator used', async () => {
    // the shape media's asset list filters on: a result document with a flag inside it
    await notes().insertMany([
      note('n1', { meta: { passed: true, by: 'ann', score: 9 } }),
      note('n2', { meta: { passed: false, by: 'bo', score: 3 } }),
      note('n3', { meta: { by: 'cy' } }),
      note('n4', { meta: { passed: null, by: 'cy' } }),
      note('n5', { meta: null }),
      note('n6', { meta: { by: null } }),
    ]);
    const ids = async (where: Record<string, unknown>) => (await notes().find(where as never, { sort: { id: 1 } })).map((r) => r.id);

    // a value, and a boolean stays a boolean: `->>` would have made it the string 'true'
    expect(await ids({ 'meta.passed': true })).toEqual(['n1']);
    expect(await ids({ 'meta.passed': false })).toEqual(['n2']);
    expect(await ids({ 'meta.by': ['ann', 'cy'] })).toEqual(['n1', 'n3', 'n4']);
    // a number compares as a number
    expect(await ids({ 'meta.score': { op: '>=', value: 5 } })).toEqual(['n1']);
    expect(await ids({ 'meta.score': { op: 'between', value: [3, 9] } })).toEqual(['n1', 'n2']);
    // null is "not set, or set to null" — the two MongoDB cannot tell apart, and neither can a filter here
    expect(await ids({ 'meta.passed': null })).toEqual(['n3', 'n4', 'n5', 'n6']);
    // `<>` keeps SQL's reading: a field that is missing or null is not "different from true"
    expect(await ids({ 'meta.passed': { op: '<>', value: true } })).toEqual(['n2']);
    // `is not` is "is distinct from", which is what MongoDB's own $ne means: those rows do match
    expect(await ids({ 'meta.passed': { op: 'is not', value: true } })).toEqual(['n2', 'n3', 'n4', 'n5', 'n6']);
    expect(await ids({ 'meta.passed': { op: 'is not', value: null } })).toEqual(['n1', 'n2']);
    // `not in` skips a field that is null as well as one that is missing, as it skips a null column
    expect(await ids({ 'meta.by': { op: 'not in', value: ['ann', 'bo'] } })).toEqual(['n3', 'n4']);
    expect(await ids({ 'meta.by': { op: 'like', value: 'c%' } })).toEqual(['n3', 'n4']);
    // and it ands with the columns beside it
    expect(await ids({ owner: 'ann', 'meta.passed': true })).toEqual(['n1']);
  });

  it('keeps null in a JSON column that cannot be null, and finds it again', async () => {
    // A setting declared with no default is null, and null is a JSON document: the column is `jsonb` with no
    // `?`, so there is nowhere for SQL NULL to go. MongoDB has one null for both and never had to tell them
    // apart, which is why this is the first thing the first module to move ran into.
    await notes().insertMany([note('n1', { meta: null }), note('n2', { meta: { cap: 5 } }), note('n3', { meta: 0 })]);
    expect(await notes().get('n1')).toMatchObject({ meta: null });
    expect((await notes().get('n2'))?.meta).toEqual({ cap: 5 });
    // 0 and false are JSON values too, and neither is null
    expect((await notes().get('n3'))?.meta).toBe(0);

    const ids = async (where: Record<string, unknown>) => (await notes().find(where as never, { sort: { id: 1 } })).map((r) => r.id);
    expect(await ids({ meta: null })).toEqual(['n1']);
    expect(await ids({ meta: { op: 'is not', value: null } })).toEqual(['n2', 'n3']);
    // and a patch writes it the same way an insert does
    await notes().update('n2', { meta: null });
    expect(await ids({ meta: null })).toEqual(['n1', 'n2']);
  });

  it('ands a list of conditions, for what one filter object cannot say twice', async () => {
    await notes().insertMany([
      note('n1', { items: [{ key: 'a.x', n: 1 }, { key: 'b.y', n: 2 }] }),
      note('n2', { items: [{ key: 'a.x', n: 1 }] }),
    ]);
    const ids = async (where: Record<string, unknown>) => (await notes().find(where as never, { sort: { id: 1 } })).map((r) => r.id);

    // two conditions on one name: a key *and* a key of a section (settings' change list)
    expect(await ids({ and: [{ 'items[].key': 'a.x' }, { 'items[].key': 'b.y' }] })).toEqual(['n1']);
    expect(await ids({ and: [{ 'items[].key': 'a.x' }, { 'items[].key': 'c.z' }] })).toEqual([]);
    // anded with the columns beside it, and each branch may hold an `or` of its own
    expect(await ids({ status: 'live', and: [{ or: [{ id: 'n1' }, { id: 'n9' }] }] })).toEqual(['n1']);
    // all of no conditions is every row (and MongoDB refuses an empty $and, so this is not nothing)
    expect(await ids({ and: [] })).toEqual(['n1', 'n2']);
  });

  it('counts, tests existence and lists distinct values', async () => {
    await notes().insertMany([note('n1', { owner: 'ann' }), note('n2', { owner: 'bo' }), note('n3', { owner: 'bo' })]);
    expect(await notes().count({ owner: 'bo' })).toBe(2);
    expect(await notes().count()).toBe(3);
    expect(await notes().exists({ owner: 'cy' })).toBe(false);
    expect((await notes().distinct<string>('owner')).sort()).toEqual(['ann', 'bo']);
  });

  it('passes over the first rows of a read, by the same name on both stores', async () => {
    await notes().insertMany([note('n1'), note('n2'), note('n3'), note('n4')]);
    const ids = async (o: Record<string, unknown>) => (await notes().find({}, { sort: { id: 1 }, ...o } as never)).map((r) => r.id);

    expect(await ids({ offset: 1 })).toEqual(['n2', 'n3', 'n4']);
    expect(await ids({ offset: 2, limit: 1 })).toEqual(['n3']);
    // the shape that found this: "the row after the ones we keep", which decides a retention cut-off
    expect(await ids({ offset: 3, limit: 1 })).toEqual(['n4']);
    expect(await ids({ offset: 9 })).toEqual([]);
    expect(await ids({ offset: 0 })).toEqual(['n1', 'n2', 'n3', 'n4']);
  });

  it('counts rows per key, by one column and by two', async () => {
    await notes().insertMany([
      note('n1', { owner: 'ann', status: 'live' }),
      note('n2', { owner: 'bo', status: 'live' }),
      note('n3', { owner: 'bo', status: 'draft' }),
      note('n4', { owner: 'bo', status: 'draft' }),
    ]);
    expect(sortRows(await notes().countBy(['owner']), 'owner')).toEqual([
      { owner: 'ann', n: 1 },
      { owner: 'bo', n: 3 },
    ]);
    // a filter first, then two columns as the key
    expect(sortRows(await notes().countBy(['owner', 'status'], { owner: 'bo' }), 'status')).toEqual([
      { owner: 'bo', status: 'draft', n: 2 },
      { owner: 'bo', status: 'live', n: 1 },
    ]);
    // nothing matching is no rows: a count of nothing has no key to report it under
    expect(await notes().countBy(['owner'], { owner: 'cy' })).toEqual([]);
  });

  it('counts the rows with no value as one group, and refuses a column the table has not got', async () => {
    await notes().insertMany([note('n1', { title: 'One' }), note('n2'), note('n3')]);
    // null is a key like any other, which is SQL's GROUP BY and MongoDB's $group over a missing field
    expect(sortRows(await notes().countBy(['title']), 'title')).toEqual([
      { title: null, n: 2 },
      { title: 'One', n: 1 },
    ]);
    await expect(notes().countBy(['nope' as never])).rejects.toThrow(/has no column nope/);
    await expect(notes().countBy([])).rejects.toThrow(/countBy needs a column/);
  });

  it('totals an integer column, and refuses a money one', async () => {
    await notes().insertMany([note('n1', { version: 2 }), note('n2', { version: 40, owner: 'bo' })]);
    expect(await notes().sum('version')).toBe(42);
    expect(await notes().sum('version', { owner: 'bo' })).toBe(40);
    // no rows is 0 — not undefined, and not a row with nothing in it
    expect(await notes().sum('version', { owner: 'cy' })).toBe(0);
    await expect(notes().sum('price')).rejects.toThrow(/sum\(\) would round it/);
  });

  /* ---------------------------------------------------------------- patches */

  it('writes plain values, and an inc the server computes', async () => {
    await notes().insert(note('n1', { version: 1 }));
    expect((await notes().update('n1', { title: 'Named', status: 'draft' }))?.title).toBe('Named');
    expect((await notes().update('n1', { version: inc('version', 2) }))?.version).toBe(3);
    // the point of inc: two writers both count, neither reading the value first
    await Promise.all([notes().update('n1', { version: inc('version', 1) }), notes().update('n1', { version: inc('version', 1) })]);
    expect((await notes().get('n1'))?.version).toBe(5);
  });

  it('updates and deletes many by filter', async () => {
    await notes().insertMany([note('n1', { status: 'draft' }), note('n2', { status: 'draft' }), note('n3', { status: 'live' })]);
    expect(await notes().updateMany({ status: 'draft' }, { status: 'live' })).toBe(2);
    expect(await notes().count({ status: 'live' })).toBe(3);
    expect(await notes().deleteMany({ owner: 'ann' })).toBe(3);
  });

  it('increments a composite-key row into existence', async () => {
    expect(await tallies().increment({ owner: 'ann', day: '2026-01-10' }, { n: 1 })).toMatchObject({ owner: 'ann', day: '2026-01-10', n: 1 });
    expect(await tallies().increment({ owner: 'ann', day: '2026-01-10' }, { n: 4 })).toMatchObject({ n: 5 });
  });

  it('lets the server number an identity column', async () => {
    const entries = () => store.table<Entry>('entries');
    const first = await entries().insert({ id: 'e1', label: 'one' });
    const second = await entries().insert({ id: 'e2', label: 'two' });
    expect(typeof first.seq).toBe('number');
    expect(second.seq).toBe(first.seq + 1);
    expect((await entries().get('e1'))?.seq).toBe(first.seq);
  });

  it('upserts by key', async () => {
    await notes().upsert(note('n1', { title: 'First' }));
    await notes().upsert(note('n1', { title: 'Second' }));
    expect(await notes().count()).toBe(1);
    expect((await notes().get('n1'))?.title).toBe('Second');
  });

  it('says when a unique key refused a write, in the same words for both databases', async () => {
    await notes().insert(note('n1'));
    // the shape a repository that races on a unique key uses: insert, and read the error
    const err = await notes()
      .insert(note('n1'))
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(err, 'a second row with the same primary key is refused').toBeDefined();
    expect(isDuplicateKey(err)).toBe(true);
    // and it is not every error: a column the table has not got is a different kind of wrong
    const other = await notes()
      .insert({ nope: 1 } as never)
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(other).toBeDefined();
    expect(isDuplicateKey(other)).toBe(false);
  });

  it('inserts only what is absent', async () => {
    expect(await notes().insertIfAbsent(note('n1'))).toBeTruthy();
    expect(await notes().insertIfAbsent(note('n1'))).toBeUndefined();
    expect(await notes().insertManyIfAbsent([note('n1'), note('n2')])).toBe(1);
  });

  /* ---------------------------------------------------------------- transactions, locks, the inbox */

  it('commits together and rolls back together', async () => {
    await store.transaction(async (tx) => {
      await tx.table<Note>('notes').insert(note('n1'));
      await tx.table<Tally>('tallies').insert({ owner: 'ann', day: '2026-01-10', n: 1 });
    });
    expect(await notes().count()).toBe(1);

    await expect(
      store.transaction(async (tx) => {
        await tx.table<Note>('notes').insert(note('n2'));
        throw new Error('no');
      }),
    ).rejects.toThrow('no');
    expect(await notes().count()).toBe(1);
  });

  it('knows whether it is in a transaction, and a nested transaction joins the outer one', async () => {
    expect(store.inTransaction).toBe(false);
    await store.transaction(async (tx) => {
      expect(tx.inTransaction).toBe(true);
      await tx.transaction(async (inner) => {
        expect(inner.inTransaction).toBe(true);
        await inner.table<Note>('notes').insert(note('n1'));
      });
      throw new Error('rolled back');
    }).catch(() => undefined);
    expect(await notes().count(), 'the inner work was part of the outer transaction').toBe(0);
  });

  it('reads a row for update inside a transaction', async () => {
    await notes().insert(note('n1', { version: 1 }));
    await store.transaction(async (tx) => {
      const row = await tx.table<Note>('notes').findOne({ id: 'n1' }, { forUpdate: true });
      await tx.table<Note>('notes').update('n1', { version: row!.version + 1 });
    });
    expect((await notes().get('n1'))?.version).toBe(2);
  });

  it('serialises a transaction on a name', async () => {
    await store.transaction(async (tx) => {
      await tx.lock('notes');
      await tx.table<Note>('notes').insert(note('n1'));
    });
    expect(await notes().count()).toBe(1);
    await expect(store.lock('notes')).rejects.toThrow(/outside a transaction/);
  });

  it('claims an event key once', async () => {
    const key = `demo-event-${kind}-${Date.now()}`;
    expect(await store.seen(key)).toBe(false);
    expect(await store.claim(key)).toBe(true);
    expect(await store.claim(key)).toBe(false);
    expect(await store.seen(key)).toBe(true);
  });

  it('numbers a counter', async () => {
    const counter = `demo-${kind}-${Date.now()}`;
    expect(await store.nextValue(counter)).toBe(1);
    expect(await store.nextValues(counter, 3)).toEqual([2, 3, 4]);
  });

  it('pages in a stable order', async () => {
    await notes().insertMany([note('n1'), note('n2'), note('n3')]);
    const first = await notes().page({}, { mode: 'cursor', cursor: null, limit: 2 }, { column: 'id', direction: 'asc' });
    expect(first.items.map((r) => r.id)).toEqual(['n1', 'n2']);
    const next = await notes().page({}, { mode: 'cursor', cursor: first.nextCursor, limit: 2 }, { column: 'id', direction: 'asc' });
    expect(next.items.map((r) => r.id)).toEqual(['n3']);
  });

  it('pages by a date column, where the cursor holds an instant and not a string', async () => {
    await notes().insertMany([note('n1', { from_at: JAN }), note('n2', { from_at: FEB }), note('n3', { from_at: MAR })]);
    const order = { column: 'from_at', direction: 'asc' as const };
    const first = await notes().page({}, { mode: 'cursor', cursor: null, limit: 2 }, order);
    expect(first.items.map((r) => r.id)).toEqual(['n1', 'n2']);
    // the second page is read from a cursor the first page encoded: the def says from_at is a date, so the
    // value in it is turned back into one before it is compared. Treated as a string it compares wrongly.
    const next = await notes().page({}, { mode: 'cursor', cursor: first.nextCursor, limit: 2 }, order);
    expect(next.items.map((r) => r.id)).toEqual(['n3']);
  });
});

/* ------------------------------------------------------------------ what the MongoDB side refuses */

describe('SQL-only expressions on MongoDB', () => {
  it('refuses decToZero and expr by name, rather than writing something that means something else', async () => {
    const store = stores.mongo!();
    await store.table<Note>('notes').deleteMany({});
    await store.table<Note>('notes').insert(note('n1', { version: 5 }));

    await expect(store.table<Note>('notes').update('n1', { version: decToZero('version', 1) })).rejects.toThrow(/decToZero\(version\) is SQL-only/);
    await expect(store.table<Note>('notes').update('n1', { version: expr(() => 'version - 1') })).rejects.toThrow(/expr\(\) on version is SQL/);
    expect((await store.table<Note>('notes').get('n1'))?.version, 'nothing was written').toBe(5);
  });

  it('runs both of them on MySQL, which is where they belong', async () => {
    const store = stores.mysql!();
    await store.table<Note>('notes').deleteMany({});
    await store.table<Note>('notes').insert(note('n1', { version: 5 }));
    expect((await store.table<Note>('notes').update('n1', { version: decToZero('version', 7) }))?.version).toBe(0);
  });
});
