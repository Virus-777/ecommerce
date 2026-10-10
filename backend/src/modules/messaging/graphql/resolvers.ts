import { AppError } from '../../../kernel/errors/index.js';
import type { GraphQLContext, ModuleResolvers } from '../../../kernel/graphql/index.js';
import { isUuid } from '../../../kernel/lib/ids.js';
import type * as common from '../../../spec/common.js';
import type { Message } from '../../../spec/messaging.js';
import type { ConversationView, MessagingService, Viewer } from '../service.js';

/* ---------------------------------------------------------------- REST shapes → GraphQL shapes (enums in capitals) */

const upper = (s: string | null | undefined) => (s ? s.toUpperCase() : null);
const ACTOR_KIND: Record<string, string> = { customer: 'CUSTOMER', visitor: 'GUEST', seller: 'SELLER', staff: 'STAFF' };
const actor = (a: common.Actor | null | undefined) => (a ? { kind: ACTOR_KIND[a.kind] ?? 'SYSTEM', id: a.id ?? null, name: a.name ?? null } : null);
const deadline = (d: common.Deadline | null | undefined) => (d ? { dueAt: d.dueAt, state: upper(d.state) } : null);

const message = (m: Message) => ({
  id: m.id,
  conversationId: m.conversationId,
  kind: upper(m.kind),
  author: actor(m.author),
  authorLabel: m.authorLabel,
  fromMe: m.fromMe,
  body: m.body,
  attachments: m.attachments,
  redactions: m.redactions.map(upper),
  hidden: m.hidden,
  at: m.at,
});

/* ---------------------------------------------------------------- batching per request (one call per field and tick) */

type Batch<V> = { ids: Set<string>; promise: Promise<Map<string, V>> };
const batches = new WeakMap<object, Map<string, Batch<unknown>>>();

function load<V>(ctx: GraphQLContext, key: string, id: string, fetch: (ids: string[]) => Promise<Map<string, V>>): Promise<V | undefined> {
  let perCtx = batches.get(ctx);
  if (!perCtx) batches.set(ctx, (perCtx = new Map()));
  let batch = perCtx.get(key) as Batch<V> | undefined;
  if (!batch) {
    const ids = new Set<string>();
    const promise = new Promise<Map<string, V>>((resolve, reject) => {
      setImmediate(() => {
        perCtx!.delete(key);
        fetch([...ids]).then(resolve, reject);
      });
    });
    batch = { ids, promise };
    perCtx.set(key, batch as Batch<unknown>);
  }
  batch.ids.add(id);
  return batch.promise.then((m) => m.get(id));
}

/**
 * Resolvers for the GraphQL fields this module owns (`@source(module: "messaging", …)` in graphql/schema.ts).
 * Same record scope as REST: the store sees the customer's (or guest session's) own conversations, the seller area
 * the caller's seller conversations only. Staff read message content through REST only (logged), never here.
 *
 *   Order.conversations → service.listForOrder
 *   Return.conversation → service.getForSubject
 *   Customer.unreadMessages → service.unreadSummary
 *   Customer.conversationSummary → service.customerConversationSummaries
 *   Seller.inbox → service.sellerInboxSummary
 *   Seller.replyStats → service.sellerResponseStats
 *   Query.conversations → service.listInbox
 *   Query.conversation → service.getConversation
 *   Query.sellerConversations → service.listInbox
 *   Query.sellerConversation → service.getConversation
 */
export const resolvers = (service: MessagingService): ModuleResolvers => {
  /** The caller as a conversation participant, or null when the area has none (admin) */
  const viewerOf = async (ctx: GraphQLContext): Promise<Viewer | null> => {
    const p = ctx.principal;
    if (!p) return null;
    if (ctx.area === 'seller') return p.sellerId ? { kind: 'seller', sellerId: p.sellerId, accountId: p.accountId ?? null, name: p.name ?? null } : null;
    if (ctx.area !== 'store') return null;
    if (p.kind === 'visitor') return { kind: 'customer', customerId: null, guestSessionId: p.guestSessionId ?? p.sessionId, accountId: null };
    if (p.kind === 'customer') return { kind: 'customer', customerId: await ctx.customerId(), guestSessionId: null, accountId: p.accountId ?? null };
    return null;
  };

  const sellerIdOf = (ctx: GraphQLContext) => {
    const id = ctx.principal?.sellerId;
    if (!id) throw new AppError('UNAUTHORIZED', 'Choose the seller account to act for');
    return id;
  };

  const conversation = (v: Viewer, x: ConversationView) => {
    const c = x.conversation;
    const s = x.summary;
    return {
      id: c.id,
      kind: upper(c.kind),
      counterparty: { ...c.counterparty, kind: upper(c.counterparty.kind), id: c.counterparty.id ?? null },
      // the GraphQL enum has no GUEST (schema owned by the spec): a guest order's buyer shows as CUSTOMER
      participants: c.participants.map((p) => ({ kind: p.kind === 'guest' ? 'CUSTOMER' : upper(p.kind), id: p.id, name: p.name, label: p.label, joinedAt: p.joinedAt, joinedFromCaseId: p.joinedFromCaseId ?? null })),
      subject: { ...c.subject, kind: upper(c.subject.kind) },
      status: upper(c.status),
      lockedReason: c.lockedReason ?? null,
      replyState: upper(c.replyState),
      replyDue: deadline(c.replyDue),
      privacyNote: c.privacyNote,
      rulesNote: c.rulesNote,
      canSend: c.canSend,
      createdAt: c.createdAt,
      lastMessageAt: c.lastMessageAt,
      lastMessagePreview: s.lastMessagePreview,
      lastFromMe: s.lastFromMe,
      unreadCount: s.unreadCount,
      replyLabel: s.replyLabel ?? null,
      dispatchWarning: c.dispatchWarning ?? null,
      messages: async (args: { paging?: common.PageInput | null }) => {
        const page = await service.messagesFor(v, c.id, service.pageRequest(args?.paging));
        return { ...page, items: page.items.map(message) };
      },
    };
  };

  const inbox = async (ctx: GraphQLContext, filter: { unreadOnly?: boolean; replyState?: string }, paging: common.PageInput | null | undefined) => {
    const v = await viewerOf(ctx);
    if (!v || (v.kind === 'customer' && !v.customerId && !v.guestSessionId)) return { items: [], nextCursor: null, total: 0 };
    const page = await service.inboxViews(v, filter, service.pageRequest(paging));
    return { ...page, items: page.items.map((x) => conversation(v, x)) };
  };

  const one = async (ctx: GraphQLContext, id: string) => {
    const v = await viewerOf(ctx);
    if (!v || !isUuid(id)) return null;
    const x = await service.viewOf(v, id);
    return x ? conversation(v, x) : null;
  };

  return {
    Query: {
      conversations: async (_root, args: { unreadOnly?: boolean | null; paging?: common.PageInput | null }, ctx) => inbox(ctx, args.unreadOnly ? { unreadOnly: true } : {}, args.paging),
      conversation: async (_root, args: { id: string }, ctx) => one(ctx, args.id),
      sellerConversations: async (_root, args: { replyState?: string | null; paging?: common.PageInput | null }, ctx) => {
        sellerIdOf(ctx);
        return inbox(ctx, args.replyState ? { replyState: args.replyState.toLowerCase() } : {}, args.paging);
      },
      sellerConversation: async (_root, args: { id: string }, ctx) => {
        sellerIdOf(ctx);
        return one(ctx, args.id);
      },
    },
    Order: {
      conversations: async (root: { id?: string | null }, _args: unknown, ctx: GraphQLContext) => {
        const v = await viewerOf(ctx);
        if (!v || !root?.id || !isUuid(root.id)) return [];
        return (await service.viewsForOrder(v, root.id)).map((x) => conversation(v, x));
      },
    },
    Return: {
      conversation: async (root: { id?: string | null }, _args: unknown, ctx: GraphQLContext) => {
        const v = await viewerOf(ctx);
        if (!v || !root?.id) return null;
        const x = await service.viewForSubject(v, { kind: 'return', id: root.id });
        return x ? conversation(v, x) : null;
      },
    },
    Customer: {
      unreadMessages: async (root: { id: string }, _args: unknown, ctx: GraphQLContext) => {
        const v = await viewerOf(ctx);
        // the store's Customer is always the signed-in customer (`me`)
        if (!v || v.kind !== 'customer' || !v.customerId || v.customerId !== root.id) return { conversations: 0, messages: 0, fromNames: [] };
        return service.unreadSummaryFor(v);
      },
      conversationSummary: async (root: { id: string }, _args: unknown, ctx: GraphQLContext) => {
        const s = await load(ctx, 'customerConversationSummaries', root.id, async (ids) => new Map(Object.entries(await service.customerConversationSummaries(ids))));
        if (!s) return null;
        return {
          ...s,
          lastMessageAt: s.lastMessageAt ?? null,
          counterparties: (s.counterparties as { kind: string; sellerId?: string | null; name: string; conversationCount: number; lastMessageAt: string }[]).map((c) => ({
            kind: c.kind.toUpperCase(),
            sellerId: c.sellerId ?? null,
            name: c.name,
            conversationCount: c.conversationCount,
            lastMessageAt: c.lastMessageAt,
          })),
        };
      },
    },
    Seller: {
      inbox: async (root: { id: string }, _args: unknown, ctx: GraphQLContext) => {
        // Seller Center reaches only its own account; staff (shared field) may read any seller's tiles
        if (ctx.principal?.kind === 'seller' && ctx.principal.sellerId !== root.id) return null;
        return service.sellerInboxSummary(root.id);
      },
      replyStats: async (root: { id: string }) => {
        const to = service.core.today();
        const from = service.core.today(new Date(service.core.now().getTime() - 29 * 86_400_000));
        const s = await service.sellerResponseStats(root.id, { from, to });
        return { targetHours: s.targetHours, repliedWithinTargetPct: s.repliedWithinTargetPct ?? null, averageReplyMinutes: s.averageReplyMinutes ?? null, label: service.replyLabelFor(s.averageReplyMinutes), periodDays: 30 };
      },
    },
  };
};
