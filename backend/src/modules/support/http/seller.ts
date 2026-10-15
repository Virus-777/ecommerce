import { routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/support.js';
import type { SupportService } from '../service.js';

/**
 * Seller API: /api/seller/support/…  (docs/api/modules/support.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 * Sellers reach only cases about their own orders and their own support requests (others: 404).
 */
export const sellerRoutes = (service: SupportService) => {
  const own = (id: string, sellerId: string) => service.core.visible(id, { area: 'seller', sellerId });
  const detail = async (id: string) => service.views.view((await service.core.load(id))!, 'seller');

  return routes(endpoints, 'seller', {
    /** GET /cases: Customer cases and disputes about the seller's orders, and the seller's own support requests */
    listSellerCases: async ({ query, page, sellerId }) => service.reads.listForSeller(sellerId, { scope: query.scope, state: query.state, orderId: query.orderId }, page),
    /** GET /cases/{id}: Case as the seller sees it (no internal notes) */
    getSellerCase: async ({ params, sellerId }) => service.views.view(await own(params.id, sellerId), 'seller'),
    /** POST /cases/{id}/messages: Reply to the customer and Marketly support, optionally with an offer */
    sellerReply: async ({ params, body, sellerId, actor, requestId, principal }) => {
      const agg = await own(params.id, sellerId);
      await service.cases.sellerReply(agg, body, sellerId, { actor, requestId, principal });
      return detail(agg.c.id);
    },
    /** POST /cases/{id}/evidence: Add dispute evidence (photos, test videos, invoices, carrier records) */
    addSellerEvidence: async ({ params, body, sellerId, actor, requestId, principal }) => service.cases.addEvidence(await own(params.id, sellerId), body, 'seller', { actor, requestId, principal }),
    /** POST /cases/{id}/appeal: Appeal a dispute decision before the deadline */
    sellerAppeal: async ({ params, body, sellerId, actor, requestId, principal }) => {
      const agg = await own(params.id, sellerId);
      await service.decisions.appeal(agg, body, 'seller', { actor, requestId, principal });
      return detail(agg.c.id);
    },
    /** POST /requests: Contact seller support (Seller Manager team) */
    createSellerRequest: async ({ body, sellerId, actor, requestId, principal }) => service.views.view(await service.cases.createSellerRequest(body, sellerId, { actor, requestId, principal }), 'seller'),
    /** GET /categories: Seller support topics with expected reply time */
    listSellerCategories: async () => service.reads.sellerOptions(),
  });
};
