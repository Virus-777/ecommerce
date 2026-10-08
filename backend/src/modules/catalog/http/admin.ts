import { notImplemented, routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/catalog.js';
import type { CatalogService } from '../service.js';

/**
 * Admin API: /api/admin/catalog/…  (docs/api/modules/catalog.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const adminRoutes = (service: CatalogService) =>
  routes(endpoints, 'admin', {
    /** GET /review-queue: Submissions waiting for review, oldest first */
    reviewQueue: notImplemented,
    /** GET /products: All products with filters */
    listProductsAdmin: notImplemented,
    /** GET /products/stats: Counts for the catalog product tabs and page header */
    productStats: notImplemented,
    /** POST /products/exports: Export the filtered product list */
    exportProducts: notImplemented,
    /** GET /products/{id}: Product with review history and duplicate candidates */
    getProductAdmin: notImplemented,
    /** POST /products/{id}/checks/{kind}/dismiss: Mark an automated check finding as not applicable (e.g. Not a duplicate) */
    dismissCheck: notImplemented,
    /** PUT /products/{id}/review-draft: Save the reviewer's unsent decision */
    saveReviewDraft: notImplemented,
    /** POST /products: Create an Official Store product draft */
    createOfficialDraft: notImplemented,
    /** PATCH /products/{id}: Edit an Official Store draft */
    updateOfficialDraft: notImplemented,
    /** POST /products/{id}/submit: Submit an Official Store product (same standard as sellers) */
    submitOfficial: notImplemented,
    /** POST /products/{id}/approve: Approve a submission */
    approveProduct: notImplemented,
    /** POST /products/{id}/request-changes: Ask the submitter to fix specific fields */
    requestChanges: notImplemented,
    /** POST /products/{id}/reject: Reject with a reason */
    rejectProduct: notImplemented,
    /** POST /products/{id}/publication: Set Active, Hidden or Suspended */
    setPublication: notImplemented,
    /** GET /products/{id}/publication-impact: What hiding or suspending the product would do */
    publicationImpact: notImplemented,
    /** POST /products/merge: Merge duplicates and submissions into the product to keep */
    mergeDuplicate: notImplemented,
    /** POST /products/merge/preview: Preview what a merge moves before confirming */
    previewMerge: notImplemented,
    /** POST /products/bulk: Bulk edit products (category, brand, publication) with preview */
    bulkUpdate: notImplemented,
    /** GET /corrections: Open correction suggestions */
    listCorrections: notImplemented,
    /** POST /corrections/{id}/decide: Accept or decline a correction */
    decideCorrection: notImplemented,
    /** GET /categories: Full category tree including hidden, with product and offer counts */
    categoriesAdmin: notImplemented,
    /** POST /categories: Create a category */
    createCategory: notImplemented,
    /** PATCH /categories/{id}: Rename, move, hide or mark coming soon */
    updateCategory: notImplemented,
    /** GET /categories/{id}/attributes: Category attributes with fill rates, inheritance and image standards */
    getCategoryAttributesAdmin: notImplemented,
    /** PUT /categories/{id}/attributes: Replace a category's attributes and image standards */
    putAttributes: notImplemented,
    /** GET /brands: All brands with counts, seller authorization and status */
    listBrandsAdmin: notImplemented,
    /** POST /brands: Create a brand */
    createBrand: notImplemented,
    /** PATCH /brands/{id}: Edit a brand, including who can sell */
    updateBrand: notImplemented,
    /** POST /brands/{id}/status: Activate, flag for review or block a brand (decides seller brand requests) */
    setBrandStatus: notImplemented,
  });
