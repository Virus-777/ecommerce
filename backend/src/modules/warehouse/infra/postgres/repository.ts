import { sql, type Kysely } from 'kysely';
import { paginate } from '../../../../kernel/lib/pagination.js';
import type { WarehouseDb } from '../../../../spec/warehouse.js';
import type { Table, WarehouseRepository } from '../../ports.js';

/** jsonb columns per table: values are sent as JSON text (pg would turn JS arrays into PG arrays) */
const JSON_COLUMNS: Record<Table, readonly string[]> = {
  bins: [],
  bin_assignments: [],
  fulfillments: ['ship_to', 'discrepancy_ids'],
  fulfillment_lines: [],
  waves: [],
  scan_log: [],
  box_types: ['dimensions', 'max_weight'],
  packages: ['dimensions', 'weight'],
  // serial_numbers is a PostgreSQL text[] array
  package_items: [],
  putaway_tasks: [],
  return_parcels: ['expected_items', 'photo_media_ids'],
};

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
    else if (isOp(v)) q = q.where(col, v.op, v.value);
    else q = q.where(col, '=', v);
  }
  return q;
}

const like = (s: string) => `%${s.trim().toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** Postgres adapter for WarehouseRepository. `db` is scoped to the `warehouse` schema. */
export function createPostgresWarehouseRepository(db: Kysely<WarehouseDb>): WarehouseRepository {
  // generic table access: the row types are checked at the WarehouseRepository boundary
  const d: any = db;

  const repo: WarehouseRepository = {
    async transaction(fn) {
      if (db.isTransaction) return fn(repo);
      return db.transaction().execute((trx) => fn(createPostgresWarehouseRepository(trx)));
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
    async assignmentCounts(binIds) {
      const out = new Map<string, number>();
      if (!binIds.length) return out;
      const rows = (await d
        .selectFrom('bin_assignments')
        .select(['bin_id', sql<number>`count(*)::int`.as('n')])
        .where('bin_id', 'in', binIds)
        .groupBy('bin_id')
        .execute()) as { bin_id: string; n: number }[];
      for (const r of rows) out.set(r.bin_id, r.n);
      return out;
    },
    async busiestLocation() {
      const r = (await d
        .selectFrom('bins')
        .select(['location_id', sql<number>`count(*)::int`.as('n')])
        .where('active', '=', true)
        .groupBy('location_id')
        .orderBy('n', 'desc')
        .orderBy('location_id')
        .limit(1)
        .executeTakeFirst()) as { location_id: string } | undefined;
      return r?.location_id ?? null;
    },
  };
  return repo;
}
