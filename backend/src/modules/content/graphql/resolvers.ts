import type { ModuleResolvers } from '../../../kernel/graphql/index.js';
import type { ContentService } from '../service.js';

/**
 * Resolvers for the GraphQL fields this module owns (`@source(module: "content", …)` in graphql/schema.ts).
 * A field without a resolver answers NOT_IMPLEMENTED; fields of this module's own types without
 * @source resolve from the parent object.
 *
 * Fields to resolve:
 *   Collection.products → service.collectionProducts
 *   Case.helpArticles → service.helpArticlesFor
 *   Query.homePage → service.getHomePage
 *   Query.contentPage → service.getStorePage
 *   Query.helpCenter → service.getHelpCenter
 *   Query.helpArticle → service.getHelpArticle
 *   Query.homePagePreview → service.previewHomePage
 *   Query.contentPagePreview → service.previewPage
 */
export const resolvers = (service: ContentService): ModuleResolvers => ({});
