import type { ModuleResolvers } from '../../../kernel/graphql/index.js';
import type { CheckoutService } from '../service.js';

/**
 * Resolvers for the GraphQL fields this module owns (`@source(module: "checkout", …)` in graphql/schema.ts).
 * A field without a resolver answers NOT_IMPLEMENTED; fields of this module's own types without
 * @source resolve from the parent object.
 *
 * Fields to resolve:
 *   CheckoutSession.confirmation → service.getConfirmation
 *   Query.checkoutSession → service.getSessionView
 */
export const resolvers = (service: CheckoutService): ModuleResolvers => {
  void service;
  return {};
};
