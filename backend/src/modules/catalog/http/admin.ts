import type { Principal } from '../../../kernel/auth/index.js';
import { routes, notImplemented } from '../../../kernel/http/index.js';
import type { Actor } from '../../../spec/common.js';
import { endpoints } from '../../../spec/catalog.js';
import type { CatalogService } from '../service.js';

const by = (i: { actor: Actor; requestId: string; principal: Principal }) => ({ actor: i.actor, requestId: i.requestId, principal: i.principal });
const staff = (i: { principal: Principal }) => ({ kind: 'staff' as const, staffId: i.principal.accountId ?? null });

/**
 * Admin API: /api/admin/catalog/…  (docs/api/modules/catalog.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const adminRoutes = (service: CatalogService) =>
  routes(endpoints, 'admin', {
    /** GET /review-queue: Submissions waiting for review, oldest first */
    reviewQueue: async (i) => service.reviewQueue(i.query, i.page, staff(i)),
    /** GET /products: All products with filters */
    listProductsAdmin: async (i) => service.listProductsAdmin(i.query, i.page, staff(i)),
    /** GET /products/stats: Counts for the catalog product tabs and page header */
    productStats: async () => service.productStats(),
    /** POST /products/exports: Export the filtered product list */
    exportProducts: async (i) => service.exportProducts(i.body, by(i)),
    /** GET /products/{id}: Product with review history and duplicate candidates */
    getProductAdmin: async (i) => service.productAdminFor(i.params.id, staff(i)),
    /** POST /products/{id}/checks/{kind}/dismiss: Mark an automated check finding as not applicable (e.g. Not a duplicate) */
    dismissCheck: async (i) => service.dismissCheck(i.params.id, i.params.kind, i.body, by(i)),
    /** PUT /products/{id}/review-draft: Save the reviewer's unsent decision */
    saveReviewDraft: async (i) => service.saveReviewDraft(i.params.id, i.body, by(i)),
    /** POST /products: Create an Official Store product draft */
    createOfficialDraft: async (i) => service.createOfficialDraft(i.body, by(i)),
    /** PATCH /products/{id}: Edit an Official Store draft */
    updateOfficialDraft: async (i) => service.updateOfficialDraft(i.params.id, i.body, by(i)),
    /** POST /products/{id}/submit: Submit an Official Store product (same standard as sellers) */
    submitOfficial: async (i) => service.submitOfficial(i.params.id, by(i)),
    /** POST /products/{id}/approve: Approve a submission */
    approveProduct: async (i) => service.approve(i.params.id, i.body?.note, by(i)),
    /** POST /products/{id}/request-changes: Ask the submitter to fix specific fields */
    requestChanges: async (i) => service.requestChanges(i.params.id, i.body, by(i)),
    /** POST /products/{id}/reject: Reject with a reason */
    rejectProduct: async (i) => service.reject(i.params.id, i.body.reason, by(i)),
    /** POST /products/{id}/publication: Set Active, Hidden or Suspended */
    setPublication: async (i) => service.setPublication(i.params.id, i.body, by(i)),
    /** GET /products/{id}/publication-impact: What hiding or suspending the product would do */
    publicationImpact: async (i) => service.publicationImpact(i.params.id, i.query.publication),
    /** POST /products/merge: Merge duplicates and submissions into the product to keep */
    mergeDuplicate: async (i) => service.mergeDuplicate(i.body, by(i)),
    /** POST /products/merge/preview: Preview what a merge moves before confirming */
    previewMerge: async (i) => service.previewMerge(i.body),
    /** POST /products/bulk: Bulk edit products (category, brand, publication) with preview */
    bulkUpdate: async (i) => service.bulkUpdate(i.body, by(i)),
    /** GET /corrections: Open correction suggestions */
    listCorrections: async (i) => service.listCorrections(i.query.state, i.page),
    /** POST /corrections/{id}/decide: Accept or decline a correction */
    decideCorrection: async (i) => service.decideCorrection(i.params.id, i.body, by(i)),
    /** GET /categories: Full category tree including hidden, with product and offer counts */
    categoriesAdmin: async () => service.listCategories({ includeHidden: true }),
    /** POST /categories: Create a category */
    createCategory: async (i) => service.createCategory(i.body, by(i)),
    /** PATCH /categories/{id}: Rename, move, hide or mark coming soon */
    updateCategory: async (i) => service.updateCategory(i.params.id, i.body, by(i)),
    /** GET /categories/{id}/attributes: Category attributes with fill rates, inheritance and image standards */
    getCategoryAttributesAdmin: async (i) => service.categoryAttributesAdmin(i.params.id),
    /** PUT /categories/{id}/attributes: Replace a category's attributes and image standards */
    putAttributes: async (i) => service.putAttributes(i.params.id, i.body, by(i)),
    /** GET /brands: All brands with counts, seller authorization and status */
    listBrandsAdmin: async (i) => service.listBrandsAdmin(i.query, i.page),
    /** POST /brands: Create a brand */
    createBrand: async (i) => service.createBrand(i.body, by(i)),
    /** PATCH /brands/{id}: Edit a brand, including who can sell */
    updateBrand: async (i) => service.updateBrand(i.params.id, i.body, by(i)),
    /** POST /brands/{id}/status: Activate, flag for review or block a brand (decides seller brand requests) */
    setBrandStatus: async (i) => service.setBrandStatus(i.params.id, i.body, by(i)),
    /** PATCH /products/{id}/variants/{variantId}: Set a variant's shipping weight, dimensions and list price (TODO pass 3: implement) */
    updateVariantDetails: notImplemented,
  });
