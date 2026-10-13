import type mongoose from 'mongoose';
import { orThrow } from '../../kernel/lib/or-throw.js';
import type { PageRequest } from '../../kernel/lib/pagination.js';
import { CASE_INSENSITIVE, contains, startsWith, whereFilter, type Filter, type ModuleStore, type Table, type Where } from '../../kernel/mongo/index.js';
import type * as common from '../../spec/common.js';
import { OPEN_GROUP } from './domain/rules.js';
import type {
  AdminOrderFilter,
  CancellationRec,
  CustomerOrderFilter,
  GroupRec,
  ItemInfoRow,
  ItemRec,
  OrderRec,
  Recs,
  SavedFilterRec,
  SellerCounts,
  SellerGroupFilter,
  ShipmentRec,
  TableName,
  TimelineRec,
} from './ports.js';

type Doc = mongoose.mongo.Document;

/** Sort and lock options of the generic find */
export interface FindOptions<R> {
  orderBy?: [keyof R & string, 'asc' | 'desc'][];
  limit?: number;
  forUpdate?: boolean;
}

/** A condition no document meets (a list tab set that names no status) */
const NOTHING: Filter = { $expr: false };

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

/**
 * orders.orders, seller_groups, order_items, item_state_log, cancellations, shipment_refs, timeline, notes,
 * documents, saved_filters and order_facts (MongoDB, docs/04-mongodb-migration.md): generic table access for the
 * order aggregate plus the list queries.
 */
export class OrdersRepository {
  readonly #orders: Table<OrderRec>;
  readonly #groups: Table<GroupRec>;
  readonly #items: Table<ItemRec>;
  readonly #cancellations: Table<CancellationRec>;

  constructor(private readonly store: ModuleStore) {
    this.#orders = this.#t('orders');
    this.#groups = this.#t('seller_groups');
    this.#items = this.#t('order_items');
    this.#cancellations = this.#t('cancellations');
  }

  #t<T extends TableName>(table: T): Table<Recs[T]> {
    return this.store.table<Recs[T]>(table);
  }

  /** Runs fn in one transaction (nested calls join the outer one); inside it, calls run one after another */
  transaction<T>(fn: (tx: OrdersRepository) => Promise<T>): Promise<T> {
    return this.store.transaction((tx) => fn(new OrdersRepository(tx)));
  }

  /* ---------------------------------------------------------------- generic table access */

  get<T extends TableName>(table: T, id: string, o?: { forUpdate?: boolean }): Promise<Recs[T] | undefined> {
    return this.#t(table).get(id, { forUpdate: o?.forUpdate });
  }

  find<T extends TableName>(table: T, where: Where<Recs[T]>, o?: FindOptions<Recs[T]>): Promise<Recs[T][]> {
    return this.#t(table).find(whereFilter(where), {
      sort: o?.orderBy?.length ? Object.fromEntries(o.orderBy.map(([c, dir]) => [c, dir === 'desc' ? -1 : 1])) : undefined,
      limit: o?.limit,
      forUpdate: o?.forUpdate,
    });
  }

  count<T extends TableName>(table: T, where: Where<Recs[T]>): Promise<number> {
    return this.#t(table).count(whereFilter(where));
  }

  insert<T extends TableName>(table: T, row: Recs[T]): Promise<Recs[T]> {
    return this.#t(table).insert(row);
  }

  insertMany<T extends TableName>(table: T, rows: Recs[T][]): Promise<void> {
    return this.#t(table).insertMany(rows);
  }

  /** Sets the defined fields of patch; the row after (an empty patch reads it) */
  async update<T extends TableName>(table: T, id: string, patch: Partial<Recs[T]>): Promise<Recs[T]> {
    const values = Object.fromEntries(Object.entries(patch as Record<string, unknown>).filter(([, v]) => v !== undefined));
    const row = Object.keys(values).length ? await this.#t(table).update(id, values) : await this.#t(table).get(id);
    return orThrow(row, `orders: ${table} ${id}`);
  }

  async remove(table: TableName, id: string): Promise<void> {
    await this.#t(table).delete(id);
  }

  /** Inbox claim (ctx.mongo.claim): true the first time this key is claimed; commits with the transaction it runs in */
  claim(key: string): Promise<boolean> {
    return this.store.claim(key);
  }

  /** Inserts the order unless the (checkout session, attempt) pair already has one (then null) */
  async insertOrderIfNew(row: OrderRec): Promise<OrderRec | null> {
    return (await this.#orders.insertIfAbsent(row, ['checkout_session_id', 'attempt_no'])) ?? null;
  }

  /** Inserts a fact unless the order already has one of that kind for the same source (then null) */
  async insertFactIfNew(row: Recs['order_facts']): Promise<Recs['order_facts'] | null> {
    return (await this.#t('order_facts').insertIfAbsent(row, ['order_id', 'kind', 'source_id'])) ?? null;
  }

  upsertShipment(row: ShipmentRec): Promise<ShipmentRec> {
    const { shipment_id: _id, order_id: _o, group_id: _g, ...rest } = row;
    return this.#t('shipment_refs').upsert(row, { update: Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)) });
  }

  /* ---------------------------------------------------------------- store lists */

  customerOrders(customerId: string, f: CustomerOrderFilter, page: PageRequest): Promise<common.Page<OrderRec>> {
    const match: Doc = { customer_id: customerId };
    if (f.placedFrom || f.placedTo) match.placed_at = { ...(f.placedFrom ? { $gte: f.placedFrom } : {}), ...(f.placedTo ? { $lt: f.placedTo } : {}) };
    if (f.tab === 'in_progress') match.display_status = { $in: IN_PROGRESS };
    if (f.tab === 'delivered') match.display_status = { $in: DELIVERED };
    if (f.tab === 'cancelled') match.display_status = 'cancelled';
    const pipeline: Doc[] = [{ $match: match }];
    if (f.tab === 'returns') pipeline.push(this.#lookupAny('order_items', '_id', 'order_id', { return_id: { $ne: null } }, '_ret'), { $match: { _ret: { $ne: [] } } }, { $unset: '_ret' });
    if (f.q?.trim()) {
      const term = contains(f.q);
      pipeline.push(this.#lookupAny('order_items', '_id', 'order_id', { 'product_snapshot.title': term }, '_title'), { $match: { $or: [{ ref: term }, { _title: { $ne: [] } }] } }, { $unset: '_title' });
    }
    return this.#orders.pageAggregate(pipeline, page, { key: 'placed_at', direction: 'desc' });
  }

  async customerTabCounts(customerId: string, placedFrom: Date | null): Promise<{ all: number; inProgress: number; delivered: number; returns: number; cancelled: number }> {
    const match: Doc = { customer_id: customerId, ...(placedFrom ? { placed_at: { $gte: placedFrom } } : {}) };
    const [r] = await this.#orders.aggregate<{ all: number; inProgress: number; delivered: number; returns: number; cancelled: number }>([
      { $match: match },
      this.#lookupAny('order_items', '_id', 'order_id', { return_id: { $ne: null } }, '_ret'),
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
  }

  /** Packages (groups) of the customer's open orders that are delayed or past their dispatch deadline */
  async delayedGroupsOfCustomer(customerId: string, now: Date): Promise<GroupRec[]> {
    const open = await this.#orders.find({ customer_id: customerId, lifecycle: 'open' });
    if (!open.length) return [];
    const placed = new Map(open.map((o) => [o.id, o.placed_at.getTime()]));
    const rows = await this.#groups.find({ order_id: { $in: [...placed.keys()] }, $or: [{ status: 'delayed' }, { status: { $in: OPEN }, dispatch_by: { $lt: now } }] });
    return rows.sort((a, b) => placed.get(b.order_id)! - placed.get(a.order_id)!);
  }

  /* ---------------------------------------------------------------- seller lists */

  async sellerGroups(sellerId: string, f: SellerGroupFilter, page: PageRequest, now: Date): Promise<common.Page<GroupRec>> {
    const match: Doc[] = [{ seller_id: sellerId }];
    if (f.tabs?.length) {
      // Fulfilled by Marketly groups are left out of the new, preparing and cancellation_requests tabs (the seller has nothing to do)
      const sellerTabs = [...new Set(f.tabs.flatMap((tab) => (SELLER_ACTION_TABS.includes(tab) ? (TABS[tab] ?? []) : [])))];
      const anyTabs = [...new Set(f.tabs.flatMap((tab) => (tab === 'cancellation_requests' || SELLER_ACTION_TABS.includes(tab) ? [] : (TABS[tab] ?? []))))];
      const pending = f.tabs.includes('cancellation_requests') ? await this.#cancellations.distinct<string>('group_id', { status: 'requested', group_id: { $ne: null } }) : null;
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
      { $lookup: { from: this.#orders.name, localField: 'order_id', foreignField: '_id', pipeline: [{ $project: { placed_at: 1, ref: 1, contact_name: 1 } }], as: '_o' } },
      { $unwind: '$_o' },
      { $set: { _placed_at: '$_o.placed_at' } },
    ];
    const after: Doc[] = [];
    if (f.placedFrom) after.push({ _placed_at: { $gte: f.placedFrom } });
    if (f.placedTo) after.push({ _placed_at: { $lt: f.placedTo } });
    if (f.q?.trim()) {
      const term = contains(f.q);
      pipeline.push(this.#lookupAny('order_items', '_id', 'group_id', { 'offer_snapshot.sellerSku': term }, '_sku'));
      after.push({ $or: [{ '_o.ref': term }, { '_o.contact_name': term }, { _sku: { $ne: [] } }] });
    }
    if (after.length) pipeline.push({ $match: { $and: after } });
    pipeline.push({ $unset: ['_o', '_sku'] });
    // sorted by order date: _placed_at is the computed key (pageAggregate drops it); by deadline: drop it here
    if (f.sort === 'newest' || f.sort === 'oldest') return this.#groups.pageAggregate(pipeline, page, { key: '_placed_at', direction: f.sort === 'newest' ? 'desc' : 'asc' });
    return this.#groups.pageAggregate([...pipeline, { $unset: '_placed_at' }], page, { key: 'dispatch_by', direction: 'asc' });
  }

  async sellerCounts(sellerId: string, now: Date, endOfDay: Date): Promise<SellerCounts> {
    const own = await this.#groups.distinct<string>('id', { seller_id: sellerId });
    const pending = own.length ? await this.#cancellations.distinct<string>('group_id', { group_id: { $in: own }, status: 'requested' }) : [];
    const notMarketly = { $ne: ['$fulfilled_by', MARKETLY] };
    const open = { $in: ['$status', OPEN] };
    const [r] = await this.#groups.aggregate<Record<string, number>>([
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
  }

  async sellerTiles(
    sellerIds: string[],
    now: Date,
    endOfDay: Date,
    since30d: Date,
  ): Promise<Map<string, { open: number; overdueDispatch: number; dueToday: number; cancellationRequests: number; cancellations30d: number }>> {
    const out = new Map<string, { open: number; overdueDispatch: number; dueToday: number; cancellationRequests: number; cancellations30d: number }>();
    if (!sellerIds.length) return out;
    const notMarketly = { $ne: ['$fulfilled_by', MARKETLY] };
    const open = { $in: ['$status', OPEN] };
    const rows = await this.#groups.aggregate<{ _id: string; openOrders: (string | null)[]; overdueDispatch: number; dueToday: number }>([
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
    const requests = await this.#cancellations.find({ status: 'requested', initiated_by: 'customer', group_id: { $ne: null } });
    const requestGroups = new Map((await this.#groups.getMany([...new Set(requests.map((c) => c.group_id!))])).map((g) => [g.id, g]));
    const requestCount = new Map<string, number>();
    for (const c of requests) {
      const g = requestGroups.get(c.group_id!);
      if (g && g.fulfilled_by !== MARKETLY) requestCount.set(g.seller_id ?? '', (requestCount.get(g.seller_id ?? '') ?? 0) + 1);
    }
    // items of the sellers' groups cancelled in the last 30 days (state log rows)
    const logs = await this.#t('item_state_log').find({ to_state: 'cancelled', at: { $gte: since30d } });
    const logItems = new Map((await this.#items.getMany([...new Set(logs.map((l) => l.item_id))])).map((i) => [i.id, i]));
    const logGroups = new Map((await this.#groups.getMany([...new Set([...logItems.values()].map((i) => i.group_id))])).map((g) => [g.id, g]));
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
  }

  /* ---------------------------------------------------------------- admin lists */

  adminOrders(f: AdminOrderFilter, page: PageRequest, now: Date): Promise<common.Page<OrderRec>> {
    return this.#orders.pageAggregate(this.#adminPipeline(f, now), page, { key: 'placed_at', direction: 'desc' });
  }

  async adminCount(f: AdminOrderFilter, now: Date): Promise<number> {
    const [r] = await this.#orders.aggregate<{ n: number }>([...this.#adminPipeline(f, now), { $count: 'n' }]);
    return r?.n ?? 0;
  }

  /** Whether the customer (or, without one, the contact email, case-insensitive) has an order whose payment was accepted */
  hasAcceptedOrder(who: { customerId?: string | null; email?: string | null }): Promise<boolean> {
    if (!who.customerId && !who.email?.trim()) return Promise.resolve(false);
    if (who.customerId) return this.#orders.exists({ accepted_at: { $ne: null }, customer_id: who.customerId });
    return this.#orders.exists({ accepted_at: { $ne: null }, contact_email: who.email!.trim() }, { collation: CASE_INSENSITIVE });
  }

  /** Guest orders (no customer) of a contact email, case-insensitive, newest first */
  guestOrdersByEmail(email: string): Promise<OrderRec[]> {
    return this.#orders.find({ customer_id: null, contact_email: email.trim() }, { sort: { placed_at: -1 }, limit: 100, collation: CASE_INSENSITIVE });
  }

  /** Orders in a lifecycle, by id, in bounded batches (jobs) */
  ordersInLifecycle(lifecycles: string[], afterId: string | null, limit: number): Promise<OrderRec[]> {
    return this.#orders.find({ lifecycle: { $in: lifecycles }, ...(afterId ? { id: { $gt: afterId } } : {}) }, { sort: { id: 1 }, limit });
  }

  async ordersWithOpenGroupsOfSeller(sellerId: string): Promise<GroupRec[]> {
    const open = await this.#groups.find({ seller_id: sellerId, status: { $nin: CLOSED_GROUP } });
    if (!open.length) return [];
    const live = new Set(await this.#orders.distinct<string>('id', { id: { $in: [...new Set(open.map((g) => g.order_id))] }, lifecycle: { $in: ['payment_pending', 'open'] } }));
    return open.filter((g) => live.has(g.order_id));
  }

  async countPurchased(customerId: string, offerId: string, since: Date): Promise<number> {
    const ids = await this.#customerOrderIds(customerId, { placed_at: { $gte: since }, lifecycle: { $ne: 'cancelled' } });
    if (!ids.length) return 0;
    const [r] = await this.#items.aggregate<{ n: number }>([
      { $match: { order_id: { $in: ids }, offer_id: offerId, state: { $ne: 'cancelled' }, replacement_of_item_id: null } },
      { $group: { _id: null, n: { $sum: '$quantity' } } },
    ]);
    return Number(r?.n ?? 0);
  }

  async verifiedPurchase(customerId: string, productId: string): Promise<ItemRec | undefined> {
    const ids = await this.#customerOrderIds(customerId);
    if (!ids.length) return undefined;
    return this.#items.findOne({ order_id: { $in: ids }, product_id: productId, delivered_at: { $ne: null }, state: { $in: ['delivered', 'return_requested', 'returned', 'refunded'] } }, { sort: { delivered_at: 1 } });
  }

  /** One item with its order, group and customer */
  async itemInfo(itemId: string): Promise<ItemInfoRow | undefined> {
    const item = await this.#items.get(itemId);
    return item ? (await this.#infoOf([item]))[0] : undefined;
  }

  /** Items delivered to the customer (delivered_at set), optionally since a time, newest delivery first */
  async deliveredItemsOf(customerId: string, since: Date | null): Promise<ItemInfoRow[]> {
    const ids = await this.#customerOrderIds(customerId);
    if (!ids.length) return [];
    const rows = await this.#items.find({ order_id: { $in: ids }, delivered_at: since ? { $ne: null, $gte: since } : { $ne: null } }, { sort: { delivered_at: -1, id: 1 }, limit: 1000 });
    return this.#infoOf(rows);
  }

  async itemCountsForProducts(productIds: string[]): Promise<{ product_id: string; open: number; past: number }[]> {
    if (!productIds.length) return [];
    const rows = await this.#items.aggregate<{ _id: string; open: number; past: number }>([
      { $match: { product_id: { $in: [...new Set(productIds)] } } },
      { $group: { _id: '$product_id', open: countIf({ $not: [{ $in: ['$state', PAST_ITEM] }] }), past: countIf({ $in: ['$state', PAST_ITEM] }) } },
    ]);
    return rows.map((r) => ({ product_id: r._id, open: Number(r.open), past: Number(r.past) }));
  }

  async openInCategories(categoryIds: string[], placedBefore: Date): Promise<{ orders: number; items: number }> {
    if (!categoryIds.length) return { orders: 0, items: 0 };
    // coalesce(category_id, product_snapshot.categoryId) in (…)
    const open = await this.#items.find({
      state: { $nin: PAST_ITEM },
      $or: [{ category_id: { $in: categoryIds } }, { category_id: null, 'product_snapshot.categoryId': { $in: categoryIds } }],
    });
    if (!open.length) return { orders: 0, items: 0 };
    const live = new Set(await this.#orders.distinct<string>('id', { id: { $in: [...new Set(open.map((i) => i.order_id))] }, placed_at: { $lt: placedBefore }, lifecycle: { $in: ['payment_pending', 'open'] } }));
    const counted = open.filter((i) => live.has(i.order_id));
    return { orders: new Set(counted.map((i) => i.order_id)).size, items: counted.length };
  }

  timelinePage(orderId: string, visibility: string | undefined, page: PageRequest): Promise<common.Page<TimelineRec>> {
    return this.#t('timeline').page({ order_id: orderId, ...(visibility ? { visibility } : {}) }, page, { column: 'at', direction: 'desc' });
  }

  dueCancellationRequests(now: Date, limit: number): Promise<CancellationRec[]> {
    return this.#cancellations.find({ status: 'requested', respond_by: { $lte: now } }, { sort: { respond_by: 1 }, limit });
  }

  savedFiltersFor(staffId: string): Promise<SavedFilterRec[]> {
    return this.#t('saved_filters').find({ $or: [{ owner_staff_id: staffId }, { shared: true }] }, { sort: { created_at: 1 } });
  }

  /* ---------------------------------------------------------------- helpers */

  #customerOrderIds(customerId: string, extra: Filter = {}): Promise<string[]> {
    return this.#orders.distinct<string>('id', { customer_id: customerId, ...extra });
  }

  /**
   * EXISTS (select 1 from <table> where <foreign> = <outer local> and <match>) as a $lookup: the stages add `as`
   * (empty when nothing matches); match with { [as]: { $ne: [] } }.
   */
  #lookupAny(table: TableName, localField: string, foreignField: string, match: Doc, as: string): Doc {
    return { $lookup: { from: this.#t(table).name, localField, foreignField, pipeline: [{ $match: match }, { $limit: 1 }, { $project: { _id: 1 } }], as } };
  }

  /** The admin list filter as an aggregation on orders (exists conditions as lookups) */
  #adminPipeline(f: AdminOrderFilter, now: Date): Doc[] {
    const match: Doc[] = [];
    const stages: Doc[] = [];
    const exists = (table: TableName, foreignField: string, m: Doc) => {
      const as = `_x${stages.length}`;
      stages.push(this.#lookupAny(table, '_id', foreignField, m, as), { $match: { [as]: { $ne: [] } } }, { $unset: as });
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
      // decision S-D2: ref exactly or by prefix; contact name and email (case-insensitive contains); tracking numbers
      const term = contains(f.q);
      stages.push(this.#lookupAny('shipment_refs', '_id', 'order_id', { tracking_number: term }, '_track'));
      stages.push({ $match: { $or: [{ ref: startsWith(f.q) }, { contact_name: term }, { contact_email: term }, { _track: { $ne: [] } }] } }, { $unset: '_track' });
    }
    return [...(match.length ? [{ $match: { $and: match } }] : []), ...stages];
  }

  /** ItemInfoRow of items (inner joins on their order and group) */
  async #infoOf(rows: ItemRec[]): Promise<ItemInfoRow[]> {
    if (!rows.length) return [];
    const os = new Map((await this.#orders.getMany([...new Set(rows.map((i) => i.order_id))])).map((o) => [o.id, o]));
    const gs = new Map((await this.#groups.getMany([...new Set(rows.map((i) => i.group_id))])).map((g) => [g.id, g]));
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
}
