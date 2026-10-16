/**
 * Rows → API types, with the lookups each list needs done once per list (products, seller names,
 * photos, responses, votes, moderation outcomes).
 */
import type * as common from '../../../spec/common.js';
import type { Answer, AppealView, Author, ModerationOutcome, MyFeedback, MyReview, ProductReview, Question, SellerFeedback, SellerResponse } from '../../../spec/reviews.js';
import {
  ADVERSE,
  addDays,
  ANONYMOUS_REVIEWER,
  AUTHOR_TEXT,
  FEEDBACK_STATUS_LABEL,
  isOfficial,
  OFFICIAL_STORE_ID,
  OFFICIAL_STORE_NAME,
  OUTCOME_OF,
  reasonLabel,
  REPORT_REASON_LABEL,
  REVIEW_STATUS_LABEL,
} from '../domain/rules.js';
import { productReviewMachine, sellerFeedbackMachine } from '../domain/state-machines.js';
import type { AnswerRec, AppealRec, DecisionRec, FeedbackRec, ItemRec, QuestionRec, ResponseRec, ReviewRec } from '../ports.js';
import type { Core } from './core.js';

const ADVERSE_STATES = new Set(['removed', 'edit_requested', 'rejected']);

export const validUrl = (u: string | null | undefined) => (u && URL.canParse(u) ? u : null);

export interface Outcome {
  moderation: ModerationOutcome | null;
  appeal: AppealView | null;
  /** The decision an appeal would be against */
  decision: DecisionRec | null;
  openItem: ItemRec | null;
}

export const appealView = (a: AppealRec): AppealView => ({
  id: a.id,
  status: a.status as AppealView['status'],
  submittedAt: a.submitted_at.toISOString(),
  decidedAt: a.decided_at?.toISOString() ?? null,
  outcome: a.outcome,
});

export class Views {
  constructor(private readonly core: Core) {}

  /* ---------------------------------------------------------------- seller responses */

  responseOut(r: ResponseRec, fromName: string, internal: boolean): SellerResponse {
    const ruleCheck = r.rule_check as { passed: boolean; failures: string[] } | null;
    return {
      id: r.id,
      fromName,
      fromKind: isOfficial(r.seller_id) ? 'official_store' : 'seller',
      text: r.text,
      status: r.status as SellerResponse['status'],
      publishedAt: r.published_at?.toISOString() ?? null,
      editableUntil: internal ? r.editable_until.toISOString() : null,
      ruleCheck: internal && ruleCheck ? { passed: Boolean(ruleCheck.passed), failures: ruleCheck.failures ?? [] } : null,
    };
  }

  /** Responses by target id; public views get only published responses not hidden by a report */
  async responses(targetType: 'product_review' | 'seller_feedback', targetIds: readonly string[], internal: boolean): Promise<Map<string, SellerResponse>> {
    const rows = await this.core.repo.responsesFor(targetType, targetIds);
    const hidden = internal ? new Set<string>() : await this.core.repo.hiddenByReport('seller_response', rows.map((r) => r.id));
    const visible = rows.filter((r) => internal || (r.status === 'published' && !hidden.has(r.id)));
    const names = await this.core.sellerNames(visible.map((r) => r.seller_id));
    return new Map(visible.map((r) => [r.target_id, this.responseOut(r, this.core.sellerName(names, r.seller_id), internal)]));
  }

  /* ---------------------------------------------------------------- product reviews */

  reviewAuthor(r: ReviewRec): Author {
    return { kind: 'customer', displayName: r.show_name ? r.display_name : ANONYMOUS_REVIEWER, sellerId: null, verifiedPurchase: r.verified };
  }

  async reviews(rows: readonly ReviewRec[], o: { viewerCustomerId?: string | null; internal?: boolean } = {}): Promise<ProductReview[]> {
    if (!rows.length) return [];
    const internal = Boolean(o.internal);
    const viewer = o.viewerCustomerId;
    const [products, names, media, responses, voted, reported] = await Promise.all([
      this.core.products(rows.map((r) => r.product_id)),
      this.core.sellerNames(rows.map((r) => r.seller_id)),
      this.core.mediaRefs(rows.flatMap((r) => (r.media_ids as string[]) ?? [])),
      this.responses('product_review', rows.map((r) => r.id), internal),
      viewer ? this.core.repo.votedHelpful('product_review', rows.map((r) => r.id), viewer) : Promise.resolve(null),
      viewer ? this.core.repo.reportedBy('product_review', rows.map((r) => r.id), { kind: 'customer', id: viewer }).then((ids) => new Set(ids)) : Promise.resolve(null),
    ]);
    return rows.map((r) => ({
      id: r.id,
      productId: r.product_id,
      variantLabel: this.core.variantLabel(products.get(r.product_id), r.variant_id),
      author: this.reviewAuthor(r),
      rating: r.rating,
      headline: r.headline,
      text: r.body,
      media: ((r.media_ids as string[]) ?? []).map((id) => media.get(id)).filter((m): m is common.MediaRef => Boolean(m)),
      soldBy: { sellerId: r.seller_id, name: this.core.sellerName(names, r.seller_id) },
      reviewedAt: (r.published_at ?? r.created_at).toISOString(),
      editedAt: r.edited_at?.toISOString() ?? null,
      helpfulCount: r.helpful_count,
      viewerVotedHelpful: voted ? voted.has(r.id) : null,
      viewerReported: reported ? reported.has(r.id) : null,
      response: responses.get(r.id) ?? null,
    }));
  }

  /* ---------------------------------------------------------------- moderation outcomes (author's view) */

  async outcomes(contentType: string, contents: readonly { id: string; status: string }[]): Promise<Map<string, Outcome>> {
    const out = new Map<string, Outcome>();
    if (!contents.length) return out;
    const ids = contents.map((c) => c.id);
    const repo = this.core.repo;
    const [items, appeals, targetHours] = await Promise.all([
      repo.find('moderation_items', { content_type: contentType, content_id: ids }, { orderBy: [['first_reported_at', 'desc']] }),
      repo.find('appeals', { content_type: contentType, content_id: ids }, { orderBy: [['submitted_at', 'desc']] }),
      this.core.num('moderationTargetHours'),
    ]);
    const decisions = await repo.find('moderation_decisions', { moderation_item_id: items.map((i) => i.id) }, { orderBy: [['decided_at', 'desc']] });
    // per content, the first in each list's order: its open item, latest decision and latest appeal
    const contentOf = new Map(items.map((i) => [i.id, i.content_id]));
    const openBy = new Map<string, ItemRec>();
    for (const i of items) if (i.status === 'open' && !openBy.has(i.content_id)) openBy.set(i.content_id, i);
    const decisionBy = new Map<string, DecisionRec>();
    for (const d of decisions) {
      const content = contentOf.get(d.moderation_item_id)!;
      if (!decisionBy.has(content)) decisionBy.set(content, d);
    }
    const appealBy = new Map<string, AppealRec>();
    for (const a of appeals) if (!appealBy.has(a.content_id)) appealBy.set(a.content_id, a);
    const appealedDecisions = new Set(appeals.map((a) => a.decision_id));
    const now = this.core.now();
    for (const c of contents) {
      const open = openBy.get(c.id) ?? null;
      const decision = decisionBy.get(c.id) ?? null;
      const appeal = appealBy.get(c.id) ?? null;
      let moderation: ModerationOutcome | null = null;
      const underReview = open && (open.visibility === 'hidden' || ['held', 'pending', 'pending_review'].includes(c.status)) && open.queue !== 'appeal';
      if (underReview) {
        const reasons = ((open.reasons as string[]) ?? []).map((r) => REPORT_REASON_LABEL[r] ?? r);
        moderation = {
          decision: 'hidden_pending_review',
          reasonCode: ((open.reasons as string[]) ?? [])[0] ?? null,
          reasonText: reasons.length ? `Hidden while we check it (${reasons.join(', ').toLowerCase()}).` : 'Hidden while we check it.',
          decidedAt: null,
          expectedBy: addDays(open.first_reported_at, targetHours / 24).toISOString(),
          appealBy: null,
          appealable: false,
        };
      } else if (decision) {
        const appealed = appealedDecisions.has(decision.id);
        const appealable = ADVERSE.has(decision.decision) && Boolean(decision.appeal_by) && now <= decision.appeal_by! && !appealed && ADVERSE_STATES.has(c.status);
        const base = decision.message_to_author ?? AUTHOR_TEXT[decision.reason_code] ?? reasonLabel(decision.reason_code);
        moderation = {
          decision: OUTCOME_OF[decision.decision] ?? 'kept',
          reasonCode: decision.reason_code,
          reasonText: decision.decision === 'request_edit' && decision.edit_request ? `${base} Please change: ${decision.edit_request}` : base,
          decidedAt: decision.decided_at.toISOString(),
          expectedBy: null,
          appealBy: decision.appeal_by?.toISOString() ?? null,
          appealable,
        };
      }
      out.set(c.id, { moderation, appeal: appeal ? appealView(appeal) : null, decision, openItem: open });
    }
    return out;
  }

  /* ---------------------------------------------------------------- my reviews */

  async myReviews(rows: readonly ReviewRec[], viewerCustomerId: string | null): Promise<MyReview[]> {
    if (!rows.length) return [];
    const [reviews, products, outcomes] = await Promise.all([
      this.reviews(rows, { viewerCustomerId, internal: false }),
      this.core.products(rows.map((r) => r.product_id)),
      this.outcomes('product_review', rows),
    ]);
    return rows.map((r, i) => {
      const o = outcomes.get(r.id);
      const p = products.get(r.product_id);
      const status = r.status as MyReview['status'];
      const byEnforcement = o?.decision?.reason_code === 'proven_fake' && status === 'removed';
      return {
        review: reviews[i]!,
        status,
        statusLabel: REVIEW_STATUS_LABEL[r.status] ?? r.status,
        visibleToShoppers: r.status === 'published' && r.visible,
        productTitle: p?.title ?? 'Product',
        productImageUrl: validUrl(this.core.productImage(p)?.url),
        orderItemId: r.order_item_id,
        moderation: o?.moderation ?? null,
        appeal: o?.appeal ?? null,
        canEdit: !byEnforcement && (['submit', 'edit', 'resubmit'] as const).some((e) => productReviewMachine.can(status, e)),
        canDelete: productReviewMachine.can(status, 'delete'),
        canAppeal: Boolean(o?.moderation?.appealable),
      };
    });
  }

  /* ---------------------------------------------------------------- seller feedback */

  feedbackAuthor(f: FeedbackRec): Author {
    return { kind: 'customer', displayName: f.display_name, sellerId: null, verifiedPurchase: true };
  }

  /** internal: the order reference and package label (the author, the seller and staff) */
  async feedback(rows: readonly FeedbackRec[], o: { internal?: boolean } = {}): Promise<SellerFeedback[]> {
    if (!rows.length) return [];
    const [names, orders, responses] = await Promise.all([
      this.core.sellerNames(rows.map((r) => r.seller_id)),
      this.core.orders(rows.map((r) => r.order_id)),
      this.responses('seller_feedback', rows.map((r) => r.id), Boolean(o.internal)),
    ]);
    return rows.map((r) => {
      const order = orders.get(r.order_id);
      const pkg = this.core.packageFor(order, r.seller_id);
      return {
        id: r.id,
        sellerId: r.seller_id,
        sellerName: this.core.sellerName(names, r.seller_id),
        orderId: r.order_id,
        orderRef: o.internal ? (order?.ref ?? null) : null,
        packageLabel: o.internal ? (pkg?.packageLabel ?? null) : null,
        author: this.feedbackAuthor(r),
        dimensions: { asDescribed: r.as_described, dispatchRating: r.dispatch_rating, communicationRating: r.communication_rating },
        overall: r.overall,
        sentiment: r.sentiment as SellerFeedback['sentiment'],
        comment: r.comment,
        itemTitle: this.core.itemTitle(pkg),
        postedAt: r.created_at.toISOString(),
        editedAt: r.edited_at?.toISOString() ?? null,
        response: responses.get(r.id) ?? null,
      };
    });
  }

  async myFeedback(rows: readonly FeedbackRec[]): Promise<MyFeedback[]> {
    if (!rows.length) return [];
    const [list, outcomes, publicResponses] = await Promise.all([this.feedback(rows, { internal: true }), this.outcomes('seller_feedback', rows), this.responses('seller_feedback', rows.map((r) => r.id), false)]);
    return rows.map((r, i) => {
      const status = r.status as MyFeedback['status'];
      return {
        feedback: { ...list[i]!, response: publicResponses.get(r.id) ?? null },
        status,
        statusLabel: FEEDBACK_STATUS_LABEL[r.status] ?? r.status,
        moderation: outcomes.get(r.id)?.moderation ?? null,
        canEdit: (['submit', 'edit'] as const).some((e) => sellerFeedbackMachine.can(status, e)),
        canDelete: sellerFeedbackMachine.can(status, 'delete'),
      };
    });
  }

  /* ---------------------------------------------------------------- questions and answers */

  answerAuthor(a: AnswerRec): Author {
    return { kind: a.author_kind as Author['kind'], displayName: a.display_name, sellerId: a.seller_id, verifiedPurchase: false };
  }

  /** voted: the viewer's helpful votes on answers (store lists with a customer session), else null */
  answerOut(a: AnswerRec, voted: Set<string> | null = null): Answer {
    return {
      id: a.id,
      questionId: a.question_id,
      text: a.text,
      by: this.answerAuthor(a),
      label: a.author_kind === 'seller' ? 'seller' : a.author_kind === 'staff' ? 'marketly_staff' : 'customer',
      answeredAt: (a.published_at ?? a.created_at).toISOString(),
      helpfulCount: a.helpful_count,
      viewerVotedHelpful: voted ? voted.has(a.id) : null,
      status: a.status as Answer['status'],
    };
  }

  /**
   * publicOnly: published answers not hidden by a report. answerExpectation is given while no answer is
   * published, from the product's main offer (offers, optional).
   */
  async questions(rows: readonly QuestionRec[], o: { publicOnly: boolean; viewerCustomerId?: string | null }): Promise<Question[]> {
    if (!rows.length) return [];
    const [answers, products] = await Promise.all([this.core.repo.answersOf(rows.map((q) => q.id), { publicOnly: o.publicOnly }), this.core.products(rows.map((q) => q.product_id))]);
    // answers by question, in their order (helpful first)
    const answersBy = new Map<string, AnswerRec[]>();
    for (const a of answers) {
      const list = answersBy.get(a.question_id);
      if (list) list.push(a);
      else answersBy.set(a.question_id, [a]);
    }
    const hasPublished = (questionId: string) => (answersBy.get(questionId) ?? []).some((a) => a.status === 'published');
    const unanswered = rows.filter((q) => !hasPublished(q.id));
    const [voted, expectations] = await Promise.all([
      o.viewerCustomerId ? this.core.repo.votedHelpful('answer', answers.map((a) => a.id), o.viewerCustomerId) : null,
      this.expectations([...new Set(unanswered.map((q) => q.product_id))]),
    ]);
    return rows.map((q) => {
      const own = answersBy.get(q.id) ?? [];
      return {
        id: q.id,
        productId: q.product_id,
        productTitle: products.get(q.product_id)?.title ?? null,
        text: q.text,
        askedBy: q.display_name,
        askedAt: q.created_at.toISOString(),
        status: q.status as Question['status'],
        answers: own.map((a) => this.answerOut(a, voted)),
        answerCount: q.answer_count,
        answerExpectation: hasPublished(q.id) ? null : (expectations.get(q.product_id) ?? null),
      };
    });
  }

  /** "The Official Store usually answers within 1 business day." from the main offer's seller */
  async expectations(productIds: readonly string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (!productIds.length) return out;
    const [days, offers] = await Promise.all([
      this.core.num('questionAnswerTargetBusinessDays'),
      this.core.optional('offers', (api) => api.getFeaturedOfferForProduct(productIds.map((productId) => ({ productId })))),
    ]);
    if (!offers) return out;
    const sellerIds = Object.values(offers).flatMap((o) => (o && o.ownerType === 'seller' && o.sellerId ? [o.sellerId] : []));
    const names = await this.core.sellerNames(sellerIds);
    const within = `${days} business day${days === 1 ? '' : 's'}`;
    for (const id of productIds) {
      const offer = offers[id];
      if (!offer) continue;
      const who = offer.ownerType === 'official' ? 'The Official Store' : (names.get(offer.sellerId ?? '') ?? offer.sellerName ?? 'The seller');
      out.set(id, `${who} usually answers within ${within}.`);
    }
    return out;
  }

  officialName = () => OFFICIAL_STORE_NAME;
  officialId = () => OFFICIAL_STORE_ID;
}
