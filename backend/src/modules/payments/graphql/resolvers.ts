import { gqlActor, type GraphQLContext, type ModuleResolvers } from '../../../kernel/graphql/index.js';
import { isUuid } from '../../../kernel/lib/ids.js';
import { format as formatMoney } from '../../../kernel/lib/money.js';
import type * as common from '../../../spec/common.js';
import type { Decline, Dispute, MethodSnapshot, PaymentDetail, Refund, RefundView, SavedPaymentMethod } from '../../../spec/payments.js';
import { CUSTOMER_STATE_LABEL, STATUS_LABEL } from '../domain/rules.js';
import type { PaymentsService } from '../service.js';

/* ---------------------------------------------------------------- REST shapes → GraphQL shapes (enums in capitals, Money.formatted) */

const upper = (s: string | null | undefined) => (s ? s.toUpperCase() : (s ?? null));
const money = (m: common.Money | null | undefined) => (m ? { ...m, formatted: formatMoney(m) } : null);
const actor = gqlActor;
const timeline = (list: readonly common.TimelineEvent[]) => list.map((t) => ({ ...t, detail: t.detail ?? null, actor: actor(t.actor) }));
const deadline = (d: common.Deadline | null | undefined) => (d ? { dueAt: d.dueAt, state: upper(d.state) } : null);
const lazy = <T>(f: () => Promise<T>) => {
  let p: Promise<T> | undefined;
  return () => (p ??= f());
};

const decline = (d: Decline | null | undefined) => (d ? { ...d, category: upper(d.category) } : null);
const snapshot = (m: MethodSnapshot) => ({ kind: upper(m.kind), brand: m.brand ?? null, last4: m.last4 ?? null, wallet: upper(m.wallet ?? null), label: m.label });
const savedMethod = (m: SavedPaymentMethod) => ({ ...m, kind: upper(m.kind) });

function payment(service: PaymentsService, p: PaymentDetail) {
  const inFlight = p.refunds.filter((r) => r.status === 'requested' || r.status === 'processing' || r.status === 'failed').reduce((s, r) => s + r.amount.amount, 0);
  const attempts = lazy(() => service.attemptsOf(p.id));
  return {
    id: p.id,
    state: upper(p.customerState),
    stateLabel: CUSTOMER_STATE_LABEL[p.customerState],
    methodLabel: p.method.label,
    method: snapshot(p.method),
    amount: money(p.amount),
    capturedAmount: money(p.capturedAmount),
    refundedAmount: money(p.refundedAmount),
    refundsInFlight: money({ amount: inFlight, currency: p.amount.currency }),
    chargedAt: p.capturedAt ?? p.authorizedAt ?? null,
    ref: p.ref,
    status: upper(p.status),
    provider: p.provider,
    providerRef: p.providerRef ?? null,
    authorizedAmount: money(p.authorizedAmount),
    authorizedAt: p.authorizedAt ?? null,
    capturedAt: p.capturedAt ?? null,
    authorizationExpiresAt: p.authorizationExpiresAt ?? null,
    lastCheckedAt: p.lastCheckedAt ?? null,
    decline: async () => decline(p.decline ?? [...(await attempts())].reverse().find((a) => a.decline)?.decline ?? null),
    allocations: p.allocations.map((a) => ({ groupId: a.groupId, sellerId: a.sellerId ?? null, amount: money(a.amount) })),
    captures: p.captures.map((c) => ({ ...c, groupId: c.groupId ?? null, providerRef: c.providerRef ?? null, amount: money(c.amount), status: upper(c.status) })),
    attempts: async () =>
      (await attempts()).map((a) => ({
        id: a.id,
        ref: a.ref,
        attemptNo: a.attempt_no,
        amount: money({ amount: a.amount, currency: a.currency }),
        methodLabel: a.method.label,
        status: upper(a.status),
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
    origin: upper(r.origin),
    originRef: r.originRef ?? null,
    items: r.items.map((i) => ({ orderItemId: i.orderItemId, title: i.title, groupId: i.groupId, amount: money(i.amount) })),
    amount: money(r.amount),
    destination: upper(r.destination),
    destinationLabel: r.destinationLabel,
    status: upper(r.status),
    statusLabel: r.statusLabel,
    steps: v.steps,
    currentStep: v.currentStep,
    sentAt: r.sentAt ?? null,
    arrivalNote: r.arrivalNote,
    explanation: v.explanation,
    failure: v.failure ? { reason: v.failure.reason, action: upper(v.failure.action) } : null,
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
    kind: upper(d.kind),
    provider: d.provider,
    providerCaseId: d.providerCaseId,
    groupId: d.groupId ?? null,
    sellerName: d.sellerName ?? null,
    reasonCode: d.reasonCode,
    reason: d.reason,
    amount: money(d.amount),
    evidenceDue: deadline(d.evidenceDue),
    status: upper(d.status),
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
export const resolvers = (service: PaymentsService): ModuleResolvers => ({
  Order: {
    payment: async (root: { id: string }) => {
      if (!isUuid(root.id)) return null;
      const p = await service.getPaymentForOrder(root.id);
      return p ? payment(service, p) : null;
    },
    refunds: async (root: { id: string }) => (isUuid(root.id) ? (await service.refundsWithViews(root.id)).map(({ refund: r, view: v }) => refund(r, v)) : []),
    refundable: async (root: { id: string }) => {
      if (!isUuid(root.id)) return null;
      const s = await service.remainingRefundable(root.id).catch(() => null);
      if (!s) return null;
      return {
        captured: money(s.captured),
        refunded: money(s.refunded),
        inFlight: money(s.inFlight),
        remaining: money(s.remaining),
        items: s.items.map((i) => ({ ...i, paid: money(i.paid), refunded: money(i.refunded), inFlight: money(i.inFlight), remaining: money(i.remaining), blockedReason: i.blockedReason ?? null })),
      };
    },
    paymentDisputes: async (root: { id: string }) => (isUuid(root.id) ? (await service.listDisputesForOrder(root.id)).map(dispute) : []),
  },
  Customer: {
    paymentMethods: async (root: { id: string }, _args: unknown, ctx: GraphQLContext) => {
      if (ctx.principal?.kind !== 'customer') return [];
      const own = (await ctx.customerId()) ?? ctx.principal.accountId ?? null;
      if (!own || (root.id !== own && root.id !== ctx.principal.accountId)) return [];
      return (await service.listSavedMethods(own)).map(savedMethod);
    },
  },
});
