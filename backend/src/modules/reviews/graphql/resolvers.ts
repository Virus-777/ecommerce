import { createBatchLoader, gqlEnum, type GraphQLContext, type ModuleResolvers, pageInput } from '../../../kernel/graphql/index.js';
import { isUuid } from '../../../kernel/lib/ids.js';
import type * as common from '../../../spec/common.js';
import type { Answer, Author, ProductReview, Question, SellerFeedback, SellerFeedbackSummary, SellerResponse } from '../../../spec/reviews.js';
import type { ReviewsService } from '../service.js';

/* ---------------------------------------------------------------- REST shapes → GraphQL shapes (enums in capitals) */

const lower = (s: string | null | undefined) => (s ? s.toLowerCase() : undefined);

const author = (a: Author) => ({ kind: gqlEnum(a.kind), displayName: a.displayName, verifiedPurchase: a.verifiedPurchase });
const response = (r: SellerResponse | null | undefined) =>
  r ? { id: r.id, fromName: r.fromName, fromKind: gqlEnum(r.fromKind), text: r.text, publishedAt: r.publishedAt ?? null, status: gqlEnum(r.status), editableUntil: r.editableUntil ?? null } : null;
const answer = (a: Answer) => ({ id: a.id, text: a.text, by: author(a.by), label: gqlEnum(a.label), answeredAt: a.answeredAt, helpfulCount: a.helpfulCount, status: gqlEnum(a.status) });
const question = (q: Question) => ({ ...q, answers: q.answers.map(answer), status: gqlEnum(q.status), answerExpectation: q.answerExpectation ?? null });
const rating = (s: SellerFeedbackSummary) => s;

const pageOut = <T, U>(p: common.Page<T>, f: (x: T) => U) => ({ items: p.items.map(f), nextCursor: p.nextCursor, page: p.page ?? null, totalPages: p.totalPages ?? null, total: p.total ?? null });

const SORT: Record<string, string> = { MOST_HELPFUL: 'most_helpful', NEWEST: 'newest', HIGHEST_RATED: 'highest', LOWEST_RATED: 'lowest' };

/* ---------------------------------------------------------------- batching per request (one call per key and tick) */

const load = createBatchLoader();

/**
 * Resolvers for the GraphQL fields this module owns (`@source(module: "reviews", …)` in graphql/schema.ts).
 * Seller- and admin-only fields of Review and SellerFeedback are lazy functions, so they cost nothing
 * unless a query asks for them; the same record scope as REST applies.
 */
export const resolvers = (service: ReviewsService): ModuleResolvers => {
  const core = service.core;

  const reviewRow = (ctx: GraphQLContext, id: string) => load(ctx, 'review-rows', id, async (ids) => new Map((await core.repo.getMany('product_reviews', ids)).map((r) => [r.id, r])));
  const orderRef = (ctx: GraphQLContext, orderId: string) => load(ctx, 'order-refs', orderId, async (ids) => new Map([...(await core.orders(ids))].map(([k, o]) => [k, o.ref])));
  const ownsOrStaff = (ctx: GraphQLContext, sellerId: string) => ctx.principal?.kind === 'staff' || (ctx.principal?.sellerId != null && ctx.principal.sellerId === sellerId);

  const review = (r: ProductReview, ctx: GraphQLContext) => ({
    ...r,
    author: author(r.author),
    soldBy: { sellerId: r.soldBy.sellerId, name: r.soldBy.name },
    response: response(r.response),
    orderRef: async () => {
      const row = await reviewRow(ctx, r.id);
      return row && ownsOrStaff(ctx, row.seller_id) ? ((await orderRef(ctx, row.order_id)) ?? null) : null;
    },
    canRespond: async () => {
      const row = await reviewRow(ctx, r.id);
      return Boolean(row && ctx.principal?.sellerId === row.seller_id && !r.response);
    },
    reportCount: async () => (ctx.principal?.kind === 'staff' ? ((await load(ctx, 'report-counts', r.id, (ids) => core.repo.countReportsByTarget('product_review', ids))) ?? 0) : null),
  });

  const feedback = (f: SellerFeedback, ctx: GraphQLContext) => ({
    id: f.id,
    sellerId: f.sellerId,
    author: author(f.author),
    asDescribed: f.dimensions.asDescribed,
    dispatchRating: f.dimensions.dispatchRating,
    communicationRating: f.dimensions.communicationRating ?? null,
    overall: f.overall,
    sentiment: gqlEnum(f.sentiment),
    comment: f.comment ?? null,
    itemTitle: f.itemTitle ?? null,
    postedAt: f.postedAt,
    editedAt: f.editedAt ?? null,
    response: response(f.response),
    orderRef: async () => (ownsOrStaff(ctx, f.sellerId) ? ((await orderRef(ctx, f.orderId)) ?? null) : null),
  });

  return {
    Product: {
      reviewSummary: async (root: { id: string }, _args, ctx: GraphQLContext) => {
        const s = await load(ctx, 'rating-summaries', root.id, async (ids) => new Map((await service.getRatingSummaries(ids)).map((x) => [x.productId, x])));
        return s ?? (await service.getRatingSummaries([root.id]))[0] ?? service.summaries.summaryOut(root.id, undefined);
      },
      reviews: async (
        root: { id: string },
        args: { stars?: number | null; verifiedOnly?: boolean | null; withPhotos?: boolean | null; variantLabel?: string | null; sort?: string | null; paging?: common.PageInput | null },
        ctx: GraphQLContext,
      ) => {
        const viewer: common.Actor | null = ctx.principal ? { kind: ctx.principal.kind, id: ctx.principal.kind === 'visitor' ? ctx.principal.sessionId : (ctx.principal.accountId ?? null) } : null;
        const page = await service.listProductReviews(
          root.id,
          {
            ...(args.stars ? { stars: args.stars } : {}),
            ...(args.verifiedOnly ? { verifiedOnly: true } : {}),
            ...(args.withPhotos ? { withPhotos: true } : {}),
            ...(args.variantLabel ? { variantLabel: args.variantLabel } : {}),
          },
          SORT[args.sort ?? 'MOST_HELPFUL'] ?? 'most_helpful',
          pageInput(args.paging),
          viewer,
        );
        return pageOut(page, (r) => review(r, ctx));
      },
      questions: async (root: { id: string }, args: { search?: string | null; paging?: common.PageInput | null }) =>
        pageOut(await service.listProductQuestions(root.id, args.search ?? null, pageInput(args.paging)), question),
    },
    Seller: {
      rating: async (root: { id: string }, _args, ctx: GraphQLContext) => {
        const s = await load(ctx, 'seller-ratings', root.id, (ids) => service.feedback.summaries(ids));
        return rating(s ?? (await service.getSellerFeedbackSummary(root.id)));
      },
      feedback: async (root: { id: string }, args: { sentiment?: string | null; paging?: common.PageInput | null }, ctx: GraphQLContext) =>
        pageOut(await service.listSellerFeedback(root.id, { ...(args.sentiment ? { sentiment: lower(args.sentiment) } : {}) }, pageInput(args.paging)), (f) => feedback(f, ctx)),
    },
    Offer: {
      sellerRating: async (root: { id: string; ownerType?: string | null; sellerId?: string | null }, _args, ctx: GraphQLContext) => {
        const ownerType = lower(root.ownerType) === 'official' ? 'official' : 'seller';
        const key = `${ownerType}:${root.sellerId ?? ''}`;
        const s = await load(ctx, 'offer-ratings', key, async (keys) => {
          const offers = keys.map((k) => {
            const [o, id] = k.split(':');
            return { offerId: k, ownerType: o as 'official' | 'seller', sellerId: id && isUuid(id) ? id : null };
          });
          return new Map(Object.entries(await service.getOfferSellerRatings(offers)));
        });
        return s ?? (await service.getOfferSellerRatings([{ offerId: root.id, ownerType, sellerId: root.sellerId ?? null }]))[root.id];
      },
    },
    OrderItem: {
      reviewStatus: async (root: { id: string }, _args, ctx: GraphQLContext) => {
        const customerId = await ctx.customerId();
        if (!customerId) return null;
        const s = await load(ctx, `review-status:${customerId}`, root.id, async (ids) => new Map((await service.reviewStatusForItems(customerId, ids)).map((x) => [x.orderItemId, x])));
        return s ? { ...s, status: gqlEnum(s.status) } : null;
      },
    },
  };
};
