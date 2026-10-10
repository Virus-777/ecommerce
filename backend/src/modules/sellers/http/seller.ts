import { routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/sellers.js';
import type { SellersService } from '../service.js';

/**
 * Seller API: /api/seller/sellers/…  (docs/api/modules/sellers.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 * Every call acts for input.sellerId (the session's seller); another seller's record ids answer 404.
 */
export const sellerRoutes = (service: SellersService) => {
  const { accounts, storefront, members, enforcement, performance } = service;
  return routes(endpoints, 'seller', {
    getAccount: async ({ sellerId, sellerAccess }) => accounts.getAccount(sellerId, sellerAccess ?? null),
    getSetup: async ({ sellerId }) => accounts.getSetup(sellerId),
    requestLaunchReview: async ({ sellerId, body, actor, requestId }) => accounts.requestLaunchReview(sellerId, body?.note, { actor, requestId }),
    getBusinessDetails: async ({ sellerId }) => accounts.getBusinessDetails(sellerId),
    updateBusinessContact: async ({ sellerId, body, actor, requestId }) => accounts.updateBusinessContact(sellerId, body, { actor, requestId }),
    requestBusinessChange: async ({ sellerId, body, actor, requestId }) => storefront.requestBusinessChange(sellerId, body, { actor, requestId }),
    listOwnChangeRequests: async ({ sellerId, query, page }) => storefront.listOwnChangeRequests(sellerId, query.state, page),
    withdrawChangeRequest: async ({ sellerId, params, actor, requestId }) => storefront.withdrawChangeRequest(sellerId, params.id, { actor, requestId }),
    getStoreProfile: async ({ sellerId }) => storefront.getStoreProfile(sellerId),
    updateStoreProfile: async ({ sellerId, body, actor, requestId }) => storefront.updateStoreProfile(sellerId, body, { actor, requestId }),
    submitPublicClaim: async ({ sellerId, body, actor, requestId }) => storefront.submitPublicClaim(sellerId, body, { actor, requestId }),
    requestBrand: async ({ sellerId, body, actor, requestId }) => storefront.requestBrand(sellerId, body, { actor, requestId }),
    withdrawPublicClaim: async ({ sellerId, params, actor, requestId }) => storefront.withdrawPublicClaim(sellerId, params.id, { actor, requestId }),
    createCollection: async ({ sellerId, body, actor, requestId }) => storefront.createCollection(sellerId, body, { actor, requestId }),
    updateCollection: async ({ sellerId, params, body, actor, requestId }) => storefront.updateCollection(sellerId, params.id, body, { actor, requestId }),
    deleteCollection: async ({ sellerId, params, actor, requestId }) => {
      await storefront.deleteCollection(sellerId, params.id, { actor, requestId });
    },
    reorderCollections: async ({ sellerId, body, actor, requestId }) => storefront.reorderCollections(sellerId, body.collectionIds, { actor, requestId }),
    listMembers: async ({ sellerId }) => members.listMembers(sellerId),
    listRoleTemplates: async () => members.listRoleTemplates(),
    inviteMember: async ({ sellerId, body, actor, requestId }) => members.inviteMember(sellerId, body, { actor, requestId }),
    resendInvitation: async ({ sellerId, params, actor, requestId }) => members.resendInvitation(sellerId, params.id, { actor, requestId }),
    revokeInvitation: async ({ sellerId, params, actor, requestId }) => members.revokeInvitation(sellerId, params.id, { actor, requestId }),
    updateMember: async ({ sellerId, params, body, actor, requestId }) => members.updateMember(sellerId, params.id, body, { actor, requestId }),
    suspendMember: async ({ sellerId, params, body, actor, requestId }) => members.suspendMember(sellerId, params.id, body?.reason, { actor, requestId }),
    removeMember: async ({ sellerId, params, body, actor, requestId }) => members.removeMember(sellerId, params.id, body?.reason, { actor, requestId }),
    getPerformance: async ({ sellerId }) => performance.getPerformance(sellerId),
    listOwnRestrictions: async ({ sellerId, query, page }) => enforcement.listOwnRestrictions(sellerId, query.state, page),
    getOwnRestriction: async ({ sellerId, params }) => enforcement.getOwnRestriction(sellerId, params.id),
    submitResolutionEvidence: async ({ sellerId, params, body, actor, requestId }) => enforcement.submitResolutionEvidence(sellerId, params.id, body, { actor, requestId }),
    appealRestriction: async ({ sellerId, params, body, actor, requestId }) => enforcement.appealRestriction(sellerId, params.id, body, { actor, requestId }),
    listOwnAppeals: async ({ sellerId, page }) => enforcement.listOwnAppeals(sellerId, page),
    withdrawOwnAppeal: async ({ sellerId, params, actor, requestId }) => enforcement.withdrawOwnAppeal(sellerId, params.id, { actor, requestId }),
    getPayoutAccount: async ({ sellerId }) => accounts.getPayoutAccount(sellerId),
    changePayoutAccount: async ({ sellerId, body, actor, requestId }) => accounts.changePayoutAccount(sellerId, body, { actor, requestId }),
    listAgreements: async ({ sellerId }) => accounts.listAgreements(sellerId),
    acceptAgreement: async ({ sellerId, params, body, actor, requestId }) => accounts.acceptAgreement(sellerId, params.key, body, { actor, requestId }),
    requestSellerClosure: async ({ sellerId, body, actor, requestId }) => accounts.requestSellerClosure(sellerId, body.reason, { actor, requestId }),
    reactivateMember: async ({ sellerId, params, body, actor, requestId }) => members.reactivateMember(sellerId, params.id, body?.reason, { actor, requestId }),
  });
};
