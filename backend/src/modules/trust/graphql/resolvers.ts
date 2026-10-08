import type { ModuleResolvers } from '../../../kernel/graphql/index.js';
import type { TrustService } from '../service.js';

/**
 * Resolvers for the GraphQL fields this module owns (`@source(module: "trust", …)` in graphql/schema.ts).
 * A field without a resolver answers NOT_IMPLEMENTED; fields of this module's own types without
 * @source resolve from the parent object.
 *
 * Fields to resolve:
 *   Customer.trustReportCounts → service.reportsAbout
 *   Customer.trustReports → service.listReportsAbout
 *   Seller.trustReportCounts → service.reportsAbout
 *   Seller.trustReports → service.listReportsAbout
 *   SellerRestriction.trustReport → service.getReportSummaries
 *   CustomerRestriction.trustReport → service.getReportSummaries
 */
export const resolvers = (service: TrustService): ModuleResolvers => {
  void service;
  return {};
};
