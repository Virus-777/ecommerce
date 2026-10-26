import type { Principal } from '../../../kernel/auth/index.js';
import type { Scope } from '../../../kernel/auth/scope.js';
import { AppError } from '../../../kernel/errors/index.js';
import { routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/farm.js';
import type { FarmService } from '../service.js';

/** The signed-in customer's customers-module id (as payments uses it; the account id when no customer record exists yet), or null */
const customerOrNull = (scope: Scope, principal: Principal | null): string | null => (scope.kind === 'customer' ? (scope.customerId ?? principal?.accountId ?? null) : null);
const customerOf = (scope: Scope, principal: Principal | null): string => {
  const id = customerOrNull(scope, principal);
  if (!id) throw new AppError('UNAUTHORIZED', 'Sign in to continue');
  return id;
};

/**
 * Store API: /api/store/farm/…  (docs/api/modules/farm.md)
 * The nearest dealer and quotes are open to visitors (a signed-in customer gets their own address's dealer); orders
 * and their payments need a customer.
 */
export const storeRoutes = (service: FarmService) =>
  routes(endpoints, 'store', {
    /** GET /dealers/nearest: Your nearest dealer, for Farm machines */
    getNearestDealer: async ({ principal }) => service.getNearestDealer(await service.viewerOf(principal)),
    /** POST /quotes: Price a machine with attachments, the dealer and the payment options */
    quoteOrder: async ({ body, principal }) => service.quoteOrder(await service.viewerOf(principal), body),
    /** GET /payment-options: Saved cards and a new-card session for a farm order's card amount */
    getPaymentOptions: async ({ query, scope, principal }) => service.getPaymentOptions(customerOf(scope, principal), query),
    /** POST /orders: Order a machine for delivery to your farm */
    placeOrder: async ({ body, scope, principal, idempotencyKey, actor, requestId }) => service.placeOrder(customerOf(scope, principal), body, idempotencyKey!, { actor, requestId }),
    /** GET /orders: My farm orders, newest first */
    listMyOrders: async ({ query, page, scope, principal }) => service.listMyOrders(customerOf(scope, principal), query, page),
    /** GET /orders/{id}: A farm order with its status and payment */
    getOrder: async ({ params, query, scope, principal, actor, requestId }) => service.getOrder(customerOf(scope, principal), params.id, query.refresh ?? false, { actor, requestId }),
    /** POST /orders/{id}/complete-action: Finish the bank challenge of a farm order */
    completeOrderAction: async ({ params, body, scope, principal, idempotencyKey, actor, requestId }) => service.completeOrderAction(customerOf(scope, principal), params.id, body.resultToken, idempotencyKey!, { actor, requestId }),
    /** POST /orders/{id}/retry: Pay a failed farm order again */
    retryOrderPayment: async ({ params, body, scope, principal, idempotencyKey, actor, requestId }) => service.retryOrderPayment(customerOf(scope, principal), params.id, body, idempotencyKey!, { actor, requestId }),
    /** POST /orders/{id}/cancel: Cancel an order the dealer hasn't confirmed */
    cancelOrder: async ({ params, body, scope, principal, actor, requestId }) => service.cancelOrder(customerOf(scope, principal), params.id, body ?? {}, { actor, requestId }),
    /** GET /statistics: What the customer spent on farm machines in a period */
    getMyStatistics: async ({ query, scope, principal }) => service.statisticsFor(customerOf(scope, principal), query),
  });
