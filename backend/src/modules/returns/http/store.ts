import type { Principal } from '../../../kernel/auth/index.js';
import type { Scope } from '../../../kernel/auth/scope.js';
import { routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/returns.js';
import type { Shopper } from '../service/requests.js';
import type { ReturnsService } from '../service.js';

/** The shopper behind a store request: a signed-in customer or a guest (visitor) session */
export const shopperOf = (scope: Scope, principal: Principal): Shopper =>
  scope.kind === 'customer'
    ? { customerId: scope.customerId, accountId: scope.accountId }
    : scope.kind === 'visitor'
      ? { guestSessionId: principal.guestSessionId ?? scope.visitorSessionId }
      : principal.kind === 'visitor'
        ? { guestSessionId: principal.guestSessionId ?? principal.sessionId }
        : { accountId: principal.accountId ?? null };

/**
 * Store API: /api/store/returns/…  (docs/api/modules/returns.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const storeRoutes = (service: ReturnsService) => {
  const mine = async (id: string, scope: Scope, principal: Principal) => {
    const who = shopperOf(scope, principal);
    return { who, agg: await service.core.visible(id, { area: 'store', customerId: who.customerId, guestSessionId: who.guestSessionId }) };
  };
  const detail = async (id: string) => (await service.views.details([(await service.core.load(id))!], 'store'))[0]!;

  return routes(endpoints, 'store', {
    /** GET /policy: Current returns baseline, category exceptions and who pays return shipping */
    getPublicPolicy: async () => service.policies.publicPolicy(),
    /** GET /terms: Effective return terms for a seller and category */
    getEffectiveTerms: async ({ query }) => service.policies.resolveTerms(query.sellerId, query.categoryId ?? null, query.condition ?? null),
    /** GET /orders/{orderId}/returnable-items: Items of an order with per-item return eligibility */
    listReturnableItems: async ({ params, scope, principal }) => service.requests.returnableItems(params.orderId, shopperOf(scope, principal)),
    /** POST /eligibility: Eligibility, deadline, destination, shipping responsibility, remedies and refund estimate before submission */
    checkEligibility: async ({ body, scope, principal }) => service.requests.checkEligibility(body, shopperOf(scope, principal)),
    /** POST /requests: Request a return for selected items and quantities */
    createReturn: async ({ body, scope, principal, actor, requestId }) => {
      const aggs = await service.requests.create(body, shopperOf(scope, principal), { actor, requestId, principal });
      return { returns: await service.views.details(aggs, 'store') };
    },
    /** GET /requests/overview: Return and refund totals for the account */
    getCustomerOverview: async ({ scope }) => {
      const customerId = scope.kind === 'customer' ? scope.customerId : null;
      if (!customerId) return { openReturns: 0, openNote: null, refundsOnTheWay: { amount: 0, currency: service.core.currency }, refundsOnTheWayNote: null, refundedThisYear: { amount: 0, currency: service.core.currency }, completedThisYear: 0 };
      return service.reads.customerOverview(customerId);
    },
    /** GET /requests: My returns with return status and refund status side by side */
    listCustomerReturns: async ({ query, page, scope, principal }) => service.reads.listMine(shopperOf(scope, principal), { state: query.state, orderId: query.orderId }, page),
    /** GET /requests/{id}: Return detail: status track, drop-off, return shipment, refund or replacement progress */
    getCustomerReturn: async ({ params, scope, principal }) => {
      const { agg } = await mine(params.id, scope, principal);
      return (await service.views.details([agg], 'store'))[0]!;
    },
    /** POST /requests/{id}/info: Answer the seller's or Marketly's question */
    replyToInfoRequest: async ({ params, body, scope, principal, actor, requestId }) => {
      const { who, agg } = await mine(params.id, scope, principal);
      await service.requests.reply(agg, body, who, { actor, requestId, principal });
      return detail(agg.ret.id);
    },
    /** POST /requests/{id}/withdraw: Cancel a return before the item is sent back */
    withdrawReturn: async ({ params, body, scope, principal, actor, requestId }) => {
      const { agg } = await mine(params.id, scope, principal);
      await service.requests.withdraw(agg, body.reason, { actor, requestId, principal });
      return detail(agg.ret.id);
    },
    /** GET /requests/{id}/label: Drop-off QR code, printable label, instructions and nearby drop-off points */
    getReturnLabel: async ({ params, query, scope, principal }) => {
      const { agg } = await mine(params.id, scope, principal);
      return service.requests.label(agg, query.near);
    },
    /** POST /requests/{id}/label/email: Email the drop-off code to the customer */
    emailReturnLabel: async ({ params, scope, principal }) => {
      const { who, agg } = await mine(params.id, scope, principal);
      await service.requests.emailLabel(agg, who);
    },
    /** POST /requests/{id}/shipment: Add carrier and tracking for a customer-arranged return */
    addCustomerTracking: async ({ params, body, scope, principal, actor, requestId }) => {
      const { agg } = await mine(params.id, scope, principal);
      await service.requests.addTracking(agg, body, { actor, requestId, principal });
      return detail(agg.ret.id);
    },
    /** POST /requests/{id}/escalate: Ask Marketly to step in */
    escalateReturn: async ({ params, body, scope, principal, actor, requestId }) => {
      const { who, agg } = await mine(params.id, scope, principal);
      await service.requests.escalate(agg, body, who, { actor, requestId, principal });
      return detail(agg.ret.id);
    },
  });
};
