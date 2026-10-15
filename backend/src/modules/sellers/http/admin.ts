import { routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/sellers.js';
import type { SellersService } from '../service.js';

/**
 * Admin API: /api/admin/sellers/…  (docs/api/modules/sellers.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 * Enforcement and money-related decisions go through access (limits, second reviewer) in the service.
 */
export const adminRoutes = (service: SellersService) => {
  const { accounts, applications, enforcement, storefront, performance } = service;
  return routes(endpoints, 'admin', {
    listSellers: async ({ query, page, can }) => accounts.listSellers(query, page, { canSeeBalances: await can('finance.ledger.view') }),
    getSellerStats: async ({ can }) => accounts.getSellerStats({ canSeeBalances: await can('finance.ledger.view') }),
    getSellerAdmin: async ({ params, can }) => accounts.getSellerAdmin(await accounts.sellerIdOf(params.id), { canSeeBalances: await can('finance.ledger.view') }),
    addSellerNote: async ({ params, body, actor, requestId }) => accounts.addSellerNote(params.id, body.body, { actor, requestId }),
    assignAccountManager: async ({ params, body, actor, requestId }) => accounts.assignAccountManager(params.id, body.staffId, { actor, requestId }),
    createRestriction: async ({ params, body, actor, requestId, principal }) => enforcement.createRestriction(params.id, body, { actor, requestId, principal }),
    updateRestriction: async ({ params, body, actor, requestId, principal }) => enforcement.updateRestriction(params.id, body, { actor, requestId, principal }),
    liftRestriction: async ({ params, body, actor, requestId, principal }) => enforcement.liftRestriction(params.id, body.reason, { actor, requestId, principal }),
    previewSuspension: async ({ params }) => enforcement.previewSuspension(params.id),
    suspendSeller: async ({ params, body, actor, requestId, principal }) => enforcement.suspendSeller(params.id, body, { actor, requestId, principal }),
    reinstateSeller: async ({ params, body, actor, requestId, principal }) => {
      const s = await enforcement.reinstateSeller(params.id, body, { actor, requestId, principal });
      return accounts.account(s, null, [], { staff: true });
    },
    closeSeller: async ({ params, body, actor, requestId, principal }) => accounts.closeSeller(params.id, body, { actor, requestId, principal }),
    issueWarning: async ({ params, body, actor, requestId }) => enforcement.issueWarning(params.id, body, { actor, requestId }),
    resolveWarning: async ({ params, body, actor, requestId }) => enforcement.resolveWarning(params.id, body.note, { actor, requestId }),
    setVerificationLabel: async ({ params, body, actor, requestId }) => accounts.setVerificationLabel(params.id, body, { actor, requestId }),
    decideLaunchReview: async ({ params, body, actor, requestId }) => accounts.decideLaunchReview(params.id, body, { actor, requestId }),
    listApplications: async ({ query, page }) => applications.listApplications(query, page),
    getApplicationAdmin: async ({ params }) => applications.getApplicationAdmin(params.id),
    assignApplication: async ({ params, body, actor, requestId }) => applications.assignApplication(params.id, body.reviewerId, { actor, requestId }),
    startApplicationReview: async ({ params, actor, requestId }) => applications.startApplicationReview(params.id, { actor, requestId }),
    rerunCheck: async ({ params, actor, requestId }) => applications.rerunCheck(params.id, params.checkId, { actor, requestId }),
    recordCheckResult: async ({ params, body, actor, requestId }) => applications.recordCheckResult(params.id, params.checkId, body, { actor, requestId }),
    requestTrustReview: async ({ params, body, actor, requestId }) => applications.requestTrustReview(params.id, body.question, { actor, requestId }),
    requestApplicationInformation: async ({ params, body, actor, requestId }) => applications.requestApplicationInformation(params.id, body, { actor, requestId }),
    approveApplication: async ({ params, body, actor, requestId, principal }) => applications.approveApplication(params.id, body ?? {}, { actor, requestId, principal }),
    rejectApplication: async ({ params, body, actor, requestId }) => applications.rejectApplication(params.id, body, { actor, requestId }),
    addApplicationNote: async ({ params, body, actor, requestId }) => applications.addApplicationNote(params.id, body.body, { actor, requestId }),
    listAppealsAdmin: async ({ query, page }) => enforcement.listAppealsAdmin(query, page),
    assignAppeal: async ({ params, body, actor, requestId }) => enforcement.assignAppeal(params.id, body.reviewerId, { actor, requestId }),
    decideAppeal: async ({ params, body, actor, requestId, principal }) => enforcement.decideAppeal(params.id, body, { actor, requestId, principal }),
    listChangeRequestsAdmin: async ({ query, page }) => storefront.listChangeRequestsAdmin(query, page),
    decideChangeRequest: async ({ params, body, actor, requestId }) => storefront.decideChangeRequest(params.id, body, { actor, requestId }),
    revokePublicClaim: async ({ params, body, actor, requestId }) => storefront.revokePublicClaim(params.id, body, { actor, requestId }),
    listPerformanceTargets: async () => performance.listPerformanceTargets(),
    setPerformanceTargets: async ({ body, actor, requestId, principal }) => performance.setPerformanceTargets(body.targets, body.reason, { actor, requestId, principal }),
    inviteSeller: async ({ body, actor, requestId }) => applications.inviteSeller(body, { actor, requestId }),
    listSellerInvitations: async ({ query, page }) => applications.listSellerInvitations(query.state, page),
    revokeSellerInvitation: async ({ params, actor, requestId }) => applications.revokeSellerInvitation(params.id, { actor, requestId }),
    exportSellers: async ({ body, principal, actor, requestId }) => accounts.exportSellers(body, principal, { actor, requestId, principal }),
  });
};
