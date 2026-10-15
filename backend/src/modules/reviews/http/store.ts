import { AppError } from '../../../kernel/errors/index.js';
import type { Scope } from '../../../kernel/auth/scope.js';
import { routes } from '../../../kernel/http/index.js';
import { isUuid } from '../../../kernel/lib/ids.js';
import type * as common from '../../../spec/common.js';
import { endpoints } from '../../../spec/reviews.js';
import type { CustomerWho } from '../service/core.js';
import type { ReviewsService } from '../service.js';

const customerIdOf = (scope: Scope) => (scope.kind === 'customer' ? scope.customerId : null);

/** The signed-in customer: customer id for records, account id for photo ownership */
export const customerWho = (i: { scope: Scope; principal: { accountId?: string | null } | null; actor: common.Actor; requestId: string }): CustomerWho => ({
  customerId: customerIdOf(i.scope),
  accountId: i.principal?.accountId ?? null,
  actor: i.actor,
  requestId: i.requestId,
});

const MAX_SUMMARIES = 100;

/**
 * Store API: /api/store/reviews/…  (docs/api/modules/reviews.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const storeRoutes = (service: ReviewsService) =>
  routes(endpoints, 'store', {
    /** GET /products/{productId}/reviews: Published product reviews with filters and sorting */
    listProductReviews: async ({ params, query, page, principal }) =>
      service.reviews.listProductReviews(
        params.productId,
        {
          ...(query.rating ? { stars: query.rating } : {}),
          ...(query.critical ? { critical: true } : {}),
          ...(query.verifiedOnly ? { verifiedOnly: true } : {}),
          ...(query.withPhotos ? { withPhotos: true } : {}),
          ...(query.variantId ? { variantId: query.variantId } : {}),
          ...(query.q ? { q: query.q } : {}),
        },
        query.sort,
        page,
        principal?.kind === 'customer' && principal.accountId ? await service.customerIdOf(principal.accountId) : null,
      ),
    /** GET /products/{productId}/rating-summary: Average, count, distribution and answered questions (honest no-reviews state) */
    getRatingSummary: async ({ params }) => (await service.getRatingSummaries([params.productId]))[0]!,
    /** GET /rating-summaries: Ratings for several products (cards) */
    getRatingSummaries: async ({ query }) => {
      const ids = [...new Set(query.productIds.split(',').map((s) => s.trim()).filter(Boolean))];
      const bad = ids.filter((id) => !isUuid(id));
      if (bad.length) throw new AppError('VALIDATION_FAILED', 'productIds must be product ids', { issues: [{ path: 'productIds', message: `Not a product id: ${bad[0]}` }] });
      if (ids.length > MAX_SUMMARIES) throw new AppError('VALIDATION_FAILED', `Ask for up to ${MAX_SUMMARIES} products at a time`, { issues: [{ path: 'productIds', message: `Up to ${MAX_SUMMARIES} ids` }] });
      return service.getRatingSummaries(ids);
    },
    /** GET /products/{productId}/questions: Questions with answers labelled Seller, Marketly staff or Customer */
    listQuestions: async ({ params, query, page, principal }) =>
      service.qa.listPublic(params.productId, query.q ?? null, query.sort, page, {
        ...(query.state ? { state: query.state } : {}),
        viewerCustomerId: principal?.kind === 'customer' && principal.accountId ? await service.customerIdOf(principal.accountId) : null,
      }),
    /** POST /products/{productId}/questions: Ask a question about the product */
    askQuestion: async (i) => service.qa.ask(customerWho(i), i.params.productId, i.body.text),
    /** POST /questions/{id}/answers: Answer another shopper's question (labelled Customer) */
    answerAsCustomer: async (i) => service.qa.answerAsCustomer(customerWho(i), i.params.id, i.body.text),
    /** POST /votes: Mark a review or answer helpful (or undo) */
    voteHelpful: async (i) => service.reviews.vote(customerWho(i), i.body),
    /** POST /reports: Report a review, feedback, question, answer or seller response */
    reportContent: async (i) => {
      const who = customerWho(i);
      if (!who.customerId) throw new AppError('NOT_FOUND', 'Content not found');
      return service.moderation.report({ kind: 'customer', id: who.customerId, actor: i.actor, requestId: i.requestId }, i.body);
    },
    /** GET /sellers/{sellerId}/feedback: Seller feedback with public seller responses */
    listSellerFeedbackPublic: async ({ params, query, page }) => service.feedback.listPublic(params.sellerId, { ...(query.sentiment ? { sentiment: query.sentiment } : {}) }, page),
    /** GET /sellers/{sellerId}/feedback-summary: Positive percentage and count over 12 months */
    getSellerFeedbackSummary: async ({ params }) => service.feedback.summary(params.sellerId),
    /** GET /me/pending: Delivered purchases waiting for a review and packages waiting for seller feedback */
    listPending: async ({ scope }) => service.reviews.pending(customerIdOf(scope)),
    /** GET /me/review-context/{orderItemId}: Everything the write-a-review page needs: product, Verified Purchase, seller, existing review and feedback, guidelines */
    getReviewContext: async (i) => service.reviews.context(customerWho(i), i.params.orderItemId),
    /** GET /me/reviews: My product reviews with status and moderation outcomes */
    listMyReviews: async ({ scope, page }) => service.reviews.listMine(customerIdOf(scope), page),
    /** GET /me/feedback: Seller feedback I gave, with seller responses */
    listMyFeedback: async ({ scope, page }) => service.feedback.listMine(customerIdOf(scope), page),
    /** GET /me/reports: Reports I made and their outcomes */
    listMyReports: async ({ scope, page }) => service.moderation.listReports({ kind: 'customer', id: customerIdOf(scope) }, page),
    /** POST /me/reviews: Write a product review (or save a draft) */
    createReview: async (i) => service.reviews.create(customerWho(i), i.body),
    /** PATCH /me/reviews/{id}: Edit a review, or fix and resubmit after removal or an edit request */
    updateReview: async (i) => service.reviews.update(customerWho(i), i.params.id, i.body),
    /** DELETE /me/reviews/{id}: Delete my review */
    deleteReview: async (i) => service.reviews.remove(customerWho(i), i.params.id),
    /** POST /me/feedback: Leave seller feedback for a delivered package (or save a draft) */
    createFeedback: async (i) => service.feedback.create(customerWho(i), i.body),
    /** PATCH /me/feedback/{id}: Edit seller feedback */
    updateFeedback: async (i) => service.feedback.update(customerWho(i), i.params.id, i.body),
    /** DELETE /me/feedback/{id}: Delete seller feedback */
    deleteFeedback: async (i) => service.feedback.remove(customerWho(i), i.params.id),
    /** POST /me/appeals: Appeal a moderation decision on my content */
    customerAppeal: async (i) => service.moderation.submitAppeal({ kind: 'customer', id: customerIdOf(i.scope), actor: i.actor, requestId: i.requestId }, i.body),
    /** PATCH /me/answers/{id}: Edit my answer, or fix and resubmit it after an edit request */
    editMyAnswer: async (i) => {
      const who = customerWho(i);
      if (!who.customerId) throw new AppError('NOT_FOUND', 'Answer not found');
      return service.qa.editAnswer({ kind: 'customer', customerId: who.customerId }, i.params.id, i.body.text, who);
    },
  });
