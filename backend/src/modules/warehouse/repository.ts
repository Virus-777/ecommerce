import type { ModuleStore, Table as Collection } from '../../kernel/mongo/index.js';
import type { Filter } from '../../kernel/mongo/table.js';
import type { Table, WarehouseRepository } from './ports.js';
import { containsText, encode, insertIfNew, jsonColumns, sortOf, toFilter } from './generic.js';

type Row = Record<string, unknown>;

/** MongoDB adapter for WarehouseRepository (docs/04-mongodb-migration.md): one collection per spec table. */
export function createMongoWarehouseRepository(store: ModuleStore): WarehouseRepository {
  // generic table access: the row types are checked at the WarehouseRepository boundary
  const t = (table: Table): Collection<any> => store.table(table);
  const json = new Map<string, Set<string>>();
  const enc = (table: Table, row: unknown) => {
    let cols = json.get(table);
    if (!cols) json.set(table, (cols = jsonColumns(store.schemas[table]!)));
    return encode(cols, row as Row);
  };
  const where = (w: unknown) => toFilter(w as Row);

  const repo: WarehouseRepository = {
    transaction: (fn) => store.transaction((tx) => fn(tx === store ? repo : createMongoWarehouseRepository(tx))),
    // inbox: inside a transaction the claim commits with the effects
    claim: (key) => store.claim(key),

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
      if (!row) throw new Error(`warehouse: ${table} ${id} not found`);
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
    async assignmentCounts(binIds) {
      const out = new Map<string, number>();
      if (!binIds.length) return out;
      const rows = await t('bin_assignments').aggregate<{ _id: string; n: number }>([{ $match: { bin_id: { $in: binIds } } }, { $group: { _id: '$bin_id', n: { $sum: 1 } } }]);
      for (const r of rows) out.set(r._id, r.n);
      return out;
    },
    async busiestLocation() {
      const [r] = await t('bins').aggregate<{ _id: string; n: number }>([
        { $match: { active: true } },
        { $group: { _id: '$location_id', n: { $sum: 1 } } },
        { $sort: { n: -1, _id: 1 } },
        { $limit: 1 },
      ]);
      return r?._id ?? null;
    },
  };
  return repo;
}
