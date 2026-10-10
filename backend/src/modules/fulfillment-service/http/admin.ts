import { routes, notImplemented } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/fulfillment-service.js';
import type { FulfillmentServiceService } from '../service.js';
import type { By } from '../service/core.js';

const by = (i: { actor: By['actor']; requestId: string; principal: By['principal']; idempotencyKey?: string }): By => ({ actor: i.actor, requestId: i.requestId, principal: i.principal, ...(i.idempotencyKey ? { idempotencyKey: i.idempotencyKey } : {}) });

/**
 * Admin API: /api/admin/fulfillment-service/…  (docs/api/modules/fulfillment-service.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const adminRoutes = (service: FulfillmentServiceService) => {
  const p = service.parts;
  return routes(endpoints, 'admin', {
    /** GET /enrollments: Seller enrollments */
    listEnrollmentsAdmin: async (i) => p.enrollment.listAdmin(i.query, i.page),
    /** POST /enrollments/{id}/decide: Approve with capacity, reject or request information */
    decideEnrollment: async (i) => p.enrollment.decide(i.params.id, i.body, by(i)),
    /** POST /enrollments/{id}/status: Suspend, reinstate, offboard or close an enrollment */
    changeEnrollmentStatus: async (i) => p.enrollment.changeStatus(i.params.id, i.body, by(i)),
    /** POST /skus/{id}/review: Approve or reject a SKU for the service */
    reviewSku: async (i) => p.skus.review(i.params.id, i.body, by(i)),
    /** GET /inbound: Inbound shipments expected and arriving (receiving queue) */
    listInboundAdmin: async (i) => p.inbound.listAdmin(i.query, i.page),
    /** POST /inbound/{id}/arrive: Record arrival at the dock */
    markInboundArrived: async (i) => p.inbound.arrive(i.params.id, i.body, by(i)),
    /** POST /inbound/{id}/receive: Record received and damaged units (partial or complete) */
    recordReceiving: async (i) => p.inbound.receive(i.params.id, i.body, by(i)),
    /** POST /inbound/{id}/discrepancy-decision: Decide a claimed discrepancy (reimburse, adjust or reject) */
    decideDiscrepancy: async (i) => p.inbound.decideDiscrepancy(i.params.id, i.body, by(i)),
    /** GET /fulfillment-requests: Orders for service offers and their warehouse progress */
    listFulfillmentRequests: async (i) => p.requests.list(i.query, i.page),
    /** POST /returns/{id}/outcome: Record the inspection outcome of a returned service unit */
    recordReturnOutcome: async (i) => p.returns.recordOutcome(i.params.id, i.body, by(i)),
    /** GET /removals: Removal and disposal orders */
    listRemovalsAdmin: async (i) => p.removals.listAdmin(i.query, i.page),
    /** POST /removals/{id}/transition: Approve, process, ship or complete a removal order */
    advanceRemoval: async (i) => p.removals.advance(i.params.id, i.body, by(i)),
    /** GET /sellers/{sellerId}/stock: Seller-owned stock held by the company, by SKU and group */
    getSellerStockAdmin: async (i) => p.skus.listForSeller(i.params.sellerId, i.page),
    /** GET /fee-schedules: Fee schedule versions */
    listFeeSchedules: async () => p.fees.listSchedules(),
    /** POST /fee-schedules: Propose a new fee schedule with an effective date */
    createFeeSchedule: async (i) => p.fees.createSchedule(i.body, by(i)),
    /** GET /fees: Fee charges across sellers */
    listFeeChargesAdmin: async (i) => p.fees.listAdmin(i.query, i.page),
    /** POST /fees/{id}/reverse: Reverse a fee charge with a reason */
    reverseFeeCharge: async (i) => p.fees.reverse(i.params.id, i.body.reason, by(i)),
    /** GET /stock-differences: Differences between the ownership ledger and inventory found by the daily reconciliation (TODO pass 3: implement) */
    listStockDifferences: notImplemented,
    /** POST /stock-differences/{id}/resolve: Resolve a stock difference: adjust the ledger, reimburse the seller or leave it (TODO pass 3: implement) */
    resolveStockDifference: notImplemented,
  });
};
