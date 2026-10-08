import type { ModuleResolvers } from '../../../kernel/graphql/index.js';
import type { CustomersService } from '../service.js';

/**
 * Resolvers for the GraphQL fields this module owns (`@source(module: "customers", …)` in graphql/schema.ts).
 * A field without a resolver answers NOT_IMPLEMENTED; fields of this module's own types without
 * @source resolve from the parent object.
 *
 * Fields to resolve:
 *   Query.me → service.getCustomerByUserId
 *   Query.recentlyViewed → service.listRecentlyViewedItems
 *   Query.customer → service.getCustomer
 *   Query.customers → service.searchCustomers
 */
export const resolvers = (service: CustomersService): ModuleResolvers => ({});
