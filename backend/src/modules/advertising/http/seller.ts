import { notImplemented, routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/advertising.js';
import type { AdvertisingService } from '../service.js';

/**
 * Seller API: /api/seller/advertising/…  (docs/api/modules/advertising.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const sellerRoutes = (service: AdvertisingService) => {
  void service;
  return routes(endpoints, 'seller', {
    /** GET /summary: Ad spend, clicks and attributed orders for a period */
    sellerAdsSummary: notImplemented,
    /** GET /campaigns: Own sponsored campaigns with status and spend vs limit */
    listSellerAdCampaigns: notImplemented,
    /** GET /pricing: Billing models and rates (example until confirmed in the advertising terms) */
    getAdPricing: notImplemented,
    /** GET /promotable-offers: Own active offers with stock that can be promoted */
    listPromotableOffers: notImplemented,
    /** POST /creatives: Add a desktop or mobile creative for a request */
    uploadSellerCreative: notImplemented,
    /** POST /campaigns: Create a sponsored campaign request (draft) */
    createAdRequest: notImplemented,
    /** GET /campaigns/{id}: Request with review checks, previews, activity and results */
    getAdRequest: notImplemented,
    /** PATCH /campaigns/{id}: Edit a request (sends a request in review back to the start of review) */
    updateAdRequest: notImplemented,
    /** POST /campaigns/{id}/submit: Submit for Marketly review */
    submitAdRequest: notImplemented,
    /** POST /campaigns/{id}/withdraw: Withdraw a request in review */
    withdrawAdRequest: notImplemented,
    /** POST /campaigns/{id}/pause: Pause an own live campaign */
    pauseSellerAd: notImplemented,
    /** POST /campaigns/{id}/resume: Resume an own campaign paused by the seller */
    resumeSellerAd: notImplemented,
    /** GET /charges: Own ad charges by day (they appear on statements as a separate line) */
    listSellerAdCharges: notImplemented,
  });
};
