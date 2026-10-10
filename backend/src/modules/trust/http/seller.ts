import { routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/trust.js';
import type { TrustService } from '../service.js';
import { appellantOf, byOf, sellerOf } from './who.js';

/**
 * Seller API: /api/seller/trust/…  (docs/api/modules/trust.md)
 * A seller reaches only its own reports, the proof requested from it, and enforcement on its account, offers,
 * products and claims. Reporters are never named.
 */
export const sellerRoutes = (service: TrustService) =>
  routes(endpoints, 'seller', {
    /** POST /reports: Report abuse by a customer, a counterfeit competitor offer or a listing problem */
    createSellerReport: async (i) => service.reports.file(i.body, await sellerOf(service, i), byOf(i)),
    /** GET /reports: Reports this seller made */
    listSellerReports: async (i) => service.reports.listMine({ kind: 'seller', ids: [i.sellerId] }, i.page),
    /** GET /evidence-requests: Proof Trust and Risk asked this seller for (e.g. proof of supply) */
    listSellerEvidenceRequests: async (i) => service.reports.listRequestsFor('seller', i.sellerId, i.query.state),
    /** POST /evidence-requests/{id}/answer: Send the requested proof */
    answerEvidenceRequest: async (i) => service.reports.answerRequest(i.params.id, i.body, { type: 'seller', ids: [i.sellerId], actor: i.actor, mediaOwner: { kind: 'seller', id: i.sellerId } }, byOf(i)),
    /** GET /enforcements: Trust actions on this seller's offers, products or claims, with appeal route */
    listSellerEnforcements: async (i) => service.actions.myEnforcements('seller', [i.sellerId], [i.sellerId]),
    /** POST /appeals: Appeal a trust action on an offer, product or claim */
    submitSellerAppeal: async (i) => service.appeals.submit(i.body, appellantOf(await sellerOf(service, i)), byOf(i)),
    /** GET /appeals: This seller's trust appeals */
    listSellerAppeals: async (i) => service.appeals.listMine('seller', [i.sellerId]),
  });
