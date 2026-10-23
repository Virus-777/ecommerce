import { createBatchLoader, gqlActor, gqlDeadline, gqlEnum, type GraphQLContext, type ModuleResolvers, pageInput } from '../../../kernel/graphql/index.js';
import { isUuid } from '../../../kernel/lib/ids.js';
import type * as common from '../../../spec/common.js';
import type { AdminCaseDetail, CaseView, DecisionInput } from '../../../spec/support.js';
import { isOpen } from '../domain/rules.js';
import type { Agg } from '../service/core.js';
import type { SupportService } from '../service.js';

/**
 * Resolvers for the GraphQL fields this module owns (`@source(module: "support", …)` in graphql/schema.ts).
 * Same record scope as REST: store callers see their own cases (or a guest session's), sellers only cases about
 * their own orders and their own requests, staff everything. REST shapes are mapped to GraphQL shapes.
 */

const actor = gqlActor;
const timeline = (list: readonly common.TimelineEvent[]) => list.map((t) => ({ at: t.at, label: t.label, detail: t.detail ?? null, actor: actor(t.actor) }));
const options = (o: Record<string, string> | null | undefined) => Object.entries(o ?? {}).map(([name, value]) => ({ name, value }));
const emptyPage = { items: [], nextCursor: null, page: null, totalPages: null, total: 0 };

const draftRemedies = (d: DecisionInput) =>
  (d.remedies ?? []).map((r) => ({ kind: gqlEnum(r.kind), amount: r.amount ?? null, chargedTo: gqlEnum(r.chargedTo), orderItemIds: r.orderItemIds ?? [], dueAt: r.dueAt ?? null, note: r.note ?? null }));

/** The GraphQL Case from the REST view; the admin detail adds the dispute review fields */
export function gqlCase(v: CaseView, extra: { updatedAt: string; area: 'store' | 'seller' | 'admin'; marketplaceInvolved: boolean; expectedReply: string; reopened: boolean; detail?: AdminCaseDetail | null; evidence?: AdminCaseDetail['evidence'] }) {
  const d = extra.detail;
  return {
    id: v.id,
    ref: v.ref,
    kind: gqlEnum(v.kind),
    subject: v.subject,
    category: { ...v.category, team: v.category.team },
    priority: gqlEnum(v.priority),
    status: gqlEnum(v.status),
    statusLabel: v.statusLabel,
    openedAt: v.openedAt,
    updatedAt: extra.updatedAt,
    open: isOpen(v.status),
    handledBy: { kind: gqlEnum(v.handledBy.kind), name: v.handledBy.name, staff: actor(v.handledBy.staff), team: v.handledBy.team ?? null, supportFollowing: v.handledBy.supportFollowing },
    nextAction: { label: v.nextAction.label, whoMustAct: gqlEnum(v.nextAction.whoMustAct), due: gqlDeadline(v.nextAction.due), youNeedToAct: v.nextAction.youNeedToAct, note: v.nextAction.note ?? null },
    expectedResponse: gqlDeadline(v.expectedResponse),
    expectedReply: extra.expectedReply,
    orderId: v.order?.id ?? null,
    orderRef: v.order?.ref || null,
    items: v.items.map((i) => ({ ...i, options: options(i.options), price: i.price ?? null, imageUrl: i.imageUrl ?? null, ownerType: gqlEnum(i.ownerType), sellerId: i.sellerId ?? null, packageLabel: i.packageLabel ?? null, estimate: i.estimate ?? null })),
    returnId: v.returnId ?? null,
    returnRef: v.returnRef ?? null,
    messages: v.messages.map((m) => ({ ...m, author: actor(m.author), role: gqlEnum(m.role), audience: gqlEnum(m.audience) })),
    attachments: v.attachments,
    offers: v.offers.map((o) => ({ ...o, from: gqlEnum(o.from), kind: gqlEnum(o.kind), amount: o.amount ?? null, shipBy: o.shipBy ?? null, note: o.note ?? null, status: gqlEnum(o.status), respondBy: o.respondBy ?? null })),
    decision: v.decision ? { outcome: gqlEnum(v.decision.outcome), reason: v.decision.reason, decidedBy: actor(v.decision.decidedBy), decidedAt: v.decision.decidedAt, publishedAt: v.decision.publishedAt ?? null, appealDeadline: v.decision.appealDeadline ?? null, appealRoute: v.decision.appealRoute, final: v.decision.final } : null,
    remedies: v.remedies.map((r) => ({ ...r, kind: gqlEnum(r.kind), amount: r.amount ?? null, chargedTo: gqlEnum(r.chargedTo), status: gqlEnum(r.status), currentStep: r.currentStep ?? null, dueAt: r.dueAt ?? null, destination: r.destination ?? null, note: r.note ?? null, refundRequestId: r.refundRequestId ?? null, replacementId: r.replacementId ?? null })),
    appeal: v.appeal ? { ...v.appeal, by: actor(v.appeal.by), status: gqlEnum(v.appeal.status), reviewer: actor(v.appeal.reviewer), decidedAt: v.appeal.decidedAt ?? null, outcome: v.appeal.outcome ?? null } : null,
    reopenUntil: v.reopenUntil ?? null,
    reopenRules: v.reopenRules,
    timeline: timeline(v.timeline),
    can: v.can,
    marketplaceInvolved: extra.marketplaceInvolved,
    evidence: (extra.evidence ?? d?.evidence ?? []).map((e) => ({ ...e, party: gqlEnum(e.party), kind: gqlEnum(e.kind), note: e.note ?? null, addedBy: actor(e.addedBy) })),
    customer: d?.customer ? { ...d.customer, id: d.customer.id ?? null, location: d.customer.location ?? null, email: d.customer.email ?? null, asksFor: d.customer.asksFor ?? null } : null,
    seller: d?.seller ? { ...d.seller, ownerType: gqlEnum(d.seller.ownerType), id: d.seller.id ?? null, location: d.seller.location ?? null, onTimeDispatchPct: d.seller.onTimeDispatchPct ?? null, offers: d.seller.offers ?? null } : null,
    owner: actor(d?.owner),
    team: d?.team ?? null,
    financeReviewer: actor(d?.financeReviewer),
    purchaseTerms: d?.purchaseTerms ? { ...d.purchaseTerms, pricePaid: d.purchaseTerms.pricePaid ?? null, listPrice: d.purchaseTerms.listPrice ?? null, discountNote: d.purchaseTerms.discountNote ?? null, promisedDelivery: d.purchaseTerms.promisedDelivery ?? null, dispatchBy: d.purchaseTerms.dispatchBy ?? null } : null,
    shipmentEvidence: timeline(d?.shipmentEvidence ?? []),
    deadlines: (d?.deadlines ?? []).map((x) => ({ label: x.label, deadline: gqlDeadline(x.deadline), party: gqlEnum(x.party) })),
    history: timeline(d?.history ?? []),
    reopened: extra.reopened,
    pendingApproval: d?.pendingApproval ? { required: d.pendingApproval.required, reason: d.pendingApproval.reason ?? null, approvalRequestId: d.pendingApproval.approvalRequestId ?? null, approvers: d.pendingApproval.approvers } : null,
    decisionDraft: d?.decisionDraft
      ? {
          outcome: gqlEnum(d.decisionDraft.draft.outcome),
          reason: d.decisionDraft.draft.reason ?? null,
          remedies: draftRemedies(d.decisionDraft.draft),
          appealDeadline: d.decisionDraft.draft.appealDeadline ?? null,
          notifyParties: d.decisionDraft.draft.notifyParties,
          savedAt: d.decisionDraft.savedAt,
          savedBy: actor(d.decisionDraft.savedBy),
        }
      : null,
  };
}

export const resolvers = (service: SupportService): ModuleResolvers => {
  const load = createBatchLoader();
  /** The store viewer: customer id or guest session */
  const shopper = async (ctx: GraphQLContext) => {
    const p = ctx.principal;
    if (p?.kind === 'visitor') return { customerId: null, guestSessionId: p.guestSessionId ?? p.sessionId };
    return { customerId: await ctx.customerId(), guestSessionId: null };
  };
  const sellerOf = (ctx: GraphQLContext) => (ctx.principal?.kind === 'seller' ? (ctx.principal.sellerId ?? null) : null);

  /** GraphQL Cases for an area from case aggregates (one batch of order, staff and file lookups) */
  const cases = async (aggs: Agg[], area: 'store' | 'seller' | 'admin') => {
    if (!aggs.length) return [];
    const x = await service.views.prepare(aggs);
    return Promise.all(
      aggs.map(async (a) => {
        const v = service.views.caseView(a, area, x);
        const detail = area === 'admin' ? await service.views.adminDetail(a, x) : null;
        return gqlCase(v, {
          updatedAt: a.c.updated_at.toISOString(),
          area,
          marketplaceInvolved: a.c.kind === 'seller_request' || a.c.handler_kind === 'marketplace_support' || a.c.support_following,
          expectedReply: service.views.expectedReply(a),
          reopened: a.c.reopen_count > 0,
          detail,
          ...(area === 'seller' ? { evidence: a.evidence.map((e) => service.views.evidence(e, x, 'seller')) } : {}),
        });
      }),
    );
  };
  const page = async (res: common.Page<{ id: string }>, area: 'store' | 'seller' | 'admin') => {
    const aggs = await service.core.loadMany(res.items.map((r) => r.id));
    const list = res.items.map((r) => aggs.get(r.id)).filter((a): a is Agg => !!a);
    return { items: await cases(list, area), nextCursor: res.nextCursor ?? null, page: res.page ?? null, totalPages: res.totalPages ?? null, total: res.total ?? null };
  };

  return {
    Order: {
      // one read per page of orders, not per order: the loader key carries the viewer, so two areas never share
      cases: async (order: { id: string }, _args, ctx: GraphQLContext) => {
        if (ctx.area === 'admin') {
          const list = await load(ctx, 'cases:admin', order.id, async (ids) => new Map(Object.entries(await service.reads.listForOrders(ids, { area: 'admin' }))));
          return cases(list ?? [], 'admin');
        }
        if (ctx.area === 'seller') {
          const sellerId = sellerOf(ctx);
          if (!sellerId) return [];
          const list = await load(ctx, `cases:seller:${sellerId}`, order.id, async (ids) => new Map(Object.entries(await service.reads.listForOrders(ids, { area: 'seller', sellerId }))));
          return cases(list ?? [], 'seller');
        }
        const who = await shopper(ctx);
        const viewer = { area: 'store' as const, ...(who.customerId ? { customerId: who.customerId } : who.guestSessionId ? { guestSessionId: who.guestSessionId } : {}) };
        const list = await load(ctx, `cases:store:${who.customerId ?? who.guestSessionId ?? ''}`, order.id, async (ids) => new Map(Object.entries(await service.reads.listForOrders(ids, viewer))));
        return cases(list ?? [], 'store');
      },
    },
    Return: {
      case: async (ret: { id: string }, _args, ctx: GraphQLContext) => {
        if (!isUuid(ret?.id)) return null;
        const rows = await service.core.repo.find('cases', { return_id: ret.id }, { orderBy: [['opened_at', 'asc']] });
        const area = ctx.area;
        const v = area === 'admin' ? { area: 'admin' as const } : area === 'seller' ? { area: 'seller' as const, sellerId: sellerOf(ctx) ?? '' } : { area: 'store' as const, ...(await shopper(ctx)) };
        for (const r of rows) {
          if (!(await service.core.canSee(r, v))) continue;
          const agg = await service.core.load(r.id);
          return agg ? (await cases([agg], area))[0] : null;
        }
        return null;
      },
    },
    Customer: {
      openCases: async (customer: { id: string }, args: { limit?: number }) => {
        const limit = Math.min(Math.max(args?.limit ?? 3, 1), 50);
        const f = service.reads.storeFilter({ customerId: customer.id }, 'open');
        const [res, total] = await Promise.all([service.core.repo.listCases(f, 'updated', { mode: 'cursor', cursor: null, limit }), service.core.repo.countCases(f)]);
        return page({ ...res, total }, 'store');
      },
      cases: async (customer: { id: string }, args: { open?: boolean | null; paging?: common.PageInput | null }) => {
        const state = args?.open === true ? 'open' : args?.open === false ? 'closed' : 'all';
        return page(await service.core.repo.listCases(service.reads.storeFilter({ customerId: customer.id }, state), 'updated', service.reads.page(pageInput(args?.paging))), 'admin');
      },
    },
    Seller: {
      cases: async (seller: { id: string }, args: { open?: boolean | null; paging?: common.PageInput | null }) => {
        if (!isUuid(seller?.id)) return emptyPage;
        const f = service.reads.sellerFilter(seller.id, { ...(typeof args?.open === 'boolean' ? { open: args.open } : {}) });
        return page(await service.core.repo.listCases(f, 'updated', service.reads.page(pageInput(args?.paging))), 'admin');
      },
    },
    Query: {
      case: async (_root, args: { ref: string }, ctx: GraphQLContext) => {
        const who = await shopper(ctx);
        const agg = await service.core.byRef(args.ref);
        if (!agg || !(await service.core.canSee(agg.c, { area: 'store', ...who }))) return null;
        return (await cases([agg], 'store'))[0];
      },
      cases: async (_root, args: { open?: boolean | null; paging?: common.PageInput | null }, ctx: GraphQLContext) => {
        const customerId = await ctx.customerId();
        if (!customerId) return emptyPage;
        const state = args?.open === true ? 'open' : args?.open === false ? 'closed' : 'all';
        return page(await service.core.repo.listCases(service.reads.storeFilter({ customerId }, state), 'updated', service.reads.page(pageInput(args?.paging))), 'store');
      },
      sellerCase: async (_root, args: { ref: string }, ctx: GraphQLContext) => {
        const sellerId = sellerOf(ctx);
        const agg = await service.core.byRef(args.ref);
        if (!agg) return null;
        if (ctx.principal?.kind === 'staff') return (await cases([agg], 'admin'))[0];
        if (!sellerId || !(await service.core.canSee(agg.c, { area: 'seller', sellerId }))) return null;
        return (await cases([agg], 'seller'))[0];
      },
      caseAdmin: async (_root, args: { ref: string }) => {
        const agg = await service.core.byRef(args.ref);
        return agg ? (await cases([agg], 'admin'))[0] : null;
      },
    },
  };
};
