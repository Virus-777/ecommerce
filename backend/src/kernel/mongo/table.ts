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
 */
import mongoose, { type Model } from 'mongoose';
import { decodeCursor, encodeCursor, type KeysetOrder, type PageRequest } from '../lib/pagination.js';
import type { CollectionDef } from '../spec/define.js';
import type { Page } from '../../spec/common.js';
import type { ClientSession, MongoStore } from './index.js';
import { inTransaction } from './session.js';

const { Decimal128, Binary } = mongoose.mongo;
type Document = mongoose.mongo.Document;

export type Filter = Record<string, unknown>;
export type Sort = Record<string, 1 | -1>;
/** A $set patch of row fields, update operators ($set, $inc, $unset, $push …), or an aggregation pipeline */
export type UpdateSpec = Record<string, unknown> | Document[];

const isOperator = (k: string) => k.startsWith('$');

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

  async findOne(f: Filter, o: { sort?: Sort; forUpdate?: boolean } = {}): Promise<R | undefined> {
    const filter = this.filter(f);
    const doc =
      o.forUpdate && inTransaction(this.session)
        ? await this.model.findOneAndUpdate(filter, { $inc: { _lock: 1 } }, { session: this.session, sort: this.#sort(o.sort), new: true, lean: true })
        : await this.model.findOne(filter, null, { session: this.#session, sort: this.#sort(o.sort), lean: true });
    return doc ? this.fromDoc(doc as Document) : undefined;
  }

  async find(f: Filter = {}, o: { sort?: Sort; limit?: number; skip?: number; forUpdate?: boolean } = {}): Promise<R[]> {
    const filter = this.filter(f);
    // lock every matching document first (a superset of a limited page), then read them as they are now
    if (o.forUpdate && inTransaction(this.session)) await this.model.updateMany(filter, { $inc: { _lock: 1 } }, { session: this.session });
    const docs = await this.model.find(filter, null, { session: this.#session, sort: this.#sort(o.sort), skip: o.skip, limit: o.limit, lean: true });
    return (docs as Document[]).map((d) => this.fromDoc(d));
  }

  /** Rows whose primary key is one of ids (empty ids: none) */
  async getMany(ids: readonly unknown[], o: { forUpdate?: boolean; sort?: Sort } = {}): Promise<R[]> {
    if (!ids.length) return [];
    if (!this.def.idField) throw new Error(`${this.name} has no single-column key: use find`);
    return this.find({ [this.def.idField]: { $in: [...ids] } }, o);
  }

  count(f: Filter = {}): Promise<number> {
    return this.model.countDocuments(this.filter(f)).session(this.#session).exec();
  }

  async exists(f: Filter): Promise<boolean> {
    return Boolean(await this.model.exists(this.filter(f)).session(this.#session));
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
      const [total, items] = await Promise.all([this.count(f), this.find(f, { sort, skip: (req.page - 1) * req.limit, limit: req.limit })]);
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
   * Inserts the row unless one with the same key exists (PostgreSQL's on conflict do nothing): the inserted row, or
   * undefined. `key` names the unique fields (default: the primary key).
   */
  async insertIfAbsent(row: Partial<R> | Record<string, unknown>, key: readonly string[] = this.#defaultKey()): Promise<R | undefined> {
    const values = row as Record<string, unknown>;
    const doc = await this.#insertDoc(values);
    const r = await this.model.updateOne(this.#keyFilter(values, key), { $setOnInsert: doc }, { session: this.session, upsert: true, runValidators: true });
    return r.upsertedCount ? this.fromDoc(doc) : undefined;
  }

  /** insertIfAbsent for many rows in one round trip; how many were inserted */
  async insertManyIfAbsent(rows: readonly (Partial<R> | Record<string, unknown>)[], key: readonly string[] = this.#defaultKey()): Promise<number> {
    if (!rows.length) return 0;
    const ops = [];
    for (const row of rows) {
      const values = row as Record<string, unknown>;
      ops.push({ updateOne: { filter: this.#keyFilter(values, key), update: { $setOnInsert: await this.#insertDoc(values) }, upsert: true } });
    }
    return (await this.model.bulkWrite(ops as never, { session: this.session, ordered: true })).upsertedCount;
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

  /** Updates every matching row; how many matched (as PostgreSQL counts updated rows) */
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
