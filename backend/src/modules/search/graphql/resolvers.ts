import type { ModuleResolvers } from '../../../kernel/graphql/index.js';
import type { SearchService } from '../service.js';

/**
 * Resolvers for the GraphQL fields this module owns (`@source(module: "search", …)` in graphql/schema.ts).
 * A field without a resolver answers NOT_IMPLEMENTED; fields of this module's own types without
 * @source resolve from the parent object.
 *
 * Fields to resolve:
 *   Product.bestSellerRank → service.bestSellerRanks
 *   Product.searchMatch → service.runSearch
 *   Product.related → service.similarProducts
 *   Seller.products → service.listSellerProducts
 *   Seller.categories → service.sellerCategoryCounts
 *   Query.search → service.runSearch
 *   Query.categoryProducts → service.listCategoryProducts
 *   Query.searchSuggestions → service.getSuggestions
 */
export const resolvers = (service: SearchService): ModuleResolvers => ({});
