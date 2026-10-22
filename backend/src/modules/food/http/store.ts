import type { Principal } from '../../../kernel/auth/index.js';
import type { Scope } from '../../../kernel/auth/scope.js';
import { AppError } from '../../../kernel/errors/index.js';
import { routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/food.js';
import type { FoodService } from '../service.js';

/** The signed-in customer's customers-module id (as payments uses it; the account id when no customer record exists yet) */
const customerOf = (scope: Scope, principal: Principal | null): string => {
  const id = scope.kind === 'customer' ? (scope.customerId ?? principal?.accountId ?? null) : null;
  if (!id) throw new AppError('UNAUTHORIZED', 'Sign in to continue');
  return id;
};

/** The signed-in customer on a page visitors can also open (saved flags and distances), else null */
const viewerOf = (scope: Scope, principal: Principal | null): string | null => (scope.kind === 'customer' ? (scope.customerId ?? principal?.accountId ?? null) : null);

/**
 * Store API: /api/store/food/…  (docs/api/modules/food.md)
 * Browsing is open to visitors; the basket, orders, payments and ratings need a customer.
 */
export const storeRoutes = (service: FoodService) =>
  routes(endpoints, 'store', {
    /** GET /categories: Visible food categories in order */
    listCategories: async () => service.listCategories(),
    /** GET /restaurants: Published restaurants, open ones first */
    listRestaurants: async ({ query, page, scope, principal }) => service.listRestaurants(query, page, viewerOf(scope, principal)),
    /** GET /restaurants/{slug}: A restaurant with its menu */
    getRestaurant: async ({ params, scope, principal }) => service.getRestaurant(params.slug, viewerOf(scope, principal)),
    /** GET /restaurants/{slug}/reviews: A restaurant's reviews, newest first */
    listRestaurantReviews: async ({ params, query, page }) => service.listRestaurantReviews(params.slug, query, page),
    /** GET /restaurants/{slug}/ratings: A restaurant's rating summary: average, count and count per star */
    getRestaurantRatings: async ({ params }) => service.getRestaurantRatings(params.slug),
    /** GET /saved-restaurants: My saved restaurants, last saved first */
    listSavedRestaurants: async ({ page, scope, principal }) => service.listSavedRestaurants(customerOf(scope, principal), page),
    /** PUT /saved-restaurants/{slug}: Save a restaurant (the heart) */
    saveRestaurant: async ({ params, scope, principal }) => service.saveRestaurant(customerOf(scope, principal), params.slug),
    /** DELETE /saved-restaurants/{slug}: Remove a restaurant from my saved ones */
    unsaveRestaurant: async ({ params, scope, principal }) => service.unsaveRestaurant(customerOf(scope, principal), params.slug),
    /** GET /items: Menu items across restaurants */
    listItems: async ({ query, page }) => service.listItems(query, page),
    /** GET /items/{id}: A menu item with its photos, sizes and extras */
    getItem: async ({ params, scope, principal }) => service.getItem(params.id, viewerOf(scope, principal)),
    /** GET /basket: My food basket with prices worked out now */
    getBasket: async ({ scope, principal }) => service.getBasket(customerOf(scope, principal)),
    /** POST /basket/lines: Add an item with its options */
    addToBasket: async ({ body, scope, principal }) => service.addToBasket(customerOf(scope, principal), body),
    /** PATCH /basket/lines/{lineId}: Change a line's quantity or note; 0 removes it */
    updateBasketLine: async ({ params, body, scope, principal }) => service.updateBasketLine(customerOf(scope, principal), params.lineId, body),
    /** DELETE /basket: Empty the basket */
    clearBasket: async ({ scope, principal }) => service.clearBasket(customerOf(scope, principal)),
    /** GET /payment-options: Saved cards and a new-card session for the basket total */
    getPaymentOptions: async ({ scope, principal }) => service.getPaymentOptions(customerOf(scope, principal)),
    /** POST /orders: Order the basket */
    placeOrder: async ({ body, scope, principal, idempotencyKey, actor, requestId }) => service.placeOrder(customerOf(scope, principal), body, idempotencyKey!, { actor, requestId }),
    /** GET /orders: My food orders, newest first */
    listMyOrders: async ({ query, page, scope, principal }) => service.listMyOrders(customerOf(scope, principal), query, page),
    /** GET /orders/{id}: A food order with its status and payment */
    getOrder: async ({ params, query, scope, principal, actor, requestId }) => service.getOrder(customerOf(scope, principal), params.id, query.refresh ?? false, { actor, requestId }),
    /** POST /orders/{id}/complete-action: Finish the bank challenge of a food order */
    completeOrderAction: async ({ params, body, scope, principal, idempotencyKey, actor, requestId }) => service.completeOrderAction(customerOf(scope, principal), params.id, body.resultToken, idempotencyKey!, { actor, requestId }),
    /** POST /orders/{id}/retry: Pay a failed food order again */
    retryOrderPayment: async ({ params, body, scope, principal, idempotencyKey, actor, requestId }) => service.retryOrderPayment(customerOf(scope, principal), params.id, body, idempotencyKey!, { actor, requestId }),
    /** POST /orders/{id}/cancel: Cancel an order the restaurant hasn't accepted */
    cancelOrder: async ({ params, body, scope, principal, actor, requestId }) => service.cancelOrder(customerOf(scope, principal), params.id, body ?? {}, { actor, requestId }),
    /** POST /orders/{id}/review: Rate a delivered order */
    reviewOrder: async ({ params, body, scope, principal, actor, requestId }) => service.reviewOrder(customerOf(scope, principal), params.id, body, { actor, requestId }),
  });
