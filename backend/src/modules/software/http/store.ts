import type { Principal } from '../../../kernel/auth/index.js';
import type { Scope } from '../../../kernel/auth/scope.js';
import { AppError } from '../../../kernel/errors/index.js';
import { routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/software.js';
import type { SoftwareService } from '../service.js';

/**
 * The signed-in customer's customers-module id (the store principal's customerId, as payments and promotions use),
 * or the account id while customers is off.
 */
const customerOf = (scope: Scope, principal: Principal | null): string => {
  if (scope.kind === 'customer') {
    const id = scope.customerId ?? principal?.accountId;
    if (id) return id;
  }
  throw new AppError('UNAUTHORIZED', 'Sign in to continue');
};

/**
 * Store API: /api/store/software/…  (docs/api/modules/software.md)
 * Browsing is open to visitors (a signed-in customer also sees what they own and their licence keys); owning, buying,
 * downloading (no purchase needed) and rating need a customer.
 */
export const storeRoutes = (service: SoftwareService) =>
  routes(endpoints, 'store', {
    /** GET /home: The Recommended tab: rails and the pack deal */
    getHome: async ({ principal }) => service.getHome(principal),
    /** GET /categories: Visible categories with their app counts */
    listCategories: async () => service.listCategories(),
    /** GET /apps: Published apps shown in the department */
    listApps: async ({ query, page, principal }) => service.listApps(query, page, principal),
    /** GET /apps/{slug}: An app with its files, versions, permissions and newest reviews */
    getApp: async ({ params, principal }) => service.getApp(params.slug, principal),
    /** GET /deals: Packs and apps on sale */
    getDeals: async ({ principal }) => service.getDeals(principal),
    /** GET /apps/{slug}/reviews: An app's reviews, newest first */
    listAppReviews: async ({ params, query, page, principal }) => service.listAppReviews(params.slug, query, page, principal),
    /** POST /apps/{slug}/reviews: Rate an app you own, or change your rating */
    reviewApp: async ({ params, body, scope, principal }) => service.reviewApp(customerOf(scope, principal), params.slug, body),
    /** POST /apps/{slug}/get: Own a free app */
    getFreeApp: async ({ params, scope, principal }) => service.getFreeApp(customerOf(scope, principal), params.slug),
    /** POST /apps/{slug}/downloads: A signed link to download an app's package or a database (any signed-in customer) */
    createDownload: async ({ params, body, scope, principal }) => service.createDownload(customerOf(scope, principal), params.slug, body ?? {}, principal!),
    /** GET /payment-options: Saved cards and a new-card session for buying an app or a pack */
    getPaymentOptions: async ({ query, scope, principal }) => service.getPaymentOptions(customerOf(scope, principal), query),
    /** POST /purchases: Buy an app or a pack */
    createPurchase: async ({ body, scope, principal, idempotencyKey, actor, requestId }) => service.createPurchase(customerOf(scope, principal), body, idempotencyKey, { actor, requestId }),
    /** GET /purchases/{id}: A purchase and its payment status */
    getPurchase: async ({ params, query, scope, principal, actor, requestId }) => service.getPurchase(customerOf(scope, principal), params.id, Boolean(query.refresh), { actor, requestId }),
    /** POST /purchases/{id}/complete-action: Finish the bank challenge of a purchase */
    completePurchaseAction: async ({ params, body, scope, principal, idempotencyKey, actor, requestId }) =>
      service.completePurchaseAction(customerOf(scope, principal), params.id, body.resultToken, idempotencyKey, { actor, requestId }),
    /** POST /purchases/{id}/retry: Pay a failed purchase again */
    retryPurchase: async ({ params, body, scope, principal, idempotencyKey, actor, requestId }) => service.retryPurchase(customerOf(scope, principal), params.id, body, idempotencyKey, { actor, requestId }),
    /** GET /purchases: My software purchases, newest first */
    listMyPurchases: async ({ page, scope, principal }) => service.listMyPurchases(customerOf(scope, principal), page),
    /** GET /library: Apps I own, newest first */
    listLibrary: async ({ page, scope, principal }) => service.listLibrary(customerOf(scope, principal), page),
  });
