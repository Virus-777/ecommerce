import { routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/search.js';
import type { SearchService } from '../service.js';

/**
 * Seller API: /api/seller/search/…  (docs/api/modules/search.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const sellerRoutes = (service: SearchService) =>
  routes(endpoints, 'seller', {
    /** GET /quick: Seller Center top-bar search across own orders, offers/SKUs and returns */
    sellerQuickSearch: async ({ query, sellerId, sellerAccess }) => service.sellerQuick(sellerId, sellerAccess, query),
  });
