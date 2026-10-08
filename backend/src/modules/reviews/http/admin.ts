import { notImplemented, routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/reviews.js';
import type { ReviewsService } from '../service.js';

/**
 * Admin API: /api/admin/reviews/…  (docs/api/modules/reviews.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const adminRoutes = (service: ReviewsService) => {
  void service;
  return routes(endpoints, 'admin', {
    /** GET /moderation-items: Reported and held content: reviews, feedback, questions, answers, seller responses */
    moderationQueue: notImplemented,
    /** GET /moderation-items/summary: Open moderation counts for the nav badge and tabs */
    moderationSummary: notImplemented,
    /** GET /moderation-items/{id}: Content with reports, purchase, author history and previous decisions */
    getModerationItem: notImplemented,
    /** POST /moderation-items/{id}/decide: Keep, remove for a policy reason, request an edit, publish, or reject a seller response */
    decideModeration: notImplemented,
    /** POST /moderation-items/{id}/refer: Send to Trust and Risk (suspected fake or paid reviews, payment offers) */
    referToTrust: notImplemented,
    /** GET /questions: Customer questions on products, e.g. unanswered questions on Official Store products (plan ch. 9) */
    listQuestionsAdmin: notImplemented,
    /** POST /questions/{id}/answers: Add a Marketly staff answer */
    answerAsStaff: notImplemented,
    /** GET /appeals: Appeals of moderation decisions */
    listAppeals: notImplemented,
    /** POST /appeals/{id}/decide: Decide an appeal (not by the original moderator) */
    decideAppeal: notImplemented,
    /** GET /reviews: Search all product reviews */
    listReviewsAdmin: notImplemented,
    /** GET /moderation-reasons: Policy reasons for decisions */
    listModerationReasons: notImplemented,
  });
};
