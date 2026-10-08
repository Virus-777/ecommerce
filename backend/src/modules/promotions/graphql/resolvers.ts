import type { ModuleResolvers } from '../../../kernel/graphql/index.js';
import type { PromotionsService } from '../service.js';

/**
 * Resolvers for the GraphQL fields this module owns (`@source(module: "promotions", …)` in graphql/schema.ts).
 * A field without a resolver answers NOT_IMPLEMENTED; fields of this module's own types without
 * @source resolve from the parent object.
 *
 * Fields to resolve:
 *   DealsOverview.clearance → service.listClearance
 *   Offer.deal → service.priceOffers
 *   Product.coupons → service.couponsForProduct
 *   Customer.coupons → service.couponsForCustomer
 *   Seller.activePromotions → service.activeSellerPromotions
 *   OrderItem.discountFunding → service.fundingSplitFor
 *   HomeSection.flashSales → service.liveDeals
 *   HomeSection.campaign → service.getPublicCampaign
 *   ContentPage.campaign → service.getPublicCampaign
 *   Query.deals → service.getDealsPage
 *   Query.flashSales → service.liveDeals
 *   Query.flashSale → service.getFlashSale
 */
export const resolvers = (service: PromotionsService): ModuleResolvers => {
  void service;
  return {};
};
