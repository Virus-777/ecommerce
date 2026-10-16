/**
 * One spec table as a MongoDB collection through its Mongoose model, for repositories (docs/04-mongodb-migration.md
 * §2). Rows keep their spec shape (snake_case fields, `id`, numeric as string, bytea as Uint8Array, nullable columns
 * null); documents store the primary key column as `_id`, numeric as Decimal128 and bytea as binary. Writes are
 * validated by the generated Mongoose schema (and the collection's validator in the database).
 *
 *   const t = store.table<RoleRow>('roles');
 *   await t.get(id, { forUpdate: true });            // in a transaction: locks the document (lock-by-write)
 *   await t.find({ status: { $in: ['active'] } }, { sort: { created_at: -1 }, limit: 50 });
 *   await t.insert(row); await t.update(id, { name }); await t.page(filter, req, { column: 'created_at', direction: 'desc' });
 *
 * Filters and sorts name row fields; the primary key column is translated to `_id`. A transaction must not see a
 * duplicate-key error (it aborts the whole transaction): use insertIfAbsent or upsert where a row may exist, never
 * insert-and-catch.
 *
 * Helpers that replace hand-written copies in repositories: insertIfAbsent (checks every unique index), increment
 * (an upserted $inc), the `collation` and `nullsLast` read options, pageAggregate (paging on a computed key), and
 * isDuplicateKey / CASE_INSENSITIVE below; whereFilter, contains and likePattern are in ./filters.ts.
 */
import mongoose, { type Model } from 'mongoose';
import { decodeCursor, encodeCursor, type KeysetOrder, type PageRequest } from '../lib/pagination.js';
import type { CollectionDef, MongoIndexDef } from '../spec/define.js';
import type { Page } from '../../spec/common.js';
import type { ClientSession, MongoStore } from './index.js';
import { inTransaction } from './session.js';

const { Decimal128, Binary } = mongoose.mongo;
type Document = mongoose.mongo.Document;

export type Filter = Record<string, unknown>;
export type Sort = Record<string, 1 | -1>;
/** A $set patch of row fields, update operators ($set, $inc, $unset, $push …), or an aggregation pipeline */
export type UpdateSpec = Record<string, unknown> | Document[];
/** How strings compare in a read (MongoDB collation) */
export type Collation = Readonly<{ locale: string; strength: number }>;

/**
 * Case-insensitive comparison: the collation the generator gives a `lower(col)` index. A read that should use such an
 * index, or compare the way lower(x) = lower(y) did, passes it: `t.find(f, { collation: CASE_INSENSITIVE })`.
 */
export const CASE_INSENSITIVE: Collation = { locale: 'en', strength: 2 };

/**
 * Whether an error is MongoDB's duplicate key (a unique index refused the write). Only for the few writes outside a
 * transaction that may lose a race on a unique key; inside a transaction use insertIfAbsent or upsert instead.
 */
export function isDuplicateKey(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null | undefined;
  return e?.code === 11000 || (typeof e?.message === 'string' && e.message.includes('E11000'));
}

export interface ReadOptions {
  /** Compare strings under this collation (CASE_INSENSITIVE to match a lower(col) index) */
  collation?: Collation;
}

export interface FindOptions extends ReadOptions {
  sort?: Sort;
  limit?: number;
  skip?: number;
  /** Inside a transaction: lock the matching rows (lock-by-write) */
  forUpdate?: boolean;
  /**
   * Sort fields whose nulls come after every value, in either direction. PostgreSQL put nulls last in ascending
   * order; MongoDB puts them first. Each field must also be in `sort`. The read then runs as an aggregation.
   */
  nullsLast?: readonly string[];
}

/** The order of pageAggregate: a field the pipeline computes (or a column), then the primary key */
export interface ComputedOrder {
  key: string;
  direction: 'asc' | 'desc';
}

const isOperator = (k: string) => k.startsWith('$');
/** Query options carrying a collation, when there is one */
const collationOption = (o: ReadOptions) => (o.collation ? { collation: { ...o.collation } } : {});

export class Table<R extends object> {
  readonly #decimal: Set<string>;
  readonly #binary: Set<string>;
  readonly #dates: Set<string>;

  constructor(
    readonly store: MongoStore,
    readonly model: Model<any>,
    readonly def: CollectionDef,
    readonly name: string,
    readonly session?: ClientSession,
  ) {
    this.#decimal = new Set(def.decimal);
    this.#binary = new Set(def.binary);
    this.#dates = new Set(def.dates);
  }

  get #session() {
    return this.session ?? null;
  }

  /* ---------------------------------------------------------------- conversion */

  #field(k: string) {
    return k === this.def.idField ? '_id' : k;
  }

  /** A row (or part of one) as document fields */
  toDoc(row: Record<string, unknown>): Document {
    const out: Document = {};
    for (const [k, v] of Object.entries(row)) {
      if (v === undefined) continue;
      out[this.#field(k)] = this.#store(k, v);
    }
    return out;
  }

  /** A field's value as stored: numeric as Decimal128, bytea as a Buffer (Mongoose refuses a plain Uint8Array) */
  #store(k: string, v: unknown): unknown {
    if (v === null) return v;
    if (this.#decimal.has(k) && !(v instanceof Decimal128)) return Decimal128.fromString(String(v));
    if (this.#binary.has(k) && v instanceof Uint8Array && !Buffer.isBuffer(v)) return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
    return v;
  }

  /** A stored document as a row */
  fromDoc(doc: Document): R {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(doc)) {
      if (k === '_lock') continue;
      if (k === '_id') {
        if (this.def.idField) out[this.def.idField] = v;
        continue;
      }
      if (v instanceof Decimal128) out[k] = v.toString();
      else if (v instanceof Binary) out[k] = new Uint8Array(v.buffer);
      else if (Buffer.isBuffer(v)) out[k] = new Uint8Array(v);
      else out[k] = v;
    }
    for (const c of this.def.nullable) if (out[c] === undefined) out[c] = null;
    return out as R;
  }

  /** A filter on row fields as a document filter (Mongoose casts the values by the schema) */
  filter(f: Filter): Filter {
    const out: Filter = {};
    for (const [k, v] of Object.entries(f)) {
      if (k === '$and' || k === '$or' || k === '$nor') out[k] = (v as Filter[]).map((x) => this.filter(x));
      else out[isOperator(k) ? k : this.#field(k)] = v;
    }
    return out;
  }

  #sort(s: Sort | undefined): Sort | undefined {
    return s && Object.fromEntries(Object.entries(s).map(([k, d]) => [this.#field(k), d]));
  }

  /** A patch or update operators as an update document */
  #update(u: UpdateSpec): Document | Document[] {
    if (Array.isArray(u)) return u;
    if (!Object.keys(u).some(isOperator)) return { $set: this.toDoc(u) };
    const out: Document = {};
    for (const [op, fields] of Object.entries(u)) {
      out[op] = op === '$set' || op === '$setOnInsert' ? this.toDoc(fields as Record<string, unknown>) : Object.fromEntries(Object.entries(fields as object).map(([k, v]) => [this.#field(k), v]));
    }
    return out;
  }

  /** A full row for insert: nullable columns the row leaves out are stored as null; the identity column is numbered */
  async #insertDoc(row: Record<string, unknown>): Promise<Document> {
    const full: Record<string, unknown> = { ...row };
    for (const c of this.def.nullable) if (full[c] === undefined) full[c] = null;
    if (this.def.identity && full[this.def.identity] == null) full[this.def.identity] = await this.store.nextValue(`${this.name}.${this.def.identity}`);
    return this.toDoc(full);
  }

  #keyFilter(values: Record<string, unknown>, key: readonly string[]): Filter {
    return this.filter(Object.fromEntries(key.map((k) => [k, values[k] ?? null])));
  }

  /* ---------------------------------------------------------------- reads */

  /** One row by primary key; forUpdate inside a transaction locks it (later writers conflict and retry) */
  async get(id: unknown, o: { forUpdate?: boolean } = {}): Promise<R | undefined> {
    if (!this.def.idField) throw new Error(`${this.name} has no single-column key: use findOne`);
    return this.findOne({ [this.def.idField]: id }, o);
  }

  async findOne(f: Filter, o: { sort?: Sort; forUpdate?: boolean } & ReadOptions = {}): Promise<R | undefined> {
    const filter = this.filter(f);
    const doc =
      o.forUpdate && inTransaction(this.session)
        ? await this.model.findOneAndUpdate(filter, { $inc: { _lock: 1 } }, { session: this.session, sort: this.#sort(o.sort), new: true, lean: true, ...collationOption(o) })
        : await this.model.findOne(filter, null, { session: this.#session, sort: this.#sort(o.sort), lean: true, ...collationOption(o) });
    return doc ? this.fromDoc(doc as Document) : undefined;
  }

  async find(f: Filter = {}, o: FindOptions = {}): Promise<R[]> {
    const filter = this.filter(f);
    // lock every matching document first (a superset of a limited page), then read them as they are now
    if (o.forUpdate && inTransaction(this.session)) await this.model.updateMany(filter, { $inc: { _lock: 1 } }, { session: this.session, ...collationOption(o) });
    if (o.nullsLast?.length) return this.#findNullsLast(filter, o);
    const docs = await this.model.find(filter, null, { session: this.#session, sort: this.#sort(o.sort), skip: o.skip, limit: o.limit, lean: true, ...collationOption(o) });
    return (docs as Document[]).map((d) => this.fromDoc(d));
  }

  /**
   * find with some sort fields' nulls last: an aggregation that adds a 0/1 "is null" flag before each such field in
   * the sort. Aggregations do not cast values, so the filter is cast by Mongoose first (as find would).
   */
  async #findNullsLast(filter: Filter, o: FindOptions): Promise<R[]> {
    const flags: Document = {};
    const sort: Document = {};
    for (const [k, dir] of Object.entries(o.sort ?? {})) {
      const field = this.#field(k);
      if (o.nullsLast!.includes(k)) {
        flags[`_null_${k}`] = { $cond: [{ $eq: [{ $ifNull: [`$${field}`, null] }, null] }, 1, 0] };
        sort[`_null_${k}`] = 1;
      }
      sort[field] = dir;
    }
    const missing = o.nullsLast!.filter((k) => !(k in (o.sort ?? {})));
    if (missing.length) throw new Error(`${this.name}: nullsLast names ${missing.join(', ')}, which the sort does not`);
    const pipeline: Document[] = [
      { $match: this.model.find(filter).cast() },
      { $addFields: flags },
      { $sort: sort },
      ...(o.skip ? [{ $skip: o.skip }] : []),
      ...(o.limit !== undefined ? [{ $limit: o.limit }] : []),
      { $project: Object.fromEntries(Object.keys(flags).map((f) => [f, 0])) },
    ];
    const q = this.model.aggregate(pipeline as never).session(this.#session);
    if (o.collation) q.collation({ ...o.collation });
    return ((await q.exec()) as Document[]).map((d) => this.fromDoc(d));
  }

  /** Rows whose primary key is one of ids (empty ids: none) */
  async getMany(ids: readonly unknown[], o: { forUpdate?: boolean; sort?: Sort } = {}): Promise<R[]> {
    if (!ids.length) return [];
    if (!this.def.idField) throw new Error(`${this.name} has no single-column key: use find`);
    return this.find({ [this.def.idField]: { $in: [...ids] } }, o);
  }

  count(f: Filter = {}, o: ReadOptions = {}): Promise<number> {
    return this.model.countDocuments(this.filter(f), collationOption(o)).session(this.#session).exec();
  }

  async exists(f: Filter, o: ReadOptions = {}): Promise<boolean> {
    const q = this.model.exists(this.filter(f)).session(this.#session);
    if (o.collation) q.collation({ ...o.collation });
    return Boolean(await q);
  }

  async distinct<T = unknown>(field: string, f: Filter = {}): Promise<T[]> {
    const values = await this.model.distinct(this.#field(field), this.filter(f)).session(this.#session);
    return values.map((v: unknown) => (v instanceof Decimal128 ? v.toString() : v)) as T[];
  }

  /** Raw aggregation: values are not cast (numeric as Decimal128, keys as _id); use fromDoc on whole documents */
  aggregate<T = Document>(pipeline: Document[]): Promise<T[]> {
    return this.model.aggregate<T>(pipeline as never).session(this.#session).exec();
  }

  /**
   * A page of rows (kernel/lib/pagination.ts): cursor mode pages by (column, primary key) after the cursor;
   * page mode counts and skips.
   */
  async page(f: Filter, req: PageRequest, order: KeysetOrder): Promise<Page<R>> {
    const idCol = order.id ?? this.def.idField ?? 'id';
    const dir = order.direction === 'desc' ? -1 : 1;
    const sort: Sort = { [order.column]: dir, [idCol]: dir };
    const cursorOf = (row: R) => {
      const v = (row as Record<string, unknown>)[order.column];
      return encodeCursor([v instanceof Date ? v.toISOString() : v, (row as Record<string, unknown>)[idCol]]);
    };
    if (req.mode === 'page') {
      const read = () => this.find(f, { sort, skip: (req.page - 1) * req.limit, limit: req.limit });
      // operations on one session run one after another (a transaction refuses parallel ones)
      const [total, items] = this.session ? [await this.count(f), await read()] : await Promise.all([this.count(f), read()]);
      const totalPages = Math.max(1, Math.ceil(total / req.limit));
      const last = items.at(-1);
      return { items, nextCursor: req.page < totalPages && last ? cursorOf(last) : null, page: req.page, totalPages, total };
    }
    let filter = f;
    if (req.cursor) {
      const [raw, id] = decodeCursor(req.cursor);
      const v = this.#dates.has(order.column) && typeof raw === 'string' ? new Date(raw) : raw;
      const cmp = dir === -1 ? '$lt' : '$gt';
      filter = { $and: [f, { $or: [{ [order.column]: { [cmp]: v } }, { [order.column]: v, [idCol]: { [cmp]: id } }] }] };
    }
    const rows = await this.find(filter, { sort, limit: req.limit + 1 });
    const items = rows.slice(0, req.limit);
    return { items, nextCursor: rows.length > req.limit ? cursorOf(items.at(-1)!) : null };
  }

  /**
   * A page of rows ordered by a value the pipeline computes, then by primary key: for lists sorted by something that
   * is not a column (a priority rank, a deadline with a default). `pipeline` filters and adds the field `order.key`:
   *
   *   t.pageAggregate([{ $match: t.filter(f) }, { $addFields: { sort_due: { $ifNull: ['$due_at', FAR_FUTURE] } } }],
   *                   req, { key: 'sort_due', direction: 'asc' })
   *
   * The stages see stored documents (`_id`, Decimal128) and their values are not cast. The key must hold numbers,
   * strings or dates. Cursor mode pages after the last (key, id); page mode counts in the same aggregation.
   */
  async pageAggregate(pipeline: readonly Document[], req: PageRequest, order: ComputedOrder): Promise<Page<R>> {
    if (!this.def.idField) throw new Error(`${this.name} has no single-column key: pageAggregate needs one`);
    const dir = order.direction === 'desc' ? -1 : 1;
    const sort = { $sort: { [order.key]: dir, _id: dir } };
    // the computed key is not a column: drop it from the rows
    const computed = !this.def.columns.includes(order.key);
    const rowOf = (d: Document) => {
      if (!computed) return this.fromDoc(d);
      const { [order.key]: _key, ...doc } = d;
      return this.fromDoc(doc);
    };
    // a date key is kept as { $date } in the cursor so it reads back as a Date
    const cursorOf = (d: Document) => {
      const v = d[order.key];
      return encodeCursor([v instanceof Date ? { $date: v.toISOString() } : v, d._id]);
    };
    if (req.mode === 'page') {
      const [r] = await this.aggregate<{ total: { n: number }[]; items: Document[] }>([
        ...pipeline,
        { $facet: { total: [{ $count: 'n' }], items: [sort, { $skip: (req.page - 1) * req.limit }, { $limit: req.limit }] } },
      ]);
      const total = r?.total[0]?.n ?? 0;
      const docs = r?.items ?? [];
      const totalPages = Math.max(1, Math.ceil(total / req.limit));
      const last = docs.at(-1);
      return { items: docs.map(rowOf), nextCursor: req.page < totalPages && last ? cursorOf(last) : null, page: req.page, totalPages, total };
    }
    const after: Document[] = [];
    if (req.cursor) {
      const [raw, id] = decodeCursor(req.cursor);
      const v = typeof raw === 'object' && raw !== null && '$date' in raw ? new Date(String((raw as { $date: unknown }).$date)) : raw;
      const cmp = dir === -1 ? '$lt' : '$gt';
      after.push({ $match: { $or: [{ [order.key]: { [cmp]: v } }, { [order.key]: v, _id: { [cmp]: id } }] } });
    }
    const docs = await this.aggregate<Document>([...pipeline, ...after, sort, { $limit: req.limit + 1 }]);
    const items = docs.slice(0, req.limit);
    return { items: items.map(rowOf), nextCursor: docs.length > req.limit ? cursorOf(items.at(-1)!) : null };
  }

  /* ---------------------------------------------------------------- writes */

  async insert(row: Partial<R> | Record<string, unknown>): Promise<R> {
    const doc = await this.#insertDoc(row as Record<string, unknown>);
    await this.model.insertMany([doc], { session: this.session });
    return this.fromDoc(doc);
  }

  async insertMany(rows: readonly (Partial<R> | Record<string, unknown>)[]): Promise<void> {
    if (!rows.length) return;
    const docs: Document[] = [];
    for (const r of rows) docs.push(await this.#insertDoc(r as Record<string, unknown>));
    await this.model.insertMany(docs, { session: this.session, ordered: true });
  }

  /**
   * Inserts the row unless it would break a unique index (SQL: on conflict do nothing): the inserted row, or
   * undefined. Every unique key of the collection is checked: the primary key, and each unique index of the spec
   * whose partial filter the row falls under (with the index's collation). No duplicate-key error is raised, so it
   * is safe inside a transaction (a concurrent insert of the same key there is a write conflict, and the transaction
   * runs again); outside one, a race lost to another insert also answers undefined.
   *
   * `key` checks only those fields instead (SQL: on conflict (key) do nothing): a clash on another unique index
   * then still fails.
   */
  async insertIfAbsent(row: Partial<R> | Record<string, unknown>, key?: readonly string[]): Promise<R | undefined> {
    const values = row as Record<string, unknown>;
    if (key) {
      const doc = await this.#insertDoc(values);
      const r = await this.model.updateOne(this.#keyFilter(values, key), { $setOnInsert: doc }, { session: this.session, upsert: true, runValidators: true });
      return r.upsertedCount ? this.fromDoc(doc) : undefined;
    }
    if (await this.#anyTaken(this.#uniqueKeysOf(values))) return undefined;
    try {
      return await this.insert(values);
    } catch (err) {
      if (!inTransaction(this.session) && isDuplicateKey(err)) return undefined;
      throw err;
    }
  }

  /** insertIfAbsent for each row, in order (a later row may clash with an earlier one); how many were inserted */
  async insertManyIfAbsent(rows: readonly (Partial<R> | Record<string, unknown>)[], key?: readonly string[]): Promise<number> {
    if (!rows.length) return 0;
    if (!key) {
      let inserted = 0;
      for (const row of rows) if (await this.insertIfAbsent(row)) inserted++;
      return inserted;
    }
    // one key: one round trip of upserts
    const ops = [];
    for (const row of rows) {
      const values = row as Record<string, unknown>;
      ops.push({ updateOne: { filter: this.#keyFilter(values, key), update: { $setOnInsert: await this.#insertDoc(values) }, upsert: true } });
    }
    return (await this.model.bulkWrite(ops as never, { session: this.session, ordered: true })).upsertedCount;
  }

  /**
   * The unique keys a new row would take, as filters: its primary key, and every unique index whose partial filter
   * it falls under. Index keys and partial filters name the primary key column `_id`.
   */
  #uniqueKeysOf(row: Record<string, unknown>): { filter: Filter; collation?: Collation }[] {
    const valueOf = (field: string) => (field === '_id' && this.def.idField ? row[this.def.idField] : row[field]) ?? null;
    const keys: { filter: Filter; collation?: Collation }[] = [];
    if (this.def.idField && row[this.def.idField] != null) keys.push({ filter: { _id: row[this.def.idField] } });
    for (const index of this.def.indexes) {
      if (!index.unique) continue;
      if (index.partial && !fallsUnder(index.partial, valueOf)) continue;
      const filter: Filter = Object.fromEntries(Object.keys(index.key).map((field) => [field, valueOf(field)]));
      if (index.partial) filter.$and = [index.partial];
      keys.push({ filter, collation: index.collation });
    }
    return keys;
  }

  /** Whether a row holds any of the keys: one read per collation (an $or of the keys), not one per key */
  async #anyTaken(keys: readonly { filter: Filter; collation?: Collation }[]): Promise<boolean> {
    const byCollation = new Map<string, { filters: Filter[]; collation?: Collation }>();
    for (const k of keys) {
      const id = k.collation ? `${k.collation.locale}/${k.collation.strength}` : '';
      const group = byCollation.get(id) ?? { filters: [], collation: k.collation };
      group.filters.push(k.filter);
      byCollation.set(id, group);
    }
    for (const { filters, collation } of byCollation.values()) {
      if (await this.exists(filters.length === 1 ? filters[0]! : { $or: filters }, { collation })) return true;
    }
    return false;
  }

  /**
   * Adds to number fields of the row with this key, creating the row when there is none (SQL: insert … on conflict
   * do update set n = n + excluded.n). `key` holds equality conditions only: a new row gets the key's fields, the
   * additions, and null in its other nullable columns (every other column must be in the key). The row after.
   *
   *   await t.increment({ owner_kind, owner_id, day }, { count: 1, bytes });
   */
  async increment(key: Record<string, unknown>, fields: Record<string, number>): Promise<R> {
    const onInsert: Record<string, unknown> = {};
    for (const c of this.def.nullable) if (!(c in key) && !(c in fields)) onInsert[c] = null;
    const update: Document = { $inc: Object.fromEntries(Object.entries(fields).map(([k, n]) => [this.#field(k), n])) };
    if (Object.keys(onInsert).length) update.$setOnInsert = this.toDoc(onInsert);
    const doc = await this.model.findOneAndUpdate(this.filter(key), update, { session: this.#session, upsert: true, new: true, lean: true });
    return this.fromDoc(doc as Document);
  }

  /**
   * Inserts the row, or updates the existing one with the same key (on conflict do update): `update` is applied to
   * an existing row (default: every field of `row` but the key). Returns the row as stored.
   */
  async upsert(row: Partial<R> | Record<string, unknown>, o: { key?: readonly string[]; update?: Record<string, unknown> } = {}): Promise<R> {
    const key = o.key ?? this.#defaultKey();
    const values = row as Record<string, unknown>;
    const doc = await this.model.findOneAndUpdate(this.#keyFilter(values, key), await this.#upsertUpdate(values, key, o.update), {
      session: this.#session,
      upsert: true,
      new: true,
      lean: true,
      runValidators: true,
    });
    return this.fromDoc(doc as Document);
  }

  /**
   * upsert for many rows in one round trip: each row is inserted, or `update(row)` (default: every field but the
   * key) is set on the existing one.
   */
  async upsertMany(rows: readonly (Partial<R> | Record<string, unknown>)[], o: { key?: readonly string[]; update?: (row: Record<string, unknown>) => Record<string, unknown> } = {}): Promise<void> {
    if (!rows.length) return;
    const key = o.key ?? this.#defaultKey();
    const ops = [];
    for (const row of rows) {
      const values = row as Record<string, unknown>;
      ops.push({ updateOne: { filter: this.#keyFilter(values, key), update: await this.#upsertUpdate(values, key, o.update?.(values)), upsert: true } });
    }
    await this.model.bulkWrite(ops as never, { session: this.session, ordered: true });
  }

  /** $set for an existing document, $setOnInsert (the full row, nulls included) for a new one */
  async #upsertUpdate(values: Record<string, unknown>, key: readonly string[], update?: Record<string, unknown>): Promise<Document> {
    const setDoc = this.toDoc(update ?? Object.fromEntries(Object.entries(values).filter(([k, v]) => !key.includes(k) && v !== undefined)));
    // a field set on update must not also be in $setOnInsert
    const onInsert = Object.fromEntries(Object.entries(await this.#insertDoc(values)).filter(([k]) => !(k in setDoc)));
    return { ...(Object.keys(setDoc).length ? { $set: setDoc } : {}), $setOnInsert: onInsert };
  }

  #defaultKey(): readonly string[] {
    return this.def.idField ? [this.def.idField] : this.def.key;
  }

  /** Updates one row by primary key; the row after the update, or undefined when there is none */
  async update(id: unknown, u: UpdateSpec): Promise<R | undefined> {
    if (!this.def.idField) throw new Error(`${this.name} has no single-column key: use updateOne`);
    return this.updateOne({ [this.def.idField]: id }, u);
  }

  async updateOne(f: Filter, u: UpdateSpec, o: { sort?: Sort } = {}): Promise<R | undefined> {
    const doc = await this.model.findOneAndUpdate(this.filter(f), this.#update(u), { session: this.#session, sort: this.#sort(o.sort), new: true, lean: true, runValidators: true });
    return doc ? this.fromDoc(doc as Document) : undefined;
  }

  /** Updates every matching row; how many matched */
  async updateMany(f: Filter, u: UpdateSpec): Promise<number> {
    const r = await this.model.updateMany(this.filter(f), this.#update(u), { session: this.session, runValidators: true });
    return r.matchedCount;
  }

  async delete(id: unknown): Promise<boolean> {
    if (!this.def.idField) throw new Error(`${this.name} has no single-column key: use deleteMany`);
    return (await this.deleteMany({ [this.def.idField]: id })) > 0;
  }

  async deleteMany(f: Filter): Promise<number> {
    return (await this.model.deleteMany(this.filter(f), { session: this.session })).deletedCount;
  }
}

/** The $type names the generator writes in partial filters, as tests on a row value */
const TYPE_TESTS: Record<string, (v: unknown) => boolean> = {
  string: (v) => typeof v === 'string',
  null: (v) => v === null || v === undefined,
  bool: (v) => typeof v === 'boolean',
  date: (v) => v instanceof Date,
  int: (v) => Number.isInteger(v),
  long: (v) => Number.isInteger(v),
  double: (v) => typeof v === 'number',
  number: (v) => typeof v === 'number',
  decimal: (v) => typeof v === 'string' || typeof v === 'number' || v instanceof Decimal128,
  object: (v) => typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date),
  array: (v) => Array.isArray(v),
  binData: (v) => v instanceof Uint8Array,
};

/**
 * Whether a row falls under an index's partial filter, i.e. the index covers it (insertIfAbsent). Handles what the
 * generator writes ($and, $or, $type, $in, $eq, $exists, equality); for anything else it assumes the row is covered,
 * which only checks one key too many.
 */
function fallsUnder(partial: NonNullable<MongoIndexDef['partial']>, valueOf: (field: string) => unknown): boolean {
  for (const [field, cond] of Object.entries(partial)) {
    if (field === '$and') {
      if (!(cond as Filter[]).every((c) => fallsUnder(c, valueOf))) return false;
      continue;
    }
    if (field === '$or') {
      if (!(cond as Filter[]).some((c) => fallsUnder(c, valueOf))) return false;
      continue;
    }
    const v = valueOf(field);
    if (typeof cond === 'object' && cond !== null && !Array.isArray(cond) && !(cond instanceof Date)) {
      for (const [op, x] of Object.entries(cond)) {
        if (op === '$type' && !(TYPE_TESTS[String(x)]?.(v) ?? true)) return false;
        if (op === '$in' && !(x as unknown[]).some((y) => y === v)) return false;
        if (op === '$eq' && x !== v) return false;
        if (op === '$exists' && x && v === null) return false;
      }
    } else if (cond !== v) return false;
  }
  return true;
}
