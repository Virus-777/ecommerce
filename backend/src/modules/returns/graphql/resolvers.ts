import type { ModuleResolvers } from '../../../kernel/graphql/index.js';
import type { ReturnsService } from '../service.js';

/**
 * Resolvers for the GraphQL fields this module owns (`@source(module: "returns", …)` in graphql/schema.ts).
 * A field without a resolver answers NOT_IMPLEMENTED; fields of this module's own types without
 * @source resolve from the parent object.
 *
 * Fields to resolve:
 *   Order.returns → service.listForOrder
 *   Order.refundRequests → service.listRefundRequestsForOrder
 *   OrderItem.returnEligibility → service.eligibilityForItems
 *   Customer.returnsOverview → service.customerOverview
 *   Customer.openReturns → service.listOpenForCustomer
 *   Customer.returns → service.listForCustomer
 *   Seller.returnCounts → service.sellerQueueCounts
 *   Seller.returns → service.listForSeller
 *   Seller.returnTerms → service.sellerReturnTermsFor
 *   Case.refundRequests → service.listRefundRequestsForCase
 *   Query.return → service.getReturnForCustomer
 *   Query.returns → service.listForCustomer
 *   Query.sellerReturn → service.getReturnForSeller
 *   Query.returnAdmin → service.getReturnAdmin
 *   Query.refundRequests → service.listRefundRequests
 *   Query.refundRequest → service.getRefundRequest
 */
export const resolvers = (service: ReturnsService): ModuleResolvers => ({});
