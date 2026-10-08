import { notImplemented } from '../../kernel/errors/index.js';
import type { EventPayload } from '../../kernel/events/index.js';
import type { ModuleContext } from '../../kernel/module-system/index.js';
import type * as common from '../../spec/common.js';
import type * as identity from '../../spec/identity.js';
import type { CatalogPublicApi, Category, Attribute, Brand, Product, ProductAdmin, ProductSnapshot } from '../../spec/catalog.js';
import type { CatalogRepository } from './ports.js';

export interface CatalogServiceDeps {
  repo: CatalogRepository;
  ctx: ModuleContext<'catalog'>;
}

/**
 * Catalog use cases. Depends only on ports, the event bus, the clock and other modules' public APIs.
 * Each method maps to a publicApi function, a consumed event or a job in docs/api/spec/modules/catalog.json.
 */
export class CatalogService implements CatalogPublicApi {
  readonly #deps: CatalogServiceDeps;

  constructor(deps: CatalogServiceDeps) {
    this.#deps = deps;
  }

  protected get deps(): CatalogServiceDeps {
    return this.#deps;
  }

  /* ---------------- public API (in-process) */

  /** Read shared product content */
  async getProduct(productId: string): Promise<Product | null> {
    throw notImplemented('catalog.getProduct');
  }

  /** Approved and Active. Offers only go live on purchasable products. */
  async isPurchasable(productId: string): Promise<boolean> {
    throw notImplemented('catalog.isPurchasable');
  }

  /** Frozen copy of title, brand, options and version stored on an order item (plan ch. 8: purchases keep what was accepted) */
  async snapshotForOrder(variantId: string): Promise<ProductSnapshot> {
    throw notImplemented('catalog.snapshotForOrder');
  }

  /** Category tree for menus and the Categories tab, with in-stock product counts and category images */
  async listCategories(opts: { includeHidden?: boolean }): Promise<Category[]> {
    throw notImplemented('catalog.listCategories');
  }

  /** Category page header, breadcrumb and filterable attributes */
  async getCategoryBySlug(slug: string): Promise<{ category: Category, breadcrumb: Category[], filters: Attribute[] } | null> {
    throw notImplemented('catalog.getCategoryBySlug');
  }

  /** Brand page header */
  async getBrandBySlug(slug: string): Promise<Brand | null> {
    throw notImplemented('catalog.getBrandBySlug');
  }

  /** A product the seller submitted, an approved product the seller has offers on, or any approved and active product (so the seller can create a first offer on it, seller/offer). Review log, missing fields and the submission are returned only when ownsSubmission is true (null otherwise); reviewState is returned for every resolved product (always approved when the seller did not submit it). Null (NOT_FOUND) only for another seller's unapproved product, or a hidden or suspended product the seller has no offer on. */
  async getProductForSeller(sellerId: string, productId: string): Promise<{ product: ProductAdmin, ownsSubmission: boolean } | null> {
    throw notImplemented('catalog.getProductForSeller');
  }

  /** Any product with review history and duplicate candidates (staff) */
  async getProductAdmin(productId: string): Promise<ProductAdmin | null> {
    throw notImplemented('catalog.getProductAdmin');
  }

  /** Submissions waiting for review */
  async listReviewQueue(filter: { kind?: unknown, categoryId?: unknown}, page: common.PageInput): Promise<common.Page<ProductAdmin>> {
    throw notImplemented('catalog.listReviewQueue');
  }

  /** Seller 360 catalog tiles (staff): the seller's submitted products by review state, and whether a restriction blocks new drafts and submissions (with its scope) and how many open submissions are paused */
  async countProductsForSellers(sellerIds: string[]): Promise<Record<string, { approved: number, inReview: number, changesRequested: number, rejected: number, drafts: number, submissionsBlocked: boolean, blockedNote: string | null, pausedSubmissions: number }>> {
    throw notImplemented('catalog.countProductsForSellers');
  }

  /** Export rows for reports dataset catalog.admin.products (the filtered admin product list) */
  async exportRows(dataset: string, filters: unknown, principal: identity.Principal, cursor?: string): Promise<{ rows: unknown[], nextCursor?: string }> {
    throw notImplemented('catalog.exportRows');
  }

  /* ---------------- events consumed */

  /** sellers.seller.restricted: When the restriction covers product submissions (optionally scoped to categories), block new drafts and submissions from that seller in scope and pause its open submissions in the review queue */
  async onSellerRestrictedFromSellers(event: EventPayload<"sellers.seller.restricted">): Promise<void> {
    void event;
    throw notImplemented('catalog consumer of sellers.seller.restricted');
  }

  /** sellers.seller.suspended: Pause the seller's open submissions in the review queue */
  async onSellerSuspendedFromSellers(event: EventPayload<"sellers.seller.suspended">): Promise<void> {
    void event;
    throw notImplemented('catalog consumer of sellers.seller.suspended');
  }

  /** sellers.seller.reinstated: Return paused submissions to the review queue */
  async onSellerReinstatedFromSellers(event: EventPayload<"sellers.seller.reinstated">): Promise<void> {
    void event;
    throw notImplemented('catalog consumer of sellers.seller.reinstated');
  }

  /** trust.enforcement.recorded: Suspend products named in a counterfeit enforcement */
  async onEnforcementRecordedFromTrust(event: EventPayload<"trust.enforcement.recorded">): Promise<void> {
    void event;
    throw notImplemented('catalog consumer of trust.enforcement.recorded');
  }

  /** offers.offer.created: Add the offer to offer_index and refresh listing_stats for the product */
  async onOfferCreatedFromOffers(event: EventPayload<"offers.offer.created">): Promise<void> {
    void event;
    throw notImplemented('catalog consumer of offers.offer.created');
  }

  /** offers.offer.status_changed: Update offer eligibility in offer_index and refresh listing_stats (offerNote names paused offers) */
  async onOfferStatusChangedFromOffers(event: EventPayload<"offers.offer.status_changed">): Promise<void> {
    void event;
    throw notImplemented('catalog consumer of offers.offer.status_changed');
  }

  /** offers.offer.price_changed: Update the offer price in offer_index and the product best price */
  async onOfferPriceChangedFromOffers(event: EventPayload<"offers.offer.price_changed">): Promise<void> {
    void event;
    throw notImplemented('catalog consumer of offers.offer.price_changed');
  }

  /** inventory.stock.changed: Update in_stock for the offer in offer_index and refresh listing_stats */
  async onStockChangedFromInventory(event: EventPayload<"inventory.stock.changed">): Promise<void> {
    void event;
    throw notImplemented('catalog consumer of inventory.stock.changed');
  }

  /** sellers.change_request.decided: kind brand_request and approved: create the brand as active from brandRequest (selling policy open: every approved seller may list it and the requesting seller gets no exclusive authorization; requestedBy records the seller and the change request), or activate a brand with the same name that is still under_review; publishes catalog.brand.changed. Rejected requests and other kinds are ignored */
  async onChangeRequestDecidedFromSellers(event: EventPayload<"sellers.change_request.decided">): Promise<void> {
    void event;
    throw notImplemented('catalog consumer of sellers.change_request.decided');
  }

  /* ---------------- jobs */

  /** Job catalog.refresh-counts (every 10 min): Roll listing_stats up into category_stats (with subcategories) and brand_stats (overall and per top-level category) */
  async refreshCounts(): Promise<void> {
    throw notImplemented('job catalog.refresh-counts');
  }
}
