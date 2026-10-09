import { routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/offers.js';
import type { OffersService } from '../service.js';

/**
 * Store API: /api/store/offers/…  (docs/api/modules/offers.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const storeRoutes = (service: OffersService) =>
  routes(endpoints, 'store', {
    /** GET /products/{productId}/offers: All offers for a product variant with comparable totals to a delivery location */
    listProductOffers: async ({ params, query }) =>
      service.compareOffers(params.productId, {
        ...(query.variantId ? { variantId: query.variantId } : {}),
        ...(query.condition ? { condition: query.condition } : {}),
        ...(query.postalCode ? { postalCode: query.postalCode } : {}),
        ...(query.sort ? { sort: query.sort } : {}),
      }),
    /** GET /products/{productId}/purchase-box: Purchase box for the selected variant: featured or chosen offer, delivery, quantity options, variant availability */
    getPurchaseBox: async ({ params, query }) =>
      service.storefront.purchaseBox(params.productId, {
        ...(query.variantId ? { variantId: query.variantId } : {}),
        ...(query.offerId ? { offerId: query.offerId } : {}),
        ...(query.postalCode ? { postalCode: query.postalCode } : {}),
      }),
    /** GET /offers/{id}: One offer as the customer sees it (used by cart and review-changes) */
    getOfferView: async ({ params, query }) => service.storefront.offerView(params.id, { ...(query.postalCode ? { postalCode: query.postalCode } : {}), ...(query.quantity ? { quantity: query.quantity } : {}) }),
    /** GET /featured-offer-rule: Published featured-offer rule ('How we choose the featured offer') */
    getFeaturedRule: async () => service.featured.currentRule(),
  });
