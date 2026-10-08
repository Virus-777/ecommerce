import { notImplemented, routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/customers.js';
import type { CustomersService } from '../service.js';

/**
 * Store API: /api/store/customers/…  (docs/api/modules/customers.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const storeRoutes = (service: CustomersService) => {
  void service;
  return routes(endpoints, 'store', {
    /** GET /overview: Account tab home: tiles, alerts, recent orders, open cases and returns */
    getAccountOverview: notImplemented,
    /** GET /profile: Profile, verification state and active restrictions */
    getProfile: notImplemented,
    /** PATCH /profile: Change name or mobile phone */
    updateProfile: notImplemented,
    /** GET /addresses: Saved addresses (bounded by maxAddresses, not paged) */
    listAddresses: notImplemented,
    /** POST /addresses: Add an address */
    createAddress: notImplemented,
    /** PATCH /addresses/{id}: Edit an address */
    updateAddress: notImplemented,
    /** DELETE /addresses/{id}: Remove an address */
    deleteAddress: notImplemented,
    /** POST /addresses/{id}/make-default: Set the default delivery address */
    makeDefaultAddress: notImplemented,
    /** POST /addresses/validate: Check an address before saving or at guest checkout */
    validateAddress: notImplemented,
    /** GET /marketing-preferences: Promotional consent per channel */
    getMarketingPreferences: notImplemented,
    /** PUT /marketing-preferences: Turn promotional channels on or off */
    updateMarketingPreferences: notImplemented,
    /** GET /recently-viewed: Recently viewed products for the home page */
    listRecentlyViewed: notImplemented,
    /** POST /recently-viewed: Record a product view */
    recordRecentlyViewed: notImplemented,
    /** DELETE /recently-viewed: Clear the whole list */
    clearRecentlyViewed: notImplemented,
    /** DELETE /recently-viewed/{productId}: Remove one product from the list */
    removeRecentlyViewed: notImplemented,
    /** POST /data-requests/exports: Request a copy of my data */
    requestDataExport: notImplemented,
    /** GET /data-requests: My export and closure requests */
    listDataRequests: notImplemented,
    /** GET /closure-eligibility: Can I close my account now, and what blocks it */
    getClosureEligibility: notImplemented,
    /** POST /data-requests/closure: Request account closure */
    requestClosure: notImplemented,
    /** POST /data-requests/{id}/cancel: Cancel a pending closure or export request */
    cancelDataRequest: notImplemented,
    /** POST /guest-orders/lookup: Find a guest order by reference and checkout email */
    lookupGuestOrder: notImplemented,
    /** POST /guest-orders/links: Email fresh links to every guest order placed with this email */
    sendGuestOrderLinks: notImplemented,
  });
};
