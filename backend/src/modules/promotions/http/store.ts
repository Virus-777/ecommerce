import { notImplemented, routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/promotions.js';
import type { PromotionsService } from '../service.js';

/**
 * Store API: /api/store/promotions/…  (docs/api/modules/promotions.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const storeRoutes = (service: PromotionsService) =>
  routes(endpoints, 'store', {
    /** GET /deals: Deals page: flash sales, coupons, clearance and upcoming events */
    getDeals: notImplemented,
    /** GET /deals/clearance: More clearance products */
    listClearance: notImplemented,
    /** GET /deals/coupons: More clippable coupons */
    listDealCoupons: notImplemented,
    /** GET /flash-sales/{campaignId}: One flash sale with live claimed meters */
    getFlashSale: notImplemented,
    /** GET /products/{productId}: Promotions for a product page: deal prices per offer, purchase limits, countdowns, seller promos and coupons */
    getProductPromotions: notImplemented,
    /** GET /offer-prices: Promotion prices for a set of offers (product cards, collections, wishlist) */
    priceOffersStore: notImplemented,
    /** GET /campaigns/{id}/eligible-products: Items a coupon or campaign applies to ('Eligible items') */
    listCampaignProducts: notImplemented,
    /** POST /codes/check: Look up a coupon code's terms without applying it */
    checkCode: notImplemented,
    /** GET /coupons: My coupons: available and clipped, used and expired */
    listMyCoupons: notImplemented,
    /** POST /coupons/{campaignId}/clip: Clip a coupon so it applies automatically at checkout */
    clipCoupon: notImplemented,
    /** DELETE /coupons/{campaignId}/clip: Remove a clipped coupon */
    unclipCoupon: notImplemented,
    /** POST /events/{campaignId}/reminder: Remind me when an upcoming event starts */
    setEventReminder: notImplemented,
    /** DELETE /events/{campaignId}/reminder: Cancel an event reminder */
    removeEventReminder: notImplemented,
  });
