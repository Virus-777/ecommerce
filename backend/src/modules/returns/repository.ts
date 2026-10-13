import { newId } from '../../kernel/lib/ids.js';
import type { ModuleStore, Table as Collection } from '../../kernel/mongo/index.js';
import type { Filter } from '../../kernel/mongo/table.js';
import type * as common from '../../spec/common.js';
import type { ReturnsDb } from '../../spec/returns.js';
import type { DraftRec, RefundFilter, RefundItem, RefundRec, ReturnFilter, ReturnsRepository, Table } from './ports.js';
import { containsText, encode, jsonColumns, sortOf, toFilter } from './generic.js';

type Row = Record<string, unknown>;
type ItemRow = ReturnsDb['refund_request_items'];
type EventRow = ReturnsDb['refund_request_events'];

const ACTIVE_REFUND = ['requested', 'under_review', 'approved', 'processing', 'failed'];
/** matches no row (an empty IN) */
const NONE: Filter = { id: { $in: [] } };

/** Refund request fields that live in refund_request_items / refund_request_events, not in the row */
const REFUND_CHILDREN = ['items', 'order_item_ids', 'history'];
const withoutChildren = (table: Table, row: Row) => (table === 'refund_requests' ? Object.fromEntries(Object.entries(row).filter(([k]) => !REFUND_CHILDREN.includes(k))) : row);

/** MongoDB adapter for ReturnsRepository (docs/04-mongodb-migration.md): one collection per spec table. */
export function createMongoReturnsRepository(store: ModuleStore): ReturnsRepository {
  // generic table access: the row types are checked at the ReturnsRepository boundary
  const t = (table: Table): Collection<any> => store.table(table);
  const json = new Map<string, Set<string>>();
  const enc = (table: Table, row: unknown) => {
    let cols = json.get(table);
    if (!cols) json.set(table, (cols = jsonColumns(store.schemas[table]!)));
    return encode(cols, withoutChildren(table, row as Row));
  };
  const items = store.table<ItemRow>('refund_request_items');
  const events = store.table<EventRow>('refund_request_events');
  const returns = t('returns');
  const coll = (table: string) => store.table(table).model.collection.collectionName;

  /** Refund request rows with their items and history */
  async function hydrate(rows: Row[]): Promise<RefundRec[]> {
    if (!rows.length) return rows as never;
    const ids = rows.map((r) => r.id as string);
    // one after the other: this may run in a transaction
    const its = await items.find({ refund_request_id: { $in: ids } }, { sort: { refund_request_id: 1, position: 1 } });
    const evs = await events.find({ refund_request_id: { $in: ids } }, { sort: { at: 1, id: 1 } });
    return rows.map((r) => {
      const mine: RefundItem[] = its.filter((i) => i.refund_request_id === r.id).map((i) => ({ orderItemId: i.order_item_id, quantity: i.quantity, amount: Number(i.amount) }));
      const history: common.TimelineEvent[] = evs
        .filter((e) => e.refund_request_id === r.id)
        .map((e) => ({ at: new Date(e.at).toISOString(), label: e.label, detail: e.detail, actor: e.actor_kind ? ({ kind: e.actor_kind, id: e.actor_id, ...(e.actor_name ? { name: e.actor_name } : {}) } as common.Actor) : null }));
      return { ...r, items: mine, order_item_ids: mine.map((i) => i.orderItemId), history } as unknown as RefundRec;
    });
  }
  const hydrated = async (table: Table, rows: Row[]) => (table === 'refund_requests' ? hydrate(rows) : rows);

  async function writeItems(id: string, list: RefundItem[]) {
    await items.deleteMany({ refund_request_id: id });
    if (list.length) await items.insertMany(list.map((i, n) => ({ refund_request_id: id, order_item_id: i.orderItemId, position: n, quantity: i.quantity, amount: i.amount })));
  }
  async function writeEvents(id: string, list: common.TimelineEvent[]) {
    if (!list.length) return;
    await events.insertMany(list.map((e) => ({ id: newId(), refund_request_id: id, at: new Date(e.at), label: e.label, detail: e.detail ?? null, actor_kind: e.actor?.kind ?? null, actor_id: e.actor?.id ?? null, actor_name: e.actor?.name ?? null })));
  }

  /** Return ids from another table (a subquery) */
  const returnIdsWhere = (table: string, f: Filter) => store.table<Row>(table).distinct<string>('return_id', f);

  async function returnFilter(f: ReturnFilter): Promise<Filter> {
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
    if (f.refundStatuses?.length) conds.push({ id: { $in: await returnIdsWhere('refund_requests', { status: { $in: f.refundStatuses } }) } });
    if (f.refundPending !== undefined) {
      const ids = await returnIdsWhere('refund_requests', { status: { $in: ACTIVE_REFUND } });
      conds.push({ id: f.refundPending ? { $in: ids } : { $nin: ids } });
    }
    if (f.productIds) conds.push(f.productIds.length ? { id: { $in: await returnIdsWhere('return_items', { product_id: { $in: f.productIds } }) } } : NONE);
    if (f.q?.trim()) {
      const term = containsText(f.q);
      const byItem = await returnIdsWhere('return_items', { $or: [{ title: term }, { sku: term }] });
      conds.push({ $or: [{ ref: term }, { order_ref: term }, { id: { $in: byItem } }] });
    }
    return conds.length ? { $and: conds } : {};
  }

  const repo: ReturnsRepository = {
    transaction: (fn) => store.transaction((tx) => fn(tx === store ? repo : createMongoReturnsRepository(tx))),

    async get(table, id, o) {
      const row = await t(table).get(id, o);
      return row ? ((await hydrated(table, [row]))[0] as never) : undefined;
    },
    async find(table, where, o) {
      const rows = await t(table).find(toFilter(where as Row), { sort: sortOf(o?.orderBy as never), limit: o?.limit, forUpdate: o?.forUpdate });
      return hydrated(table, rows) as never;
    },
    count: (table, where) => t(table).count(toFilter(where as Row)),
    async insert(table, row) {
      const inserted = await t(table).insert(enc(table, row));
      if (table !== 'refund_requests') return inserted;
      const rr = row as unknown as RefundRec;
      await writeItems(rr.id, rr.items ?? []);
      await writeEvents(rr.id, rr.history ?? []);
      return (await hydrate([inserted]))[0] as never;
    },
    async insertMany(table, rows) {
      if (!rows.length) return;
      if (table === 'refund_requests') {
        for (const r of rows) await repo.insert(table, r);
        return;
      }
      await t(table).insertMany(rows.map((r) => enc(table, r)));
    },
    async update(table, id, patch) {
      const values = enc(table, patch);
      const row = Object.keys(values).length ? await t(table).update(id, values) : await t(table).get(id);
      if (!row) throw new Error(`returns: ${table} ${id} not found`);
      return (await hydrated(table, [row]))[0] as never;
    },
    async setRefundItems(id, list) {
      await writeItems(id, list);
    },
    async addRefundEvents(id, list) {
      await writeEvents(id, list);
    },
    async remove(table, id) {
      await t(table).delete(id);
    },

    async upsertDraft(row) {
      // on conflict (return_id) do update set every other column
      return t('inspection_drafts').upsert(enc('inspection_drafts', row)) as Promise<DraftRec>;
    },

    async listReturns(f, page) {
      return returns.page(await returnFilter(f), page, { column: 'requested_at', direction: 'desc' });
    },
    async countReturns(f) {
      return returns.count(await returnFilter(f));
    },
    async listRefunds(f: RefundFilter, page) {
      const conds: Filter[] = [];
      if (f.status) conds.push({ status: f.status });
      if (f.statuses) conds.push({ status: { $in: f.statuses } });
      if (f.source) conds.push({ source: f.source });
      if (f.sellerId) conds.push({ seller_id: f.sellerId });
      if (f.orderId) conds.push({ order_id: f.orderId });
      if (f.caseId) conds.push({ case_id: f.caseId });
      if (f.returnIds) conds.push({ return_id: { $in: f.returnIds } });
      if (f.customerIds) conds.push({ customer_id: { $in: f.customerIds } });
      const p = await t('refund_requests').page(conds.length ? { $and: conds } : {}, page, { column: 'created_at', direction: 'desc' });
      return { ...p, items: await hydrate(p.items) };
    },
    async usedQuantities(orderItemIds) {
      const out = new Map<string, number>();
      if (!orderItemIds.length) return out;
      // units in returns that are not cancelled or rejected (join on the return)
      const rows = await t('return_items').aggregate<{ _id: string; n: unknown }>([
        { $match: { order_item_id: { $in: orderItemIds } } },
        { $lookup: { from: coll('returns'), localField: 'return_id', foreignField: '_id', as: 'r' } },
        { $addFields: { return_status: { $arrayElemAt: ['$r.status', 0] } } },
        { $match: { return_status: { $nin: ['cancelled', 'rejected', null] } } },
        { $group: { _id: '$order_item_id', n: { $sum: '$quantity' } } },
      ]);
      for (const r of rows) out.set(r._id, Number(r.n ?? 0));
      return out;
    },
    async openReturnsPerProduct(productIds) {
      const out = new Map<string, number>();
      if (!productIds.length) return out;
      // count(distinct return) per product, of returns not completed, cancelled or rejected
      const rows = await t('return_items').aggregate<{ _id: string; n: number }>([
        { $match: { product_id: { $in: productIds } } },
        { $lookup: { from: coll('returns'), localField: 'return_id', foreignField: '_id', as: 'r' } },
        { $addFields: { return_status: { $arrayElemAt: ['$r.status', 0] } } },
        { $match: { return_status: { $nin: ['completed', 'cancelled', 'rejected', null] } } },
        { $group: { _id: { product_id: '$product_id', return_id: '$return_id' } } },
        { $group: { _id: '$_id.product_id', n: { $sum: 1 } } },
      ]);
      for (const r of rows) out.set(r._id, r.n);
      return out;
    },
  };
  return repo;
}
