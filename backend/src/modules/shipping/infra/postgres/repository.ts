import { sql, type Kysely } from 'kysely';
import { paginate } from '../../../../kernel/lib/pagination.js';
import type { ShippingDb } from '../../../../spec/shipping.js';
import type { ShippingRepository, Table } from '../../ports.js';

/** jsonb columns per table: values are sent as JSON text (pg would turn JS arrays into PG arrays) */
const JSON_COLUMNS: Record<Table, readonly string[]> = {
  carriers: ['contacts'],
  carrier_services: [],
  methods: ['carrier_service_ids'],
  zones: ['regions', 'postal_prefixes', 'address_kinds', 'transit_by_method'],
  profiles: ['methods', 'updated_by'],
  seller_settings: ['coverage', 'business_days', 'updated_by', 'default_parcel'],
  closures: [],
  dispatch_targets: ['official', 'seller_default', 'set_by'],
  // carrier_service_ids, postal_prefixes and zone_ids are PostgreSQL arrays
  notices: ['carrier_codes', 'regions', 'effect', 'surfaces', 'created_by'],
  free_shipping_rules: [],
  shipments: ['to_address', 'estimated_arrival', 'failed_delivery', 'recorded_by'],
  shipment_lines: [],
  tracking_events: [],
  tracking_corrections: ['by'],
  labels: ['purchased_by'],
  label_quotes: ['parcel', 'estimated_arrival'],
  dispatch_watch: ['open_item_ids'],
  exceptions: ['seller_response', 'resolution', 'opened_by'],
  exception_log: ['actor'],
  claims: ['evidence_ids'],
  webhook_events: ['payload'],
};

const KEY: Partial<Record<Table, string>> = { dispatch_watch: 'group_id' };
const keyOf = (t: Table) => KEY[t] ?? 'id';

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

/** Postgres adapter for ShippingRepository. `db` is scoped to the `shipping` schema. */
export function createPostgresShippingRepository(db: Kysely<ShippingDb>): ShippingRepository {
  // generic table access: the row types are checked at the ShippingRepository boundary
  const d: any = db;

  const repo: ShippingRepository = {
    async transaction(fn) {
      if (db.isTransaction) return fn(repo);
      return db.transaction().execute((trx) => fn(createPostgresShippingRepository(trx)));
    },

    async get(table, id, o) {
      let q = d.selectFrom(table).selectAll().where(keyOf(table), '=', id);
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
      return d.updateTable(table).set(values).where(keyOf(table), '=', id).returningAll().executeTakeFirstOrThrow();
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
      return paginate(q, page, { column: o.order.column, direction: o.order.direction, ...(keyOf(table) !== 'id' ? { id: keyOf(table) } : {}) }) as never;
    },
    async exceptionCounts() {
      const rows = (await d
        .selectFrom('exceptions')
        .select(['kind', sql<number>`count(*)::int`.as('n'), sql<number>`count(*) filter (where customer_notified_at is null)::int`.as('nn')])
        .where('status', 'in', ['open', 'in_progress', 'escalated'])
        .groupBy('kind')
        .execute()) as { kind: string; n: number; nn: number }[];
      return { kinds: Object.fromEntries(rows.map((r) => [r.kind, r.n])), notNotified: rows.reduce((s, r) => s + r.nn, 0) };
    },
  };
  return repo;
}
