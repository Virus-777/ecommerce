import { gqlActor, gqlDeadline, gqlEnum, type GraphQLContext, type ModuleResolvers, pageInput } from '../../../kernel/graphql/index.js';
import { format as formatMoney } from '../../../kernel/lib/money.js';
import type * as common from '../../../spec/common.js';
import type { EffectiveTerms, RefundBreakdown, RefundRequest, ReturnCase, ReturnDetail } from '../../../spec/returns.js';
import { OPEN_STATUSES } from '../domain/rules.js';
import type { Agg } from '../service/core.js';
import type { ReturnsService } from '../service.js';

/**
 * Resolvers for the GraphQL fields this module owns (`@source(module: "returns", …)` in graphql/schema.ts).
 * Same record scope as REST: store callers see their own returns (or a guest session's), sellers only their
 * own returns, staff everything. REST shapes are mapped to GraphQL shapes (enums in capitals, Money.formatted).
 */

const money = (m: common.Money | null | undefined) => (m ? { ...m, formatted: formatMoney(m) } : null);
const actor = gqlActor;
const timeline = (list: readonly common.TimelineEvent[]) => list.map((t) => ({ at: t.at, label: t.label, detail: t.detail ?? null, actor: actor(t.actor) }));
const options = (o: Record<string, string> | null | undefined) => Object.entries(o ?? {}).map(([name, value]) => ({ name, value }));
const steps = (s: { key: string; label: string; state: string }[]) => s.map((x) => ({ ...x, state: gqlEnum(x.state) }));

const breakdown = (b: RefundBreakdown) => ({
  itemAmount: money(b.itemAmount),
  discountShare: money(b.discountShare),
  shippingRefund: money(b.shippingRefund),
  returnShippingDeduction: money(b.returnShippingDeduction),
  deductions: b.deductions.map((d) => ({ label: d.label, amount: money(d.amount), reason: d.reason })),
  total: money(b.total),
  maxRefundable: money(b.maxRefundable),
  destination: b.destination,
  isEstimate: b.isEstimate,
});

export const terms = (t: EffectiveTerms) => ({
  windowDays: t.windowDays,
  changeOfMindAllowed: t.changeOfMindAllowed,
  condition: t.condition ?? null,
  responsibilities: t.responsibilities.map((r) => ({ reasonGroup: gqlEnum(r.reasonGroup), paidBy: gqlEnum(r.paidBy), customerFee: money(r.customerFee), originalShippingRefunded: r.originalShippingRefunded, officialStoreRule: r.officialStoreRule ?? null, note: r.note ?? null })),
  remedies: t.remedies.map(gqlEnum),
  responseTargetBusinessDays: t.responseTargetBusinessDays,
  summary: t.summary,
  policyVersion: t.policyVersion,
  sellerTermsVersion: t.sellerTermsVersion ?? null,
  source: gqlEnum(t.source),
});

const impact = (e: ReturnCase['earningsImpact']) =>
  e ? { refundToCustomer: money(e.refundToCustomer), sellerEarningsChange: money(e.sellerEarningsChange), feeReturned: money(e.feeReturned), labelCharge: money(e.labelCharge), labelChargeEstimated: e.labelChargeEstimated, totalBalanceChange: money(e.totalBalanceChange), afterPayout: e.afterPayout, note: e.note } : null;

export const refundRequest = (r: RefundRequest) => ({
  ...r,
  returnId: r.returnId ?? null,
  returnRef: r.returnRef ?? null,
  caseId: r.caseId ?? null,
  source: gqlEnum(r.source),
  ownerType: gqlEnum(r.ownerType),
  sellerId: r.sellerId ?? null,
  status: gqlEnum(r.status),
  breakdown: breakdown(r.breakdown),
  fundedBy: gqlEnum(r.fundedBy),
  sellerShare: money(r.sellerShare),
  platformShare: money(r.platformShare),
  earningsImpact: impact(r.earningsImpact),
  proposedBy: actor(r.proposedBy),
  approvedBy: actor(r.approvedBy),
  history: timeline(r.history),
  approval: r.approval ?? null,
  trustReportId: r.trustReportId ?? null,
});

/** The GraphQL Return from the customer's detail, plus the seller and staff case when there is one */
export function gqlReturn(d: ReturnDetail, c?: ReturnCase | null) {
  const open = (OPEN_STATUSES as string[]).includes(d.status);
  return {
    id: d.id,
    ref: d.ref,
    orderId: d.orderId,
    orderRef: d.orderRef,
    ownerType: gqlEnum(d.seller.ownerType),
    sellerId: d.seller.id ?? null,
    sellerName: d.seller.name,
    status: gqlEnum(d.status),
    // seller and admin areas (with the case): the seller and staff wording their lists use, not the customer's
    statusLabel: c ? c.statusLabel : d.statusLabel,
    track: steps(d.track),
    items: d.items.map((i) => ({ ...i, sku: i.sku ?? null, imageUrl: i.imageUrl ?? null, options: options(i.options), unitPrice: money(i.unitPrice) })),
    itemCount: d.items.reduce((n, i) => n + i.quantity, 0),
    reason: d.reason,
    details: d.details || null,
    media: d.media,
    remedy: gqlEnum(d.remedy),
    handledBy: gqlEnum(d.handledBy),
    responseDue: gqlDeadline(d.responseDue),
    infoRequest: d.infoRequest ? { ...d.infoRequest, askedBy: actor(d.infoRequest.askedBy), reply: d.infoRequest.reply ?? null, repliedAt: d.infoRequest.repliedAt ?? null } : null,
    decision: d.decision ? { ...d.decision, kind: gqlEnum(d.decision.kind), reasonCode: d.decision.reasonCode ?? null, explanation: d.decision.explanation ?? null, decidedBy: actor(d.decision.decidedBy) } : null,
    shipment: d.shipment
      ? {
          ...d.shipment,
          status: gqlEnum(d.shipment.status),
          method: gqlEnum(d.shipment.method),
          cost: money(d.shipment.cost),
          paidBy: gqlEnum(d.shipment.paidBy),
          dropOffPoints: d.shipment.dropOffPoints.map((p) => ({ name: p.name, address: p.address, distanceMiles: p.distanceMiles ?? null, hours: p.hours ?? null })),
          events: timeline(d.shipment.events),
        }
      : null,
    refund: d.refund ? { ...d.refund, status: gqlEnum(d.refund.status), track: steps(d.refund.track), breakdown: breakdown(d.refund.breakdown) } : null,
    refundEstimate: d.refundEstimate ? breakdown(d.refundEstimate) : null,
    replacement: d.replacement ? { ...d.replacement, kind: gqlEnum(d.replacement.kind), status: gqlEnum(d.replacement.status), options: options(d.replacement.options) } : null,
    terms: terms(d.terms),
    escalation: d.escalation ? { ...d.escalation, by: actor(d.escalation.by), reason: gqlEnum(d.escalation.reason), note: d.escalation.note ?? null, caseId: d.escalation.caseId ?? null, caseRef: d.escalation.caseRef ?? null } : null,
    timeline: timeline(d.timeline),
    nextStep: d.nextStep,
    nextDeadline: gqlDeadline(c ? (c.deadlines.respondBy ?? c.deadlines.dropOffBy ?? c.deadlines.inspectBy ?? c.deadlines.refundBy) : (d.responseDue ?? null)),
    open,
    requestedAt: d.requestedAt,
    actions: d.actions.map(gqlEnum),
    // seller and staff
    customer: c?.customer ?? null,
    payment: c
      ? { itemPaid: money(c.payment.itemPaid), shippingPaid: money(c.payment.shippingPaid), discountShare: money(c.payment.discountShare), maxRefundable: money(c.payment.maxRefundable), refundedSoFar: money(c.payment.refundedSoFar), methodLabel: c.payment.methodLabel }
      : null,
    shippingPaidBy: c ? gqlEnum(c.shippingPaidBy) : null,
    deadlines: c ? { respondBy: gqlDeadline(c.deadlines.respondBy), inspectBy: gqlDeadline(c.deadlines.inspectBy), refundBy: gqlDeadline(c.deadlines.refundBy), dropOffBy: gqlDeadline(c.deadlines.dropOffBy) } : null,
    inspection: c?.inspection
      ? {
          ...c.inspection,
          inspectedBy: actor(c.inspection.inspectedBy),
          conditionOutcome: gqlEnum(c.inspection.conditionOutcome),
          grade: gqlEnum(c.inspection.grade),
          proposedStockOutcome: gqlEnum(c.inspection.proposedStockOutcome),
          stockOutcomeRecordedBy: actor(c.inspection.stockOutcomeRecordedBy),
        }
      : null,
    refundRequest: c?.refundRequest ? refundRequest(c.refundRequest) : null,
    earningsImpact: impact(c?.earningsImpact),
    platformInvolved: c ? c.flags.some((f) => ['platform_took_over', 'customer_escalated', 'dispute_open', 'seller_missed_deadline'].includes(f.kind)) || d.handledBy === 'marketplace_support' : false,
    flags: (c?.flags ?? []).map((f) => ({ kind: gqlEnum(f.kind), label: f.label })),
    activity: timeline(c?.activity ?? []),
    allowedActions: c?.allowedActions ?? [],
    owner: actor(c?.owner),
    exception: c?.exception ? { ...c.exception, proposedBy: actor(c.exception.proposedBy), approvedBy: actor(c.exception.approvedBy) } : null,
    inspectionChecklist: c?.inspectionChecklist ? { ...c.inspectionChecklist, serialShipped: c.inspectionChecklist.serialShipped ?? null, items: c.inspectionChecklist.items.map((i) => ({ ...i, kind: gqlEnum(i.kind), expected: i.expected ?? null })) } : null,
    inspectionDraft: c?.inspectionDraft ? { ...c.inspectionDraft, remedy: c.inspectionDraft.remedy ?? null, photos: c.inspectionDraft.inspection.media, savedBy: actor(c.inspectionDraft.savedBy) } : null,
    inspector: actor(c?.inspector),
    evidence: (c?.evidence ?? []).map((e) => ({ ...e, kind: gqlEnum(e.kind), addedBy: actor(e.addedBy), caseId: e.caseId ?? null })),
  };
}

const fromCase = (c: ReturnCase) => gqlReturn(c.detail, c);

export const resolvers = (service: ReturnsService): ModuleResolvers => {
  /** The store viewer: customer id or guest session */
  const shopper = async (ctx: GraphQLContext) => {
    const p = ctx.principal;
    if (p?.kind === 'visitor') return { customerId: null, guestSessionId: p.guestSessionId ?? p.sessionId };
    return { customerId: await ctx.customerId(), guestSessionId: null };
  };
  const sellerOf = (ctx: GraphQLContext) => (ctx.principal?.kind === 'seller' ? (ctx.principal.sellerId ?? null) : null);

  /** A page of returns as GraphQL Returns for an area */
  const page = async (res: common.Page<{ id: string }>, area: 'store' | 'seller' | 'admin') => {
    const aggs = await service.core.loadMany(res.items.map((r) => r.id));
    const list = res.items.map((r) => aggs.get(r.id)).filter((a): a is Agg => !!a);
    const items = area === 'store' ? (await service.views.details(list, 'store')).map((d) => gqlReturn(d)) : (await Promise.all(list.map((a) => service.views.returnCase(a, area)))).map(fromCase);
    return { ...res, items, nextCursor: res.nextCursor ?? null, page: res.page ?? null, totalPages: res.totalPages ?? null, total: res.total ?? null };
  };

  return {
    Order: {
      returns: async (order: { id: string }, _args, ctx: GraphQLContext) => {
        if (ctx.area === 'admin') return (await service.listForOrder(order.id, { area: 'admin' })).map(fromCase);
        if (ctx.area === 'seller') {
          const sellerId = sellerOf(ctx);
          return sellerId ? (await service.listForOrder(order.id, { area: 'seller', sellerId })).map(fromCase) : [];
        }
        const who = await shopper(ctx);
        const list = await service.reads.listForOrder(order.id, { area: 'store', customerId: who.customerId ?? undefined, guestSessionId: who.guestSessionId ?? undefined });
        return list.map((c) => gqlReturn(c.detail));
      },
      refundRequests: async (order: { id: string }) => (await service.listRefundRequestsForOrder(order.id)).map(refundRequest),
    },
    OrderItem: {
      returnEligibility: async (item: { id: string; state?: string | null; quantity: number; deliveredAt?: string | null; returnWindowEndsAt?: string | null; returnTerms?: { windowDays?: number } | null }) => {
        const [e] = await service.reads.eligibilityFromFacts([
          { orderItemId: item.id, state: String(item.state ?? '').toLowerCase(), quantity: item.quantity, deliveredAt: item.deliveredAt ?? null, returnWindowEndsAt: item.returnWindowEndsAt ?? null, windowDays: item.returnTerms?.windowDays ?? 0 },
        ]);
        if (!e) return null;
        return {
          eligible: e.eligible,
          ineligibleReason: gqlEnum(e.ineligibleReason),
          message: e.message,
          quantityPurchased: e.quantityPurchased,
          quantityReturnable: e.quantityReturnable,
          returnBy: e.returnBy,
          latestReturn: e.latestReturn ? { ...e.latestReturn, status: gqlEnum(e.latestReturn.status), refundStatus: gqlEnum(e.latestReturn.refundStatus) } : null,
        };
      },
    },
    Customer: {
      returnsOverview: async (customer: { id: string }) => {
        const o = await service.customerOverview(customer.id);
        return { ...o, openNote: o.openNote ?? null, refundsOnTheWay: money(o.refundsOnTheWay), refundsOnTheWayNote: o.refundsOnTheWayNote ?? null, refundedThisYear: money(o.refundedThisYear) };
      },
      openReturns: async (customer: { id: string }, args: { limit?: number }) => {
        const f = service.reads.storeFilter({ customerId: customer.id }, 'open');
        const [res, total] = await Promise.all([service.core.repo.listReturns(f, { mode: 'cursor', cursor: null, limit: Math.min(Math.max(args?.limit ?? 3, 1), 50) }), service.core.repo.countReturns(f)]);
        return page({ ...res, total }, 'store');
      },
      returns: async (customer: { id: string }, args: { state?: string; paging?: common.PageInput | null }) => {
        const state = String(args?.state ?? 'ALL').toLowerCase();
        const res = await service.core.repo.listReturns(service.reads.storeFilter({ customerId: customer.id }, state), service.reads.page(pageInput(args?.paging)));
        return page(res, 'admin');
      },
    },
    Seller: {
      returnCounts: async (seller: { id: string }, _args, ctx: GraphQLContext) => {
        const sellerId = sellerOf(ctx);
        if (ctx.principal?.kind === 'seller' && sellerId !== seller.id) return null;
        const c = await service.sellerQueueCounts(seller.id);
        return { ...c, overdueRef: c.overdueRef ?? null, nextResponseDueAt: c.nextResponseDueAt ?? null, oldestReceivedAt: c.oldestReceivedAt ?? null, nextEvidenceDueAt: c.nextEvidenceDueAt ?? null };
      },
      returns: async (seller: { id: string }, args: { state?: string; paging?: common.PageInput | null }) => {
        const state = String(args?.state ?? 'OPEN').toLowerCase();
        const f = { sellerId: seller.id, ownerType: 'seller' as const, ...(state === 'open' ? { statuses: OPEN_STATUSES } : state === 'completed' ? { statuses: ['completed', 'cancelled', 'rejected'] } : {}) };
        return page(await service.core.repo.listReturns(f, service.reads.page(pageInput(args?.paging))), 'admin');
      },
      returnTerms: async (seller: { id: string }) => {
        const t = (await service.sellerReturnTermsFor([seller.id]))[seller.id];
        return t ? terms(t) : null;
      },
    },
    Case: {
      refundRequests: async (c: { id: string }) => (await service.listRefundRequestsForCase(c.id)).map(refundRequest),
    },
    Query: {
      return: async (_root, args: { ref: string }, ctx: GraphQLContext) => {
        const who = await shopper(ctx);
        const d = await service.getReturnForCustomer(who.customerId, who.guestSessionId, args.ref);
        return d ? gqlReturn(d) : null;
      },
      returns: async (_root, args: { state?: string; paging?: common.PageInput | null }, ctx: GraphQLContext) => {
        const customerId = await ctx.customerId();
        if (!customerId) return { items: [], nextCursor: null, page: null, totalPages: null, total: 0 };
        const state = String(args?.state ?? 'OPEN').toLowerCase();
        return page(await service.core.repo.listReturns(service.reads.storeFilter({ customerId }, state), service.reads.page(pageInput(args?.paging))), 'store');
      },
      sellerReturn: async (_root, args: { ref: string }, ctx: GraphQLContext) => {
        const sellerId = sellerOf(ctx);
        if (!sellerId) return null;
        const c = await service.getReturnForSeller(sellerId, args.ref);
        return c ? fromCase(c) : null;
      },
      returnAdmin: async (_root, args: { ref: string }) => {
        const c = await service.getReturnAdmin(args.ref);
        return c ? fromCase(c) : null;
      },
      refundRequests: async (_root, args: { status?: string | null; source?: string | null; paging?: common.PageInput | null }) => {
        const res = await service.listRefundRequests({ ...(args?.status ? { status: args.status.toLowerCase() } : {}), ...(args?.source ? { source: args.source.toLowerCase() } : {}) }, pageInput(args?.paging));
        return { ...res, items: res.items.map(refundRequest), nextCursor: res.nextCursor ?? null, page: res.page ?? null, totalPages: res.totalPages ?? null, total: res.total ?? null };
      },
      refundRequest: async (_root, args: { ref: string }) => {
        const r = await service.getRefundRequest(args.ref);
        return r ? refundRequest(r) : null;
      },
    },
  };
};
