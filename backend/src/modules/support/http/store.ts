import type { Principal } from '../../../kernel/auth/index.js';
import type { Scope } from '../../../kernel/auth/scope.js';
import { routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/support.js';
import type { Shopper } from '../service/cases.js';
import type { SupportService } from '../service.js';

/** The shopper behind a store request: a signed-in customer or a guest (visitor) session */
export const shopperOf = (scope: Scope, principal: Principal): Shopper =>
  scope.kind === 'customer'
    ? { customerId: scope.customerId ?? scope.accountId, accountId: scope.accountId }
    : scope.kind === 'visitor'
      ? { guestSessionId: principal.guestSessionId ?? scope.visitorSessionId }
      : principal.kind === 'visitor'
        ? { guestSessionId: principal.guestSessionId ?? principal.sessionId }
        : { accountId: principal.accountId ?? null, customerId: null };

/**
 * Store API: /api/store/support/…  (docs/api/modules/support.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const storeRoutes = (service: SupportService) => {
  const mine = async (id: string, scope: Scope, principal: Principal) => {
    const who = shopperOf(scope, principal);
    return { who, agg: await service.core.visible(id, { area: 'store', customerId: who.customerId, guestSessionId: who.guestSessionId }) };
  };
  const detail = async (id: string) => service.views.view((await service.core.load(id))!, 'store');

  return routes(endpoints, 'store', {
    /** GET /contact-options: Topics, channels, hours and expected reply times */
    getContactOptions: async () => service.reads.contactOptions(),
    /** GET /orders/{orderId}/problem-context: Order problem form context: packages and items, who handles first, when Marketly steps in, open cases */
    getProblemContext: async ({ params, query, scope, principal }) => service.reads.problemContext(params.orderId, shopperOf(scope, principal), query.orderItemId ?? null),
    /** POST /cases: Contact support or report an order problem (missing, damaged, wrong item, not arrived) */
    createCase: async ({ body, scope, principal, actor, requestId }) => {
      const agg = await service.cases.createForShopper(body, shopperOf(scope, principal), { actor, requestId, principal });
      return service.views.view(agg, 'store');
    },
    /** GET /cases: My cases with who handles them, the next action and the expected reply */
    listCustomerCases: async ({ query, page, scope, principal }) => service.reads.listMine(shopperOf(scope, principal), query.state ?? 'all', page),
    /** GET /cases/{id}: Case detail: handler, next action and expected response, linked items, conversation, decision, remedy progress, appeal and reopen rules */
    getCustomerCase: async ({ params, scope, principal }) => service.views.view((await mine(params.id, scope, principal)).agg, 'store'),
    /** POST /cases/{id}/messages: Reply on a case (with photos) */
    customerReply: async ({ params, body, scope, principal, actor, requestId }) => {
      const { who, agg } = await mine(params.id, scope, principal);
      await service.cases.customerReply(agg, body, who, { actor, requestId, principal });
      return detail(agg.c.id);
    },
    /** POST /cases/{id}/escalate: Ask Marketly to step in */
    customerEscalate: async ({ params, body, scope, principal, actor, requestId }) => {
      const { agg } = await mine(params.id, scope, principal);
      await service.cases.customerEscalate(agg, body, { actor, requestId, principal });
      return detail(agg.c.id);
    },
    /** POST /cases/{id}/offers/{offerId}/respond: Accept or decline the seller's offer */
    respondToOffer: async ({ params, body, scope, principal, actor, requestId }) => {
      const { agg } = await mine(params.id, scope, principal);
      await service.cases.respondToOffer(agg, params.offerId, body, { actor, requestId, principal }, { fromOffer: (a, o, by) => service.decisions.fromOffer(a, o, by) });
      return detail(agg.c.id);
    },
    /** POST /cases/{id}/appeal: Appeal a decision before the appeal deadline */
    customerAppeal: async ({ params, body, scope, principal, actor, requestId }) => {
      const { agg } = await mine(params.id, scope, principal);
      await service.decisions.appeal(agg, body, 'customer', { actor, requestId, principal });
      return detail(agg.c.id);
    },
    /** POST /cases/{id}/reopen: Reopen a resolved case within the reopen window */
    customerReopen: async ({ params, body, scope, principal, actor, requestId }) => {
      const { agg } = await mine(params.id, scope, principal);
      await service.decisions.reopen(agg, body, 'customer', { actor, requestId, principal });
      return detail(agg.c.id);
    },
  });
};
