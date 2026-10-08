import type { ModuleResolvers } from '../../../kernel/graphql/index.js';
import type { WishlistService } from '../service.js';

/**
 * Resolvers for the GraphQL fields this module owns (`@source(module: "wishlist", …)` in graphql/schema.ts).
 * A field without a resolver answers NOT_IMPLEMENTED; fields of this module's own types without
 * @source resolve from the parent object.
 *
 * Fields to resolve:
 *   Customer.wishlist → service.listItems
 *   Customer.wishlistLists → service.listLists
 *   Customer.wishlistAlerts → service.listAlerts
 *   Product.saved → service.isSaved
 */
export const resolvers = (service: WishlistService): ModuleResolvers => ({});
