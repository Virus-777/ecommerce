import type { ModuleStore, Table as Collection } from '../../kernel/mongo/index.js';
import type { Filter } from '../../kernel/mongo/table.js';
import type { ShippingRepository, Table } from './ports.js';
import { containsText, encode, insertIfNew, jsonColumns, sortOf, toFilter } from './generic.js';

type Row = Record<string, unknown>;

/** MongoDB adapter for ShippingRepository (docs/04-mongodb-migration.md): one collection per spec table. */
export function createMongoShippingRepository(store: ModuleStore): ShippingRepository {
  // generic table access: the row types are checked at the ShippingRepository boundary
  const t = (table: Table): Collection<any> => store.table(table);
  const json = new Map<string, Set<string>>();
  const enc = (table: Table, row: unknown) => {
    let cols = json.get(table);
    if (!cols) json.set(table, (cols = jsonColumns(store.schemas[table]!)));
    return encode(cols, row as Row);
  };
  const where = (w: unknown) => toFilter(w as Row);

  const repo: ShippingRepository = {
    transaction: (fn) => store.transaction((tx) => fn(tx === store ? repo : createMongoShippingRepository(tx))),

    get: (table, id, o) => t(table).get(id, o),
    find: (table, w, o) => t(table).find(where(w), { sort: sortOf(o?.orderBy as never), limit: o?.limit, forUpdate: o?.forUpdate }),
    count: (table, w) => t(table).count(where(w)),
    insert: (table, row) => t(table).insert(enc(table, row)),
    async insertMany(table, rows) {
      await t(table).insertMany(rows.map((r) => enc(table, r)));
    },
    async insertIfNew(table, row) {
      return (await insertIfNew(t(table), enc(table, row))) !== undefined;
    },
    async update(table, id, patch) {
      const values = enc(table, patch);
      const row = Object.keys(values).length ? await t(table).update(id, values) : await t(table).get(id);
      if (!row) throw new Error(`shipping: ${table} ${id} not found`);
      return row;
    },
    async updateWhere(table, w, patch) {
      const values = enc(table, patch);
      if (!Object.keys(values).length) return 0;
      return t(table).updateMany(where(w), values);
    },
    async removeWhere(table, w) {
      await t(table).deleteMany(where(w));
    },
    async page(table, w, page, o) {
      const conds: Filter[] = [where(w)];
      const term = o.search?.term?.trim();
      // lower(coalesce(col::text, '')) like '%term%' over the search columns (text columns)
      if (term && o.search?.columns.length) conds.push({ $or: o.search.columns.map((c) => ({ [c]: containsText(term) })) });
      return t(table).page({ $and: conds }, page, { column: o.order.column, direction: o.order.direction });
    },
    async exceptionCounts() {
      const rows = await t('exceptions').aggregate<{ _id: string; n: number; nn: number }>([
        { $match: { status: { $in: ['open', 'in_progress', 'escalated'] } } },
        { $group: { _id: '$kind', n: { $sum: 1 }, nn: { $sum: { $cond: [{ $eq: [{ $ifNull: ['$customer_notified_at', null] }, null] }, 1, 0] } } } },
      ]);
      return { kinds: Object.fromEntries(rows.map((r) => [r._id, r.n])), notNotified: rows.reduce((s, r) => s + r.nn, 0) };
    },
  };
  return repo;
}
