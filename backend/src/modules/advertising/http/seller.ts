import { routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/advertising.js';
import type { AdvertisingService } from '../service.js';

/**
 * Seller API: /api/seller/advertising/…  (docs/api/modules/advertising.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 * Sellers act for input.sellerId only; another seller's campaign is 404.
 */
export const sellerRoutes = (service: AdvertisingService) => {
  const s = service.sellers;
  return routes(endpoints, 'seller', {
    /** GET /summary: Ad spend, clicks and attributed orders for a period */
    sellerAdsSummary: async ({ sellerId, query }) => s.summary(sellerId, query),
    /** GET /campaigns: Own sponsored campaigns with status and spend vs limit */
    listSellerAdCampaigns: async ({ sellerId, query, page }) => s.list(sellerId, query, page),
    /** GET /pricing: Billing models and rates (example until confirmed in the advertising terms) */
    getAdPricing: async ({ query }) => s.pricing(query.type),
    /** GET /promotable-offers: Own active offers with stock that can be promoted */
    listPromotableOffers: async ({ sellerId, query, page }) => s.promotableOffers(sellerId, query, page),
    /** POST /creatives: Add a desktop or mobile creative for a request */
    uploadSellerCreative: async ({ sellerId, body, actor, requestId, principal }) => s.uploadCreative(sellerId, body, { actor, requestId, principal }),
    /** POST /campaigns: Create a sponsored campaign request (draft) */
    createAdRequest: async ({ sellerId, body, actor, requestId, principal }) => s.create(sellerId, body, { actor, requestId, principal }),
    /** GET /campaigns/{id}: Request with review checks, previews, activity and results */
    getAdRequest: async ({ sellerId, params }) => s.get(sellerId, params.id),
    /** PATCH /campaigns/{id}: Edit a request (sends a request in review back to the start of review) */
    updateAdRequest: async ({ sellerId, params, body, actor, requestId, principal }) => s.update(sellerId, params.id, body, { actor, requestId, principal }),
    /** POST /campaigns/{id}/submit: Submit for Marketly review */
    submitAdRequest: async ({ sellerId, params, actor, requestId, principal }) => s.submit(sellerId, params.id, { actor, requestId, principal }),
    /** POST /campaigns/{id}/withdraw: Withdraw a request in review */
    withdrawAdRequest: async ({ sellerId, params, actor, requestId, principal }) => s.withdraw(sellerId, params.id, { actor, requestId, principal }),
    /** POST /campaigns/{id}/pause: Pause an own live campaign */
    pauseSellerAd: async ({ sellerId, params, actor, requestId, principal }) => s.pause(sellerId, params.id, { actor, requestId, principal }),
    /** POST /campaigns/{id}/resume: Resume an own campaign paused by the seller */
    resumeSellerAd: async ({ sellerId, params, actor, requestId, principal }) => s.resume(sellerId, params.id, { actor, requestId, principal }),
    /** GET /charges: Own ad charges by day (they appear on statements as a separate line) */
    listSellerAdCharges: async ({ sellerId, query, page }) => service.billing.list({ sellerId, ...query }, page),
  });
};
