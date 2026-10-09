import type { Principal } from '../../../kernel/auth/index.js';
import { routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/returns.js';
import { illegal, type By } from '../service/core.js';
import type { ReturnsService } from '../service.js';

/**
 * Admin API: /api/admin/returns/…  (docs/api/modules/returns.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const adminRoutes = (service: ReturnsService) => {
  const any = (id: string) => service.core.visible(id, { area: 'admin' });
  const caseOf = async (id: string) => service.views.returnCase((await service.core.load(id))!, 'admin');
  const by = (i: { actor: By['actor']; requestId: string; principal: Principal; can: (p: string) => Promise<boolean> }): By => ({ actor: i.actor, requestId: i.requestId, principal: i.principal, can: i.can });

  return routes(endpoints, 'admin', {
    /** GET /requests/stats: Returns queue KPIs and queue owner */
    adminReturnStats: async () => service.reads.stats(),
    /** GET /requests: Returns and refunds queue with reason, owner, deadline, amount and flags */
    listAdminReturns: async ({ query, page }) => service.reads.listAdmin(query, page),
    /** GET /requests/{id}: Full return case with exception record, refund request and action history */
    getAdminReturn: async ({ params }) => service.views.returnCase(await any(params.id), 'admin'),
    /** POST /requests/{id}/approve: Approve an Official Store return, or decide a seller return as the platform */
    adminApproveReturn: async (i) => {
      const agg = await any(i.params.id);
      await service.decisions.approve(i.params.id, { labelMethod: i.body.labelMethod, carrierServiceId: i.body.carrierServiceId, note: i.body.reason }, by(i), 'admin', agg);
      return caseOf(i.params.id);
    },
    /** POST /requests/{id}/request-info: Ask the customer for more information or photos */
    adminRequestInfo: async (i) => {
      const agg = await any(i.params.id);
      await service.decisions.requestInfo(i.params.id, i.body.question, by(i), 'admin', agg);
      return caseOf(i.params.id);
    },
    /** POST /requests/{id}/reject: Reject with an explanation */
    adminRejectReturn: async (i) => {
      const agg = await any(i.params.id);
      await service.decisions.reject(i.params.id, i.body, by(i), 'admin', agg);
      return caseOf(i.params.id);
    },
    /** POST /requests/{id}/take-over: Platform intervention: Marketly takes over a seller return */
    takeOverReturn: async (i) => {
      const agg = await any(i.params.id);
      await service.decisions.takeOver(i.params.id, i.body, by(i), agg);
      return caseOf(i.params.id);
    },
    /** POST /requests/{id}/overturn: Overturn a seller's rejection */
    overturnRejection: async (i) => {
      const agg = await any(i.params.id);
      await service.decisions.overturn(i.params.id, i.body, by(i), agg);
      return caseOf(i.params.id);
    },
    /** POST /requests/{id}/assign: Set the owner of a return */
    assignReturn: async (i) => {
      const agg = await any(i.params.id);
      await service.decisions.assign(i.params.id, i.body, by(i), agg);
      return caseOf(i.params.id);
    },
    /** POST /requests/{id}/approve-without-return: Propose refund-without-return (controlled exception) */
    adminApproveWithoutReturn: async (i) => {
      const agg = await any(i.params.id);
      await service.decisions.approveWithoutReturn(i.params.id, i.body, by(i), 'admin', agg);
      return caseOf(i.params.id);
    },
    /** POST /requests/{id}/receive: Record receipt at a seller's address for a platform-handled return */
    receiveReturn: async (i) => {
      const agg = await any(i.params.id);
      if (agg.ret.owner_type !== 'seller' || !agg.ret.platform_handling) {
        throw illegal('Only returns Marketly handles for a seller are received here; the warehouse scans Official Store parcels', { from: agg.ret.status });
      }
      await service.handling.receive(i.params.id, { receivedAt: i.body.receivedAt, note: i.body.note, trackingNumber: i.body.trackingNumber }, by(i), agg);
      await service.core.audit({ action: 'returns.return.receive', actionLabel: `Recorded receipt of return ${agg.ret.ref}`, target: { type: 'return', id: agg.ret.id, ref: agg.ret.ref, label: `Return ${agg.ret.ref}` }, after: i.body, reason: i.body.note ?? null }, by(i));
      return caseOf(i.params.id);
    },
    /** GET /inspections: Official Store returns received, arriving and decided */
    inspectionQueue: async ({ query, page }) => service.reads.inspectionQueue(query.tab, page),
    /** GET /inspections/stats: Inspection queue KPIs */
    inspectionStats: async () => service.reads.inspectionStats(),
    /** POST /requests/{id}/start-inspection: Start (or continue) inspecting a received return: sets the inspector and status Inspecting */
    startInspection: async (i) => service.handling.startInspection(i.params.id, i.body.inspectorId, by(i), await any(i.params.id)),
    /** PUT /requests/{id}/inspection-draft: Save an unsent inspection (checks ticked so far, notes, photos) */
    saveInspectionDraft: async (i) => service.handling.saveDraft(i.params.id, { inspection: i.body.inspection }, by(i), await any(i.params.id), false),
    /** POST /requests/{id}/inspection: Record inspection: photos, condition grade, checks, missing parts and proposed stock outcome */
    recordInspection: async (i) => {
      const agg = await any(i.params.id);
      await service.handling.recordInspection(i.params.id, i.body, by(i), agg, 'staff');
      return caseOf(i.params.id);
    },
    /** POST /requests/{id}/remedy: Decide the remedy for an Official Store or platform-handled return */
    proposeRemedy: async (i) => {
      const agg = await any(i.params.id);
      await service.handling.remedy(i.params.id, i.body, by(i), agg, 'admin');
      return caseOf(i.params.id);
    },
    /** POST /refunds: Issue a refund from the order page (exception refund request) */
    createExceptionRefund: async (i) => service.refunds.createException(i.body, by(i), i.idempotencyKey),
    /** GET /refunds: Refund approval queue for Finance */
    listRefundRequests: async ({ query, page }) => service.reads.listRefunds(query, page),
    /** GET /refunds/{id}: One refund request with breakdown, funding and earnings impact */
    getRefundRequest: async ({ params }) => service.reads.refundById(params.id),
    /** POST /refunds/{id}/approve: Finance approves the refund and hands it to payments */
    approveRefund: async (i) => {
      await service.reads.refundById(i.params.id);
      return service.refunds.approve(i.params.id, i.body, by(i));
    },
    /** POST /refunds/{id}/decline: Send a refund request back with a reason */
    declineRefund: async (i) => {
      await service.reads.refundById(i.params.id);
      return service.refunds.decline(i.params.id, i.body.reason, by(i));
    },
    /** POST /refunds/{id}/revise: Change a declined refund and resubmit */
    reviseRefund: async (i) => {
      await service.reads.refundById(i.params.id);
      return service.refunds.revise(i.params.id, i.body, by(i));
    },
    /** GET /policies: Active baseline, scheduled changes and history */
    getPolicyAdmin: async () => service.policies.policyAdmin(),
    /** POST /policies: Propose a new baseline version with an effective date */
    proposeBaseline: async (i) => service.policies.proposeBaseline(i.body, by(i)),
    /** POST /policies/{id}/withdraw: Withdraw a draft or scheduled baseline */
    withdrawBaseline: async (i) => service.policies.withdrawBaseline(i.params.id, i.body.reason, by(i)),
    /** POST /category-exceptions: Add a category exception with an effective date */
    createCategoryException: async (i) => service.policies.createCategoryException(i.body, by(i)),
    /** POST /category-exceptions/preview: Impact of a category exception change before saving */
    previewCategoryException: async (i) => service.policies.previewCategoryException(i.body, by(i)),
    /** PATCH /category-exceptions/{id}: Change or retire a category exception from a date */
    updateCategoryException: async (i) => service.policies.updateCategoryException(i.params.id, i.body, by(i)),
  });
};
