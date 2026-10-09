import type { EventPayload } from '../../kernel/events/index.js';
import { toPageRequest } from '../../kernel/lib/pagination.js';
import type * as common from '../../spec/common.js';
import type { ProductReview, Question, RatingSummary, ReviewsPublicApi, SellerFeedback, SellerFeedbackSummary } from '../../spec/reviews.js';
import { sellerKey, OFFICIAL_STORE_ID } from './domain/rules.js';
import { Core, type ReviewsServiceDeps } from './service/core.js';
import { FeedbackPart } from './service/feedback.js';
import { ModerationPart } from './service/moderation.js';
import { QaPart } from './service/qa.js';
import { ResponsesPart } from './service/responses.js';
import { ReviewsPart } from './service/reviews.js';
import { SummariesPart } from './service/summaries.js';
import { Views } from './service/views.js';

export type { ReviewsServiceDeps };

/**
 * Reviews use cases. Depends only on ports, the event bus, the clock and other modules' public APIs.
 * The work is split by area (service/*.ts); this class is the module's public API, its event consumers and jobs.
 */
export class ReviewsService implements ReviewsPublicApi {
  readonly core: Core;
  readonly views: Views;
  readonly moderation: ModerationPart;
  readonly reviews: ReviewsPart;
  readonly feedback: FeedbackPart;
  readonly qa: QaPart;
  readonly responses: ResponsesPart;
  readonly summaries: SummariesPart;

  constructor(deps: ReviewsServiceDeps) {
    this.core = new Core(deps);
    this.views = new Views(this.core);
    this.moderation = new ModerationPart(this.core, this.views);
    this.feedback = new FeedbackPart(this.core, this.views, this.moderation);
    this.reviews = new ReviewsPart(this.core, this.views, this.moderation);
    this.reviews.feedback = this.feedback;
    this.qa = new QaPart(this.core, this.views, this.moderation);
    this.qa.feedback = this.feedback;
    this.responses = new ResponsesPart(this.core, this.views, this.moderation, this.feedback);
    this.summaries = new SummariesPart(this.core);
  }

  /* ---------------- public API (in-process) */

  /** Ratings for product cards and search results */
  async getRatingSummaries(productIds: string[]): Promise<RatingSummary[]> {
    return this.summaries.ratingSummaries(productIds);
  }

  /** Seller quality for offer comparison, featured-offer eligibility and storefronts */
  async getSellerFeedbackSummary(sellerId: string): Promise<SellerFeedbackSummary> {
    return this.feedback.summary(sellerId);
  }

  /** Called during a duplicate merge */
  async moveProductContent(fromProductId: string, toProductId: string): Promise<{ reviews: number; questions: number }> {
    return this.summaries.moveProductContent(fromProductId, toProductId);
  }

  /** Remove proven fake reviews named in an enforcement */
  async removeContentForEnforcement(contentIds: string[], enforcementId: string, reason: string): Promise<number> {
    return this.moderation.removeForEnforcement(contentIds, enforcementId, reason);
  }

  /** Published product reviews with filters and sorting (Product.reviews) */
  async listProductReviews(
    productId: string,
    filter: { stars?: number; verifiedOnly?: boolean; withPhotos?: boolean; variantLabel?: string },
    sort: string,
    page: common.PageInput,
    viewer: common.Actor | null,
  ): Promise<common.Page<ProductReview>> {
    const customerId = viewer?.kind === 'customer' && viewer.id ? await this.customerIdOf(viewer.id) : null;
    return this.reviews.listProductReviews(productId, filter ?? {}, sort, toPageRequest(page), customerId);
  }

  /** Published questions with labelled answers (Product.questions) */
  async listProductQuestions(productId: string, search: string | null, page: common.PageInput): Promise<common.Page<Question>> {
    return this.qa.listPublic(productId, search, 'most_helpful', toPageRequest(page));
  }

  /** Seller feedback with public seller responses, newest first (Seller.feedback) */
  async listSellerFeedback(sellerId: string, filter: { sentiment?: string }, page: common.PageInput): Promise<common.Page<SellerFeedback>> {
    return this.feedback.listPublic(sellerId, filter ?? {}, toPageRequest(page));
  }

  /** Review and seller-feedback state per purchased item, batched (OrderItem.reviewStatus) */
  async reviewStatusForItems(
    customerId: string,
    orderItemIds: string[],
  ): Promise<{ orderItemId: string; canReview: boolean; reviewBy: string | null; reviewId: string | null; status: string | null; statusLabel: string | null; rating: number | null; feedbackEligible: boolean; feedbackGiven: boolean }[]> {
    return this.reviews.statusForItems(customerId, orderItemIds);
  }

  /** Feedback summary of whoever sells each offer, the Official Store included, with on-time dispatch from shipping when enabled */
  async getOfferSellerRatings(offers: { offerId: string; ownerType: 'official' | 'seller'; sellerId: string | null }[]): Promise<Record<string, SellerFeedbackSummary>> {
    const keyOf = (o: (typeof offers)[number]) => (o.ownerType === 'official' ? OFFICIAL_STORE_ID : sellerKey(o.sellerId));
    const summaries = await this.feedback.summaries(offers.map(keyOf));
    return Object.fromEntries(offers.map((o) => [o.offerId, summaries.get(keyOf(o)) ?? this.feedback.summaryOut(keyOf(o), undefined, undefined, 12, null)]));
  }

  /** Account id (actor) → customer id (customers, optional) */
  async customerIdOf(accountId: string): Promise<string | null> {
    const c = await this.core.optional('customers', (api) => api.getCustomerByUserId(accountId));
    return c?.id ?? null;
  }

  /* ---------------- events consumed */

  /** orders.item.delivered: Make the item eligible for a Verified Purchase review and its seller package for feedback; schedule the invitation */
  async onItemDeliveredFromOrders(event: EventPayload<'orders.item.delivered'>): Promise<void> {
    // eligibility is read from orders (getOrderItem) when the customer writes; the invitations job looks at this customer
    this.summaries.noteDelivery(event.customerId, new Date(event.deliveredAt));
  }

  /** orders.item.cancelled: Remove eligibility for cancelled items */
  async onItemCancelledFromOrders(event: EventPayload<'orders.item.cancelled'>): Promise<void> {
    // a cancelled item is never delivered: orders no longer reports it (getOrderItem state, listDeliveredItems), so it gets no review or invitation
    this.core.ctx.log.debug({ itemId: event.itemId }, 'reviews: item cancelled, no review eligibility');
  }

  /** catalog.product.merged: Move reviews, questions and the rating summary to the kept product */
  async onProductMergedFromCatalog(event: EventPayload<'catalog.product.merged'>): Promise<void> {
    await this.summaries.moveProductContent(event.duplicateProductId, event.keptProductId, event.newVariantId ?? event.intoVariantId ?? null);
  }

  /** trust.enforcement.recorded: Remove reviews and answers named in a fake-review enforcement and notify authors */
  async onEnforcementRecordedFromTrust(event: EventPayload<'trust.enforcement.recorded'>): Promise<void> {
    if (event.alreadyApplied || event.action !== 'remove_reviews') return;
    const ids = (event.targets as { type?: string; id?: string }[])
      .filter((t) => t && typeof t.id === 'string' && ['review', 'question', 'answer'].includes(t.type ?? ''))
      .map((t) => t.id!);
    if (ids.length) await this.moderation.removeForEnforcement(ids, event.enforcementId, event.reason);
  }

  /** sellers.seller.closed: Keep feedback published; stop new responses from the closed seller */
  async onSellerClosedFromSellers(event: EventPayload<'sellers.seller.closed'>): Promise<void> {
    // feedback stays as it is; responses and seller answers check the seller's status when posted
    this.core.ctx.log.info({ sellerId: event.sellerId }, 'reviews: seller closed, feedback kept and new responses stopped');
  }

  /* ---------------- jobs */

  /** Job reviews.invites (hourly): Publish reviews.invite.due for items delivered inviteDelayDays ago without a review */
  async invites(): Promise<void> {
    await this.summaries.sendInvitations();
  }

  /** Job reviews.summaries (every 10 min): Refresh product and 12-month seller summaries; publish reviews.rating.changed */
  async summariesJob(): Promise<void> {
    await this.summaries.refreshAll();
  }

  /** Job reviews.moderation-sla (every 30 min): Flag moderation items older than moderationTargetHours (workqueues) */
  async moderationSla(): Promise<void> {
    await this.summaries.moderationSla();
  }
}
