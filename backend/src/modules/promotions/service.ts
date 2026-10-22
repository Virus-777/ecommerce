import { AppError } from '../../kernel/errors/index.js';
import type { EventPayload } from '../../kernel/events/index.js';
import type * as common from '../../spec/common.js';
import type * as identity from '../../spec/identity.js';
import type { AccountCoupons, CartEvaluation, CartEvaluationInput, CouponCard, DealProduct, DealsPage, FlashSaleBlock, FundingSplit, IssuedCoupon, OfferPromotion, PromoBanner, PromotionsPublicApi, PublicCampaign, Redemption, RedemptionReservation, RefundShare } from '../../spec/promotions.js';
import { CampaignsPart } from './service/campaigns.js';
import { CheckoutPart } from './service/checkout.js';
import { Core, type PromotionsServiceDeps } from './service/core.js';
import { OpsPart } from './service/ops.js';
import { ParticipationPart } from './service/participation.js';
import { SellerDiscountsPart } from './service/seller-discounts.js';
import { StorefrontPart } from './service/storefront.js';

export type { PromotionsServiceDeps };

/**
 * Promotions use cases. Depends only on its repository, the event bus, the clock and other modules' public APIs.
 * The work is split by area (service/*.ts); this class is the module's public API, its event consumers and jobs.
 */
export class PromotionsService implements PromotionsPublicApi {
  readonly core: Core;
  readonly campaigns: CampaignsPart;
  readonly participation: ParticipationPart;
  readonly sellerDiscounts: SellerDiscountsPart;
  readonly storefront: StorefrontPart;
  readonly checkout: CheckoutPart;
  readonly ops: OpsPart;

  constructor(deps: PromotionsServiceDeps) {
    this.core = new Core(deps);
    this.campaigns = new CampaignsPart(this.core);
    this.participation = new ParticipationPart(this.core);
    this.sellerDiscounts = new SellerDiscountsPart(this.core);
    this.storefront = new StorefrontPart(this.core);
    this.checkout = new CheckoutPart(this.core);
    this.ops = new OpsPart(this.core);
    this.core.parts = { campaigns: this.campaigns, participation: this.participation, sellerDiscounts: this.sellerDiscounts, storefront: this.storefront, checkout: this.checkout, ops: this.ops };
  }

  /* ---------------- public API (in-process) */

  priceOffers(offerIds: string[], ctx: { customerId?: string; at?: string }): Promise<OfferPromotion[]> {
    return this.storefront.priceOffers(offerIds, ctx);
  }

  evaluateCart(input: CartEvaluationInput): Promise<CartEvaluation> {
    return this.checkout.evaluateCart(input);
  }

  reserveRedemption(evaluationId: string, idempotencyKey: string): Promise<RedemptionReservation> {
    return this.checkout.reserve(evaluationId, idempotencyKey);
  }

  commitRedemption(reservationId: string, orderId: string, orderItemIds: Record<string, string>): Promise<Redemption[]> {
    return this.checkout.commit(reservationId, orderId, orderItemIds);
  }

  releaseRedemption(reservationId: string): Promise<void> {
    return this.checkout.release(reservationId);
  }

  fundingSplitFor(orderItemId: string): Promise<FundingSplit> {
    return this.checkout.fundingSplitFor(orderItemId);
  }

  refundShare(orderItemId: string, quantity: number): Promise<RefundShare> {
    return this.checkout.refundShare(orderItemId, quantity);
  }

  getPublicCampaign(campaignId: string): Promise<PublicCampaign | null> {
    return this.storefront.getPublicCampaign(campaignId);
  }

  isCampaignActive(campaignId: string): Promise<{ active: boolean; reason?: string }> {
    return this.storefront.isCampaignActive(campaignId);
  }

  liveDeals(opts: { limit: number; campaignId?: string }): Promise<FlashSaleBlock[]> {
    return this.storefront.liveDeals(opts);
  }

  referencePrice(offerId: string): Promise<common.Money | null> {
    return this.storefront.referencePrice(offerId);
  }

  getDealsPage(ctx: { customerId?: string; at?: string }): Promise<DealsPage> {
    return this.storefront.getDealsPage(ctx);
  }

  listClearance(paging: common.PageInput): Promise<common.Page<DealProduct>> {
    return this.storefront.listClearance(paging);
  }

  getFlashSale(campaignId: string): Promise<FlashSaleBlock | null> {
    return this.storefront.getFlashSale(campaignId);
  }

  couponsForProduct(productIds: string[], ctx: { customerId?: string }): Promise<Record<string, CouponCard[]>> {
    return this.storefront.couponsForProduct(productIds, ctx);
  }

  issueCode(campaignId: string, customerId: string, idempotencyKey: string): Promise<IssuedCoupon> {
    return this.campaigns.issueCode(campaignId, customerId, idempotencyKey);
  }

  couponsForCustomer(customerId: string): Promise<AccountCoupons> {
    return this.storefront.couponsForCustomer(customerId);
  }

  activeSellerPromotions(sellerIds: string[], ctx: { customerId?: string; at?: string }): Promise<Record<string, PromoBanner[]>> {
    return this.storefront.activeSellerPromotions(sellerIds, ctx);
  }

  async exportRows(dataset: string, filters: unknown, principal: identity.Principal, cursor?: string): Promise<{ rows: unknown[]; nextCursor?: string }> {
    if (principal.kind !== 'staff') throw new AppError('FORBIDDEN', 'Campaign results are for staff');
    return this.campaigns.exportRows(dataset, filters, cursor);
  }

  /* ---------------- events consumed */

  onOrderPlacedFromOrders(event: EventPayload<'orders.order.placed'>) {
    return this.checkout.onOrderPlaced(event);
  }

  onItemCancelledFromOrders(event: EventPayload<'orders.item.cancelled'>) {
    return this.checkout.onItemCancelled(event);
  }

  /** orders.item.split: split the item's redemption lines between the original and the new order item */
  onItemSplitFromOrders(event: EventPayload<'orders.item.split'>) {
    return this.checkout.onItemSplit(event);
  }

  onRefundApprovedFromReturns(event: EventPayload<'returns.refund.approved'>) {
    return this.checkout.onRefundApproved(event);
  }

  onPaymentFailedFromPayments(event: EventPayload<'payments.payment.failed'>) {
    return this.checkout.onPaymentFailed(event);
  }

  onOfferPriceChangedFromOffers(event: EventPayload<'offers.offer.price_changed'>) {
    return this.ops.onOfferPriceChanged(event);
  }

  onOfferStatusChangedFromOffers(event: EventPayload<'offers.offer.status_changed'>) {
    return this.ops.onOfferStatusChanged(event);
  }

  onStockChangedFromInventory(event: EventPayload<'inventory.stock.changed'>) {
    return this.ops.onStockChanged(event);
  }

  onProductPublicationChangedFromCatalog(event: EventPayload<'catalog.product.publication_changed'>) {
    return this.ops.onProductPublicationChanged(event);
  }

  onProductMergedFromCatalog(event: EventPayload<'catalog.product.merged'>) {
    return this.ops.onProductMerged(event);
  }

  onSellerRestrictedFromSellers(event: EventPayload<'sellers.seller.restricted'>) {
    return this.ops.onSellerRestricted(event);
  }

  onSellerSuspendedFromSellers(event: EventPayload<'sellers.seller.suspended'>) {
    return this.ops.onSellerSuspended(event);
  }

  onApprovalDecidedFromAccess(event: EventPayload<'access.approval.decided'>) {
    return this.campaigns.onApprovalDecided(event);
  }

  /* ---------------- jobs */

  startDue() {
    return this.ops.startDue();
  }

  endDue() {
    return this.ops.endDue();
  }

  releaseExpiredReservations() {
    return this.checkout.releaseExpired();
  }

  invitationDeadlines() {
    return this.participation.deadlines();
  }

  refreshEligibleOffers() {
    return this.ops.refreshEligible();
  }

  resultsRollup() {
    return this.ops.resultsRollup();
  }

  eventReminders() {
    return this.storefront.sendReminders();
  }
}
