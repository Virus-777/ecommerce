import type { PageRequest } from '../../kernel/lib/pagination.js';
import { contains, whereFilter, type ModuleStore, type Table as Collection, type Where } from '../../kernel/mongo/index.js';
import type * as common from '../../spec/common.js';
import type { Balances, IdTable, LedgerRec, Recs, SnapshotRec, StockGroup, Table } from './ports.js';

/** Groups whose units are physically in our warehouse (the rest is expected) */
const PHYSICAL: StockGroup[] = ['receiving', 'available', 'reserved', 'unsellable', 'returned', 'removal_pending'];

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

/** Undefined fields dropped (a patch leaves them as they are) */
const defined = (patch: object) => Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));

/**
 * fulfillment_service.enrollments, sku_enrollments, inbound_shipments, inbound_lines, inbound_receipts, discrepancies,
 * ownership_ledger, fulfillment_requests, service_returns, removal_orders, stock_differences, fee_schedules,
 * fee_charges, storage_snapshots: one collection per spec table, reached through a few generic methods (get / find /
 * insert / update with a Where of column conditions, kernel whereFilter), plus the ledger sums.
 */
export class FulfillmentServiceRepository {
  constructor(private readonly store: ModuleStore) {}

  /** Runs fn in one transaction (nested calls join the outer one) */
  transaction<T>(fn: (tx: FulfillmentServiceRepository) => Promise<T>): Promise<T> {
    return this.store.transaction((tx) => fn(new FulfillmentServiceRepository(tx)));
  }

  /** Inbox (ctx.mongo.claim): true the first time this key is claimed; commits with the transaction it runs in */
  claim(key: string): Promise<boolean> {
    return this.store.claim(key);
  }

  // generic table access: the row types are checked by the method signatures
  #t(table: Table): Collection<any> {
    return this.store.table(table);
  }

  get<T extends IdTable>(table: T, id: string, o?: { forUpdate?: boolean }): Promise<Recs[T] | undefined> {
    return this.#t(table).get(id, { forUpdate: o?.forUpdate });
  }

  find<T extends Table>(table: T, where: Where<Recs[T]>, o?: FindOptions<Recs[T]>): Promise<Recs[T][]> {
    return this.#t(table).find(whereFilter(where), {
      sort: o?.orderBy?.length ? Object.fromEntries(o.orderBy.map(([c, dir]) => [c, dir === 'desc' ? -1 : 1])) : undefined,
      limit: o?.limit,
      forUpdate: o?.forUpdate,
    });
  }

  async findOne<T extends Table>(table: T, where: Where<Recs[T]>, o?: FindOptions<Recs[T]>): Promise<Recs[T] | undefined> {
    return (await this.find(table, where, { ...o, limit: 1 }))[0];
  }

  count<T extends Table>(table: T, where: Where<Recs[T]>): Promise<number> {
    return this.#t(table).count(whereFilter(where));
  }

  insert<T extends Table>(table: T, row: Recs[T]): Promise<Recs[T]> {
    return this.#t(table).insert(row);
  }

  insertMany<T extends Table>(table: T, rows: Recs[T][]): Promise<void> {
    return this.#t(table).insertMany(rows);
  }

  /** Inserts unless the row conflicts with a unique key (on conflict do nothing); returns whether it was inserted */
  async insertIfAbsent<T extends Table>(table: T, row: Recs[T]): Promise<boolean> {
    return (await this.#t(table).insertIfAbsent(row)) !== undefined;
  }

  async update<T extends IdTable>(table: T, id: string, patch: Partial<Recs[T]>): Promise<Recs[T]> {
    const values = defined(patch);
    const r = Object.keys(values).length ? await this.#t(table).update(id, values) : await this.#t(table).get(id);
    if (!r) throw new Error(`fulfillment-service: ${table} ${id} not found`);
    return r;
  }

  async updateWhere<T extends Table>(table: T, where: Where<Recs[T]>, patch: Partial<Recs[T]>): Promise<number> {
    const values = defined(patch);
    if (!Object.keys(values).length) return 0;
    return this.#t(table).updateMany(whereFilter(where), values);
  }

  async removeWhere<T extends Table>(table: T, where: Where<Recs[T]>): Promise<void> {
    await this.#t(table).deleteMany(whereFilter(where));
  }

  page<T extends IdTable>(table: T, where: Where<Recs[T]>, page: PageRequest, o: PageOptions<Recs[T]>): Promise<common.Page<Recs[T]>> {
    const filter = whereFilter(where);
    const term = o.search?.term?.trim();
    if (term && o.search?.columns.length) filter.$and = [{ $or: o.search.columns.map((c) => ({ [c]: contains(term) })) }];
    return this.#t(table).page(filter, page, { column: o.order.column, direction: o.order.direction });
  }

  /** Ledger balance of every stock group per SKU enrollment (sum in − sum out) */
  async balances(ids: readonly string[]): Promise<Balances> {
    const out: Balances = new Map();
    if (!ids.length) return out;
    const ledger = this.#t('ownership_ledger');
    const sums = async (field: 'to_group' | 'from_group', sign: 1 | -1) => {
      const rows = await ledger.aggregate<{ _id: { sku: string; grp: StockGroup }; qty: number }>([
        { $match: { sku_enrollment_id: { $in: [...ids] }, [field]: { $ne: null } } },
        { $group: { _id: { sku: '$sku_enrollment_id', grp: `$${field}` }, qty: { $sum: '$quantity' } } },
      ]);
      for (const r of rows) {
        const b = out.get(r._id.sku) ?? {};
        b[r._id.grp] = (b[r._id.grp] ?? 0) + sign * Number(r.qty);
        out.set(r._id.sku, b);
      }
    };
    await sums('to_group', 1);
    await sums('from_group', -1);
    return out;
  }

  /** Units that entered the warehouse (arrivals, extra units, returns, found units), newest first, for ageing */
  async inflows(ids: readonly string[]): Promise<LedgerRec[]> {
    if (!ids.length) return [];
    return this.#t('ownership_ledger').find(
      { sku_enrollment_id: { $in: [...ids] }, to_group: { $in: PHYSICAL }, $or: [{ from_group: null }, { from_group: 'inbound' }] },
      { sort: { at: -1, id: -1 } },
    );
  }

  /** Locks a SKU enrollment's ledger (serialises decisions on its balances) */
  async lockSkus(ids: readonly string[]): Promise<void> {
    if (!ids.length) return;
    // lock-by-write on the SKU enrollments
    await this.#t('sku_enrollments').find({ id: { $in: [...new Set(ids)] } }, { forUpdate: true });
  }

  /** Inserts or replaces the day's snapshot of a SKU */
  async upsertSnapshot(row: SnapshotRec): Promise<void> {
    await this.#t('storage_snapshots').upsert(row, {
      key: ['day', 'sku_enrollment_id'],
      update: { seller_id: row.seller_id, units: row.units, cubic_feet: row.cubic_feet, aged_units: row.aged_units },
    });
  }
}
