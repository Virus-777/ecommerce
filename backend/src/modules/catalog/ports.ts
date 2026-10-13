/** Row types of the catalog collections and the filter shapes the repository (repository.ts) takes. */
import type { CatalogDb } from '../../spec/catalog.js';

export type CategoryRow = CatalogDb['categories'];
export type AttributeRow = CatalogDb['attributes'];
export type ImageStandardRow = CatalogDb['image_standards'];
export type BrandRow = CatalogDb['brands'];
export type ProductRow = CatalogDb['products'];
export type VariantRow = CatalogDb['variants'];
export type ReviewLogRow = CatalogDb['review_log'];
export type CorrectionRow = CatalogDb['correction_suggestions'];
export type SubmissionRow = CatalogDb['submissions'];
export type CheckRow = CatalogDb['submission_checks'];
export type CheckDismissalRow = CatalogDb['check_dismissals'];
export type ReviewDraftRow = CatalogDb['review_drafts'];
export type AuthorizedSellerRow = CatalogDb['brand_authorized_sellers'];
export type OfferIndexRow = CatalogDb['offer_index'];
export type ListingStatsRow = CatalogDb['listing_stats'];
export type CategoryStatsRow = CatalogDb['category_stats'];
export type BrandStatsRow = CatalogDb['brand_stats'];

export interface ProductFilter {
  q?: string;
  /** Category and its subcategories */
  categoryIds?: string[];
  brandId?: string;
  ownerSellerId?: string;
  reviewStates?: string[];
  publication?: string;
  missingContent?: boolean;
  duplicateSuspected?: boolean;
  /** Merged duplicates are left out unless asked */
  includeMerged?: boolean;
  /** q also matches a variant GTIN exactly (product pickers) */
  matchGtin?: boolean;
  /** Approved and active only */
  purchasableOnly?: boolean;
  updatedSince?: Date;
}

export interface BrandFilter {
  q?: string;
  statuses?: string[];
  sellingPolicy?: string;
  requested?: boolean;
  /** Seller form: active brands plus this seller's own requests still under review */
  activeOrRequestedBy?: string;
}

export interface QueueFilter {
  kind?: string;
  categoryIds?: string[];
}

export interface MatchHit {
  product: ProductRow;
  matchedOn: 'gtin' | 'model' | 'title';
}

export interface ProductStatsCounts {
  all: number;
  active: number;
  hidden: number;
  suspended: number;
  missingContent: number;
  duplicatesSuspected: number;
  inReview: number;
  offers: number;
}
