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

/**
 * Store API: /api/store/services/…  (docs/api/modules/services.md)
 * Browsing is open to visitors; requesting, booking, cancelling and rating need a customer.
 */
export const storeRoutes = (service: ServicesService) =>
  routes(endpoints, 'store', {
    /** GET /categories: Visible categories of an area in order */
    listCategories: async ({ query }) => service.listCategories(query),
    /** GET /services: Published services of an area */
    listServices: async ({ query, page }) => service.listServices(query, page),
    /** GET /services/{slug}: A service with its provider, price table, terms, steps and newest reviews */
    getService: async ({ params }) => service.getService(params.slug),
    /** GET /services/{id}/reviews: A service's reviews, newest first */
    listServiceReviews: async ({ params, page }) => service.listServiceReviews(params.id, page),
    /** GET /providers: Published providers of an area (Booking: Available near you) */
    listProviders: async ({ query, page }) => service.listProviders(query, page),
    /** GET /providers/{slug}: A provider's page with its services, hours and staff */
    getProvider: async ({ params, query }) => service.getProvider(params.slug, query),
    /** GET /services/{id}/availability: Free time slots of a bookable service, day by day */
    getAvailability: async ({ params, query }) => service.getAvailability(params.id, query),
    /** POST /requests: Request or book a service */
    createRequest: async ({ body, scope, actor, requestId }) => service.createRequest(customerOf(scope), body, { actor, requestId }),
    /** GET /requests: My requests and bookings, newest first */
    listMyRequests: async ({ query, page, scope }) => service.listMyRequests(customerOf(scope), query, page),
    /** GET /requests/{id}: One of my requests */
    getMyRequest: async ({ params, scope }) => service.getMyRequest(customerOf(scope), params.id),
    /** POST /requests/{id}/cancel: Cancel my request or booking */
    cancelMyRequest: async ({ params, body, scope, actor, requestId }) => service.cancelMyRequest(customerOf(scope), params.id, body ?? {}, { actor, requestId }),
    /** POST /requests/{id}/review: Rate a completed request */
    reviewMyRequest: async ({ params, body, scope, actor, requestId }) => service.reviewMyRequest(customerOf(scope), params.id, body, { actor, requestId }),
  });
