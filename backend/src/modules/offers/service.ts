import type { EventEnvelope, EventPayload } from '../../kernel/events/index.js';
import type * as common from '../../spec/common.js';
import type * as identity from '../../spec/identity.js';
import type { FeaturedDecision, Offer, OfferChange, OfferComparison, OfferSnapshot, OfferSummary, OffersPublicApi, OfferView, VariantAvailability } from '../../spec/offers.js';
import { BulkPart } from './service/bulk.js';
import { Core, type OffersServiceDeps } from './service/core.js';
import { EnforcementPart } from './service/enforcement.js';
import { FeaturedPart } from './service/featured.js';
import { ManagePart } from './service/manage.js';
import { PricingPart } from './service/pricing.js';
import { StorefrontPart } from './service/storefront.js';
import { ViewsPart } from './service/views.js';
import { isUuid } from '../../kernel/lib/ids.js';

export type { OffersServiceDeps };

/**
 * Offers use cases. Depends only on ports, the event bus, the clock and other modules' public APIs.
 * The work is split by area (service/*.ts); this class is the module's public API, its event consumers and jobs.
 */
export class OffersService implements OffersPublicApi {
  readonly core: Core;
  readonly manage: ManagePart;
  readonly pricing: PricingPart;
  readonly storefront: StorefrontPart;
  readonly featured: FeaturedPart;
  readonly enforcement: EnforcementPart;
  readonly views: ViewsPart;
  readonly bulk: BulkPart;

  constructor(deps: OffersServiceDeps) {
    this.core = new Core(deps);
    this.manage = new ManagePart(this.core);
    this.pricing = new PricingPart(this.core);
    this.storefront = new StorefrontPart(this.core);
    this.featured = new FeaturedPart(this.core);
    this.enforcement = new EnforcementPart(this.core);
    this.views = new ViewsPart(this.core);
    this.bulk = new BulkPart(this.core);
    this.core.parts = { manage: this.manage, pricing: this.pricing, storefront: this.storefront, featured: this.featured, enforcement: this.enforcement, views: this.views, bulk: this.bulk };
  }

  /* ---------------- public API (in-process) */

  async getOffer(offerId: string): Promise<Offer | null> {
    const row = isUuid(offerId) ? await this.core.repo.get('offers', offerId) : undefined;
    return row ? this.core.toOffer(row) : null;
  }

  /** Batch read in any status; unknown ids map to null */
  async getOffers(offerIds: string[]): Promise<Record<string, Offer | null>> {
    const ids = [...new Set((offerIds ?? []).filter(isUuid))];
    const out: Record<string, Offer | null> = Object.fromEntries((offerIds ?? []).map((id) => [id, null]));
    if (!ids.length) return out;
    for (const o of await this.core.toOffers(await this.core.repo.getMany('offers', ids))) out[o.id] = o;
    return out;
  }

  /** Offers that still use a shipping profile: every status except removed (one count query) */
  async countActiveOffersByProfile(shippingProfileId: string): Promise<number> {
    if (!isUuid(shippingProfileId)) return 0;
    return this.core.repo.count('offers', { shipping_profile_id: shippingProfileId, status: { op: '<>', value: 'removed' } });
  }

  quoteOffer(offerId: string, quantity: number, postalCode?: string): Promise<OfferView> {
    return this.storefront.quoteOffer(offerId, quantity, postalCode);
  }

  revalidate(lines: { offerId: string; quantity: number; termsVersion: number; price: common.Money }[], postalCode: string): Promise<{ ok: boolean; changes: OfferChange[] }> {
    return this.storefront.revalidate(lines, postalCode);
  }

  snapshotForOrder(offerId: string): Promise<OfferSnapshot> {
    return this.storefront.snapshotForOrder(offerId);
  }

  getFeaturedOffer(variantId: string, postalCode?: string): Promise<OfferView | null> {
    return this.storefront.getFeaturedOffer(variantId, postalCode);
  }

  listActiveOffersForProduct(productId: string): Promise<OfferSummary[]> {
    return this.storefront.listActiveOffersForProduct(productId);
  }

  isPromotable(offerId: string): Promise<boolean> {
    return this.storefront.isPromotable(offerId);
  }

  lowestPrice(offerId: string, sinceDays: number, before?: string): Promise<common.Money | null> {
    return this.pricing.lowestPrice(offerId, sinceDays, before);
  }

  priceRange(offerId: string, sinceDays: number): Promise<{ lowest: common.Money; highest: common.Money; current: common.Money; unchanged: boolean } | null> {
    return this.pricing.priceRange(offerId, sinceDays);
  }

  compareOffers(productId: string, opts: { variantId?: string; condition?: 'all' | 'new' | 'used' | 'refurbished'; postalCode?: string; sort?: 'total_cost' | 'fastest_delivery' }): Promise<OfferComparison> {
    return this.storefront.compareOffers(productId, opts ?? {});
  }

  getFeaturedOfferForProduct(items: { productId: string; variantId?: string }[], postalCode?: string): Promise<Record<string, Offer | null>> {
    return this.storefront.getFeaturedOfferForProduct(items, postalCode);
  }

  getOfferStats(productIds: string[], opts?: { condition?: 'all' | 'new' | 'used' | 'refurbished' }) {
    return this.storefront.getOfferStats(productIds, opts);
  }

  getVariantOfferSummaries(variantIds: string[], postalCode?: string): Promise<Record<string, VariantAvailability>> {
    return this.storefront.getVariantOfferSummaries(variantIds, postalCode);
  }

  listOwnOffersForProduct(sellerId: string, productIds: string[]): Promise<Record<string, Offer[]>> {
    return this.views.listOwnForProducts(sellerId, productIds);
  }

  async getOwnOffer(sellerId: string, offerId: string): Promise<Offer | null> {
    const row = isUuid(offerId) ? await this.core.repo.get('offers', offerId) : undefined;
    return row && row.owner_type === 'seller' && row.seller_id === sellerId ? this.core.toOffer(row) : null;
  }

  searchOwnOffers(sellerId: string, q: string, limit: number): Promise<{ items: OfferSummary[]; more: boolean }> {
    return this.views.searchOwn(sellerId, q, limit);
  }

  getOfferAdmin(offerId: string): Promise<Offer | null> {
    return this.getOffer(offerId);
  }

  listOffersAdmin(filter: { sellerId?: string; official?: boolean; productId?: string; status?: string[]; featuredEligible?: boolean; ineligibilityCode?: string; q?: string }, page: common.PageInput): Promise<common.Page<Offer>> {
    return this.views.listAdmin(filter ?? {}, page ?? {});
  }

  getFeaturedDecision(productId: string, variantId?: string, postalCode?: string): Promise<FeaturedDecision> {
    return this.featured.explain(productId, variantId, postalCode);
  }

  getPurchaseBoxOffer(items: { productId: string; offerId?: string; variantId?: string }[], postalCode?: string): Promise<Record<string, Offer | null>> {
    return this.storefront.getPurchaseBoxOffer(items, postalCode);
  }

  listActiveOffersByIds(offerIds: string[], limit?: number): Promise<Offer[]> {
    return this.storefront.listActiveOffersByIds(offerIds, limit);
  }

  exportRows(dataset: string, filters: unknown, principal: identity.Principal, cursor?: string): Promise<{ rows: unknown[]; nextCursor?: string }> {
    return this.views.exportRows(dataset, filters, principal, cursor);
  }

  /* ---------------- events consumed */

  onSellerRestrictedFromSellers(event: EventPayload<'sellers.seller.restricted'>, envelope?: Pick<EventEnvelope, 'actor'>) {
    return this.enforcement.onSellerRestricted(event, envelope?.actor);
  }

  onRestrictionUpdatedFromSellers(event: EventPayload<'sellers.restriction.updated'>) {
    return this.enforcement.onRestrictionUpdated(event);
  }

  onRestrictionLiftedFromSellers(event: EventPayload<'sellers.restriction.lifted'>) {
    return this.enforcement.onRestrictionLifted(event);
  }

  onSellerSuspendedFromSellers(event: EventPayload<'sellers.seller.suspended'>) {
    return this.enforcement.onSellerSuspended(event);
  }

  onSellerReinstatedFromSellers(event: EventPayload<'sellers.seller.reinstated'>) {
    return this.enforcement.onSellerReinstated(event);
  }

  onLaunchReviewDecidedFromSellers(event: EventPayload<'sellers.launch_review.decided'>) {
    return this.enforcement.onLaunchReviewDecided(event);
  }

  onSellerClosedFromSellers(event: EventPayload<'sellers.seller.closed'>) {
    return this.enforcement.onSellerClosed(event);
  }

  onProductPublicationChangedFromCatalog(event: EventPayload<'catalog.product.publication_changed'>) {
    return this.enforcement.onProductPublicationChanged(event);
  }

  onProductApprovedFromCatalog(event: EventPayload<'catalog.product.approved'>) {
    return this.enforcement.onProductApproved(event);
  }

  onProductMergedFromCatalog(event: EventPayload<'catalog.product.merged'>) {
    return this.enforcement.onProductMerged(event);
  }

  onProductUpdatedFromCatalog(event: EventPayload<'catalog.product.updated'>) {
    return this.enforcement.onProductUpdated(event);
  }

  onStockChangedFromInventory(event: EventPayload<'inventory.stock.changed'>) {
    return this.enforcement.onStockChanged(event);
  }

  onApprovalDecidedFromAccess(event: EventPayload<'access.approval.decided'>) {
    return this.pricing.onApprovalDecided(event);
  }

  onEnforcementRecordedFromTrust(event: EventPayload<'trust.enforcement.recorded'>, envelope?: Pick<EventEnvelope, 'actor'>) {
    return this.enforcement.onEnforcementRecorded(event, envelope?.actor);
  }

  onEnforcementReversedFromTrust(event: EventPayload<'trust.enforcement.reversed'>, envelope?: Pick<EventEnvelope, 'actor' | 'id'>) {
    return this.enforcement.onEnforcementReversed(event, envelope?.id, envelope?.actor);
  }

  onCampaignStartedFromPromotions(event: EventPayload<'promotions.campaign.started'>) {
    return this.enforcement.onCampaignStarted(event);
  }

  onCampaignEndedFromPromotions(event: EventPayload<'promotions.campaign.ended'>) {
    return this.enforcement.onCampaignEnded(event);
  }

  /* ---------------- jobs */

  applyPriceSchedule() {
    return this.pricing.applySchedule();
  }

  recomputeFeatured() {
    return this.featured.recompute();
  }

  reevaluateEligibility() {
    return this.featured.reevaluate();
  }

  verifyCompareAt() {
    return this.pricing.verifyCompareAtJob();
  }

  expireBulkPreviews() {
    return this.bulk.expire();
  }

  parseBulkFile() {
    return this.bulk.parsePending();
  }
}
