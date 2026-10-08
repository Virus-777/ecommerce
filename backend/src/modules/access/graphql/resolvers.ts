import type { ModuleResolvers } from '../../../kernel/graphql/index.js';
import type { AccessService } from '../service.js';

/**
 * Resolvers for the GraphQL fields this module owns (`@source(module: "access", …)` in graphql/schema.ts).
 * A field without a resolver answers NOT_IMPLEMENTED; fields of this module's own types without
 * @source resolve from the parent object.
 *
 * Fields to resolve:
 *   Query.myApprovalLimit → service.myLimitFor
 *   Query.approvalsWaitingForMe → service.listApprovalsToDecide
 *   Query.myApprovalSummary → service.approvalSummaryFor
 *   Query.approvalRequest → service.getApprovalForViewer
 *   Query.teamOnShift → service.coverageNow
 *   PayoutRun.approvalRequest → service.approvalForTargets
 *   Hold.approvalRequest → service.approvalForTargets
 *   RefundRequest.approvalRequest → service.approvalForTargets
 *   Seller.pendingApprovals → service.approvalsForSellers
 */
export const resolvers = (service: AccessService): ModuleResolvers => ({});
