import { notImplemented, routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/cart.js';
import type { CartService } from '../service.js';

/**
 * Store API: /api/store/cart/…  (docs/api/modules/cart.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const storeRoutes = (service: CartService) =>
  routes(endpoints, 'store', {
    /** GET /cart: Cart grouped by package, with change detection */
    getCart: notImplemented,
    /** GET /cart/badge: Item count and attention count for the header and app tab bar */
    getCartBadge: notImplemented,
    /** POST /cart/items: Add an offer to the cart (Add to cart) */
    addItem: notImplemented,
    /** PATCH /cart/items/{id}: Change a line's quantity */
    updateItemQuantity: notImplemented,
    /** DELETE /cart/items/{id}: Remove a line */
    removeItem: notImplemented,
    /** POST /cart/items/{id}/accept: Accept a changed price or reduced quantity for a line */
    acceptItemChanges: notImplemented,
    /** POST /cart/items/{id}/switch-offer: Replace a line's offer with one the customer explicitly chose */
    switchItemOffer: notImplemented,
    /** POST /cart/remove-unavailable: Remove every unavailable line in one action */
    removeUnavailableItems: notImplemented,
    /** PUT /cart/destination: Set the deliver-to location used for estimates */
    setDestination: notImplemented,
    /** POST /cart/coupons: Apply a coupon code for preview */
    previewCoupon: notImplemented,
    /** DELETE /cart/coupons/{code}: Remove a coupon code */
    removeCoupon: notImplemented,
    /** POST /cart/merge: Merge the guest cart into the customer cart after sign-in */
    mergeGuestCart: notImplemented,
    /** POST /cart/items/{id}/save-for-later: Move a line to Saved for later */
    saveForLater: notImplemented,
    /** GET /cart/saved: Saved for later */
    listSavedItems: notImplemented,
    /** POST /cart/saved/{id}/move-to-cart: Move a saved item back into the cart */
    moveSavedToCart: notImplemented,
    /** DELETE /cart/saved/{id}: Delete a saved item */
    deleteSavedItem: notImplemented,
  });
