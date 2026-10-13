import { orThrow } from '../../kernel/lib/or-throw.js';
import { decodeCursor, encodeCursor, type PageRequest } from '../../kernel/lib/pagination.js';
import { contains, whereFilter, type Filter, type ModuleStore, type Table, type Where } from '../../kernel/mongo/index.js';
import type * as common from '../../spec/common.js';
import { CLOSED_STATUSES } from './domain/rules.js';
import { FACT_COLUMNS, type CaseFacts, type CaseFilter, type CaseRec, type CaseSort, type CategoryRec, type FactColumn, type PendingApproval, type Recs, type StoredPending, type TableName } from './ports.js';

/** Sort, limit and lock options of the generic find */
export interface FindOptions<R> {
  orderBy?: [keyof R & string, 'asc' | 'desc'][];
  limit?: number;
  forUpdate?: boolean;
}


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
function encode(table: TableName, row: Record<string, unknown>): Record<string, unknown> {
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
const decode = <T extends TableName>(table: T, row: unknown): Recs[T] => (table === 'cases' ? decodeCase(row as Record<string, unknown>) : row) as Recs[T];


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
    const term = contains(f.q);
    and.push({ $or: [{ ref: term }, { subject: term }, { order_ref: term }, { customer_name: term }, { seller_name: term }, { return_ref: term }] });
  }
  return and.length ? { $and: and } : {};
}


/**
 * support.case_categories, cases, case_items, case_messages, case_evidence, case_offers, case_remedies,
 * case_appeals and case_events (MongoDB, docs/04-mongodb-migration.md). A case's facts and pending approval are
 * columns of cases, mapped to CaseRec.facts and CaseRec.pending here.
 */
export class SupportRepository {
  readonly #cases: Table<Record<string, unknown>>;

  constructor(private readonly store: ModuleStore) {
    this.#cases = store.table<Record<string, unknown>>('cases');
  }

  /** A table's stored rows (cases hold fact columns: decode them before handing a row out) */
  #t(table: TableName): Table<Record<string, unknown>> {
    return this.store.table<Record<string, unknown>>(table);
  }

  /** Runs fn in one transaction (nested calls join the outer one) */
  transaction<T>(fn: (tx: SupportRepository) => Promise<T>): Promise<T> {
    return this.store.transaction((tx) => fn(new SupportRepository(tx)));
  }

  /** Claims an event key in the module inbox (inside a transaction: commits with its effects); false once claimed */
  claim(key: string): Promise<boolean> {
    return this.store.claim(key);
  }

  /* ---------------------------------------------------------------- generic table access (case_categories is keyed by key) */

  async get<T extends Exclude<TableName, 'case_items'>>(table: T, id: string, o?: { forUpdate?: boolean }): Promise<Recs[T] | undefined> {
    const row = await this.#t(table).get(id, o);
    return row && decode(table, row);
  }

  async find<T extends TableName>(table: T, where: Where<Recs[T]>, o?: FindOptions<Recs[T]>): Promise<Recs[T][]> {
    const sort = o?.orderBy?.length ? Object.fromEntries(o.orderBy.map(([c, d]) => [c, d === 'desc' ? -1 : 1] as const)) : undefined;
    const rows = await this.#t(table).find(whereFilter(where), { sort, limit: o?.limit, forUpdate: o?.forUpdate });
    return rows.map((row) => decode(table, row));
  }

  count<T extends TableName>(table: T, where: Where<Recs[T]>): Promise<number> {
    return this.#t(table).count(whereFilter(where));
  }

  async insert<T extends TableName>(table: T, row: Recs[T]): Promise<Recs[T]> {
    return decode(table, await this.#t(table).insert(encode(table, row as unknown as Record<string, unknown>)));
  }

  async insertMany<T extends TableName>(table: T, rows: Recs[T][]): Promise<void> {
    await this.#t(table).insertMany(rows.map((r) => encode(table, r as unknown as Record<string, unknown>)));
  }

  /** Sets the defined fields of patch (facts and pending as their columns); the row after */
  async update<T extends Exclude<TableName, 'case_items'>>(table: T, id: string, patch: Partial<Recs[T]>): Promise<Recs[T]> {
    const values = encode(table, patch as Record<string, unknown>);
    const row = Object.keys(values).length ? await this.#t(table).update(id, values) : await this.#t(table).get(id);
    return decode(table, orThrow(row, `support: ${table} ${id}`));
  }

  /** Inserts categories that do not exist yet (staff changes are kept) */
  async seedCategories(rows: CategoryRec[]): Promise<void> {
    await this.#t('case_categories').insertManyIfAbsent(rows);
  }

  async upsertCategory(row: CategoryRec): Promise<CategoryRec> {
    return (await this.#t('case_categories').upsert(row)) as unknown as CategoryRec;
  }

  /* ---------------------------------------------------------------- lists */

  /** Cases matching a filter in the given order; offset paging in both modes */
  async listCases(f: CaseFilter, sort: CaseSort, page: PageRequest): Promise<common.Page<CaseRec>> {
    const offset = page.mode === 'page' ? (page.page - 1) * page.limit : page.cursor ? Number(decodeCursor(page.cursor)[0]) || 0 : 0;
    const filter = caseFilter(f);
    let rows: Record<string, unknown>[];
    if (sort === 'newest' || sort === 'updated') {
      const column = sort === 'newest' ? 'opened_at' : 'updated_at';
      rows = await this.#cases.find(filter, { sort: { [column]: -1, id: -1 }, skip: offset, limit: page.limit + 1 });
    } else if (sort === 'next_deadline') {
      rows = await this.#cases.find(filter, { sort: { next_response_due_at: 1, opened_at: 1, id: 1 }, nullsLast: ['next_response_due_at'], skip: offset, limit: page.limit + 1 });
    } else {
      // priority (urgent, high, medium, the rest), then next_response_due_at asc nulls last (a computed flag sorts the nulls after)
      const docs = await this.#cases.aggregate<Record<string, unknown>>([
        { $match: this.#cases.filter(filter) },
        {
          $addFields: {
            _due_null: { $cond: [{ $eq: [{ $ifNull: ['$next_response_due_at', null] }, null] }, 1, 0] },
            _rank: { $switch: { branches: [{ case: { $eq: ['$priority', 'urgent'] }, then: 0 }, { case: { $eq: ['$priority', 'high'] }, then: 1 }, { case: { $eq: ['$priority', 'medium'] }, then: 2 }], default: 3 } },
          },
        },
        { $sort: { _rank: 1, _due_null: 1, next_response_due_at: 1, _id: 1 } },
        { $skip: offset },
        { $limit: page.limit + 1 },
        { $project: { _due_null: 0, _rank: 0 } },
      ]);
      rows = docs.map((d) => this.#cases.fromDoc(d));
    }
    const decoded = rows.map((row) => decodeCase(row)!);
    const items = decoded.slice(0, page.limit);
    const more = decoded.length > page.limit;
    const nextCursor = more ? encodeCursor([offset + page.limit]) : null;
    if (page.mode === 'page') {
      const total = await this.countCases(f);
      return { items, nextCursor, page: page.page, totalPages: Math.max(1, Math.ceil(total / page.limit)), total };
    }
    return { items, nextCursor };
  }

  countCases(f: CaseFilter): Promise<number> {
    return this.#cases.count(caseFilter(f));
  }

  /** Cases (any state unless openOnly) linked to any of these order items */
  async casesForItems(orderItemIds: string[], openOnly: boolean): Promise<{ caseId: string; orderItemId: string }[]> {
    if (!orderItemIds.length) return [];
    const items = await this.#t('case_items').find({ order_item_id: { $in: orderItemIds } });
    if (!items.length) return [];
    const caseIds = [...new Set(items.map((i) => i.case_id as string))];
    const known = new Set(await this.#cases.distinct<string>('id', { id: { $in: caseIds }, ...(openOnly ? { status: { $nin: [...CLOSED_STATUSES, null] } } : {}) }));
    return items.filter((i) => known.has(i.case_id as string)).map((i) => ({ caseId: i.case_id as string, orderItemId: i.order_item_id as string }));
  }

  /** Open customer cases per product (case items of the product) */
  async openCasesPerProduct(productIds: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (!productIds.length) return out;
    const items = await this.#t('case_items').find({ 'snapshot.productId': { $in: productIds } });
    if (!items.length) return out;
    const open = new Set(
      await this.#cases.distinct<string>('id', { id: { $in: [...new Set(items.map((i) => i.case_id as string))] }, status: { $nin: [...CLOSED_STATUSES, null] }, kind: { $nin: ['seller_request', null] } }),
    );
    const perProduct = new Map<string, Set<string>>();
    for (const i of items) {
      const productId = (i.snapshot as { productId?: string } | null)?.productId;
      if (!productId || !open.has(i.case_id as string)) continue;
      perProduct.set(productId, (perProduct.get(productId) ?? new Set()).add(i.case_id as string));
    }
    for (const [p, ids] of perProduct) out.set(p, ids.size);
    return out;
  }

  /** Open cases per owner and how many are past their response deadline */
  async openPerOwner(ownerIds: string[], now: Date): Promise<Map<string, { open: number; overdue: number }>> {
    const out = new Map<string, { open: number; overdue: number }>();
    if (!ownerIds.length) return out;
    const rows = await this.#cases.aggregate<{ _id: string; open: number; overdue: number }>([
      { $match: { owner_staff_id: { $in: ownerIds }, status: { $nin: [...CLOSED_STATUSES, null] } } },
      { $group: { _id: '$owner_staff_id', open: { $sum: 1 }, overdue: { $sum: { $cond: [{ $and: [{ $ne: [{ $ifNull: ['$next_response_due_at', null] }, null] }, { $lt: ['$next_response_due_at', now] }] }, 1, 0] } } } },
    ]);
    for (const r of rows) out.set(r._id, { open: r.open, overdue: r.overdue });
    return out;
  }
}
