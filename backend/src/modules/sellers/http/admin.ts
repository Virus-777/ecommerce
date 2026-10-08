import { notImplemented, routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/sellers.js';
import type { SellersService } from '../service.js';

/**
 * Admin API: /api/admin/sellers/…  (docs/api/modules/sellers.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const adminRoutes = (service: SellersService) =>
  routes(endpoints, 'admin', {
    /** GET /sellers: All sellers with status, verification, rating, on-time dispatch, cases, balance and restrictions */
    listSellers: notImplemented,
    /** GET /sellers/stats: Counts for the sellers header and status tabs */
    getSellerStats: notImplemented,
    /** GET /sellers/{id}: Seller detail: account, restrictions, performance, open obligations, appeals, payouts, notes, history */
    getSellerAdmin: notImplemented,
    /** POST /sellers/{id}/notes: Add a staff-only note */
    addSellerNote: notImplemented,
    /** POST /sellers/{id}/account-manager: Set the seller's account manager */
    assignAccountManager: notImplemented,
    /** POST /sellers/{id}/restrictions: Restrict a seller (reason, affected activity, scope, appeal route, review date) */
    createRestriction: notImplemented,
    /** PATCH /restrictions/{id}: Edit an active restriction (scope, reason, resolution steps, review date) */
    updateRestriction: notImplemented,
    /** POST /restrictions/{id}/lift: Lift a restriction with a reason */
    liftRestriction: notImplemented,
    /** GET /sellers/{id}/suspension-impact: What a suspension would do to offers, open orders, returns, cases and payouts */
    previewSuspension: notImplemented,
    /** POST /sellers/{id}/suspend: Suspend all new sales (always needs a second reviewer) */
    suspendSeller: notImplemented,
    /** POST /sellers/{id}/reinstate: End a suspension (optionally keeping restrictions) */
    reinstateSeller: notImplemented,
    /** POST /sellers/{id}/close: Close a seller account */
    closeSeller: notImplemented,
    /** POST /sellers/{id}/warnings: Send a performance or policy warning */
    issueWarning: notImplemented,
    /** POST /warnings/{id}/resolve: Mark a warning resolved */
    resolveWarning: notImplemented,
    /** POST /sellers/{id}/verification: Grant or revoke the Verified seller label */
    setVerificationLabel: notImplemented,
    /** POST /sellers/{id}/launch-review/decide: Pass the launch readiness review or ask for changes */
    decideLaunchReview: notImplemented,
    /** GET /applications: Application queue, oldest decision target first */
    listApplications: notImplemented,
    /** GET /applications/{id}: Application with checks, risk flags, documents, notes and timeline */
    getApplicationAdmin: notImplemented,
    /** POST /applications/{id}/assign: Assign a reviewer */
    assignApplication: notImplemented,
    /** POST /applications/{id}/start-review: Move a submitted application to Under review */
    startApplicationReview: notImplemented,
    /** POST /applications/{id}/checks/{checkId}/rerun: Run an automated check again (e.g. after a new document) */
    rerunCheck: notImplemented,
    /** POST /applications/{id}/checks/{checkId}/result: Record a manual check result or accept a 'needs attention' result with a note */
    recordCheckResult: notImplemented,
    /** POST /applications/{id}/trust-review: Refer the application to Trust and Risk */
    requestTrustReview: notImplemented,
    /** POST /applications/{id}/request-information: Ask the applicant for specific items with a deadline */
    requestApplicationInformation: notImplemented,
    /** POST /applications/{id}/approve: Approve the application */
    approveApplication: notImplemented,
    /** POST /applications/{id}/reject: Reject with an explanation the applicant will read */
    rejectApplication: notImplemented,
    /** POST /applications/{id}/notes: Add a staff-only note to an application */
    addApplicationNote: notImplemented,
    /** GET /appeals: Appeals waiting for a decision */
    listAppealsAdmin: notImplemented,
    /** POST /appeals/{id}/assign: Assign an appeal reviewer (not the original decider) */
    assignAppeal: notImplemented,
    /** POST /appeals/{id}/decide: Uphold, overturn or partly overturn */
    decideAppeal: notImplemented,
    /** GET /change-requests: Store names, public claims, brand affiliation and business changes waiting for review */
    listChangeRequestsAdmin: notImplemented,
    /** POST /change-requests/{id}/decide: Approve or reject a change request or public claim */
    decideChangeRequest: notImplemented,
    /** POST /claims/{id}/revoke: Remove an approved claim found to be false */
    revokePublicClaim: notImplemented,
    /** GET /performance-targets: Current and scheduled performance targets */
    listPerformanceTargets: notImplemented,
    /** PUT /performance-targets: Change targets with an effective date */
    setPerformanceTargets: notImplemented,
    /** POST /seller-invitations: Invite a business to apply (invite-only launch) */
    inviteSeller: notImplemented,
    /** GET /seller-invitations: Invitations sent and whether they applied */
    listSellerInvitations: notImplemented,
    /** POST /seller-invitations/{id}/revoke: Revoke an unused invitation */
    revokeSellerInvitation: notImplemented,
    /** POST /sellers/exports: Export the filtered seller list */
    exportSellers: notImplemented,
  });
