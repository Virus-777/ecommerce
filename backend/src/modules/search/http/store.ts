import { routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/search.js';
import type { SearchService } from '../service.js';

/**
 * Store API: /api/store/search/…  (docs/api/modules/search.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const storeRoutes = (service: SearchService) =>
  routes(endpoints, 'store', {
    /** GET /products: Search results or category listing (product cards with sponsored slots marked) */
    searchProducts: async ({ query, page, principal }) => service.restProducts(query, page, principal),
    /** GET /facets: Everything around the results for the same query: total, correction, applied filters, facets with counts, sorts, store match, category context, empty guidance */
    getSearchContext: async ({ query, principal }) => service.restContext(query, principal),
    /** GET /suggestions: Suggestions while typing: queries, categories, brands, stores, products and recent searches */
    getSuggestions: async ({ query, principal }) => service.suggestions(query.q, await service.sessionFor(principal), query.limit),
    /** GET /recent-searches: Recent searches for this customer or guest session (max 10) */
    listRecentSearches: async ({ scope }) => service.recentForScope(scope),
    /** DELETE /recent-searches/{id}: Remove one recent search */
    deleteRecentSearch: async ({ params, scope }) => service.deleteRecent(scope, params.id),
    /** DELETE /recent-searches: Clear all recent searches */
    clearRecentSearches: async ({ scope }) => service.clearRecent(scope),
    /** GET /products/{productId}/similar: Similar in-stock products (unavailable product alternatives and related products) */
    getSimilarProducts: async ({ params, query }) => service.similarCards(params.productId, query.limit),
    /** GET /cards: Product cards for a list of product ids (home sections, recently viewed) */
    getProductCards: async ({ query }) => service.getProductCards(query.ids, query.postalCode ? { postalCode: query.postalCode } : {}),
    /** POST /searches/{searchId}/clicks: Record which result was opened (relevance and reports) */
    recordSearchClick: async ({ params, body }) => service.recordClick(params.searchId, body),
    /** GET /barcodes/{code}: Resolve a scanned GTIN/UPC/EAN to a listed product and variant */
    lookupBarcode: async ({ params, principal }) => service.barcode(params.code, await service.sessionFor(principal)),
    /** GET /ranking-policy: Published 'How results are ranked' */
    getRankingPolicy: async () => service.rankingPolicy(),
  });
