import { notImplemented, routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/search.js';
import type { SearchService } from '../service.js';

/**
 * Admin API: /api/admin/search/…  (docs/api/modules/search.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const adminRoutes = (service: SearchService) =>
  routes(endpoints, 'admin', {
    /** GET /lookup: Back-office top-bar quick search across orders, sellers, products and customers */
    adminLookup: notImplemented,
    /** GET /synonyms: Search synonyms */
    listSynonyms: notImplemented,
    /** POST /synonyms: Add a synonym set (takes effect on the next query; no reindex needed) */
    createSynonym: notImplemented,
    /** PATCH /synonyms/{id}: Edit or deactivate a synonym set */
    updateSynonym: notImplemented,
    /** DELETE /synonyms/{id}: Delete a synonym set */
    deleteSynonym: notImplemented,
    /** GET /index: Index size, staleness and lag behind events */
    getIndexStatus: notImplemented,
    /** POST /reindex-jobs: Reindex everything or a scope (products, category, brand, seller) */
    startReindex: notImplemented,
    /** GET /reindex-jobs/{id}: Reindex progress */
    getReindexJob: notImplemented,
    /** GET /zero-result-queries: Searches that found nothing (unavailable searches), most frequent first */
    listZeroResultQueries: notImplemented,
    /** GET /explain: Why results rank as they do for a query (scores, factors, synonyms, correction) */
    explainSearch: notImplemented,
    /** POST /ranking-policies: Publish a new ranking policy version (wording and recommended-sort weights) */
    publishRankingPolicy: notImplemented,
  });
