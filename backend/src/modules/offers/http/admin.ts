import { notImplemented, routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/offers.js';
import type { OffersService } from '../service.js';

/**
 * Admin API: /api/admin/offers/…  (docs/api/modules/offers.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const adminRoutes = (service: OffersService) =>
  routes(endpoints, 'admin', {
    /** GET /offers: All offers with filters (seller, product, status, eligibility) */
    listOffersAdmin: notImplemented,
    /** GET /offers/{id}: Offer with status log, price history and price changes */
    getOfferAdmin: notImplemented,
    /** POST /offers/{id}/remove: Remove an offer with a reason (seller is told the reason and appeal route) */
    removeOffer: notImplemented,
    /** POST /offers/{id}/hold: Hold an offer during an investigation (Ineligible, staff_hold) with a reason and review date */
    holdOffer: notImplemented,
    /** POST /offers/{id}/release-hold: Release a staff hold */
    releaseOfferHold: notImplemented,
    /** POST /offers/{id}/reinstate: Reinstate a removed offer as Paused (e.g. after a successful appeal) */
    reinstateOffer: notImplemented,
    /** GET /official/offers: Official Store offers with price, cost, margin and sellable stock */
    listOfficialOffers: notImplemented,
    /** POST /official/offers: Create an Official Store offer linked to a company stock item */
    createOfficialOffer: notImplemented,
    /** PATCH /official/offers/{id}: Edit Official Store offer terms (not price; use price changes) */
    updateOfficialOffer: notImplemented,
    /** POST /official/offers/{id}/publish: Publish an Official Store offer */
    publishOfficialOffer: notImplemented,
    /** POST /official/offers/{id}/pause: Hide an Official Store offer */
    pauseOfficialOffer: notImplemented,
    /** POST /official/offers/{id}/resume: Show a hidden Official Store offer again */
    resumeOfficialOffer: notImplemented,
    /** POST /official/offers/{id}/price-changes: Change an Official Store price (now or scheduled) with a reason */
    requestOfficialPriceChange: notImplemented,
    /** GET /price-changes: Pending, scheduled and recent price changes */
    listPriceChanges: notImplemented,
    /** POST /price-changes/{id}/cancel: Cancel a scheduled or pending price change */
    cancelPriceChange: notImplemented,
    /** POST /official/bulk-updates: Upload an Official Store price file for preview */
    createOfficialBulkUpdate: notImplemented,
    /** GET /official/bulk-updates/{id}: Official Store bulk job state and totals */
    getOfficialBulkUpdate: notImplemented,
    /** GET /official/bulk-updates/{id}/rows: Official Store bulk preview rows */
    listOfficialBulkUpdateRows: notImplemented,
    /** POST /official/bulk-updates/{id}/apply: Apply valid rows; rows above the price-change limit become approval requests */
    applyOfficialBulkUpdate: notImplemented,
    /** GET /featured-rule: Current, scheduled and past versions of the featured-offer rule */
    getFeaturedRuleAdmin: notImplemented,
    /** POST /featured-rule/versions: Publish a new version of the featured-offer rule with an effective date */
    publishFeaturedRule: notImplemented,
    /** GET /products/{productId}/featured-decision: Why an offer is (or is not) featured for a variant and location */
    explainFeaturedOffer: notImplemented,
    /** POST /featured-decisions/recompute: Recompute featured decisions for a product (or everything) */
    recomputeFeatured: notImplemented,
  });
