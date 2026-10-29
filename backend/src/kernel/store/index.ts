/**
 * The store a module's repository is written against, in the one vocabulary both stores understand
 * (docs/10-mysql-migration.md §10.5, §23 Y1: "during the transition a module chooses store: 'mongo' | 'mysql'").
 *
 * A repository that takes a `Store` instead of a `ModuleStore` runs on MongoDB and on MySQL without a line of
 * difference, and the contract suite proves it by running the same tests twice. The vocabulary is:
 *
 *   - **filters**: `WhereWithOr<R>` — `{ column: value | list | null | { op, value }, or: [...] }`. It was
 *     defined with SQL's reading of null in the first place (kernel/mongo/filters.ts), which is why there is
 *     one type and not two. A key may also be a `[]` path into a JSON array — `items[].key` is "some element
 *     of items has key = …" — because MongoDB's dotted path and SQL's `MEMBER OF` are the same question asked
 *     of the same column, and only SQL needs telling that the column is an array;
 *   - **patches**: `Patch<R>` — a value per column, or one of the portable expressions `inc` and `jsonAppend`,
 *     which the server computes. `decToZero` and a hand-written `expr` are SQL and the MongoDB side refuses
 *     them by name (see mongo.ts): better a compile-time-looking failure in one place than two writes that do
 *     not mean the same thing.
 *
 * What is deliberately **not** here: `aggregate` and `pageAggregate` (MongoDB pipelines) and `db`/`pageQuery`
 * (Kysely and SQL). A repository needing either is not store-neutral, and says so by taking the store it needs
 * — in Y2 that is a small per-module queries port with one implementation per database (docs/10 §10.5e).
 *
 * Two aggregates are the exception, because they are the same question in both databases and between them
 * cover about half of the census's `$group` sites (docs/10 §13.1): `countBy` (how many rows per key) and
 * `sum` (the total of one integer column). Anything with a join, a window, a second measure or a money
 * column belongs to the queries port, where the SQL and the pipeline can each be what they need to be.
 */
import { isDuplicateKey as isMongoDuplicateKey } from '../mongo/table.js';
import { isDuplicateKey as isMysqlDuplicateKey } from '../mysql/errors.js';
import type { KeysetOrder, PageRequest } from '../lib/pagination.js';

/**
 * Whether a unique key refused this write, whichever database raised it: MongoDB's 11000 or MySQL's 1062.
 *
 * A store-neutral repository that races on a unique key — insert and catch, rather than read and then insert —
 * cannot ask either store's own helper without knowing which store it has, and "which store do I have" is the
 * one question the seam exists to remove. The two tests are cheap and neither can match the other's error,
 * so asking both is the whole of it.
 *
 * Inside a transaction, prefer `insertIfAbsent` or `upsert`: on MongoDB a duplicate-key error takes the whole
 * transaction down with it (§25), which is why the two stores do not spell this the same way underneath.
 */
export const isDuplicateKey = (err: unknown): boolean => isMysqlDuplicateKey(err) || isMongoDuplicateKey(err);
import type { Page } from '../../spec/common.js';
import type { Patch } from '../mysql/table.js';

export type { Cond, JsonArrayPath, JsonObjectPath, Where, WhereWithOr } from '../mongo/filters.js';
export type { Expr, Intent, Patch } from '../mysql/table.js';
export { decToZero, expr, inc, isExpr, jsonAppend } from '../mysql/table.js';

import type { WhereWithOr } from '../mongo/filters.js';

/**
 * The row an upsert's `update` callback is handed: the one the caller passed, read as a row of this table.
 * It is what both stores already pass; saying so is what lets a repository write `{ label: r.label }` without
 * a cast, and `Patch` takes `undefined` for a column the row left out.
 */
export type UpsertRow<R> = Partial<R> & Record<string, unknown>;

/** How strings are read back: both stores take the same options object, and ignore what does not apply */
export interface StoreReadOptions {
  limit?: number;
}

export interface StoreFindOptions extends StoreReadOptions {
  sort?: Readonly<Record<string, 1 | -1>>;
  /**
   * Rows to pass over before the ones wanted — SQL's `OFFSET`, which MongoDB spells `skip` and the facade
   * translates. It was called `skip` here until 2026-10-29, which meant the MySQL table (whose option is
   * `offset`) **silently ignored it**: a read written `{ skip: keep, limit: 1 }` to find a retention cut-off
   * took the newest row instead and a trim deleted everything the owner had, with nothing in the log about
   * it. One name, and it is SQL's, because that is the reading the rest of this vocabulary takes.
   */
  offset?: number;
  forUpdate?: boolean;
}

/**
 * One of a module's spec tables. The methods are the ones both `kernel/mongo/table.ts` and
 * `kernel/mysql/table.ts` already have, with the same meanings, so this interface adds no behaviour of its own.
 */
export interface StoreTable<R extends object> {
  get(id: unknown, o?: { forUpdate?: boolean }): Promise<R | undefined>;
  findOne(where: WhereWithOr<R>, o?: { sort?: Readonly<Record<string, 1 | -1>>; forUpdate?: boolean }): Promise<R | undefined>;
  find(where?: WhereWithOr<R>, o?: StoreFindOptions): Promise<R[]>;
  getMany(ids: readonly unknown[], o?: { forUpdate?: boolean; sort?: Readonly<Record<string, 1 | -1>> }): Promise<R[]>;
  count(where?: WhereWithOr<R>): Promise<number>;
  exists(where: WhereWithOr<R>): Promise<boolean>;
  distinct<T = unknown>(column: string, where?: WhereWithOr<R>): Promise<T[]>;
  /** How many rows per key: `GROUP BY` / `$group` with a count, the one aggregate both stores read the same way */
  countBy<K extends keyof R & string>(columns: readonly K[], where?: WhereWithOr<R>): Promise<(Pick<R, K> & { n: number })[]>;
  /** The total of one numeric column (0 when no row matches). A money column is refused: see the implementations */
  sum(column: keyof R & string, where?: WhereWithOr<R>): Promise<number>;
  page(where: WhereWithOr<R>, req: PageRequest, order: KeysetOrder): Promise<Page<R>>;
  insert(row: Partial<R> | Record<string, unknown>): Promise<R>;
  insertMany(rows: readonly (Partial<R> | Record<string, unknown>)[]): Promise<void>;
  insertIfAbsent(row: Partial<R> | Record<string, unknown>, key?: readonly string[]): Promise<R | undefined>;
  insertManyIfAbsent(rows: readonly (Partial<R> | Record<string, unknown>)[], key?: readonly string[]): Promise<number>;
  upsert(row: Partial<R> | Record<string, unknown>, o?: { key?: readonly string[]; update?: Patch<R> }): Promise<R>;
  upsertMany(rows: readonly (Partial<R> | Record<string, unknown>)[], o?: { key?: readonly string[]; update?: (row: UpsertRow<R>) => Patch<R> }): Promise<void>;
  increment(key: Record<string, unknown>, fields: Record<string, number>): Promise<R>;
  update(id: unknown, patch: Patch<R>): Promise<R | undefined>;
  updateOne(where: WhereWithOr<R>, patch: Patch<R>, o?: { sort?: Readonly<Record<string, 1 | -1>> }): Promise<R | undefined>;
  updateMany(where: WhereWithOr<R>, patch: Patch<R>): Promise<number>;
  delete(id: unknown): Promise<boolean>;
  deleteMany(where: WhereWithOr<R>): Promise<number>;
  /**
   * Deletes from an append-only table, which a plain `deleteMany` is refused on (docs/10 §6.3): `audit_entries`,
   * `audit_entry_targets`, `audit_checkpoints`, `finance_ledger_entries`, `wallet_ledger`. Only a retention job
   * has any business calling it. On MongoDB, where append-only is a rule the repositories keep rather than one
   * the server enforces, it deletes like any other write — so the *rule* lives in the name of this method.
   */
  purgeMany(where: WhereWithOr<R>): Promise<number>;
}

/** A module's data, whichever database holds it */
export interface Store {
  /** The module whose tables this store reaches; a table of another module is not reachable (§10.6) */
  readonly module: string;
  readonly inTransaction: boolean;
  table<R extends object>(name: string): StoreTable<R>;
  /** fn with a store bound to a transaction — this one, when already inside it */
  transaction<T>(fn: (tx: Store) => Promise<T>): Promise<T>;
  /** Serialises transactions on a name (§11.2 rule 5). Only inside a transaction */
  lock(name: string): Promise<void>;
  /** The event inbox: true the first time this module claims the key */
  claim(key: string): Promise<boolean>;
  seen(key: string): Promise<boolean>;
  nextValue(counter: string): Promise<number>;
  nextValues(counter: string, n: number): Promise<number[]>;
}

/** Which database a module's data lives in while the migration is under way */
export type StoreKind = 'mongo' | 'mysql';
