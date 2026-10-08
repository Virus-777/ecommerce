import type { ModuleResolvers } from '../../../kernel/graphql/index.js';
import type { SellersService } from '../service.js';

/**
 * Resolvers for the GraphQL fields this module owns (`@source(module: "sellers", …)` in graphql/schema.ts).
 * A field without a resolver answers NOT_IMPLEMENTED; fields of this module's own types without
 * @source resolve from the parent object.
 *
 * Fields to resolve:
 *   Offer.seller → service.getStorefrontCard
 *   Product.ownerSeller → service.getSellers
 *   Query.sellerStorefront → service.getStorefrontBySlug
 *   Query.mySeller → service.getSeller
 *   Query.sellerAdmin → service.getSeller
 *   Query.sellers → service.searchSellers
 */
export const resolvers = (service: SellersService): ModuleResolvers => {
  void service;
  return {};
};
