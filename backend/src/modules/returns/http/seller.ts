import { notImplemented, routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/returns.js';
import type { ReturnsService } from '../service.js';

/**
 * Seller API: /api/seller/returns/…  (docs/api/modules/returns.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const sellerRoutes = (service: ReturnsService) => {
  void service;
  return routes(endpoints, 'seller', {
    /** POST /requests/exports: Export own returns and cases (current tab and filters) as CSV */
    exportSellerReturns: notImplemented,
    /** GET /requests/exports/{id}: Returns export status and download link (requesting member only) */
    getSellerReturnsExport: notImplemented,
    /** GET /requests/counts: Queue tiles and list tab totals (Return requests, Received to inspect, Disputes, Closed) */
    sellerReturnCounts: notImplemented,
    /** GET /requests: Return requests, received returns to inspect, disputes and closed returns */
    listSellerReturns: notImplemented,
    /** GET /requests/{id}: Return case: request, photos, policy applied, payment, deadlines, shipment, inspection and earnings impact */
    getSellerReturn: notImplemented,
    /** POST /requests/{id}/approve: Approve and issue the return label */
    sellerApproveReturn: notImplemented,
    /** POST /requests/{id}/request-info: Ask the customer a question (pauses the respond-by clock) */
    sellerRequestInfo: notImplemented,
    /** POST /requests/{id}/reject: Reject with a reason and an explanation shown to the customer */
    sellerRejectReturn: notImplemented,
    /** POST /requests/{id}/approve-without-return: Refund without asking for the item back (recorded reason) */
    sellerApproveWithoutReturn: notImplemented,
    /** POST /requests/{id}/receive: Mark the return as received at the seller's return address */
    sellerReceiveReturn: notImplemented,
    /** POST /requests/{id}/inspection: Record the condition on arrival and the stock outcome */
    sellerRecordInspection: notImplemented,
    /** PUT /requests/{id}/inspection-draft: Save an unsent inspection and refund decision */
    saveSellerInspectionDraft: notImplemented,
    /** POST /requests/{id}/evidence: Attach evidence to a return before any case exists */
    addSellerEvidence: notImplemented,
    /** POST /requests/{id}/remedy: Confirm the refund (full or partial) or ship a replacement or exchange */
    sellerIssueRemedy: notImplemented,
    /** GET /terms: Own return terms, return address and the platform baseline */
    getSellerTerms: notImplemented,
    /** PUT /terms: Change return terms or return address */
    updateSellerTerms: notImplemented,
  });
};
