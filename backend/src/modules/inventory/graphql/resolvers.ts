import type { ModuleResolvers } from '../../../kernel/graphql/index.js';
import type { InventoryService } from '../service.js';

/**
 * Resolvers for the GraphQL fields this module owns (`@source(module: "inventory", …)` in graphql/schema.ts).
 * A field without a resolver answers NOT_IMPLEMENTED; fields of this module's own types without
 * @source resolve from the parent object.
 *
 * Fields to resolve:
 *   Offer.availability → service.getOfferAvailability
 *   Offer.stock → service.getStockForOffers
 *   Variant.stock → service.listStockForVariants
 *   Query.myStockSummary → service.getSellerStockSummary
 *   Query.stockSummary → service.getStockSummary
 */
export const resolvers = (service: InventoryService): ModuleResolvers => ({});
