import { notImplemented, routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/sellers.js';
import type { SellersService } from '../service.js';

/**
 * Store API: /api/store/sellers/…  (docs/api/modules/sellers.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const storeRoutes = (service: SellersService) =>
  routes(endpoints, 'store', {
    /** GET /program: Sell with us: requirements, categories, example fees, payout timing, targets, steps */
    getSellerProgram: notImplemented,
    /** POST /applications: Start a seller application (step 1: seller account) */
    startApplication: notImplemented,
    /** GET /applications/current: My application with progress, information requests, decision and timeline */
    getMyApplication: notImplemented,
    /** PATCH /applications/{id}: Save a step (draft saves at any time) */
    updateApplication: notImplemented,
    /** POST /applications/{id}/documents: Attach an uploaded document (ID, registration, W-9, bank letter, certificate) */
    addApplicationDocument: notImplemented,
    /** DELETE /applications/{id}/documents/{documentId}: Remove a document from a draft or an open information request */
    removeApplicationDocument: notImplemented,
    /** POST /applications/{id}/submit: Accept the agreements and submit */
    submitApplication: notImplemented,
    /** POST /applications/{id}/respond: Send the requested information for review */
    respondToInformationRequest: notImplemented,
    /** POST /applications/{id}/withdraw: Withdraw an application */
    withdrawApplication: notImplemented,
    /** POST /applications/{id}/appeal: Appeal a rejection before the deadline */
    appealApplicationDecision: notImplemented,
    /** GET /stores/{slug}: Public seller storefront */
    getStorefront: notImplemented,
    /** GET /stores/{slug}/collections/{collectionId}: One featured collection with its offer ids */
    getStorefrontCollection: notImplemented,
  });
