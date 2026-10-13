import type { Schema } from 'mongoose';
import type { PageRequest } from '../../kernel/lib/pagination.js';
import { contains, whereFilter, type ModuleStore, type Table as Collection, type Where } from '../../kernel/mongo/index.js';
import type { Filter, Sort } from '../../kernel/mongo/table.js';
import type * as common from '../../spec/common.js';
import type { IdTable, Recs, Table } from './ports.js';

type Row = Record<string, unknown>;

export interface FindOptions<R> {
  orderBy?: [keyof R & string, 'asc' | 'desc'][];
  limit?: number;
  forUpdate?: boolean;
}

export interface PageOptions<R> {
  order: { column: keyof R & string; direction: 'asc' | 'desc' };
  /** Case-insensitive contains over these text columns */
  search?: { columns: (keyof R & string)[]; term: string };
}

const sortOf = (orderBy: readonly (readonly [string, 'asc' | 'desc'])[] | undefined): Sort | undefined =>
  orderBy?.length ? Object.fromEntries(orderBy.map(([c, d]) => [c, d === 'desc' ? -1 : 1])) : undefined;

/** The json columns of a table (Mixed paths of its generated schema) */
const jsonColumns = (schema: Schema) => new Set(Object.entries(schema.paths).filter(([, p]) => p.instance === 'Mixed').map(([k]) => k));

/**
 * warehouse.bins, bin_assignments, fulfillments, fulfillment_lines, waves, scan_log, box_types, packages,
 * package_items, putaway_tasks, return_parcels: one collection per spec table, reached through a few generic
 * methods (get / find / insert / update with a Where of column conditions, kernel whereFilter).
 */
export class WarehouseRepository {
  readonly #json = new Map<string, Set<string>>();

  constructor(private readonly store: ModuleStore) {}

  /** Runs fn in one transaction (nested calls join the outer one) */
  transaction<T>(fn: (tx: WarehouseRepository) => Promise<T>): Promise<T> {
    return this.store.transaction((tx) => fn(tx === this.store ? this : new WarehouseRepository(tx)));
  }

  /** Claims a consumer's or job's once-only key (kernel inbox); inside a transaction the claim commits with the effects. False when already handled */
  claim(key: string): Promise<boolean> {
    return this.store.claim(key);
  }

  // generic table access: the row types are checked by the method signatures
  #t(table: Table): Collection<any> {
    return this.store.table(table);
  }

  /**
   * A row or patch as stored: undefined fields dropped, json values as JSON (dates inside become strings, the way the
   * service reads them back).
   */
  #encode(table: Table, row: unknown): Row {
    let json = this.#json.get(table);
    if (!json) this.#json.set(table, (json = jsonColumns(this.store.schemas[table]!)));
    const out: Row = {};
    for (const [k, v] of Object.entries(row as Row)) {
      if (v === undefined) continue;
      out[k] = json.has(k) && v !== null ? JSON.parse(JSON.stringify(v)) : v;
    }
    return out;
  }

  get<T extends IdTable>(table: T, id: string, o?: { forUpdate?: boolean }): Promise<Recs[T] | undefined> {
    return this.#t(table).get(id, o);
  }

  find<T extends Table>(table: T, where: Where<Recs[T]>, o?: FindOptions<Recs[T]>): Promise<Recs[T][]> {
    return this.#t(table).find(whereFilter(where), { sort: sortOf(o?.orderBy), limit: o?.limit, forUpdate: o?.forUpdate });
  }

  count<T extends Table>(table: T, where: Where<Recs[T]>): Promise<number> {
    return this.#t(table).count(whereFilter(where));
  }

  insert<T extends Table>(table: T, row: Recs[T]): Promise<Recs[T]> {
    return this.#t(table).insert(this.#encode(table, row));
  }

  async insertMany<T extends Table>(table: T, rows: Recs[T][]): Promise<void> {
    await this.#t(table).insertMany(rows.map((r) => this.#encode(table, r)));
  }

  /** Inserts unless the row conflicts with a unique key (on conflict do nothing); returns whether it was inserted */
  async insertIfAbsent<T extends Table>(table: T, row: Recs[T]): Promise<boolean> {
    return (await this.#t(table).insertIfAbsent(this.#encode(table, row))) !== undefined;
  }

  async update<T extends IdTable>(table: T, id: string, patch: Partial<Recs[T]>): Promise<Recs[T]> {
    const values = this.#encode(table, patch);
    const row = Object.keys(values).length ? await this.#t(table).update(id, values) : await this.#t(table).get(id);
    if (!row) throw new Error(`warehouse: ${table} ${id} not found`);
    return row;
  }

  async updateWhere<T extends Table>(table: T, where: Where<Recs[T]>, patch: Partial<Recs[T]>): Promise<number> {
    const values = this.#encode(table, patch);
    if (!Object.keys(values).length) return 0;
    return this.#t(table).updateMany(whereFilter(where), values);
  }

  async removeWhere<T extends Table>(table: T, where: Where<Recs[T]>): Promise<void> {
    await this.#t(table).deleteMany(whereFilter(where));
  }

  page<T extends IdTable>(table: T, where: Where<Recs[T]>, page: PageRequest, o: PageOptions<Recs[T]>): Promise<common.Page<Recs[T]>> {
    const conds: Filter[] = [whereFilter(where)];
    const term = o.search?.term?.trim();
    if (term && o.search?.columns.length) conds.push({ $or: o.search.columns.map((c) => ({ [c]: contains(term) })) });
    return this.#t(table).page({ $and: conds }, page, { column: o.order.column, direction: o.order.direction });
  }

  /** Assigned stock items per bin */
  async assignmentCounts(binIds: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (!binIds.length) return out;
    const rows = await this.#t('bin_assignments').aggregate<{ _id: string; n: number }>([{ $match: { bin_id: { $in: binIds } } }, { $group: { _id: '$bin_id', n: { $sum: 1 } } }]);
    for (const r of rows) out.set(r._id, r.n);
    return out;
  }

  /** The location with the most active bins (the main Official Store warehouse at launch) */
  async busiestLocation(): Promise<string | null> {
    const [r] = await this.#t('bins').aggregate<{ _id: string; n: number }>([
      { $match: { active: true } },
      { $group: { _id: '$location_id', n: { $sum: 1 } } },
      { $sort: { n: -1, _id: 1 } },
      { $limit: 1 },
    ]);
    return r?._id ?? null;
  }
}
