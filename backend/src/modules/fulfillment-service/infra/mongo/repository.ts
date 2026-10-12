import type { ModuleStore, Table as Collection } from '../../../../kernel/mongo/index.js';
import type { Balances, FulfillmentServiceRepository, LedgerRec, StockGroup, Table } from '../../ports.js';

/** Groups whose units are physically in our warehouse (the rest is expected) */
const PHYSICAL: StockGroup[] = ['receiving', 'available', 'reserved', 'unsellable', 'returned', 'removal_pending'];

const isOp = (v: unknown): v is { op: string; value: unknown } => typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date) && 'op' in v;
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const CMP: Record<string, string> = { '<': '$lt', '<=': '$lte', '>': '$gt', '>=': '$gte' };

/** A Where (ports.ts) as a filter on row fields, with SQL's meaning (`<>` and `not in` skip nulls) */
function filterOf(where: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [col, v] of Object.entries(where)) {
    if (v === undefined) continue;
    if (v === null) out[col] = null;
    else if (Array.isArray(v)) out[col] = { $in: v };
    else if (isOp(v)) {
      if (v.op in CMP) out[col] = { [CMP[v.op]!]: v.value };
      else if (v.op === '<>') out[col] = v.value === null ? { $ne: null } : { $nin: [v.value, null] };
      else if (v.op === 'is not') out[col] = { $ne: v.value };
      else if (v.op === 'not in') {
        if (Array.isArray(v.value) && v.value.length) out[col] = { $nin: [...v.value, null] };
      } else if (v.op === 'between' && Array.isArray(v.value)) out[col] = { $gte: v.value[0], $lte: v.value[1] };
      else throw new Error(`fulfillment-service: unknown condition ${v.op}`);
    } else out[col] = v;
  }
  return out;
}

/** MongoDB adapter for FulfillmentServiceRepository (docs/04-mongodb-migration.md): one collection per spec table. */
export function createMongoFulfillmentServiceRepository(store: ModuleStore): FulfillmentServiceRepository {
  // generic table access: the row types are checked at the FulfillmentServiceRepository boundary
  const t = (table: Table): Collection<any> => store.table<any>(table);

  /** The unique keys of a table (primary key first): a row conflicts when it matches one of them */
  const uniqueKeys = (table: Table): string[][] => {
    const c = t(table);
    const keys: string[][] = [];
    if (c.def.idField) keys.push([c.def.idField]);
    else if (c.def.key.length) keys.push([...c.def.key]);
    for (const ix of c.def.indexes) if (ix.unique) keys.push(Object.keys(ix.key).map((k) => (k === '_id' ? c.def.idField! : k)));
    return keys;
  };

  const repo: FulfillmentServiceRepository = {
    transaction: (fn) => store.transaction((tx) => fn(createMongoFulfillmentServiceRepository(tx))),
    claim: (key) => store.claim(key),

    get: (table, id, o) => t(table).get(id, { forUpdate: o?.forUpdate }),
    find: (table, where, o) =>
      t(table).find(filterOf(where as Record<string, unknown>), {
        sort: o?.orderBy?.length ? Object.fromEntries(o.orderBy.map(([c, dir]) => [c, dir === 'desc' ? -1 : 1])) : undefined,
        limit: o?.limit,
        forUpdate: o?.forUpdate,
      }),
    async findOne(table, where, o) {
      return (await repo.find(table, where, { ...o, limit: 1 }))[0];
    },
    count: (table, where) => t(table).count(filterOf(where as Record<string, unknown>)),
    insert: (table, row) => t(table).insert(row),
    insertMany: (table, rows) => t(table).insertMany(rows),
    async insertIfNew(table, row) {
      // on conflict (any unique key) do nothing: an upsert matching any of the row's unique keys inserts only when
      // none exists (keys with a null are skipped: a null never conflicts, as in PostgreSQL)
      const c = t(table);
      const values = row as Record<string, unknown>;
      const keys = uniqueKeys(table).filter((k) => k.every((col) => values[col] != null));
      if (!keys.length) {
        await c.insert(row);
        return true;
      }
      const full: Record<string, unknown> = { ...values };
      for (const col of c.def.nullable) if (full[col] === undefined) full[col] = null;
      const match = c.filter({ $or: keys.map((k) => Object.fromEntries(k.map((col) => [col, values[col]]))) });
      try {
        const r = await c.model.updateOne(match, { $setOnInsert: c.toDoc(full) }, { session: c.session, upsert: true, runValidators: true });
        return r.upsertedCount === 1;
      } catch (err) {
        // outside a transaction a concurrent insert of the same key can still win the race
        if (!store.inTransaction && (err as { code?: number }).code === 11000) return false;
        throw err;
      }
    },
    async update(table, id, patch) {
      const values = Object.fromEntries(Object.entries(patch as Record<string, unknown>).filter(([, v]) => v !== undefined));
      const r = Object.keys(values).length ? await t(table).update(id, values) : await t(table).get(id);
      if (!r) throw new Error(`fulfillment-service: ${table} ${id} not found`);
      return r;
    },
    async updateWhere(table, where, patch) {
      const values = Object.fromEntries(Object.entries(patch as Record<string, unknown>).filter(([, v]) => v !== undefined));
      if (!Object.keys(values).length) return 0;
      return t(table).updateMany(filterOf(where as Record<string, unknown>), values);
    },
    async removeWhere(table, where) {
      await t(table).deleteMany(filterOf(where as Record<string, unknown>));
    },
    page(table, where, page, o) {
      const filter = filterOf(where as Record<string, unknown>);
      const term = o.search?.term?.trim();
      if (term && o.search?.columns.length) {
        // case-insensitive contains over the columns (SQL: lower(coalesce(col::text, '')) like %term%)
        const rx = { $regex: escapeRegExp(term.toLowerCase()), $options: 'i' };
        filter.$and = [{ $or: o.search.columns.map((c) => ({ [c]: rx })) }];
      }
      return t(table).page(filter, page, { column: o.order.column, direction: o.order.direction });
    },

    async balances(ids) {
      const out: Balances = new Map();
      if (!ids.length) return out;
      const ledger = t('ownership_ledger');
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
    },
    async inflows(ids) {
      if (!ids.length) return [];
      return t('ownership_ledger').find(
        { sku_enrollment_id: { $in: [...ids] }, to_group: { $in: PHYSICAL }, $or: [{ from_group: null }, { from_group: 'inbound' }] },
        { sort: { at: -1, id: -1 } },
      ) as Promise<LedgerRec[]>;
    },
    async lockSkus(ids) {
      if (!ids.length) return;
      // lock-by-write on the SKU enrollments (serialises decisions on their ledger balances)
      await t('sku_enrollments').find({ id: { $in: [...new Set(ids)] } }, { forUpdate: true });
    },
    async upsertSnapshot(row) {
      await t('storage_snapshots').upsert(row, {
        key: ['day', 'sku_enrollment_id'],
        update: { seller_id: row.seller_id, units: row.units, cubic_feet: row.cubic_feet, aged_units: row.aged_units },
      });
    },
  };
  return repo;
}
