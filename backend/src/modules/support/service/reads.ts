/**
 * Reads: contact options, the order problem form, lists for each area, queue KPIs, assignees, the public
 * API reads other modules and GraphQL use, and report exports.
 */
import { AppError } from '../../../kernel/errors/index.js';
import { dateInZone, zonedTimeToUtc } from '../../../kernel/lib/clock.js';
import { isUuid } from '../../../kernel/lib/ids.js';
import { toPageRequest, type PageRequest } from '../../../kernel/lib/pagination.js';
import type * as common from '../../../spec/common.js';
import type * as identity from '../../../spec/identity.js';
import type { AdminCaseDetail, AdminCaseRow, CaseAssignee, CaseStats, CaseSummary, CaseView, ContactOptions, ProblemContext, ProblemPackage, SellerCaseRow, SellerSupportOptions } from '../../../spec/support.js';
import { CLOSED_STATUSES, median, OFFICIAL_STORE_NAME, OPEN_STATUSES, TEAM_ROLES, type Area, type Team } from '../domain/rules.js';
import type { CaseFilter, CaseRec, CaseSort } from '../ports.js';
import type { Cases, Shopper } from './cases.js';
import { DAY, notFound, type Agg, type Core } from './core.js';
import type { Views } from './views.js';

export const ADMIN_DATASET = 'support.admin.cases';
const OPEN = OPEN_STATUSES as string[];
const CLOSED = CLOSED_STATUSES as string[];

export class Reads {
  #registered: Promise<void> | null = null;

  constructor(
    private readonly core: Core,
    private readonly views: Views,
    private readonly cases: Cases,
  ) {}

  page(p: common.PageInput | PageRequest | null | undefined): PageRequest {
    if (p && 'mode' in p) return p as PageRequest;
    return toPageRequest({ ...(p?.cursor ? { cursor: p.cursor } : {}), ...(p?.page ? { page: p.page } : {}), ...(p?.limit ? { limit: p.limit } : {}) });
  }

  /** A page of case rows with their aggregates */
  async aggPage(f: CaseFilter, sort: CaseSort, page: PageRequest): Promise<common.Page<Agg>> {
    const res = await this.core.repo.listCases(f, sort, page);
    const aggs = await this.core.loadMany(res.items.map((c) => c.id));
    return { ...res, items: res.items.map((c) => aggs.get(c.id)).filter((a): a is Agg => !!a) };
  }

  private async support() {
    return this.core.soft('settings', 'support hours', (s) => s.storeInfo());
  }

  /* ================================================================ store */

  async contactOptions(): Promise<ContactOptions> {
    const [cats, info, sellerDays] = await Promise.all([this.core.categories(), this.support(), this.core.setting('sellerReplyBusinessDays', 2)]);
    const topics = [...cats.values()].filter((c) => c.audience === 'customer' && c.active).map((c) => this.core.categoryView(c));
    const fastest = Math.min(...topics.map((t) => t.firstResponseBusinessHours), 24);
    const hours = info?.support.hoursLabel ?? 'Mon–Sat, 8 AM–8 PM PT';
    const openNow = info?.support.openNow ?? true;
    return {
      topics,
      channels: [
        { kind: 'messages', label: 'Message the seller', expectedResponse: `Within ${sellerDays} business days`, available: true, hours: 'Any time' },
        { kind: 'email', label: 'Email Marketly support', expectedResponse: fastest <= 8 ? `Within ${fastest} business hours` : 'Within 1 business day', available: true, hours: 'Any time; replies during support hours' },
        { kind: 'chat', label: 'Chat with Marketly', expectedResponse: openNow ? 'About 2 minutes' : 'When support opens', available: openNow, hours: info?.support.chatHoursLabel ?? hours },
        { kind: 'phone', label: 'Call Marketly', expectedResponse: openNow ? 'About 5 minutes' : 'When support opens', available: openNow, hours },
      ],
      hours,
      phone: info?.support.phone ?? '+1 800 555 0100',
      sellerFirstNote: `Marketplace items: the seller answers first, Marketly steps in after ${sellerDays} business days`,
    };
  }

  async problemContext(orderId: string, who: Shopper, orderItemId?: string | null): Promise<ProblemContext> {
    const order = await this.cases.shopperOrder(orderId, who);
    const sellerDays = await this.core.setting('sellerReplyBusinessDays', 2);
    const links = await this.core.repo.casesForItems(order.groups.flatMap((g) => g.items.map((i) => i.id)), true);
    const caseRows = links.length ? await this.core.repo.find('cases', { id: [...new Set(links.map((l) => l.caseId))] }) : [];
    const delivered = (s: string) => ['delivered', 'return_requested', 'returned', 'refunded'].includes(s);
    const packages: ProblemPackage[] = order.groups.map((g) => {
      const late = g.dispatchDeadline.state === 'overdue' && !g.items.some((i) => i.shipmentId);
      return {
        label: g.packageLabel,
        ownerType: g.seller.ownerType,
        sellerId: g.seller.ownerType === 'official' ? null : (g.seller.id ?? null),
        sellerName: g.seller.ownerType === 'official' ? OFFICIAL_STORE_NAME : g.seller.name,
        verified: g.seller.verified,
        status: g.statusLabel,
        items: g.items.map((i) => ({
          orderItemId: i.id,
          title: i.title,
          options: i.product.options ?? {},
          quantity: i.quantity,
          price: i.unitPrice,
          imageUrl: i.image?.url ?? i.product.imageUrl ?? null,
          ownerType: g.seller.ownerType,
          sellerId: g.seller.ownerType === 'official' ? null : (g.seller.id ?? null),
          sellerName: g.seller.ownerType === 'official' ? OFFICIAL_STORE_NAME : g.seller.name,
          packageLabel: g.packageLabel,
          itemStatus: i.stateLabel,
          estimate: g.estimateLabel,
        })),
        warning: late ? `Dispatch was due ${g.dispatchDeadline.dueAt.slice(0, 10)}; ${g.estimateLabel}` : (g.alert?.message ?? null),
      };
    });
    const allItems = order.groups.flatMap((g) => g.items.map((i) => ({ g, i })));
    const chosen = orderItemId ? allItems.find((x) => x.i.id === orderItemId) : undefined;
    if (orderItemId && !chosen) throw notFound('Order item');
    const g = chosen?.g ?? (order.groups.length === 1 ? order.groups[0] : undefined);
    const sellerFirst = g?.seller.ownerType === 'seller';
    const scope = chosen ? [chosen.i] : allItems.map((x) => x.i);
    const types = new Set<ProblemContext['problemTypes'][number]>();
    for (const i of scope) {
      if (delivered(i.state)) ['missing_item', 'damaged', 'wrong_item'].forEach((t) => types.add(t as never));
      else types.add('not_arrived');
    }
    types.add('other');
    const refundable = scope.reduce((s, i) => s + i.paidAmount.amount, 0);
    const notDelivered = scope.some((i) => !delivered(i.state) && i.state !== 'cancelled');
    return {
      order: { id: order.id, ref: order.ref, placedAt: order.placedAt },
      packages,
      preselectedItemIds: chosen ? [chosen.i.id] : [],
      problemTypes: [...types],
      handledFirstBy: sellerFirst
        ? { kind: 'seller', name: `${g!.seller.name} (seller)`, staff: null, team: null, supportFollowing: true }
        : g?.seller.ownerType === 'official'
          ? { kind: 'official_store', name: OFFICIAL_STORE_NAME, staff: null, team: 'Customer Support', supportFollowing: false }
          : { kind: 'marketplace_support', name: 'Marketly support', staff: null, team: 'Customer Support', supportFollowing: false },
      sellerReplyDueAt: sellerFirst ? (await this.core.addBusinessDays(this.core.now(), sellerDays)).toISOString() : null,
      marketlyStepsIn: sellerFirst
        ? [`If the seller hasn't replied within ${sellerDays} business days`, "If you don't agree with the seller's answer", 'If a promised refund is late', 'If the item is not shipped by its dispatch deadline']
        : ['Marketly support handles this package from the start'],
      openCases: caseRows.map((c) => ({ caseId: c.id, ref: c.ref, orderItemIds: links.filter((l) => l.caseId === c.id).map((l) => l.orderItemId) })),
      remedyChoices: [
        { kind: 'refund', label: 'Refund', description: 'Get your money back for the item', amount: { amount: refundable, currency: order.totals.total.currency } },
        ...(notDelivered ? [{ kind: 'keep_waiting' as const, label: 'Keep waiting', description: 'Wait for the package; we follow up with the seller' }] : []),
        { kind: 'replacement', label: 'Replacement', description: 'Get the same item again' },
        { kind: 'other', label: 'Something else', description: 'Tell us what would help' },
      ],
      otherItemsNote: allItems.length > scope.length ? 'Other items in this order are not affected unless you choose them' : null,
    };
  }

  storeFilter(who: Shopper, state: string | undefined): CaseFilter {
    const f: CaseFilter = { customerId: who.customerId ?? null, guestSessionId: who.guestSessionId ?? null, kinds: ['customer_help', 'order_problem', 'dispute'] };
    if (state === 'open') f.statuses = OPEN;
    else if (state === 'closed') f.statuses = CLOSED;
    return f;
  }

  async listMine(who: Shopper, state: string | undefined, page: PageRequest): Promise<common.Page<CaseSummary>> {
    if (!who.customerId && !who.guestSessionId) return { items: [], nextCursor: null, total: 0 };
    const res = await this.aggPage(this.storeFilter(who, state), 'updated', page);
    const x = await this.views.prepare(res.items, { orders: false });
    return { ...res, items: res.items.map((a) => this.views.summary(a, x)) };
  }

  /* ================================================================ seller */

  sellerFilter(sellerId: string, q: { scope?: string; state?: string; orderId?: string; open?: boolean }): CaseFilter {
    const f: CaseFilter = { sellerId };
    if (q.scope === 'customer_cases') f.kinds = ['customer_help', 'order_problem'];
    else if (q.scope === 'disputes') f.kinds = ['dispute'];
    else if (q.scope === 'support_requests') f.kinds = ['seller_request'];
    if (q.state === 'open' || q.open === true) f.statuses = OPEN;
    else if (q.state === 'closed' || q.open === false) f.statuses = CLOSED;
    if (q.orderId) f.orderId = q.orderId;
    return f;
  }

  async listForSeller(sellerId: string, q: { scope?: string; state?: string; orderId?: string; open?: boolean }, page: PageRequest): Promise<common.Page<SellerCaseRow>> {
    const res = await this.aggPage(this.sellerFilter(sellerId, q), 'updated', page);
    const x = await this.views.prepare(res.items, { orders: false });
    return { ...res, items: res.items.map((a) => this.views.sellerRow(a, x)) };
  }

  async sellerOptions(): Promise<SellerSupportOptions> {
    const [cats, info] = await Promise.all([this.core.categories(), this.support()]);
    return {
      categories: [...cats.values()].filter((c) => c.audience === 'seller' && c.active).map((c) => this.core.categoryView(c)),
      hoursLabel: info?.support.hoursLabel ?? 'Mon–Sat, 8 AM–8 PM PT',
      openNow: info?.support.openNow ?? true,
      nextOpenAt: info?.support.openNow ? null : (info?.support.nextOpenAt ?? null),
    };
  }

  /* ================================================================ admin */

  adminFilter(q: { tab?: string; q?: string; category?: string; priority?: string; kind?: string; customerId?: string; sellerId?: string; orderId?: string }, staffId: string | null): CaseFilter {
    const f: CaseFilter = {};
    const tab = q.tab ?? 'all_open';
    if (tab === 'closed') f.statuses = CLOSED;
    else f.statuses = OPEN;
    if (tab === 'mine') f.ownerId = staffId ?? '00000000-0000-0000-0000-000000000000';
    if (tab === 'unassigned') f.unassigned = true;
    if (tab === 'overdue') f.dueBefore = this.core.now();
    if (tab === 'disputes') f.kinds = ['dispute'];
    if (q.kind) f.kinds = f.kinds ? f.kinds.filter((k) => k === q.kind) : [q.kind];
    if (q.q?.trim()) f.q = q.q;
    if (q.category) f.category = q.category;
    if (q.priority) f.priority = q.priority;
    if (q.customerId) f.customerId = q.customerId;
    if (q.sellerId) f.sellerId = q.sellerId;
    if (q.orderId) f.orderId = q.orderId;
    return f;
  }

  async listAdmin(q: Parameters<Reads['adminFilter']>[0] & { sort?: string }, staffId: string | null, page: PageRequest): Promise<common.Page<AdminCaseRow>> {
    const sort: CaseSort = q.sort === 'newest' ? 'newest' : q.sort === 'priority' ? 'priority' : q.tab === 'closed' ? 'updated' : 'next_deadline';
    const res = await this.aggPage(this.adminFilter(q, staffId), sort, page);
    const x = await this.views.prepare(res.items, { orders: false });
    return { ...res, items: res.items.map((a) => this.views.adminRow(a, x)) };
  }

  async stats(): Promise<CaseStats> {
    const now = this.core.now();
    const today = zonedTimeToUtc(dateInZone(now, this.core.tz), '00:00', this.core.tz);
    const [open, openedToday, pastTarget, unassigned, openDisputes, oldest, cats] = await Promise.all([
      this.core.repo.countCases({ statuses: OPEN }),
      this.core.repo.countCases({ openedFrom: today }),
      this.core.repo.countCases({ statuses: OPEN, dueBefore: now }),
      this.core.repo.countCases({ statuses: OPEN, unassigned: true, handler: 'marketplace_support' }),
      this.core.repo.countCases({ statuses: OPEN, kinds: ['dispute'] }),
      this.core.repo.listCases({ statuses: OPEN, dueBefore: now }, 'next_deadline', { mode: 'page', page: 1, limit: 1 }),
      this.core.categories(),
    ]);
    const replies = async (from: Date, to: Date) => {
      const rows = await this.core.repo.find('cases', { first_replied_at: { op: '>=', value: from } });
      return rows.filter((r) => r.first_replied_at! < to && r.handler_kind !== 'seller').map((r) => (r.first_replied_at!.getTime() - r.opened_at.getTime()) / 60_000);
    };
    const [current, previous] = await Promise.all([replies(new Date(now.getTime() - 30 * DAY), now), replies(new Date(now.getTime() - 60 * DAY), new Date(now.getTime() - 30 * DAY))]);
    const med = median(current);
    const access = this.core.ctx.use('access');
    const recipients = await this.core.quiet('queue owner', () => access.resolveRecipients('customer_support_manager'));
    const names = await this.core.staffNames([recipients?.leadAccountId, ...(recipients?.viaBackup ? recipients.accountIds : [])]);
    const customerCats = [...cats.values()].filter((c) => c.audience === 'customer' && c.active);
    const firstTarget = customerCats.length ? Math.min(...customerCats.map((c) => c.first_response_business_hours)) : await this.core.setting('firstResponseBusinessHours', 4);
    const disputeDays = await this.core.setting('disputeDecisionBusinessDays', 5);
    const oldestDue = oldest.items[0]?.next_response_due_at;
    return {
      open,
      openedToday,
      pastTarget,
      oldestOverdueMinutes: oldestDue ? Math.round((now.getTime() - oldestDue.getTime()) / 60_000) : null,
      unassigned,
      openDisputes,
      medianFirstReplyMinutes: med,
      medianFirstReplyChangeMinutes: previous.length && current.length ? med - median(previous) : null,
      targets: `First reply within ${firstTarget} business hours, dispute decision within ${disputeDays} business days`,
      queueOwner: {
        lead: recipients?.leadAccountId ? (names.get(recipients.leadAccountId) ?? null) : null,
        backup: recipients?.viaBackup ? (recipients.accountIds.map((id) => names.get(id)).find((n) => !!n) ?? null) : null,
        escalation: recipients?.escalationRoleKey ? recipients.escalationRoleKey.replace(/_/g, ' ') : null,
      },
    };
  }

  /**
   * Staff holding support.cases.handle (access.staffWithPermission, not a fixed list of roles), each with the
   * team of the support role they hold (customer support when none), filtered by team and name.
   */
  async assignees(q: { team?: string; q?: string }): Promise<CaseAssignee[]> {
    const access = this.core.ctx.use('access');
    const handlers = (await this.core.quiet('case handlers', () => access.staffWithPermission('support.cases.handle'))) ?? [];
    const teamOf = new Map<string, Team>();
    for (const team of Object.keys(TEAM_ROLES) as Team[]) {
      for (const role of TEAM_ROLES[team]) {
        for (const m of (await this.core.quiet('role members', () => access.membersOfRole(role))) ?? []) if (!teamOf.has(m.accountId)) teamOf.set(m.accountId, team);
      }
    }
    const out = new Map<string, CaseAssignee>();
    for (const m of handlers) {
      if (out.has(m.accountId)) continue;
      const team = teamOf.get(m.accountId) ?? 'customer_support';
      if (q.team && team !== q.team) continue;
      out.set(m.accountId, { staffId: m.accountId, name: m.name, team, role: m.roleLabel ?? 'Staff', openCases: 0, overdueCases: 0, away: m.away, awayUntil: null });
    }
    const term = q.q?.trim().toLowerCase();
    const list = [...out.values()].filter((a) => !term || a.name.toLowerCase().includes(term));
    const load = await this.core.repo.openPerOwner(
      list.map((a) => a.staffId),
      this.core.now(),
    );
    for (const a of list) {
      a.openCases = load.get(a.staffId)?.open ?? 0;
      a.overdueCases = load.get(a.staffId)?.overdue ?? 0;
    }
    return list.sort((a, b) => Number(a.away) - Number(b.away) || a.openCases - b.openCases || a.name.localeCompare(b.name));
  }

  /* ================================================================ public API reads */

  /** Customers-module ids with a case that is not resolved or closed (only the given ids when ids is set) */
  async customerIdsWithOpenCases(filter: { ids?: string[] }): Promise<string[]> {
    const ids = filter?.ids ? [...new Set(filter.ids.filter(isUuid))] : undefined;
    if (ids && !ids.length) return [];
    const rows = await this.core.repo.find('cases', { status: { op: 'not in', value: CLOSED }, ...(ids ? { customer_id: ids } : { customer_id: { op: 'is not', value: null } }) });
    return [...new Set(rows.map((r) => r.customer_id).filter((x): x is string => !!x && isUuid(x)))];
  }

  async casesForOrder(orderId: string): Promise<{ caseId: string; ref: string; status: string; orderItemIds: string[] }[]> {
    if (!isUuid(orderId)) return [];
    const rows = await this.core.repo.find('cases', { order_id: orderId }, { orderBy: [['opened_at', 'desc']] });
    if (!rows.length) return [];
    const items = await this.core.repo.find('case_items', { case_id: rows.map((r) => r.id) });
    return rows.map((r) => ({ caseId: r.id, ref: r.ref, status: r.status, orderItemIds: items.filter((i) => i.case_id === r.id).map((i) => i.order_item_id) }));
  }

  async sellerCaseStats(sellerId: string, range: common.DateRange): Promise<{ open: number; unresolved: number; decidedAgainstSeller: number; medianReplyMinutes: number }> {
    const from = zonedTimeToUtc(range.from, '00:00', this.core.tz);
    const to = new Date(zonedTimeToUtc(range.to, '00:00', this.core.tz).getTime() + DAY);
    const kinds = ['customer_help', 'order_problem', 'dispute'];
    const [open, rows] = await Promise.all([this.core.repo.countCases({ sellerId, kinds, statuses: OPEN }), this.core.repo.find('cases', { seller_id: sellerId, opened_at: { op: '>=', value: from } })]);
    const inRange = rows.filter((r) => r.opened_at < to && kinds.includes(r.kind));
    const decided = await this.core.repo.find('cases', { seller_id: sellerId, decision: { op: 'is not', value: null } });
    const against = decided.filter((c) => c.decision && ['customer_favored', 'shared'].includes(c.decision.outcome) && c.decision.decidedAt >= from.toISOString() && c.decision.decidedAt < to.toISOString());
    const replies = inRange.filter((r) => r.facts.sellerRepliedAt).map((r) => (new Date(r.facts.sellerRepliedAt!).getTime() - r.opened_at.getTime()) / 60_000);
    return { open, unresolved: inRange.filter((r) => !CLOSED.includes(r.status)).length, decidedAgainstSeller: against.length, medianReplyMinutes: median(replies) };
  }

  async listOpenForCustomer(customerId: string, limit: number): Promise<{ items: CaseSummary[]; total: number }> {
    const f = this.storeFilter({ customerId }, 'open');
    const [res, total] = await Promise.all([this.aggPage(f, 'updated', { mode: 'cursor', cursor: null, limit: Math.min(Math.max(limit || 3, 1), 50) }), this.core.repo.countCases(f)]);
    const x = await this.views.prepare(res.items, { orders: false });
    return { items: res.items.map((a) => this.views.summary(a, x)), total };
  }

  async listForCustomer(customerId: string, filter: { open?: boolean }, page: common.PageInput | PageRequest): Promise<common.Page<CaseSummary>> {
    return this.listMine({ customerId }, filter.open === true ? 'open' : filter.open === false ? 'closed' : 'all', this.page(page));
  }

  /**
   * Open and recent cases on one order the viewer may see: staff all, a seller the cases about its items, a
   * customer their own, a guest session the cases it opened or of guest orders identity granted it (core.canSee).
   * A store viewer with neither a customer id nor a guest session sees none.
   */
  async listForOrder(orderId: string, viewer: { area: Area; customerId?: string; guestSessionId?: string; sellerId?: string }): Promise<Agg[]> {
    if (!isUuid(orderId)) return [];
    if (viewer.area === 'store' && !viewer.customerId && !viewer.guestSessionId) return [];
    const rows = await this.core.repo.find('cases', { order_id: orderId }, { orderBy: [['opened_at', 'desc']] });
    const recent = new Date(this.core.now().getTime() - 180 * DAY);
    const v = viewer.area === 'admin' ? { area: 'admin' as const } : viewer.area === 'seller' ? { area: 'seller' as const, sellerId: viewer.sellerId ?? '' } : { area: 'store' as const, customerId: viewer.customerId ?? null, guestSessionId: viewer.customerId ? null : (viewer.guestSessionId ?? null) };
    const visible: CaseRec[] = [];
    for (const c of rows) {
      if (c.status === 'closed' && c.closed_at && c.closed_at < recent) continue;
      if (viewer.area === 'seller' && !viewer.sellerId) continue;
      if (await this.core.canSee(c, v)) visible.push(c);
    }
    const aggs = await this.core.loadMany(visible.map((c) => c.id));
    return visible.map((c) => aggs.get(c.id)!).filter(Boolean);
  }

  /**
   * Customer data export hook (customers.build-data-exports): the customer's cases with the messages they can see
   * (no internal notes, no seller-only or staff-only messages; staff shown as Marketly support), what they asked
   * for, the decision and remedies. attachmentIds are the files the customer attached.
   */
  async exportCustomerData(input: { customerId: string; accountId: string }): Promise<common.CustomerDataSection[]> {
    if (!isUuid(input.customerId)) return [];
    const rows = await this.core.repo.find('cases', { customer_id: input.customerId, kind: ['customer_help', 'order_problem', 'dispute'] }, { orderBy: [['opened_at', 'asc'], ['id', 'asc']] });
    const records: unknown[] = [];
    const attachmentIds = new Set<string>();
    for (let i = 0; i < rows.length; i += 50) {
      const chunk = rows.slice(i, i + 50);
      const aggs = await this.core.loadMany(chunk.map((c) => c.id));
      const list = chunk.map((c) => aggs.get(c.id)).filter((a): a is Agg => !!a);
      const x = await this.views.prepare(list, { orders: false });
      for (const a of list) {
        const v = this.views.caseView(a, 'store', x);
        const own = (m: Agg['messages'][number]) => m.role === 'customer' && (m.author_kind === 'customer' || m.author_kind === 'visitor');
        for (const m of a.messages) if (own(m) && (m.audience === 'all' || m.audience === 'customer')) m.media_ids.forEach((id) => attachmentIds.add(id));
        records.push({
          ref: a.c.ref,
          kind: a.c.kind,
          topic: v.category.label,
          subject: a.c.subject,
          orderRef: v.order?.ref || null,
          returnRef: v.returnRef ?? null,
          items: v.items.map((it) => ({ title: it.title, quantity: it.quantity, seller: it.sellerName })),
          problemType: a.c.facts.problemType ?? null,
          askedFor: a.c.facts.desiredRemedy ?? null,
          replyChannel: a.c.reply_channel,
          callbackPhone: a.c.facts.callbackPhone ?? null,
          status: v.statusLabel,
          openedAt: v.openedAt,
          resolvedAt: a.c.resolved_at?.toISOString() ?? null,
          closedAt: a.c.closed_at?.toISOString() ?? null,
          decision: v.decision ? { outcome: v.decision.outcome, reason: v.decision.reason, decidedAt: v.decision.decidedAt, final: v.decision.final } : null,
          remedies: v.remedies.map((r) => ({ kind: r.kind, amount: r.amount, status: r.statusLabel })),
          appeal: v.appeal ? { reason: v.appeal.reason, submittedAt: v.appeal.submittedAt, status: v.appeal.status, outcome: v.appeal.outcome ?? null } : null,
          messages: v.messages.map((m) => {
            const rec = a.messages.find((r) => r.id === m.id);
            const mine = !!rec && own(rec);
            return { at: m.at, from: mine ? 'You' : m.role === 'system' ? 'Marketly' : m.authorLabel, text: m.body, attachments: m.attachments.length };
          }),
        });
      }
    }
    return [{ key: 'support-cases', title: 'Help cases', module: 'support', records, attachmentIds: [...attachmentIds] }];
  }

  async casesForReturns(returnIds: string[], viewer: { area: Area; customerId?: string; guestSessionId?: string; sellerId?: string }): Promise<Record<string, CaseView | AdminCaseDetail | null>> {
    const ids = [...new Set(returnIds.filter(isUuid))];
    const out: Record<string, CaseView | AdminCaseDetail | null> = Object.fromEntries(returnIds.map((id) => [id, null]));
    if (!ids.length) return out;
    const rows = await this.core.repo.find('cases', { return_id: ids }, { orderBy: [['opened_at', 'asc']] });
    const aggs = await this.core.loadMany(rows.map((r) => r.id));
    const v = viewer.area === 'admin' ? { area: 'admin' as const } : viewer.area === 'seller' ? { area: 'seller' as const, sellerId: viewer.sellerId ?? '' } : { area: 'store' as const, customerId: viewer.customerId ?? null, guestSessionId: viewer.guestSessionId ?? null };
    const visible: Agg[] = [];
    for (const r of rows) if (await this.core.canSee(r, v)) visible.push(aggs.get(r.id)!);
    const x = await this.views.prepare(visible);
    for (const a of visible) out[a.c.return_id!] = viewer.area === 'admin' ? await this.views.adminDetail(a, x) : this.views.caseView(a, viewer.area, x);
    return out;
  }

  async countOpenForProducts(productIds: string[]): Promise<Record<string, number>> {
    const counts = await this.core.repo.openCasesPerProduct([...new Set(productIds)]);
    return Object.fromEntries(productIds.map((id) => [id, counts.get(id) ?? 0]));
  }

  /* ================================================================ exports */

  registerDatasets(): Promise<void> {
    const api = this.core.ctx.tryUse('reports');
    if (!api) return Promise.resolve();
    this.#registered ??= api
      .registerDataset({
        key: ADMIN_DATASET,
        owner: 'support',
        title: 'Support cases',
        permission: 'support.cases.view',
        audience: 'staff',
        screens: ['admin/cases'],
        available: true,
        phase: 1,
        columns: [
          { key: 'ref', label: 'Case' },
          { key: 'kind', label: 'Kind' },
          { key: 'category', label: 'Category' },
          { key: 'priority', label: 'Priority' },
          { key: 'status', label: 'Status' },
          { key: 'customer', label: 'Customer' },
          { key: 'seller', label: 'Seller' },
          { key: 'owner', label: 'Owner' },
          { key: 'orderRef', label: 'Order' },
          { key: 'openedAt', label: 'Opened at' },
          { key: 'nextResponseDueAt', label: 'Next response due' },
          { key: 'resolvedAt', label: 'Resolved at' },
        ],
      })
      .catch((err) => {
        this.#registered = null;
        this.core.ctx.log.warn({ err }, 'support: export dataset not registered; retried on first export');
      });
    return this.#registered;
  }

  async exportRows(dataset: string, filters: unknown, principal: identity.Principal, cursor?: string): Promise<{ rows: unknown[]; nextCursor?: string }> {
    if (dataset !== ADMIN_DATASET) throw notFound('Dataset');
    if (principal.kind !== 'staff') throw new AppError('FORBIDDEN', 'Staff only');
    const f = (filters && typeof filters === 'object' ? filters : {}) as Record<string, unknown>;
    const str = (k: string) => (typeof f[k] === 'string' ? (f[k] as string) : undefined);
    const filter = this.adminFilter({ tab: str('tab'), q: str('q'), category: str('category'), priority: str('priority'), kind: str('kind'), customerId: str('customerId'), sellerId: str('sellerId'), orderId: str('orderId') }, principal.accountId ?? null);
    const ids = Array.isArray(f.caseIds) ? (f.caseIds as unknown[]).filter(isUuid) : null;
    const res = await this.aggPage(ids ? { ...filter, ids } : filter, 'next_deadline', { mode: 'cursor', cursor: cursor ?? null, limit: 100 });
    const x = await this.views.prepare(res.items, { orders: false });
    const rows = res.items.map((a) => {
      const row = this.views.adminRow(a, x);
      return {
        ref: row.ref,
        kind: row.kind,
        category: row.category,
        priority: row.priority,
        status: row.statusLabel,
        customer: row.customerName ?? '',
        seller: row.sellerName ?? '',
        owner: row.owner?.name ?? row.owner?.id ?? '',
        orderRef: row.orderRef ?? '',
        openedAt: a.c.opened_at.toISOString(),
        nextResponseDueAt: a.c.next_response_due_at?.toISOString() ?? '',
        resolvedAt: a.c.resolved_at?.toISOString() ?? '',
      };
    });
    return { rows, ...(res.nextCursor ? { nextCursor: res.nextCursor } : {}) };
  }
}
