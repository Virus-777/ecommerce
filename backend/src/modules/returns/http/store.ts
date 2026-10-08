import { notImplemented, routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/returns.js';
import type { ReturnsService } from '../service.js';

/**
 * Store API: /api/store/returns/…  (docs/api/modules/returns.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const storeRoutes = (service: ReturnsService) => {
  void service;
  return routes(endpoints, 'store', {
    /** GET /policy: Current returns baseline, category exceptions and who pays return shipping */
    getPublicPolicy: notImplemented,
    /** GET /terms: Effective return terms for a seller and category */
    getEffectiveTerms: notImplemented,
    /** GET /orders/{orderId}/returnable-items: Items of an order with per-item return eligibility */
    listReturnableItems: notImplemented,
    /** POST /eligibility: Eligibility, deadline, destination, shipping responsibility, remedies and refund estimate before submission */
    checkEligibility: notImplemented,
    /** POST /requests: Request a return for selected items and quantities */
    createReturn: notImplemented,
    /** GET /requests/overview: Return and refund totals for the account */
    getCustomerOverview: notImplemented,
    /** GET /requests: My returns with return status and refund status side by side */
    listCustomerReturns: notImplemented,
    /** GET /requests/{id}: Return detail: status track, drop-off, return shipment, refund or replacement progress */
    getCustomerReturn: notImplemented,
    /** POST /requests/{id}/info: Answer the seller's or Marketly's question */
    replyToInfoRequest: notImplemented,
    /** POST /requests/{id}/withdraw: Cancel a return before the item is sent back */
    withdrawReturn: notImplemented,
    /** GET /requests/{id}/label: Drop-off QR code, printable label, instructions and nearby drop-off points */
    getReturnLabel: notImplemented,
    /** POST /requests/{id}/label/email: Email the drop-off code to the customer */
    emailReturnLabel: notImplemented,
    /** POST /requests/{id}/shipment: Add carrier and tracking for a customer-arranged return */
    addCustomerTracking: notImplemented,
    /** POST /requests/{id}/escalate: Ask Marketly to step in */
    escalateReturn: notImplemented,
  });
};
