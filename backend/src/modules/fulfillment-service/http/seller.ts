import { routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/fulfillment-service.js';
import type { FulfillmentServiceService } from '../service.js';
import type { By } from '../service/core.js';

const by = (i: { actor: By['actor']; requestId: string; principal: By['principal']; idempotencyKey?: string }): By => ({ actor: i.actor, requestId: i.requestId, principal: i.principal, ...(i.idempotencyKey ? { idempotencyKey: i.idempotencyKey } : {}) });

/**
 * Seller API: /api/seller/fulfillment-service/…  (docs/api/modules/fulfillment-service.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 * Every handler acts for input.sellerId: another seller's records answer 404.
 */
export const sellerRoutes = (service: FulfillmentServiceService) => {
  const p = service.parts;
  return routes(endpoints, 'seller', {
    /** GET /overview: Enrollment, stock held by Marketly, open inbound shipments and fees */
    getServiceOverview: async (i) => p.stock.overview(i.sellerId),
    /** POST /enrollment: Apply for storage and shipping by Marketly and accept the service terms */
    applyForService: async (i) => p.enrollment.apply(i.sellerId, i.body, by(i)),
    /** GET /enrollment: Own enrollment status, terms, capacity */
    getOwnEnrollment: async (i) => p.enrollment.getOwn(i.sellerId),
    /** POST /enrollment/offboard: Stop using the service (stock must be removed) */
    requestOffboarding: async (i) => p.enrollment.offboard(i.sellerId, i.body, by(i)),
    /** GET /fee-schedule: Current and upcoming fee schedule */
    getFeeScheduleSeller: async () => p.fees.sellerSchedule(),
    /** GET /skus: Enrolled SKUs with stock held by Marketly by group */
    listSkuEnrollments: async (i) => p.skus.list(i.sellerId, i.query, i.page),
    /** POST /skus: Enroll an offer for fulfillment by Marketly */
    enrollSku: async (i) => p.skus.enroll(i.sellerId, i.body, by(i)),
    /** POST /skus/{id}/deactivate: Stop using the service for a SKU */
    deactivateSku: async (i) => p.skus.deactivate(i.sellerId, i.params.id, by(i)),
    /** GET /inbound: Own inbound shipments */
    listInbound: async (i) => p.inbound.list(i.sellerId, i.query, i.page),
    /** POST /inbound: Plan an inbound shipment to our warehouse */
    createInbound: async (i) => p.inbound.create(i.sellerId, i.body, by(i)),
    /** GET /inbound/{id}: Inbound shipment with labels, receiving results and discrepancies */
    getInbound: async (i) => p.inbound.get(i.sellerId, i.params.id),
    /** PATCH /inbound/{id}: Edit a draft or add carrier and tracking */
    updateInbound: async (i) => p.inbound.update(i.sellerId, i.params.id, i.body, by(i)),
    /** POST /inbound/{id}/submit: Submit and get box and unit labels */
    submitInbound: async (i) => p.inbound.submit(i.sellerId, i.params.id, by(i)),
    /** POST /inbound/{id}/ship: Mark as shipped with carrier and tracking */
    markInboundShipped: async (i) => p.inbound.ship(i.sellerId, i.params.id, i.body, by(i)),
    /** POST /inbound/{id}/cancel: Cancel before it ships */
    cancelInbound: async (i) => p.inbound.cancel(i.sellerId, i.params.id, i.body ?? {}, by(i)),
    /** POST /inbound/{id}/discrepancy-response: Accept a receiving discrepancy or claim it with evidence */
    respondDiscrepancy: async (i) => p.inbound.respondDiscrepancy(i.sellerId, i.params.id, i.body, by(i)),
    /** GET /returns: Returns of service offers received at our warehouse with inspection outcome */
    listOwnServiceReturns: async (i) => p.returns.list(i.sellerId, i.query, i.page),
    /** GET /removals: Removal and disposal orders */
    listRemovals: async (i) => p.removals.list(i.sellerId, i.page),
    /** POST /removals: Ask for stock back or to dispose of it */
    requestRemoval: async (i) => p.removals.request(i.sellerId, i.body, by(i)),
    /** POST /removals/{id}/cancel: Cancel a removal that has not been approved */
    cancelRemoval: async (i) => p.removals.cancel(i.sellerId, i.params.id, by(i)),
    /** GET /fees: Fees charged (storage, handling, receiving, returns, removal) */
    listOwnFees: async (i) => p.fees.listOwn(i.sellerId, i.query, i.page),
    /** GET /skus/{id}/movements: Ownership ledger for one SKU (every unit movement with reason) */
    listStockMovements: async (i) => p.stock.movements(i.sellerId, i.params.id, i.page),
  });
};
