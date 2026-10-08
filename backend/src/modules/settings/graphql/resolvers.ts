import type { ModuleResolvers } from '../../../kernel/graphql/index.js';
import type { SettingsService } from '../service.js';

/**
 * Resolvers for the GraphQL fields this module owns (`@source(module: "settings", …)` in graphql/schema.ts).
 * A field without a resolver answers NOT_IMPLEMENTED; fields of this module's own types without
 * @source resolve from the parent object.
 *
 * Fields to resolve:
 *   Query.storeInfo → service.storeInfo
 *   Query.upcomingChanges → service.upcomingChangesForSellers
 */
export const resolvers = (service: SettingsService): ModuleResolvers => {
  void service;
  return {};
};
