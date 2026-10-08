import { notImplemented } from '../../kernel/errors/index.js';
import type { EventPayload } from '../../kernel/events/index.js';
import type { ModuleContext } from '../../kernel/module-system/index.js';
import type * as common from '../../spec/common.js';
import type { SearchPublicApi, ProductCard, SearchContext, Suggestions, ZeroResultQuery } from '../../spec/search.js';
import type { SearchRepository } from './ports.js';

export interface SearchServiceDeps {
  repo: SearchRepository;
  ctx: ModuleContext<'search'>;
}

/**
 * Search use cases. Depends only on ports, the event bus, the clock and other modules' public APIs.
 * Each method maps to a publicApi function, a consumed event or a job in docs/api/spec/modules/search.json.
 */
export class SearchService implements SearchPublicApi {
  constructor(protected readonly deps: SearchServiceDeps) {}

  /* ---------------- public API (in-process) */

  /** Same engine as the store endpoint, without sponsored slots. Used for collections (new arrivals, best sellers, category picks). */
  async searchProducts(query: unknown): Promise<{ items: ProductCard[], total: number, nextCursor: string|null }> {
    throw notImplemented("search.searchProducts");
  }

  /** Cards for any product list (home sections, recently viewed, related products), same shape everywhere */
  async getProductCards(productIds: string[], opts?: { postalCode?: string, sellerId?: string }): Promise<ProductCard[]> {
    throw notImplemented("search.getProductCards");
  }

  /** Unavailable searches for the products and discovery report */
  async zeroResultStats(from: string, to: string): Promise<ZeroResultQuery[]> {
    throw notImplemented("search.zeroResultStats");
  }

  /** Store search with spelling correction, facets, store match, empty guidance and sponsored placeholders (ads are filled by advertising) */
  async runSearch(query: unknown & { exact?: boolean, postalCode?: string, searchId?: string }, page: common.PageInput): Promise<{ context: SearchContext, items: { productId: string, match: unknown }[], sponsoredSlots: unknown[], page: unknown }> {
    throw notImplemented("search.runSearch");
  }

  /** Category page listing with category attribute facets and category context */
  async listCategoryProducts(slug: string, query: unknown & { postalCode?: string, searchId?: string }, page: common.PageInput): Promise<{ context: SearchContext, items: { productId: string, match: unknown }[], sponsoredSlots: unknown[], page: unknown } | null> {
    throw notImplemented("search.listCategoryProducts");
  }

  /** Suggestions while typing: queries, categories, brands, stores, products and recent searches */
  async getSuggestions(prefix: string, session?: { customerId?: string, guestSessionId?: string }): Promise<Suggestions> {
    throw notImplemented("search.getSuggestions");
  }

  /** Similar in-stock products per product (related products, alternatives for unavailable products) */
  async similarProducts(productIds: string[], limit: number): Promise<Record<string, string[]>> {
    throw notImplemented("search.similarProducts");
  }

  /** Storefront product grid: products with a live offer from this seller, with the same filters, facets and sorts as search (query.filters.sellerIds is replaced by the seller). Each result's match.offer is this seller's offer. No store match and no sponsored slots. */
  async listSellerProducts(sellerId: string, query: unknown & { postalCode?: string, searchId?: string }, page: common.PageInput): Promise<{ context: SearchContext, items: { productId: string, match: unknown }[], sponsoredSlots: unknown[], page: unknown }> {
    throw notImplemented("search.listSellerProducts");
  }

  /** Storefront category chips: categories in which the seller has live offers, with product counts from the search index (the REST storefront's categories) */
  async sellerCategoryCounts(sellerIds: string[]): Promise<Record<string, { categoryId: string, name: string, slug: string, count: number, comingSoon: boolean }[]>> {
    throw notImplemented("search.sellerCategoryCounts");
  }

  /** Best-seller rank of products in their category by 30-day units sold; null when not ranked (outside the top 100 or below bestSellingMinOrders) */
  async bestSellerRanks(productIds: string[]): Promise<Record<string, { rank: number, categoryId: string, categoryName: string, label: string, updatedAt: string } | null>> {
    throw notImplemented("search.bestSellerRanks");
  }

  /* ---------------- events consumed */

  /** catalog.product.approved: Index the product (it appears once it has an eligible offer) */
  async onProductApprovedFromCatalog(event: EventPayload<"catalog.product.approved">): Promise<void> {
    throw notImplemented("search consumer of catalog.product.approved");
  }

  /** catalog.product.publication_changed: Remove Hidden or Suspended products; re-add on Active */
  async onProductPublicationChangedFromCatalog(event: EventPayload<"catalog.product.publication_changed">): Promise<void> {
    throw notImplemented("search consumer of catalog.product.publication_changed");
  }

  /** catalog.product.updated: Reindex title, brand, category, attributes and images */
  async onProductUpdatedFromCatalog(event: EventPayload<"catalog.product.updated">): Promise<void> {
    throw notImplemented("search consumer of catalog.product.updated");
  }

  /** catalog.product.merged: Drop the duplicate; reindex the kept product */
  async onProductMergedFromCatalog(event: EventPayload<"catalog.product.merged">): Promise<void> {
    throw notImplemented("search consumer of catalog.product.merged");
  }

  /** offers.offer.created: Mark the product dirty */
  async onOfferCreatedFromOffers(event: EventPayload<"offers.offer.created">): Promise<void> {
    throw notImplemented("search consumer of offers.offer.created");
  }

  /** offers.offer.price_changed: Update offer row and the product's from/featured price */
  async onOfferPriceChangedFromOffers(event: EventPayload<"offers.offer.price_changed">): Promise<void> {
    throw notImplemented("search consumer of offers.offer.price_changed");
  }

  /** offers.offer.status_changed: Update offer row; drop the product from in-stock results when it has no active offer */
  async onOfferStatusChangedFromOffers(event: EventPayload<"offers.offer.status_changed">): Promise<void> {
    throw notImplemented("search consumer of offers.offer.status_changed");
  }

  /** offers.featured.changed: Update featured offer, price and seller on the card */
  async onFeaturedChangedFromOffers(event: EventPayload<"offers.featured.changed">): Promise<void> {
    throw notImplemented("search consumer of offers.featured.changed");
  }

  /** inventory.stock.changed: Update in-stock and low-stock flags */
  async onStockChangedFromInventory(event: EventPayload<"inventory.stock.changed">): Promise<void> {
    throw notImplemented("search consumer of inventory.stock.changed");
  }

  /** reviews.review.published: Update rating and rating count */
  async onReviewPublishedFromReviews(event: EventPayload<"reviews.review.published">): Promise<void> {
    throw notImplemented("search consumer of reviews.review.published");
  }

  /** sellers.seller.approved: Add the store to store suggestions */
  async onSellerApprovedFromSellers(event: EventPayload<"sellers.seller.approved">): Promise<void> {
    throw notImplemented("search consumer of sellers.seller.approved");
  }

  /** sellers.seller.restricted: Refresh the seller's offers and store suggestion */
  async onSellerRestrictedFromSellers(event: EventPayload<"sellers.seller.restricted">): Promise<void> {
    throw notImplemented("search consumer of sellers.seller.restricted");
  }

  /** sellers.seller.suspended: Remove the store from suggestions; offers update through offers events */
  async onSellerSuspendedFromSellers(event: EventPayload<"sellers.seller.suspended">): Promise<void> {
    throw notImplemented("search consumer of sellers.seller.suspended");
  }

  /** sellers.seller.reinstated: Restore the store suggestion */
  async onSellerReinstatedFromSellers(event: EventPayload<"sellers.seller.reinstated">): Promise<void> {
    throw notImplemented("search consumer of sellers.seller.reinstated");
  }

  /** sellers.seller.closed: Remove the store from suggestions */
  async onSellerClosedFromSellers(event: EventPayload<"sellers.seller.closed">): Promise<void> {
    throw notImplemented("search consumer of sellers.seller.closed");
  }

  /** promotions.campaign.started: Update deal badges, was prices and deal end times on cards */
  async onCampaignStartedFromPromotions(event: EventPayload<"promotions.campaign.started">): Promise<void> {
    throw notImplemented("search consumer of promotions.campaign.started");
  }

  /** promotions.campaign.ended: Remove deal badges */
  async onCampaignEndedFromPromotions(event: EventPayload<"promotions.campaign.ended">): Promise<void> {
    throw notImplemented("search consumer of promotions.campaign.ended");
  }

  /** orders.order.placed: Count units for best-selling sort and popularity (phase 2 sort) */
  async onOrderPlacedFromOrders(event: EventPayload<"orders.order.placed">): Promise<void> {
    throw notImplemented("search consumer of orders.order.placed");
  }

  /** identity.guest_session.claimed: Merge the guest session's recent searches into the account (identity calls nothing in search) */
  async onGuestSessionClaimedFromIdentity(event: EventPayload<"identity.guest_session.claimed">): Promise<void> {
    throw notImplemented("search consumer of identity.guest_session.claimed");
  }

  /** catalog.brand.changed: Reindex the brand name, slug and status on the brand's product documents and brand suggestions; only active brands are suggested or offered as a facet */
  async onBrandChangedFromCatalog(event: EventPayload<"catalog.brand.changed">): Promise<void> {
    throw notImplemented("search consumer of catalog.brand.changed");
  }

  /** customers.marketing_preferences.changed: recentSearches false: delete the customer's saved recent searches and stop saving new ones; true: start saving again (nothing is restored) */
  async onMarketingPreferencesChangedFromCustomers(event: EventPayload<"customers.marketing_preferences.changed">): Promise<void> {
    throw notImplemented("search consumer of customers.marketing_preferences.changed");
  }

  /* ---------------- jobs */

  /** Job search.process-dirty (every 30 s): Rebuild documents in dirty_documents from catalog, offers, inventory, reviews and promotions public APIs */
  async processDirty(): Promise<void> {
    throw notImplemented("job search.process-dirty");
  }

  /** Job search.refresh-delivery-flags (every 15 min): Recompute 'Ships today' and arrives-by flags as dispatch cutoffs pass */
  async refreshDeliveryFlags(): Promise<void> {
    throw notImplemented("job search.refresh-delivery-flags");
  }

  /** Job search.refresh-suggestions (hourly): Rebuild suggestion_terms from popular queries (with results), categories, brands, stores and product names */
  async refreshSuggestions(): Promise<void> {
    throw notImplemented("job search.refresh-suggestions");
  }

  /** Job search.full-reindex (nightly 03:00 market time): Full rebuild (catches category tree changes, which catalog does not publish as events) */
  async fullReindex(): Promise<void> {
    throw notImplemented("job search.full-reindex");
  }

  /** Job search.sales-counts (nightly 03:30 market time): 30-day units sold per product for best-selling sort and popularity; enables best_selling once bestSellingMinOrders is reached; ranks the top 100 products per leaf category (best_seller_rank, shown as #3 in Headphones) */
  async salesCounts(): Promise<void> {
    throw notImplemented("job search.sales-counts");
  }

  /** Job search.prune-logs (daily 04:00 market time): Delete recent searches older than the retention period and query/click logs older than 13 months */
  async pruneLogs(): Promise<void> {
    throw notImplemented("job search.prune-logs");
  }
}
