import { routes } from '../../../kernel/http/index.js';
import { pageOf } from '../../../kernel/lib/pagination.js';
import { endpoints } from '../../../spec/search.js';
import type { SearchService } from '../service.js';

/**
 * Admin API: /api/admin/search/…  (docs/api/modules/search.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const adminRoutes = (service: SearchService) =>
  routes(endpoints, 'admin', {
    /** GET /lookup: Back-office top-bar quick search across orders, sellers, products and customers */
    adminLookup: async ({ query, can }) => service.adminLookup(query, can),
    /** GET /synonyms: Search synonyms */
    listSynonyms: async ({ query, page }) => service.listSynonyms(query, page),
    /** POST /synonyms: Add a synonym set (takes effect on the next query; no reindex needed) */
    createSynonym: async ({ body, actor, requestId }) => service.createSynonym(body, { actor, requestId }),
    /** PATCH /synonyms/{id}: Edit or deactivate a synonym set */
    updateSynonym: async ({ params, body, actor, requestId }) => service.updateSynonym(params.id, body, { actor, requestId }),
    /** DELETE /synonyms/{id}: Delete a synonym set */
    deleteSynonym: async ({ params, actor, requestId }) => service.deleteSynonym(params.id, { actor, requestId }),
    /** GET /index: Index size, staleness and lag behind events */
    getIndexStatus: async () => service.indexStatus(),
    /** POST /reindex-jobs: Reindex everything or a scope (products, category, brand, seller) */
    startReindex: async ({ body, actor, requestId }) => service.startReindex(body, { actor, requestId }),
    /** GET /reindex-jobs/{id}: Reindex progress */
    getReindexJob: async ({ params }) => service.getReindexJob(params.id),
    /** GET /zero-result-queries: Searches that found nothing (unavailable searches), most frequent first */
    listZeroResultQueries: async ({ query, page }) => pageOf(await service.zeroResultQueries(query.from, query.to), page),
    /** GET /explain: Why results rank as they do for a query (scores, factors, synonyms, correction) */
    explainSearch: async ({ query }) => service.explain(query),
    /** POST /ranking-policies: Publish a new ranking policy version (wording and recommended-sort weights) */
    publishRankingPolicy: async ({ body, actor, requestId }) => service.publishRankingPolicy(body, { actor, requestId }),
  });
