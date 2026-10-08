import { notImplemented, routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/wishlist.js';
import type { WishlistService } from '../service.js';

/**
 * Store API: /api/store/wishlist/…  (docs/api/modules/wishlist.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const storeRoutes = (service: WishlistService) => {
  void service;
  return routes(endpoints, 'store', {
    /** GET /wishlist: Wishlist page: lists, first batch of items with price hints and stock, and alerts */
    getWishlist: notImplemented,
    /** GET /lists/{id}/items: More items of a list */
    listItems: notImplemented,
    /** GET /saved: Which products are saved (for heart icons on cards) */
    savedStatus: notImplemented,
    /** POST /items: Save a product (optionally with alerts) */
    saveItem: notImplemented,
    /** DELETE /items/{id}: Remove a saved item (its alerts are removed too) */
    removeItem: notImplemented,
    /** POST /items/{id}/move: Move an item to another list */
    moveItem: notImplemented,
    /** POST /items/{id}/move-to-cart: Add the item to the cart with an explicit offer */
    moveToCart: notImplemented,
    /** PUT /items/{id}/alerts: Turn price-drop and back-in-stock alerts on or off for an item */
    updateItemAlerts: notImplemented,
    /** GET /lists: My lists */
    listLists: notImplemented,
    /** POST /lists: Create a named list */
    createList: notImplemented,
    /** PATCH /lists/{id}: Rename a list */
    updateList: notImplemented,
    /** DELETE /lists/{id}: Delete a list (not the default list) */
    deleteList: notImplemented,
    /** POST /lists/{id}/share: Create or revoke a share link */
    shareList: notImplemented,
    /** GET /shared/{token}: View a shared list (read-only, no prices history or alerts) */
    getSharedList: notImplemented,
    /** GET /alerts: My alerts */
    listAlerts: notImplemented,
    /** POST /alerts: Create an alert (also for a product not saved, e.g. from an out-of-stock product page) */
    createAlert: notImplemented,
    /** POST /alerts/{id}/transition: Pause, resume or rearm an alert */
    changeAlert: notImplemented,
    /** DELETE /alerts/{id}: Remove an alert */
    removeAlert: notImplemented,
  });
};
