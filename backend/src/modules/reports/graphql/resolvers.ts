import type { ModuleResolvers } from '../../../kernel/graphql/index.js';
import type { ReportsService } from '../service.js';

/**
 * Resolvers for the GraphQL fields this module owns (`@source(module: "reports", …)` in graphql/schema.ts).
 * A field without a resolver answers NOT_IMPLEMENTED; fields of this module's own types without
 * @source resolve from the parent object.
 *
 * Fields to resolve:
 *   Query.adminDashboard → service.getAdminDashboard
 *   Query.sellerDashboard → service.getSellerDashboard
 */
export const resolvers = (service: ReportsService): ModuleResolvers => ({});
