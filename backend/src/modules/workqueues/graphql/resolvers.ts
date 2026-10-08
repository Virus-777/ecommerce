import type { ModuleResolvers } from '../../../kernel/graphql/index.js';
import type { WorkqueuesService } from '../service.js';

/**
 * Resolvers for the GraphQL fields this module owns (`@source(module: "workqueues", …)` in graphql/schema.ts).
 * A field without a resolver answers NOT_IMPLEMENTED; fields of this module's own types without
 * @source resolve from the parent object.
 *
 * Fields to resolve:
 *   Seller.openWorkItems → service.listForSubject
 *   Query.myQueues → service.getMyQueues
 *   Query.workSummary → service.getWorkSummary
 *   Query.workItems → service.listItems
 *   Query.workItem → service.getItem
 */
export const resolvers = (service: WorkqueuesService): ModuleResolvers => {
  void service;
  return {};
};
