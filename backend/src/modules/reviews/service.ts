import { notImplemented } from '../../kernel/errors/index.js';
import type { EventPayload } from '../../kernel/events/index.js';
import type { ModuleContext } from '../../kernel/module-system/index.js';
import type * as common from '../../spec/common.js';
import type { ReviewsPublicApi, ProductReview, RatingSummary, Question, SellerFeedback, SellerFeedbackSummary } from '../../spec/reviews.js';
import type { ReviewsRepository } from './ports.js';

export interface ReviewsServiceDeps {
  repo: ReviewsRepository;
  ctx: ModuleContext<'reviews'>;
}

/**
 * Reviews use cases. Depends only on ports, the event bus, the clock and other modules' public APIs.
 * Each method maps to a publicApi function, a consumed event or a job in docs/api/spec/modules/reviews.json.
 */
export class ReviewsService implements ReviewsPublicApi {
  constructor(protected readonly deps: ReviewsServiceDeps) {}

  /* ---------------- public API (in-process) */

  /** Ratings for product cards and search results */
  async getRatingSummaries(productIds: string[]): Promise<RatingSummary[]> {
    throw notImplemented("reviews.getRatingSummaries");
  }

  /** Seller quality for offer comparison, featured-offer eligibility and storefronts */
  async getSellerFeedbackSummary(sellerId: string): Promise<SellerFeedbackSummary> {
    throw notImplemented("reviews.getSellerFeedbackSummary");
  }

  /** Called during a duplicate merge */
  async moveProductContent(fromProductId: string, toProductId: string): Promise<{ reviews: number, questions: number }> {
    throw notImplemented("reviews.moveProductContent");
  }

  /** Remove proven fake reviews named in an enforcement */
  async removeContentForEnforcement(contentIds: string[], enforcementId: string, reason: string): Promise<number> {
    throw notImplemented("reviews.removeContentForEnforcement");
  }

  /** Published product reviews with filters and sorting (Product.reviews) */
  async listProductReviews(productId: string, filter: { stars?: number, verifiedOnly?: boolean, withPhotos?: boolean, variantLabel?: string }, sort: string, page: common.PageInput, viewer: common.Actor | null): Promise<common.Page<ProductReview>> {
    throw notImplemented("reviews.listProductReviews");
  }

  /** Published questions with labelled answers (Product.questions) */
  async listProductQuestions(productId: string, search: string | null, page: common.PageInput): Promise<common.Page<Question>> {
    throw notImplemented("reviews.listProductQuestions");
  }

  /** Seller feedback with public seller responses, newest first (Seller.feedback) */
  async listSellerFeedback(sellerId: string, filter: { sentiment?: string }, page: common.PageInput): Promise<common.Page<SellerFeedback>> {
    throw notImplemented("reviews.listSellerFeedback");
  }

  /** Review and seller-feedback state per purchased item, batched (OrderItem.reviewStatus) */
  async reviewStatusForItems(customerId: string, orderItemIds: string[]): Promise<{ orderItemId: string, canReview: boolean, reviewBy: string | null, reviewId: string | null, status: string | null, statusLabel: string | null, rating: number | null, feedbackEligible: boolean, feedbackGiven: boolean }[]> {
    throw notImplemented("reviews.reviewStatusForItems");
  }

  /** Feedback summary of whoever sells each offer, the Official Store included, with on-time dispatch from shipping when enabled */
  async getOfferSellerRatings(offers: { offerId: string, ownerType: 'official' | 'seller', sellerId: string | null }[]): Promise<Record<string, SellerFeedbackSummary>> {
    throw notImplemented("reviews.getOfferSellerRatings");
  }

  /* ---------------- events consumed */

  /** orders.item.delivered: Make the item eligible for a Verified Purchase review and its seller package for feedback; schedule the invitation */
  async onItemDeliveredFromOrders(event: EventPayload<"orders.item.delivered">): Promise<void> {
    throw notImplemented("reviews consumer of orders.item.delivered");
  }

  /** orders.item.cancelled: Remove eligibility for cancelled items */
  async onItemCancelledFromOrders(event: EventPayload<"orders.item.cancelled">): Promise<void> {
    throw notImplemented("reviews consumer of orders.item.cancelled");
  }

  /** catalog.product.merged: Move reviews, questions and the rating summary to the kept product */
  async onProductMergedFromCatalog(event: EventPayload<"catalog.product.merged">): Promise<void> {
    throw notImplemented("reviews consumer of catalog.product.merged");
  }

  /** trust.enforcement.recorded: Remove reviews and answers named in a fake-review enforcement and notify authors */
  async onEnforcementRecordedFromTrust(event: EventPayload<"trust.enforcement.recorded">): Promise<void> {
    throw notImplemented("reviews consumer of trust.enforcement.recorded");
  }

  /** sellers.seller.closed: Keep feedback published; stop new responses from the closed seller */
  async onSellerClosedFromSellers(event: EventPayload<"sellers.seller.closed">): Promise<void> {
    throw notImplemented("reviews consumer of sellers.seller.closed");
  }

  /* ---------------- jobs */

  /** Job reviews.invites (hourly): Publish reviews.invite.due for items delivered inviteDelayDays ago without a review */
  async invites(): Promise<void> {
    throw notImplemented("job reviews.invites");
  }

  /** Job reviews.summaries (every 10 min): Refresh product and 12-month seller summaries; publish reviews.rating.changed */
  async summaries(): Promise<void> {
    throw notImplemented("job reviews.summaries");
  }

  /** Job reviews.moderation-sla (every 30 min): Flag moderation items older than moderationTargetHours (workqueues) */
  async moderationSla(): Promise<void> {
    throw notImplemented("job reviews.moderation-sla");
  }
}
