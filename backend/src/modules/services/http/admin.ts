import { routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/services.js';
import type { ServicesService } from '../service.js';

/**
 * Admin API: /api/admin/services/…  (docs/api/modules/services.md)
 * Admin › Departments: categories, providers and services of the OS install, Post-sale, Welfare and Booking pages,
 * and the requests and reviews customers send. Writes are audited.
 */
export const adminRoutes = (service: ServicesService) =>
  routes(endpoints, 'admin', {
    /** GET /categories: Categories of an area */
    listCategoriesAdmin: async ({ query }) => service.listCategoriesAdmin(query),
    /** POST /categories: Add a category */
    createCategory: async ({ body, actor, requestId }) => service.createCategory(body, { actor, requestId }),
    /** PATCH /categories/{id}: Rename, reorder, hide or show a category */
    updateCategory: async ({ params, body, actor, requestId }) => service.updateCategory(params.id, body, { actor, requestId }),
    /** DELETE /categories/{id}: Delete a category no service uses */
    deleteCategory: async ({ params, actor, requestId }) => service.deleteCategory(params.id, { actor, requestId }),
    /** GET /providers: Providers */
    listProvidersAdmin: async ({ query, page }) => service.listProvidersAdmin(query, page),
    /** POST /providers: Add a provider */
    createProvider: async ({ body, actor, requestId }) => service.createProvider(body, { actor, requestId }),
    /** GET /providers/{id}: A provider for editing */
    getProviderAdmin: async ({ params }) => service.getProviderAdmin(params.id),
    /** PATCH /providers/{id}: Edit, hide or show a provider */
    updateProvider: async ({ params, body, actor, requestId }) => service.updateProvider(params.id, body, { actor, requestId }),
    /** DELETE /providers/{id}: Delete a provider without services */
    deleteProvider: async ({ params, actor, requestId }) => service.deleteProvider(params.id, { actor, requestId }),
    /** GET /services: Services in staff order */
    listServicesAdmin: async ({ query, page }) => service.listServicesAdmin(query, page),
    /** POST /services: Add a service */
    createService: async ({ body, actor, requestId }) => service.createService(body, { actor, requestId }),
    /** GET /services/{id}: A service for editing */
    getServiceAdmin: async ({ params }) => service.getServiceAdmin(params.id),
    /** PATCH /services/{id}: Edit, hide or show a service */
    updateService: async ({ params, body, actor, requestId }) => service.updateService(params.id, body, { actor, requestId }),
    /** DELETE /services/{id}: Delete a service without open requests */
    deleteService: async ({ params, actor, requestId }) => service.deleteService(params.id, { actor, requestId }),
    /** GET /requests: Requests and bookings, newest first */
    listRequestsAdmin: async ({ query, page }) => service.listRequestsAdmin(query, page),
    /** GET /requests/{id}: A request */
    getRequestAdmin: async ({ params }) => service.getRequestAdmin(params.id),
    /** PATCH /requests/{id}: Confirm, start, complete, decline or cancel a request; move a booking; add notes */
    updateRequest: async ({ params, body, actor, requestId }) => service.updateRequest(params.id, body, { actor, requestId }),
    /** GET /reviews: Reviews, newest first */
    listReviewsAdmin: async ({ query, page }) => service.listReviewsAdmin(query, page),
    /** PATCH /reviews/{id}: Hide or show a review */
    moderateReview: async ({ params, body, actor, requestId }) => service.moderateReview(params.id, body, { actor, requestId }),
  });
