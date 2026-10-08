import { notImplemented, routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/reviews.js';
import type { ReviewsService } from '../service.js';

/**
 * Store API: /api/store/reviews/…  (docs/api/modules/reviews.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const storeRoutes = (service: ReviewsService) =>
  routes(endpoints, 'store', {
    /** GET /products/{productId}/reviews: Published product reviews with filters and sorting */
    listProductReviews: notImplemented,
    /** GET /products/{productId}/rating-summary: Average, count, distribution and answered questions (honest no-reviews state) */
    getRatingSummary: notImplemented,
    /** GET /rating-summaries: Ratings for several products (cards) */
    getRatingSummaries: notImplemented,
    /** GET /products/{productId}/questions: Questions with answers labelled Seller, Marketly staff or Customer */
    listQuestions: notImplemented,
    /** POST /products/{productId}/questions: Ask a question about the product */
    askQuestion: notImplemented,
    /** POST /questions/{id}/answers: Answer another shopper's question (labelled Customer) */
    answerAsCustomer: notImplemented,
    /** POST /votes: Mark a review or answer helpful (or undo) */
    voteHelpful: notImplemented,
    /** POST /reports: Report a review, feedback, question, answer or seller response */
    reportContent: notImplemented,
    /** GET /sellers/{sellerId}/feedback: Seller feedback with public seller responses */
    listSellerFeedbackPublic: notImplemented,
    /** GET /sellers/{sellerId}/feedback-summary: Positive percentage and count over 12 months */
    getSellerFeedbackSummary: notImplemented,
    /** GET /me/pending: Delivered purchases waiting for a review and packages waiting for seller feedback */
    listPending: notImplemented,
    /** GET /me/review-context/{orderItemId}: Everything the write-a-review page needs: product, Verified Purchase, seller, existing review and feedback, guidelines */
    getReviewContext: notImplemented,
    /** GET /me/reviews: My product reviews with status and moderation outcomes */
    listMyReviews: notImplemented,
    /** GET /me/feedback: Seller feedback I gave, with seller responses */
    listMyFeedback: notImplemented,
    /** GET /me/reports: Reports I made and their outcomes */
    listMyReports: notImplemented,
    /** POST /me/reviews: Write a product review (or save a draft) */
    createReview: notImplemented,
    /** PATCH /me/reviews/{id}: Edit a review, or fix and resubmit after removal or an edit request */
    updateReview: notImplemented,
    /** DELETE /me/reviews/{id}: Delete my review */
    deleteReview: notImplemented,
    /** POST /me/feedback: Leave seller feedback for a delivered package (or save a draft) */
    createFeedback: notImplemented,
    /** PATCH /me/feedback/{id}: Edit seller feedback */
    updateFeedback: notImplemented,
    /** DELETE /me/feedback/{id}: Delete seller feedback */
    deleteFeedback: notImplemented,
    /** POST /me/appeals: Appeal a moderation decision on my content */
    customerAppeal: notImplemented,
  });
