import type { ModuleResolvers } from '../../../kernel/graphql/index.js';
import type { CatalogService } from '../service.js';

/**
 * Resolvers for the GraphQL fields this module owns (`@source(module: "catalog", …)` in graphql/schema.ts).
 * A field without a resolver answers NOT_IMPLEMENTED; fields of this module's own types without
 * @source resolve from the parent object.
 *
 * Fields to resolve:
 *   Query.product → service.getProduct
 *   Query.categories → service.listCategories
 *   Query.category → service.getCategoryBySlug
 *   Query.brand → service.getBrandBySlug
 *   Query.myProduct → service.getProductForSeller
 *   Query.productReviewQueue → service.listReviewQueue
 *   Query.productAdmin → service.getProductAdmin
 *   Seller.catalogCounts → service.countProductsForSellers
 */
export const resolvers = (service: CatalogService): ModuleResolvers => {
  void service;
  return {};
};
