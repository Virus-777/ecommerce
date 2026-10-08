import { notImplemented } from '../../kernel/errors/index.js';
import type { EventPayload } from '../../kernel/events/index.js';
import type { ModuleContext } from '../../kernel/module-system/index.js';
import type * as common from '../../spec/common.js';
import type * as identity from '../../spec/identity.js';
import type { OffersPublicApi, Offer, OfferView, OfferComparison, VariantAvailability, OfferSummary, FeaturedDecision, OfferChange, OfferSnapshot } from '../../spec/offers.js';
import type { OffersRepository } from './ports.js';

export interface OffersServiceDeps {
  repo: OffersRepository;
  ctx: ModuleContext<'offers'>;
}

/**
 * Offers use cases. Depends only on ports, the event bus, the clock and other modules' public APIs.
 * Each method maps to a publicApi function, a consumed event or a job in docs/api/spec/modules/offers.json.
 */
export class OffersService implements OffersPublicApi {
  constructor(protected readonly deps: OffersServiceDeps) {}

  /* ---------------- public API (in-process) */

  /** Current offer with terms and status */
  async getOffer(offerId: string): Promise<Offer | null> {
    throw notImplemented("offers.getOffer");
  }

  /** Price, availability, delivery estimate and comparable total for one offer at a location */
  async quoteOffer(offerId: string, quantity: number, postalCode?: string): Promise<OfferView> {
    throw notImplemented("offers.quoteOffer");
  }

  /** Scenario 2: reports price, stock, delivery or terms changes since the cart line was added. Never substitutes another seller. */
  async revalidate(lines: { offerId: string, quantity: number, termsVersion: number, price: common.Money }[], postalCode: string): Promise<{ ok: boolean, changes: OfferChange[] }> {
    throw notImplemented("offers.revalidate");
  }

  /** Frozen seller, condition, notes, missing items, price, compare-at and terms stored on the order item (plan ch. 8) */
  async snapshotForOrder(offerId: string): Promise<OfferSnapshot> {
    throw notImplemented("offers.snapshotForOrder");
  }

  /** Featured offer under the published rule; null when no eligible offer */
  async getFeaturedOffer(variantId: string, postalCode?: string): Promise<OfferView | null> {
    throw notImplemented("offers.getFeaturedOffer");
  }

  /** Active offers for indexing (from price, sellers, conditions, delivery flags) */
  async listActiveOffersForProduct(productId: string): Promise<OfferSummary[]> {
    throw notImplemented("offers.listActiveOffersForProduct");
  }

  /** Active, in stock and featured-eligible. Sponsored products may only promote such offers (plan ch. 16). */
  async isPromotable(offerId: string): Promise<boolean> {
    throw notImplemented("offers.isPromotable");
  }

  /** Lowest offer price in force in the window, from offer_price_history. The single source for honest was-prices. */
  async lowestPrice(offerId: string, sinceDays: number, before?: string): Promise<common.Money | null> {
    throw notImplemented("offers.lowestPrice");
  }

  /** Lowest, highest and current price in force in the window, from offer_price_history (wishlist price hints). */
  async priceRange(offerId: string, sinceDays: number): Promise<{ lowest: common.Money, highest: common.Money, current: common.Money, unchanged: boolean } | null> {
    throw notImplemented("offers.priceRange");
  }

  /** All offers for a product variant with comparable totals to a delivery location (all-offers page). Same as GET /products/{productId}/offers; primes the quoteOffer loader. */
  async compareOffers(productId: string, opts: { variantId?: string, condition?: 'all'|'new'|'used'|'refurbished', postalCode?: string, sort?: 'total_cost'|'fastest_delivery' }): Promise<OfferComparison> {
    throw notImplemented("offers.compareOffers");
  }

  /** Featured offer per product (default variant when variantId is omitted) under the published rule, batched for product cards and the purchase box */
  async getFeaturedOfferForProduct(items: { productId: string, variantId?: string }[], postalCode?: string): Promise<Record<string, Offer | null>> {
    throw notImplemented("offers.getFeaturedOfferForProduct");
  }

  /** Active offer count and price range per product; the lowest price always names its eligible offer */
  async getOfferStats(productIds: string[], opts?: { condition?: 'all'|'new'|'used'|'refurbished' }): Promise<Record<string, { count: number, lowest: common.Money, highest: common.Money, lowestOfferId: string, lowestSellerName: string } | null>> {
    throw notImplemented("offers.getOfferStats");
  }

  /** Variant chooser cues: offer count, lowest price, in stock, summary label */
  async getVariantOfferSummaries(variantIds: string[], postalCode?: string): Promise<Record<string, VariantAvailability>> {
    throw notImplemented("offers.getVariantOfferSummaries");
  }

  /** The seller's own offers on each product, any status (Seller Center product detail) */
  async listOwnOffersForProduct(sellerId: string, productIds: string[]): Promise<Record<string, Offer[]>> {
    throw notImplemented("offers.listOwnOffersForProduct");
  }

  /** One of the seller's own offers; null for another seller's offer */
  async getOwnOffer(sellerId: string, offerId: string): Promise<Offer | null> {
    throw notImplemented("offers.getOwnOffer");
  }

  /** Own offers matching title, seller SKU or GTIN, for the Seller Center top-bar search */
  async searchOwnOffers(sellerId: string, q: string, limit: number): Promise<{ items: OfferSummary[], more: boolean }> {
    throw notImplemented("offers.searchOwnOffers");
  }

  /** Any offer with status reason, eligibility, price history, status log and price changes (staff) */
  async getOfferAdmin(offerId: string): Promise<Offer | null> {
    throw notImplemented("offers.getOfferAdmin");
  }

  /** All offers with filters, including featured-ineligible offers by reason (staff) */
  async listOffersAdmin(filter: { sellerId?: string, official?: boolean, productId?: string, status?: string[], featuredEligible?: boolean, ineligibilityCode?: string, q?: string }, page: common.PageInput): Promise<common.Page<Offer>> {
    throw notImplemented("offers.listOffersAdmin");
  }

  /** Why each offer is or is not featured for a variant and location (staff) */
  async getFeaturedDecision(productId: string, variantId?: string, postalCode?: string): Promise<FeaturedDecision> {
    throw notImplemented("offers.getFeaturedDecision");
  }

  /** The offer for the purchase box: the requested offer when it is active on the product, otherwise the featured offer for the variant and location (ProductPage with a nullable offer id) */
  async getPurchaseBoxOffer(items: { productId: string, offerId?: string, variantId?: string }[], postalCode?: string): Promise<Record<string, Offer | null>> {
    throw notImplemented("offers.getPurchaseBoxOffer");
  }

  /** Active offers for a list of ids in the given order, inactive ones left out (storefront featured collections) */
  async listActiveOffersByIds(offerIds: string[], limit?: number): Promise<Offer[]> {
    throw notImplemented("offers.listActiveOffersByIds");
  }

  /** Export rows for reports datasets offers.admin.offers and offers.seller.offers (seller rows scoped to the principal's seller) */
  async exportRows(dataset: string, filters: unknown, principal: identity.Principal, cursor?: string): Promise<{ rows: unknown[], nextCursor?: string }> {
    throw notImplemented("offers.exportRows");
  }

  /* ---------------- events consumed */

  /** sellers.seller.restricted: Read affectedActivities and scope (categoryIds, conditions, offerIds, productIds; empty = whole account). sales: make the in-scope offers Ineligible (reason, affected activity and appeal route copied to statusReason; ineligible_source = restrictionId). new_listings / new_offers: refuse new in-scope offers and publishing drafts (SELLER_RESTRICTED). offer_reactivation: refuse resume and reactivation. Other sellers' offers are untouched (scenario 7). */
  async onSellerRestrictedFromSellers(event: EventPayload<"sellers.seller.restricted">): Promise<void> {
    throw notImplemented("offers consumer of sellers.seller.restricted");
  }

  /** sellers.restriction.updated: Re-apply the changed activities and scope: restore offers no longer covered, make newly covered offers Ineligible */
  async onRestrictionUpdatedFromSellers(event: EventPayload<"sellers.restriction.updated">): Promise<void> {
    throw notImplemented("offers consumer of sellers.restriction.updated");
  }

  /** sellers.restriction.lifted: restoreEligibility on offers whose ineligible_source is this restriction and that no remaining restriction covers */
  async onRestrictionLiftedFromSellers(event: EventPayload<"sellers.restriction.lifted">): Promise<void> {
    throw notImplemented("offers consumer of sellers.restriction.lifted");
  }

  /** sellers.seller.suspended: Make all the seller's offers Ineligible (ineligible_source = suspensionId); new sales stop while open orders keep their snapshots */
  async onSellerSuspendedFromSellers(event: EventPayload<"sellers.seller.suspended">): Promise<void> {
    throw notImplemented("offers consumer of sellers.seller.suspended");
  }

  /** sellers.seller.reinstated: restoreEligibility on offers made ineligible by liftedRestrictionId or endedSuspensionId, except offers still covered by remainingRestrictionIds */
  async onSellerReinstatedFromSellers(event: EventPayload<"sellers.seller.reinstated">): Promise<void> {
    throw notImplemented("offers consumer of sellers.seller.reinstated");
  }

  /** sellers.launch_review.decided: outcome passed: publish the seller's drafts waiting with publish_on_approval (approved product, complete offer; out_of_stock when available = 0) and clear statusReason awaiting_launch_review. changes_needed: keep them in draft */
  async onLaunchReviewDecidedFromSellers(event: EventPayload<"sellers.launch_review.decided">): Promise<void> {
    throw notImplemented("offers consumer of sellers.launch_review.decided");
  }

  /** sellers.seller.closed: Remove all the seller's offers (reason seller_closed) */
  async onSellerClosedFromSellers(event: EventPayload<"sellers.seller.closed">): Promise<void> {
    throw notImplemented("offers consumer of sellers.seller.closed");
  }

  /** catalog.product.publication_changed: Hidden or Suspended → offers Ineligible (product_hidden / product_suspended); Active → restoreEligibility */
  async onProductPublicationChangedFromCatalog(event: EventPayload<"catalog.product.publication_changed">): Promise<void> {
    throw notImplemented("offers consumer of catalog.product.publication_changed");
  }

  /** catalog.product.approved: Publish draft offers with publishOnApproval on that product; refresh content_gaps */
  async onProductApprovedFromCatalog(event: EventPayload<"catalog.product.approved">): Promise<void> {
    throw notImplemented("offers consumer of catalog.product.approved");
  }

  /** catalog.product.merged: Move offers from the duplicate to the kept product, mapping variants by options; unmatched variants are paused and the seller told */
  async onProductMergedFromCatalog(event: EventPayload<"catalog.product.merged">): Promise<void> {
    throw notImplemented("offers consumer of catalog.product.merged");
  }

  /** catalog.product.updated: Flag offers whose missingItems name items no longer in the product's box; seller asked to review; refresh content_gaps on the product's offers from catalog.getProductAdmin (missing images / identifiers) */
  async onProductUpdatedFromCatalog(event: EventPayload<"catalog.product.updated">): Promise<void> {
    throw notImplemented("offers consumer of catalog.product.updated");
  }

  /** inventory.stock.changed: available 0 → stockDepleted; available > 0 → stockRestored; mark featured decisions dirty */
  async onStockChangedFromInventory(event: EventPayload<"inventory.stock.changed">): Promise<void> {
    throw notImplemented("offers consumer of inventory.stock.changed");
  }

  /** access.approval.decided: Approve or reject pending price changes (and pending bulk rows) */
  async onApprovalDecidedFromAccess(event: EventPayload<"access.approval.decided">): Promise<void> {
    throw notImplemented("offers consumer of access.approval.decided");
  }

  /** trust.enforcement.recorded: Remove or hold offers named in an enforcement (counterfeit, abuse) */
  async onEnforcementRecordedFromTrust(event: EventPayload<"trust.enforcement.recorded">): Promise<void> {
    throw notImplemented("offers consumer of trust.enforcement.recorded");
  }

  /** promotions.campaign.started: Mark featured decisions dirty for offers whose automatic discount changes the comparable total */
  async onCampaignStartedFromPromotions(event: EventPayload<"promotions.campaign.started">): Promise<void> {
    throw notImplemented("offers consumer of promotions.campaign.started");
  }

  /** promotions.campaign.ended: Same as started */
  async onCampaignEndedFromPromotions(event: EventPayload<"promotions.campaign.ended">): Promise<void> {
    throw notImplemented("offers consumer of promotions.campaign.ended");
  }

  /* ---------------- jobs */

  /** Job offers.apply-price-schedule (every 1 min): Start scheduled price changes whose startsAt has passed; revert applied changes whose endsAt has passed; publish offers.offer.price_changed */
  async applyPriceSchedule(): Promise<void> {
    throw notImplemented("job offers.apply-price-schedule");
  }

  /** Job offers.recompute-featured (every 2 min (dirty rows) + nightly full): Recompute featured_offers rows marked dirty for each delivery zone; publish offers.featured.changed when the winner changes */
  async recomputeFeatured(): Promise<void> {
    throw notImplemented("job offers.recompute-featured");
  }

  /** Job offers.reevaluate-eligibility (hourly): Read seller performance (on-time dispatch over the window, delivery reviews, open restrictions) from sellers and update offer_eligibility; publish offers.offer.eligibility_changed */
  async reevaluateEligibility(): Promise<void> {
    throw notImplemented("job offers.reevaluate-eligibility");
  }

  /** Job offers.verify-compare-at (daily 02:00 market time): Drop compare-at prices whose basis no longer holds (e.g. no longer the 30-day low before the sale) and tell the owner */
  async verifyCompareAt(): Promise<void> {
    throw notImplemented("job offers.verify-compare-at");
  }

  /** Job offers.expire-bulk-previews (hourly): Expire preview_ready jobs past expiresAt */
  async expireBulkPreviews(): Promise<void> {
    throw notImplemented("job offers.expire-bulk-previews");
  }

  /** Job offers.parse-bulk-file (on demand (queue)): Parse uploaded CSV, resolve seller SKUs, validate rows, build preview */
  async parseBulkFile(): Promise<void> {
    throw notImplemented("job offers.parse-bulk-file");
  }
}
