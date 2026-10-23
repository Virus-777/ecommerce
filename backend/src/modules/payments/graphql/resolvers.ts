import { createBatchLoader, gqlActor, gqlDeadline, gqlEnum, type GraphQLContext, lazy, type ModuleResolvers } from '../../../kernel/graphql/index.js';
import { isUuid } from '../../../kernel/lib/ids.js';
import type * as common from '../../../spec/common.js';
import type { Decline, Dispute, MethodSnapshot, PaymentDetail, Refund, RefundView, SavedPaymentMethod } from '../../../spec/payments.js';
import { CUSTOMER_STATE_LABEL, STATUS_LABEL } from '../domain/rules.js';
import type { PaymentsService } from '../service.js';

/* ---------------------------------------------------------------- REST shapes → GraphQL shapes (enums in capitals, Money.formatted) */

const actor = gqlActor;
const timeline = (list: readonly common.TimelineEvent[]) => list.map((t) => ({ ...t, detail: t.detail ?? null, actor: actor(t.actor) }));

const decline = (d: Decline | null | undefined) => (d ? { ...d, category: gqlEnum(d.category) } : null);
const snapshot = (m: MethodSnapshot) => ({ kind: gqlEnum(m.kind), brand: m.brand ?? null, last4: m.last4 ?? null, wallet: gqlEnum(m.wallet ?? null), label: m.label });
const savedMethod = (m: SavedPaymentMethod) => ({ ...m, kind: gqlEnum(m.kind) });

function payment(service: PaymentsService, p: PaymentDetail) {
  const inFlight = p.refunds.filter((r) => r.status === 'requested' || r.status === 'processing' || r.status === 'failed').reduce((s, r) => s + r.amount.amount, 0);
  const attempts = lazy(() => service.attemptsOf(p.id));
  return {
    id: p.id,
    state: gqlEnum(p.customerState),
    stateLabel: CUSTOMER_STATE_LABEL[p.customerState],
    methodLabel: p.method.label,
    method: snapshot(p.method),
    amount: p.amount ?? null,
    capturedAmount: p.capturedAmount ?? null,
    refundedAmount: p.refundedAmount ?? null,
    refundsInFlight: { amount: inFlight, currency: p.amount.currency },
    chargedAt: p.capturedAt ?? p.authorizedAt ?? null,
    ref: p.ref,
    status: gqlEnum(p.status),
    provider: p.provider,
    providerRef: p.providerRef ?? null,
    authorizedAmount: p.authorizedAmount ?? null,
    authorizedAt: p.authorizedAt ?? null,
    capturedAt: p.capturedAt ?? null,
    authorizationExpiresAt: p.authorizationExpiresAt ?? null,
    lastCheckedAt: p.lastCheckedAt ?? null,
    decline: async () => decline(p.decline ?? [...(await attempts())].reverse().find((a) => a.decline)?.decline ?? null),
    allocations: p.allocations.map((a) => ({ groupId: a.groupId, sellerId: a.sellerId ?? null, amount: a.amount ?? null })),
    captures: p.captures.map((c) => ({ ...c, groupId: c.groupId ?? null, providerRef: c.providerRef ?? null, amount: c.amount ?? null, status: gqlEnum(c.status) })),
    attempts: async () =>
      (await attempts()).map((a) => ({
        id: a.id,
        ref: a.ref,
        attemptNo: a.attempt_no,
        amount: { amount: a.amount, currency: a.currency },
        methodLabel: a.method.label,
        status: gqlEnum(a.status),
        statusLabel: STATUS_LABEL[a.status as keyof typeof STATUS_LABEL] ?? a.status,
        decline: decline(a.decline),
        createdAt: a.created_at.toISOString(),
      })),
    providerCalls: p.calls.map((c) => ({ ...c, providerRef: c.providerRef ?? null, message: c.message ?? null })),
  };
}

function refund(r: Refund, v: RefundView) {
  return {
    id: r.id,
    ref: r.ref,
    orderId: r.orderId,
    orderRef: r.orderRef,
    origin: gqlEnum(r.origin),
    originRef: r.originRef ?? null,
    items: r.items.map((i) => ({ orderItemId: i.orderItemId, title: i.title, groupId: i.groupId, amount: i.amount ?? null })),
    amount: r.amount ?? null,
    destination: gqlEnum(r.destination),
    destinationLabel: r.destinationLabel,
    status: gqlEnum(r.status),
    statusLabel: r.statusLabel,
    steps: v.steps,
    currentStep: v.currentStep,
    sentAt: r.sentAt ?? null,
    arrivalNote: r.arrivalNote,
    explanation: v.explanation,
    failure: v.failure ? { reason: v.failure.reason, action: gqlEnum(v.failure.action) } : null,
    createdAt: r.createdAt,
    attempts: r.attempts,
    maxAttempts: r.maxAttempts,
    outcomeUnknown: r.outcomeUnknown,
    failureCode: r.failureCode ?? null,
    failureReason: r.failureReason ?? null,
    nextStep: r.nextStep ?? null,
    providerRef: r.providerRef ?? null,
    reason: r.reason,
    requestedBy: actor(r.requestedBy),
    history: timeline(r.history),
  };
}

function dispute(d: Dispute) {
  return {
    id: d.id,
    ref: d.ref,
    kind: gqlEnum(d.kind),
    provider: d.provider,
    providerCaseId: d.providerCaseId,
    groupId: d.groupId ?? null,
    sellerName: d.sellerName ?? null,
    reasonCode: d.reasonCode,
    reason: d.reason,
    amount: d.amount ?? null,
    evidenceDue: gqlDeadline(d.evidenceDue),
    status: gqlEnum(d.status),
    statusLabel: d.statusLabel,
    sellerBalanceEffect: d.sellerBalanceEffect,
    evidenceText: d.evidence.text ?? null,
    evidenceFiles: d.evidence.files,
    evidenceSubmittedAt: d.evidence.submittedAt ?? null,
    owner: d.owner ?? null,
    history: timeline(d.history),
    openedAt: d.openedAt,
    decidedAt: d.decidedAt ?? null,
  };
}

/**
 * Resolvers for the GraphQL fields this module owns (`@source(module: "payments", …)` in graphql/schema.ts).
 * The parent Order was already resolved with the viewer's record scope by orders; Customer.paymentMethods
 * answers only for the signed-in customer's own record.
 */
export const resolvers = (service: PaymentsService): ModuleResolvers => {
  const load = createBatchLoader();
  return {
  Order: {
    payment: async (root: { id: string }, _args: unknown, ctx: GraphQLContext) => {
      if (!isUuid(root.id)) return null;
      const p = await load<PaymentDetail>(ctx, 'payment-for-order', root.id, async (ids) => {
        const byOrder = await service.paymentsForOrders(ids);
        const out = new Map<string, PaymentDetail>();
        for (const [id, detail] of Object.entries(byOrder)) if (detail) out.set(id, detail);
        return out;
      });
      return p ? payment(service, p) : null;
    },
    refunds: async (root: { id: string }, _args: unknown, ctx: GraphQLContext) => {
      if (!isUuid(root.id)) return [];
      const list = await load(ctx, 'refunds-for-order', root.id, async (ids) => new Map(Object.entries(await service.refundsWithViewsForOrders(ids))));
      return (list ?? []).map(({ refund: r, view: v }) => refund(r, v));
    },
    refundable: async (root: { id: string }) => {
      if (!isUuid(root.id)) return null;
      // Deliberately not batched (docs/10 Appendix D): remainingRefundable goes through intentOfOrder's fallback,
      // which links an intent to an order — a write — and through caps(), which would need its own batching.
      // No persisted list query selects this field; it belongs to the order detail screens.
      const s = await service.remainingRefundable(root.id).catch(() => null);
      if (!s) return null;
      return {
        captured: s.captured ?? null,
        refunded: s.refunded ?? null,
        inFlight: s.inFlight ?? null,
        remaining: s.remaining ?? null,
        items: s.items.map((i) => ({ ...i, paid: i.paid ?? null, refunded: i.refunded ?? null, inFlight: i.inFlight ?? null, remaining: i.remaining ?? null, blockedReason: i.blockedReason ?? null })),
      };
    },
    paymentDisputes: async (root: { id: string }, _args: unknown, ctx: GraphQLContext) => {
      if (!isUuid(root.id)) return [];
      const list = await load(ctx, 'disputes-for-order', root.id, async (ids) => new Map(Object.entries(await service.disputesForOrders(ids))));
      return (list ?? []).map(dispute);
    },
  },
  Customer: {
    paymentMethods: async (root: { id: string }, _args: unknown, ctx: GraphQLContext) => {
      if (ctx.principal?.kind !== 'customer') return [];
      const own = (await ctx.customerId()) ?? ctx.principal.accountId ?? null;
      if (!own || (root.id !== own && root.id !== ctx.principal.accountId)) return [];
      return (await service.listSavedMethods(own)).map(savedMethod);
    },
  },
  };
};
