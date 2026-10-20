import { gqlEnum, type GraphQLContext, type ModuleResolvers } from '../../../kernel/graphql/index.js';
import { toPageRequest } from '../../../kernel/lib/pagination.js';
import type { PageInput } from '../../../spec/common.js';
import type { Notice } from '../../../spec/notifications.js';
import type { Reader } from '../app/inbox.js';
import type { NotificationsService } from '../service.js';

const low = <T extends string>(s: string | null | undefined) => (s ? (s.toLowerCase() as T) : undefined);

/** REST Notice → GraphQL Notification (enum values in upper case, `read` flag) */
export function gqlNotice(n: Notice) {
  return {
    ...n,
    category: gqlEnum(n.category),
    tone: gqlEnum(n.tone),
    read: Boolean(n.readAt),
    deadline: n.deadline ? { dueAt: n.deadline.dueAt, state: gqlEnum(n.deadline.state) } : null,
    routedTo: n.routedTo ? { ...n.routedTo, reason: gqlEnum(n.routedTo.reason), recipients: n.routedTo.recipients.map((r) => ({ ...r, as: gqlEnum(r.as) })) } : null,
  };
}

const readerOf = (ctx: GraphQLContext): Reader | null => (ctx.principal ? { principal: ctx.principal, sellerAccess: ctx.auth?.sellerAccess ?? null } : null);

interface FilterArgs {
  filter?: { group?: string | null; unreadOnly?: boolean | null; actionRequired?: boolean | null; category?: string | null; view?: string | null } | null;
  paging?: PageInput | null;
}

/**
 * Resolvers for the GraphQL fields this module owns (`@source(module: "notifications", …)` in graphql/schema.ts).
 * Every field reads the caller's own inbox (customer, seller member within the current seller, staff
 * member including notices received as a backup); visitors have none.
 *
 *   Query.notifications → service.listInbox
 *   Query.unreadNotificationCount → service.unreadCount
 *   Query.notificationInbox → service.inboxSummary
 */
export const resolvers = (service: NotificationsService): ModuleResolvers => ({
  Query: {
    notifications: async (_root: unknown, args: FilterArgs, ctx: GraphQLContext) => {
      const reader = readerOf(ctx);
      const page = toPageRequest(args.paging ?? undefined);
      if (!reader) return { items: [], nextCursor: null, ...(page.mode === 'page' ? { page: page.page, totalPages: 1, total: 0 } : {}) };
      const f = args.filter ?? {};
      const res = await service.listInboxFor(
        reader,
        {
          group: f.group ?? undefined,
          unreadOnly: f.unreadOnly ?? undefined,
          actionRequired: f.actionRequired ?? undefined,
          category: low<'essential' | 'optional' | 'promotional'>(f.category),
          view: ctx.area === 'admin' ? low<'all' | 'needs_my_action' | 'mentions'>(f.view) : undefined,
        },
        page,
      );
      return { ...res, items: res.items.map(gqlNotice) };
    },
    unreadNotificationCount: async (_root: unknown, _args: unknown, ctx: GraphQLContext) => {
      const reader = readerOf(ctx);
      return reader ? service.inbox.unreadCount(reader) : 0;
    },
    notificationInbox: async (_root: unknown, _args: unknown, ctx: GraphQLContext) => {
      const reader = readerOf(ctx);
      if (!reader) return { unread: 0, byGroup: [], actionRequired: 0, needsAction: [] };
      const s = await service.inbox.summary(reader);
      const groups = [...new Set([...Object.keys(s.totalByGroup), ...Object.keys(s.byGroup)])];
      return {
        unread: s.unread,
        byGroup: groups.map((group) => ({ group, unread: s.byGroup[group] ?? 0, total: s.totalByGroup[group] ?? 0 })),
        actionRequired: s.actionRequired,
        needsAction: s.needsAction.map(gqlNotice),
        needsMyAction: s.needsMyAction ?? null,
        mentions: s.mentions ?? null,
        routingToday: s.routingToday ?? null,
        coveringNote: s.coveringNote ?? null,
      };
    },
  },
});
