import type { Scope } from '../../../kernel/auth/scope.js';
import { AppError } from '../../../kernel/errors/index.js';
import { routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/services.js';
import type { ServicesService } from '../service.js';

/** The signed-in customer's key for requests and reviews: the account id, as in departments */
const customerOf = (scope: Scope): string => {
  if (scope.kind === 'customer') return scope.accountId;
  throw new AppError('UNAUTHORIZED', 'Sign in to continue');
};

/** The key of saved providers and registered devices: the customers-module id (the account id without a customer record) */
const ownerOf = (scope: Scope): string => {
  if (scope.kind === 'customer') return scope.customerId ?? scope.accountId;
  throw new AppError('UNAUTHORIZED', 'Sign in to continue');
};

/** Who browses: the signed-in customer's customers-module id, or nobody for visitors */
const viewerKey = (scope: Scope): string | null => (scope.kind === 'customer' ? (scope.customerId ?? scope.accountId) : null);

/**
 * Store API: /api/store/services/…  (docs/api/modules/services.md)
 * Browsing is open to visitors (signed-in customers also get distances, saved flags and their device's price);
 * requesting, booking, cancelling, rating, saving providers and registering devices need a customer.
 */
export const storeRoutes = (service: ServicesService) =>
  routes(endpoints, 'store', {
    /** GET /categories: Visible categories of an area in order */
    listCategories: async ({ query }) => service.listCategories(query),
    /** GET /area: Where the lists measure distances from */
    getMyArea: async ({ scope }) => service.getMyArea(await service.viewerOf(viewerKey(scope))),
    /** GET /services: Published services of an area */
    listServices: async ({ query, page, scope }) => service.listServices(query, page, await service.viewerOf(viewerKey(scope))),
    /** GET /services/{slug}: A service with its provider, price table, terms, full terms, steps and newest reviews */
    getService: async ({ params, scope }) => service.getService(params.slug, await service.viewerOf(viewerKey(scope))),
    /** GET /services/{id}/reviews: A service's reviews, newest first */
    listServiceReviews: async ({ params, page }) => service.listServiceReviews(params.id, page),
    /** GET /providers: Published providers of an area (Booking: Available near you, and the map) */
    listProviders: async ({ query, page, scope }) => service.listProviders(query, page, await service.viewerOf(viewerKey(scope))),
    /** GET /providers/{slug}: A provider's page with its services, hours and staff */
    getProvider: async ({ params, query, scope }) => service.getProvider(params.slug, query, await service.viewerOf(viewerKey(scope))),
    /** GET /saved-providers: Providers I saved, newest first */
    listSavedProviders: async ({ query, page, scope }) => service.listSavedProviders(ownerOf(scope), query, page),
    /** PUT /saved-providers/{providerId}: Save a provider */
    saveProvider: async ({ params, scope }) => service.saveProvider(ownerOf(scope), params.providerId),
    /** DELETE /saved-providers/{providerId}: Remove a provider from my saved ones */
    unsaveProvider: async ({ params, scope }) => service.unsaveProvider(ownerOf(scope), params.providerId),
    /** GET /services/{id}/availability: Free time slots of a bookable service, day by day */
    getAvailability: async ({ params, query }) => service.getAvailability(params.id, query),
    /** POST /requests: Request or book a service */
    createRequest: async ({ body, scope, actor, requestId }) => service.createRequest(customerOf(scope), body, { actor, requestId }, ownerOf(scope)),
    /** GET /requests: My requests and bookings, newest first */
    listMyRequests: async ({ query, page, scope }) => service.listMyRequests(customerOf(scope), query, page),
    /** GET /requests/{id}: One of my requests */
    getMyRequest: async ({ params, scope }) => service.getMyRequest(customerOf(scope), params.id),
    /** POST /requests/{id}/cancel: Cancel my request or booking */
    cancelMyRequest: async ({ params, body, scope, actor, requestId }) => service.cancelMyRequest(customerOf(scope), params.id, body ?? {}, { actor, requestId }),
    /** POST /requests/{id}/review: Rate a completed request */
    reviewMyRequest: async ({ params, body, scope, actor, requestId }) => service.reviewMyRequest(customerOf(scope), params.id, body, { actor, requestId }),
    /** GET /statistics: The customer's service requests in a period (one area with area=, else every area) */
    getMyStatistics: async ({ query, scope }) => service.statisticsFor(customerOf(scope), query),
    /** GET /devices: My registered devices, newest first */
    listMyDevices: async ({ scope }) => service.listMyDevices(ownerOf(scope)),
    /** POST /devices: Register a device for post-sale cover */
    registerDevice: async ({ body, scope }) => service.registerDevice(ownerOf(scope), body),
    /** GET /devices/{id}: One of my devices */
    getMyDevice: async ({ params, scope }) => service.getMyDevice(ownerOf(scope), params.id),
    /** PATCH /devices/{id}: Change a pending or rejected device */
    updateMyDevice: async ({ params, body, scope }) => service.updateMyDevice(ownerOf(scope), params.id, body),
    /** DELETE /devices/{id}: Remove one of my devices */
    removeMyDevice: async ({ params, scope }) => service.removeMyDevice(ownerOf(scope), params.id),
  });
