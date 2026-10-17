import type { Schema } from 'mongoose';
import { newId } from '../../kernel/lib/ids.js';
import { orThrow } from '../../kernel/lib/or-throw.js';
import type { PageRequest } from '../../kernel/lib/pagination.js';
import { contains, whereFilter, type Filter, type ModuleStore, type Table, type Where } from '../../kernel/mongo/index.js';
import type * as common from '../../spec/common.js';
import type { ReturnsDb } from '../../spec/returns.js';
import type { DraftRec, RefundFilter, RefundItem, RefundRec, Recs, ReturnFilter, ReturnRec, TableName } from './ports.js';

type Row = Record<string, unknown>;
type ItemRow = ReturnsDb['refund_request_items'];
type EventRow = ReturnsDb['refund_request_events'];

/** Sort, limit and lock options of the generic find */
export interface FindOptions<R> {
  orderBy?: [keyof R & string, 'asc' | 'desc'][];
  limit?: number;
  forUpdate?: boolean;
}

const ACTIVE_REFUND = ['requested', 'under_review', 'approved', 'processing', 'failed'];
/** matches no row (an empty IN) */
const NONE: Filter = { id: { $in: [] } };

/** Refund request fields that live in refund_request_items / refund_request_events, not in the row */
const REFUND_CHILDREN = ['items', 'order_item_ids', 'history'];

/** The json columns of a table (Mixed paths of its generated schema) */
const jsonColumns = (schema: Schema) => new Set(Object.entries(schema.paths).filter(([, p]) => p.instance === 'Mixed').map(([k]) => k));

/** Rows per key, in their order */
function groupBy<T, K>(rows: readonly T[], key: (r: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const r of rows) {
    const list = out.get(key(r));
    if (list) list.push(r);
    else out.set(key(r), [r]);
  }
  return out;
}

/** How many refund requests match and their summed total in minor units (queue figures) */
export interface RefundTotals {
  count: number;
  total: number;
}

/**
 * returns.policy_versions, category_exceptions, seller_terms, returns, return_items, return_shipments,
 * inspection_drafts, return_evidence, inspections, refund_requests (with refund_request_items and
 * refund_request_events), replacements and return_events (MongoDB, docs/04-mongodb-migration.md).
 */
export class ReturnsRepository {
  readonly #items: Table<ItemRow>;
  readonly #events: Table<EventRow>;
  readonly #returns: Table<ReturnRec>;
  readonly #json = new Map<string, Set<string>>();

  constructor(
    private readonly store: ModuleStore,
    /** Bound to a transaction: its session takes one operation at a time, so reads never run together */
    readonly inTransaction = false,
  ) {
    this.#items = store.table<ItemRow>('refund_request_items');
    this.#events = store.table<EventRow>('refund_request_events');
    this.#returns = this.#t('returns');
  }

  /** The table's rows as the typed records (json columns typed by ports.ts) */
  #t<T extends TableName>(table: T): Table<Recs[T]> {
    return this.store.table<Recs[T]>(table);
  }

  /** Runs fn in one transaction (nested calls join the outer one) */
  transaction<T>(fn: (tx: ReturnsRepository) => Promise<T>): Promise<T> {
    return this.store.transaction((tx) => fn(new ReturnsRepository(tx, true)));
  }

  /** Independent reads: together outside a transaction, one after another inside one */
  async reads<T extends unknown[]>(...fns: { [K in keyof T]: () => Promise<T[K]> }): Promise<T> {
    if (!this.inTransaction) return (await Promise.all(fns.map((f) => f()))) as T;
    const out: unknown[] = [];
    for (const f of fns) out.push(await f());
    return out as T;
  }

  /* ---------------------------------------------------------------- generic table access */

  async get<T extends TableName>(table: T, id: string, o?: { forUpdate?: boolean }): Promise<Recs[T] | undefined> {
    const row = await this.#t(table).get(id, o);
    return row ? (await this.#hydrated(table, [row]))[0] : undefined;
  }

  async find<T extends TableName>(table: T, where: Where<Recs[T]>, o?: FindOptions<Recs[T]>): Promise<Recs[T][]> {
    const sort = o?.orderBy?.length ? Object.fromEntries(o.orderBy.map(([c, d]) => [c, d === 'desc' ? -1 : 1] as const)) : undefined;
    const rows = await this.#t(table).find(whereFilter(where), { sort, limit: o?.limit, forUpdate: o?.forUpdate });
    return this.#hydrated(table, rows);
  }

  /**
   * Every matching row of a table keyed by `id`, in batches of `size` (keyset on id: each batch reads the rows
   * after the last id of the one before). Jobs walk their candidates with it, so rows a job skips (not due yet)
   * never hide the rows after them, and only one batch is in memory at a time.
   * The walk ends with the first batch shorter than `size`.
   */
  batches<T extends TableName>(table: T, where: Where<Recs[T]>, size: number): AsyncGenerator<Recs[T][]> {
    return this.#batches(table, whereFilter(where), size);
  }

  /** batches of the returns matching a ReturnFilter (e.g. the received returns at the Marketly dock) */
  async *returnBatches(f: ReturnFilter, size: number): AsyncGenerator<ReturnRec[]> {
    yield* this.#batches('returns', await this.#returnFilter(f), size);
  }

  /**
   * batches of the returns waiting for an answer to a question whose reply-by time has passed. replyDueAt is kept
   * as an ISO-8601 UTC string (toISOString), so comparing the strings compares the instants.
   */
  infoRequestsDue(now: Date, size: number): AsyncGenerator<ReturnRec[]> {
    return this.#batches('returns', { status: 'info_requested', 'info_request.replyDueAt': { $lt: now.toISOString() } }, size);
  }

  async *#batches<T extends TableName>(table: T, filter: Filter, size: number): AsyncGenerator<Recs[T][]> {
    let afterId: string | null = null;
    for (;;) {
      const rows: Recs[T][] = await this.#t(table).find(afterId ? { $and: [filter, { id: { $gt: afterId } }] } : filter, { sort: { id: 1 }, limit: size });
      if (rows.length) yield await this.#hydrated(table, rows);
      if (rows.length < size) return;
      afterId = (rows.at(-1) as { id: string }).id;
    }
  }

  count<T extends TableName>(table: T, where: Where<Recs[T]>): Promise<number> {
    return this.#t(table).count(whereFilter(where));
  }

  /** Inserts a row (a refund request with its items and history) */
  async insert<T extends TableName>(table: T, row: Recs[T]): Promise<Recs[T]> {
    const inserted = await this.#t(table).insert(this.#encode(table, row));
    if (table !== 'refund_requests') return inserted;
    const rr = row as RefundRec;
    await this.#writeItems(rr.id, rr.items ?? []);
    await this.#writeEvents(rr.id, rr.history ?? []);
    return (await this.#hydrate([inserted as Row]))[0] as Recs[T];
  }

  async insertMany<T extends TableName>(table: T, rows: Recs[T][]): Promise<void> {
    if (!rows.length) return;
    if (table === 'refund_requests') {
      for (const r of rows) await this.insert(table, r);
      return;
    }
    await this.#t(table).insertMany(rows.map((r) => this.#encode(table, r)));
  }

  /** Sets the defined fields of patch (a refund request's items and history are left alone); the row after */
  async update<T extends TableName>(table: T, id: string, patch: Partial<Recs[T]>): Promise<Recs[T]> {
    const values = this.#encode(table, patch);
    const row = orThrow(Object.keys(values).length ? await this.#t(table).update(id, values) : await this.#t(table).get(id), `returns: ${table} ${id}`);
    return (await this.#hydrated(table, [row]))[0]!;
  }

  async remove(table: TableName, id: string): Promise<void> {
    await this.#t(table).delete(id);
  }

  /** Replaces a refund request's items */
  async setRefundItems(refundRequestId: string, items: RefundItem[]): Promise<void> {
    await this.#writeItems(refundRequestId, items);
  }

  /** Appends to a refund request's history */
  async addRefundEvents(refundRequestId: string, events: common.TimelineEvent[]): Promise<void> {
    await this.#writeEvents(refundRequestId, events);
  }

  /** Inserts or replaces the draft of a return (on conflict (return_id) do update set every other column) */
  upsertDraft(row: DraftRec): Promise<DraftRec> {
    return this.#t('inspection_drafts').upsert(this.#encode('inspection_drafts', row));
  }

  /* ---------------------------------------------------------------- lists */

  /** Returns matching a filter, newest first */
  async listReturns(f: ReturnFilter, page: PageRequest): Promise<common.Page<ReturnRec>> {
    return this.#returns.page(await this.#returnFilter(f), page, { column: 'requested_at', direction: 'desc' });
  }

  async countReturns(f: ReturnFilter): Promise<number> {
    return this.#returns.count(await this.#returnFilter(f));
  }

  /** Refund requests matching a filter, newest first */
  async listRefunds(f: RefundFilter, page: PageRequest): Promise<common.Page<RefundRec>> {
    const conds: Filter[] = [];
    if (f.status) conds.push({ status: f.status });
    if (f.statuses) conds.push({ status: { $in: f.statuses } });
    if (f.source) conds.push({ source: f.source });
    if (f.sources) conds.push({ source: { $in: f.sources } });
    if (f.sellerId) conds.push({ seller_id: f.sellerId });
    if (f.orderId) conds.push({ order_id: f.orderId });
    if (f.caseId) conds.push({ case_id: f.caseId });
    if (f.returnIds) conds.push({ return_id: { $in: f.returnIds } });
    if (f.customerIds) conds.push({ customer_id: { $in: f.customerIds } });
    const p = await this.#t('refund_requests').page(conds.length ? { $and: conds } : {}, page, { column: 'created_at', direction: 'desc' });
    return { ...p, items: await this.#hydrate(p.items as unknown as Row[]) };
  }

  /**
   * How many refund requests are in these statuses and their summed total (minor units), counted by the database
   * over every matching row (queue tiles: no rows read into memory, no cap).
   */
  refundTotals(statuses: readonly string[]): Promise<RefundTotals> {
    return this.#refundTotals([{ $match: { status: { $in: [...statuses] } } }]);
  }

  /**
   * refundTotals of the refunds that sit with Finance at the Marketly returns dock: every Official Store refund, and
   * the seller refunds of Fulfilled by Marketly returns (the return's fulfilled_by, joined by return_id).
   */
  dockRefundTotals(statuses: readonly string[]): Promise<RefundTotals> {
    return this.#refundTotals([
      { $match: { status: { $in: [...statuses] } } },
      { $lookup: { from: this.#returns.name, localField: 'return_id', foreignField: '_id', pipeline: [{ $project: { _id: 0, fulfilled_by: 1 } }], as: 'ret' } },
      { $match: { $or: [{ owner_type: 'official' }, { owner_type: 'seller', 'ret.fulfilled_by': 'marketly_service' }] } },
    ]);
  }

  async #refundTotals(match: Filter[]): Promise<RefundTotals> {
    const [row] = await this.#t('refund_requests').aggregate<RefundTotals>([...match, { $group: { _id: null, count: { $sum: 1 }, total: { $sum: '$total' } } }, { $project: { _id: 0, count: 1, total: 1 } }]);
    return row ?? { count: 0, total: 0 };
  }

  /** Units per order item in returns that are not cancelled or rejected */
  async usedQuantities(orderItemIds: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (!orderItemIds.length) return out;
    // units in returns that are not cancelled or rejected (join on the return)
    const rows = await this.#t('return_items').aggregate<{ _id: string; n: unknown }>([
      { $match: { order_item_id: { $in: orderItemIds } } },
      { $lookup: { from: this.#returns.name, localField: 'return_id', foreignField: '_id', as: 'r' } },
      { $addFields: { return_status: { $arrayElemAt: ['$r.status', 0] } } },
      { $match: { return_status: { $nin: ['cancelled', 'rejected', null] } } },
      { $group: { _id: '$order_item_id', n: { $sum: '$quantity' } } },
    ]);
    for (const r of rows) out.set(r._id, Number(r.n ?? 0));
    return out;
  }

  /** Open returns per product (not completed, cancelled or rejected) */
  async openReturnsPerProduct(productIds: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (!productIds.length) return out;
    // count(distinct return) per product, of returns not completed, cancelled or rejected
    const rows = await this.#t('return_items').aggregate<{ _id: string; n: number }>([
      { $match: { product_id: { $in: productIds } } },
      { $lookup: { from: this.#returns.name, localField: 'return_id', foreignField: '_id', as: 'r' } },
      { $addFields: { return_status: { $arrayElemAt: ['$r.status', 0] } } },
      { $match: { return_status: { $nin: ['completed', 'cancelled', 'rejected', null] } } },
      { $group: { _id: { product_id: '$product_id', return_id: '$return_id' } } },
      { $group: { _id: '$_id.product_id', n: { $sum: 1 } } },
    ]);
    for (const r of rows) out.set(r._id, r.n);
    return out;
  }

  /* ---------------------------------------------------------------- helpers */

  /**
   * A row or patch as stored: undefined fields dropped, a refund request's child fields left out, and json values
   * as plain JSON (dates inside become strings, which is how the views read them back)
   */
  #encode(table: TableName, row: unknown): Row {
    let json = this.#json.get(table);
    if (!json) this.#json.set(table, (json = jsonColumns(this.store.schemas[table]!)));
    const out: Row = {};
    for (const [k, v] of Object.entries(row as Row)) {
      if (v === undefined || (table === 'refund_requests' && REFUND_CHILDREN.includes(k))) continue;
      out[k] = json.has(k) && v !== null ? JSON.parse(JSON.stringify(v)) : v;
    }
    return out;
  }

  /** Refund request rows with their items and history; other tables' rows as they are */
  async #hydrated<T extends TableName>(table: T, rows: Recs[T][]): Promise<Recs[T][]> {
    return table === 'refund_requests' ? ((await this.#hydrate(rows as unknown as Row[])) as Recs[T][]) : rows;
  }

  /** Refund request rows with their items and history */
  async #hydrate(rows: Row[]): Promise<RefundRec[]> {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id as string);
    const [its, evs] = await this.reads(
      () => this.#items.find({ refund_request_id: { $in: ids } }, { sort: { refund_request_id: 1, position: 1 } }),
      () => this.#events.find({ refund_request_id: { $in: ids } }, { sort: { at: 1, id: 1 } }),
    );
    const itemsOf = groupBy(its, (i) => i.refund_request_id);
    const eventsOf = groupBy(evs, (e) => e.refund_request_id);
    return rows.map((r) => {
      const mine: RefundItem[] = (itemsOf.get(r.id as string) ?? []).map((i) => ({ orderItemId: i.order_item_id, quantity: i.quantity, amount: Number(i.amount) }));
      const history: common.TimelineEvent[] = (eventsOf.get(r.id as string) ?? []).map((e) => ({
        at: new Date(e.at).toISOString(),
        label: e.label,
        detail: e.detail,
        actor: e.actor_kind ? ({ kind: e.actor_kind, id: e.actor_id, ...(e.actor_name ? { name: e.actor_name } : {}) } as common.Actor) : null,
      }));
      return { ...r, items: mine, order_item_ids: mine.map((i) => i.orderItemId), history } as unknown as RefundRec;
    });
  }

  async #writeItems(id: string, list: RefundItem[]): Promise<void> {
    await this.#items.deleteMany({ refund_request_id: id });
    if (list.length) await this.#items.insertMany(list.map((i, n) => ({ refund_request_id: id, order_item_id: i.orderItemId, position: n, quantity: i.quantity, amount: i.amount })));
  }

  async #writeEvents(id: string, list: common.TimelineEvent[]): Promise<void> {
    if (!list.length) return;
    await this.#events.insertMany(list.map((e) => ({ id: newId(), refund_request_id: id, at: new Date(e.at), label: e.label, detail: e.detail ?? null, actor_kind: e.actor?.kind ?? null, actor_id: e.actor?.id ?? null, actor_name: e.actor?.name ?? null })));
  }

  /** Return ids from another table (a subquery) */
  #returnIdsWhere(table: TableName, f: Filter): Promise<string[]> {
    return this.store.table<Row>(table).distinct<string>('return_id', f);
  }

  async #returnFilter(f: ReturnFilter): Promise<Filter> {
    const conds: Filter[] = [];
    if (f.customerId !== undefined || f.guestSessionId !== undefined) {
      const c = f.customerId ?? null;
      const g = f.guestSessionId ?? null;
      if (c && g) conds.push({ $or: [{ customer_id: c }, { guest_session_id: g }] });
      else if (c) conds.push({ customer_id: c });
      else if (g) conds.push({ guest_session_id: g });
      else conds.push(NONE);
    }
    if (f.ids) conds.push({ id: { $in: f.ids } });
    if (f.sellerId) conds.push({ seller_id: f.sellerId });
    if (f.ownerType) conds.push({ owner_type: f.ownerType });
    if (f.marketlyDock) conds.push({ $or: [{ owner_type: 'official' }, { fulfilled_by: 'marketly_service' }] });
    if (f.orderId) conds.push({ order_id: f.orderId });
    if (f.statuses) conds.push({ status: { $in: f.statuses } });
    if (f.notStatuses?.length) conds.push({ status: { $nin: [...f.notStatuses, null] } });
    if (f.platformHandling !== undefined) conds.push({ platform_handling: f.platformHandling });
    if (f.disputed !== undefined) {
      // Fulfilled by Marketly returns are platform handled from the request: a dispute only when escalated or on a case
      const cond = { $or: [{ platform_handling: true, fulfilled_by: { $nin: ['marketly_service', null] } }, { escalation: { $ne: null } }, { case_id: { $ne: null } }] };
      conds.push(f.disputed ? cond : { $nor: [cond] });
    }
    if (f.hasException !== undefined) conds.push({ exception: f.hasException ? { $ne: null } : null });
    if (f.reason) conds.push({ reason: f.reason });
    if (f.ownerStaffId) conds.push({ owner_staff_id: f.ownerStaffId });
    if (f.requestedFrom) conds.push({ requested_at: { $gte: f.requestedFrom } });
    if (f.requestedTo) conds.push({ requested_at: { $lt: f.requestedTo } });
    if (f.dueFrom) conds.push({ response_due_at: { $gte: f.dueFrom } });
    if (f.dueBefore) conds.push({ response_due_at: { $lt: f.dueBefore } });
    if (f.completedFrom) conds.push({ completed_at: { $gte: f.completedFrom } });
    if (f.refundStatuses?.length) conds.push({ id: { $in: await this.#returnIdsWhere('refund_requests', { status: { $in: f.refundStatuses } }) } });
    if (f.refundPending !== undefined) {
      const ids = await this.#returnIdsWhere('refund_requests', { status: { $in: ACTIVE_REFUND } });
      conds.push({ id: f.refundPending ? { $in: ids } : { $nin: ids } });
    }
    if (f.productIds) conds.push(f.productIds.length ? { id: { $in: await this.#returnIdsWhere('return_items', { product_id: { $in: f.productIds } }) } } : NONE);
    if (f.q?.trim()) {
      const term = contains(f.q);
      const byItem = await this.#returnIdsWhere('return_items', { $or: [{ title: term }, { sku: term }] });
      conds.push({ $or: [{ ref: term }, { order_ref: term }, { id: { $in: byItem } }] });
    }
    return conds.length ? { $and: conds } : {};
  }
}
