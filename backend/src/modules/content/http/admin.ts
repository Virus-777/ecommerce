import { routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/content.js';
import type { ContentService } from '../service.js';
import type { By } from '../service/base.js';

const by = (i: { actor: By['actor']; requestId: string; principal: By['principal'] }): By => ({ actor: i.actor, requestId: i.requestId, principal: i.principal });

/**
 * Admin API: /api/admin/content/…  (docs/api/modules/content.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const adminRoutes = (service: ContentService) =>
  routes(endpoints, 'admin', {
    /* ---------------------------------------------------------------- homepage */
    getHomepageAdmin: async () => service.getHomepageAdmin(),
    addHomeSection: async (i) => service.addHomeSection(i.body, by(i)),
    updateHomeSection: async (i) => service.updateHomeSection(i.params.id, i.body, by(i)),
    listHomeSectionProducts: async (i) => service.listHomeSectionProducts(i.params.id, { includeHidden: i.query.includeHidden }, i.page),
    scheduleHomeSection: async (i) => service.scheduleHomeSection(i.params.id, i.body, by(i)),
    removeHomeSection: async (i) => service.removeHomeSection(i.params.id, i.body, by(i)),
    reorderHomeSections: async (i) => service.reorderHomeSections(i.body.sectionIds, by(i)),
    previewHomepage: async (i) => service.previewHomePage(i.body),
    publishHomepage: async (i) => service.publishHomepage(i.body, by(i)),
    discardHomepageDraft: async (i) => service.discardHomepageDraft(by(i)),
    listHomepageVersions: async (i) => service.listHomepageVersions(i.page),
    restoreHomepageVersion: async (i) => service.restoreHomepageVersion(i.params.number, i.body, by(i)),

    /* ---------------------------------------------------------------- pages and collections */
    listPagesAdmin: async (i) => service.listPagesAdmin(i.query, i.page),
    createPage: async (i) => service.createPage(i.body, by(i)),
    getPageAdmin: async (i) => service.getPageAdmin(i.params.id),
    updatePage: async (i) => service.updatePage(i.params.id, i.body, by(i)),
    previewPage: async (i) => service.previewPage(i.params.id),
    submitPage: async (i) => service.submitPage(i.params.id, by(i)),
    approvePage: async (i) => service.approvePage(i.params.id, i.body, by(i)),
    schedulePage: async (i) => service.schedulePage(i.params.id, i.body, by(i)),
    publishPage: async (i) => service.publishPage(i.params.id, by(i)),
    unpublishPage: async (i) => service.unpublishPage(i.params.id, i.body, by(i)),
    removePage: async (i) => service.removePage(i.params.id, i.body, by(i)),
    listPageVersions: async (i) => service.listPageVersions(i.params.id, i.page),
    restorePageVersion: async (i) => service.restorePageVersion(i.params.id, i.params.number, i.body, by(i)),

    /* ---------------------------------------------------------------- Help Center */
    helpSummary: async () => service.helpSummary(),
    listHelpContent: async (i) => service.listHelpContent(i.query, i.page),
    listHelpCategoriesAdmin: async () => service.listHelpCategoriesAdmin(),
    createHelpCategory: async (i) => service.createHelpCategory(i.body, by(i)),
    /** News (docs/06-news.md) */
    listNewsAdmin: async ({ query, page }) => service.listNewsAdmin({ status: query.status, categoryId: query.categoryId, q: query.q }, page),
    getNewsCounts: async () => service.getNewsCounts(),
    createNews: async (i) => service.createNews(i.body, by(i)),
    getNewsAdmin: async (i) => service.getNewsAdmin(i.params.id, by(i)),
    updateNews: async (i) => service.updateNews(i.params.id, i.body, by(i)),
    previewNews: async (i) => service.previewNews(i.params.id, i.body),
    transitionNews: async (i) => service.transitionNews(i.params.id, i.body, by(i)),
    pinNews: async (i) => service.pinNews(i.params.id, i.body, by(i)),
    listNewsVersions: async ({ params, page }) => service.listNewsVersions(params.id, page),
    restoreNewsVersion: async (i) => service.restoreNewsVersion(i.params.id, i.params.number, i.body, by(i)),
    listNewsCategoriesAdmin: async () => service.listNewsCategoriesAdmin(),
    createNewsCategory: async (i) => service.createNewsCategory(i.body, by(i)),
    updateNewsCategory: async (i) => service.updateNewsCategory(i.params.id, i.body, by(i)),
    deleteNewsCategory: async (i) => service.deleteNewsCategory(i.params.id, by(i)),
    updateHelpCategory: async (i) => service.updateHelpCategory(i.params.id, i.body, by(i)),
    createHelpArticle: async (i) => service.createHelpArticle(i.body, by(i)),
    getHelpArticleAdmin: async (i) => service.getHelpArticleAdmin(i.params.id, by(i)),
    updateHelpArticle: async (i) => service.updateHelpArticle(i.params.id, i.body, by(i)),
    transitionHelpArticle: async (i) => service.transitionHelpArticle(i.params.id, i.body, by(i)),
    listArticleVersions: async (i) => service.listArticleVersions(i.params.id, i.page),
    restoreArticleVersion: async (i) => service.restoreArticleVersion(i.params.id, i.params.number, i.body, by(i)),

    /* ---------------------------------------------------------------- policies */
    listPoliciesAdmin: async () => service.listPoliciesAdmin(),
    createPolicy: async (i) => service.createPolicy(i.body, by(i)),
    listPolicyVersionsAdmin: async (i) => service.listPolicyVersionsAdmin(i.params.id),
    createPolicyVersion: async (i) => service.createPolicyVersion(i.params.id, i.body ?? {}, by(i)),
    getPolicyVersionAdmin: async (i) => service.getPolicyVersionAdmin(i.params.id),
    updatePolicyVersion: async (i) => service.updatePolicyVersion(i.params.id, i.body, by(i)),
    diffPolicyVersion: async (i) => service.diffPolicyVersion(i.params.id),
    submitPolicyVersion: async (i) => service.submitPolicyVersion(i.params.id, by(i)),
    approvePolicyVersion: async (i) => service.approvePolicyVersion(i.params.id, i.body, { ...by(i), can: i.can }),
    schedulePolicyVersion: async (i) => service.schedulePolicyVersion(i.params.id, i.body, by(i)),
    withdrawPolicyVersion: async (i) => service.withdrawPolicyVersion(i.params.id, i.body, by(i)),

    /* ---------------------------------------------------------------- navigation */
    updateNavigation: async (i) => service.updateNavigation(i.body, by(i)),
    /** POST /homepage/submit: Send the draft layout for review */
    submitHomepageDraft: async (i) => service.submitHomepageDraft(i.body ?? {}, by(i)),
    /** POST /homepage/review: Approve the draft layout or request changes */
    reviewHomepageDraft: async (i) => service.reviewHomepageDraft(i.body, by(i)),
    /** POST /pages/{id}/cancel-schedule: Cancel a scheduled publication */
    cancelPageSchedule: async (i) => service.cancelPageSchedule(i.params.id, i.body ?? {}, by(i)),
  });
