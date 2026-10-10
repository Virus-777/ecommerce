/**
 * In-app inboxes: the customer's (store), a seller member's within the current seller (Seller Center)
 * and a staff member's, including notices received as a backup (Admin Center). Read state is per person.
 */
import { AppError, isNotImplemented } from '../../../kernel/errors/index.js';
import type { PageRequest } from '../../../kernel/lib/pagination.js';
import type { Page } from '../../../spec/common.js';
import type * as identity from '../../../spec/identity.js';
import type { InboxSummary, Notice, NoticeLink, RoutingInfo, RoutingRow, StaffInboxSummary } from '../../../spec/notifications.js';
import { roleName, TOPICS, topicDef, type Category } from '../domain/catalog.js';
import { deadlineOf, defaultGroups, defaultMemberChannel, effectiveGroups, formatDate, memberReceives, type MemberAccessLike } from '../domain/rules.js';
import type { InboxFilter, InboxOwner, InboxRow } from '../ports.js';
import { actorText, Core } from './core.js';

export interface InboxQuery {
  group?: string;
  unreadOnly?: boolean;
  actionRequired?: boolean;
  category?: Category;
  view?: 'all' | 'needs_my_action' | 'mentions';
}

/** Who is reading: the principal, and for seller members their access within the seller */
export interface Reader {
  principal: identity.Principal;
  sellerAccess?: (MemberAccessLike & { memberId?: string }) | null;
}

export class Inbox {
  constructor(private readonly core: Core) {}

  /** The inbox a principal owns; null for visitors and sessions without an account */
  async owner(r: Reader): Promise<InboxOwner | null> {
    const p = r.principal;
    if (!p.accountId) return null;
    if (p.kind === 'customer') return { kind: 'customer', accountId: p.accountId };
    if (p.kind === 'staff') return { kind: 'staff', accountId: p.accountId };
    if (p.kind === 'seller') {
      if (!p.sellerId) return null;
      const access = r.sellerAccess ?? (await this.core.memberAccess(p.sellerId, p.accountId));
      if (!access) return { kind: 'seller', sellerId: p.sellerId, accountId: p.accountId, topicKeys: [] };
      const pref = await this.rememberMember(p.sellerId, p.sellerMemberId ?? (r.sellerAccess as { memberId?: string } | null)?.memberId ?? p.accountId, p.accountId, access.isOwner);
      const groups = effectiveGroups(pref.groups as Record<string, unknown>, access.isOwner);
      return { kind: 'seller', sellerId: p.sellerId, accountId: p.accountId, topicKeys: TOPICS.filter((t) => memberReceives(t, access, groups)).map((t) => t.key) };
    }
    return null;
  }

  /** Stores a member's default preferences on their first visit (until then sellers.listMembers supplies them with defaults) */
  async rememberMember(sellerId: string, memberId: string, accountId: string, isOwner: boolean) {
    return this.core.repo.ensureMemberPreference({
      seller_id: sellerId,
      member_id: memberId,
      account_id: accountId,
      groups: defaultGroups(isOwner) as never,
      channel: defaultMemberChannel(isOwner),
      updated_by: actorText({ kind: 'system' }),
      updated_at: this.core.now(),
    });
  }

  #filter(q: InboxQuery): InboxFilter {
    const f: InboxFilter = {};
    if (q.group) f.group = q.group;
    if (q.unreadOnly) f.unreadOnly = true;
    if (q.actionRequired !== undefined) f.actionRequired = q.actionRequired;
    if (q.category) f.topicKeys = TOPICS.filter((t) => t.category === q.category).map((t) => t.key);
    if (q.view === 'needs_my_action') f.openActionOnly = true;
    if (q.view === 'mentions') f.mentionsOnly = true;
    return f;
  }

  async list(r: Reader, q: InboxQuery, page: PageRequest): Promise<Page<Notice>> {
    const owner = await this.owner(r);
    if (!owner) return { items: [], nextCursor: null, ...(page.mode === 'page' ? { page: page.page, totalPages: 1, total: 0 } : {}) };
    const res = await this.core.repo.listInbox(owner, this.#filter(r.principal.kind === 'staff' ? q : { ...q, view: undefined }), page);
    return { ...res, items: await this.toNotices(res.items, owner) };
  }

  async unreadCount(r: Reader): Promise<number> {
    const owner = await this.owner(r);
    if (!owner) return 0;
    return (await this.core.repo.inboxCounts(owner)).reduce((n, c) => n + c.unread, 0);
  }

  async summary(r: Reader): Promise<InboxSummary & Partial<StaffInboxSummary>> {
    const owner = await this.owner(r);
    if (!owner) return { unread: 0, byGroup: {}, total: 0, totalByGroup: {}, actionRequired: 0, needsAction: [] };
    const counts = await this.core.repo.inboxCounts(owner);
    const byGroup: Record<string, number> = {};
    const totalByGroup: Record<string, number> = {};
    for (const c of counts) {
      byGroup[c.group] = c.unread;
      totalByGroup[c.group] = c.total;
    }
    const open = await this.core.repo.inboxRows(owner, { openActionOnly: true }, 200);
    open.sort((a, b) => (a.deadline_at?.getTime() ?? Infinity) - (b.deadline_at?.getTime() ?? Infinity) || b.created_at.getTime() - a.created_at.getTime());
    const base: InboxSummary = {
      unread: counts.reduce((n, c) => n + c.unread, 0),
      byGroup,
      total: counts.reduce((n, c) => n + c.total, 0),
      totalByGroup,
      actionRequired: counts.reduce((n, c) => n + c.openActions, 0),
      needsAction: await this.toNotices(open.slice(0, 10), owner),
    };
    if (owner.kind !== 'staff') return base;
    const routing = await this.routingToday(owner.accountId);
    return { ...base, byArea: byGroup, needsMyAction: base.actionRequired, mentions: counts.reduce((n, c) => n + c.mentionsUnread, 0), ...routing };
  }

  async staffSummary(r: Reader): Promise<StaffInboxSummary> {
    const s = await this.summary(r);
    return { unread: s.unread, byArea: s.byArea ?? s.byGroup, needsMyAction: s.needsMyAction ?? s.actionRequired, mentions: s.mentions ?? 0, routingToday: s.routingToday ?? [], coveringNote: s.coveringNote ?? null };
  }

  /** Roles the person leads, backs up or covers today, from access (empty when access cannot answer) */
  async routingToday(accountId: string): Promise<{ routingToday: RoutingRow[]; coveringNote: string | null }> {
    const api = this.core.access;
    if (!api) return { routingToday: [], coveringNote: null };
    let coverage;
    try {
      coverage = await api.coverageNow({});
    } catch (err) {
      if (isNotImplemented(err)) return { routingToday: [], coveringNote: null };
      throw err;
    }
    const mine = coverage.filter((c) => c.lead?.accountId === accountId || c.backups.some((b) => b.accountId === accountId) || c.receivingNow.some((s) => s.accountId === accountId));
    const tz = this.core.timeZone;
    const rows: RoutingRow[] = mine.map((c) => ({
      roleKey: c.role.key,
      roleName: c.role.name,
      receivingNow: c.receivingNow.map((s) => s.name),
      lead: c.lead?.name ?? null,
      leadAway: Boolean(c.viaBackup || c.lead?.away),
      note: c.viaBackup ? `${c.lead?.name ?? 'The lead'} is away${c.leadAwayUntil ? ` until ${formatDate(c.leadAwayUntil, tz)}` : ''}; ${c.receivingNow.map((s) => s.name).join(', ')} receive${c.receivingNow.length === 1 ? 's' : ''} the notices` : null,
    }));
    const covering = mine.filter((c) => c.viaBackup && c.lead?.accountId !== accountId && c.receivingNow.some((s) => s.accountId === accountId));
    const coveringNote = covering.length ? covering.map((c) => `Backup ${c.role.name}${c.leadAwayUntil ? ` until ${formatDate(c.leadAwayUntil, tz)}` : ''}`).join('; ') : null;
    return { routingToday: rows, coveringNote };
  }

  async markRead(r: Reader, noticeId: string): Promise<Notice> {
    const owner = await this.owner(r);
    if (!owner) throw new AppError('NOT_FOUND', 'Notice not found');
    const row = await this.core.repo.getInboxNotice(owner, noticeId);
    if (!row) throw new AppError('NOT_FOUND', 'Notice not found');
    if (!row.read_at) await this.core.repo.markRead(owner, [noticeId], this.core.now());
    const after = (await this.core.repo.getInboxNotice(owner, noticeId)) ?? row;
    return (await this.toNotices([after], owner))[0]!;
  }

  async markAll(r: Reader, group?: string | null): Promise<{ updated: number }> {
    const owner = await this.owner(r);
    if (!owner) return { updated: 0 };
    return { updated: await this.core.repo.markRead(owner, 'all', this.core.now(), group ? { group } : {}) };
  }

  /** API shape of inbox rows (staff notices carry who they were routed to) */
  async toNotices(rows: InboxRow[], owner: InboxOwner): Promise<Notice[]> {
    const now = this.core.now();
    const staff = owner.kind === 'staff';
    const routed = staff ? rows.filter((n) => n.address_kind === 'role') : [];
    const recipients = routed.length ? await this.core.repo.recipientsOf(routed.map((n) => n.id)) : [];
    const names = recipients.length ? await this.core.accounts(recipients.map((x) => x.account_id)) : new Map<string, identity.AccountSummary>();
    return rows.map((n) => {
      const t = topicDef(n.topic_key);
      let routedTo: RoutingInfo | null = null;
      if (staff && n.address_kind === 'role') {
        routedTo = {
          roleKey: n.address_id,
          roleName: roleName(n.address_id),
          reason: (n.reason ?? 'member') as RoutingInfo['reason'],
          coveringFor: n.covering_for,
          recipients: recipients
            .filter((x) => x.notice_id === n.id)
            .map((x) => ({ staffId: x.account_id, name: names.get(x.account_id)?.displayName ?? 'Staff member', as: (x.reason === 'lead' || x.reason === 'backup' ? x.reason : 'member') as 'lead' | 'backup' | 'member' })),
        };
      }
      return {
        id: n.id,
        topicKey: n.topic_key,
        category: t?.category ?? 'essential',
        group: n.group_key,
        title: n.title,
        body: n.body,
        icon: n.icon,
        tone: n.tone as Notice['tone'],
        link: linkOf(n.link),
        createdAt: n.created_at.toISOString(),
        readAt: n.read_at?.toISOString() ?? null,
        actionRequired: n.action_required,
        deadline: deadlineOf(n.deadline_at, now),
        resolvedAt: n.resolved_at?.toISOString() ?? null,
        // action notices only: an expired one ("No longer needed") is never shown as resolved
        state: n.action_required ? (n.resolved_at ? 'resolved' : n.expired_at ? 'expired' : 'open') : null,
        expiredAt: n.expired_at?.toISOString() ?? null,
        routedTo,
      };
    });
  }
}

/** The public part of a stored link (link.subjects stays internal) */
export function linkOf(raw: unknown): NoticeLink {
  const l = (raw ?? {}) as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === 'string' && v ? v : null);
  return { kind: s(l.kind) ?? 'account', id: s(l.id) ?? '', ref: s(l.ref), label: s(l.label), screen: s(l.screen) ?? '', url: s(l.url) };
}
