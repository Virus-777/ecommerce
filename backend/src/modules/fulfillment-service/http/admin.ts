import { notImplemented, routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/fulfillment-service.js';
import type { FulfillmentServiceService } from '../service.js';

/**
 * Admin API: /api/admin/fulfillment-service/…  (docs/api/modules/fulfillment-service.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const adminRoutes = (service: FulfillmentServiceService) => {
  void service;
  return routes(endpoints, 'admin', {
    /** GET /enrollments: Seller enrollments */
    listEnrollmentsAdmin: notImplemented,
    /** POST /enrollments/{id}/decide: Approve with capacity, reject or request information */
    decideEnrollment: notImplemented,
    /** POST /enrollments/{id}/status: Suspend, reinstate, offboard or close an enrollment */
    changeEnrollmentStatus: notImplemented,
    /** POST /skus/{id}/review: Approve or reject a SKU for the service */
    reviewSku: notImplemented,
    /** GET /inbound: Inbound shipments expected and arriving (receiving queue) */
    listInboundAdmin: notImplemented,
    /** POST /inbound/{id}/arrive: Record arrival at the dock */
    markInboundArrived: notImplemented,
    /** POST /inbound/{id}/receive: Record received and damaged units (partial or complete) */
    recordReceiving: notImplemented,
    /** POST /inbound/{id}/discrepancy-decision: Decide a claimed discrepancy (reimburse, adjust or reject) */
    decideDiscrepancy: notImplemented,
    /** GET /fulfillment-requests: Orders for service offers and their warehouse progress */
    listFulfillmentRequests: notImplemented,
    /** POST /returns/{id}/outcome: Record the inspection outcome of a returned service unit */
    recordReturnOutcome: notImplemented,
    /** GET /removals: Removal and disposal orders */
    listRemovalsAdmin: notImplemented,
    /** POST /removals/{id}/transition: Approve, process, ship or complete a removal order */
    advanceRemoval: notImplemented,
    /** GET /sellers/{sellerId}/stock: Seller-owned stock held by the company, by SKU and group */
    getSellerStockAdmin: notImplemented,
    /** GET /fee-schedules: Fee schedule versions */
    listFeeSchedules: notImplemented,
    /** POST /fee-schedules: Propose a new fee schedule with an effective date */
    createFeeSchedule: notImplemented,
    /** GET /fees: Fee charges across sellers */
    listFeeChargesAdmin: notImplemented,
    /** POST /fees/{id}/reverse: Reverse a fee charge with a reason */
    reverseFeeCharge: notImplemented,
  });
};
