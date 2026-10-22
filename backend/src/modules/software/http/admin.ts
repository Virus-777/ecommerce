import { routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/software.js';
import type { SoftwareService } from '../service.js';

/**
 * Admin API: /api/admin/software/…  (docs/api/modules/software.md)
 * Admin › Departments › Softwares: categories, apps and their files, packs, the Recommended tab's rails, purchases,
 * grants and reviews. Writes are audited.
 */
export const adminRoutes = (service: SoftwareService) =>
  routes(endpoints, 'admin', {
    /** GET /categories: All categories in order */
    listCategoriesAdmin: async () => service.listCategoriesAdmin(),
    /** POST /categories: Add a category */
    createCategory: async ({ body, actor, requestId }) => service.createCategory(body, { actor, requestId }),
    /** PATCH /categories/{id}: Rename, reorder, hide or show a category */
    updateCategory: async ({ params, body, actor, requestId }) => service.updateCategory(params.id, body, { actor, requestId }),
    /** DELETE /categories/{id}: Delete an empty category */
    deleteCategory: async ({ params, actor, requestId }) => service.deleteCategory(params.id, { actor, requestId }),
    /** GET /apps: Apps with filters */
    listAppsAdmin: async ({ query, page }) => service.listAppsAdmin(query, page),
    /** POST /apps: Add an app */
    createApp: async ({ body, actor, requestId }) => service.createApp(body, { actor, requestId }),
    /** GET /apps/{id}: An app for editing */
    getAppAdmin: async ({ params }) => service.getAppAdmin(params.id),
    /** PATCH /apps/{id}: Change an app, its files, price or status */
    updateApp: async ({ params, body, actor, requestId }) => service.updateApp(params.id, body, { actor, requestId }),
    /** DELETE /apps/{id}: Delete an app nobody owns */
    deleteApp: async ({ params, actor, requestId }) => service.deleteApp(params.id, { actor, requestId }),
    /** GET /packs: Packs in order */
    listPacksAdmin: async () => service.listPacksAdmin(),
    /** POST /packs: Add a pack */
    createPack: async ({ body, actor, requestId }) => service.createPack(body, { actor, requestId }),
    /** PATCH /packs/{id}: Change a pack */
    updatePack: async ({ params, body, actor, requestId }) => service.updatePack(params.id, body, { actor, requestId }),
    /** DELETE /packs/{id}: Delete a pack that was never sold */
    deletePack: async ({ params, actor, requestId }) => service.deletePack(params.id, { actor, requestId }),
    /** GET /rails: The Recommended tab's rails in order */
    getRails: async () => service.getRails(),
    /** PUT /rails: Replace the Recommended tab's rails */
    setRails: async ({ body, actor, requestId }) => service.setRails(body, { actor, requestId }),
    /** GET /purchases: Purchases, newest first */
    listPurchasesAdmin: async ({ query, page }) => service.listPurchasesAdmin(query, page),
    /** POST /entitlements: Give a customer an app (support goodwill or a payment settled elsewhere) */
    grantApp: async ({ body, actor, requestId }) => service.grantApp(body, { actor, requestId }),
    /** GET /entitlements: Who owns which app, with licence keys, newest first */
    listEntitlementsAdmin: async ({ query, page }) => service.listEntitlementsAdmin(query, page),
    /** POST /entitlements/{id}/reissue-licence: Replace an owner's licence key */
    reissueLicence: async ({ params, body, actor, requestId }) => service.reissueLicence(params.id, body, { actor, requestId }),
    /** GET /reviews: Reviews, newest first */
    listReviewsAdmin: async ({ query, page }) => service.listReviewsAdmin(query, page),
    /** POST /reviews/{id}/moderate: Hide or show a review */
    moderateReview: async ({ params, body, actor, requestId }) => service.moderateReview(params.id, body, { actor, requestId }),
  });
