import type { ModuleResolvers } from '../../../kernel/graphql/index.js';
import type { AdvertisingService } from '../service.js';

/**
 * Resolvers for the GraphQL fields this module owns (`@source(module: "advertising", …)` in graphql/schema.ts).
 * A field without a resolver answers NOT_IMPLEMENTED; fields of this module's own types without
 * @source resolve from the parent object.
 *
 * Fields to resolve:
 *   PromotionCampaign.adCampaigns → service.campaignsForPromotion
 *   Query.adDashboard → service.dashboardSummary
 */
export const resolvers = (service: AdvertisingService): ModuleResolvers => {
  void service;
  return {};
};
