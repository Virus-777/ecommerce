import { notImplemented } from '../../kernel/errors/index.js';
import type { EventPayload } from '../../kernel/events/index.js';
import type { ModuleContext } from '../../kernel/module-system/index.js';
import type * as common from '../../spec/common.js';
import type { AdvertisingPublicApi, PageType, AdCampaignSummary, SponsoredProductSlot, CampaignDayPerformance, AdsDashboard } from '../../spec/advertising.js';
import type { AdvertisingRepository } from './ports.js';

export interface AdvertisingServiceDeps {
  repo: AdvertisingRepository;
  ctx: ModuleContext<'advertising'>;
}

/**
 * Advertising use cases. Depends only on ports, the event bus, the clock and other modules' public APIs.
 * Each method maps to a publicApi function, a consumed event or a job in docs/api/spec/modules/advertising.json.
 */
export class AdvertisingService implements AdvertisingPublicApi {
  readonly #deps: AdvertisingServiceDeps;

  constructor(deps: AdvertisingServiceDeps) {
    this.#deps = deps;
  }

  protected get deps(): AdvertisingServiceDeps {
    return this.#deps;
  }

  /* ---------------- public API (in-process) */

  /** Sponsored product cards and their positions for a results list (max per page from the placement; relevance first, then priority). Only eligible, in-stock offers are returned. */
  async sponsoredForResults(ctx: { page: PageType, query?: string, categoryId?: string, productId?: string, visitorId: string, sessionId: string, device: string, organicOfferIds: string[] }): Promise<SponsoredProductSlot[]> {
    throw notImplemented('advertising.sponsoredForResults');
  }

  /** Ad positions on a page, so content can show them as locked markers in homepage sections. */
  async adPositionsFor(page: PageType): Promise<{ placementKey: string, name: string, enabled: boolean }[]> {
    throw notImplemented('advertising.adPositionsFor');
  }

  /** Ads linked to a promotion (shown on the promotion detail). */
  async campaignsForPromotion(promotionId: string): Promise<AdCampaignSummary[]> {
    throw notImplemented('advertising.campaignsForPromotion');
  }

  /** True for checkout, payment results, order tracking and returns; used by front-end shells to skip the serve call. */
  async isAdBlockedPage(page: PageType): Promise<boolean> {
    throw notImplemented('advertising.isAdBlockedPage');
  }

  /** Displays, clicks, dismissals, attributed purchases and spend per campaign and day, from the daily_stats read model (days still open are marked partial). */
  async dailyPerformance(range: common.DateRange, filter?: { campaignId?: string, sellerId?: string }): Promise<CampaignDayPerformance[]> {
    throw notImplemented('advertising.dailyPerformance');
  }

  /** Read-only advertising summary for the Admin dashboard tile: live now (own and paid), starting in 7 days, ending soon, waiting approval, spend this month and short campaign lists. Records nothing; ad serving stays on POST /api/store/advertising/decisions. */
  async dashboardSummary(opts?: { listLimit?: number }): Promise<AdsDashboard> {
    throw notImplemented('advertising.dashboardSummary');
  }

  /* ---------------- events consumed */

  /** promotions.campaign.ended: Finish linked ads with stopWithPromotion (reason promotion_ended) */
  async onCampaignEndedFromPromotions(event: EventPayload<"promotions.campaign.ended">): Promise<void> {
    void event;
    throw notImplemented('advertising consumer of promotions.campaign.ended');
  }

  /** promotions.campaign.paused: Pause linked ads until the promotion resumes */
  async onCampaignPausedFromPromotions(event: EventPayload<"promotions.campaign.paused">): Promise<void> {
    void event;
    throw notImplemented('advertising consumer of promotions.campaign.paused');
  }

  /** promotions.campaign.resumed: Resume ads paused because of the promotion */
  async onCampaignResumedFromPromotions(event: EventPayload<"promotions.campaign.resumed">): Promise<void> {
    void event;
    throw notImplemented('advertising consumer of promotions.campaign.resumed');
  }

  /** offers.offer.status_changed: Pause ads whose promoted offer is no longer active (offer_unavailable) */
  async onOfferStatusChangedFromOffers(event: EventPayload<"offers.offer.status_changed">): Promise<void> {
    void event;
    throw notImplemented('advertising consumer of offers.offer.status_changed');
  }

  /** inventory.stock.low: Pause sponsored ads below the minimum stock threshold */
  async onStockLowFromInventory(event: EventPayload<"inventory.stock.low">): Promise<void> {
    void event;
    throw notImplemented('advertising consumer of inventory.stock.low');
  }

  /** inventory.stock.changed: Resume system-paused ads when stock returns above the threshold */
  async onStockChangedFromInventory(event: EventPayload<"inventory.stock.changed">): Promise<void> {
    void event;
    throw notImplemented('advertising consumer of inventory.stock.changed');
  }

  /** catalog.product.publication_changed: Pause ads promoting hidden or suspended products */
  async onProductPublicationChangedFromCatalog(event: EventPayload<"catalog.product.publication_changed">): Promise<void> {
    void event;
    throw notImplemented('advertising consumer of catalog.product.publication_changed');
  }

  /** sellers.seller.restricted: Pause the seller's ads when the restriction covers new sales or advertising */
  async onSellerRestrictedFromSellers(event: EventPayload<"sellers.seller.restricted">): Promise<void> {
    void event;
    throw notImplemented('advertising consumer of sellers.seller.restricted');
  }

  /** sellers.seller.suspended: Finish the seller's ads (seller_restricted); charges only for delivery so far */
  async onSellerSuspendedFromSellers(event: EventPayload<"sellers.seller.suspended">): Promise<void> {
    void event;
    throw notImplemented('advertising consumer of sellers.seller.suspended');
  }

  /** trust.enforcement.recorded: Revoke creatives and reject requests that promote the enforced offer or product */
  async onEnforcementRecordedFromTrust(event: EventPayload<"trust.enforcement.recorded">): Promise<void> {
    void event;
    throw notImplemented('advertising consumer of trust.enforcement.recorded');
  }

  /** orders.order.placed: Attribute the order to the visitor's last ad click within the attribution period */
  async onOrderPlacedFromOrders(event: EventPayload<"orders.order.placed">): Promise<void> {
    void event;
    throw notImplemented('advertising consumer of orders.order.placed');
  }

  /** orders.item.cancelled: Reduce attributed sales for cancelled items */
  async onItemCancelledFromOrders(event: EventPayload<"orders.item.cancelled">): Promise<void> {
    void event;
    throw notImplemented('advertising consumer of orders.item.cancelled');
  }

  /** content.page.published: Re-run link checks for creatives pointing at the page */
  async onPagePublishedFromContent(event: EventPayload<"content.page.published">): Promise<void> {
    void event;
    throw notImplemented('advertising consumer of content.page.published');
  }

  /** access.approval.decided: Apply an approved global rules change at its effective time */
  async onApprovalDecidedFromAccess(event: EventPayload<"access.approval.decided">): Promise<void> {
    void event;
    throw notImplemented('advertising consumer of access.approval.decided');
  }

  /** catalog.product.merged: Repoint ads, ad requests and creatives that promote the duplicate product (or its variants, mapped through newVariantId / intoVariantId) to the kept product; delivery, spend and attribution history stay on the ad */
  async onProductMergedFromCatalog(event: EventPayload<"catalog.product.merged">): Promise<void> {
    void event;
    throw notImplemented('advertising consumer of catalog.product.merged');
  }

  /* ---------------- jobs */

  /** Job advertising.start-due (every 1 min): Scheduled campaigns past startsAt → live */
  async startDue(): Promise<void> {
    throw notImplemented('job advertising.start-due');
  }

  /** Job advertising.finish-due (every 1 min): Live or paused campaigns past endsAt → finished; finish when delivery cap reached */
  async finishDue(): Promise<void> {
    throw notImplemented('job advertising.finish-due');
  }

  /** Job advertising.availability-sweep (every 5 min): Pause ads for unavailable or low-stock promoted offers and inactive linked promotions; resume when available again */
  async availabilitySweep(): Promise<void> {
    throw notImplemented('job advertising.availability-sweep');
  }

  /** Job advertising.link-check (hourly): Re-check destination links and promoted-offer availability for approved and live creatives */
  async linkCheck(): Promise<void> {
    throw notImplemented('job advertising.link-check');
  }

  /** Job advertising.stats-rollup (every 5 min): Aggregate ad_events into daily_stats */
  async statsRollup(): Promise<void> {
    throw notImplemented('job advertising.stats-rollup');
  }

  /** Job advertising.accrue-charges (every 15 min): Accrue billable clicks/displays and fixed daily fees, capped at daily and total limits; stop delivery at the limit */
  async accrueCharges(): Promise<void> {
    throw notImplemented('job advertising.accrue-charges');
  }

  /** Job advertising.post-charges (daily 02:00 market time): Post the previous day's charges to finance (advertising.charge.posted) */
  async postCharges(): Promise<void> {
    throw notImplemented('job advertising.post-charges');
  }

  /** Job advertising.expire-frequency-state (hourly): Delete frequency and suppression rows past their window */
  async expireFrequencyState(): Promise<void> {
    throw notImplemented('job advertising.expire-frequency-state');
  }

  /** Job advertising.ending-soon-notice (daily 08:00 market time): Notify owners of campaigns ending within 3 days to finish or renew deliberately */
  async endingSoonNotice(): Promise<void> {
    throw notImplemented('job advertising.ending-soon-notice');
  }
}
