import type { ModuleResolvers } from '../../../kernel/graphql/index.js';
import type { FinanceService } from '../service.js';

/**
 * Resolvers for the GraphQL fields this module owns (`@source(module: "finance", …)` in graphql/schema.ts).
 * A field without a resolver answers NOT_IMPLEMENTED; fields of this module's own types without
 * @source resolve from the parent object.
 *
 * Fields to resolve:
 *   Offer.earningsPreview → service.previewOfferEarnings
 *   Seller.balance → service.getSellerBalances
 *   Seller.balance → service.getSellerBalances
 *   Seller.finance → service.getSellerAccount
 *   Case.holds → service.holdsForReference
 *   Query.sellerFinance → service.getSellerAccount
 *   Query.statement → service.getStatementForSeller
 *   Query.statementAdmin → service.getStatement
 *   Query.payoutRun → service.getPayoutRun
 *   Query.nextPayoutRun → service.getNextPayoutRun
 *   Query.refundImpactPreview → service.previewRefundImpactForOrder
 *   Query.payoutRuns → service.listPayoutRuns
 */
export const resolvers = (service: FinanceService): ModuleResolvers => ({});
