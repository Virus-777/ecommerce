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
import type { AdminCaseDetail, AdminCaseRow, CaseAssignee, CaseStats, CaseSummary, CaseView, ContactChannel, ContactOptions, DailyCaseStats, ProblemContext, ProblemPackage, SellerCaseRow, SellerSupportOptions } from '../../../spec/support.js';
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
    return {
      topics,
      channels: await this.contactChannels('customer'),
      hours: info?.support.hoursLabel ?? 'Mon–Sat, 8 AM–8 PM PT',
      phone: info?.support.phone ?? '+1 800 555 0100',
      sellerFirstNote: `Marketplace items: the seller answers first, Marketly steps in after ${sellerDays} business days`,
    };
  }

  /**
   * The contact channels (single source: GET /contact-options and content's Help Center read them). Live chat is
   * not offered (decision G7).
   */
  async contactChannels(audience: 'customer' | 'seller'): Promise<ContactChannel[]> {
    const [cats, info, sellerDays] = await Promise.all([this.core.categories(), this.support(), this.core.setting('sellerReplyBusinessDays', 2)]);
    const hours = info?.support.hoursLabel ?? 'Mon–Sat, 8 AM–8 PM PT';
    const openNow = info?.support.openNow ?? true;
    const phone = info?.support.phone?.trim() || '+1 800 555 0100';
    const fastest = Math.min(...[...cats.values()].filter((c) => c.audience === audience && c.active).map((c) => c.first_response_business_hours), 24);
    const reply = fastest <= 8 ? `Within ${fastest} business hours` : 'Within 1 business day';
    const channels: ContactChannel[] = [];
    if (audience === 'customer') {
      channels.push({
        kind: 'messages',
        label: 'Message the seller',
        expectedResponse: `Within ${sellerDays} business days`,
        available: true,
        hours: 'Any time',
        detail: 'For marketplace items the seller answers first',
        action: { label: 'Go to my messages', url: '/account/messages', kind: 'help' },
      });
    }
    channels.push({
      kind: 'email',
      label: audience === 'seller' ? 'Contact seller support' : 'Email Marketly support',
      expectedResponse: reply,
      available: true,
      hours: 'Any time; replies during support hours',
      detail: `We reply ${reply.charAt(0).toLowerCase()}${reply.slice(1)}`,
      action: { label: 'Write to us', url: audience === 'seller' ? '/seller/help/contact' : '/help/contact', kind: 'help' },
    });
    channels.push({
      kind: 'phone',
      label: 'Call Marketly',
      expectedResponse: openNow ? 'About 5 minutes' : 'When support opens',
      available: openNow,
      hours,
      detail: phone,
      action: { label: phone, url: `tel:${phone.replace(/[^\d+]/g, '')}`, kind: 'external' },
    });
    return channels;
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
    // first replies of the last 60 days, read once: the last 30 days against the 30 before
    const monthAgo = new Date(now.getTime() - 30 * DAY);
    const replied = await this.core.repo.find('cases', { first_replied_at: { op: '>=', value: new Date(now.getTime() - 60 * DAY) } });
    const replies = (from: Date, to: Date) => replied.filter((r) => r.first_replied_at! >= from && r.first_replied_at! < to && r.handler_kind !== 'seller').map((r) => (r.first_replied_at!.getTime() - r.opened_at.getTime()) / 60_000);
    const current = replies(monthAgo, now);
    const previous = replies(new Date(now.getTime() - 60 * DAY), monthAgo);
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
    const teamRoles = (Object.keys(TEAM_ROLES) as Team[]).flatMap((team) => TEAM_ROLES[team].map((role) => ({ team, role })));
    const members = await Promise.all(teamRoles.map(({ role }) => this.core.quiet('role members', () => access.membersOfRole(role))));
    // the first team (in TEAM_ROLES order) a member holds a role of
    const teamOf = new Map<string, Team>();
    teamRoles.forEach(({ team }, n) => {
      for (const m of members[n] ?? []) if (!teamOf.has(m.accountId)) teamOf.set(m.accountId, team);
    });
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
    const itemsOf = new Map<string, string[]>();
    for (const i of items) {
      const list = itemsOf.get(i.case_id);
      if (list) list.push(i.order_item_id);
      else itemsOf.set(i.case_id, [i.order_item_id]);
    }
    return rows.map((r) => ({ caseId: r.id, ref: r.ref, status: r.status, orderItemIds: itemsOf.get(r.id) ?? [] }));
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

  /** Cases opened per market day, seller and category, with first-reply figures (reports: Complaint patterns, Response time) */
  async caseStatsByDay(range: common.DateRange, sellerId?: string): Promise<DailyCaseStats[]> {
    const day = /^\d{4}-\d{2}-\d{2}$/;
    if (!day.test(range?.from ?? '') || !day.test(range?.to ?? '') || range.from > range.to) {
      throw new AppError('VALIDATION_FAILED', 'A date range: from on or before to', { issues: [{ path: 'range', message: 'Dates are YYYY-MM-DD, from on or before to' }] });
    }
    const tz = this.core.tz;
    const from = zonedTimeToUtc(range.from, '00:00', tz);
    const to = new Date(zonedTimeToUtc(range.to, '00:00', tz).getTime() + DAY);
    const [rows, categories] = await Promise.all([
      this.core.repo.find('cases', { opened_at: { op: '>=', value: from }, ...(sellerId ? { seller_id: sellerId } : {}) }),
      this.core.categories(),
    ]);
    const minutes = (a: Date, b: Date) => Math.max(0, Math.round((b.getTime() - a.getTime()) / 60_000));
    const out = new Map<string, DailyCaseStats>();
    for (const r of rows) {
      if (r.opened_at >= to) continue;
      const date = dateInZone(r.opened_at, tz);
      const key = `${date}|${r.seller_id ?? ''}|${r.category_key}`;
      let v = out.get(key);
      if (!v) {
        const cat = categories.get(r.category_key);
        const view = cat ? this.core.categoryView(cat) : null;
        v = {
          date,
          sellerId: r.seller_id ?? null,
          categoryKey: r.category_key,
          categoryLabel: view?.label ?? r.category_key,
          group: view?.group ?? 'other',
          audience: view?.audience ?? (r.kind === 'seller_request' ? 'seller' : 'customer'),
          opened: 0,
          firstReplied: 0,
          firstReplyMinutesTotal: 0,
          firstReplyWithinTarget: 0,
          sellerReplied: 0,
          sellerReplyMinutesTotal: 0,
        };
        out.set(key, v);
      }
      v.opened += 1;
      if (r.first_replied_at) {
        v.firstReplied += 1;
        v.firstReplyMinutesTotal += minutes(r.opened_at, r.first_replied_at);
        if (!r.first_response_due_at || r.first_replied_at <= r.first_response_due_at) v.firstReplyWithinTarget += 1;
      }
      const sellerAt = r.facts.sellerRepliedAt ? new Date(r.facts.sellerRepliedAt) : null;
      if (sellerAt && !Number.isNaN(sellerAt.getTime())) {
        v.sellerReplied += 1;
        v.sellerReplyMinutesTotal += minutes(r.opened_at, sellerAt);
      }
    }
    return [...out.values()].sort((a, b) => a.date.localeCompare(b.date) || (a.sellerId ?? '').localeCompare(b.sellerId ?? '') || a.categoryKey.localeCompare(b.categoryKey));
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
    const candidates = viewer.area === 'seller' && !viewer.sellerId ? [] : rows.filter((c) => !(c.status === 'closed' && c.closed_at && c.closed_at < recent));
    const seen = await Promise.all(candidates.map((c) => this.core.canSee(c, v)));
    const visible: CaseRec[] = candidates.filter((_, n) => seen[n]);
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
    const seen = await Promise.all(rows.map((r) => this.core.canSee(r, v)));
    const visible = rows.filter((_, n) => seen[n]).map((r) => aggs.get(r.id)!);
    const x = await this.views.prepare(visible);
    const views = await Promise.all(visible.map((a) => (viewer.area === 'admin' ? this.views.adminDetail(a, x) : this.views.caseView(a, viewer.area, x))));
    // oldest first: a later case of the same return replaces an earlier one
    for (const [n, a] of visible.entries()) out[a.c.return_id!] = views[n]!;
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
