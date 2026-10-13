import type { ModuleStore } from '../../kernel/mongo/index.js';
import type { Filter, Sort, Table as MongoTable } from '../../kernel/mongo/table.js';
import { decodeCursor, encodeCursor } from '../../kernel/lib/pagination.js';
import type * as common from '../../spec/common.js';
import { CLOSED_STATUSES } from './domain/rules.js';
import { FACT_COLUMNS, type CaseFacts, type CaseFilter, type CaseRec, type CaseSort, type FactColumn, type PendingApproval, type Recs, type StoredPending, type SupportRepository, type Table } from './ports.js';

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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

/** A row (or patch) as stored: a case's facts and pending approval become their columns */
function encode(table: Table, row: Record<string, unknown>): Record<string, unknown> {
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
        out.pending_decision = rest;
      } else out.pending_decision = null;
      continue;
    }
    out[k] = v;
  }
  return out;
}

/** Rows read from a table, cases decoded */
const decode = <T extends Table>(table: T, row: unknown): Recs[T] => (table === 'cases' ? decodeCase(row as Record<string, unknown>) : row) as Recs[T];

const isOp = (v: unknown): v is { op: string; value: unknown } => typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date) && 'op' in v;

/** A column condition (ports Cond) as a MongoDB condition, with SQL's meaning (`<>` and NOT IN skip nulls) */
function cond(v: unknown): unknown {
  if (v === null) return null;
  if (Array.isArray(v)) return { $in: v };
  if (isOp(v)) {
    switch (v.op) {
      case '<':
        return { $lt: v.value };
      case '<=':
        return { $lte: v.value };
      case '>':
        return { $gt: v.value };
      case '>=':
        return { $gte: v.value };
      case '<>':
        return { $nin: [v.value, null] };
      case 'is not':
        return { $ne: v.value };
      case 'not in':
        // an empty list leaves the column unfiltered (as before)
        return Array.isArray(v.value) && v.value.length ? { $nin: [...v.value, null] } : undefined;
      default:
        throw new Error(`support: unknown operator ${v.op}`);
    }
  }
  return v;
}

function where(w: Record<string, unknown>): Filter {
  const out: Filter = {};
  for (const [k, v] of Object.entries(w)) {
    if (v === undefined) continue;
    const c = cond(v);
    if (c !== undefined) out[k] = c;
  }
  return out;
}

const sortOf = (orderBy: [string, 'asc' | 'desc'][] | undefined): Sort | undefined =>
  orderBy?.length ? Object.fromEntries(orderBy.map(([c, d]) => [c, d === 'desc' ? -1 : 1])) : undefined;

/** The case-list filter as a MongoDB filter on cases */
function caseFilter(f: CaseFilter): Filter {
  const and: Filter[] = [];
  const none = { id: { $in: [] } };
  if (f.customerId !== undefined || f.guestSessionId !== undefined) {
    const c = f.customerId ?? null;
    const g = f.guestSessionId ?? null;
    if (c && g) and.push({ $or: [{ customer_id: c }, { guest_session_id: g }] });
    else if (c) and.push({ customer_id: c });
    else if (g) and.push({ guest_session_id: g });
    else and.push(none);
  }
  if (f.ids) and.push({ id: { $in: f.ids } });
  if (f.sellerId) and.push({ seller_id: f.sellerId });
  if (f.orderId) and.push({ order_id: f.orderId });
  if (f.returnIds) and.push({ return_id: { $in: f.returnIds } });
  if (f.kinds) and.push({ kind: { $in: f.kinds } });
  if (f.statuses) and.push({ status: { $in: f.statuses } });
  if (f.ownerId) and.push({ owner_staff_id: f.ownerId });
  if (f.unassigned) and.push({ owner_staff_id: null });
  if (f.dueBefore) and.push({ next_response_due_at: { $lt: f.dueBefore } });
  if (f.category) and.push({ category_key: f.category });
  if (f.priority) and.push({ priority: f.priority });
  if (f.handler) and.push({ handler_kind: f.handler });
  if (f.appealWindowOpen) and.push({ appeal_window_closed: false });
  if (f.appealDeadlineBefore) and.push({ appeal_deadline: { $lt: f.appealDeadlineBefore } });
  // overdue_notified_for IS DISTINCT FROM next_response_due_at
  if (f.overdueUnannounced) and.push({ $expr: { $ne: [{ $ifNull: ['$overdue_notified_for', null] }, { $ifNull: ['$next_response_due_at', null] }] } });
  if (f.openedFrom) and.push({ opened_at: { $gte: f.openedFrom } });
  if (f.openedTo) and.push({ opened_at: { $lt: f.openedTo } });
  if (f.q?.trim()) {
    const term = { $regex: escapeRegExp(f.q.trim()), $options: 'i' };
    and.push({ $or: [{ ref: term }, { subject: term }, { order_ref: term }, { customer_name: term }, { seller_name: term }, { return_ref: term }] });
  }
  return and.length ? { $and: and } : {};
}

/** MongoDB adapter for SupportRepository (docs/04-mongodb-migration.md): one collection per spec table. */
export function createMongoSupportRepository(store: ModuleStore): SupportRepository {
  const t = <T extends Table>(name: T) => store.table<Record<string, unknown>>(name) as MongoTable<any>;
  const cases = t('cases');

  const repo: SupportRepository = {
    transaction: (fn) => store.transaction((tx) => fn(createMongoSupportRepository(tx))),
    claim: (key) => store.claim(key),

    async get(table, id, o) {
      const row = await t(table).get(id, o);
      return row && decode(table, row);
    },
    async find(table, w, o) {
      const rows = await t(table).find(where(w as Record<string, unknown>), { sort: sortOf(o?.orderBy as [string, 'asc' | 'desc'][]), limit: o?.limit, forUpdate: o?.forUpdate });
      return rows.map((row) => decode(table, row));
    },
    count: (table, w) => t(table).count(where(w as Record<string, unknown>)),
    async insert(table, row) {
      return decode(table, await t(table).insert(encode(table, row as Record<string, unknown>)));
    },
    async insertMany(table, rows) {
      await t(table).insertMany(rows.map((r) => encode(table, r as Record<string, unknown>)));
    },
    async update(table, id, patch) {
      const values = encode(table, patch as Record<string, unknown>);
      const row = Object.keys(values).length ? await t(table).update(id, values) : await t(table).get(id);
      if (!row) throw new Error(`support: ${table} ${id} not found`);
      return decode(table, row);
    },

    async seedCategories(rows) {
      await t('case_categories').insertManyIfAbsent(rows);
    },
    upsertCategory: (row) => t('case_categories').upsert(row),

    async listCases(f, sort, page) {
      const offset = page.mode === 'page' ? (page.page - 1) * page.limit : page.cursor ? Number(decodeCursor(page.cursor)[0]) || 0 : 0;
      const filter = caseFilter(f);
      let rows: Record<string, unknown>[];
      if (sort === 'newest' || sort === 'updated') {
        const column = sort === 'newest' ? 'opened_at' : 'updated_at';
        rows = await cases.find(filter, { sort: { [column]: -1, id: -1 }, skip: offset, limit: page.limit + 1 });
      } else {
        // next_response_due_at asc nulls last (MongoDB sorts nulls first): a computed flag sorts the nulls after
        const docs = await cases.aggregate<Record<string, unknown>>([
          { $match: cases.filter(filter) },
          {
            $addFields: {
              _due_null: { $cond: [{ $eq: [{ $ifNull: ['$next_response_due_at', null] }, null] }, 1, 0] },
              ...(sort === 'priority' ? { _rank: { $switch: { branches: [{ case: { $eq: ['$priority', 'urgent'] }, then: 0 }, { case: { $eq: ['$priority', 'high'] }, then: 1 }, { case: { $eq: ['$priority', 'medium'] }, then: 2 }], default: 3 } } } : {}),
            },
          },
          { $sort: sort === 'priority' ? { _rank: 1, _due_null: 1, next_response_due_at: 1, _id: 1 } : { _due_null: 1, next_response_due_at: 1, opened_at: 1, _id: 1 } },
          { $skip: offset },
          { $limit: page.limit + 1 },
          { $project: { _due_null: 0, _rank: 0 } },
        ]);
        rows = docs.map((d) => cases.fromDoc(d));
      }
      const decoded = rows.map((row) => decodeCase(row)!);
      const items = decoded.slice(0, page.limit);
      const more = decoded.length > page.limit;
      const nextCursor = more ? encodeCursor([offset + page.limit]) : null;
      if (page.mode === 'page') {
        const total = await repo.countCases(f);
        return { items, nextCursor, page: page.page, totalPages: Math.max(1, Math.ceil(total / page.limit)), total };
      }
      return { items, nextCursor };
    },
    countCases: (f) => cases.count(caseFilter(f)),
    async casesForItems(orderItemIds, openOnly) {
      if (!orderItemIds.length) return [];
      const items = await t('case_items').find({ order_item_id: { $in: orderItemIds } });
      if (!items.length) return [];
      const caseIds = [...new Set(items.map((i) => i.case_id as string))];
      const known = new Set(await cases.distinct<string>('id', { id: { $in: caseIds }, ...(openOnly ? { status: { $nin: [...CLOSED_STATUSES, null] } } : {}) }));
      return items.filter((i) => known.has(i.case_id as string)).map((i) => ({ caseId: i.case_id as string, orderItemId: i.order_item_id as string }));
    },
    async openCasesPerProduct(productIds) {
      const out = new Map<string, number>();
      if (!productIds.length) return out;
      const items = await t('case_items').find({ 'snapshot.productId': { $in: productIds } });
      if (!items.length) return out;
      const open = new Set(
        await cases.distinct<string>('id', { id: { $in: [...new Set(items.map((i) => i.case_id as string))] }, status: { $nin: [...CLOSED_STATUSES, null] }, kind: { $nin: ['seller_request', null] } }),
      );
      const perProduct = new Map<string, Set<string>>();
      for (const i of items) {
        const productId = (i.snapshot as { productId?: string } | null)?.productId;
        if (!productId || !open.has(i.case_id as string)) continue;
        perProduct.set(productId, (perProduct.get(productId) ?? new Set()).add(i.case_id as string));
      }
      for (const [p, ids] of perProduct) out.set(p, ids.size);
      return out;
    },
    async openPerOwner(ownerIds, now) {
      const out = new Map<string, { open: number; overdue: number }>();
      if (!ownerIds.length) return out;
      const rows = await cases.aggregate<{ _id: string; open: number; overdue: number }>([
        { $match: { owner_staff_id: { $in: ownerIds }, status: { $nin: [...CLOSED_STATUSES, null] } } },
        { $group: { _id: '$owner_staff_id', open: { $sum: 1 }, overdue: { $sum: { $cond: [{ $and: [{ $ne: [{ $ifNull: ['$next_response_due_at', null] }, null] }, { $lt: ['$next_response_due_at', now] }] }, 1, 0] } } } },
      ]);
      for (const r of rows) out.set(r._id, { open: r.open, overdue: r.overdue });
      return out;
    },
  };
  return repo;
}
