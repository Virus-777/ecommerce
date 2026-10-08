import { notImplemented, routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/trust.js';
import type { TrustService } from '../service.js';

/**
 * Seller API: /api/seller/trust/…  (docs/api/modules/trust.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const sellerRoutes = (service: TrustService) =>
  routes(endpoints, 'seller', {
    /** POST /reports: Report abuse by a customer, a counterfeit competitor offer or a listing problem */
    createSellerReport: notImplemented,
    /** GET /reports: Reports this seller made */
    listSellerReports: notImplemented,
    /** GET /evidence-requests: Proof Trust and Risk asked this seller for (e.g. proof of supply) */
    listSellerEvidenceRequests: notImplemented,
    /** POST /evidence-requests/{id}/answer: Send the requested proof */
    answerEvidenceRequest: notImplemented,
    /** GET /enforcements: Trust actions on this seller's offers, products or claims, with appeal route */
    listSellerEnforcements: notImplemented,
    /** POST /appeals: Appeal a trust action on an offer, product or claim */
    submitSellerAppeal: notImplemented,
    /** GET /appeals: This seller's trust appeals */
    listSellerAppeals: notImplemented,
  });
