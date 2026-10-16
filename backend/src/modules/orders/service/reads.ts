/**
 * Reads for every area with record scope: customers see their own orders, guest sessions the orders identity
 * granted them, sellers only their own groups (another seller's items never appear), staff everything.
 * Not visible → NOT_FOUND (REST) or null (public API), never an error that reveals the order exists.
 */
import { isUuid } from '../../../kernel/lib/ids.js';
import { money } from '../../../kernel/lib/money.js';
import type { PageRequest } from '../../../kernel/lib/pagination.js';
import type * as common from '../../../spec/common.js';
import type { AdminOrderDetail, AdminOrderRow, DelayedItemAlert, ItemPaidAmount, OrderDetail, OrderSummary, SellerOrderCounts, SellerOrderDetail, SellerOrderRow } from '../../../spec/orders.js';
import { DAY, dayStart, endOfMarketDay, isMarketlyService, rangeStart } from '../domain/rules.js';
import type { AdminOrderFilter, GroupRec, NoteRec, OrderRec, SellerGroupFilter, TimelineRec } from '../ports.js';
import { notFound, type Agg, type Cfg, type Core } from './core.js';
import type { Fees, Views } from './views.js';

export interface StoreViewer {
  customerId?: string | null;
  guestSessionId?: string | null;
}

export type AdminListQuery = Omit<AdminOrderFilter, 'placedFrom' | 'placedTo'> & { placedFrom?: string; placedTo?: string; savedFilterId?: string };
export type SellerListQuery = { tab?: string; tabs?: string | string[]; q?: string; placedFrom?: string; placedTo?: string; overdueOnly?: boolean; sort?: string; fulfilledBy?: string; groupIds?: unknown; refs?: unknown };

/** A list given in export filters (array or comma-separated text), at most 500 entries; undefined when not given */
const listOf = (v: unknown, keep: (s: string) => string | null): string[] | undefined => {
  if (v === undefined || v === null) return undefined;
  const raw = Array.isArray(v) ? v : String(v).split(',');
  // given but nothing usable: matches nothing (an export of the selected rows never widens to everything)
  return [...new Set(raw.map((x) => keep(String(x).trim())).filter((x): x is string => !!x))].slice(0, 500);
};

const toPageRequest = (p: common.PageInput | undefined): PageRequest => {
  const limit = Math.min(Math.max(p?.limit ?? 24, 1), 100);
  return p?.page ? { mode: 'page', page: p.page, limit } : { mode: 'cursor', cursor: p?.cursor ?? null, limit };
};

/** Timeline entries each area may see */
const CUSTOMER = ['customer'];
const SELLER = ['customer', 'seller'];

export class Reads {
  constructor(
    private readonly core: Core,
    private readonly views: Views,
  ) {}

  page = toPageRequest;

  /* ---------------------------------------------------------------- store */

  async visibleToShopper(agg: Agg | undefined, viewer: StoreViewer): Promise<boolean> {
    if (!agg) return false;
    if (viewer.customerId && agg.order.customer_id === viewer.customerId) return true;
    if (viewer.guestSessionId) return Boolean(await this.core.soft('identity', 'guest order access', (i) => i.hasGuestOrderAccess(viewer.guestSessionId!, agg.order.id)));
    return false;
  }

  /** The order a shopper may see, or NOT_FOUND */
  async shopperOrder(orderId: string, viewer: StoreViewer): Promise<Agg> {
    const agg = isUuid(orderId) ? await this.core.load(orderId) : undefined;
    if (!agg || !(await this.visibleToShopper(agg, viewer))) throw notFound();
    return agg;
  }

  /** timeline: the order's customer-visible entries when the caller read them already (lists read them in one go) */
  async storeDetail(agg: Agg, cfg?: Cfg, timeline?: readonly TimelineRec[]): Promise<OrderDetail> {
    return this.views.detail(agg, timeline ?? (await this.core.timelineOf(agg.order.id, CUSTOMER)), 'store', cfg ?? (await this.core.cfg()));
  }

  customerFilter(customerId: string, filter: { q?: string; range?: string; from?: string; to?: string; tab?: string }) {
    const tz = this.core.tz;
    const now = this.core.now();
    const fromRange = rangeStart(filter.range, now, tz);
    const from = filter.from ? dayStart(filter.from, tz) : null;
    return {
      customerId,
      f: {
        q: filter.q,
        tab: filter.tab && filter.tab !== 'all' ? filter.tab : undefined,
        placedFrom: [fromRange, from].filter(Boolean).sort((a, b) => b!.getTime() - a!.getTime())[0] ?? null,
        placedTo: filter.to ? dayStart(filter.to, tz, true) : null,
      },
    };
  }

  async listMyOrders(customerId: string | null, filter: { q?: string; range?: string; from?: string; to?: string; tab?: string }, page: PageRequest): Promise<common.Page<OrderSummary>> {
    if (!customerId) return { items: [], nextCursor: null, total: 0 };
    const { f } = this.customerFilter(customerId, filter);
    const rows = await this.core.repo.customerOrders(customerId, f, page);
    const aggs = await this.core.loadMany(rows.items.map((r) => r.id));
    const slugs = await this.core.productSlugs([...aggs.values()].flatMap((a) => a.items.map((i) => i.product_id)));
    return { ...rows, items: rows.items.map((r) => this.views.summary(aggs.get(r.id)!, slugs)) };
  }

  async listOrdersForCustomer(customerId: string, filter: { q?: string; range?: string; from?: string; to?: string; tab?: string }, page: common.PageInput): Promise<common.Page<OrderDetail>> {
    const { f } = this.customerFilter(customerId, filter ?? {});
    const rows = await this.core.repo.customerOrders(customerId, f, toPageRequest(page));
    const ids = rows.items.map((r) => r.id);
    const [aggs, timelines, cfg] = await Promise.all([this.core.loadMany(ids), this.core.timelinesOf(ids, CUSTOMER), this.core.cfg()]);
    const items = await Promise.all(rows.items.map((r) => this.storeDetail(aggs.get(r.id)!, cfg, timelines.get(r.id))));
    return { ...rows, items };
  }

  /**
   * exportCustomerData: every order of the customer as they see it in their account (customer-visible timeline,
   * no staff notes or staff-only entries), without the screen-only fields. Walks all pages.
   */
  async exportForCustomer(customerId: string): Promise<common.CustomerDataSection[]> {
    const records: Record<string, unknown>[] = [];
    const cfg = await this.core.cfg();
    let cursor: string | null = null;
    for (let round = 0; round < 1000; round++) {
      const rows: common.Page<OrderRec> = await this.core.repo.customerOrders(customerId, {}, { mode: 'cursor', cursor, limit: 100 });
      const ids = rows.items.map((r) => r.id);
      const [aggs, timelines] = await Promise.all([this.core.loadMany(ids), this.core.timelinesOf(ids, CUSTOMER)]);
      for (const r of rows.items) {
        const { canCancelSomething: _c, paymentIntentId: _p, documents, ...order } = await this.storeDetail(aggs.get(r.id)!, cfg, timelines.get(r.id));
        records.push({ ...order, documents: documents.map((d) => ({ kind: d.kind, label: d.label, number: d.number, issuedAt: d.issuedAt })) });
      }
      cursor = rows.nextCursor ?? null;
      if (!cursor) break;
    }
    return [{ key: 'orders', title: 'Orders', module: 'orders', records }];
  }

  /** Tab counts; q narrows them like the order list search (ref, product title, seller name) */
  async countByTab(customerId: string | null, range?: string, q?: string) {
    if (!customerId) return { all: 0, inProgress: 0, delivered: 0, returns: 0, cancelled: 0, delayedPackages: 0 };
    const [counts, delayed] = await Promise.all([
      this.core.repo.customerTabCounts(customerId, rangeStart(range, this.core.now(), this.core.tz), q),
      this.core.repo.delayedGroupsOfCustomer(customerId, this.core.now()),
    ]);
    return { ...counts, delayedPackages: delayed.length };
  }

  async delayedItems(customerId: string): Promise<DelayedItemAlert[]> {
    const groups = await this.core.repo.delayedGroupsOfCustomer(customerId, this.core.now());
    const aggs = await this.core.loadMany(groups.map((g) => g.order_id));
    return groups.map((g) => {
      const agg = aggs.get(g.order_id)!;
      const items = agg.items.filter((i) => i.group_id === g.id && i.state !== 'cancelled');
      const est = this.views.latestEstimate(g);
      const caseRef = (agg.facts.cases ?? []).find((c) => c.itemIds.some((id) => items.some((i) => i.id === id)))?.ref ?? null;
      return {
        orderId: agg.order.id,
        orderRef: agg.order.ref,
        groupId: g.id,
        title: items.length > 1 ? `${this.views.title(items[0]!)} and ${items.length - 1} more` : items[0] ? this.views.title(items[0]) : `Package ${g.position}`,
        sellerName: this.views.sellerLabel(g).name,
        newDispatchBy: est ? new Date(est.to).toISOString() : null,
        newArrival: null,
        options: ['wait', 'cancel', 'contact_support'],
        caseRef,
      };
    });
  }

  async recent(customerId: string, limit: number): Promise<OrderSummary[]> {
    const rows = await this.core.repo.customerOrders(customerId, {}, { mode: 'cursor', cursor: null, limit: Math.min(Math.max(limit, 1), 50) });
    const aggs = await this.core.loadMany(rows.items.map((r) => r.id));
    const slugs = await this.core.productSlugs([...aggs.values()].flatMap((a) => a.items.map((i) => i.product_id)));
    return rows.items.map((r) => this.views.summary(aggs.get(r.id)!, slugs));
  }

  async getOrderForViewer(viewer: StoreViewer, ref: string): Promise<OrderDetail | null> {
    const o = (await this.core.repo.find('orders', { ref: ref.trim().toUpperCase() }))[0];
    const agg = o ? await this.core.load(o.id) : undefined;
    if (!agg || !(await this.visibleToShopper(agg, viewer))) return null;
    return this.storeDetail(agg);
  }

  /* ---------------------------------------------------------------- seller */

  /** Fee estimates of the groups, asked of finance at the same time (Official Store groups have none) */
  async fees(agg: Agg, groups: readonly GroupRec[]): Promise<Fees> {
    const c = agg.order.currency;
    const estimates = await Promise.all(
      groups.map(async (g) => {
        if (g.owner_type === 'official') return null;
        const items = agg.items.filter((i) => i.group_id === g.id);
        const f = this.views.funding(items, c);
        const calc = await this.core.soft('finance', 'fee estimate', (fin) =>
          fin.calculateFee({
            categoryId: items[0]?.category_id ?? items[0]?.product_snapshot.categoryId ?? null,
            itemPrice: money(g.items_total, c),
            sellerDiscount: money(f.seller, c),
            platformDiscount: money(f.platform, c),
            shippingCharged: money(g.shipping_total, c),
          }),
        );
        return calc ? { fee: calc.fee, earnings: calc.sellerEarnings } : null;
      }),
    );
    return new Map(groups.map((g, i) => [g.id, estimates[i] ?? null]));
  }

  /** The seller's own group, or NOT_FOUND */
  async sellerGroup(sellerId: string, groupId: string): Promise<{ agg: Agg; group: GroupRec }> {
    const g = isUuid(groupId) ? await this.core.repo.get('seller_groups', groupId) : undefined;
    if (!g || g.seller_id !== sellerId) throw notFound();
    const agg = (await this.core.load(g.order_id))!;
    return { agg, group: agg.groups.find((x) => x.id === g.id)! };
  }

  async sellerDetail(sellerId: string, groupId: string): Promise<SellerOrderDetail> {
    const { agg, group } = await this.sellerGroup(sellerId, groupId);
    const [timeline, cfg, fees] = await Promise.all([this.core.timelineOf(agg.order.id, SELLER), this.core.cfg(), this.fees(agg, [group])]);
    return this.views.sellerDetail(agg, group, timeline, cfg, fees);
  }

  sellerFilter(q: SellerListQuery): SellerGroupFilter {
    const tz = this.core.tz;
    const tabs = [...(q.tab ? [q.tab] : []), ...(Array.isArray(q.tabs) ? q.tabs : q.tabs ? q.tabs.split(',') : [])].map((t) => t.trim().toLowerCase()).filter(Boolean);
    return {
      tabs: tabs.length ? [...new Set(tabs)] : undefined,
      q: q.q,
      placedFrom: q.placedFrom ? dayStart(q.placedFrom, tz) : null,
      placedTo: q.placedTo ? dayStart(q.placedTo, tz, true) : null,
      overdueOnly: q.overdueOnly,
      sort: (['dispatch_deadline', 'newest', 'oldest'].includes(String(q.sort)) ? q.sort : 'dispatch_deadline') as SellerGroupFilter['sort'],
      fulfilledBy: q.fulfilledBy === 'seller' || q.fulfilledBy === 'marketly_service' ? q.fulfilledBy : undefined,
      groupIds: listOf(q.groupIds, (s) => (isUuid(s) ? s : null)),
      refs: listOf(q.refs, (s) => s.toUpperCase() || null),
    };
  }

  async sellerRows(sellerId: string, q: SellerListQuery, page: PageRequest): Promise<common.Page<SellerOrderRow>> {
    const rows = await this.core.repo.sellerGroups(sellerId, this.sellerFilter(q), page, this.core.now());
    const aggs = await this.core.loadMany(rows.items.map((g) => g.order_id));
    const [cfg, stages] = await Promise.all([this.core.cfg(), this.core.warehouseStages(rows.items.filter(isMarketlyService).map((g) => g.order_id))]);
    return { ...rows, items: rows.items.map((g) => this.views.sellerRow(aggs.get(g.order_id)!, aggs.get(g.order_id)!.groups.find((x) => x.id === g.id)!, cfg, stages)) };
  }

  /** timeline: the order's customer and seller entries when the caller read them already */
  async sellerOrder(agg: Agg, sellerId: string, cfg: Cfg, timeline?: readonly TimelineRec[]) {
    const own = agg.groups.filter((g) => g.seller_id === sellerId);
    if (!own.length) return null;
    const [entries, fees] = await Promise.all([timeline ?? this.core.timelineOf(agg.order.id, SELLER), this.fees(agg, own)]);
    return this.views.sellerOrder(agg, sellerId, entries, cfg, fees);
  }

  async getOrderForSeller(sellerId: string, ref: string): Promise<{ order: OrderDetail; groups: SellerOrderDetail[] } | null> {
    const o = (await this.core.repo.find('orders', { ref: ref.trim().toUpperCase() }))[0];
    const agg = o ? await this.core.load(o.id) : undefined;
    if (!agg) return null;
    return this.sellerOrder(agg, sellerId, await this.core.cfg());
  }

  async listOrdersForSeller(sellerId: string, q: SellerListQuery, page: common.PageInput) {
    const rows = await this.core.repo.sellerGroups(sellerId, this.sellerFilter(q ?? {}), toPageRequest(page), this.core.now());
    // one entry per order, in the order of its first group on the page
    const orderIds = [...new Set(rows.items.map((g) => g.order_id))];
    const [aggs, timelines, cfg] = await Promise.all([this.core.loadMany(orderIds), this.core.timelinesOf(orderIds, SELLER), this.core.cfg()]);
    const views = await Promise.all(orderIds.map((id) => this.sellerOrder(aggs.get(id)!, sellerId, cfg, timelines.get(id))));
    return { ...rows, items: views.filter((v) => v !== null) };
  }

  async sellerCounts(sellerId: string): Promise<SellerOrderCounts> {
    const now = this.core.now();
    return this.core.repo.sellerCounts(sellerId, now, endOfMarketDay(now, this.core.tz));
  }

  async countOrdersForSellers(sellerIds: string[]) {
    const now = this.core.now();
    const ids = [...new Set(sellerIds.filter(isUuid))];
    const tiles = await this.core.repo.sellerTiles(ids, now, endOfMarketDay(now, this.core.tz), new Date(now.getTime() - 30 * DAY));
    const out: Record<string, { open: number; overdueDispatch: number; dueToday: number; cancellationRequests: number; cancellations30d: number }> = {};
    for (const id of sellerIds) out[id] = tiles.get(id) ?? { open: 0, overdueDispatch: 0, dueToday: 0, cancellationRequests: 0, cancellations30d: 0 };
    return out;
  }

  /* ---------------------------------------------------------------- admin */

  async adminFilter(q: AdminListQuery, staffId: string | null): Promise<AdminOrderFilter> {
    let base: Record<string, unknown> = {};
    if (q.savedFilterId) {
      const sf = await this.core.repo.get('saved_filters', q.savedFilterId);
      if (!sf || (!sf.shared && sf.owner_staff_id !== staffId && staffId !== null)) throw notFound('Saved filter');
      base = sf.query ?? {};
    }
    const m = { ...base, ...Object.fromEntries(Object.entries(q).filter(([, v]) => v !== undefined && v !== null && v !== '')) } as Record<string, string | undefined>;
    const tz = this.core.tz;
    return {
      q: m.q,
      sellerType: m.sellerType as AdminOrderFilter['sellerType'],
      sellerId: m.sellerId && isUuid(m.sellerId) ? m.sellerId : undefined,
      customerId: m.customerId && isUuid(m.customerId) ? m.customerId : undefined,
      fulfillmentStatus: m.fulfillmentStatus,
      paymentState: m.paymentState,
      flag: m.flag,
      fulfilledBy: ['official_warehouse', 'seller', 'marketly_service'].includes(String(m.fulfilledBy)) ? (m.fulfilledBy as AdminOrderFilter['fulfilledBy']) : undefined,
      placedFrom: m.placedFrom ? dayStart(String(m.placedFrom).slice(0, 10), tz) : null,
      placedTo: m.placedTo ? dayStart(String(m.placedTo).slice(0, 10), tz, true) : null,
    };
  }

  async adminRows(q: AdminListQuery, page: PageRequest, staffId: string | null): Promise<common.Page<AdminOrderRow>> {
    const rows = await this.core.repo.adminOrders(await this.adminFilter(q, staffId), page, this.core.now());
    const aggs = await this.core.loadMany(rows.items.map((r) => r.id));
    const exceptions = await this.core.openExceptionIds(rows.items.map((r) => r.id));
    return { ...rows, items: rows.items.map((r) => this.views.adminRow(aggs.get(r.id)!, exceptions)) };
  }

  /** pre: what the caller read already (lists read timelines and notes in one go) */
  async adminDetail(agg: Agg, canViewContact: boolean, cfg?: Cfg, pre: { timeline?: readonly TimelineRec[]; notes?: NoteRec[]; fees?: Fees } = {}): Promise<AdminOrderDetail> {
    const [timeline, notes, c, fees, orderCount] = await Promise.all([
      pre.timeline ?? this.core.timelineOf(agg.order.id),
      pre.notes ?? this.core.repo.find('notes', { order_id: agg.order.id }, { orderBy: [['at', 'desc']] }),
      cfg ?? this.core.cfg(),
      pre.fees ?? this.fees(agg, agg.groups),
      agg.order.customer_id ? this.core.repo.count('orders', { customer_id: agg.order.customer_id }) : null,
    ]);
    return this.views.adminDetail(agg, timeline, notes, c, { canViewContact, fees, orderCount });
  }

  async adminOrder(orderId: string): Promise<Agg> {
    const agg = isUuid(orderId) ? await this.core.load(orderId) : undefined;
    if (!agg) throw notFound();
    return agg;
  }

  async getOrderAdmin(ref: string, canViewContact = false): Promise<AdminOrderDetail | null> {
    const o = (await this.core.repo.find('orders', { ref: ref.trim().toUpperCase() }))[0];
    const agg = o ? await this.core.load(o.id) : undefined;
    return agg ? this.adminDetail(agg, canViewContact) : null;
  }

  async listOrdersAdmin(q: AdminListQuery, page: common.PageInput, canViewContact = false): Promise<common.Page<AdminOrderDetail>> {
    const rows = await this.core.repo.adminOrders(await this.adminFilter(q ?? {}, null), toPageRequest(page), this.core.now());
    const ids = rows.items.map((r) => r.id);
    const [aggs, timelines, notes, cfg] = await Promise.all([this.core.loadMany(ids), this.core.timelinesOf(ids), this.notesOf(ids), this.core.cfg()]);
    const items = await Promise.all(rows.items.map((r) => this.adminDetail(aggs.get(r.id)!, canViewContact, cfg, { timeline: timelines.get(r.id)!, notes: notes.get(r.id) ?? [] })));
    return { ...rows, items };
  }

  /** Staff notes of several orders in one read, newest first */
  async notesOf(orderIds: string[]): Promise<Map<string, NoteRec[]>> {
    const out = new Map<string, NoteRec[]>();
    if (!orderIds.length) return out;
    for (const n of await this.core.repo.find('notes', { order_id: orderIds }, { orderBy: [['at', 'desc']] })) {
      const list = out.get(n.order_id);
      if (list) list.push(n);
      else out.set(n.order_id, [n]);
    }
    return out;
  }

  async getOrdersByIds(
    viewer: { area: 'store' | 'seller' | 'admin'; customerId?: string; guestSessionId?: string; sellerId?: string },
    orderIds: string[],
    canViewContact = false,
  ): Promise<Record<string, OrderDetail | { order: OrderDetail; groups: SellerOrderDetail[] } | AdminOrderDetail | null>> {
    const ids = orderIds.filter(isUuid);
    // the timelines (and staff notes) of every order in one read each, with what the area may see
    const visibility = viewer.area === 'store' ? CUSTOMER : viewer.area === 'seller' ? SELLER : undefined;
    const [aggs, timelines, notes, cfg] = await Promise.all([
      this.core.loadMany(ids),
      this.core.timelinesOf(ids, visibility),
      viewer.area === 'admin' ? this.notesOf(ids) : new Map<string, NoteRec[]>(),
      this.core.cfg(),
    ]);
    const out: Record<string, OrderDetail | { order: OrderDetail; groups: SellerOrderDetail[] } | AdminOrderDetail | null> = {};
    for (const id of orderIds) {
      const agg = aggs.get(id);
      out[id] = null;
      if (!agg) continue;
      const timeline = timelines.get(id)!;
      if (viewer.area === 'store') out[id] = (await this.visibleToShopper(agg, viewer)) ? await this.storeDetail(agg, cfg, timeline) : null;
      else if (viewer.area === 'seller') out[id] = viewer.sellerId ? await this.sellerOrder(agg, viewer.sellerId, cfg, timeline) : null;
      else out[id] = await this.adminDetail(agg, canViewContact, cfg, { timeline, notes: notes.get(id) ?? [] });
    }
    return out;
  }

  async paidAmounts(orderId: string): Promise<ItemPaidAmount[]> {
    const agg = await this.core.load(orderId);
    if (!agg) throw notFound();
    return agg.items.map((i) => this.views.paid(agg, i));
  }
}
