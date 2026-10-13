import type { Schema } from 'mongoose';
import { orThrow } from '../../kernel/lib/or-throw.js';
import type { PageRequest } from '../../kernel/lib/pagination.js';
import { contains, whereFilter, type Filter, type ModuleStore, type Table, type Where } from '../../kernel/mongo/index.js';
import type * as common from '../../spec/common.js';
import type { Recs, TableName } from './ports.js';

type Row = Record<string, unknown>;

/** Sort, limit and lock options of the generic find */
export interface FindOptions<R> {
  orderBy?: [keyof R & string, 'asc' | 'desc'][];
  limit?: number;
  forUpdate?: boolean;
}

/** Order and text search of a page */
export interface PageOptions<R> {
  order: { column: keyof R & string; direction: 'asc' | 'desc' };
  /** Case-insensitive contains over these text columns */
  search?: { columns: (keyof R & string)[]; term: string };
}

/** The json columns of a table (Mixed paths of its generated schema) */
const jsonColumns = (schema: Schema) => new Set(Object.entries(schema.paths).filter(([, p]) => p.instance === 'Mixed').map(([k]) => k));

/** The shipping collections (MongoDB, docs/04-mongodb-migration.md): generic table access by table name. */
export class ShippingRepository {
  readonly #json = new Map<string, Set<string>>();

  constructor(private readonly store: ModuleStore) {}

  #t<T extends TableName>(table: T): Table<Recs[T]> {
    return this.store.table<Recs[T]>(table);
  }

  /** Runs fn in one transaction (nested calls join the outer one) */
  transaction<T>(fn: (tx: ShippingRepository) => Promise<T>): Promise<T> {
    return this.store.transaction((tx) => fn(new ShippingRepository(tx)));
  }

  get<T extends TableName>(table: T, id: string, o?: { forUpdate?: boolean }): Promise<Recs[T] | undefined> {
    return this.#t(table).get(id, o);
  }

  find<T extends TableName>(table: T, where: Where<Recs[T]>, o?: FindOptions<Recs[T]>): Promise<Recs[T][]> {
    const sort = o?.orderBy?.length ? Object.fromEntries(o.orderBy.map(([c, d]) => [c, d === 'desc' ? -1 : 1] as const)) : undefined;
    return this.#t(table).find(whereFilter(where), { sort, limit: o?.limit, forUpdate: o?.forUpdate });
  }

  count<T extends TableName>(table: T, where: Where<Recs[T]>): Promise<number> {
    return this.#t(table).count(whereFilter(where));
  }

  insert<T extends TableName>(table: T, row: Recs[T]): Promise<Recs[T]> {
    return this.#t(table).insert(this.#encode(table, row));
  }

  async insertMany<T extends TableName>(table: T, rows: Recs[T][]): Promise<void> {
    await this.#t(table).insertMany(rows.map((r) => this.#encode(table, r)));
  }

  /** Inserts unless the row conflicts with a unique key (on conflict do nothing); returns whether it was inserted */
  async insertIfAbsent<T extends TableName>(table: T, row: Recs[T]): Promise<boolean> {
    return (await this.#t(table).insertIfAbsent(this.#encode(table, row))) !== undefined;
  }

  /** Sets the defined fields of patch; the row after (an empty patch reads it) */
  async update<T extends TableName>(table: T, id: string, patch: Partial<Recs[T]>): Promise<Recs[T]> {
    const values = this.#encode(table, patch);
    const row = Object.keys(values).length ? await this.#t(table).update(id, values) : await this.#t(table).get(id);
    return orThrow(row, `shipping: ${table} ${id}`);
  }

  /** Sets the defined fields of patch on every matching row; how many matched */
  async updateWhere<T extends TableName>(table: T, where: Where<Recs[T]>, patch: Partial<Recs[T]>): Promise<number> {
    const values = this.#encode(table, patch);
    if (!Object.keys(values).length) return 0;
    return this.#t(table).updateMany(whereFilter(where), values);
  }

  async removeWhere<T extends TableName>(table: T, where: Where<Recs[T]>): Promise<void> {
    await this.#t(table).deleteMany(whereFilter(where));
  }

  page<T extends TableName>(table: T, where: Where<Recs[T]>, page: PageRequest, o: PageOptions<Recs[T]>): Promise<common.Page<Recs[T]>> {
    const conds: Filter[] = [whereFilter(where)];
    const term = o.search?.term?.trim();
    // case-insensitive contains over the search columns (text columns)
    if (term && o.search?.columns.length) conds.push({ $or: o.search.columns.map((c) => ({ [c]: contains(term) })) });
    return this.#t(table).page({ $and: conds }, page, { column: o.order.column, direction: o.order.direction });
  }

  /** Open exceptions per kind and open exceptions whose customer was not notified */
  async exceptionCounts(): Promise<{ kinds: Record<string, number>; notNotified: number }> {
    const rows = await this.#t('exceptions').aggregate<{ _id: string; n: number; nn: number }>([
      { $match: { status: { $in: ['open', 'in_progress', 'escalated'] } } },
      { $group: { _id: '$kind', n: { $sum: 1 }, nn: { $sum: { $cond: [{ $eq: [{ $ifNull: ['$customer_notified_at', null] }, null] }, 1, 0] } } } },
    ]);
    return { kinds: Object.fromEntries(rows.map((r) => [r._id, r.n])), notNotified: rows.reduce((s, r) => s + r.nn, 0) };
  }

  /** A row or patch as stored: undefined fields dropped, json values as plain JSON (dates inside become strings) */
  #encode(table: TableName, row: unknown): Row {
    let json = this.#json.get(table);
    if (!json) this.#json.set(table, (json = jsonColumns(this.store.schemas[table]!)));
    const out: Row = {};
    for (const [k, v] of Object.entries(row as Row)) {
      if (v === undefined) continue;
      out[k] = json.has(k) && v !== null ? JSON.parse(JSON.stringify(v)) : v;
    }
    return out;
  }
}
