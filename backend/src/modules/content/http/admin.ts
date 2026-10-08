import { notImplemented, routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/content.js';
import type { ContentService } from '../service.js';

/**
 * Admin API: /api/admin/content/…  (docs/api/modules/content.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const adminRoutes = (service: ContentService) => {
  void service;
  return routes(endpoints, 'admin', {
    /** GET /homepage: Homepage sections with owner, schedule, status and locked ad positions */
    getHomepageAdmin: notImplemented,
    /** POST /homepage/sections: Add a section to the draft layout */
    addHomeSection: notImplemented,
    /** PATCH /homepage/sections/{id}: Edit a section (heading, product source, schedule, position, owner) */
    updateHomeSection: notImplemented,
    /** GET /homepage/sections/{id}/products: Products in a section, resolved with title, seller and stock */
    listHomeSectionProducts: notImplemented,
    /** POST /homepage/sections/{id}/schedule: Schedule a section (show from / remove at) */
    scheduleHomeSection: notImplemented,
    /** POST /homepage/sections/{id}/remove: Remove a section (correction or removal, reason required) */
    removeHomeSection: notImplemented,
    /** PUT /homepage/order: Reorder sections in the draft (ad positions move with the layout but stay locked) */
    reorderHomeSections: notImplemented,
    /** POST /homepage/preview: Preview the homepage (draft or live) on desktop or phone at a given time */
    previewHomepage: notImplemented,
    /** POST /homepage/publish: Publish the draft layout as a new version */
    publishHomepage: notImplemented,
    /** POST /homepage/discard-draft: Discard the unpublished layout draft */
    discardHomepageDraft: notImplemented,
    /** GET /homepage/versions: Homepage version history */
    listHomepageVersions: notImplemented,
    /** POST /homepage/versions/{number}/restore: Restore an earlier layout (creates a new version; nothing is overwritten) */
    restoreHomepageVersion: notImplemented,
    /** GET /pages: Campaign pages and collections with publish and removal times */
    listPagesAdmin: notImplemented,
    /** POST /pages: Create a page or collection draft */
    createPage: notImplemented,
    /** GET /pages/{id}: Page with draft and live versions, checks and linked promotion */
    getPageAdmin: notImplemented,
    /** PATCH /pages/{id}: Edit the page draft (creates or updates the draft version) */
    updatePage: notImplemented,
    /** POST /pages/{id}/preview: Preview the draft as customers will see it */
    previewPage: notImplemented,
    /** POST /pages/{id}/submit: Send for review */
    submitPage: notImplemented,
    /** POST /pages/{id}/approve: Approve or request changes */
    approvePage: notImplemented,
    /** POST /pages/{id}/schedule: Set publish and removal times */
    schedulePage: notImplemented,
    /** POST /pages/{id}/publish: Publish the draft now */
    publishPage: notImplemented,
    /** POST /pages/{id}/unpublish: Take a page down (it can be republished) */
    unpublishPage: notImplemented,
    /** POST /pages/{id}/remove: Correction or removal action (reason required, takes effect now) */
    removePage: notImplemented,
    /** GET /pages/{id}/versions: Version history of a page */
    listPageVersions: notImplemented,
    /** POST /pages/{id}/versions/{number}/restore: Restore an earlier version as a new draft version */
    restorePageVersion: notImplemented,
    /** GET /help/summary: Published articles, policies, articles needing review and helpful rating */
    helpSummary: notImplemented,
    /** GET /help/items: Policies and help articles in one list */
    listHelpContent: notImplemented,
    /** GET /help/categories: Help categories including hidden */
    listHelpCategoriesAdmin: notImplemented,
    /** POST /help/categories: Create a help category */
    createHelpCategory: notImplemented,
    /** PATCH /help/categories/{id}: Rename, hide or reorder a category */
    updateHelpCategory: notImplemented,
    /** POST /help/articles: Create a help article draft */
    createHelpArticle: notImplemented,
    /** GET /help/articles/{id}: Article with status, versions and feedback */
    getHelpArticleAdmin: notImplemented,
    /** PATCH /help/articles/{id}: Edit the article draft */
    updateHelpArticle: notImplemented,
    /** POST /help/articles/{id}/transition: Submit, approve, request changes, schedule, publish, unpublish or remove an article */
    transitionHelpArticle: notImplemented,
    /** GET /help/articles/{id}/versions: Article version history */
    listArticleVersions: notImplemented,
    /** POST /help/articles/{id}/versions/{number}/restore: Restore an earlier article version as a new draft */
    restoreArticleVersion: notImplemented,
    /** GET /policies: Policies with current, scheduled and draft versions */
    listPoliciesAdmin: notImplemented,
    /** POST /policies: Create a new policy with its business owner */
    createPolicy: notImplemented,
    /** GET /policies/{id}/versions: All versions of a policy with effective date, summary and approver */
    listPolicyVersionsAdmin: notImplemented,
    /** POST /policies/{id}/versions: Start a new version draft (copies the current text) */
    createPolicyVersion: notImplemented,
    /** GET /policy-versions/{id}: A policy version with approvals */
    getPolicyVersionAdmin: notImplemented,
    /** PATCH /policy-versions/{id}: Edit a draft version (text, effective date, change summary, impact, notices) */
    updatePolicyVersion: notImplemented,
    /** GET /policy-versions/{id}/diff: Changes from the previous version */
    diffPolicyVersion: notImplemented,
    /** POST /policy-versions/{id}/submit: Send for approval (policy owner, then Business Owner) */
    submitPolicyVersion: notImplemented,
    /** POST /policy-versions/{id}/approve: Policy owner approval or changes requested */
    approvePolicyVersion: notImplemented,
    /** POST /policy-versions/{id}/schedule: Publish an approved version with its effective date */
    schedulePolicyVersion: notImplemented,
    /** POST /policy-versions/{id}/withdraw: Withdraw a version before it takes effect */
    withdrawPolicyVersion: notImplemented,
    /** PUT /navigation: Replace header and footer links */
    updateNavigation: notImplemented,
  });
};
