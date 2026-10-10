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
import { DAY, dayStart, endOfMarketDay, rangeStart } from '../domain/rules.js';
import type { AdminOrderFilter, GroupRec, OrderRec, SellerGroupFilter } from '../ports.js';
import { notFound, type Agg, type Cfg, type Core } from './core.js';
import type { Fees, Views } from './views.js';

export interface StoreViewer {
  customerId?: string | null;
  guestSessionId?: string | null;
}

export type AdminListQuery = Omit<AdminOrderFilter, 'placedFrom' | 'placedTo'> & { placedFrom?: string; placedTo?: string; savedFilterId?: string };
export type SellerListQuery = { tab?: string; tabs?: string | string[]; q?: string; placedFrom?: string; placedTo?: string; overdueOnly?: boolean; sort?: string };

const toPageRequest = (p: common.PageInput | undefined): PageRequest => {
  const limit = Math.min(Math.max(p?.limit ?? 24, 1), 100);
  return p?.page ? { mode: 'page', page: p.page, limit } : { mode: 'cursor', cursor: p?.cursor ?? null, limit };
};

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

  async storeDetail(agg: Agg, cfg?: Cfg): Promise<OrderDetail> {
    return this.views.detail(agg, await this.core.timelineOf(agg.order.id, ['customer']), 'store', cfg ?? (await this.core.cfg()));
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
    return { ...rows, items: rows.items.map((r) => this.views.summary(aggs.get(r.id)!)) };
  }

  async listOrdersForCustomer(customerId: string, filter: { q?: string; range?: string; from?: string; to?: string; tab?: string }, page: common.PageInput): Promise<common.Page<OrderDetail>> {
    const { f } = this.customerFilter(customerId, filter ?? {});
    const rows = await this.core.repo.customerOrders(customerId, f, toPageRequest(page));
    const aggs = await this.core.loadMany(rows.items.map((r) => r.id));
    const cfg = await this.core.cfg();
    const items: OrderDetail[] = [];
    for (const r of rows.items) items.push(await this.storeDetail(aggs.get(r.id)!, cfg));
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
      const aggs = await this.core.loadMany(rows.items.map((r) => r.id));
      for (const r of rows.items) {
        const { canCancelSomething: _c, paymentIntentId: _p, documents, ...order } = await this.storeDetail(aggs.get(r.id)!, cfg);
        records.push({ ...order, documents: documents.map((d) => ({ kind: d.kind, label: d.label, number: d.number, issuedAt: d.issuedAt })) });
      }
      cursor = rows.nextCursor ?? null;
      if (!cursor) break;
    }
    return [{ key: 'orders', title: 'Orders', module: 'orders', records }];
  }

  async countByTab(customerId: string | null, range?: string) {
    if (!customerId) return { all: 0, inProgress: 0, delivered: 0, returns: 0, cancelled: 0, delayedPackages: 0 };
    const counts = await this.core.repo.customerTabCounts(customerId, rangeStart(range, this.core.now(), this.core.tz));
    const delayedPackages = (await this.core.repo.delayedGroupsOfCustomer(customerId, this.core.now())).length;
    return { ...counts, delayedPackages };
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
    return rows.items.map((r) => this.views.summary(aggs.get(r.id)!));
  }

  async getOrderForViewer(viewer: StoreViewer, ref: string): Promise<OrderDetail | null> {
    const o = (await this.core.repo.find('orders', { ref: ref.trim().toUpperCase() }))[0];
    const agg = o ? await this.core.load(o.id) : undefined;
    if (!agg || !(await this.visibleToShopper(agg, viewer))) return null;
    return this.storeDetail(agg);
  }

  /* ---------------------------------------------------------------- seller */

  async fees(agg: Agg, groups: readonly GroupRec[]): Promise<Fees> {
    const out: Fees = new Map();
    for (const g of groups) {
      if (g.owner_type === 'official') {
        out.set(g.id, null);
        continue;
      }
      const items = agg.items.filter((i) => i.group_id === g.id);
      const f = this.views.funding(items, agg.order.currency);
      const c = agg.order.currency;
      const calc = await this.core.soft('finance', 'fee estimate', (fin) =>
        fin.calculateFee({
          categoryId: items[0]?.category_id ?? items[0]?.product_snapshot.categoryId ?? null,
          itemPrice: money(g.items_total, c),
          sellerDiscount: money(f.seller, c),
          platformDiscount: money(f.platform, c),
          shippingCharged: money(g.shipping_total, c),
        }),
      );
      out.set(g.id, calc ? { fee: calc.fee, earnings: calc.sellerEarnings } : null);
    }
    return out;
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
    const [timeline, cfg, fees] = await Promise.all([this.core.timelineOf(agg.order.id, ['customer', 'seller']), this.core.cfg(), this.fees(agg, [group])]);
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
    };
  }

  async sellerRows(sellerId: string, q: SellerListQuery, page: PageRequest): Promise<common.Page<SellerOrderRow>> {
    const rows = await this.core.repo.sellerGroups(sellerId, this.sellerFilter(q), page, this.core.now());
    const aggs = await this.core.loadMany(rows.items.map((g) => g.order_id));
    const cfg = await this.core.cfg();
    return { ...rows, items: rows.items.map((g) => this.views.sellerRow(aggs.get(g.order_id)!, aggs.get(g.order_id)!.groups.find((x) => x.id === g.id)!, cfg)) };
  }

  async sellerOrder(agg: Agg, sellerId: string, cfg: Cfg) {
    const own = agg.groups.filter((g) => g.seller_id === sellerId);
    if (!own.length) return null;
    const [timeline, fees] = await Promise.all([this.core.timelineOf(agg.order.id, ['customer', 'seller']), this.fees(agg, own)]);
    return this.views.sellerOrder(agg, sellerId, timeline, cfg, fees);
  }

  async getOrderForSeller(sellerId: string, ref: string): Promise<{ order: OrderDetail; groups: SellerOrderDetail[] } | null> {
    const o = (await this.core.repo.find('orders', { ref: ref.trim().toUpperCase() }))[0];
    const agg = o ? await this.core.load(o.id) : undefined;
    if (!agg) return null;
    return this.sellerOrder(agg, sellerId, await this.core.cfg());
  }

  async listOrdersForSeller(sellerId: string, q: SellerListQuery, page: common.PageInput) {
    const rows = await this.core.repo.sellerGroups(sellerId, this.sellerFilter(q ?? {}), toPageRequest(page), this.core.now());
    const aggs = await this.core.loadMany(rows.items.map((g) => g.order_id));
    const cfg = await this.core.cfg();
    const seen = new Set<string>();
    const items: { order: OrderDetail; groups: SellerOrderDetail[] }[] = [];
    for (const g of rows.items) {
      if (seen.has(g.order_id)) continue;
      seen.add(g.order_id);
      const v = await this.sellerOrder(aggs.get(g.order_id)!, sellerId, cfg);
      if (v) items.push(v);
    }
    return { ...rows, items };
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
      placedFrom: m.placedFrom ? dayStart(String(m.placedFrom).slice(0, 10), tz) : null,
      placedTo: m.placedTo ? dayStart(String(m.placedTo).slice(0, 10), tz, true) : null,
    };
  }

  async adminRows(q: AdminListQuery, page: PageRequest, staffId: string | null): Promise<common.Page<AdminOrderRow>> {
    const rows = await this.core.repo.adminOrders(await this.adminFilter(q, staffId), page, this.core.now());
    const aggs = await this.core.loadMany(rows.items.map((r) => r.id));
    return { ...rows, items: rows.items.map((r) => this.views.adminRow(aggs.get(r.id)!)) };
  }

  async adminDetail(agg: Agg, canViewContact: boolean, cfg?: Cfg): Promise<AdminOrderDetail> {
    const [timeline, notes, c, fees, orderCount] = await Promise.all([
      this.core.timelineOf(agg.order.id),
      this.core.repo.find('notes', { order_id: agg.order.id }, { orderBy: [['at', 'desc']] }),
      cfg ? Promise.resolve(cfg) : this.core.cfg(),
      this.fees(agg, agg.groups),
      agg.order.customer_id ? this.core.repo.count('orders', { customer_id: agg.order.customer_id }) : Promise.resolve(null),
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
    const aggs = await this.core.loadMany(rows.items.map((r) => r.id));
    const cfg = await this.core.cfg();
    const items: AdminOrderDetail[] = [];
    for (const r of rows.items) items.push(await this.adminDetail(aggs.get(r.id)!, canViewContact, cfg));
    return { ...rows, items };
  }

  async getOrdersByIds(
    viewer: { area: 'store' | 'seller' | 'admin'; customerId?: string; guestSessionId?: string; sellerId?: string },
    orderIds: string[],
    canViewContact = false,
  ): Promise<Record<string, OrderDetail | { order: OrderDetail; groups: SellerOrderDetail[] } | AdminOrderDetail | null>> {
    const aggs = await this.core.loadMany(orderIds.filter(isUuid));
    const cfg = await this.core.cfg();
    const out: Record<string, OrderDetail | { order: OrderDetail; groups: SellerOrderDetail[] } | AdminOrderDetail | null> = {};
    for (const id of orderIds) {
      const agg = aggs.get(id);
      out[id] = null;
      if (!agg) continue;
      if (viewer.area === 'store') out[id] = (await this.visibleToShopper(agg, viewer)) ? await this.storeDetail(agg, cfg) : null;
      else if (viewer.area === 'seller') out[id] = viewer.sellerId ? await this.sellerOrder(agg, viewer.sellerId, cfg) : null;
      else out[id] = await this.adminDetail(agg, canViewContact, cfg);
    }
    return out;
  }

  async paidAmounts(orderId: string): Promise<ItemPaidAmount[]> {
    const agg = await this.core.load(orderId);
    if (!agg) throw notFound();
    return agg.items.map((i) => this.views.paid(agg, i));
  }
}
