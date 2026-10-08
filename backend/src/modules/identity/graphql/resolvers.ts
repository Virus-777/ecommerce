import type { ModuleResolvers } from '../../../kernel/graphql/index.js';
import type { IdentityService } from '../service.js';

/**
 * Resolvers for the GraphQL fields this module owns (`@source(module: "identity", …)` in graphql/schema.ts).
 * A field without a resolver answers NOT_IMPLEMENTED; fields of this module's own types without
 * @source resolve from the parent object.
 *
 * Fields to resolve:
 *   Customer.security → service.accountSecurityOf
 */
export const resolvers = (service: IdentityService): ModuleResolvers => {
  void service;
  return {};
};
