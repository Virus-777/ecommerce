import { routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/content.js';
import type { ContentService } from '../service.js';

/**
 * Seller API: /api/seller/content/…  (docs/api/modules/content.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 * The Help Center with the seller's own session: the same help reads as the store, for the seller audience.
 */
export const sellerRoutes = (service: ContentService) =>
  routes(endpoints, 'seller', {
    /** GET /help: Seller Help Center: seller topics, popular articles and searches, featured guide and contact channels */
    getSellerHelpHome: async () => service.getHelpCenter('seller'),
    /** GET /help/articles: Search or browse seller help articles */
    searchSellerHelp: async ({ query, page }) => service.searchHelp({ q: query.q, category: query.category, audience: 'seller' }, page),
    /** GET /help/articles/{slug}: A seller help article */
    getSellerHelpArticle: async ({ params }) => service.viewSellerHelpArticle(params.slug),
    /** POST /help/articles/{id}/feedback: Was this helpful? (seller) */
    rateSellerHelpArticle: async ({ params, body, principal, requestId }) => service.rateSellerHelpArticle(params.id, body, { principal, requestId }),
  });
