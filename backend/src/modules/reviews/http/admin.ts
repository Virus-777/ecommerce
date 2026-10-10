import { routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/reviews.js';
import type { ReviewsService } from '../service.js';

/**
 * Admin API: /api/admin/reviews/…  (docs/api/modules/reviews.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const adminRoutes = (service: ReviewsService) =>
  routes(endpoints, 'admin', {
    /** GET /moderation-items: Reported and held content: reviews, feedback, questions, answers, seller responses */
    moderationQueue: async ({ query, page }) => service.moderation.queue(query, page),
    /** GET /moderation-items/summary: Open moderation counts for the nav badge and tabs */
    moderationSummary: async () => service.moderation.summary(),
    /** GET /moderation-items/{id}: Content with reports, purchase, author history and previous decisions */
    getModerationItem: async ({ params }) => service.moderation.detail(params.id),
    /** POST /moderation-items/{id}/decide: Keep, remove for a policy reason, request an edit, publish, or reject a seller response */
    decideModeration: async ({ params, body, actor, requestId }) => service.moderation.decide(params.id, body, { actor, requestId }),
    /** POST /moderation-items/{id}/refer: Send to Trust and Risk (suspected fake or paid reviews, payment offers) */
    referToTrust: async ({ params, body, actor, requestId }) => service.moderation.refer(params.id, body.note, { actor, requestId }),
    /** GET /questions: Customer questions on products, e.g. unanswered questions on Official Store products (plan ch. 9) */
    listQuestionsAdmin: async ({ query, page }) => service.qa.listForAdmin(query, page),
    /** POST /questions/{id}/answers: Add a Marketly staff answer */
    answerAsStaff: async ({ params, body, actor, requestId }) => service.qa.answerAsStaff({ actor, requestId }, params.id, body),
    /** GET /appeals: Appeals of moderation decisions */
    listAppeals: async ({ query, page }) => service.moderation.listAppeals(query, page),
    /** POST /appeals/{id}/decide: Decide an appeal (not by the original moderator) */
    decideAppeal: async ({ params, body, actor, requestId }) => service.moderation.decideAppeal(params.id, body, { actor, requestId }),
    /** GET /reviews: Search all product reviews */
    listReviewsAdmin: async ({ query, page }) => service.reviews.listAdmin(query, page),
    /** GET /moderation-reasons: Policy reasons for decisions */
    listModerationReasons: async () => service.moderation.reasons(),
    /** GET /official-store/reviews: Product reviews of Official Store sales and Official Store feedback, to respond as the Official Store */
    listOfficialStoreReviews: async ({ query, page }) => service.responses.listOfficial(query, page),
    /** POST /official-store/responses: Respond publicly as the Official Store */
    postOfficialResponse: async ({ body, actor, requestId }) => service.responses.postOfficial({ actor, requestId }, body),
    /** PATCH /official-store/responses/{id}: Edit an Official Store response within the edit window */
    editOfficialResponse: async ({ params, body, actor, requestId }) => service.responses.editOfficial({ actor, requestId }, params.id, body.text),
  });
