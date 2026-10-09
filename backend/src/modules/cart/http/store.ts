import { routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/cart.js';
import type { CartService } from '../service.js';

/**
 * Store API: /api/store/cart/…  (docs/api/modules/cart.md)
 * Every handler acts for the caller's own cart: the signed-in customer or the visitor (guest) session.
 */
export const storeRoutes = (service: CartService) =>
  routes(endpoints, 'store', {
    /** GET /cart: Cart grouped by package, with change detection */
    getCart: async ({ scope, query }) => service.getCart(scope, query.postalCode),
    /** GET /cart/badge: Item count and attention count for the header and app tab bar */
    getCartBadge: async ({ scope }) => service.getBadge(scope),
    /** POST /cart/items: Add an offer to the cart (Add to cart) */
    addItem: async ({ scope, body, actor, requestId }) => service.addItem(scope, body, { actor, requestId }),
    /** PATCH /cart/items/{id}: Change a line's quantity */
    updateItemQuantity: async ({ scope, params, body, actor, requestId }) => service.updateItemQuantity(scope, params.id, body.quantity, { actor, requestId }),
    /** DELETE /cart/items/{id}: Remove a line */
    removeItem: async ({ scope, params, actor, requestId }) => service.removeItem(scope, params.id, { actor, requestId }),
    /** POST /cart/items/{id}/accept: Accept a changed price or reduced quantity for a line */
    acceptItemChanges: async ({ scope, params, body, actor, requestId }) => service.acceptItemChanges(scope, params.id, body.noticeIds, { actor, requestId }),
    /** POST /cart/items/{id}/switch-offer: Replace a line's offer with one the customer explicitly chose */
    switchItemOffer: async ({ scope, params, body, actor, requestId }) => service.switchItemOffer(scope, params.id, body, { actor, requestId }),
    /** POST /cart/remove-unavailable: Remove every unavailable line in one action */
    removeUnavailableItems: async ({ scope, actor, requestId }) => service.removeUnavailableItems(scope, { actor, requestId }),
    /** PUT /cart/destination: Set the deliver-to location used for estimates */
    setDestination: async ({ scope, body }) => service.setDestination(scope, body),
    /** POST /cart/coupons: Apply a coupon code for preview */
    previewCoupon: async ({ scope, body }) => service.previewCoupon(scope, body.code),
    /** DELETE /cart/coupons/{code}: Remove a coupon code */
    removeCoupon: async ({ scope, params }) => service.removeCoupon(scope, params.code),
    /** POST /cart/merge: Merge the guest cart into the customer cart after sign-in */
    mergeGuestCart: async ({ scope, body, actor, requestId }) => service.mergeGuestCart(scope, body.guestSessionId, { actor, requestId }),
    /** POST /cart/items/{id}/save-for-later: Move a line to Saved for later */
    saveForLater: async ({ scope, params, actor, requestId }) => service.saveForLater(scope, params.id, { actor, requestId }),
    /** GET /cart/saved: Saved for later */
    listSavedItems: async ({ scope, page }) => service.listSavedItems(scope, page),
    /** POST /cart/saved/{id}/move-to-cart: Move a saved item back into the cart */
    moveSavedToCart: async ({ scope, params, body, actor, requestId }) => service.moveSavedToCart(scope, params.id, body.quantity, { actor, requestId }),
    /** DELETE /cart/saved/{id}: Delete a saved item */
    deleteSavedItem: async ({ scope, params }) => service.deleteSavedItem(scope, params.id),
  });
