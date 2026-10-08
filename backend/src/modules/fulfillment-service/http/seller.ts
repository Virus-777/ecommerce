import { notImplemented, routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/fulfillment-service.js';
import type { FulfillmentServiceService } from '../service.js';

/**
 * Seller API: /api/seller/fulfillment-service/…  (docs/api/modules/fulfillment-service.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const sellerRoutes = (service: FulfillmentServiceService) => {
  void service;
  return routes(endpoints, 'seller', {
    /** GET /overview: Enrollment, stock held by Marketly, open inbound shipments and fees */
    getServiceOverview: notImplemented,
    /** POST /enrollment: Apply for storage and shipping by Marketly and accept the service terms */
    applyForService: notImplemented,
    /** GET /enrollment: Own enrollment status, terms, capacity */
    getOwnEnrollment: notImplemented,
    /** POST /enrollment/offboard: Stop using the service (stock must be removed) */
    requestOffboarding: notImplemented,
    /** GET /fee-schedule: Current and upcoming fee schedule */
    getFeeScheduleSeller: notImplemented,
    /** GET /skus: Enrolled SKUs with stock held by Marketly by group */
    listSkuEnrollments: notImplemented,
    /** POST /skus: Enroll an offer for fulfillment by Marketly */
    enrollSku: notImplemented,
    /** POST /skus/{id}/deactivate: Stop using the service for a SKU */
    deactivateSku: notImplemented,
    /** GET /inbound: Own inbound shipments */
    listInbound: notImplemented,
    /** POST /inbound: Plan an inbound shipment to our warehouse */
    createInbound: notImplemented,
    /** GET /inbound/{id}: Inbound shipment with labels, receiving results and discrepancies */
    getInbound: notImplemented,
    /** PATCH /inbound/{id}: Edit a draft or add carrier and tracking */
    updateInbound: notImplemented,
    /** POST /inbound/{id}/submit: Submit and get box and unit labels */
    submitInbound: notImplemented,
    /** POST /inbound/{id}/ship: Mark as shipped with carrier and tracking */
    markInboundShipped: notImplemented,
    /** POST /inbound/{id}/cancel: Cancel before it ships */
    cancelInbound: notImplemented,
    /** POST /inbound/{id}/discrepancy-response: Accept a receiving discrepancy or claim it with evidence */
    respondDiscrepancy: notImplemented,
    /** GET /returns: Returns of service offers received at our warehouse with inspection outcome */
    listOwnServiceReturns: notImplemented,
    /** GET /removals: Removal and disposal orders */
    listRemovals: notImplemented,
    /** POST /removals: Ask for stock back or to dispose of it */
    requestRemoval: notImplemented,
    /** POST /removals/{id}/cancel: Cancel a removal that has not been approved */
    cancelRemoval: notImplemented,
    /** GET /fees: Fees charged (storage, handling, receiving, returns, removal) */
    listOwnFees: notImplemented,
    /** GET /skus/{id}/movements: Ownership ledger for one SKU (every unit movement with reason) */
    listStockMovements: notImplemented,
  });
};
