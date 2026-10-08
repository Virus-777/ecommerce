import type { ModuleResolvers } from '../../../kernel/graphql/index.js';
import type { ReviewsService } from '../service.js';

/**
 * Resolvers for the GraphQL fields this module owns (`@source(module: "reviews", …)` in graphql/schema.ts).
 * A field without a resolver answers NOT_IMPLEMENTED; fields of this module's own types without
 * @source resolve from the parent object.
 *
 * Fields to resolve:
 *   Product.reviewSummary → service.getRatingSummaries
 *   Product.reviews → service.listProductReviews
 *   Product.questions → service.listProductQuestions
 *   Seller.rating → service.getSellerFeedbackSummary
 *   Seller.feedback → service.listSellerFeedback
 *   Offer.sellerRating → service.getOfferSellerRatings
 *   OrderItem.reviewStatus → service.reviewStatusForItems
 */
export const resolvers = (service: ReviewsService): ModuleResolvers => ({});
