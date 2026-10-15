import type { Principal } from '../../../kernel/auth/index.js';
import { routes } from '../../../kernel/http/index.js';
import type * as identity from '../../../spec/identity.js';
import { endpoints } from '../../../spec/returns.js';
import type { By } from '../service/core.js';
import type { ReturnsService } from '../service.js';

/**
 * Seller API: /api/seller/returns/…  (docs/api/modules/returns.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 * Every return is read through the session's seller: another seller's return is NOT_FOUND.
 */
export const sellerRoutes = (service: ReturnsService) => {
  const own = (id: string, sellerId: string) => service.core.visible(id, { area: 'seller', sellerId });
  /** A return the seller may change: Fulfilled by Marketly returns are read-only for the seller (Marketly handles them) */
  const writable = async (id: string, sellerId: string) => {
    const agg = await own(id, sellerId);
    service.core.sellerMayAct(agg.ret);
    return agg;
  };
  const caseOf = async (id: string) => service.views.returnCase((await service.core.load(id))!, 'seller');
  const by = (i: { actor: By['actor']; requestId: string; principal: Principal; can: (p: string) => Promise<boolean> }): By => ({ actor: i.actor, requestId: i.requestId, principal: i.principal, can: i.can });

  return routes(endpoints, 'seller', {
    /** POST /requests/exports: Export own returns and cases (current tab and filters) as CSV */
    exportSellerReturns: async (i) => service.reads.requestSellerExport(i.sellerId, i.body, i.principal as unknown as identity.Principal, by(i)),
    /** GET /requests/exports/{id}: Returns export status and download link (requesting member only) */
    getSellerReturnsExport: async ({ params, principal, sellerId }) => service.reads.getSellerExport(params.id, principal as unknown as identity.Principal, sellerId),
    /** GET /requests/counts: Queue tiles and list tab totals (Return requests, Received to inspect, Disputes, Closed) */
    sellerReturnCounts: async ({ sellerId }) => service.reads.sellerCounts(sellerId),
    /** GET /requests: Return requests, received returns to inspect, disputes and closed returns */
    listSellerReturns: async ({ query, page, sellerId }) => service.reads.listSeller(sellerId, query, page),
    /** GET /requests/{id}: Return case: request, photos, policy applied, payment, deadlines, shipment, inspection and earnings impact */
    getSellerReturn: async ({ params, sellerId }) => service.views.returnCase(await own(params.id, sellerId), 'seller'),
    /** POST /requests/{id}/approve: Approve and issue the return label */
    sellerApproveReturn: async (i) => {
      const agg = await writable(i.params.id, i.sellerId);
      await service.decisions.approve(agg.ret.id, i.body, by(i), 'seller', agg);
      return caseOf(agg.ret.id);
    },
    /** POST /requests/{id}/request-info: Ask the customer a question (pauses the respond-by clock) */
    sellerRequestInfo: async (i) => {
      const agg = await writable(i.params.id, i.sellerId);
      await service.decisions.requestInfo(agg.ret.id, i.body.question, by(i), 'seller', agg);
      return caseOf(agg.ret.id);
    },
    /** POST /requests/{id}/reject: Reject with a reason and an explanation shown to the customer */
    sellerRejectReturn: async (i) => {
      const agg = await writable(i.params.id, i.sellerId);
      await service.decisions.reject(agg.ret.id, i.body, by(i), 'seller', agg);
      return caseOf(agg.ret.id);
    },
    /** POST /requests/{id}/approve-without-return: Refund without asking for the item back (recorded reason) */
    sellerApproveWithoutReturn: async (i) => {
      const agg = await writable(i.params.id, i.sellerId);
      await service.decisions.approveWithoutReturn(agg.ret.id, i.body, by(i), 'seller', agg);
      return caseOf(agg.ret.id);
    },
    /** POST /requests/{id}/receive: Mark the return as received at the seller's return address */
    sellerReceiveReturn: async (i) => {
      const agg = await writable(i.params.id, i.sellerId);
      await service.handling.receive(agg.ret.id, { receivedAt: i.body.receivedAt, note: i.body.note }, by(i), agg);
      return caseOf(agg.ret.id);
    },
    /** POST /requests/{id}/inspection: Record the condition on arrival and the stock outcome */
    sellerRecordInspection: async (i) => {
      const agg = await writable(i.params.id, i.sellerId);
      await service.handling.recordInspection(agg.ret.id, i.body, by(i), agg, 'seller');
      return caseOf(agg.ret.id);
    },
    /** PUT /requests/{id}/inspection-draft: Save an unsent inspection and refund decision */
    saveSellerInspectionDraft: async (i) => {
      const agg = await writable(i.params.id, i.sellerId);
      return service.handling.saveDraft(agg.ret.id, i.body, by(i), agg, true);
    },
    /** POST /requests/{id}/evidence: Attach evidence to a return before any case exists */
    addSellerEvidence: async (i) => {
      const agg = await own(i.params.id, i.sellerId);
      return service.handling.addEvidence(agg.ret.id, i.body, by(i), agg, 'seller');
    },
    /** POST /requests/{id}/remedy: Confirm the refund (full or partial) or ship a replacement or exchange */
    /** POST /requests/{id}/remedy/preview: Preview a full or partial refund before issuing it */
    previewSellerRemedy: async (i) => service.handling.previewRemedy(i.body, await own(i.params.id, i.sellerId)),
    sellerIssueRemedy: async (i) => {
      const agg = await writable(i.params.id, i.sellerId);
      await service.handling.remedy(agg.ret.id, i.body, by(i), agg, 'seller');
      return caseOf(agg.ret.id);
    },
    /** GET /terms: Own return terms, return address and the platform baseline */
    getSellerTerms: async ({ sellerId }) => service.policies.getSellerTerms(sellerId),
    /** PUT /terms: Change return terms or return address */
    updateSellerTerms: async (i) => service.policies.updateSellerTerms(i.sellerId, i.body, by(i)),
    /** POST /replacements/{id}/cancel: Cancel a replacement or exchange not shipped yet (e.g. no stock) with a reason */
    sellerCancelReplacement: async (i) => service.handling.cancelReplacement(i.params.id, i.body.reason, by(i), { area: 'seller', sellerId: i.sellerId }),
  });
};
