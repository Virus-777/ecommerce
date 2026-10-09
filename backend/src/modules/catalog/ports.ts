/**
 * What the catalog service needs from the outside world, database-agnostic.
 * The Postgres adapter lives in infra/postgres/; a MongoDB switch would add infra/mongo/.
 */
import type { PageRequest } from '../../kernel/lib/pagination.js';
import type * as common from '../../spec/common.js';
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

/** Persistence for this module's own tables (schema catalog). */
export interface CatalogRepository {
  transaction<T>(fn: (tx: CatalogRepository) => Promise<T>): Promise<T>;
  /** Inbox (ctx.inbox): true the first time this key is claimed; commits with the transaction it runs in */
  claim(key: string): Promise<boolean>;

  /* categories, attributes, image standards */
  allCategories(): Promise<CategoryRow[]>;
  getCategory(id: string): Promise<CategoryRow | undefined>;
  insertCategory(row: CategoryRow): Promise<CategoryRow>;
  updateCategory(id: string, patch: Partial<CategoryRow>): Promise<CategoryRow>;
  categorySlugTaken(slug: string, exceptId?: string): Promise<boolean>;
  attributesOf(categoryIds: string[]): Promise<AttributeRow[]>;
  replaceAttributes(categoryId: string, rows: AttributeRow[]): Promise<void>;
  imageStandardsOf(categoryIds: string[]): Promise<ImageStandardRow[]>;
  saveImageStandard(categoryId: string, row: ImageStandardRow | null): Promise<void>;
  categoryStats(): Promise<CategoryStatsRow[]>;
  replaceCategoryStats(rows: CategoryStatsRow[]): Promise<void>;

  /* brands */
  getBrand(id: string, opts?: { forUpdate?: boolean }): Promise<BrandRow | undefined>;
  getBrands(ids: string[]): Promise<BrandRow[]>;
  getBrandBySlug(slug: string): Promise<BrandRow | undefined>;
  findBrandByName(name: string): Promise<BrandRow | undefined>;
  findBrandByChangeRequest(changeRequestId: string): Promise<BrandRow | undefined>;
  brandSlugTaken(slug: string, exceptId?: string): Promise<boolean>;
  listBrands(filter: BrandFilter, page: PageRequest): Promise<common.Page<BrandRow>>;
  /** Brands ordered by in-stock products from brand_stats (null = all categories) */
  listPopularBrands(filter: BrandFilter, categoryId: string | null, page: PageRequest): Promise<common.Page<BrandRow>>;
  insertBrand(row: BrandRow): Promise<BrandRow>;
  updateBrand(id: string, patch: Partial<BrandRow>): Promise<BrandRow>;
  authorizedSellers(brandIds: string[]): Promise<AuthorizedSellerRow[]>;
  /** Replaces the staff-added authorized sellers; claim-based entries stay */
  replaceStaffAuthorizedSellers(brandId: string, sellerIds: string[], addedBy: common.Actor, at: Date): Promise<void>;
  brandStats(brandIds: string[], categoryId: string | null): Promise<BrandStatsRow[]>;
  replaceBrandStats(rows: BrandStatsRow[]): Promise<void>;
  /** Products by brand (not merged), for brand admin counts */
  productCountsByBrand(brandIds: string[]): Promise<Map<string, number>>;
  /** Live product counts by brand within the given categories (popular brands of a subcategory) */
  liveProductCountsByBrandIn(categoryIds: string[]): Promise<Map<string, number>>;

  /* products */
  getProduct(id: string, opts?: { forUpdate?: boolean }): Promise<ProductRow | undefined>;
  getProducts(ids: string[]): Promise<ProductRow[]>;
  insertProduct(row: ProductRow): Promise<ProductRow>;
  updateProduct(id: string, patch: Partial<ProductRow>): Promise<ProductRow>;
  listProducts(filter: ProductFilter, page: PageRequest): Promise<common.Page<ProductRow>>;
  /** Keyset batches by id for exports */
  productBatch(filter: ProductFilter, afterId: string | null, limit: number): Promise<ProductRow[]>;
  productStats(): Promise<ProductStatsCounts>;
  productsInCategories(categoryIds: string[], reviewStates: string[]): Promise<ProductRow[]>;
  productsOfBrand(brandId: string, reviewStates: string[]): Promise<ProductRow[]>;
  /** Review states of the products sellers submitted */
  countBySellerAndState(sellerIds: string[]): Promise<{ seller_id: string; review_state: string; n: number }[]>;
  /** Approved, not merged products: GTIN, model number and title matches */
  matchProducts(input: { q: string; gtin?: string; limit: number }): Promise<MatchHit[]>;
  /** Candidates for the duplicate check */
  duplicateCandidates(input: { productId: string; modelNumber: string | null; gtins: string[]; titleWords: string[] }): Promise<ProductRow[]>;
  /** Live products (approved, active, not merged) with their listing stats, for the counts job */
  liveCountsSource(): Promise<{ id: string; brand_id: string | null; category_id: string | null; live: boolean; live_offers: number; offers: number }[]>;

  /* variants */
  variantsOf(productIds: string[]): Promise<VariantRow[]>;
  getVariant(id: string): Promise<VariantRow | undefined>;
  insertVariant(row: VariantRow): Promise<VariantRow>;
  updateVariant(id: string, patch: Partial<VariantRow>): Promise<void>;
  deleteVariants(ids: string[]): Promise<void>;
  /** Which products already use these GTINs */
  gtinOwners(gtins: string[]): Promise<{ gtin: string; product_id: string; variant_id: string }[]>;

  /* review log */
  insertLog(row: ReviewLogRow): Promise<void>;
  logsOf(productIds: string[]): Promise<ReviewLogRow[]>;
  latestLog(productId: string, action: string): Promise<ReviewLogRow | undefined>;

  /* submissions, checks, review drafts */
  insertSubmission(row: SubmissionRow): Promise<SubmissionRow>;
  updateSubmission(id: string, patch: Partial<SubmissionRow>): Promise<SubmissionRow>;
  getSubmission(id: string): Promise<SubmissionRow | undefined>;
  openSubmission(productId: string, opts?: { forUpdate?: boolean }): Promise<SubmissionRow | undefined>;
  latestSubmissions(productIds: string[]): Promise<SubmissionRow[]>;
  submissionCount(productId: string): Promise<number>;
  reviewQueue(filter: QueueFilter, page: PageRequest): Promise<common.Page<SubmissionRow>>;
  /** Open submissions of a seller's products (optionally only in some categories) */
  openSubmissionsOfSeller(sellerId: string, opts?: { categoryIds?: string[]; paused?: boolean }): Promise<SubmissionRow[]>;
  pausedCounts(sellerIds: string[]): Promise<Map<string, number>>;
  insertChecks(rows: CheckRow[]): Promise<void>;
  checksOf(submissionIds: string[]): Promise<CheckRow[]>;
  updateCheck(id: string, patch: Partial<CheckRow>): Promise<void>;
  saveDraft(row: ReviewDraftRow): Promise<ReviewDraftRow>;
  draftsOf(submissionIds: string[], staffId: string): Promise<ReviewDraftRow[]>;
  deleteDrafts(submissionId: string): Promise<void>;

  /* corrections */
  insertCorrection(row: CorrectionRow): Promise<CorrectionRow>;
  getCorrection(id: string, opts?: { forUpdate?: boolean }): Promise<CorrectionRow | undefined>;
  updateCorrection(id: string, patch: Partial<CorrectionRow>): Promise<CorrectionRow>;
  listCorrections(filter: { state?: string }, page: PageRequest): Promise<common.Page<CorrectionRow>>;

  /* offer index and listing stats */
  getOffer(offerId: string): Promise<OfferIndexRow | undefined>;
  upsertOffer(row: OfferIndexRow): Promise<void>;
  updateOffer(offerId: string, patch: Partial<OfferIndexRow>): Promise<void>;
  offersOf(productIds: string[]): Promise<OfferIndexRow[]>;
  offersOfSeller(sellerId: string, productIds: string[]): Promise<OfferIndexRow[]>;
  moveOffers(fromProductId: string, toProductId: string, variantMap: Map<string, string>): Promise<number>;
  listingStats(productIds: string[]): Promise<ListingStatsRow[]>;
  saveListingStats(row: ListingStatsRow): Promise<void>;
  productIdsWithOffers(): Promise<string[]>;
}
