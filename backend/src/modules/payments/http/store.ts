import { AppError } from '../../../kernel/errors/index.js';
import type { Principal } from '../../../kernel/auth/index.js';
import type { Scope } from '../../../kernel/auth/scope.js';
import { routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/payments.js';
import type { PaymentsService } from '../service.js';

/** The signed-in customer's customer id (customers), or the account id while customers is off */
const customerOf = (scope: Scope, principal: Principal | null): string | null => (scope.kind === 'customer' ? (scope.customerId ?? principal?.accountId ?? null) : null);

const mustCustomer = (scope: Scope, principal: Principal | null): string => {
  const id = customerOf(scope, principal);
  if (!id) throw new AppError('UNAUTHORIZED', 'Sign in to manage payment methods');
  return id;
};

/**
 * Store API: /api/store/payments/…  (docs/api/modules/payments.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const storeRoutes = (service: PaymentsService) =>
  routes(endpoints, 'store', {
    /** GET /options: Accepted methods, saved cards, wallet availability and new-card setup */
    getPaymentOptions: async ({ query, scope, principal }) => {
      const customerId = customerOf(scope, principal);
      const owner = customerId ? { customerId } : scope.kind === 'visitor' ? { guestSessionId: scope.visitorSessionId } : {};
      return service.listOptions(owner, { amount: query.amount, currency: query.currency });
    },
    /** GET /intents/{id}: Payment result for the payment-result page (accepted, pending check, failed) */
    getPaymentStatus: ({ params, scope, principal }) => service.storeStatus(params.id, scope, customerOf(scope, principal), false),
    /** POST /intents/{id}/check: Ask the provider for the result now ('Check now') */
    checkPaymentNow: ({ params, scope, principal }) => service.storeStatus(params.id, scope, customerOf(scope, principal), true),
    /** GET /methods: Saved cards and wallets */
    listSavedMethods: async ({ scope, principal }) => {
      const customerId = customerOf(scope, principal);
      return customerId ? service.listSavedMethods(customerId) : [];
    },
    /** POST /methods/setup: Start adding a card (provider fields receive the card number) */
    startMethodSetup: ({ scope, principal }) => service.methods.setup(mustCustomer(scope, principal)),
    /** POST /methods: Save a card after the provider confirmed the setup */
    saveMethod: ({ body, scope, principal, actor, requestId }) => service.methods.save(mustCustomer(scope, principal), body, { actor, requestId }),
    /** PATCH /methods/{id}: Change the label, billing address or expiry date */
    updateMethod: ({ params, body, scope, principal }) => service.methods.update(mustCustomer(scope, principal), params.id, body),
    /** POST /methods/{id}/make-default: Use this card by default at checkout */
    makeMethodDefault: ({ params, scope, principal }) => service.methods.makeDefault(mustCustomer(scope, principal), params.id),
    /** DELETE /methods/{id}: Remove a saved card */
    removeMethod: ({ params, scope, principal, actor, requestId }) => service.methods.remove(mustCustomer(scope, principal), params.id, { actor, requestId }),
    /** GET /refunds: My refunds with status (Requested, Processing, Sent, Failed) */
    listMyRefunds: ({ query, page, scope, principal }) => service.refunds.listMine(customerOf(scope, principal), query.orderId, page),
    /** GET /refunds/{id}: One refund with destination and timing */
    getMyRefund: async ({ params, scope, principal }) => service.refunds.view(await service.refunds.ownRefund(params.id, withCustomer(scope, principal))),
    /** POST /refunds/{id}/destination: Choose where a failed refund should go instead */
    chooseRefundDestination: ({ params, body, scope, principal, actor, requestId }) => service.refunds.chooseDestination(params.id, withCustomer(scope, principal), body, { actor, requestId }),
  });

/** Customer scope with the customer id resolved (account id while customers is off) */
const withCustomer = (scope: Scope, principal: Principal | null): Scope => (scope.kind === 'customer' ? { ...scope, customerId: customerOf(scope, principal) } : scope);
