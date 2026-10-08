import type { ModuleResolvers } from '../../../kernel/graphql/index.js';
import type { CartService } from '../service.js';

/**
 * Resolvers for the GraphQL fields this module owns (`@source(module: "cart", …)` in graphql/schema.ts).
 * A field without a resolver answers NOT_IMPLEMENTED; fields of this module's own types without
 * @source resolve from the parent object.
 *
 * Fields to resolve:
 *   Query.cart → service.getCartView
 */
export const resolvers = (service: CartService): ModuleResolvers => {
  void service;
  return {};
};
