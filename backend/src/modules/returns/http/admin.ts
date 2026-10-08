import { notImplemented, routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/returns.js';
import type { ReturnsService } from '../service.js';

/**
 * Admin API: /api/admin/returns/…  (docs/api/modules/returns.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const adminRoutes = (service: ReturnsService) => {
  void service;
  return routes(endpoints, 'admin', {
    /** GET /requests/stats: Returns queue KPIs and queue owner */
    adminReturnStats: notImplemented,
    /** GET /requests: Returns and refunds queue with reason, owner, deadline, amount and flags */
    listAdminReturns: notImplemented,
    /** GET /requests/{id}: Full return case with exception record, refund request and action history */
    getAdminReturn: notImplemented,
    /** POST /requests/{id}/approve: Approve an Official Store return, or decide a seller return as the platform */
    adminApproveReturn: notImplemented,
    /** POST /requests/{id}/request-info: Ask the customer for more information or photos */
    adminRequestInfo: notImplemented,
    /** POST /requests/{id}/reject: Reject with an explanation */
    adminRejectReturn: notImplemented,
    /** POST /requests/{id}/take-over: Platform intervention: Marketly takes over a seller return */
    takeOverReturn: notImplemented,
    /** POST /requests/{id}/overturn: Overturn a seller's rejection */
    overturnRejection: notImplemented,
    /** POST /requests/{id}/assign: Set the owner of a return */
    assignReturn: notImplemented,
    /** POST /requests/{id}/approve-without-return: Propose refund-without-return (controlled exception) */
    adminApproveWithoutReturn: notImplemented,
    /** POST /requests/{id}/receive: Record receipt at a seller's address for a platform-handled return */
    receiveReturn: notImplemented,
    /** GET /inspections: Official Store returns received, arriving and decided */
    inspectionQueue: notImplemented,
    /** GET /inspections/stats: Inspection queue KPIs */
    inspectionStats: notImplemented,
    /** POST /requests/{id}/start-inspection: Start (or continue) inspecting a received return: sets the inspector and status Inspecting */
    startInspection: notImplemented,
    /** PUT /requests/{id}/inspection-draft: Save an unsent inspection (checks ticked so far, notes, photos) */
    saveInspectionDraft: notImplemented,
    /** POST /requests/{id}/inspection: Record inspection: photos, condition grade, checks, missing parts and proposed stock outcome */
    recordInspection: notImplemented,
    /** POST /requests/{id}/remedy: Decide the remedy for an Official Store or platform-handled return */
    proposeRemedy: notImplemented,
    /** POST /refunds: Issue a refund from the order page (exception refund request) */
    createExceptionRefund: notImplemented,
    /** GET /refunds: Refund approval queue for Finance */
    listRefundRequests: notImplemented,
    /** GET /refunds/{id}: One refund request with breakdown, funding and earnings impact */
    getRefundRequest: notImplemented,
    /** POST /refunds/{id}/approve: Finance approves the refund and hands it to payments */
    approveRefund: notImplemented,
    /** POST /refunds/{id}/decline: Send a refund request back with a reason */
    declineRefund: notImplemented,
    /** POST /refunds/{id}/revise: Change a declined refund and resubmit */
    reviseRefund: notImplemented,
    /** GET /policies: Active baseline, scheduled changes and history */
    getPolicyAdmin: notImplemented,
    /** POST /policies: Propose a new baseline version with an effective date */
    proposeBaseline: notImplemented,
    /** POST /policies/{id}/withdraw: Withdraw a draft or scheduled baseline */
    withdrawBaseline: notImplemented,
    /** POST /category-exceptions: Add a category exception with an effective date */
    createCategoryException: notImplemented,
    /** POST /category-exceptions/preview: Impact of a category exception change before saving */
    previewCategoryException: notImplemented,
    /** PATCH /category-exceptions/{id}: Change or retire a category exception from a date */
    updateCategoryException: notImplemented,
  });
};
