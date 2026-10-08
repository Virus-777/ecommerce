import type { ModuleResolvers } from '../../../kernel/graphql/index.js';
import type { OffersService } from '../service.js';

/**
 * Resolvers for the GraphQL fields this module owns (`@source(module: "offers", …)` in graphql/schema.ts).
 * A field without a resolver answers NOT_IMPLEMENTED; fields of this module's own types without
 * @source resolve from the parent object.
 *
 * Fields to resolve:
 *   Offer.quote → service.quoteOffer
 *   Product.offers → service.compareOffers
 *   Product.featuredOffer → service.getFeaturedOfferForProduct
 *   Product.offer → service.getPurchaseBoxOffer
 *   Product.offerCount → service.getOfferStats
 *   Product.priceRange → service.getOfferStats
 *   Product.myOffers → service.listOwnOffersForProduct
 *   Product.featuredDecision → service.getFeaturedDecision
 *   SellerCollection.offers → service.listActiveOffersByIds
 *   Variant.offerSummary → service.getVariantOfferSummaries
 *   Query.offer → service.getOffer
 *   Query.myOffer → service.getOwnOffer
 *   Query.offerAdmin → service.getOfferAdmin
 *   Query.offersAdmin → service.listOffersAdmin
 */
export const resolvers = (service: OffersService): ModuleResolvers => {
  void service;
  return {};
};
