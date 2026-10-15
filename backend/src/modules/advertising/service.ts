import type { EventPayload } from '../../kernel/events/index.js';
import { isUuid } from '../../kernel/lib/ids.js';
import type * as common from '../../spec/common.js';
import type * as identity from '../../spec/identity.js';
import type { AdCampaignSummary, AdsDashboard, AdvertisingPublicApi, CampaignDayPerformance, SponsoredProductSlot } from '../../spec/advertising.js';
import type { PageTypeName } from './domain/rules.js';
import { placementSeedRows, rulesSeedRow } from './domain/seed.js';
import { BillingPart } from './service/billing.js';
import { CampaignsPart } from './service/campaigns.js';
import { Core, type AdvertisingServiceDeps } from './service/core.js';
import { CreativesPart } from './service/creatives.js';
import { OpsPart } from './service/ops.js';
import { ReportsPart } from './service/reports.js';
import { SellerPart } from './service/sellers.js';
import { ServingPart } from './service/serving.js';
import { SetupPart } from './service/setup.js';
import { ViewsPart } from './service/views.js';

export type { AdvertisingServiceDeps };

/**
 * Advertising use cases. Depends only on its repository, the event bus, the clock and other modules' public APIs.
 * The work is split by area (service/*.ts); this class is the module's public API, its event consumers and jobs.
 */
export class AdvertisingService implements AdvertisingPublicApi {
  readonly core: Core;
  readonly views: ViewsPart;
  readonly campaigns: CampaignsPart;
  readonly creatives: CreativesPart;
  readonly setup: SetupPart;
  readonly serving: ServingPart;
  readonly sellers: SellerPart;
  readonly billing: BillingPart;
  readonly reports: ReportsPart;
  readonly ops: OpsPart;

  constructor(deps: AdvertisingServiceDeps) {
    this.core = new Core(deps);
    this.views = new ViewsPart(this.core);
    this.campaigns = new CampaignsPart(this.core);
    this.creatives = new CreativesPart(this.core);
    this.setup = new SetupPart(this.core);
    this.serving = new ServingPart(this.core);
    this.sellers = new SellerPart(this.core);
    this.billing = new BillingPart(this.core);
    this.reports = new ReportsPart(this.core);
    this.ops = new OpsPart(this.core);
    this.core.parts = { views: this.views, campaigns: this.campaigns, creatives: this.creatives, setup: this.setup, serving: this.serving, sellers: this.sellers, billing: this.billing, reports: this.reports, ops: this.ops };
  }

  /** Install seed on boot: the launch placements and global rules version 1, each only when absent (domain/seed.ts) */
  async seed(): Promise<void> {
    for (const row of placementSeedRows()) await this.core.repo.insertIfAbsent('placements', row);
    await this.core.repo.insertIfAbsent('global_rules', rulesSeedRow());
  }

  /* ---------------- public API (in-process) */

  /** Export rows for the reports dataset advertising.admin.campaigns (G72) */
  exportRows(dataset: string, filters: unknown, principal: identity.Principal, cursor?: string): Promise<{ rows: unknown[]; nextCursor?: string }> {
    return this.reports.exportRows(dataset, filters, principal, cursor);
  }

  /** Sponsored product cards and their positions for a results list (max per page from the placement; relevance first, then priority). Only eligible, in-stock offers are returned. */
  sponsoredForResults(ctx: { page: PageTypeName; query?: string; categoryId?: string; productId?: string; visitorId: string; sessionId: string; device: string; organicOfferIds: string[]; personalizationAllowed: boolean; customerId?: string }): Promise<SponsoredProductSlot[]> {
    return this.serving.sponsoredForResults(ctx);
  }

  /** Ad positions on a page, so content can show them as locked markers in homepage sections. */
  adPositionsFor(page: PageTypeName): Promise<{ placementKey: string; name: string; enabled: boolean }[]> {
    return this.serving.adPositionsFor(page);
  }

  /** Ads linked to a promotion (shown on the promotion detail). */
  async campaignsForPromotion(promotionId: string): Promise<AdCampaignSummary[]> {
    if (!isUuid(promotionId)) return [];
    const rows = await this.core.repo.find('campaigns', { linked_promotion_id: promotionId }, { orderBy: [['created_at', 'desc']], limit: 200 });
    return this.views.summaries(rows);
  }

  /** True for checkout, payment results, order tracking and returns; used by front-end shells to skip the serve call. */
  isAdBlockedPage(page: PageTypeName): Promise<boolean> {
    return this.serving.isAdBlockedPage(page);
  }

  /** Displays, clicks, dismissals, attributed purchases and spend per campaign and day, from the daily_stats read model (days still open are marked partial). */
  dailyPerformance(range: common.DateRange, filter?: { campaignId?: string; sellerId?: string }): Promise<CampaignDayPerformance[]> {
    return this.reports.dailyPerformance(range, filter);
  }

  /** Read-only advertising summary for the Admin dashboard tile. Records nothing. */
  async dashboardSummary(opts?: { listLimit?: number }): Promise<AdsDashboard> {
    const { liveList: _live, ...dash } = await this.reports.dashboard({ listLimit: opts?.listLimit ?? 3 });
    return dash;
  }

  /* ---------------- events consumed */

  onCampaignEndedFromPromotions(event: EventPayload<'promotions.campaign.ended'>) {
    return this.ops.onPromotionEnded(event);
  }

  onCampaignPausedFromPromotions(event: EventPayload<'promotions.campaign.paused'>) {
    return this.ops.onPromotionPaused(event);
  }

  onCampaignResumedFromPromotions(event: EventPayload<'promotions.campaign.resumed'>) {
    return this.ops.onPromotionResumed(event);
  }

  onOfferStatusChangedFromOffers(event: EventPayload<'offers.offer.status_changed'>) {
    return this.ops.onOfferStatusChanged(event);
  }

  onStockLowFromInventory(event: EventPayload<'inventory.stock.low'>) {
    return this.ops.onStockLow(event);
  }

  onStockChangedFromInventory(event: EventPayload<'inventory.stock.changed'>) {
    return this.ops.onStockChanged(event);
  }

  onProductPublicationChangedFromCatalog(event: EventPayload<'catalog.product.publication_changed'>) {
    return this.ops.onProductPublicationChanged(event);
  }

  onSellerRestrictedFromSellers(event: EventPayload<'sellers.seller.restricted'>) {
    return this.ops.onSellerRestricted(event);
  }

  onSellerSuspendedFromSellers(event: EventPayload<'sellers.seller.suspended'>) {
    return this.ops.onSellerSuspended(event);
  }

  onEnforcementRecordedFromTrust(event: EventPayload<'trust.enforcement.recorded'>) {
    return this.ops.onEnforcementRecorded(event);
  }

  onEnforcementReversedFromTrust(event: EventPayload<'trust.enforcement.reversed'>, eventId?: string) {
    return this.ops.onEnforcementReversed(event, eventId);
  }

  onOrderPlacedFromOrders(event: EventPayload<'orders.order.placed'>) {
    return this.ops.onOrderPlaced(event);
  }

  onItemCancelledFromOrders(event: EventPayload<'orders.item.cancelled'>) {
    return this.ops.onItemCancelled(event);
  }

  onPagePublishedFromContent(event: EventPayload<'content.page.published'>) {
    return this.ops.onPagePublished(event);
  }

  onApprovalDecidedFromAccess(event: EventPayload<'access.approval.decided'>, eventId?: string) {
    return this.ops.onApprovalDecided(event, eventId);
  }

  onProductMergedFromCatalog(event: EventPayload<'catalog.product.merged'>) {
    return this.ops.onProductMerged(event);
  }

  /* ---------------- jobs */

  startDue() {
    return this.ops.startDue();
  }

  finishDue() {
    return this.ops.finishDue();
  }

  availabilitySweep() {
    return this.ops.availabilitySweep();
  }

  linkCheck() {
    return this.ops.linkCheck();
  }

  statsRollup() {
    return this.reports.rollup();
  }

  accrueCharges() {
    return this.billing.accrueAll();
  }

  postCharges() {
    return this.billing.postAll();
  }

  expireFrequencyState() {
    return this.ops.expireFrequencyState();
  }

  endingSoonNotice() {
    return this.ops.endingSoonNotice();
  }
}
