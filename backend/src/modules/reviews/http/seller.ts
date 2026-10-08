import { notImplemented, routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/reviews.js';
import type { ReviewsService } from '../service.js';

/**
 * Seller API: /api/seller/reviews/…  (docs/api/modules/reviews.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const sellerRoutes = (service: ReviewsService) => {
  void service;
  return routes(endpoints, 'seller', {
    /** GET /questions: Questions on products the seller offers */
    listSellerQuestions: notImplemented,
    /** POST /questions/{id}/answers: Publish an answer labelled as from the seller */
    answerAsSeller: notImplemented,
    /** GET /feedback: Seller feedback received */
    listSellerFeedback: notImplemented,
    /** GET /feedback-summary: Own feedback summary */
    getOwnFeedbackSummary: notImplemented,
    /** GET /product-reviews: Product reviews of items the seller sold (to respond) */
    listSellerProductReviews: notImplemented,
    /** POST /responses: Respond publicly to a review or feedback */
    postResponse: notImplemented,
    /** PATCH /responses/{id}: Edit a response within the edit window */
    editResponse: notImplemented,
    /** POST /reports: Report feedback, a review or an answer that breaks the rules */
    sellerReport: notImplemented,
    /** GET /reports: Reports the seller made and their outcomes */
    listSellerReports: notImplemented,
    /** POST /appeals: Appeal a moderation decision on the seller's answer or response */
    sellerAppeal: notImplemented,
  });
};
