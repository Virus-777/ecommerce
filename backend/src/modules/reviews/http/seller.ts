import { routes, notImplemented } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/reviews.js';
import type { ReviewsService } from '../service.js';

/**
 * Seller API: /api/seller/reviews/…  (docs/api/modules/reviews.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 * Sellers act for input.sellerId (the session's seller), never an id from the body.
 */
export const sellerRoutes = (service: ReviewsService) =>
  routes(endpoints, 'seller', {
    /** GET /questions: Questions on products the seller offers */
    listSellerQuestions: async ({ sellerId, query, page }) => service.qa.listForSeller(sellerId, { ...(query.state ? { state: query.state } : {}), ...(query.productId ? { productId: query.productId } : {}) }, page),
    /** POST /questions/{id}/answers: Publish an answer labelled as from the seller */
    answerAsSeller: async ({ sellerId, params, body, actor, requestId }) => service.qa.answerAsSeller({ sellerId, actor, requestId }, params.id, body.text),
    /** GET /feedback: Seller feedback received */
    listSellerFeedback: async ({ sellerId, query, page }) =>
      service.feedback.listForSeller(sellerId, { ...(query.needsResponse !== undefined ? { needsResponse: query.needsResponse } : {}), ...(query.sentiment ? { sentiment: query.sentiment } : {}) }, page),
    /** GET /feedback-summary: Own feedback summary */
    getOwnFeedbackSummary: async ({ sellerId }) => service.feedback.summary(sellerId),
    /** GET /product-reviews: Product reviews of items the seller sold (to respond) */
    listSellerProductReviews: async ({ sellerId, query, page }) =>
      service.responses.listProductReviews(sellerId, { ...(query.needsResponse !== undefined ? { needsResponse: query.needsResponse } : {}), ...(query.rating ? { rating: query.rating } : {}) }, page),
    /** POST /responses: Respond publicly to a review or feedback */
    postResponse: async ({ sellerId, body, actor, requestId }) => service.responses.post({ sellerId, actor, requestId }, body),
    /** PATCH /responses/{id}: Edit a response within the edit window */
    editResponse: async ({ sellerId, params, body, actor, requestId }) => service.responses.edit({ sellerId, actor, requestId }, params.id, body.text),
    /** POST /reports: Report feedback, a review or an answer that breaks the rules */
    sellerReport: async ({ sellerId, body, actor, requestId }) => service.moderation.report({ kind: 'seller', id: sellerId, actor, requestId }, body),
    /** GET /reports: Reports the seller made and their outcomes */
    listSellerReports: async ({ sellerId, page }) => service.moderation.listReports({ kind: 'seller', id: sellerId }, page),
    /** POST /appeals: Appeal a moderation decision on the seller's answer or response */
    sellerAppeal: async ({ sellerId, body, actor, requestId }) => service.moderation.submitAppeal({ kind: 'seller', id: sellerId, actor, requestId }, body),
    /** PATCH /answers/{id}: Edit the seller's answer, or fix and resubmit it after an edit request (TODO pass 3: implement) */
    editSellerAnswer: notImplemented,
  });
