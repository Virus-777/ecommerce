/**
 * Runs the routing table (domain/routing.ts) for consumed events: resolves recipients that the
 * event does not name (earlier notices about the same order, return or case), realm-specific
 * topics, guest order links, and the side effects some events have (consent cache, closed accounts,
 * staff re-routing, reminders). Consumers are idempotent through dedupe keys and never fail for
 * records they don't know (they log and return).
 */
import { isNotImplemented } from '../../../kernel/errors/index.js';
import type { EventName, EventPayload } from '../../../kernel/events/index.js';
import { format } from '../../../kernel/lib/money.js';
import type { NotifyInput } from '../../../spec/notifications.js';
import { TOPICS } from '../domain/catalog.js';
import { ROUTES, type EventRoute, type Fmt, type RouteSend, type RouteTarget, type Routes, type SubjectKey, type Target } from '../domain/routing.js';
import { formatDate } from '../domain/rules.js';
import { Core } from './core.js';
import type { Sender } from './sender.js';

const SUBJECT_KEYS: SubjectKey[] = ['orderId', 'returnId', 'caseId', 'conversationId', 'groupId'];
const REF_FIELDS: [string, string][] = [
  ['order', 'orderRef'],
  ['return', 'returnRef'],
  ['case', 'caseRef'],
];

export type Scheduler = (input: NotifyInput, sendAt: string, createdBy: string) => Promise<string>;

export class Consumers {
  readonly fmt: Fmt;

  constructor(
    private readonly core: Core,
    private readonly sender: Sender,
    private readonly schedule: Scheduler,
  ) {
    const tz = () => core.timeZone;
    this.fmt = {
      money: (m) => (m ? format(m) : ''),
      date: (iso) => formatDate(iso, tz()),
      dateTime: (iso) => formatDate(iso, tz(), true),
      human: (code) => (code ?? '').replace(/[_.-]+/g, ' ').trim(),
      until: (iso) => {
        if (!iso) return 'a few minutes';
        const mins = Math.max(1, Math.round((new Date(iso).getTime() - core.now().getTime()) / 60_000));
        return mins >= 120 ? `${Math.round(mins / 60)} hours` : `${mins} minute${mins === 1 ? '' : 's'}`;
      },
    };
  }

  async handle<N extends keyof Routes>(name: N, payload: EventPayload<N & EventName>): Promise<void> {
    const route = ROUTES[name] as unknown as EventRoute<typeof payload>;
    const now = this.core.now();
    for (const key of route.resolve?.(payload) ?? []) if (key) await this.core.repo.resolveNotices(key, null, now);
    for (const key of route.cancel?.(payload) ?? []) if (key) await this.core.repo.cancelScheduled(key);
    const sends = (route.sends?.(payload, this.fmt) ?? []).filter((s): s is RouteSend => Boolean(s));
    for (const s of sends) await this.run(name, s);
    for (const e of route.effects ?? []) await this.#effect(e, payload as never);
  }

  async run(event: string, send: RouteSend): Promise<void> {
    const core = this.core;
    const repo = core.repo;
    let topic: string;
    let realm: 'member' | 'staff' = 'member';
    if (typeof send.topic === 'string') topic = send.topic;
    else {
      const acct = await core.account(send.topic.realmOf);
      realm = acct?.realm === 'staff' ? 'staff' : 'member';
      topic = realm === 'staff' ? send.topic.staff : send.topic.member;
    }

    if (send.skipIfRecent) {
      const recent = await repo.latestNotice({ topicKey: send.skipIfRecent.topic, subject: { key: send.skipIfRecent.key, value: send.skipIfRecent.value } });
      const window = Number(await core.setting('dedupeWindowMinutes')) * 60_000;
      if (recent && core.now().getTime() - recent.created_at.getTime() < window) return;
    }

    const subjects: Record<string, string> = {};
    for (const [k, v] of Object.entries(send.subjects ?? {})) if (typeof v === 'string' && v) subjects[k] = v;
    const context: Record<string, unknown> = structuredClone(send.context ?? {});
    for (const [field, key] of REF_FIELDS) {
      const ref = (context[field] as { ref?: unknown } | undefined)?.ref;
      if (typeof ref === 'string' && ref) subjects[key] = ref;
    }
    for (const k of SUBJECT_KEYS) {
      if (!subjects[k]) continue;
      const known = await repo.subjectsWith(k, subjects[k]!);
      for (const [kk, vv] of Object.entries(known)) subjects[kk] ??= vv;
    }

    const targets: Target[] = [];
    for (const t of send.to) {
      if (!t) continue;
      targets.push(...(await this.#target(t, realm, subjects)));
    }
    if (!targets.length) {
      core.log.debug({ event, topic }, 'no recipient known for this notice; skipped');
      return;
    }

    for (const [field, key] of REF_FIELDS) {
      if (!subjects[key]) continue;
      const obj = (context[field] ??= {}) as Record<string, unknown>;
      obj.ref ??= subjects[key];
    }
    const link = { ...send.link };
    if (!link.ref) {
      const ref = link.kind === 'order' ? subjects.orderRef : link.kind === 'return' ? subjects.returnRef : link.kind === 'case' ? subjects.caseRef : undefined;
      if (ref) link.ref = ref;
    }
    if (send.guestOrderLink) {
      try {
        const { url } = await core.identity.issueOrderLink(send.guestOrderLink.orderId, send.guestOrderLink.email);
        link.url = url;
        context.guest = { url };
      } catch (err) {
        if (!isNotImplemented(err)) throw err;
        core.log.debug('identity.issueOrderLink is not available; guest email links to the order lookup');
      }
    }

    await this.sender.send({
      topic,
      targets,
      link,
      context,
      subjects,
      dedupeKey: send.dedupe,
      actionRequired: send.actionRequired,
      deadline: send.deadline ?? null,
      sellerId: send.sellerId ?? null,
      group: send.group,
      replyTo: send.replyTo ?? null,
    });
  }

  async #target(t: RouteTarget, realm: 'member' | 'staff', subjects: Record<string, string>): Promise<Target[]> {
    const core = this.core;
    switch (t.kind) {
      case 'subject': {
        if (!t.value) return [];
        let found = await core.repo.addresseeOf(t.audience, t.key, t.value);
        for (const k of SUBJECT_KEYS) {
          if (found) break;
          if (k !== t.key && subjects[k]) found = await core.repo.addresseeOf(t.audience, k, subjects[k]!);
        }
        if (!found) return [];
        for (const [k, v] of Object.entries(found.subjects)) subjects[k] ??= v;
        if (t.audience === 'customer') return [{ kind: 'customer', accountId: found.addressId }];
        const sellerId = found.sellerId ?? found.addressId.split('/')[0]!;
        return [{ kind: 'seller', sellerId }];
      }
      case 'account':
        return [realm === 'staff' ? { kind: 'staff', accountId: t.accountId } : { kind: 'customer', accountId: t.accountId }];
      case 'account_email': {
        const acct = await core.account(t.accountId);
        return acct?.email ? [{ kind: 'email', email: acct.email, accountId: t.accountId, recipientKind: t.recipientKind }] : [];
      }
      case 'all_sellers':
        return this.#allSellers();
      case 'email':
        return [{ ...t, recipientKind: t.recipientKind ?? (realm === 'staff' ? 'staff_member' : t.accountId ? 'customer' : 'guest_email') }];
      default:
        return [t];
    }
  }

  async #allSellers(): Promise<Target[]> {
    const api = this.core.sellers;
    if (!api) return [];
    const out: Target[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 200; i++) {
      const page = await api.searchSellers({ statuses: ['approved', 'restricted'] }, { limit: 100, ...(cursor ? { cursor } : {}) });
      out.push(...page.items.map((s) => ({ kind: 'seller' as const, sellerId: s.id })));
      if (!page.nextCursor || !page.items.length) break;
      cursor = page.nextCursor;
    }
    return out;
  }

  /* ---------------------------------------------------------------- side effects */

  async #effect(effect: NonNullable<EventRoute<unknown>['effects']>[number], payload: unknown) {
    const core = this.core;
    const repo = core.repo;
    const now = core.now();
    switch (effect) {
      case 'refreshConsent': {
        const p = payload as EventPayload<'customers.marketing_preferences.changed'>;
        core.forgetConsent(p.customerId);
        return;
      }
      case 'customerClosed': {
        const p = payload as EventPayload<'customers.account.closed'>;
        core.forgetConsent(p.customerId);
        await repo.invalidatePushDevices(p.userId, now);
        const nonEssential = TOPICS.filter((t) => t.audience === 'customer' && t.category !== 'essential').map((t) => t.key);
        await repo.skipQueuedFor(p.userId, 'account_closed', nonEssential);
        return;
      }
      case 'reroute': {
        const p = payload as EventPayload<'access.coverage.changed'>;
        const open = await repo.openRoleNotices(p.roleKey);
        if (!open.length) return;
        const names = p.viaBackup && p.leadAccountId ? await core.accounts([p.leadAccountId]) : new Map();
        const leadName = p.leadAccountId ? (names.get(p.leadAccountId)?.displayName ?? null) : null;
        await repo.insertRecipients(
          open.flatMap((n) =>
            p.receivingAccountIds.map((id) => ({
              notice_id: n.id,
              account_id: id,
              reason: id === p.leadAccountId ? 'lead' : p.viaBackup ? 'backup' : 'member',
              covering_for: p.viaBackup && id !== p.leadAccountId ? leadName : null,
              read_at: null,
              created_at: now,
            })),
          ),
        );
        return;
      }
      case 'awayEnded': {
        const p = payload as EventPayload<'access.away.ended'>;
        const api = core.access;
        if (!api) return;
        let roleKeys: string[];
        try {
          const coverage = await api.coverageNow({});
          roleKeys = coverage.filter((c) => c.lead?.accountId === p.accountId).map((c) => c.role.key);
        } catch (err) {
          if (!isNotImplemented(err)) throw err;
          roleKeys = (await api.rolesOf(p.accountId)).map((r) => r.key);
        }
        const notices = await repo.recentRoleNotices(roleKeys, new Date(now.getTime() - 30 * 86_400_000));
        await repo.insertRecipients(notices.map((n) => ({ notice_id: n.id, account_id: p.accountId, reason: 'lead', covering_for: null, read_at: null, created_at: now })));
        return;
      }
      case 'dropOffReminder': {
        const p = payload as EventPayload<'returns.label.created'>;
        const approved = await repo.latestNotice({ topicKey: 'customer.return.approved', subject: { key: 'returnId', value: p.returnId } });
        const who = (await repo.addresseeOf('customer', 'returnId', p.returnId)) ?? (await repo.addresseeOf('customer', 'orderId', p.orderId));
        if (!who) return;
        const dropOffBy = approved?.deadline_at ?? null;
        const sendAt = dropOffBy ? new Date(dropOffBy.getTime() - 24 * 3_600_000) : new Date(now.getTime() + 5 * 86_400_000);
        if (sendAt.getTime() <= now.getTime()) return;
        await this.schedule(
          {
            topic: 'customer.return.dropoff_reminder',
            recipients: [{ kind: 'customer', accountId: who.addressId }],
            link: { kind: 'return', id: p.returnId, screen: 'account/return', label: 'View return' },
            context: { due: { date: dropOffBy ? this.fmt.date(dropOffBy.toISOString()) : 'the date on your label' } },
            dedupeKey: `return-dropoff:${p.returnId}`,
          },
          sendAt.toISOString(),
          'notifications',
        );
        return;
      }
      case 'dispatchReminder': {
        // seller dispatch deadline reminder, sellerDispatchReminderHours before dispatchBy (once per group)
        const p = payload as EventPayload<'orders.order.accepted'>;
        const hours = Number(await core.setting('sellerDispatchReminderHours'));
        for (const g of p.groups) {
          if (g.ownerType !== 'seller' || !g.sellerId) continue;
          const key = `seller.dispatch.reminder:${g.groupId}`;
          const sendAt = new Date(new Date(g.dispatchBy).getTime() - hours * 3_600_000);
          if (sendAt.getTime() <= now.getTime() || (await repo.hasPendingScheduled(key))) continue;
          await this.schedule(
            {
              topic: 'seller.dispatch.reminder',
              recipients: [{ kind: 'seller', sellerId: g.sellerId }],
              link: { kind: 'seller_order', id: g.groupId, ref: p.ref, screen: 'seller/order', label: 'Open dispatch queue' },
              context: { order: { ref: p.ref }, due: { date: this.fmt.dateTime(g.dispatchBy) } },
              dedupeKey: key,
              actionRequired: true,
              deadline: g.dispatchBy,
              sellerId: g.sellerId,
            },
            sendAt.toISOString(),
            'notifications',
          );
        }
        return;
      }
      case 'approvalDueReminder': {
        const p = payload as EventPayload<'access.approval.requested'>;
        if (!p.dueAt) return;
        const sendAt = new Date(new Date(p.dueAt).getTime() - 4 * 3_600_000);
        if (sendAt.getTime() <= now.getTime()) return;
        const approvers = [...new Set([p.nominatedReviewerId, ...p.eligibleAccountIds].filter((x): x is string => Boolean(x)))];
        await this.schedule(
          {
            topic: 'staff.approval.due_soon',
            recipients: approvers.length ? approvers.map((accountId) => ({ kind: 'staff_member', accountId })) : p.eligibleRoleKeys.map((roleKey) => ({ kind: 'staff_role', roleKey })),
            link: { kind: 'approval', id: p.requestId, ref: p.ref, screen: 'admin/approvals', label: 'Review request' },
            context: { due: { date: this.fmt.dateTime(p.dueAt) } },
            dedupeKey: `approval:${p.requestId}`,
            actionRequired: true,
            deadline: p.dueAt,
          },
          sendAt.toISOString(),
          'notifications',
        );
        return;
      }
    }
  }
}
