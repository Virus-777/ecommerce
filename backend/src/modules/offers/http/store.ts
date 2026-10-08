import { notImplemented, routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/offers.js';
import type { OffersService } from '../service.js';

/**
 * Store API: /api/store/offers/…  (docs/api/modules/offers.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const storeRoutes = (service: OffersService) =>
  routes(endpoints, 'store', {
    /** GET /products/{productId}/offers: All offers for a product variant with comparable totals to a delivery location */
    listProductOffers: notImplemented,
    /** GET /products/{productId}/purchase-box: Purchase box for the selected variant: featured or chosen offer, delivery, quantity options, variant availability */
    getPurchaseBox: notImplemented,
    /** GET /offers/{id}: One offer as the customer sees it (used by cart and review-changes) */
    getOfferView: notImplemented,
    /** GET /featured-offer-rule: Published featured-offer rule ('How we choose the featured offer') */
    getFeaturedRule: notImplemented,
  });
