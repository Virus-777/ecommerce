import type { ModuleResolvers } from '../../../kernel/graphql/index.js';
import type { AuditService } from '../service.js';

/**
 * Resolvers for the GraphQL fields this module owns (`@source(module: "audit", …)` in graphql/schema.ts).
 * A field without a resolver answers NOT_IMPLEMENTED; fields of this module's own types without
 * @source resolve from the parent object.
 *
 * Fields to resolve:
 *   Query.auditEntries → service.searchEntries
 *   Query.auditEntry → service.getEntry
 *   Order.auditTrail → service.trailOf
 *   Seller.auditTrail → service.trailOf
 *   Customer.auditTrail → service.trailOf
 *   PayoutRun.auditTrail → service.trailOf
 */
export const resolvers = (service: AuditService): ModuleResolvers => ({});
