import type { ModuleResolvers } from '../../../kernel/graphql/index.js';
import type { SupportService } from '../service.js';

/**
 * Resolvers for the GraphQL fields this module owns (`@source(module: "support", …)` in graphql/schema.ts).
 * A field without a resolver answers NOT_IMPLEMENTED; fields of this module's own types without
 * @source resolve from the parent object.
 *
 * Fields to resolve:
 *   Order.cases → service.listCasesForOrder
 *   Return.case → service.getCasesForReturns
 *   Customer.openCases → service.listOpenCasesForCustomer
 *   Customer.cases → service.listCasesForCustomer
 *   Seller.cases → service.listCasesForSeller
 *   Query.case → service.getCaseForCustomer
 *   Query.cases → service.listCasesForCustomer
 *   Query.sellerCase → service.getCaseForSeller
 *   Query.caseAdmin → service.getCaseAdmin
 */
export const resolvers = (service: SupportService): ModuleResolvers => {
  void service;
  return {};
};
