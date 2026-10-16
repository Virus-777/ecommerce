/**
 * Reads for every area with record scope (customers and guest sessions their own returns, sellers only
 * their own returns, staff everything): lists with tabs and filters, queue tiles and KPIs, the inspection
 * queue, refund request lists, exports through reports and the per-item eligibility for order views.
 */
import { zonedDayRange } from '../../../kernel/lib/clock.js';
import { AppError, isNotImplemented } from '../../../kernel/errors/index.js';
import { isUuid } from '../../../kernel/lib/ids.js';
import { money } from '../../../kernel/lib/money.js';
import { toPageRequest, type PageRequest } from '../../../kernel/lib/pagination.js';
import type * as common from '../../../spec/common.js';
import type * as identity from '../../../spec/identity.js';
import type * as reports from '../../../spec/reports.js';
import type {
  AdminReturnRow,
  CustomerReturnsOverview,
  InspectionQueueRow,
  InspectionQueueStats,
  RefundRequest,
  ReturnCase,
  ReturnStats,
  ReturnSummary,
  SellerReturnCounts,
  SellerReturnRow,
} from '../../../spec/returns.js';
import { ACTIVE_STATUSES, CLOSED_STATUSES, DAY, deadline, is, itemVerdict, OPEN_STATUSES, PENDING_REFUND, REFUND_LABEL, shortDate } from '../domain/rules.js';
import type { RefundFilter, ReturnFilter } from '../ports.js';
import { notFound, unavailable, type Agg, type By, type Core, type Visibility } from './core.js';
import type { Views } from './views.js';

export const ADMIN_DATASET = 'returns.admin.requests';
export const INSPECTIONS_DATASET = 'returns.admin.inspections';
export const SELLER_DATASET = 'returns.seller.requests';

export type SellerTab = 'requests' | 'to_inspect' | 'disputes' | 'closed';
export type AdminTab = 'all_open' | 'needs_decision' | 'in_transit' | 'inspecting' | 'refund_pending' | 'exceptions' | 'closed';

export interface ItemFactsInput {
  orderItemId: string;
  state: string;
  quantity: number;
  deliveredAt: string | null;
  returnWindowEndsAt: string | null;
  windowDays: number;
}

export interface ItemEligibilityOut {
  orderItemId: string;
  eligible: boolean;
  ineligibleReason: string | null;
  message: string;
  quantityPurchased: number;
  quantityReturnable: number;
  returnBy: string | null;
  latestReturn: { returnId: string; ref: string; status: string; statusLabel: string; refundStatus: string | null } | null;
}

export class Reads {
  #registered?: Promise<void>;

  constructor(
    private readonly core: Core,
    private readonly views: Views,
  ) {}

  page = (p: common.PageInput | undefined): PageRequest => toPageRequest(p);

  private async rows<T>(f: ReturnFilter, page: PageRequest, map: (a: Agg) => T): Promise<common.Page<T>> {
    const res = await this.core.repo.listReturns(f, page);
    const aggs = await this.core.loadMany(res.items.map((r) => r.id));
    return { ...res, items: res.items.map((r) => map(aggs.get(r.id)!)) };
  }

  private periodFrom(period: string | undefined): Date | null {
    const now = this.core.now();
    if (period === 'last_30_days') return new Date(now.getTime() - 30 * DAY);
    if (period === 'last_90_days') return new Date(now.getTime() - 90 * DAY);
    if (period === 'this_year') return new Date(`${now.getUTCFullYear()}-01-01T00:00:00Z`);
    return null;
  }

  /* ---------------------------------------------------------------- store */

  storeFilter(who: { customerId?: string | null; guestSessionId?: string | null }, state?: string, orderId?: string): ReturnFilter {
    return {
      customerId: who.customerId ?? null,
      guestSessionId: who.customerId ? undefined : (who.guestSessionId ?? null),
      ...(state === 'open' ? { statuses: OPEN_STATUSES } : state === 'completed' ? { statuses: ['completed', 'cancelled'] } : {}),
      ...(orderId ? { orderId } : {}),
    };
  }

  listMine(who: { customerId?: string | null; guestSessionId?: string | null }, q: { state?: string; orderId?: string }, page: PageRequest): Promise<common.Page<ReturnSummary>> {
    if (!who.customerId && !who.guestSessionId) return Promise.resolve({ items: [], nextCursor: null, total: 0 });
    return this.rows(this.storeFilter(who, q.state ?? 'all', q.orderId), page, (a) => this.views.summary(a));
  }

  async listOpenForCustomer(customerId: string, limit: number): Promise<{ items: ReturnSummary[]; total: number }> {
    const f = this.storeFilter({ customerId }, 'open');
    const [page, total] = await Promise.all([this.rows(f, { mode: 'cursor', cursor: null, limit: Math.min(Math.max(limit, 1), 50) }, (a) => this.views.summary(a)), this.core.repo.countReturns(f)]);
    return { items: page.items, total };
  }

  async customerOverview(customerId: string): Promise<CustomerReturnsOverview> {
    const currency = this.core.currency;
    const all = await this.core.repo.find('returns', { customer_id: customerId }, { orderBy: [['requested_at', 'desc']], limit: 500 });
    const ids = all.map((r) => r.id);
    const refunds = ids.length ? await this.core.repo.find('refund_requests', { return_id: ids }) : [];
    const yearStart = new Date(`${this.core.now().getUTCFullYear()}-01-01T00:00:00Z`);
    const open = all.filter((r) => is(OPEN_STATUSES, r.status));
    const dropOff = open.filter((r) => r.status === 'approved');
    const onTheWay = refunds.filter((r) => is(['approved', 'processing'], r.status));
    const sentThisYear = refunds.filter((r) => r.status === 'sent' && new Date(r.sent_at ?? r.updated_at).getTime() >= yearStart.getTime());
    let openNote: string | null = null;
    if (dropOff.length) {
      const shipments = await this.core.repo.find('return_shipments', { return_id: dropOff.map((r) => r.id), status: 'label_issued' }, { orderBy: [['drop_off_by', 'asc']] });
      const first = shipments.find((s) => s.drop_off_by);
      openNote = `${dropOff.length} need${dropOff.length === 1 ? 's' : ''} drop-off${first?.drop_off_by ? ` by ${shortDate(first.drop_off_by, this.core.tz)}` : ''}`;
    } else if (open.some((r) => r.status === 'info_requested')) openNote = 'A seller asked you a question';
    return {
      openReturns: open.length,
      openNote,
      refundsOnTheWay: money(
        onTheWay.reduce((s, r) => s + r.total, 0),
        currency,
      ),
      refundsOnTheWayNote: onTheWay.length ? 'Approved refunds are on their way; banks usually show them in 3–5 business days after we send them.' : null,
      refundedThisYear: money(
        sentThisYear.reduce((s, r) => s + r.total, 0),
        currency,
      ),
      completedThisYear: all.filter((r) => r.status === 'completed' && r.completed_at && r.completed_at.getTime() >= yearStart.getTime()).length,
    };
  }

  async byRef(ref: string): Promise<Agg | null> {
    const row = (await this.core.repo.find('returns', { ref: ref.trim().toUpperCase() }))[0];
    return row ? ((await this.core.load(row.id)) ?? null) : null;
  }

  async byRefFor(ref: string, v: Visibility): Promise<Agg | null> {
    const agg = await this.byRef(ref);
    if (!agg || !(await this.core.canSee(agg.ret, v))) return null;
    return agg;
  }

  /* ---------------------------------------------------------------- seller */

  sellerFilter(sellerId: string, q: { tab?: SellerTab; q?: string; reason?: string; period?: string }): ReturnFilter {
    const f: ReturnFilter = { sellerId, ownerType: 'seller', q: q.q, reason: q.reason, requestedFrom: this.periodFrom(q.period) };
    if (q.tab === 'requests') f.statuses = ['requested', 'info_requested', 'approved', 'in_transit'];
    if (q.tab === 'to_inspect') f.statuses = ['received', 'awaiting_remedy'];
    if (q.tab === 'disputes') Object.assign(f, { disputed: true, statuses: OPEN_STATUSES });
    if (q.tab === 'closed') f.statuses = CLOSED_STATUSES;
    return f;
  }

  listSeller(sellerId: string, q: { tab?: SellerTab; q?: string; reason?: string; period?: string }, page: PageRequest): Promise<common.Page<SellerReturnRow>> {
    return this.rows(this.sellerFilter(sellerId, q), page, (a) => this.views.sellerRow(a));
  }

  async sellerCounts(sellerId: string): Promise<SellerReturnCounts> {
    const now = this.core.now();
    const repo = this.core.repo;
    const base: ReturnFilter = { sellerId, ownerType: 'seller' };
    const [awaiting, received, disputes, requests, toInspect, disputesTab, closed] = await Promise.all([
      repo.find('returns', { seller_id: sellerId, status: 'requested', platform_handling: false }, { orderBy: [['response_due_at', 'asc']] }),
      // Fulfilled by Marketly returns are inspected by Marketly, not the seller
      repo.find('returns', { seller_id: sellerId, status: 'received', fulfilled_by: { op: '<>', value: 'marketly_service' } }),
      repo.listReturns({ ...base, disputed: true, statuses: OPEN_STATUSES }, { mode: 'cursor', cursor: null, limit: 100 }),
      repo.countReturns(this.sellerFilter(sellerId, { tab: 'requests' })),
      repo.countReturns(this.sellerFilter(sellerId, { tab: 'to_inspect' })),
      repo.countReturns(this.sellerFilter(sellerId, { tab: 'disputes' })),
      repo.countReturns(this.sellerFilter(sellerId, { tab: 'closed' })),
    ]);
    const overdue = awaiting.filter((r) => r.response_due_at && r.response_due_at.getTime() < now.getTime());
    const [receivedAggs, withEvidence] = await Promise.all([
      this.core.loadMany(received.map((r) => r.id)),
      disputes.items.length ? repo.find('return_evidence', { return_id: disputes.items.map((r) => r.id), party: 'seller' }).then((rows) => new Set(rows.map((e) => e.return_id))) : new Set<string>(),
    ]);
    const receivedTimes = [...receivedAggs.values()].map((a) => this.core.receivedAt(a)).filter((d): d is Date => !!d);
    return {
      responseOverdue: overdue.length,
      overdueRef: overdue[0]?.ref ?? null,
      awaitingResponse: awaiting.length,
      nextResponseDueAt: awaiting.find((r) => r.response_due_at && r.response_due_at.getTime() >= now.getTime())?.response_due_at?.toISOString() ?? null,
      toInspect: received.length,
      oldestReceivedAt: receivedTimes.length ? new Date(Math.min(...receivedTimes.map((d) => d.getTime()))).toISOString() : null,
      disputesNeedingEvidence: disputes.items.filter((r) => !withEvidence.has(r.id)).length,
      nextEvidenceDueAt: null,
      tabs: { requests, toInspect, disputes: disputesTab, closed },
    };
  }

  async sellerReturnStats(sellerId: string, range: common.DateRange): Promise<{ requests: number; returnRatePct: number; respondedOnTimePct: number; unresolved: number }> {
    const { start: from, end: to } = zonedDayRange(range, this.core.tz) as { start: Date; end: Date };
    const rows = (await this.core.repo.find('returns', { seller_id: sellerId, requested_at: { op: '>=', value: from } })).filter((r) => r.requested_at.getTime() < to.getTime());
    const decided = rows.filter((r) => r.decision);
    const onTime = decided.filter((r) => !r.response_due_at || new Date(r.decision!.decidedAt).getTime() <= r.response_due_at.getTime());
    const orders = await this.core.quiet('orders of seller', () => this.core.ctx.use('orders').listOrdersAdmin({ sellerId, placedFrom: from.toISOString(), placedTo: to.toISOString() }, { page: 1, limit: 1 }));
    const unresolved = await this.core.repo.countReturns({ sellerId, statuses: ACTIVE_STATUSES });
    const ordersTotal = orders?.total ?? 0;
    return {
      requests: rows.length,
      returnRatePct: ordersTotal ? Math.round((rows.length / ordersTotal) * 1000) / 10 : 0,
      respondedOnTimePct: decided.length ? Math.round((onTime.length / decided.length) * 1000) / 10 : 100,
      unresolved,
    };
  }

  /* ---------------------------------------------------------------- admin */

  adminFilter(q: { tab?: AdminTab; q?: string; sellerType?: 'official' | 'marketplace'; sellerId?: string; reason?: string; ownerId?: string; refundStatus?: string; deadline?: 'overdue' | 'due_today' | 'next_3_days'; orderId?: string }): ReturnFilter {
    const now = this.core.now();
    const f: ReturnFilter = { q: q.q, reason: q.reason, ownerStaffId: q.ownerId, sellerId: q.sellerId, orderId: q.orderId };
    if (q.sellerType === 'official') f.ownerType = 'official';
    if (q.sellerType === 'marketplace') f.ownerType = 'seller';
    if (q.refundStatus) f.refundStatuses = [q.refundStatus];
    switch (q.tab) {
      case 'all_open':
        f.statuses = ACTIVE_STATUSES;
        break;
      case 'needs_decision':
        f.statuses = ['requested', 'info_requested'];
        break;
      case 'in_transit':
        f.statuses = ['approved', 'in_transit'];
        break;
      case 'inspecting':
        f.statuses = ['received'];
        break;
      case 'refund_pending':
        f.refundPending = true;
        break;
      case 'exceptions':
        Object.assign(f, { hasException: true, statuses: [...ACTIVE_STATUSES, 'completed'] });
        break;
      case 'closed':
        f.statuses = CLOSED_STATUSES;
        break;
    }
    if (q.deadline) {
      f.statuses = f.statuses ? f.statuses.filter((s) => s === 'requested') : ['requested'];
      if (q.deadline === 'overdue') f.dueBefore = now;
      if (q.deadline === 'due_today') Object.assign(f, { dueFrom: now, dueBefore: new Date(now.getTime() + DAY) });
      if (q.deadline === 'next_3_days') Object.assign(f, { dueFrom: now, dueBefore: new Date(now.getTime() + 3 * DAY) });
    }
    return f;
  }

  listAdmin(q: Parameters<Reads['adminFilter']>[0], page: PageRequest): Promise<common.Page<AdminReturnRow>> {
    return this.rows(this.adminFilter(q), page, (a) => this.views.adminRow(a));
  }

  listForSeller(sellerId: string, filter: { state?: 'open' | 'completed' | 'all'; q?: string }, page: common.PageInput): Promise<common.Page<AdminReturnRow>> {
    const f: ReturnFilter = { sellerId, ownerType: 'seller', q: filter.q, ...(filter.state === 'open' || !filter.state ? { statuses: OPEN_STATUSES } : filter.state === 'completed' ? { statuses: CLOSED_STATUSES } : {}) };
    return this.rows(f, this.page(page), (a) => this.views.adminRow(a));
  }

  async stats(): Promise<ReturnStats> {
    const repo = this.core.repo;
    const now = this.core.now();
    const tab = (t: AdminTab) => repo.countReturns(this.adminFilter({ tab: t }));
    // the Exceptions tile opens the Exceptions tab: both count the tab's filter
    const [open, openOfficial, pastDeadline, sellerRepliesOverdue, awaitingInspection, exceptions, allOpen, needsDecision, inTransit, inspecting, refundPending] = await Promise.all([
      repo.countReturns({ statuses: ACTIVE_STATUSES }),
      repo.countReturns({ statuses: ACTIVE_STATUSES, ownerType: 'official' }),
      repo.countReturns({ statuses: ['requested'], dueBefore: now }),
      repo.countReturns({ statuses: ['requested'], ownerType: 'seller', platformHandling: false, dueBefore: now }),
      repo.countReturns({ statuses: ['received'] }),
      tab('exceptions'),
      tab('all_open'),
      tab('needs_decision'),
      tab('in_transit'),
      tab('inspecting'),
      tab('refund_pending'),
    ]);
    const [pending, recipients] = await Promise.all([repo.refundFacts(PENDING_REFUND, 5000), this.core.soft('access', 'queue owner', (a) => a.resolveRecipients('returns_manager'))]);
    const nameOf = async (id: string | null | undefined) => (id ? ((await this.core.soft('access', 'staff ref', (a) => a.getStaffRef(id)))?.name ?? null) : null);
    const [lead, backup] = await Promise.all([nameOf(recipients?.leadAccountId), nameOf(recipients?.viaBackup ? recipients.accountIds[0] : null)]);
    return {
      open,
      openOfficial,
      openSellers: open - openOfficial,
      pastDeadline,
      sellerRepliesOverdue,
      awaitingInspection,
      refundsPending: money(
        pending.reduce((s, r) => s + r.total, 0),
        this.core.currency,
      ),
      refundsPendingCount: pending.length,
      exceptions,
      tabCounts: { allOpen, needsDecision, inTransit, inspecting, refundPending, exceptions },
      queueOwner: { lead: lead ?? null, backup: backup ?? null, escalation: recipients?.escalationRoleKey ? recipients.escalationRoleKey.replace(/_/g, ' ') : null },
    };
  }

  /* ---------------------------------------------------------------- inspection queue (Official Store) */

  /** Returns that come to the Marketly returns dock: Official Store and Fulfilled by Marketly returns (D7) */
  inspectionFilter(tab: 'received' | 'arriving' | 'decided' | undefined): ReturnFilter {
    const f: ReturnFilter = { marketlyDock: true };
    if (tab === 'arriving') f.statuses = ['approved', 'in_transit'];
    else if (tab === 'decided') f.statuses = ['awaiting_remedy', 'completed'];
    else f.statuses = ['received'];
    return f;
  }

  inspectionQueue(tab: 'received' | 'arriving' | 'decided' | undefined, page: PageRequest): Promise<common.Page<InspectionQueueRow>> {
    return this.rows(this.inspectionFilter(tab), page, (a) => this.views.inspectionRow(a));
  }

  async inspectionStats(): Promise<InspectionQueueStats> {
    const repo = this.core.repo;
    const now = this.core.now();
    const weekAgo = new Date(now.getTime() - 7 * DAY);
    const [receivedPage, arriving, inspected, pendingRefunds] = await Promise.all([
      repo.listReturns(this.inspectionFilter('received'), { mode: 'cursor', cursor: null, limit: 500 }),
      repo.countReturns(this.inspectionFilter('arriving')),
      repo.find('inspections', { inspected_at: { op: '>=', value: weekAgo } }),
      // refunds of dock returns with Finance: the Official Store's, and the seller-funded ones of Fulfilled by Marketly returns
      repo.refundFacts(['requested', 'under_review'], 5000),
    ]);
    // oldest first (the list pages newest first)
    const received = receivedPage.items.sort((a, b) => a.requested_at.getTime() - b.requested_at.getTime());
    const decided = [...new Set(inspected.map((i) => i.return_id))];
    const sellerReturnIds = [...new Set(pendingRefunds.filter((r) => r.owner_type === 'seller' && r.return_id).map((r) => r.return_id!))];
    const [aggs, decidedOfficial, serviceRows] = await Promise.all([
      this.core.loadMany(received.map((r) => r.id)),
      decided.length ? repo.countReturns({ marketlyDock: true, ids: decided }) : 0,
      sellerReturnIds.length ? repo.find('returns', { id: sellerReturnIds, fulfilled_by: 'marketly_service' }) : [],
    ]);
    const overdue = [...aggs.values()].filter((a) => (this.views.inspectBy(a)?.getTime() ?? Infinity) < now.getTime());
    const serviceReturns = new Set(serviceRows.map((r) => r.id));
    const withFinance = pendingRefunds.filter((r) => r.owner_type === 'official' || (r.return_id && serviceReturns.has(r.return_id)));
    return {
      waiting: received.length,
      overdue: overdue.length,
      overdueRef: overdue[0]?.ret.ref ?? null,
      arrivingThisWeek: arriving,
      refundsWithFinance: withFinance.length,
      refundsWithFinanceAmount: money(
        withFinance.reduce((s, r) => s + r.total, 0),
        this.core.currency,
      ),
      tabCounts: { received: received.length, arriving, decidedThisWeek: decidedOfficial },
    };
  }

  /* ---------------------------------------------------------------- refund requests */

  refundFilter(q: { status?: string; source?: string; sellerId?: string; orderId?: string }): RefundFilter {
    return { status: q.status, source: q.source, sellerId: q.sellerId, orderId: q.orderId };
  }

  async listRefunds(q: { status?: string; source?: string; sellerId?: string; orderId?: string }, page: PageRequest): Promise<common.Page<RefundRequest>> {
    const res = await this.core.repo.listRefunds(this.refundFilter(q), page);
    return { ...res, items: await this.views.refundRequests(res.items) };
  }

  async refundById(id: string): Promise<RefundRequest> {
    const rr = isUuid(id) ? await this.core.repo.get('refund_requests', id) : undefined;
    if (!rr) throw notFound('Refund request');
    return (await this.views.refundRequests([rr]))[0]!;
  }

  async refundByRef(ref: string): Promise<RefundRequest | null> {
    const rr = (await this.core.repo.find('refund_requests', { ref: ref.trim().toUpperCase() }))[0];
    return rr ? (await this.views.refundRequests([rr]))[0]! : null;
  }

  async refundsWhere(where: { orderId?: string; caseId?: string }): Promise<RefundRequest[]> {
    const rows = await this.core.repo.find('refund_requests', { ...(where.orderId ? { order_id: where.orderId } : {}), ...(where.caseId ? { case_id: where.caseId } : {}) }, { orderBy: [['created_at', 'desc']] });
    return this.views.refundRequests(rows);
  }

  /* ---------------------------------------------------------------- order views */

  async returnStateForItems(orderItemIds: string[]) {
    const ids = [...new Set(orderItemIds.filter(isUuid))];
    const rows = ids.length ? await this.core.repo.find('return_items', { order_item_id: ids }) : [];
    const aggs = await this.core.loadMany([...new Set(rows.map((r) => r.return_id))]);
    return orderItemIds.map((orderItemId) => {
      const latest = rows
        .filter((r) => r.order_item_id === orderItemId)
        .map((r) => aggs.get(r.return_id))
        .filter((a): a is Agg => !!a)
        .sort((a, b) => b.ret.requested_at.getTime() - a.ret.requested_at.getTime())[0];
      return { orderItemId, returnId: latest?.ret.id ?? null, ref: latest?.ret.ref ?? null, status: latest?.ret.status ?? null, refundStatus: latest ? this.views.refundStatusOf(latest) : null };
    });
  }

  /** Eligibility now from the order item facts (GraphQL OrderItem.returnEligibility passes the item it resolves) */
  async eligibilityFromFacts(items: ItemFactsInput[]): Promise<ItemEligibilityOut[]> {
    const ids = items.map((i) => i.orderItemId).filter(isUuid);
    const [used, rows, baseline] = await Promise.all([this.core.repo.usedQuantities(ids), ids.length ? this.core.repo.find('return_items', { order_item_id: ids }) : Promise.resolve([]), this.core.baseline()]);
    const aggs = await this.core.loadMany([...new Set(rows.map((r) => r.return_id))]);
    const now = this.core.now();
    return items.map((i) => {
      const own = rows
        .filter((r) => r.order_item_id === i.orderItemId)
        .map((r) => aggs.get(r.return_id))
        .filter((a): a is Agg => !!a)
        .sort((a, b) => b.ret.requested_at.getTime() - a.ret.requested_at.getTime());
      const open = own.find((a) => is(ACTIVE_STATUSES, a.ret.status));
      const v = itemVerdict({ ...i, used: used.get(i.orderItemId) ?? 0, openReturn: open ? { id: open.ret.id, ref: open.ret.ref } : null }, now, baseline.windowDays, this.core.tz);
      const latest = open ?? own[0];
      return {
        orderItemId: i.orderItemId,
        eligible: v.eligible,
        ineligibleReason: v.reason,
        message: v.message,
        quantityPurchased: i.quantity,
        quantityReturnable: v.quantityReturnable,
        returnBy: v.returnBy?.toISOString() ?? null,
        latestReturn: latest ? { returnId: latest.ret.id, ref: latest.ret.ref, status: latest.ret.status, statusLabel: this.views.summary(latest).statusLabel, refundStatus: this.views.refundStatusOf(latest) } : null,
      };
    });
  }

  /**
   * Public API: each item's eligibility from the item itself (orders.getOrderItem: state, delivered at,
   * quantity; the order's terms snapshot for the window) minus quantities on open or completed returns. An
   * item never becomes ineligible just because it has no return record.
   */
  async eligibilityForItems(orderItemIds: string[]): Promise<ItemEligibilityOut[]> {
    const ids = [...new Set(orderItemIds.filter(isUuid))];
    const orders = this.core.ctx.use('orders');
    const infos = (await Promise.all(ids.map((id) => this.core.quiet('order item', () => orders.getOrderItem(id))))).filter((x): x is NonNullable<typeof x> => !!x);
    const facts = new Map<string, ItemFactsInput>();
    const wanted = new Set(ids);
    const orderList = await Promise.all([...new Set(infos.map((i) => i.orderId))].map((orderId) => this.core.quiet('order', () => orders.getOrder(orderId))));
    for (const order of orderList) {
      for (const i of order?.groups.flatMap((g) => g.items) ?? []) {
        if (wanted.has(i.id)) facts.set(i.id, { orderItemId: i.id, state: i.state, quantity: i.quantity, deliveredAt: i.deliveredAt ?? null, returnWindowEndsAt: i.returnWindowEndsAt ?? null, windowDays: i.returnTerms.windowDays });
      }
    }
    // the order could not be read: the item's own facts (window from delivery to its return-by)
    for (const i of infos) {
      if (facts.has(i.id)) continue;
      const days = i.deliveredAt && i.returnWindowEndsAt ? Math.max(0, Math.round((new Date(i.returnWindowEndsAt).getTime() - new Date(i.deliveredAt).getTime()) / DAY)) : 0;
      facts.set(i.id, { orderItemId: i.id, state: i.state, quantity: i.quantity, deliveredAt: i.deliveredAt ?? null, returnWindowEndsAt: i.returnWindowEndsAt ?? null, windowDays: days });
    }
    const known = new Map((await this.eligibilityFromFacts([...facts.values()])).map((k) => [k.orderItemId, k]));
    return orderItemIds.map(
      (id) =>
        known.get(id) ?? { orderItemId: id, eligible: false, ineligibleReason: null, message: 'Open the order to see return options', quantityPurchased: 0, quantityReturnable: 0, returnBy: null, latestReturn: null },
    );
  }

  /** Returns on one order for a viewer, newest first */
  async listForOrder(orderId: string, viewer: { area: 'store' | 'seller' | 'admin'; customerId?: string; guestSessionId?: string; sellerId?: string }): Promise<ReturnCase[]> {
    if (!isUuid(orderId)) return [];
    const rows = await this.core.repo.find('returns', { order_id: orderId }, { orderBy: [['requested_at', 'desc']] });
    const aggs = await this.core.loadMany(rows.map((r) => r.id));
    const v: Visibility = viewer.area === 'admin' ? { area: 'admin' } : viewer.area === 'seller' ? { area: 'seller', sellerId: viewer.sellerId ?? '' } : { area: 'store', customerId: viewer.customerId ?? null, guestSessionId: viewer.guestSessionId ?? null };
    const seen = await Promise.all(rows.map((r) => this.core.canSee(r, v)));
    const visible = rows.filter((_, n) => seen[n]).map((r) => aggs.get(r.id)!);
    return Promise.all(visible.map((agg) => (viewer.area === 'store' ? this.storeCase(agg) : this.views.returnCase(agg, viewer.area))));
  }

  /** The customer's view in the ReturnCase shape: the detail only, seller and staff fields left empty */
  async storeCase(agg: Agg): Promise<ReturnCase> {
    const [detail] = await this.views.details([agg], 'store');
    const zero = money(0, agg.items[0]?.currency ?? this.core.currency);
    return {
      detail: detail!,
      // the store shows the customer's wording everywhere
      statusLabel: detail!.statusLabel,
      customer: { displayName: agg.ret.terms_snapshot.meta.customerName, city: null, ordersWithSeller: 0 },
      payment: { itemPaid: zero, shippingPaid: zero, discountShare: zero, maxRefundable: zero, refundedSoFar: zero, methodLabel: '' },
      policyApplied: agg.ret.terms_snapshot.terms,
      fulfilledBy: agg.ret.fulfilled_by,
      shippingPaidBy: agg.ret.shipping_paid_by as ReturnCase['shippingPaidBy'],
      deadlines: {},
      inspection: null,
      refundRequest: null,
      earningsImpact: null,
      exception: null,
      owner: null,
      flags: [],
      caseId: agg.ret.case_id,
      caseRef: agg.ret.escalation?.caseRef ?? null,
      activity: [],
      inspectionChecklist: null,
      inspectionDraft: null,
      inspector: null,
      evidence: [],
      allowedActions: [],
    };
  }

  async countOpenReturnsForProducts(productIds: string[]): Promise<Record<string, number>> {
    const ids = [...new Set(productIds.filter(isUuid))];
    const counts = await this.core.repo.openReturnsPerProduct(ids);
    return Object.fromEntries(productIds.map((id) => [id, counts.get(id) ?? 0]));
  }

  async listEvidence(returnId: string) {
    const agg = isUuid(returnId) ? await this.core.load(returnId) : undefined;
    if (!agg) return [];
    const refs = await this.views.refs(agg.evidence.flatMap((e) => e.media_ids));
    return agg.evidence.map((e) => this.views.evidenceView(e, refs));
  }

  /* ---------------------------------------------------------------- exports */

  registerDatasets(): Promise<void> {
    const api = this.core.ctx.tryUse('reports');
    if (!api) return Promise.resolve();
    const base = [
      { key: 'ref', label: 'Return' },
      { key: 'orderRef', label: 'Order' },
      { key: 'item', label: 'Item' },
      { key: 'reason', label: 'Reason' },
      { key: 'status', label: 'Status' },
    ];
    this.#registered ??= Promise.all([
      api.registerDataset({
        key: SELLER_DATASET,
        owner: 'returns',
        title: 'Returns and cases',
        permission: 'returns.requests.export',
        audience: 'seller',
        screens: ['seller/returns'],
        available: true,
        phase: 1,
        columns: [...base, { key: 'sku', label: 'SKU' }, { key: 'amount', label: 'Amount' }, { key: 'refunded', label: 'Refunded' }, { key: 'requestedAt', label: 'Requested at' }, { key: 'deadline', label: 'Deadline' }, { key: 'caseRef', label: 'Case' }],
      }),
      api.registerDataset({
        key: ADMIN_DATASET,
        owner: 'returns',
        title: 'Returns and refunds',
        permission: 'returns.requests.view',
        audience: 'staff',
        screens: ['admin/returns'],
        available: true,
        phase: 1,
        columns: [...base, { key: 'seller', label: 'Seller' }, { key: 'amount', label: 'Amount' }, { key: 'refundStatus', label: 'Refund' }, { key: 'owner', label: 'Owner' }, { key: 'deadline', label: 'Deadline' }, { key: 'flags', label: 'Flags' }],
      }),
      api.registerDataset({
        key: INSPECTIONS_DATASET,
        owner: 'returns',
        title: 'Return inspections',
        permission: 'returns.inspections.record',
        audience: 'staff',
        screens: ['ops/return-inspection'],
        available: true,
        phase: 1,
        columns: [...base, { key: 'receivedAt', label: 'Received' }, { key: 'inspector', label: 'Inspector' }, { key: 'target', label: 'Inspect by' }],
      }),
    ])
      .then(() => undefined)
      .catch((err) => {
        this.#registered = undefined;
        if (!isNotImplemented(err)) this.core.ctx.log.warn({ err }, 'returns: export datasets not registered');
      });
    return this.#registered;
  }

  private reportsApi() {
    const api = this.core.ctx.tryUse('reports');
    if (!api) throw unavailable('Exports');
    return api;
  }

  async requestSellerExport(sellerId: string, body: { filters?: unknown; returnIds?: string[] | null; format?: 'csv' | 'xlsx' | null }, principal: identity.Principal, by: By): Promise<reports.ExportJob> {
    const api = this.reportsApi();
    await this.registerDatasets();
    const raw = body.filters && typeof body.filters === 'object' && !Array.isArray(body.filters) ? { ...(body.filters as Record<string, unknown>) } : {};
    const filters = { ...raw, ...(body.returnIds?.length ? { returnIds: body.returnIds } : {}) };
    const job = await api.requestExport({ dataset: SELLER_DATASET, filters, format: body.format ?? 'csv', principal, sellerId });
    await this.core.audit({ action: 'returns.export', actionLabel: 'Exported own returns', category: 'returns', target: { type: 'export', id: job.id, ref: job.ref, label: 'Returns export', screen: 'seller/returns' }, after: { dataset: SELLER_DATASET, filters, format: body.format ?? 'csv' }, visibleToSeller: true }, by);
    return job;
  }

  async getSellerExport(id: string, principal: identity.Principal, sellerId: string): Promise<reports.ExportJob> {
    const job = await this.reportsApi().getExport(id, principal);
    if (!job || job.dataset !== SELLER_DATASET || (job.sellerId && job.sellerId !== sellerId)) throw notFound('Export');
    return job;
  }

  async exportRows(dataset: string, filters: unknown, principal: identity.Principal, cursor?: string): Promise<{ rows: unknown[]; nextCursor?: string }> {
    const f = (filters && typeof filters === 'object' ? filters : {}) as Record<string, unknown>;
    const page: PageRequest = { mode: 'cursor', cursor: cursor ?? null, limit: 100 };
    const str = (k: string) => (typeof f[k] === 'string' ? (f[k] as string) : undefined);
    const fmt = (m: common.Money | null | undefined) => (m ? (m.amount / 100).toFixed(2) : '');
    const ids = Array.isArray(f.returnIds) ? (f.returnIds as string[]).filter(isUuid) : null;
    let rf: ReturnFilter;
    if (dataset === SELLER_DATASET) {
      if (principal.kind !== 'seller' || !principal.sellerId) throw new AppError('FORBIDDEN', 'Seller only');
      rf = this.sellerFilter(principal.sellerId, { tab: str('tab') as SellerTab | undefined, q: str('q'), reason: str('reason'), period: str('period') });
    } else if (dataset === ADMIN_DATASET) {
      if (principal.kind !== 'staff') throw new AppError('FORBIDDEN', 'Staff only');
      rf = this.adminFilter({ tab: str('tab') as AdminTab | undefined, q: str('q'), sellerType: str('sellerType') as 'official' | 'marketplace' | undefined, sellerId: str('sellerId'), reason: str('reason'), ownerId: str('ownerId'), refundStatus: str('refundStatus'), orderId: str('orderId') });
    } else if (dataset === INSPECTIONS_DATASET) {
      if (principal.kind !== 'staff') throw new AppError('FORBIDDEN', 'Staff only');
      rf = this.inspectionFilter(str('tab') as 'received' | 'arriving' | 'decided' | undefined);
    } else throw notFound('Dataset');
    const res = await this.core.repo.listReturns(ids ? { ...rf, ids } : rf, page);
    const aggs = await this.core.loadMany(res.items.map((r) => r.id));
    const list = res.items.map((r) => aggs.get(r.id)!);
    const rows = list.map((a) => {
      const item = a.items[0];
      const common = { ref: a.ret.ref, orderRef: a.ret.order_ref, item: item ? `${item.title} × ${a.items.reduce((n, i) => n + i.quantity, 0)}` : '', reason: this.views.sellerRow(a).reason };
      if (dataset === SELLER_DATASET) {
        const row = this.views.sellerRow(a);
        return { ...common, status: row.statusLabel, sku: item?.sku ?? '', amount: fmt(row.amount), refunded: fmt(row.refundedAmount), requestedAt: row.requestedAt, deadline: row.deadlineLabel, caseRef: a.ret.escalation?.caseRef ?? '' };
      }
      if (dataset === ADMIN_DATASET) {
        const row = this.views.adminRow(a);
        return { ...common, status: row.status, seller: row.seller.name, amount: fmt(row.amount), refundStatus: row.refundStatus ?? '', owner: row.owner?.id ?? '', deadline: row.deadlineLabel, flags: row.flags.map((x) => x.label).join(', ') };
      }
      const row = this.views.inspectionRow(a);
      return { ...common, status: row.status, receivedAt: row.receivedAt ?? '', inspector: row.inspector?.name ?? row.inspector?.id ?? '', target: row.target?.dueAt ?? '' };
    });
    return { rows, ...(res.nextCursor ? { nextCursor: res.nextCursor } : {}) };
  }

  /** Deadline of the next seller response, for jobs and views */
  respondBy(agg: Agg) {
    return deadline(agg.ret.response_due_at, this.core.now());
  }

  /**
   * Customer data export hook (FORMAT.md): the customer's returns (their reason, description and remedy, items,
   * status, dates) and refunds (amount, destination, status, dates), with the photos they uploaded. Staff notes,
   * inspection details and internal reasons are left out.
   */
  async exportCustomerData(input: { customerId: string; accountId: string }): Promise<common.CustomerDataSection[]> {
    const ids = [...new Set([input.customerId, input.accountId].filter((v) => isUuid(v)))];
    const returns = ids.length ? await this.core.repo.find('returns', { customer_id: ids }, { orderBy: [['requested_at', 'asc']] }) : [];
    const returnIds = returns.map((r) => r.id);
    const [items, evidence, byReturn, byCustomer] = await Promise.all([
      returnIds.length ? this.core.repo.find('return_items', { return_id: returnIds }) : [],
      returnIds.length ? this.core.repo.find('return_evidence', { return_id: returnIds, party: 'customer' }) : [],
      returnIds.length ? this.core.repo.find('refund_requests', { return_id: returnIds }) : [],
      ids.length ? this.core.repo.find('refund_requests', { customer_id: ids }) : [],
    ]);
    const refunds = [...new Map([...byReturn, ...byCustomer].map((r) => [r.id, r])).values()].sort((a, b) => a.created_at.getTime() - b.created_at.getTime());
    const refOf = new Map(returns.map((r) => [r.id, r.ref]));
    const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
    const photos = [...returns.flatMap((r) => r.media_ids), ...evidence.flatMap((e) => e.media_ids)];
    return [
      {
        key: 'return_requests',
        title: 'Returns',
        module: 'returns',
        records: returns.map((r) => ({
          ref: r.ref,
          orderRef: r.order_ref,
          seller: r.terms_snapshot.meta.sellerName ?? null,
          status: r.status,
          reason: r.reason,
          description: r.details,
          remedy: r.remedy,
          items: items.filter((i) => i.return_id === r.id).map((i) => ({ title: i.title, sku: i.sku, quantity: i.quantity, unitPrice: money(i.unit_price, i.currency) })),
          evidence: evidence.filter((e) => e.return_id === r.id).map((e) => ({ kind: e.kind, note: e.note, addedAt: iso(e.added_at), files: e.media_ids.length })),
          requestedAt: iso(r.requested_at),
          receivedAt: iso(r.received_at),
          completedAt: iso(r.completed_at),
        })),
        attachmentIds: [...new Set(photos)],
      },
      {
        key: 'refunds',
        title: 'Refunds',
        module: 'returns',
        records: refunds.map((r) => ({
          ref: r.ref,
          returnRef: r.return_id ? (refOf.get(r.return_id) ?? null) : null,
          orderRef: r.order_ref,
          status: REFUND_LABEL[(r.status === 'declined' ? 'under_review' : r.status) as keyof typeof REFUND_LABEL] ?? r.status, // a declined request is being reworked: the customer sees Under review
          amount: money(r.total, r.currency),
          destination: r.destination_label,
          deductions: r.deductions.map((d) => ({ label: d.label, amount: d.amount, reason: d.reason })),
          requestedAt: iso(r.created_at),
          approvedAt: iso(r.approved_at),
          sentAt: iso(r.sent_at),
        })),
      },
    ];
  }
}
