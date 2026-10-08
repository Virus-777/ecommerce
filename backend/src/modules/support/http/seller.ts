import { notImplemented, routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/support.js';
import type { SupportService } from '../service.js';

/**
 * Seller API: /api/seller/support/…  (docs/api/modules/support.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const sellerRoutes = (service: SupportService) => {
  void service;
  return routes(endpoints, 'seller', {
    /** GET /cases: Customer cases and disputes about the seller's orders, and the seller's own support requests */
    listSellerCases: notImplemented,
    /** GET /cases/{id}: Case as the seller sees it (no internal notes) */
    getSellerCase: notImplemented,
    /** POST /cases/{id}/messages: Reply to the customer and Marketly support, optionally with an offer */
    sellerReply: notImplemented,
    /** POST /cases/{id}/evidence: Add dispute evidence (photos, test videos, invoices, carrier records) */
    addSellerEvidence: notImplemented,
    /** POST /cases/{id}/appeal: Appeal a dispute decision before the deadline */
    sellerAppeal: notImplemented,
    /** POST /requests: Contact seller support (Seller Manager team) */
    createSellerRequest: notImplemented,
    /** GET /categories: Seller support topics with expected reply time */
    listSellerCategories: notImplemented,
  });
};
