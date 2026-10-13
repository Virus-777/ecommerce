import { routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/customers.js';
import type { CustomersService } from '../service.js';

/**
 * Store API: /api/store/customers/…  (docs/api/modules/customers.md)
 * Every handler acts for the caller only: the signed-in customer (scope) or the visitor session.
 */
export const storeRoutes = (service: CustomersService) =>
  routes(endpoints, 'store', {
    /** GET /overview: Account tab home: tiles, alerts, recent orders, open cases and returns */
    getAccountOverview: async ({ scope }) => service.profiles.getAccountOverview(scope),
    /** GET /profile: Profile, verification state and active restrictions */
    getProfile: async ({ scope }) => service.profiles.getProfile(scope),
    /** PATCH /profile: Change name or mobile phone */
    updateProfile: async ({ scope, body, actor, requestId }) => service.profiles.updateProfile(scope, body, { actor, requestId }),
    /** GET /addresses: Saved addresses (bounded by maxAddresses, not paged) */
    listAddresses: async ({ scope }) => service.addresses.listAddresses(scope),
    /** POST /addresses: Add an address */
    createAddress: async ({ scope, body, actor, requestId }) => service.addresses.createAddress(scope, body, { actor, requestId }),
    /** PATCH /addresses/{id}: Edit an address */
    updateAddress: async ({ scope, params, body, actor, requestId }) => service.addresses.updateAddress(scope, params.id, body, { actor, requestId }),
    /** DELETE /addresses/{id}: Remove an address */
    deleteAddress: async ({ scope, params }) => service.addresses.deleteAddress(scope, params.id),
    /** POST /addresses/{id}/make-default: Set the default delivery address */
    makeDefaultAddress: async ({ scope, params }) => service.addresses.makeDefaultAddress(scope, params.id),
    /** POST /addresses/validate: Check an address before saving or at guest checkout */
    validateAddress: async ({ body }) => service.validateAddress(body),
    /** GET /marketing-preferences: Promotional consent per channel */
    getMarketingPreferences: async ({ scope }) => service.marketing.getMarketingPreferences(scope),
    /** PUT /marketing-preferences: Turn promotional channels on or off */
    updateMarketingPreferences: async ({ scope, body, actor, requestId, request }) => service.marketing.updateMarketingPreferences(scope, body, { actor, requestId, ip: request.ip }),
    /** GET /recently-viewed: Recently viewed products for the home page */
    listRecentlyViewed: async ({ scope, query }) => service.recentlyViewed.listRecentlyViewedFor(scope, query.limit),
    /** POST /recently-viewed: Record a product view */
    recordRecentlyViewed: async ({ scope, body }) => service.recentlyViewed.recordView(scope, body),
    /** DELETE /recently-viewed: Clear the whole list */
    clearRecentlyViewed: async ({ scope }) => service.recentlyViewed.clearViews(scope),
    /** DELETE /recently-viewed/{productId}: Remove one product from the list */
    removeRecentlyViewed: async ({ scope, params }) => service.recentlyViewed.removeView(scope, params.productId),
    /** POST /data-requests/exports: Request a copy of my data */
    requestDataExport: async ({ scope, actor, requestId }) => service.dataRequests.requestDataExport(scope, { actor, requestId }),
    /** GET /data-requests: My export and closure requests */
    listDataRequests: async ({ scope, principal }) => service.dataRequests.listDataRequests(scope, principal),
    /** GET /closure-eligibility: Can I close my account now, and what blocks it */
    getClosureEligibility: async ({ scope }) => service.dataRequests.getClosureEligibility(scope),
    /** POST /data-requests/closure: Request account closure (the re-auth token is verified by the middleware) */
    requestClosure: async ({ scope, body, actor, requestId }) => service.dataRequests.requestClosure(scope, body, { actor, requestId }),
    /** POST /data-requests/{id}/cancel: Cancel a pending closure or export request */
    cancelDataRequest: async ({ scope, params, actor, requestId }) => service.dataRequests.cancelDataRequest(scope, params.id, { actor, requestId }),
    /** POST /guest-orders/lookup: Find a guest order by reference and checkout email */
    lookupGuestOrder: async ({ principal, body, request }) => service.guestOrders.lookupGuestOrder(principal, body, request.ip),
    /** POST /guest-orders/links: Email fresh links to every guest order placed with this email */
    sendGuestOrderLinks: async ({ body, request }) => service.guestOrders.sendGuestOrderLinks(body, request.ip),
  });
