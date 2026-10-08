import { notImplemented, routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/content.js';
import type { ContentService } from '../service.js';

/**
 * Store API: /api/store/content/…  (docs/api/modules/content.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const storeRoutes = (service: ContentService) => {
  void service;
  return routes(endpoints, 'store', {
    /** GET /home: Homepage sections in order, resolved for display */
    getHomepage: notImplemented,
    /** GET /pages/{slug}: Campaign page, collection, About or landing page */
    getStorePage: notImplemented,
    /** GET /collections: Published collections of a brand (or of one collection kind) as cards */
    listCollections: notImplemented,
    /** GET /pages/{slug}/products: More products for rule-based collections (New arrivals, Best sellers) */
    listPageProducts: notImplemented,
    /** GET /navigation: Header and footer links, service strip, contact details and company line */
    getNavigation: notImplemented,
    /** GET /help: Help Center: topics, popular articles, popular searches, featured guide and contact channels */
    getHelpHome: notImplemented,
    /** GET /help/articles: Search or browse help articles */
    searchHelp: notImplemented,
    /** GET /help/articles/{slug}: A help article with effective and updated dates and related articles */
    getHelpArticle: notImplemented,
    /** POST /help/articles/{id}/feedback: Was this helpful? */
    rateHelpArticle: notImplemented,
    /** GET /policies: Policies with effective date and version */
    listPublicPolicies: notImplemented,
    /** GET /policies/{key}: Current policy (or the version in effect at a date) */
    getPublicPolicy: notImplemented,
    /** GET /policies/{key}/versions: Previous versions of a policy */
    listPublicPolicyVersions: notImplemented,
    /** GET /policy-versions/{id}: One past or current policy version (linked from order details) */
    getPublicPolicyVersion: notImplemented,
  });
};
