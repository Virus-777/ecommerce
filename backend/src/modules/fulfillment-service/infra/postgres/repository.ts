import { sql, type Kysely } from 'kysely';
import type { Inbox } from '../../../../kernel/events/inbox.js';
import { paginate } from '../../../../kernel/lib/pagination.js';
import type { FulfillmentServiceDb } from '../../../../spec/fulfillment-service.js';
import type { Balances, FulfillmentServiceRepository, LedgerRec, StockGroup, Table } from '../../ports.js';

/** jsonb columns per table: values are sent as JSON text (pg would turn JS arrays into PG arrays) */
const JSON_COLUMNS: Record<Table, readonly string[]> = {
  enrollments: ['categories'],
  sku_enrollments: ['dimensions'],
  inbound_shipments: ['ship_from', 'destination'],
  inbound_lines: [],
  inbound_receipts: ['lines'],
  discrepancies: ['evidence_media_ids'],
  ownership_ledger: [],
  fulfillment_requests: ['items'],
  service_returns: ['evidence_media_ids'],
  removal_orders: ['lines', 'ship_to'],
  stock_differences: ['ledger', 'inventory'],
  fee_schedules: ['rates'],
  fee_charges: [],
  storage_snapshots: ['aged_units'],
};

/** Groups whose units are physically in our warehouse (the rest is expected) */
const PHYSICAL: StockGroup[] = ['receiving', 'available', 'reserved', 'unsellable', 'returned', 'removal_pending'];

function encode(table: Table, row: Record<string, unknown>): Record<string, unknown> {
  const cols = JSON_COLUMNS[table];
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v === undefined) continue;
    out[k] = cols.includes(k) ? (v === null ? null : JSON.stringify(v)) : v;
  }
  return out;
}

const isOp = (v: unknown): v is { op: string; value: unknown } => typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date) && 'op' in v;

function applyWhere(q: any, where: Record<string, unknown>): any {
  for (const [col, v] of Object.entries(where)) {
    if (v === undefined) continue;
    if (v === null) q = q.where(col, 'is', null);
    else if (Array.isArray(v)) q = v.length ? q.where(col, 'in', v) : q.where(sql<boolean>`false`);
    else if (isOp(v)) {
      if (v.op === 'not in') q = Array.isArray(v.value) && v.value.length ? q.where(col, 'not in', v.value) : q;
      else if (v.op === 'between' && Array.isArray(v.value)) q = q.where(col, '>=', v.value[0]).where(col, '<=', v.value[1]);
      else q = q.where(col, v.op, v.value);
    } else q = q.where(col, '=', v);
  }
  return q;
}

const like = (s: string) => `%${s.trim().toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** Postgres adapter for FulfillmentServiceRepository. `db` is scoped to the `fulfillment_service` schema. */
export function createPostgresFulfillmentServiceRepository(db: Kysely<FulfillmentServiceDb>, inbox: Inbox): FulfillmentServiceRepository {
  // generic table access: the row types are checked at the FulfillmentServiceRepository boundary
  const d: any = db;

  const repo: FulfillmentServiceRepository = {
    async transaction(fn) {
      if (db.isTransaction) return fn(repo);
      return db.transaction().execute((trx) => fn(createPostgresFulfillmentServiceRepository(trx, inbox)));
    },
    claim(key) {
      return inbox.claim(db, key);
    },

    async get(table, id, o) {
      let q = d.selectFrom(table).selectAll().where('id', '=', id);
      if (o?.forUpdate) q = q.forUpdate();
      return q.executeTakeFirst();
    },
    async find(table, where, o) {
      let q = applyWhere(d.selectFrom(table).selectAll(), where as Record<string, unknown>);
      for (const [c, dir] of o?.orderBy ?? []) q = q.orderBy(c, dir);
      if (o?.limit) q = q.limit(o.limit);
      if (o?.forUpdate) q = q.forUpdate();
      return q.execute();
    },
    async findOne(table, where, o) {
      return (await repo.find(table, where, { ...o, limit: 1 }))[0];
    },
    async count(table, where) {
      const r = await applyWhere(d.selectFrom(table).select(sql<number>`count(*)::int`.as('n')), where as Record<string, unknown>).executeTakeFirst();
      return (r as { n: number } | undefined)?.n ?? 0;
    },
    async insert(table, row) {
      return d.insertInto(table).values(encode(table, row as Record<string, unknown>)).returningAll().executeTakeFirstOrThrow();
    },
    async insertMany(table, rows) {
      if (!rows.length) return;
      await d
        .insertInto(table)
        .values(rows.map((r) => encode(table, r as Record<string, unknown>)))
        .execute();
    },
    async insertIfNew(table, row) {
      const r = await d
        .insertInto(table)
        .values(encode(table, row as Record<string, unknown>))
        .onConflict((oc: any) => oc.doNothing())
        .returning(sql`1`.as('ok'))
        .executeTakeFirst();
      return Boolean(r);
    },
    async update(table, id, patch) {
      const values = encode(table, patch as Record<string, unknown>);
      if (!Object.keys(values).length) return (await repo.get(table, id))!;
      return d.updateTable(table).set(values).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
    },
    async updateWhere(table, where, patch) {
      const values = encode(table, patch as Record<string, unknown>);
      if (!Object.keys(values).length) return 0;
      const r = await applyWhere(d.updateTable(table).set(values), where as Record<string, unknown>).executeTakeFirst();
      return Number((r as { numUpdatedRows?: bigint } | undefined)?.numUpdatedRows ?? 0);
    },
    async removeWhere(table, where) {
      await applyWhere(d.deleteFrom(table), where as Record<string, unknown>).execute();
    },
    async page(table, where, page, o) {
      let q = applyWhere(d.selectFrom(table).selectAll(), where as Record<string, unknown>);
      const term = o.search?.term?.trim();
      if (term && o.search?.columns.length) {
        const t = like(term);
        q = q.where(sql<boolean>`(${sql.join(o.search.columns.map((c) => sql`lower(coalesce(${sql.ref(c)}::text, '')) like ${t}`), sql` or `)})`);
      }
      return paginate(q, page, { column: o.order.column, direction: o.order.direction }) as never;
    },

    async balances(ids) {
      const out: Balances = new Map();
      if (!ids.length) return out;
      const rows = (await sql<{ sku: string; grp: StockGroup; qty: number }>`
        select sku_enrollment_id as sku, to_group as grp, sum(quantity)::int as qty from fulfillment_service.ownership_ledger
          where sku_enrollment_id in (${sql.join([...ids])}) and to_group is not null group by 1, 2
        union all
        select sku_enrollment_id, from_group, -sum(quantity)::int from fulfillment_service.ownership_ledger
          where sku_enrollment_id in (${sql.join([...ids])}) and from_group is not null group by 1, 2`.execute(db)).rows;
      for (const r of rows) {
        const b = out.get(r.sku) ?? {};
        b[r.grp] = (b[r.grp] ?? 0) + Number(r.qty);
        out.set(r.sku, b);
      }
      return out;
    },
    async inflows(ids) {
      if (!ids.length) return [];
      return d
        .selectFrom('ownership_ledger')
        .selectAll()
        .where('sku_enrollment_id', 'in', [...ids])
        .where('to_group', 'in', PHYSICAL)
        .where((eb: any) => eb.or([eb('from_group', 'is', null), eb('from_group', '=', 'inbound')]))
        .orderBy('at', 'desc')
        .orderBy('id', 'desc')
        .execute() as Promise<LedgerRec[]>;
    },
    async lockSkus(ids) {
      if (!ids.length) return;
      await d.selectFrom('sku_enrollments').select('id').where('id', 'in', [...ids]).orderBy('id').forUpdate().execute();
    },
    async upsertSnapshot(row) {
      const values = encode('storage_snapshots', row as unknown as Record<string, unknown>);
      await d
        .insertInto('storage_snapshots')
        .values(values)
        .onConflict((oc: any) => oc.columns(['day', 'sku_enrollment_id']).doUpdateSet({ seller_id: values.seller_id, units: values.units, cubic_feet: values.cubic_feet, aged_units: values.aged_units }))
        .execute();
    },
  };
  return repo;
}
