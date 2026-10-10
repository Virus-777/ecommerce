import { sql, type Kysely } from 'kysely';
import type { Inbox } from '../../../../kernel/events/inbox.js';
import { decodeCursor, encodeCursor } from '../../../../kernel/lib/pagination.js';
import type * as common from '../../../../spec/common.js';
import type { SupportDb } from '../../../../spec/support.js';
import { CLOSED_STATUSES } from '../../domain/rules.js';
import { FACT_COLUMNS, type CaseFacts, type CaseFilter, type CaseRec, type CaseSort, type FactColumn, type PendingApproval, type StoredPending, type SupportRepository, type Table } from '../../ports.js';

/** jsonb columns per table: values are sent as JSON text (pg would turn JS arrays into PG arrays) */
const JSON_COLUMNS: Record<Table, readonly string[]> = {
  case_categories: [],
  cases: ['next_action', 'decision', 'decision_draft'],
  case_items: ['snapshot'],
  case_messages: ['media_ids'],
  case_evidence: ['media_ids'],
  case_offers: [],
  case_remedies: ['order_item_ids'],
  case_appeals: ['media_ids'],
  case_events: [],
};

const keyOf = (t: Table) => (t === 'case_categories' ? 'key' : 'id');

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
const date = (s: string | null | undefined) => (s ? new Date(s) : null);
const actorText = (a: unknown) => (a ? JSON.stringify(a) : null);
function actorOf(text: string | null | undefined): common.Actor | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as common.Actor;
  } catch {
    return null;
  }
}

/** CaseFacts → the fact columns of cases (every column, so a saved facts object replaces the stored one) */
function factColumns(f: CaseFacts): Record<FactColumn, unknown> {
  return {
    order_ref: f.orderRef ?? null,
    placed_at: date(f.placedAt),
    return_ref: f.returnRef ?? null,
    customer_name: f.customerName ?? null,
    contact_email: f.contactEmail ?? null,
    city: f.city ?? null,
    seller_name: f.sellerName ?? null,
    owner_type: f.ownerType ?? null,
    reference: f.reference ?? null,
    trust_report_id: f.trustReportId ?? null,
    problem_type: f.problemType ?? null,
    desired_remedy: f.desiredRemedy ?? null,
    callback_phone: f.callbackPhone ?? null,
    info_request_from: f.infoRequest?.from ?? null,
    info_request_question: f.infoRequest?.question ?? null,
    info_request_due_at: date(f.infoRequest?.dueAt),
    info_requested_at: date(f.infoRequest?.askedAt),
    info_requested_by: actorText(f.infoRequest?.askedBy),
    escalated_at: date(f.escalation?.at),
    escalated_by: actorText(f.escalation?.by),
    escalation_reason: f.escalation?.reason ?? null,
    escalated_to: f.escalation?.to ?? null,
    escalation_note: f.escalation?.note ?? null,
    seller_replied_at: date(f.sellerRepliedAt),
    dispatch_overdue_due_at: date(f.dispatchOverdue?.dueAt),
    dispatch_overdue_noted_at: date(f.dispatchOverdue?.at),
    overdue_notified_for: date(f.overdueNotified),
    appeal_window_closed: !!f.appealWindowClosed,
  };
}

/** A cases row → CaseRec (fact columns gathered in facts, the pending approval in pending) */
function decodeCase(row: Record<string, any> | undefined): CaseRec | undefined {
  if (!row) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) if (!(FACT_COLUMNS as readonly string[]).includes(k) && k !== 'approval_request_id' && k !== 'pending_decision') out[k] = v;
  const r = row;
  const facts: CaseFacts = {
    orderRef: r.order_ref,
    placedAt: iso(r.placed_at),
    returnRef: r.return_ref,
    customerName: r.customer_name,
    contactEmail: r.contact_email,
    city: r.city,
    sellerName: r.seller_name,
    ownerType: r.owner_type,
    reference: r.reference,
    trustReportId: r.trust_report_id,
    problemType: r.problem_type,
    desiredRemedy: r.desired_remedy,
    callbackPhone: r.callback_phone,
    infoRequest: r.info_request_from ? { from: r.info_request_from, question: r.info_request_question ?? '', dueAt: iso(r.info_request_due_at) ?? '', askedAt: iso(r.info_requested_at) ?? '', askedBy: actorOf(r.info_requested_by) ?? { kind: 'system', id: null } } : null,
    escalation: r.escalated_at ? { at: iso(r.escalated_at)!, by: actorOf(r.escalated_by) ?? { kind: 'system', id: null }, reason: r.escalation_reason ?? '', to: r.escalated_to ?? '', note: r.escalation_note } : null,
    sellerRepliedAt: iso(r.seller_replied_at),
    dispatchOverdue: r.dispatch_overdue_due_at ? { dueAt: iso(r.dispatch_overdue_due_at)!, at: iso(r.dispatch_overdue_noted_at) ?? iso(r.dispatch_overdue_due_at)! } : null,
    overdueNotified: iso(r.overdue_notified_for),
    appealWindowClosed: !!r.appeal_window_closed,
  };
  out.facts = facts;
  out.pending = r.approval_request_id && r.pending_decision ? { ...(r.pending_decision as StoredPending), requestId: r.approval_request_id } : null;
  return out as unknown as CaseRec;
}

function encode(table: Table, row: Record<string, unknown>): Record<string, unknown> {
  const cols = JSON_COLUMNS[table];
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v === undefined) continue;
    if (table === 'cases' && k === 'facts') {
      Object.assign(out, factColumns((v ?? {}) as CaseFacts));
      continue;
    }
    if (table === 'cases' && k === 'pending') {
      const p = v as PendingApproval | null;
      out.approval_request_id = p?.requestId ?? null;
      if (p) {
        const { requestId: _id, ...rest } = p;
        out.pending_decision = JSON.stringify(rest);
      } else out.pending_decision = null;
      continue;
    }
    out[k] = cols.includes(k) ? (v === null ? null : JSON.stringify(v)) : v;
  }
  return out;
}

/** Rows read from a table, cases decoded */
const decode = (table: Table, row: any) => (table === 'cases' ? decodeCase(row) : row);

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
const fact = (column: 'order_ref' | 'customer_name' | 'seller_name' | 'return_ref') => sql<string>`lower(coalesce(${sql.ref(`cases.${column}`)}, ''))`;

function caseQuery(d: any, f: CaseFilter): any {
  let q = d.selectFrom('cases');
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
  if (f.orderId) q = q.where('order_id', '=', f.orderId);
  if (f.returnIds) q = f.returnIds.length ? q.where('return_id', 'in', f.returnIds) : q.where(sql<boolean>`false`);
  if (f.kinds) q = f.kinds.length ? q.where('kind', 'in', f.kinds) : q.where(sql<boolean>`false`);
  if (f.statuses) q = f.statuses.length ? q.where('status', 'in', f.statuses) : q.where(sql<boolean>`false`);
  if (f.ownerId) q = q.where('owner_staff_id', '=', f.ownerId);
  if (f.unassigned) q = q.where('owner_staff_id', 'is', null);
  if (f.dueBefore) q = q.where('next_response_due_at', '<', f.dueBefore);
  if (f.category) q = q.where('category_key', '=', f.category);
  if (f.priority) q = q.where('priority', '=', f.priority);
  if (f.handler) q = q.where('handler_kind', '=', f.handler);
  if (f.appealWindowOpen) q = q.where('appeal_window_closed', '=', false);
  if (f.appealDeadlineBefore) q = q.where('appeal_deadline', '<', f.appealDeadlineBefore);
  if (f.overdueUnannounced) q = q.where(sql<boolean>`overdue_notified_for is distinct from next_response_due_at`);
  if (f.openedFrom) q = q.where('opened_at', '>=', f.openedFrom);
  if (f.openedTo) q = q.where('opened_at', '<', f.openedTo);
  if (f.q?.trim()) {
    const term = like(f.q);
    q = q.where(
      sql<boolean>`(lower(cases.ref) like ${term} or lower(cases.subject) like ${term} or ${fact('order_ref')} like ${term} or ${fact('customer_name')} like ${term} or ${fact('seller_name')} like ${term} or ${fact('return_ref')} like ${term})`,
    );
  }
  return q;
}

function sorted(q: any, sort: CaseSort): any {
  switch (sort) {
    case 'newest':
      return q.orderBy('opened_at', 'desc').orderBy('id', 'desc');
    case 'updated':
      return q.orderBy('updated_at', 'desc').orderBy('id', 'desc');
    case 'priority':
      return q
        .orderBy(sql`case priority when 'urgent' then 0 when 'high' then 1 when 'medium' then 2 else 3 end`)
        .orderBy(sql`next_response_due_at asc nulls last`)
        .orderBy('id', 'asc');
    default:
      return q.orderBy(sql`next_response_due_at asc nulls last`).orderBy('opened_at', 'asc').orderBy('id', 'asc');
  }
}

/** Postgres adapter for SupportRepository. `db` is scoped to the `support` schema. */
export function createPostgresSupportRepository(db: Kysely<SupportDb>, inbox?: Inbox): SupportRepository {
  // generic table access: the row types are checked at the SupportRepository boundary
  const d: any = db;

  const repo: SupportRepository = {
    async transaction(fn) {
      if (db.isTransaction) return fn(repo);
      return db.transaction().execute((trx) => fn(createPostgresSupportRepository(trx, inbox)));
    },

    async claim(key) {
      if (!inbox) throw new Error('support repository: no inbox to claim event keys');
      return inbox.claim(db, key);
    },

    async get(table, id, o) {
      let q = d.selectFrom(table).selectAll().where(keyOf(table), '=', id);
      if (o?.forUpdate) q = q.forUpdate();
      return decode(table, await q.executeTakeFirst());
    },
    async find(table, where, o) {
      let q = applyWhere(d.selectFrom(table).selectAll(), where as Record<string, unknown>);
      for (const [c, dir] of o?.orderBy ?? []) q = q.orderBy(c, dir);
      if (o?.limit) q = q.limit(o.limit);
      if (o?.forUpdate) q = q.forUpdate();
      return ((await q.execute()) as unknown[]).map((row) => decode(table, row));
    },
    async count(table, where) {
      const r = await applyWhere(d.selectFrom(table).select(sql<number>`count(*)::int`.as('n')), where as Record<string, unknown>).executeTakeFirst();
      return (r as { n: number } | undefined)?.n ?? 0;
    },
    async insert(table, row) {
      return decode(table, await d.insertInto(table).values(encode(table, row as Record<string, unknown>)).returningAll().executeTakeFirstOrThrow());
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
      return decode(table, await d.updateTable(table).set(values).where(keyOf(table), '=', id).returningAll().executeTakeFirstOrThrow());
    },

    async seedCategories(rows) {
      if (!rows.length) return;
      await d
        .insertInto('case_categories')
        .values(rows)
        .onConflict((oc: any) => oc.column('key').doNothing())
        .execute();
    },
    async upsertCategory(row) {
      const { key: _key, ...rest } = row;
      return d
        .insertInto('case_categories')
        .values(row)
        .onConflict((oc: any) => oc.column('key').doUpdateSet(rest))
        .returningAll()
        .executeTakeFirstOrThrow();
    },

    async listCases(f, sort, page) {
      const base = caseQuery(d, f);
      const offset = page.mode === 'page' ? (page.page - 1) * page.limit : page.cursor ? Number(decodeCursor(page.cursor)[0]) || 0 : 0;
      const rows = (await sorted(base.selectAll(), sort)
        .limit(page.limit + 1)
        .offset(offset)
        .execute()).map((row: Record<string, unknown>) => decodeCase(row)!) as CaseRec[];
      const items = rows.slice(0, page.limit);
      const more = rows.length > page.limit;
      const nextCursor = more ? encodeCursor([offset + page.limit]) : null;
      if (page.mode === 'page') {
        const total = await repo.countCases(f);
        return { items, nextCursor, page: page.page, totalPages: Math.max(1, Math.ceil(total / page.limit)), total };
      }
      return { items, nextCursor };
    },
    async countCases(f) {
      const r = await caseQuery(d, f).select(sql<number>`count(*)::int`.as('n')).executeTakeFirst();
      return (r as { n: number } | undefined)?.n ?? 0;
    },
    async casesForItems(orderItemIds, openOnly) {
      if (!orderItemIds.length) return [];
      let q = d
        .selectFrom('case_items as i')
        .innerJoin('cases as c', 'c.id', 'i.case_id')
        .select(['i.case_id as caseId', 'i.order_item_id as orderItemId'])
        .where('i.order_item_id', 'in', orderItemIds);
      if (openOnly) q = q.where('c.status', 'not in', CLOSED_STATUSES as string[]);
      return q.execute();
    },
    async openCasesPerProduct(productIds) {
      const out = new Map<string, number>();
      if (!productIds.length) return out;
      const rows = await d
        .selectFrom('case_items as i')
        .innerJoin('cases as c', 'c.id', 'i.case_id')
        .select([sql<string>`i.snapshot->>'productId'`.as('product_id'), sql<number>`count(distinct c.id)::int`.as('n')])
        .where(sql<boolean>`i.snapshot->>'productId' in (${sql.join(productIds.map((p) => sql`${p}`))})`)
        .where('c.status', 'not in', CLOSED_STATUSES as string[])
        .where('c.kind', '<>', 'seller_request')
        .groupBy(sql`i.snapshot->>'productId'`)
        .execute();
      for (const r of rows as { product_id: string; n: number }[]) out.set(r.product_id, r.n);
      return out;
    },
    async openPerOwner(ownerIds, now) {
      const out = new Map<string, { open: number; overdue: number }>();
      if (!ownerIds.length) return out;
      const rows = await d
        .selectFrom('cases')
        .select(['owner_staff_id', sql<number>`count(*)::int`.as('open'), sql<number>`(count(*) filter (where next_response_due_at < ${now}))::int`.as('overdue')])
        .where('owner_staff_id', 'in', ownerIds)
        .where('status', 'not in', CLOSED_STATUSES as string[])
        .groupBy('owner_staff_id')
        .execute();
      for (const r of rows as { owner_staff_id: string; open: number; overdue: number }[]) out.set(r.owner_staff_id, { open: r.open, overdue: r.overdue });
      return out;
    },
  };
  return repo;
}
