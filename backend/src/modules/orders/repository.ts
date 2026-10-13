import type mongoose from 'mongoose';
import { decodeCursor, encodeCursor, type PageRequest } from '../../kernel/lib/pagination.js';
import type { ModuleStore } from '../../kernel/mongo/index.js';
import type { Filter, Table as Collection } from '../../kernel/mongo/table.js';
import type * as common from '../../spec/common.js';
import { OPEN_GROUP } from './domain/rules.js';
import type { AdminOrderFilter, GroupRec, ItemInfoRow, ItemRec, OrderRec, OrdersRepository, Recs, Table } from './ports.js';

type Doc = mongoose.mongo.Document;

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** ILIKE '%term%' */
const contains = (s: string) => ({ $regex: escapeRegExp(s.trim()), $options: 'i' });
/** lower(x) = lower(y): equality under the collation of the contact_email index (case-insensitive) */
const CASE_INSENSITIVE = { locale: 'en', strength: 2 } as const;
const NOTHING: Filter = { $expr: false };

const isOp = (v: unknown): v is { op: string; value: unknown } => typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date) && 'op' in v;
const COMPARE: Record<string, string> = { '<': '$lt', '<=': '$lte', '>': '$gt', '>=': '$gte' };

/** A Where (value, list, null or operator per column) as a filter, with SQL's meaning of null kept */
function toFilter(where: Record<string, unknown>): Filter {
  const and: Filter[] = [];
  for (const [k, v] of Object.entries(where)) {
    if (v === undefined) continue;
    if (v === null) and.push({ [k]: null });
    else if (Array.isArray(v)) and.push({ [k]: { $in: [...new Set(v)] } });
    else if (isOp(v)) {
      if (v.op === 'is not') and.push({ [k]: { $ne: v.value } });
      // comparisons with null are never true in SQL; `col <> x` skips rows where col is null
      else if (v.value === null) and.push(NOTHING);
      else if (v.op === '<>') and.push({ [k]: { $nin: [v.value, null] } });
      else and.push({ [k]: { [COMPARE[v.op]!]: v.value } });
    } else and.push({ [k]: v });
  }
  return and.length === 0 ? {} : and.length === 1 ? and[0]! : { $and: and };
}

const IN_PROGRESS = ['payment_pending', 'confirmed', 'preparing', 'delayed', 'partly_shipped', 'shipped', 'partly_delivered'];
const DELIVERED = ['delivered', 'completed', 'partly_cancelled'];
const OPEN = [...OPEN_GROUP];
const CLOSED_GROUP = ['delivered', 'cancelled', 'partly_cancelled'];
const PAST_ITEM = ['delivered', 'return_requested', 'returned', 'cancelled', 'refunded'];
const MARKETLY = 'marketly_service';
/** Tabs of seller work: Fulfilled by Marketly groups are left out */
const SELLER_ACTION_TABS = ['new', 'preparing'];
const TABS: Record<string, string[]> = {
  new: ['new'],
  preparing: ['preparing', 'delayed', 'partly_shipped'],
  shipped: ['shipped', 'partly_delivered'],
  completed: ['delivered', 'partly_cancelled', 'cancelled'],
};

/** count(*) filter (where cond) in a $group */
const countIf = (cond: Doc) => ({ $sum: { $cond: [cond, 1, 0] } });

/** MongoDB adapter for OrdersRepository (docs/04-mongodb-migration.md): one collection per spec table. */
export function createMongoOrdersRepository(store: ModuleStore): OrdersRepository {
  const t = <T extends Table>(table: T) => store.table<Recs[T]>(table) as Collection<Recs[T]>;
  const orders = t('orders');
  const groups = t('seller_groups');
  const items = t('order_items');
  const cancellations = t('cancellations');
  const collection = (table: Table) => t(table).model.collection.collectionName;

  /**
   * EXISTS (select 1 from <table> where <foreign> = <outer local> and <match>) as a $lookup: the stages add `as`
   * (empty when nothing matches); match with { [as]: { $ne: [] } }.
   */
  const lookupAny = (table: Table, localField: string, foreignField: string, match: Doc, as: string): Doc => ({
    $lookup: { from: collection(table), localField, foreignField, pipeline: [{ $match: match }, { $limit: 1 }, { $project: { _id: 1 } }], as },
  });

  /**
   * A page of an aggregation (kernel/lib/pagination.ts semantics): keyset on (sort field, _id) in cursor mode, count
   * and skip in page mode. `field` is the document field sorted by; rows come back through `toRow`.
   */
  async function pageOf<R>(table: Table, pipeline: Doc[], req: PageRequest, field: string, direction: 'asc' | 'desc', toRow: (d: Doc) => R, o: { date?: boolean } = {}): Promise<common.Page<R>> {
    const dir = direction === 'desc' ? -1 : 1;
    const sort = { $sort: { [field]: dir, _id: dir } };
    const cursorOf = (d: Doc) => {
      const v = d[field];
      return encodeCursor([v instanceof Date ? v.toISOString() : v, d._id]);
    };
    const c = t(table);
    if (req.mode === 'page') {
      const [r] = await c.aggregate<{ total: { n: number }[]; items: Doc[] }>([
        ...pipeline,
        { $facet: { total: [{ $count: 'n' }], items: [sort, { $skip: (req.page - 1) * req.limit }, { $limit: req.limit }] } },
      ]);
      const total = r?.total[0]?.n ?? 0;
      const docs = r?.items ?? [];
      const totalPages = Math.max(1, Math.ceil(total / req.limit));
      const last = docs.at(-1);
      return { items: docs.map(toRow), nextCursor: req.page < totalPages && last ? cursorOf(last) : null, page: req.page, totalPages, total };
    }
    const keyset: Doc[] = [];
    if (req.cursor) {
      const [raw, id] = decodeCursor(req.cursor);
      const v = o.date && typeof raw === 'string' ? new Date(raw) : raw;
      const cmp = dir === -1 ? '$lt' : '$gt';
      keyset.push({ $match: { $or: [{ [field]: { [cmp]: v } }, { [field]: v, _id: { [cmp]: id } }] } });
    }
    const docs = await c.aggregate<Doc>([...pipeline, ...keyset, sort, { $limit: req.limit + 1 }]);
    const page = docs.slice(0, req.limit);
    return { items: page.map(toRow), nextCursor: docs.length > req.limit ? cursorOf(page.at(-1)!) : null };
  }

  /** The admin list filter as an aggregation on orders (exists conditions as lookups) */
  function adminPipeline(f: AdminOrderFilter, now: Date): Doc[] {
    const match: Doc[] = [];
    const stages: Doc[] = [];
    const exists = (table: Table, foreignField: string, m: Doc) => {
      const as = `_x${stages.length}`;
      stages.push(lookupAny(table, '_id', foreignField, m, as), { $match: { [as]: { $ne: [] } } }, { $unset: as });
    };
    if (f.customerId) match.push({ customer_id: f.customerId });
    if (f.placedFrom) match.push({ placed_at: { $gte: f.placedFrom } });
    if (f.placedTo) match.push({ placed_at: { $lt: f.placedTo } });
    switch (f.fulfillmentStatus) {
      case 'new':
        match.push({ display_status: 'confirmed' });
        break;
      case 'preparing':
        match.push({ display_status: { $in: ['preparing', 'delayed'] } });
        break;
      case 'shipped':
        match.push({ display_status: { $in: ['shipped', 'partly_shipped'] } });
        break;
      case 'partly_delivered':
        match.push({ display_status: 'partly_delivered' });
        break;
      case 'delivered':
        match.push({ display_status: { $in: ['delivered', 'completed'] } });
        break;
      case 'cancelled':
        match.push({ display_status: { $in: ['cancelled', 'partly_cancelled'] } });
        break;
    }
    switch (f.paymentState) {
      case 'pending_check':
        match.push({ payment_state: 'pending_check' });
        break;
      case 'failed':
        match.push({ payment_state: 'failed' });
        break;
      case 'refunded':
        match.push({ refunded_total: { $gt: 0 }, $expr: { $gte: ['$refunded_total', '$total'] } });
        break;
      case 'partly_refunded':
        match.push({ refunded_total: { $gt: 0 }, $expr: { $lt: ['$refunded_total', '$total'] } });
        break;
      case 'captured':
        match.push({ captured_total: { $gt: 0 }, refunded_total: 0 });
        break;
    }
    if (f.flag) match.push({ flag_kinds: f.flag });
    if (f.sellerType === 'official') exists('seller_groups', 'order_id', { owner_type: 'official' });
    if (f.sellerType === 'marketplace') exists('seller_groups', 'order_id', { owner_type: 'seller' });
    if (f.sellerId) exists('seller_groups', 'order_id', { seller_id: f.sellerId });
    if (f.fulfilledBy) exists('seller_groups', 'order_id', { fulfilled_by: f.fulfilledBy });
    if (f.fulfillmentStatus === 'overdue') exists('seller_groups', 'order_id', { status: { $in: OPEN }, dispatch_by: { $lt: now } });
    if (f.fulfillmentStatus === 'cancellation_requested') exists('cancellations', 'order_id', { status: 'requested' });
    if (f.q?.trim()) {
      // decision S-D2: ref exactly or by prefix; contact name and email (ILIKE → case-insensitive regex); tracking numbers
      const term = contains(f.q);
      stages.push(lookupAny('shipment_refs', '_id', 'order_id', { tracking_number: term }, '_track'));
      stages.push({ $match: { $or: [{ ref: { $regex: `^${escapeRegExp(f.q.trim())}`, $options: 'i' } }, { contact_name: term }, { contact_email: term }, { _track: { $ne: [] } }] } }, { $unset: '_track' });
    }
    return [...(match.length ? [{ $match: { $and: match } }] : []), ...stages];
  }

  /** ItemInfoRow of items (inner joins on their order and group) */
  async function infoOf(rows: ItemRec[]): Promise<ItemInfoRow[]> {
    if (!rows.length) return [];
    const os = new Map((await orders.getMany([...new Set(rows.map((i) => i.order_id))])).map((o) => [o.id, o]));
    const gs = new Map((await groups.getMany([...new Set(rows.map((i) => i.group_id))])).map((g) => [g.id, g]));
    const out: ItemInfoRow[] = [];
    for (const i of rows) {
      const o = os.get(i.order_id);
      const g = gs.get(i.group_id);
      if (!o || !g) continue;
      out.push({
        id: i.id,
        order_id: i.order_id,
        order_ref: o.ref,
        group_id: i.group_id,
        owner_type: g.owner_type,
        seller_id: g.seller_id,
        customer_id: o.customer_id,
        offer_id: i.offer_id,
        product_id: i.product_id,
        variant_id: i.variant_id,
        stock_item_id: i.stock_item_id,
        category_id: i.category_id,
        quantity: i.quantity,
        state: i.state,
        delivered_at: i.delivered_at,
        return_window_ends_at: i.return_window_ends_at,
      });
    }
    return out;
  }

  const customerOrderIds = (customerId: string, extra: Filter = {}) => orders.distinct<string>('id', { customer_id: customerId, ...extra });

  const repo: OrdersRepository = {
    transaction: (fn) => (store.inTransaction ? fn(self) : store.transaction((tx) => fn(createMongoOrdersRepository(tx)))),

    /* ---------------------------------------------------------------- generic */
    get: (table, id, o) => t(table).get(id, { forUpdate: o?.forUpdate }),
    find: (table, where, o) =>
      t(table).find(toFilter(where as Record<string, unknown>), {
        sort: o?.orderBy?.length ? Object.fromEntries(o.orderBy.map(([c, dir]) => [c, dir === 'desc' ? -1 : 1])) : undefined,
        limit: o?.limit,
        forUpdate: o?.forUpdate,
      }),
    count: (table, where) => t(table).count(toFilter(where as Record<string, unknown>)),
    insert: (table, row) => t(table).insert(row),
    insertMany: (table, rows) => t(table).insertMany(rows),
    async update(table, id, patch) {
      const values = Object.fromEntries(Object.entries(patch as Record<string, unknown>).filter(([, v]) => v !== undefined));
      const row = Object.keys(values).length ? await t(table).update(id, values) : await t(table).get(id);
      if (!row) throw new Error(`orders: ${table} ${id} not found`);
      return row;
    },
    async remove(table, id) {
      await t(table).delete(id);
    },

    claim: (key) => store.claim(key),
    insertOrderIfNew: async (row) => (await orders.insertIfAbsent(row, ['checkout_session_id', 'attempt_no'])) ?? null,
    insertFactIfNew: async (row) => (await t('order_facts').insertIfAbsent(row, ['order_id', 'kind', 'source_id'])) ?? null,
    upsertShipment: (row) => {
      const { shipment_id: _id, order_id: _o, group_id: _g, ...rest } = row;
      return t('shipment_refs').upsert(row, { update: Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)) });
    },

    /* ---------------------------------------------------------------- store lists */
    async customerOrders(customerId, f, page) {
      const match: Doc = { customer_id: customerId };
      if (f.placedFrom || f.placedTo) match.placed_at = { ...(f.placedFrom ? { $gte: f.placedFrom } : {}), ...(f.placedTo ? { $lt: f.placedTo } : {}) };
      if (f.tab === 'in_progress') match.display_status = { $in: IN_PROGRESS };
      if (f.tab === 'delivered') match.display_status = { $in: DELIVERED };
      if (f.tab === 'cancelled') match.display_status = 'cancelled';
      const pipeline: Doc[] = [{ $match: match }];
      if (f.tab === 'returns') pipeline.push(lookupAny('order_items', '_id', 'order_id', { return_id: { $ne: null } }, '_ret'), { $match: { _ret: { $ne: [] } } }, { $unset: '_ret' });
      if (f.q?.trim()) {
        const term = contains(f.q);
        pipeline.push(lookupAny('order_items', '_id', 'order_id', { 'product_snapshot.title': term }, '_title'), { $match: { $or: [{ ref: term }, { _title: { $ne: [] } }] } }, { $unset: '_title' });
      }
      return pageOf('orders', pipeline, page, 'placed_at', 'desc', (d) => orders.fromDoc(d), { date: true });
    },
    async customerTabCounts(customerId, placedFrom) {
      const match: Doc = { customer_id: customerId, ...(placedFrom ? { placed_at: { $gte: placedFrom } } : {}) };
      const [r] = await orders.aggregate<{ all: number; inProgress: number; delivered: number; returns: number; cancelled: number }>([
        { $match: match },
        lookupAny('order_items', '_id', 'order_id', { return_id: { $ne: null } }, '_ret'),
        {
          $group: {
            _id: null,
            all: { $sum: 1 },
            inProgress: countIf({ $in: ['$display_status', IN_PROGRESS] }),
            delivered: countIf({ $in: ['$display_status', DELIVERED] }),
            returns: countIf({ $gt: [{ $size: '$_ret' }, 0] }),
            cancelled: countIf({ $eq: ['$display_status', 'cancelled'] }),
          },
        },
      ]);
      return { all: r?.all ?? 0, inProgress: r?.inProgress ?? 0, delivered: r?.delivered ?? 0, returns: r?.returns ?? 0, cancelled: r?.cancelled ?? 0 };
    },
    async delayedGroupsOfCustomer(customerId, now) {
      const open = await orders.find({ customer_id: customerId, lifecycle: 'open' });
      if (!open.length) return [];
      const placed = new Map(open.map((o) => [o.id, o.placed_at.getTime()]));
      const rows = await groups.find({ order_id: { $in: [...placed.keys()] }, $or: [{ status: 'delayed' }, { status: { $in: OPEN }, dispatch_by: { $lt: now } }] });
      return rows.sort((a, b) => placed.get(b.order_id)! - placed.get(a.order_id)!);
    },

    /* ---------------------------------------------------------------- seller lists */
    async sellerGroups(sellerId, f, page, now) {
      const match: Doc[] = [{ seller_id: sellerId }];
      if (f.tabs?.length) {
        // Fulfilled by Marketly groups are left out of the new, preparing and cancellation_requests tabs (the seller has nothing to do)
        const sellerTabs = [...new Set(f.tabs.flatMap((tab) => (SELLER_ACTION_TABS.includes(tab) ? (TABS[tab] ?? []) : [])))];
        const anyTabs = [...new Set(f.tabs.flatMap((tab) => (tab === 'cancellation_requests' || SELLER_ACTION_TABS.includes(tab) ? [] : (TABS[tab] ?? []))))];
        const pending = f.tabs.includes('cancellation_requests') ? await cancellations.distinct<string>('group_id', { status: 'requested', group_id: { $ne: null } }) : null;
        const or: Doc[] = [
          ...(sellerTabs.length ? [{ status: { $in: sellerTabs }, fulfilled_by: { $ne: MARKETLY } }] : []),
          ...(anyTabs.length ? [{ status: { $in: anyTabs } }] : []),
          ...(pending ? [{ fulfilled_by: { $ne: MARKETLY }, _id: { $in: pending } }] : []),
        ];
        match.push(or.length ? { $or: or } : NOTHING);
      }
      if (f.fulfilledBy) match.push({ fulfilled_by: f.fulfilledBy });
      if (f.overdueOnly) match.push({ status: { $in: OPEN }, dispatch_by: { $lt: now }, fulfilled_by: { $ne: MARKETLY } });
      const pipeline: Doc[] = [
        { $match: { $and: match } },
        { $lookup: { from: collection('orders'), localField: 'order_id', foreignField: '_id', pipeline: [{ $project: { placed_at: 1, ref: 1, contact_name: 1 } }], as: '_o' } },
        { $unwind: '$_o' },
        { $set: { _placed_at: '$_o.placed_at' } },
      ];
      const after: Doc[] = [];
      if (f.placedFrom) after.push({ _placed_at: { $gte: f.placedFrom } });
      if (f.placedTo) after.push({ _placed_at: { $lt: f.placedTo } });
      if (f.q?.trim()) {
        const term = contains(f.q);
        pipeline.push(lookupAny('order_items', '_id', 'group_id', { 'offer_snapshot.sellerSku': term }, '_sku'));
        after.push({ $or: [{ '_o.ref': term }, { '_o.contact_name': term }, { _sku: { $ne: [] } }] });
      }
      if (after.length) pipeline.push({ $match: { $and: after } });
      pipeline.push({ $unset: ['_o', '_sku'] });
      const toRow = (d: Doc) => {
        const { _placed_at: _p, ...rest } = d;
        return groups.fromDoc(rest);
      };
      if (f.sort === 'newest' || f.sort === 'oldest') return pageOf('seller_groups', pipeline, page, '_placed_at', f.sort === 'newest' ? 'desc' : 'asc', toRow, { date: true });
      return pageOf('seller_groups', pipeline, page, 'dispatch_by', 'asc', toRow, { date: true });
    },
    async sellerCounts(sellerId, now, endOfDay) {
      const own = await groups.distinct<string>('id', { seller_id: sellerId });
      const pending = own.length ? await cancellations.distinct<string>('group_id', { group_id: { $in: own }, status: 'requested' }) : [];
      const notMarketly = { $ne: ['$fulfilled_by', MARKETLY] };
      const open = { $in: ['$status', OPEN] };
      const [r] = await groups.aggregate<Record<string, number>>([
        { $match: { seller_id: sellerId } },
        {
          $group: {
            _id: null,
            // Fulfilled by Marketly groups: left out of what the seller acts on, counted in fulfilledByMarketly while open
            new: countIf({ $and: [{ $eq: ['$status', 'new'] }, notMarketly] }),
            preparing: countIf({ $and: [{ $in: ['$status', ['preparing', 'delayed', 'partly_shipped']] }, notMarketly] }),
            shipped: countIf({ $in: ['$status', ['shipped', 'partly_delivered']] }),
            completed: countIf({ $in: ['$status', CLOSED_GROUP] }),
            cancellationRequests: countIf({ $and: [notMarketly, { $in: ['$_id', pending] }] }),
            overdue: countIf({ $and: [open, { $lt: ['$dispatch_by', now] }, notMarketly] }),
            dueToday: countIf({ $and: [open, { $gte: ['$dispatch_by', now] }, { $lt: ['$dispatch_by', endOfDay] }, notMarketly] }),
            fulfilledByMarketly: countIf({ $and: [{ $eq: ['$fulfilled_by', MARKETLY] }, { $not: [{ $in: ['$status', CLOSED_GROUP] }] }] }),
          },
        },
      ]);
      const n = (k: string) => Number(r?.[k] ?? 0);
      return { new: n('new'), preparing: n('preparing'), shipped: n('shipped'), completed: n('completed'), cancellationRequests: n('cancellationRequests'), overdue: n('overdue'), dueToday: n('dueToday'), fulfilledByMarketly: n('fulfilledByMarketly') };
    },
    async sellerTiles(sellerIds, now, endOfDay, since30d) {
      const out = new Map<string, { open: number; overdueDispatch: number; dueToday: number; cancellationRequests: number; cancellations30d: number }>();
      if (!sellerIds.length) return out;
      const notMarketly = { $ne: ['$fulfilled_by', MARKETLY] };
      const open = { $in: ['$status', OPEN] };
      const rows = await groups.aggregate<{ _id: string; openOrders: (string | null)[]; overdueDispatch: number; dueToday: number }>([
        { $match: { seller_id: { $in: [...new Set(sellerIds)] } } },
        {
          $group: {
            _id: '$seller_id',
            openOrders: { $addToSet: { $cond: [{ $in: ['$status', CLOSED_GROUP] }, null, '$order_id'] } },
            // the seller's own dispatch work: Fulfilled by Marketly groups are Marketly's
            overdueDispatch: countIf({ $and: [open, { $lt: ['$dispatch_by', now] }, notMarketly] }),
            dueToday: countIf({ $and: [open, { $gte: ['$dispatch_by', now] }, { $lt: ['$dispatch_by', endOfDay] }, notMarketly] }),
          },
        },
      ]);
      // open customer cancellation requests of the sellers' own (not Marketly-fulfilled) groups, counted per request
      const requests = await cancellations.find({ status: 'requested', initiated_by: 'customer', group_id: { $ne: null } });
      const requestGroups = new Map((await groups.getMany([...new Set(requests.map((c) => c.group_id!))])).map((g) => [g.id, g]));
      const requestCount = new Map<string, number>();
      for (const c of requests) {
        const g = requestGroups.get(c.group_id!);
        if (g && g.fulfilled_by !== MARKETLY) requestCount.set(g.seller_id ?? '', (requestCount.get(g.seller_id ?? '') ?? 0) + 1);
      }
      // items of the sellers' groups cancelled in the last 30 days (state log rows)
      const logs = await t('item_state_log').find({ to_state: 'cancelled', at: { $gte: since30d } });
      const logItems = new Map((await items.getMany([...new Set(logs.map((l) => l.item_id))])).map((i) => [i.id, i]));
      const logGroups = new Map((await groups.getMany([...new Set([...logItems.values()].map((i) => i.group_id))])).map((g) => [g.id, g]));
      const cancelled = new Map<string, number>();
      for (const l of logs) {
        const g = logGroups.get(logItems.get(l.item_id)?.group_id ?? '');
        if (g?.seller_id) cancelled.set(g.seller_id, (cancelled.get(g.seller_id) ?? 0) + 1);
      }
      for (const r of rows) {
        out.set(r._id, {
          open: r.openOrders.filter((o) => o !== null).length,
          overdueDispatch: Number(r.overdueDispatch),
          dueToday: Number(r.dueToday),
          cancellationRequests: requestCount.get(r._id) ?? 0,
          cancellations30d: cancelled.get(r._id) ?? 0,
        });
      }
      return out;
    },

    /* ---------------------------------------------------------------- admin lists */
    adminOrders: (f, page, now) => pageOf('orders', adminPipeline(f, now), page, 'placed_at', 'desc', (d) => orders.fromDoc(d), { date: true }),
    async adminCount(f, now) {
      const [r] = await orders.aggregate<{ n: number }>([...adminPipeline(f, now), { $count: 'n' }]);
      return r?.n ?? 0;
    },
    async hasAcceptedOrder(who) {
      if (!who.customerId && !who.email?.trim()) return false;
      const filter = orders.filter({ accepted_at: { $ne: null }, ...(who.customerId ? { customer_id: who.customerId } : { contact_email: who.email!.trim() }) });
      const q = orders.model.findOne(filter, { _id: 1 }, { session: orders.session ?? null, lean: true });
      return Boolean(await (who.customerId ? q : q.collation(CASE_INSENSITIVE)));
    },
    async guestOrdersByEmail(email) {
      const docs = await orders.model
        .find(orders.filter({ customer_id: null, contact_email: email.trim() }), null, { session: orders.session ?? null, sort: { placed_at: -1 }, limit: 100, lean: true })
        .collation(CASE_INSENSITIVE);
      return (docs as Doc[]).map((d) => orders.fromDoc(d));
    },
    ordersInLifecycle: (lifecycles, afterId, limit) => orders.find({ lifecycle: { $in: lifecycles }, ...(afterId ? { id: { $gt: afterId } } : {}) }, { sort: { id: 1 }, limit }),
    async ordersWithOpenGroupsOfSeller(sellerId) {
      const open = await groups.find({ seller_id: sellerId, status: { $nin: CLOSED_GROUP } });
      if (!open.length) return [];
      const live = new Set(await orders.distinct<string>('id', { id: { $in: [...new Set(open.map((g) => g.order_id))] }, lifecycle: { $in: ['payment_pending', 'open'] } }));
      return open.filter((g) => live.has(g.order_id));
    },
    async countPurchased(customerId, offerId, since) {
      const ids = await customerOrderIds(customerId, { placed_at: { $gte: since }, lifecycle: { $ne: 'cancelled' } });
      if (!ids.length) return 0;
      const [r] = await items.aggregate<{ n: number }>([
        { $match: { order_id: { $in: ids }, offer_id: offerId, state: { $ne: 'cancelled' }, replacement_of_item_id: null } },
        { $group: { _id: null, n: { $sum: '$quantity' } } },
      ]);
      return Number(r?.n ?? 0);
    },
    async verifiedPurchase(customerId, productId) {
      const ids = await customerOrderIds(customerId);
      if (!ids.length) return undefined;
      return items.findOne({ order_id: { $in: ids }, product_id: productId, delivered_at: { $ne: null }, state: { $in: ['delivered', 'return_requested', 'returned', 'refunded'] } }, { sort: { delivered_at: 1 } });
    },
    async itemInfo(itemId) {
      const item = await items.get(itemId);
      return item ? (await infoOf([item]))[0] : undefined;
    },
    async deliveredItemsOf(customerId, since) {
      const ids = await customerOrderIds(customerId);
      if (!ids.length) return [];
      const rows = await items.find({ order_id: { $in: ids }, delivered_at: since ? { $ne: null, $gte: since } : { $ne: null } }, { sort: { delivered_at: -1, id: 1 }, limit: 1000 });
      return infoOf(rows);
    },
    async itemCountsForProducts(productIds) {
      if (!productIds.length) return [];
      const rows = await items.aggregate<{ _id: string; open: number; past: number }>([
        { $match: { product_id: { $in: [...new Set(productIds)] } } },
        { $group: { _id: '$product_id', open: countIf({ $not: [{ $in: ['$state', PAST_ITEM] }] }), past: countIf({ $in: ['$state', PAST_ITEM] }) } },
      ]);
      return rows.map((r) => ({ product_id: r._id, open: Number(r.open), past: Number(r.past) }));
    },
    async openInCategories(categoryIds, placedBefore) {
      if (!categoryIds.length) return { orders: 0, items: 0 };
      // coalesce(category_id, product_snapshot.categoryId) in (…)
      const open = await items.find({
        state: { $nin: PAST_ITEM },
        $or: [{ category_id: { $in: categoryIds } }, { category_id: null, 'product_snapshot.categoryId': { $in: categoryIds } }],
      });
      if (!open.length) return { orders: 0, items: 0 };
      const live = new Set(await orders.distinct<string>('id', { id: { $in: [...new Set(open.map((i) => i.order_id))] }, placed_at: { $lt: placedBefore }, lifecycle: { $in: ['payment_pending', 'open'] } }));
      const counted = open.filter((i) => live.has(i.order_id));
      return { orders: new Set(counted.map((i) => i.order_id)).size, items: counted.length };
    },
    timelinePage: (orderId, visibility, page) => t('timeline').page({ order_id: orderId, ...(visibility ? { visibility } : {}) }, page, { column: 'at', direction: 'desc' }),
    dueCancellationRequests: (now, limit) => cancellations.find({ status: 'requested', respond_by: { $lte: now } }, { sort: { respond_by: 1 }, limit }),
    savedFiltersFor: (staffId) => t('saved_filters').find({ $or: [{ owner_staff_id: staffId }, { shared: true }] }, { sort: { created_at: 1 } }),
  };

  // inside a transaction, operations run one after another (a session runs one operation at a time): callers may
  // read several tables of one transaction with Promise.all (core.loadMany)
  const self: OrdersRepository = store.inTransaction ? serial(repo) : repo;
  return self;
}

/** The repository with every call queued behind the previous one (transaction-bound repositories) */
function serial(repo: OrdersRepository): OrdersRepository {
  let chain: Promise<unknown> = Promise.resolve();
  const out: Record<string, unknown> = {};
  for (const [name, fn] of Object.entries(repo) as [string, (...a: unknown[]) => Promise<unknown>][]) {
    if (name === 'transaction') {
      out[name] = fn;
      continue;
    }
    out[name] = (...args: unknown[]) => {
      const p = chain.then(() => fn(...args));
      chain = p.catch(() => undefined);
      return p;
    };
  }
  return out as unknown as OrdersRepository;
}

