import type { Scope } from '../../../kernel/auth/scope.js';
import { AppError } from '../../../kernel/errors/index.js';
import { routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/wishlist.js';
import type { WishlistService } from '../service.js';

/** The signed-in customer whose wishlist this is: customers' id, or the account id while customers has none */
export const customerOf = (scope: Scope): string => {
  if (scope.kind === 'customer') return scope.customerId ?? scope.accountId;
  throw new AppError('UNAUTHORIZED', 'Sign in to use your wishlist');
};

/**
 * Store API: /api/store/wishlist/…  (docs/api/modules/wishlist.md)
 * Every handler acts for the signed-in customer's own lists, items and alerts; anyone else's id is not found.
 */
export const storeRoutes = (service: WishlistService) =>
  routes(endpoints, 'store', {
    /** GET /wishlist: Wishlist page: lists, first batch of items with price hints and stock, and alerts */
    getWishlist: async ({ scope, query }) => service.getWishlist(customerOf(scope), query),
    /** GET /lists/{id}/items: More items of a list */
    listItems: async ({ scope, params, query, page }) => {
      const p = await service.listItemDetails(customerOf(scope), params.id, query, page);
      return { ...p, items: p.items.map((d) => d.item) };
    },
    /** GET /saved: Which products are saved (for heart icons on cards) */
    savedStatus: async ({ scope, query }) => service.savedStatus(customerOf(scope), query.productIds),
    /** POST /items: Save a product (optionally with alerts) */
    saveItem: async ({ scope, body, actor, requestId }) => service.saveItem(customerOf(scope), body, { actor, requestId }),
    /** DELETE /items/{id}: Remove a saved item (its alerts are removed too) */
    removeItem: async ({ scope, params, actor, requestId }) => service.removeItem(customerOf(scope), params.id, { actor, requestId }),
    /** POST /items/{id}/move: Move an item to another list */
    moveItem: async ({ scope, params, body }) => service.moveItem(customerOf(scope), params.id, body),
    /** POST /items/{id}/move-to-cart: Add the item to the cart with an explicit offer */
    moveToCart: async ({ scope, params, body, actor, requestId }) => service.moveToCart(customerOf(scope), params.id, body, { actor, requestId }),
    /** PUT /items/{id}/alerts: Turn price-drop and back-in-stock alerts on or off for an item */
    updateItemAlerts: async ({ scope, params, body }) => service.updateItemAlerts(customerOf(scope), params.id, body),
    /** GET /lists: My lists */
    listLists: async ({ scope }) => service.listLists(customerOf(scope)),
    /** POST /lists: Create a named list */
    createList: async ({ scope, body }) => service.createList(customerOf(scope), body),
    /** PATCH /lists/{id}: Rename a list */
    updateList: async ({ scope, params, body }) => service.renameList(customerOf(scope), params.id, body),
    /** DELETE /lists/{id}: Delete a list (not the default list) */
    deleteList: async ({ scope, params, actor, requestId }) => service.deleteList(customerOf(scope), params.id, { actor, requestId }),
    /** POST /lists/{id}/share: Create or revoke a share link */
    shareList: async ({ scope, params, body }) => service.shareList(customerOf(scope), params.id, body),
    /** GET /shared/{token}: View a shared list (read-only, no prices history or alerts) */
    getSharedList: async ({ params }) => service.getSharedList(params.token),
    /** GET /alerts: My alerts */
    listAlerts: async ({ scope, query, page }) => service.listAlertsPage(customerOf(scope), query.state, page),
    /** POST /alerts: Create an alert (also for a product not saved, e.g. from an out-of-stock product page) */
    createAlert: async ({ scope, body }) => service.createAlert(customerOf(scope), body),
    /** POST /alerts/{id}/transition: Pause, resume or rearm an alert */
    changeAlert: async ({ scope, params, body }) => service.changeAlert(customerOf(scope), params.id, body.action),
    /** DELETE /alerts/{id}: Remove an alert */
    removeAlert: async ({ scope, params }) => service.removeAlert(customerOf(scope), params.id),
  });
