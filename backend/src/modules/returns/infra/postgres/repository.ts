import { sql, type Kysely } from 'kysely';
import { paginate } from '../../../../kernel/lib/pagination.js';
import type { ReturnsDb } from '../../../../spec/returns.js';
import type { DraftRec, RefundFilter, ReturnFilter, ReturnsRepository, Table } from '../../ports.js';

/** jsonb columns per table: values are sent as JSON text (pg would turn JS arrays into PG arrays) */
const JSON_COLUMNS: Record<Table, readonly string[]> = {
  policy_versions: ['responsibilities'],
  category_exceptions: ['shown_on'],
  seller_terms: ['remedies', 'return_address'],
  returns: ['media_ids', 'terms_snapshot', 'info_request', 'decision', 'escalation', 'exception', 'inspector'],
  return_items: ['options'],
  return_shipments: ['from_address', 'to_address'],
  inspection_drafts: ['inspection', 'remedy', 'saved_by'],
  return_evidence: ['media_ids', 'added_by'],
  inspections: ['checks', 'missing_parts', 'media_ids'],
  refund_requests: ['order_item_ids', 'deductions'],
  replacements: [],
  return_events: [],
};

const KEY: Partial<Record<Table, string>> = { inspection_drafts: 'return_id' };
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
    else if (isOp(v)) {
      if (v.op === 'not in') q = Array.isArray(v.value) && v.value.length ? q.where(col, 'not in', v.value) : q;
      else q = q.where(col, v.op, v.value);
    } else q = q.where(col, '=', v);
  }
  return q;
}

const like = (s: string) => `%${s.trim().toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
const list = (values: readonly string[]) => sql.join(values.map((v) => sql`${v}`));
const ACTIVE_REFUND = ['requested', 'under_review', 'approved', 'processing', 'failed'];

function returnQuery(d: any, f: ReturnFilter): any {
  let q = d.selectFrom('returns');
  if (f.customerId !== undefined || f.guestSessionId !== undefined) {
    const c = f.customerId ?? null;
    const g = f.guestSessionId ?? null;
    if (c && g) q = q.where((eb: any) => eb.or([eb('customer_id', '=', c), eb('guest_session_id', '=', g)]));
    else if (c) q = q.where('customer_id', '=', c);
    else if (g) q = q.where('guest_session_id', '=', g);
    else q = q.where(sql<boolean>`false`);
  }
  if (f.ids) q = f.ids.length ? q.where('id', 'in', f.ids) : q.where(sql<boolean>`false`);
  if (f.sellerId) q = q.where('seller_id', '=', f.sellerId);
  if (f.ownerType) q = q.where('owner_type', '=', f.ownerType);
  if (f.orderId) q = q.where('order_id', '=', f.orderId);
  if (f.statuses) q = f.statuses.length ? q.where('status', 'in', f.statuses) : q.where(sql<boolean>`false`);
  if (f.notStatuses?.length) q = q.where('status', 'not in', f.notStatuses);
  if (f.platformHandling !== undefined) q = q.where('platform_handling', '=', f.platformHandling);
  if (f.disputed !== undefined) {
    const cond = sql<boolean>`(platform_handling or escalation is not null or case_id is not null)`;
    q = q.where(f.disputed ? cond : sql<boolean>`not ${cond}`);
  }
  if (f.hasException !== undefined) q = q.where('exception', f.hasException ? 'is not' : 'is', null);
  if (f.reason) q = q.where('reason', '=', f.reason);
  if (f.ownerStaffId) q = q.where('owner_staff_id', '=', f.ownerStaffId);
  if (f.requestedFrom) q = q.where('requested_at', '>=', f.requestedFrom);
  if (f.requestedTo) q = q.where('requested_at', '<', f.requestedTo);
  if (f.dueFrom) q = q.where('response_due_at', '>=', f.dueFrom);
  if (f.dueBefore) q = q.where('response_due_at', '<', f.dueBefore);
  if (f.completedFrom) q = q.where('completed_at', '>=', f.completedFrom);
  if (f.refundStatuses?.length) {
    q = q.where(sql<boolean>`exists (select 1 from returns.refund_requests rr where rr.return_id = returns.id and rr.status in (${list(f.refundStatuses)}))`);
  }
  if (f.refundPending !== undefined) {
    const cond = sql<boolean>`exists (select 1 from returns.refund_requests rr where rr.return_id = returns.id and rr.status in (${list(ACTIVE_REFUND)}))`;
    q = q.where(f.refundPending ? cond : sql<boolean>`not ${cond}`);
  }
  if (f.productIds) {
    q = f.productIds.length ? q.where(sql<boolean>`exists (select 1 from returns.return_items ri where ri.return_id = returns.id and ri.product_id in (${list(f.productIds)}))`) : q.where(sql<boolean>`false`);
  }
  if (f.q?.trim()) {
    const term = like(f.q);
    q = q.where(
      sql<boolean>`(lower(ref) like ${term} or lower(order_ref) like ${term} or exists (select 1 from returns.return_items ri where ri.return_id = returns.id and (lower(ri.title) like ${term} or lower(coalesce(ri.sku, '')) like ${term})))`,
    );
  }
  return q;
}

/** Postgres adapter for ReturnsRepository. `db` is scoped to the `returns` schema. */
export function createPostgresReturnsRepository(db: Kysely<ReturnsDb>): ReturnsRepository {
  // generic table access: the row types are checked at the ReturnsRepository boundary
  const d: any = db;

  const repo: ReturnsRepository = {
    async transaction(fn) {
      if (db.isTransaction) return fn(repo);
      return db.transaction().execute((trx) => fn(createPostgresReturnsRepository(trx)));
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
    async update(table, id, patch) {
      const values = encode(table, patch as Record<string, unknown>);
      if (!Object.keys(values).length) return (await repo.get(table, id))!;
      return d.updateTable(table).set(values).where(keyOf(table), '=', id).returningAll().executeTakeFirstOrThrow();
    },
    async remove(table, id) {
      await d.deleteFrom(table).where(keyOf(table), '=', id).execute();
    },

    async upsertDraft(row) {
      const values = encode('inspection_drafts', row as unknown as Record<string, unknown>);
      const { return_id: _id, ...rest } = values;
      return d
        .insertInto('inspection_drafts')
        .values(values)
        .onConflict((oc: any) => oc.column('return_id').doUpdateSet(rest))
        .returningAll()
        .executeTakeFirstOrThrow() as Promise<DraftRec>;
    },

    async listReturns(f, page) {
      return paginate(returnQuery(d, f).selectAll(), page, { column: 'requested_at', direction: 'desc' }) as never;
    },
    async countReturns(f) {
      const r = await returnQuery(d, f).select(sql<number>`count(*)::int`.as('n')).executeTakeFirst();
      return (r as { n: number } | undefined)?.n ?? 0;
    },
    async listRefunds(f: RefundFilter, page) {
      let q = d.selectFrom('refund_requests').selectAll();
      if (f.status) q = q.where('status', '=', f.status);
      if (f.statuses) q = f.statuses.length ? q.where('status', 'in', f.statuses) : q.where(sql<boolean>`false`);
      if (f.source) q = q.where('source', '=', f.source);
      if (f.sellerId) q = q.where('seller_id', '=', f.sellerId);
      if (f.orderId) q = q.where('order_id', '=', f.orderId);
      if (f.caseId) q = q.where('case_id', '=', f.caseId);
      if (f.returnIds) q = f.returnIds.length ? q.where('return_id', 'in', f.returnIds) : q.where(sql<boolean>`false`);
      return paginate(q, page, { column: 'created_at', direction: 'desc' }) as never;
    },
    async usedQuantities(orderItemIds) {
      const out = new Map<string, number>();
      if (!orderItemIds.length) return out;
      const rows = await d
        .selectFrom('return_items as i')
        .innerJoin('returns as r', 'r.id', 'i.return_id')
        .select(['i.order_item_id as order_item_id', sql<number>`coalesce(sum(i.quantity), 0)::int`.as('n')])
        .where('i.order_item_id', 'in', orderItemIds)
        .where('r.status', 'not in', ['cancelled', 'rejected'])
        .groupBy('i.order_item_id')
        .execute();
      for (const r of rows) out.set(r.order_item_id, r.n);
      return out;
    },
    async openReturnsPerProduct(productIds) {
      const out = new Map<string, number>();
      if (!productIds.length) return out;
      const rows = await d
        .selectFrom('return_items as i')
        .innerJoin('returns as r', 'r.id', 'i.return_id')
        .select(['i.product_id as product_id', sql<number>`count(distinct r.id)::int`.as('n')])
        .where('i.product_id', 'in', productIds)
        .where('r.status', 'not in', ['completed', 'cancelled', 'rejected'])
        .groupBy('i.product_id')
        .execute();
      for (const r of rows) out.set(r.product_id, r.n);
      return out;
    },
  };
  return repo;
}
