import { gqlActor, type GraphQLContext, type ModuleResolvers } from '../../../kernel/graphql/index.js';
import { format as formatMoney } from '../../../kernel/lib/money.js';
import { toPageRequest } from '../../../kernel/lib/pagination.js';
import type * as common from '../../../spec/common.js';
import type { DayEndReview, QueueDefinition, QueueSummary, RoutineDay, SavedFilter, StaffRef, WorkItem } from '../../../spec/workqueues.js';
import type { Viewer } from '../app/core.js';
import { stepTarget } from '../domain/rules.js';
import type { WorkqueuesService } from '../service.js';

/* ---------------------------------------------------------------- REST shapes → GraphQL shapes (enums in capitals, Money.formatted) */

const up = (s: string | null | undefined) => (s ? s.toUpperCase() : null);
const low = (s: string | null | undefined) => (s ? s.toLowerCase() : undefined);
const actor = gqlActor;
const money = (m: common.Money | null | undefined) => (m ? { ...m, formatted: formatMoney(m) } : null);
const staff = (s: StaffRef | null | undefined) => (s ? { staffId: s.staffId, name: s.name, role: s.role ?? null } : null);
const subject = (s: WorkItem['subject']) => ({ ...s, type: up(s.type) });
const link = (l: unknown) => {
  const x = (l ?? {}) as { label?: string; screen?: string; state?: string | null };
  return { label: x.label ?? 'Open', screen: x.screen ?? 'ops/queues', state: x.state ?? null };
};

export function gqlItem(w: WorkItem) {
  const src = (w.source ?? {}) as { module?: string; event?: string | null; raisedBy?: common.Actor; dedupeKey?: string };
  const res = w.resolution as { outcome?: string; note?: string | null; by?: common.Actor } | null | undefined;
  return {
    ...w,
    area: up(w.area),
    kind: up(w.kind),
    subject: subject(w.subject),
    relatedSubjects: w.relatedSubjects.map(subject),
    amount: money(w.amount),
    lead: staff(w.lead),
    backup: staff(w.backup),
    assignee: staff(w.assignee),
    escalatedTo: staff(w.escalatedTo),
    deadline: { dueAt: w.deadline.dueAt, state: up(w.deadline.state) },
    priority: up(w.priority),
    state: up(w.state),
    waitingOn: up(w.waitingOn),
    source: { module: src.module ?? 'workqueues', event: src.event ?? null, raisedBy: actor(src.raisedBy ?? { kind: 'system' }), dedupeKey: src.dedupeKey ?? '' },
    links: w.links.map(link),
    notes: w.notes.map((n) => ({ ...n, author: actor(n.author) })),
    history: w.history.map((h) => ({ ...h, actor: actor(h.actor) })),
    resolution: res ? { outcome: res.outcome ?? 'resolved', note: res.note ?? null, by: actor(res.by ?? { kind: 'system' }) } : null,
  };
}

const page = <T, U>(p: common.Page<T>, map: (t: T) => U) => ({ ...p, items: p.items.map(map) });

interface FilterArgs {
  filter?: { queueKeys?: string[] | null; areas?: string[] | null; kinds?: string[] | null; states?: string[] | null; assignedToMe?: boolean | null; overdueOnly?: boolean | null; overdueOver?: string | null; sellerId?: string | null; sellerKind?: string | null; search?: string | null } | null;
  paging?: common.PageInput | null;
}

const filterOf = (f: FilterArgs['filter'], queueKey?: string) => ({
  ...(f?.queueKeys?.length ? { queueKeys: f.queueKeys } : queueKey ? { queueKeys: [queueKey] } : {}),
  ...(f?.areas?.length ? { areas: f.areas.map((a) => a.toLowerCase()) } : {}),
  ...(f?.kinds?.length ? { kinds: f.kinds.map((k) => k.toLowerCase()) } : {}),
  ...(f?.states?.length ? { states: f.states.map((s) => s.toLowerCase()) } : {}),
  ...(f?.assignedToMe ? { assignedToMe: true } : {}),
  ...(f?.overdueOnly ? { overdueOnly: true } : {}),
  ...(f?.overdueOver ? { overdueOver: f.overdueOver } : {}),
  ...(f?.sellerId ? { sellerId: f.sellerId } : {}),
  ...(f?.sellerKind ? { sellerKind: low(f.sellerKind) } : {}),
  ...(f?.search ? { search: f.search } : {}),
});

function gqlQueue(def: QueueDefinition, sum: QueueSummary | undefined, items: (args: FilterArgs) => Promise<unknown>) {
  const oldest = (sum?.oldest ?? null) as { itemId: string; subjectRef?: string | null; ref?: string; openedAt: string; ageLabel: string } | null;
  return {
    ...def,
    area: up(def.area),
    lead: staff(def.lead),
    backup: staff(def.backup),
    escalationRoute: def.escalationRoute.map((s) => ({ afterMinutes: s.afterMinutes, toName: stepTarget(s)?.name ?? 'Unknown', condition: s.condition ?? null, notify: s.notify })),
    open: sum?.open ?? 0,
    overdue: sum?.overdue ?? 0,
    dueSoon: sum?.dueSoon ?? 0,
    oldest: oldest ? { itemId: oldest.itemId, subjectRef: oldest.subjectRef ?? oldest.ref ?? null, openedAt: oldest.openedAt, ageLabel: oldest.ageLabel } : null,
    mine: sum?.mine ?? false,
    items,
  };
}

const routine = (r: RoutineDay) => ({ ...r, checks: r.checks.map((c) => ({ ...c, state: up(c.state), owner: staff(c.owner), doneBy: staff(c.doneBy) })) });
const dayEnd = (d: DayEndReview | null | undefined) =>
  d
    ? {
        ...d,
        state: up(d.state),
        completedBy: staff(d.completedBy),
        items: d.items.map((i) => ({ ...i, key: up(i.key), owner: staff(i.owner), checkedBy: staff(i.checkedBy), link: { ...link(i.link), label: (i.link as { label?: string })?.label ?? i.title } })),
      }
    : null;
const savedFilter = (f: SavedFilter) => ({ ...f, owner: staff(f.owner), target: up(f.target), filters: f.filters ?? {} });

/**
 * Resolvers for the GraphQL fields this module owns (`@source(module: "workqueues", …)` in graphql/schema.ts).
 * Same visibility as REST: the caller's roles, the queues they lead or back up, view-all.
 *
 *   Seller.openWorkItems → service.listForSubject
 *   Query.myQueues → service.getMyQueues
 *   Query.workSummary → service.getWorkSummary
 *   Query.workItems → service.listItems
 *   Query.workItem → service.getItem
 */
export const resolvers = (service: WorkqueuesService): ModuleResolvers => {
  const viewerOf = (ctx: GraphQLContext): Promise<Viewer> => service.viewer(ctx.principal as never);

  const queuesFor = async (v: Viewer, keys: Set<string> | null) => {
    const rows = (await service.core.repo.listQueues()).filter((q) => q.active && (keys ? keys.has(q.key) : service.core.queueVisible(v, q)));
    const [defs, sums] = await Promise.all([service.queues.definitions(rows), service.queues.summaries(rows, v)]);
    const byKey = new Map(sums.map((s) => [s.key, s]));
    return defs.map((d) =>
      gqlQueue(d, byKey.get(d.key), async (args: FilterArgs) => page(await service.items.list(v, { ...filterOf(args.filter, d.key), ...(args.filter?.queueKeys?.length ? {} : { queueKeys: [d.key] }), sort: 'deadline' }, toPageRequest(args.paging ?? undefined)), gqlItem)),
    );
  };

  return {
    Seller: {
      openWorkItems: async (parent: { id: string }) => (await service.listForSubject('seller', parent.id)).map(gqlItem),
    },
    Query: {
      myQueues: async (_root: unknown, _args: unknown, ctx: GraphQLContext) => {
        const v = await viewerOf(ctx);
        const my = await service.myQueues(v, false);
        const me = my.me as { staffId: string; name: string; roles: string[] };
        const stats = my.stats as { assignedToMe: number; queuesILead: number; overdue: number; overdueChangeVsYesterday: number; oldestOpen: { itemId: string; subjectRef?: string | null; ref?: string; openedAt: string; ageLabel: string } | null };
        const mineKeys = new Set(my.queues.map((q) => q.key));
        return {
          me: { staffId: me.staffId, name: me.name, role: null },
          roles: me.roles,
          date: my.date,
          stats: { ...stats, oldestOpen: stats.oldestOpen ? { itemId: stats.oldestOpen.itemId, subjectRef: stats.oldestOpen.subjectRef ?? stats.oldestOpen.ref ?? null, openedAt: stats.oldestOpen.openedAt, ageLabel: stats.oldestOpen.ageLabel } : null },
          queues: async (args: { scope?: 'MINE' | 'ALL' }) => queuesFor(v, args.scope === 'ALL' ? null : mineKeys),
          routine: routine(my.routine),
          dayEnd: dayEnd(my.dayEnd),
          savedFilters: my.savedFilters.map(savedFilter),
          reminders: my.reminders,
          exportScope: my.exportScope,
        };
      },
      workSummary: async (_root: unknown, _args: unknown, ctx: GraphQLContext) => {
        const v = await viewerOf(ctx);
        const s = await service.workSummary(v);
        return {
          needsAttention: (s.needsAttention as { tone: string }[]).map((t) => ({ ...t, tone: up(t.tone) })),
          overdueDispatch: async (args: { limit?: number }) => {
            const limit = args.limit ?? 5;
            const items = limit === 5 ? s.overdueDispatch : (await service.workSummary(v, { dispatchLimit: limit })).overdueDispatch;
            return items.map(gqlItem);
          },
          team: s.team.map((t) => ({ ...t, staff: staff(t.staff), coveringFor: staff(t.coveringFor), role: up(t.role), status: up(t.status) })),
          generatedAt: s.generatedAt,
        };
      },
      workItems: async (_root: unknown, args: FilterArgs, ctx: GraphQLContext) => page(await service.listItems(filterOf(args.filter), args.paging ?? {}, ctx.principal as never), gqlItem),
      workItem: async (_root: unknown, args: { id: string }, ctx: GraphQLContext) => {
        const item = await service.getItem(args.id, ctx.principal as never);
        return item ? gqlItem(item) : null;
      },
    },
  };
};
