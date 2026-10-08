import { notImplemented } from '../../kernel/errors/index.js';
import type { EventPayload } from '../../kernel/events/index.js';
import type { ModuleContext } from '../../kernel/module-system/index.js';
import type * as common from '../../spec/common.js';
import type * as identity from '../../spec/identity.js';
import type { PromotionsPublicApi, Redemption, OfferPromotion, PromoBanner, CouponCard, DealProduct, FlashSaleBlock, DealsPage, AccountCoupons, PublicCampaign, CartEvaluationInput, CartEvaluation, RedemptionReservation, FundingSplit, RefundShare } from '../../spec/promotions.js';
import type { PromotionsRepository } from './ports.js';

export interface PromotionsServiceDeps {
  repo: PromotionsRepository;
  ctx: ModuleContext<'promotions'>;
}

/**
 * Promotions use cases. Depends only on ports, the event bus, the clock and other modules' public APIs.
 * Each method maps to a publicApi function, a consumed event or a job in docs/api/spec/modules/promotions.json.
 */
export class PromotionsService implements PromotionsPublicApi {
  readonly #deps: PromotionsServiceDeps;

  constructor(deps: PromotionsServiceDeps) {
    this.#deps = deps;
  }

  protected get deps(): PromotionsServiceDeps {
    return this.#deps;
  }

  /* ---------------- public API (in-process) */

  /** Current markdown or flash price, was price, badges, purchase limit and countdown per offer. Used for product cards, the purchase box and cart lines so prices match everywhere (plan ch. 15: consistent across product page, cart, checkout and confirmation). */
  async priceOffers(offerIds: string[], ctx: { customerId?: string, at?: string }): Promise<OfferPromotion[]> {
    throw notImplemented('promotions.priceOffers');
  }

  /** Runs eligibility, stacking, limits and budgets for a cart or checkout quote. Returns per-line discounts with the funding split, free-shipping packages, applied codes with the items they cover and rejected codes with a reason the customer can read. Pure read: nothing is reserved. */
  async evaluateCart(input: CartEvaluationInput): Promise<CartEvaluation> {
    throw notImplemented('promotions.evaluateCart');
  }

  /** Holds budget, usage counts and flash deal stock for a quote while payment runs. Fails with BUDGET_EXHAUSTED, USAGE_LIMIT_REACHED or DEAL_SOLD_OUT so checkout can show the revised total before the customer commits (plan ch. 6). */
  async reserveRedemption(evaluationId: string, idempotencyKey: string): Promise<RedemptionReservation> {
    throw notImplemented('promotions.reserveRedemption');
  }

  /** Binds a reservation to the placed order (line id → order item id). Also triggered by orders.order.placed. */
  async commitRedemption(reservationId: string, orderId: string, orderItemIds: Record<string, string>): Promise<Redemption[]> {
    throw notImplemented('promotions.commitRedemption');
  }

  /** Releases held budget, usage and deal stock when payment fails or the quote expires. */
  async releaseRedemption(reservationId: string): Promise<void> {
    throw notImplemented('promotions.releaseRedemption');
  }

  /** Discount allocations of one order item with platform and seller parts. Finance charges commission on the price after the seller-funded part only and credits the platform-funded part to seller proceeds. */
  async fundingSplitFor(orderItemId: string): Promise<FundingSplit> {
    throw notImplemented('promotions.fundingSplitFor');
  }

  /** Coupon share to deduct when refunding part of an order (coupons are split across items by value). Used to cap refunds at the remaining refundable amount. */
  async refundShare(orderItemId: string, quantity: number): Promise<RefundShare> {
    throw notImplemented('promotions.refundShare');
  }

  /** Name, period, terms and status for campaign pages, banners and ads. */
  async getPublicCampaign(campaignId: string): Promise<PublicCampaign | null> {
    throw notImplemented('promotions.getPublicCampaign');
  }

  /** False when ended, paused, out of budget or sold out. Advertising stops linked ads; content hides teasers. */
  async isCampaignActive(campaignId: string): Promise<{ active: boolean, reason?: string }> {
    throw notImplemented('promotions.isCampaignActive');
  }

  /** Flash deals for the homepage Deals section. */
  async liveDeals(opts: { limit: number }): Promise<FlashSaleBlock[]> {
    throw notImplemented('promotions.liveDeals');
  }

  /** Honest 'was' price: delegates to offers.lowestPrice(offerId, referencePriceDays, campaignStart or now) and returns null when offers has no history for the window. No price history is kept in promotions. */
  async referencePrice(offerId: string): Promise<common.Money | null> {
    throw notImplemented('promotions.referencePrice');
  }

  /** Deals page data in one call: tab counts, live flash sales, clippable coupons (clipped state for the customer), the first clearance batch, upcoming events with reminder state, the combination rules and serverTime for countdowns. Same data as GET /api/store/promotions/deals. */
  async getDealsPage(ctx: { customerId?: string, at?: string }): Promise<DealsPage> {
    throw notImplemented('promotions.getDealsPage');
  }

  /** Clearance products page by page (GET /deals/clearance). */
  async listClearance(paging: common.PageInput): Promise<common.Page<DealProduct>> {
    throw notImplemented('promotions.listClearance');
  }

  /** One flash sale with live claimed meters, deal stock and countdown (GET /flash-sales/{campaignId}). */
  async getFlashSale(campaignId: string): Promise<FlashSaleBlock | null> {
    throw notImplemented('promotions.getFlashSale');
  }

  /** Clippable coupons that cover each product, with the customer's clipped state (the coupons part of GET /products/{productId}). Batched per request. */
  async couponsForProduct(productIds: string[], ctx: { customerId?: string }): Promise<Record<string, CouponCard[]>> {
    throw notImplemented('promotions.couponsForProduct');
  }

  /** My coupons: available and clipped, used and expired, with the rules line (GET /coupons). */
  async couponsForCustomer(customerId: string): Promise<AccountCoupons> {
    throw notImplemented('promotions.couponsForCustomer');
  }

  /** Live seller-funded promotions for the storefront (automatic or by code), soonest ending first. Same eligibility and period rules as priceOffers; platform campaigns are not included. */
  async activeSellerPromotions(sellerIds: string[], ctx: { customerId?: string, at?: string }): Promise<Record<string, PromoBanner[]>> {
    throw notImplemented('promotions.activeSellerPromotions');
  }

  /** Export rows for reports dataset promotions.admin.campaigns (campaign results) */
  async exportRows(dataset: string, filters: unknown, principal: identity.Principal, cursor?: string): Promise<{ rows: unknown[], nextCursor?: string }> {
    throw notImplemented('promotions.exportRows');
  }

  /* ---------------- events consumed */

  /** orders.order.placed: Commit reservations referenced by the order (fallback when commitRedemption was not called) */
  async onOrderPlacedFromOrders(event: EventPayload<"orders.order.placed">): Promise<void> {
    void event;
    throw notImplemented('promotions consumer of orders.order.placed');
  }

  /** orders.item.cancelled: Reverse the item's allocations; restore usage and deal stock when cancelled before dispatch */
  async onItemCancelledFromOrders(event: EventPayload<"orders.item.cancelled">): Promise<void> {
    void event;
    throw notImplemented('promotions consumer of orders.item.cancelled');
  }

  /** returns.refund.approved: Partially reverse the item's allocations by the refunded quantity; count the return in campaign results */
  async onRefundApprovedFromReturns(event: EventPayload<"returns.refund.approved">): Promise<void> {
    void event;
    throw notImplemented('promotions consumer of returns.refund.approved');
  }

  /** payments.payment.failed: Release reservations of the failed quote */
  async onPaymentFailedFromPayments(event: EventPayload<"payments.payment.failed">): Promise<void> {
    void event;
    throw notImplemented('promotions consumer of payments.payment.failed');
  }

  /** offers.offer.price_changed: Flag participations whose seller raised the price during the campaign (the was price itself is read from offers.lowestPrice) */
  async onOfferPriceChangedFromOffers(event: EventPayload<"offers.offer.price_changed">): Promise<void> {
    void event;
    throw notImplemented('promotions consumer of offers.offer.price_changed');
  }

  /** offers.offer.status_changed: Rebuild eligible offers; remove deactivated offers from flash sales */
  async onOfferStatusChangedFromOffers(event: EventPayload<"offers.offer.status_changed">): Promise<void> {
    void event;
    throw notImplemented('promotions consumer of offers.offer.status_changed');
  }

  /** inventory.stock.changed: Cap remaining flash deal stock at available stock; re-check participation stock rules */
  async onStockChangedFromInventory(event: EventPayload<"inventory.stock.changed">): Promise<void> {
    void event;
    throw notImplemented('promotions consumer of inventory.stock.changed');
  }

  /** catalog.product.publication_changed: Exclude hidden or suspended products from live campaigns */
  async onProductPublicationChangedFromCatalog(event: EventPayload<"catalog.product.publication_changed">): Promise<void> {
    void event;
    throw notImplemented('promotions consumer of catalog.product.publication_changed');
  }

  /** catalog.product.merged: Retarget campaign targets and coupon product scopes from the duplicate to the kept product (variants mapped through newVariantId / intoVariantId); redemptions already made keep their order snapshots */
  async onProductMergedFromCatalog(event: EventPayload<"catalog.product.merged">): Promise<void> {
    void event;
    throw notImplemented('promotions consumer of catalog.product.merged');
  }

  /** sellers.seller.restricted: Remove the seller's offers from campaigns where the restriction covers new sales (reason recorded) */
  async onSellerRestrictedFromSellers(event: EventPayload<"sellers.seller.restricted">): Promise<void> {
    void event;
    throw notImplemented('promotions consumer of sellers.seller.restricted');
  }

  /** sellers.seller.suspended: Remove the seller from all upcoming and live campaigns; pause its own discounts */
  async onSellerSuspendedFromSellers(event: EventPayload<"sellers.seller.suspended">): Promise<void> {
    void event;
    throw notImplemented('promotions consumer of sellers.seller.suspended');
  }

  /** access.approval.decided: Complete or reject a pending funding confirmation */
  async onApprovalDecidedFromAccess(event: EventPayload<"access.approval.decided">): Promise<void> {
    void event;
    throw notImplemented('promotions consumer of access.approval.decided');
  }

  /* ---------------- jobs */

  /** Job promotions.start-due (every 1 min): Scheduled campaigns whose startsAt has passed → live; publish promotions.campaign.started */
  async startDue(): Promise<void> {
    throw notImplemented('job promotions.start-due');
  }

  /** Job promotions.end-due (every 1 min): Live or paused campaigns past endsAt → ended (period_over); expire flash items */
  async endDue(): Promise<void> {
    throw notImplemented('job promotions.end-due');
  }

  /** Job promotions.release-expired-reservations (every 1 min): Release reservations past expiresAt and return deal stock and usage */
  async releaseExpiredReservations(): Promise<void> {
    throw notImplemented('job promotions.release-expired-reservations');
  }

  /** Job promotions.invitation-deadlines (hourly): Remind sellers 24 h before respondBy; expire unanswered invitations */
  async invitationDeadlines(): Promise<void> {
    throw notImplemented('job promotions.invitation-deadlines');
  }

  /** Job promotions.refresh-eligible-offers (every 15 min): Rebuild eligible_offers for scheduled and live campaigns (stock, rating, dispatch, price-increase rules) */
  async refreshEligibleOffers(): Promise<void> {
    throw notImplemented('job promotions.refresh-eligible-offers');
  }

  /** Job promotions.results-rollup (every 15 min): Roll up campaign_results_daily from redemptions, orders and returns */
  async resultsRollup(): Promise<void> {
    throw notImplemented('job promotions.results-rollup');
  }

  /** Job promotions.event-reminders (every 5 min): Send reminders for events that start within the next 15 minutes (promotional preference permitting) */
  async eventReminders(): Promise<void> {
    throw notImplemented('job promotions.event-reminders');
  }
}
