import { notImplemented, routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/search.js';
import type { SearchService } from '../service.js';

/**
 * Store API: /api/store/search/…  (docs/api/modules/search.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const storeRoutes = (service: SearchService) =>
  routes(endpoints, 'store', {
    /** GET /products: Search results or category listing (product cards with sponsored slots marked) */
    searchProducts: notImplemented,
    /** GET /facets: Everything around the results for the same query: total, correction, applied filters, facets with counts, sorts, store match, category context, empty guidance */
    getSearchContext: notImplemented,
    /** GET /suggestions: Suggestions while typing: queries, categories, brands, stores, products and recent searches */
    getSuggestions: notImplemented,
    /** GET /recent-searches: Recent searches for this customer or guest session (max 10) */
    listRecentSearches: notImplemented,
    /** DELETE /recent-searches/{id}: Remove one recent search */
    deleteRecentSearch: notImplemented,
    /** DELETE /recent-searches: Clear all recent searches */
    clearRecentSearches: notImplemented,
    /** GET /products/{productId}/similar: Similar in-stock products (unavailable product alternatives and related products) */
    getSimilarProducts: notImplemented,
    /** GET /cards: Product cards for a list of product ids (home sections, recently viewed) */
    getProductCards: notImplemented,
    /** POST /searches/{searchId}/clicks: Record which result was opened (relevance and reports) */
    recordSearchClick: notImplemented,
    /** GET /barcodes/{code}: Resolve a scanned GTIN/UPC/EAN to a listed product and variant */
    lookupBarcode: notImplemented,
    /** GET /ranking-policy: Published 'How results are ranked' */
    getRankingPolicy: notImplemented,
  });
