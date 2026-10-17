import { AppError } from '../../../kernel/errors/index.js';
import { routes } from '../../../kernel/http/index.js';
import type { Scope } from '../../../kernel/auth/scope.js';
import { isUuid } from '../../../kernel/lib/ids.js';
import { pageOf } from '../../../kernel/lib/pagination.js';
import { endpoints } from '../../../spec/promotions.js';
import type { PromotionsService } from '../service.js';

/** The signed-in customer (customer id, or the account id while customers is off); null for visitors */
export const customerOf = (scope: Scope): string | null => (scope.kind === 'customer' ? (scope.customerId ?? scope.accountId) : null);

const requireCustomer = (scope: Scope): string => {
  const id = customerOf(scope);
  if (!id) throw new AppError('UNAUTHORIZED', 'Sign in to see your coupons');
  return id;
};

/**
 * Store API: /api/store/promotions/…  (docs/api/modules/promotions.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const storeRoutes = (service: PromotionsService) =>
  routes(endpoints, 'store', {
    /** GET /deals: Deals page: flash sales, coupons, clearance and upcoming events */
    getDeals: async ({ query, scope }) => service.storefront.getDealsPage({ customerId: customerOf(scope) ?? undefined }, query.tab),
    /** GET /deals/clearance: More clearance products */
    listClearance: async ({ query, page, scope }) => pageOf(await service.storefront.clearanceProducts({ categoryId: query.categoryId, customerId: customerOf(scope) }), page),
    /** GET /deals/coupons: More clippable coupons */
    listDealCoupons: async ({ query, page, scope }) => service.storefront.listDealCoupons(customerOf(scope), query.sellerId, page),
    /** GET /flash-sales/{campaignId}: One flash sale with live claimed meters */
    getFlashSale: async ({ params }) => {
      const block = await service.storefront.getFlashSale(params.campaignId);
      if (!block) throw new AppError('NOT_FOUND', 'Flash sale not found');
      return block;
    },
    /** GET /products/{productId}: Promotions for a product page */
    getProductPromotions: async ({ params, query, scope }) => service.storefront.productPromotions(params.productId, query.variantId, customerOf(scope)),
    /** GET /offer-prices: Promotion prices for a set of offers (product cards, collections, wishlist) */
    priceOffersStore: async ({ query, scope }) => {
      const ids = [...new Set(query.offerIds.split(',').map((s) => s.trim()).filter(Boolean))];
      const bad = ids.filter((id) => !isUuid(id));
      if (bad.length || ids.length > 100) throw new AppError('VALIDATION_FAILED', bad.length ? 'Offer ids must be UUIDs' : 'Up to 100 offers per request', { issues: [{ path: 'offerIds', message: bad.length ? `Not offer ids: ${bad.slice(0, 3).join(', ')}` : 'Up to 100 offers' }] });
      return service.storefront.priceOffers(ids, { customerId: customerOf(scope) ?? undefined });
    },
    /** GET /campaigns/{id}/eligible-products: Items a coupon or campaign applies to ('Eligible items') */
    listCampaignProducts: async ({ params, page }) => service.storefront.campaignProducts(params.id, page),
    /** POST /codes/check: Look up a coupon code's terms without applying it */
    checkCode: async ({ body, scope, principal }) => service.storefront.checkCode(body.code, customerOf(scope), principal.sessionId),
    /** GET /coupons: My coupons: available and clipped, used and expired */
    listMyCoupons: async ({ scope }) => service.storefront.couponsForCustomer(requireCustomer(scope)),
    /** POST /coupons/{campaignId}/clip: Clip a coupon so it applies automatically at checkout */
    clipCoupon: async ({ params, scope }) => service.storefront.clip(params.campaignId, requireCustomer(scope)),
    /** DELETE /coupons/{campaignId}/clip: Remove a clipped coupon */
    unclipCoupon: async ({ params, scope }) => service.storefront.unclip(params.campaignId, requireCustomer(scope)),
    /** POST /events/{campaignId}/reminder: Remind me when an upcoming event starts */
    setEventReminder: async ({ params, scope }) => service.storefront.setReminder(params.campaignId, requireCustomer(scope)),
    /** DELETE /events/{campaignId}/reminder: Cancel an event reminder */
    removeEventReminder: async ({ params, scope }) => service.storefront.removeReminder(params.campaignId, requireCustomer(scope)),
  });
