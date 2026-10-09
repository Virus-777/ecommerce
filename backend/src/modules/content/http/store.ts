import { routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/content.js';
import type { ContentService } from '../service.js';
import { notFound } from '../service/base.js';

/**
 * Store API: /api/store/content/…  (docs/api/modules/content.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const storeRoutes = (service: ContentService) =>
  routes(endpoints, 'store', {
    /** GET /home: Homepage sections in order, resolved for display */
    getHomepage: async ({ query, principal }) => service.getHomePage({ device: query.device, ...(principal.kind === 'customer' && principal.accountId ? { customerId: principal.accountId } : {}) }),
    /** GET /pages/{slug}: Campaign page, collection, About or landing page */
    getStorePage: async ({ params }) => {
      const page = await service.getStorePage(params.slug);
      if (!page) throw notFound('Page');
      return page;
    },
    /** GET /collections: Published collections of a brand (or of one collection kind) as cards */
    listCollections: async ({ query, page }) => service.listCollections({ brandId: query.brandId, collectionKind: query.collectionKind }, page),
    /** GET /pages/{slug}/products: More products for rule-based collections (New arrivals, Best sellers) */
    listPageProducts: async ({ params, query, page }) => service.listPageProducts(params.slug, { categoryId: query.categoryId, blockId: query.blockId }, page),
    /** GET /navigation: Header and footer links, service strip, contact details and company line */
    getNavigation: async () => service.getNavigation(),
    /** GET /help: Help Center: topics, popular articles, popular searches, featured guide and contact channels */
    getHelpHome: async ({ query }) => service.getHelpCenter(query.audience ?? 'customer'),
    /** GET /help/articles: Search or browse help articles */
    searchHelp: async ({ query, page }) => service.searchHelp({ q: query.q, category: query.category, audience: query.audience }, page),
    /** GET /help/articles/{slug}: A help article with effective and updated dates and related articles */
    getHelpArticle: async ({ params }) => service.viewHelpArticle(params.slug),
    /** POST /help/articles/{id}/feedback: Was this helpful? */
    rateHelpArticle: async ({ params, body, principal, requestId }) => service.rateHelpArticle(params.id, body, { principal, requestId }),
    /** GET /policies: Policies with effective date and version */
    listPublicPolicies: async () => service.listPublicPolicies(),
    /** GET /policies/{key}: Current policy (or the version in effect at a date) */
    getPublicPolicy: async ({ params, query }) => service.getPublicPolicy(params.key, query.at),
    /** GET /policies/{key}/versions: Previous versions of a policy */
    listPublicPolicyVersions: async ({ params }) => service.listPublicPolicyVersions(params.key),
    /** GET /policy-versions/{id}: One past or current policy version (linked from order details) */
    getPublicPolicyVersion: async ({ params }) => service.getPublicPolicyVersion(params.id),
  });
