/**
 * A MongoDB module store seen as a `Store` (kernel/store/index.ts): the filters and patches of the neutral
 * vocabulary turned into MongoDB's own, and everything else passed straight through.
 *
 * Why a facade and not a second mode on `kernel/mongo/table.ts`: a MongoDB filter and a neutral Where are both
 * plain objects, and telling them apart by looking would be guesswork on a value a module controls. The
 * thirty-eight modules that still pass MongoDB filters are untouched by this file; a module that moves to the
 * neutral vocabulary gets a store that speaks only it.
 *
 * What it refuses, and why that is the point: `decToZero` is `GREATEST(col - n, 0)` and `expr` is SQL. Both
 * have MongoDB spellings (an aggregation pipeline), but a pipeline's field names are *document* fields, and the
 * mapping from a spec column to a document field lives inside `Table`. Writing one from out here would be
 * right until a column were renamed, and then quietly wrong. So they throw, by name, with the one thing the
 * caller can do about it.
 */
import type { Page } from '../../spec/common.js';
import type { KeysetOrder, PageRequest } from '../lib/pagination.js';
import { whereFilter } from '../mongo/filters.js';
import type { ModuleStore as MongoModuleStore } from '../mongo/index.js';
import type { Filter, Table as MongoTable } from '../mongo/table.js';
import { isExpr, type Expr, type Patch } from '../mysql/table.js';
import type { Store, StoreFindOptions, StoreTable, UpsertRow, WhereWithOr } from './index.js';

/** The neutral filter as a MongoDB filter. `undefined` is "no filter", which is every row. */
const filterOf = <R>(where: WhereWithOr<R> | undefined): Filter => (where ? whereFilter(where as Readonly<Record<string, unknown>>) : {});

const unsupported = (column: string, e: Expr): Error =>
  new Error(
    e.intent?.kind === 'decToZero'
      ? `store(mongo): decToZero(${column}) is SQL-only in a neutral repository; read the row under its lock and write the result, or keep this repository on one store`
      : `store(mongo): expr() on ${column} is SQL; a repository that uses it is not store-neutral`,
  );

/**
 * A neutral patch as a MongoDB update. Plain values are `$set`, `inc` is `$inc` and `jsonAppend` is `$push` —
 * all three are operators, so `Table` maps their field names as it always has.
 */
function updateOf<R>(patch: Patch<R>): Record<string, unknown> {
  const set: Record<string, unknown> = {};
  const incs: Record<string, number> = {};
  const pushes: Record<string, unknown> = {};
  for (const [column, value] of Object.entries(patch as Record<string, unknown>)) {
    if (value === undefined) continue;
    if (!isExpr(value)) {
      set[column] = value;
      continue;
    }
    const intent = value.intent;
    if (intent?.kind === 'inc') incs[intent.column] = intent.n;
    else if (intent?.kind === 'jsonAppend') pushes[intent.column] = intent.value;
    else throw unsupported(column, value);
  }
  return {
    ...(Object.keys(set).length ? { $set: set } : {}),
    ...(Object.keys(incs).length ? { $inc: incs } : {}),
    ...(Object.keys(pushes).length ? { $push: pushes } : {}),
  };
}

/** The `update` option of an upsert, which MongoDB applies as plain fields: an expression has no place to go */
function plainOf<R>(patch: Patch<R>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [column, value] of Object.entries(patch as Record<string, unknown>)) {
    if (value === undefined) continue;
    if (isExpr(value)) throw unsupported(column, value);
    out[column] = value;
  }
  return out;
}

/**
 * The methods are async even where they only delegate: a filter or a patch this file refuses is a *rejection*,
 * not a synchronous throw, because the interface says the method returns a Promise and a caller's try/catch
 * around an await should see it either way.
 */
function neutralTable<R extends object>(t: MongoTable<R>): StoreTable<R> {
  return {
    get: (id, o) => t.get(id, o),
    findOne: async (where, o) => t.findOne(filterOf(where), o),
    // `offset` is SQL's name for it and this vocabulary's; MongoDB's own option is `skip`
    find: async (where, o: StoreFindOptions = {}) => t.find(filterOf(where), { ...o, ...(o.offset === undefined ? {} : { skip: o.offset }) }),
    getMany: (ids, o) => t.getMany(ids, o),
    count: async (where) => t.count(filterOf(where)),
    exists: async (where) => t.exists(filterOf(where)),
    distinct: async <T>(column: string, where?: WhereWithOr<R>) => t.distinct<T>(column, filterOf(where)),
    countBy: async <K extends keyof R & string>(columns: readonly K[], where?: WhereWithOr<R>) => t.countBy<K>(columns, filterOf(where)),
    sum: async (column: keyof R & string, where?: WhereWithOr<R>) => t.sum(column, filterOf(where)),
    page: async (where, req: PageRequest, order: KeysetOrder): Promise<Page<R>> => t.page(filterOf(where), req, order),
    insert: (row) => t.insert(row),
    insertMany: (rows) => t.insertMany(rows),
    insertIfAbsent: (row, key) => t.insertIfAbsent(row, key),
    insertManyIfAbsent: (rows, key) => t.insertManyIfAbsent(rows, key),
    upsert: async (row, o = {}) => t.upsert(row, { key: o.key, ...(o.update ? { update: plainOf(o.update) } : {}) }),
    upsertMany: async (rows, o = {}) => t.upsertMany(rows, { key: o.key, ...(o.update ? { update: (row: UpsertRow<R>) => plainOf(o.update!(row)) } : {}) }),
    increment: (key, fields) => t.increment(key, fields),
    update: async (id, patch) => t.update(id, updateOf(patch)),
    updateOne: async (where, patch, o) => t.updateOne(filterOf(where), updateOf(patch), o),
    updateMany: async (where, patch) => t.updateMany(filterOf(where), updateOf(patch)),
    delete: (id) => t.delete(id),
    deleteMany: async (where) => t.deleteMany(filterOf(where)),
    // MongoDB has no trigger to be let past: the retention purge is the same delete, under a name that says
    // which table it is allowed on (kernel/mysql/table.ts explains what the name buys on the other store)
    purgeMany: async (where) => t.deleteMany(filterOf(where)),
  };
}

/** The module's MongoDB store, in the vocabulary a store-neutral repository is written in */
export function mongoStore(store: MongoModuleStore): Store {
  const tables = new Map<string, StoreTable<never>>();
  return {
    module: store.module,
    get inTransaction() {
      return store.inTransaction;
    },
    table<R extends object>(name: string): StoreTable<R> {
      let t = tables.get(name);
      if (!t) tables.set(name, (t = neutralTable(store.table<R>(name)) as StoreTable<never>));
      return t as unknown as StoreTable<R>;
    },
    transaction: <T>(fn: (tx: Store) => Promise<T>) => store.transaction((tx) => fn(mongoStore(tx))),
    lock: (name) => store.lock(name),
    claim: (key) => store.claim(key),
    seen: (key) => store.seen(key),
    nextValue: (counter) => store.nextValue(counter),
    nextValues: (counter, n) => store.nextValues(counter, n),
  };
}
