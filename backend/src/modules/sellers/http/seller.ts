import { notImplemented, routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/sellers.js';
import type { SellersService } from '../service.js';

/**
 * Seller API: /api/seller/sellers/…  (docs/api/modules/sellers.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const sellerRoutes = (service: SellersService) =>
  routes(endpoints, 'seller', {
    /** GET /account: Account status, verification, product approval, payout readiness and active restrictions */
    getAccount: notImplemented,
    /** GET /setup: Setup checklist and what will go live after the launch review */
    getSetup: notImplemented,
    /** POST /setup/launch-review: Ask the Seller Manager for the launch readiness review */
    requestLaunchReview: notImplemented,
    /** GET /business: Legal and contact details */
    getBusinessDetails: notImplemented,
    /** PATCH /business/contact: Update contact person, email, phone and support hours */
    updateBusinessContact: notImplemented,
    /** POST /business/change-requests: Request a change to legal name, ownership or business address */
    requestBusinessChange: notImplemented,
    /** GET /change-requests: My pending and decided change requests (store name, claims, business) */
    listOwnChangeRequests: notImplemented,
    /** POST /change-requests/{id}/withdraw: Withdraw a pending change request */
    withdrawChangeRequest: notImplemented,
    /** GET /store-profile: Storefront editor data with pending reviews and live preview data */
    getStoreProfile: notImplemented,
    /** PATCH /store-profile: Save storefront changes */
    updateStoreProfile: notImplemented,
    /** POST /store-profile/claims: Submit a public claim or brand affiliation with evidence */
    submitPublicClaim: notImplemented,
    /** POST /brand-requests: Ask Marketly to add a brand that is not listed, with evidence */
    requestBrand: notImplemented,
    /** POST /store-profile/claims/{id}/withdraw: Withdraw a pending or approved claim */
    withdrawPublicClaim: notImplemented,
    /** POST /store-profile/collections: Add a featured collection */
    createCollection: notImplemented,
    /** PATCH /store-profile/collections/{id}: Edit a featured collection */
    updateCollection: notImplemented,
    /** DELETE /store-profile/collections/{id}: Remove a featured collection */
    deleteCollection: notImplemented,
    /** PUT /store-profile/collections/order: Set collection order */
    reorderCollections: notImplemented,
    /** GET /members: Owner and staff with roles, status and last activity */
    listMembers: notImplemented,
    /** GET /roles: Role templates and the seller permission catalogue (permission matrix) */
    listRoleTemplates: notImplemented,
    /** POST /invitations: Invite a staff member */
    inviteMember: notImplemented,
    /** POST /invitations/{id}/resend: Resend an invitation (new expiry) */
    resendInvitation: notImplemented,
    /** POST /invitations/{id}/revoke: Cancel an invitation */
    revokeInvitation: notImplemented,
    /** PATCH /members/{id}: Change a member's role or single permissions */
    updateMember: notImplemented,
    /** POST /members/{id}/suspend: Temporarily block a member */
    suspendMember: notImplemented,
    /** POST /members/{id}/remove: Remove a member */
    removeMember: notImplemented,
    /** GET /performance: Account health: metrics vs targets, warnings and actions */
    getPerformance: notImplemented,
    /** GET /restrictions: Active and past restrictions and suspensions */
    listOwnRestrictions: notImplemented,
    /** GET /restrictions/{id}: One restriction: reason, affected activity, what still works, how to resolve, appeal route */
    getOwnRestriction: notImplemented,
    /** POST /restrictions/{id}/evidence: Upload documents that resolve a restriction (e.g. brand authorisation) */
    submitResolutionEvidence: notImplemented,
    /** POST /restrictions/{id}/appeals: Appeal a restriction or suspension before the deadline */
    appealRestriction: notImplemented,
    /** GET /appeals: My appeals and their outcomes */
    listOwnAppeals: notImplemented,
    /** POST /appeals/{id}/withdraw: Withdraw an appeal */
    withdrawOwnAppeal: notImplemented,
    /** GET /payout-account: Payout destination label and readiness */
    getPayoutAccount: notImplemented,
    /** POST /payout-account/change: Change the payout bank account (owner only) */
    changePayoutAccount: notImplemented,
    /** GET /agreements: Accepted agreement versions and new versions waiting for acceptance */
    listAgreements: notImplemented,
    /** POST /agreements/{key}/accept: Accept a new agreement version (owner) */
    acceptAgreement: notImplemented,
    /** POST /account/close: Owner asks to close the seller account */
    requestSellerClosure: notImplemented,
  });
