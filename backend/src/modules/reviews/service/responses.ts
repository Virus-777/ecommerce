/**
 * Public seller responses to product reviews of items the seller sold and to the seller's own feedback:
 * one per review, rule-checked, editable for responseEditDays. Failing responses are held for moderation.
 */
import { isUuid, newId } from '../../../kernel/lib/ids.js';
import { pageOf, type PageRequest } from '../../../kernel/lib/pagination.js';
import type * as common from '../../../spec/common.js';
import type { OfficialReviewRow, ResponseInput, SellerProductReviewRow, SellerResponse } from '../../../spec/reviews.js';
import { addDays, isSellerId, OFFICIAL_STORE_ID, responseChecks } from '../domain/rules.js';
import { sellerResponseMachine } from '../domain/state-machines.js';
import type { FeedbackRec, ResponseRec, ReviewRec } from '../ports.js';
import type { ReviewsRepository } from '../repository.js';
import { type By, type Core, Effects, notFound, type SellerWho, invalid } from './core.js';
import { responsePublished } from './content.js';
import type { FeedbackPart } from './feedback.js';
import type { ModerationPart } from './moderation.js';
import type { Views } from './views.js';

const MAX_RESPONSE = 2000;
/** Rows read for the Official Store list when it mixes reviews and feedback */
const OFFICIAL_LIST_MAX = 500;

export class ResponsesPart {
  constructor(
    private readonly core: Core,
    private readonly views: Views,
    private readonly moderation: ModerationPart,
    private readonly feedback: FeedbackPart,
  ) {}

  /** What the customer shows and the names they keep private, for the rule check */
  private async customerNames(target: { customerId: string; shownName: string }) {
    const full = (await this.core.customerNames([target.customerId])).get(target.customerId) ?? '';
    return { shownName: target.shownName, privateNames: full.split(/\s+/).filter(Boolean) };
  }

  private async target(sellerId: string, type: string, id: string) {
    const repo = this.core.repo;
    if (type === 'product_review') {
      const r = isUuid(id) ? await repo.get('product_reviews', id) : undefined;
      if (!r || r.status !== 'published' || !r.visible) throw notFound('Review');
      if (r.seller_id !== sellerId) throw this.core.ctx.error('NOT_AN_OFFER_SELLER', 'You can respond only to reviews of items you sold.');
      return { customerId: r.customer_id, shownName: this.views.reviewAuthor(r).displayName };
    }
    const f = isUuid(id) ? await repo.get('seller_feedback', id) : undefined;
    if (!f || f.seller_id !== sellerId || f.status !== 'published' || !f.visible) throw notFound('Feedback');
    return { customerId: f.customer_id, shownName: f.display_name };
  }

  private check(text: string) {
    const t = text?.trim() ?? '';
    if (!t) throw invalid([{ path: 'text', message: 'Write your response' }]);
    if (t.length > MAX_RESPONSE) throw invalid([{ path: 'text', message: `Keep it under ${MAX_RESPONSE.toLocaleString('en-US')} characters` }]);
    return t;
  }

  async post(who: SellerWho, input: ResponseInput): Promise<SellerResponse> {
    const text = this.check(input.text);
    const target = await this.target(who.sellerId, input.targetType, input.targetId);
    if (await this.feedback.sellerClosed(who.sellerId)) throw this.core.ctx.error('NOT_AN_OFFER_SELLER', 'Closed seller accounts cannot post new responses.');
    const repo = this.core.repo;
    if (await repo.findOne('seller_responses', { target_type: input.targetType, target_id: input.targetId })) throw this.core.ctx.error('RESPONSE_ALREADY_EXISTS', 'You already responded. Edit your response instead.');
    const failures = responseChecks(text, await this.customerNames(target));
    const editDays = await this.core.num('responseEditDays');
    const fx = new Effects();
    const now = this.core.now();
    const status = sellerResponseMachine.next('pending', failures.length ? 'hold' : 'publish');
    const row = await repo.transaction(async (tx) => {
      if (await tx.findOne('seller_responses', { target_type: input.targetType, target_id: input.targetId }, { forUpdate: true })) {
        throw this.core.ctx.error('RESPONSE_ALREADY_EXISTS', 'You already responded. Edit your response instead.');
      }
      const r = await tx.insert('seller_responses', {
        id: newId(),
        target_type: input.targetType,
        target_id: input.targetId,
        seller_id: who.sellerId,
        text,
        status,
        rule_check: { passed: !failures.length, failures: failures.map((f) => f.label) },
        created_by: who.actor.id ?? who.sellerId,
        created_at: now,
        published_at: status === 'published' ? now : null,
        editable_until: addDays(now, editDays),
      });
      if (failures.length) await this.moderation.hold(tx, { type: 'seller_response', id: r.id }, failures);
      const payload = await responsePublished(tx, r);
      if (payload) fx.emit('reviews.response.published', payload);
      return r;
    });
    await this.core.flush(fx, who);
    return this.out(row);
  }

  private async own(sellerId: string, id: string, repo: ReviewsRepository = this.core.repo, forUpdate = false): Promise<ResponseRec> {
    const r = isUuid(id) ? await repo.get('seller_responses', id, { forUpdate }) : undefined;
    if (!r || r.seller_id !== sellerId) throw notFound('Response');
    return r;
  }

  async edit(who: SellerWho, id: string, textIn: string): Promise<SellerResponse> {
    const text = this.check(textIn);
    const row = await this.own(who.sellerId, id);
    if (this.core.now() > row.editable_until) throw this.core.ctx.error('RESPONSE_EDIT_WINDOW_CLOSED', 'This response can no longer be edited.', { editableUntil: row.editable_until.toISOString() });
    const pending = sellerResponseMachine.next(row.status as SellerResponse['status'], 'edit');
    const target = await this.target(who.sellerId, row.target_type, row.target_id).catch(() => null);
    if (!target) throw notFound('Review');
    const failures = responseChecks(text, await this.customerNames(target));
    const status = sellerResponseMachine.next(pending, failures.length ? 'hold' : 'publish');
    const fx = new Effects();
    const now = this.core.now();
    const updated = await this.core.repo.transaction(async (tx) => {
      const locked = await this.own(who.sellerId, id, tx, true);
      sellerResponseMachine.next(locked.status as SellerResponse['status'], 'edit');
      const r = await tx.update('seller_responses', id, {
        text,
        status,
        rule_check: { passed: !failures.length, failures: failures.map((f) => f.label) },
        ...(status === 'published' ? { published_at: now } : {}),
      });
      if (failures.length) await this.moderation.hold(tx, { type: 'seller_response', id }, failures);
      const payload = await responsePublished(tx, r);
      if (payload) fx.emit('reviews.response.published', payload);
      return r;
    });
    await this.core.flush(fx, who);
    return this.out(updated);
  }

  private async out(r: ResponseRec): Promise<SellerResponse> {
    const names = await this.core.sellerNames([r.seller_id]);
    return this.views.responseOut(r, this.core.sellerName(names, r.seller_id), true);
  }

  /* ---------------------------------------------------------------- the Official Store (staff, reviews.answers.staff) */

  /** Product reviews of Official Store sales and Official Store feedback, to respond as the Official Store */
  async listOfficial(filter: { targetType?: 'product_review' | 'seller_feedback'; needsResponse?: boolean; rating?: number }, page: PageRequest): Promise<common.Page<OfficialReviewRow>> {
    const repo = this.core.repo;
    const reviewRows = async (p: PageRequest) =>
      repo.listReviews({ sellerId: OFFICIAL_STORE_ID, publicOnly: true, ...(filter.rating ? { stars: filter.rating } : {}), ...(filter.needsResponse !== undefined ? { needsResponse: filter.needsResponse } : {}), sort: 'newest' }, p);
    const feedbackRows = async (p: PageRequest) => repo.listFeedback({ sellerId: OFFICIAL_STORE_ID, publicOnly: true, ...(filter.needsResponse !== undefined ? { needsResponse: filter.needsResponse } : {}) }, p);
    const toRows = async (reviews: ReviewRec[], feedback: FeedbackRec[]): Promise<{ at: Date; row: OfficialReviewRow }[]> => {
      const [rv, fb, orders] = await Promise.all([this.views.reviews(reviews, { internal: true }), this.views.feedback(feedback, { internal: true }), this.core.orders([...reviews.map((r) => r.order_id), ...feedback.map((f) => f.order_id)])]);
      return [
        ...rv.map((review, i) => ({ at: reviews[i]!.created_at, row: { targetType: 'product_review' as const, review, feedback: null, orderRef: orders.get(reviews[i]!.order_id)?.ref ?? null, needsResponse: !review.response, canRespond: !review.response } })),
        ...fb.map((fbk, i) => ({ at: feedback[i]!.created_at, row: { targetType: 'seller_feedback' as const, review: null, feedback: fbk, orderRef: orders.get(feedback[i]!.order_id)?.ref ?? null, needsResponse: !fbk.response, canRespond: !fbk.response } })),
      ];
    };
    if (filter.targetType === 'product_review') {
      const rows = await reviewRows(page);
      return { ...rows, items: (await toRows(rows.items, [])).map((x) => x.row) };
    }
    if (filter.targetType === 'seller_feedback') {
      const rows = await feedbackRows(page);
      return { ...rows, items: (await toRows([], rows.items)).map((x) => x.row) };
    }
    // both kinds, newest first (bounded: the Official Store's recent reviews and feedback)
    const all = { mode: 'page', page: 1, limit: OFFICIAL_LIST_MAX } as PageRequest;
    const [reviews, feedback] = await Promise.all([reviewRows(all), feedbackRows(all)]);
    const merged = (await toRows(reviews.items, feedback.items)).sort((a, b) => b.at.getTime() - a.at.getTime()).map((x) => x.row);
    return pageOf(merged, page);
  }

  /** Responds publicly as the Official Store (same rules as seller responses) */
  async postOfficial(by: By, input: ResponseInput): Promise<SellerResponse> {
    const r = await this.post({ sellerId: OFFICIAL_STORE_ID, actor: by.actor, ...(by.requestId ? { requestId: by.requestId } : {}) }, input);
    await this.core.audit(
      {
        action: 'reviews.response.official',
        actionLabel: 'Responded publicly as the Official Store',
        category: 'content',
        target: { type: input.targetType, id: input.targetId },
        relatedTargets: [{ type: 'seller_response', id: r.id }],
        after: { text: r.text, status: r.status },
      },
      by,
    );
    return r;
  }

  async editOfficial(by: By, id: string, text: string): Promise<SellerResponse> {
    const before = await this.own(OFFICIAL_STORE_ID, id);
    const r = await this.edit({ sellerId: OFFICIAL_STORE_ID, actor: by.actor, ...(by.requestId ? { requestId: by.requestId } : {}) }, id, text);
    await this.core.audit(
      {
        action: 'reviews.response.official_edit',
        actionLabel: 'Edited an Official Store response',
        category: 'content',
        target: { type: before.target_type, id: before.target_id },
        relatedTargets: [{ type: 'seller_response', id }],
        before: { text: before.text, status: before.status },
        after: { text: r.text, status: r.status },
      },
      by,
    );
    return r;
  }

  /** Product reviews of items the seller sold */
  async listProductReviews(sellerId: string, filter: { needsResponse?: boolean; rating?: number }, page: PageRequest): Promise<common.Page<SellerProductReviewRow>> {
    if (!isSellerId(sellerId)) return pageOf([], page);
    const rows = await this.core.repo.listReviews(
      { sellerId, publicOnly: true, ...(filter.rating ? { stars: filter.rating } : {}), ...(filter.needsResponse !== undefined ? { needsResponse: filter.needsResponse } : {}), sort: 'newest' },
      page,
    );
    const [reviews, orders, closed] = await Promise.all([this.views.reviews(rows.items, { internal: true }), this.core.orders(rows.items.map((r) => r.order_id)), this.feedback.sellerClosed(sellerId)]);
    const now = this.core.now();
    return {
      ...rows,
      items: reviews.map((review, i) => {
        const r = review.response;
        const editable = r?.editableUntil && new Date(r.editableUntil) >= now;
        return {
          review,
          orderRef: orders.get(rows.items[i]!.order_id)?.ref ?? '',
          canRespond: !r && !closed,
          respondNote: closed
            ? 'Your account is closed: new responses are off.'
            : r
              ? editable
                ? `You responded. You can edit it until ${r.editableUntil!.slice(0, 10)}.`
                : 'You responded. The edit window has ended.'
              : null,
        };
      }),
    };
  }
}
