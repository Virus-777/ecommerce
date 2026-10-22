/**
 * The five kinds of moderated content behind one interface: load, author, public visibility and state
 * changes (through the spec's machines), with the events and summary refreshes each change implies.
 */
import { isUuid } from '../../../kernel/lib/ids.js';
import type { ContentType } from '../domain/rules.js';
import { answerMachine, productReviewMachine, questionMachine, sellerFeedbackMachine, sellerResponseMachine } from '../domain/state-machines.js';
import { apply, oneStep, walk } from '../domain/transitions.js';
import type { AnswerRec, FeedbackRec, QuestionRec, ResponseRec, ReviewRec } from '../ports.js';
import type { ReviewsRepository } from '../repository.js';
import type { Core, Effects } from './core.js';

export type Content =
  | { type: 'product_review'; row: ReviewRec }
  | { type: 'seller_feedback'; row: FeedbackRec }
  | { type: 'question'; row: QuestionRec }
  | { type: 'answer'; row: AnswerRec }
  | { type: 'seller_response'; row: ResponseRec };

const TABLE = {
  product_review: 'product_reviews',
  seller_feedback: 'seller_feedback',
  question: 'questions',
  answer: 'answers',
  seller_response: 'seller_responses',
} as const;

export const CONTENT_TYPES = Object.keys(TABLE) as ContentType[];

export async function loadContent(repo: ReviewsRepository, type: string, id: string, o: { forUpdate?: boolean } = {}): Promise<Content | undefined> {
  if (!isUuid(id) || !(type in TABLE)) return undefined;
  const row = await repo.get(TABLE[type as ContentType], id, o);
  return row ? ({ type, row } as Content) : undefined;
}

/** Finds content by id when the type is not known (trust enforcement targets) */
export async function findContent(repo: ReviewsRepository, id: string, types: readonly ContentType[] = CONTENT_TYPES): Promise<Content | undefined> {
  for (const t of types) {
    const c = await loadContent(repo, t, id);
    if (c) return c;
  }
  return undefined;
}

/** Who wrote it: customer id, seller id or staff account id */
export function authorOf(c: Content): { kind: 'customer' | 'seller' | 'staff'; id: string } {
  switch (c.type) {
    case 'product_review':
    case 'seller_feedback':
    case 'question':
      return { kind: 'customer', id: c.row.customer_id };
    case 'answer':
      return { kind: c.row.author_kind as 'customer' | 'seller' | 'staff', id: c.row.author_kind === 'seller' ? (c.row.seller_id ?? c.row.author_id) : c.row.author_id };
    case 'seller_response':
      return { kind: 'seller', id: c.row.seller_id };
  }
}

/** Published to shoppers (reports are only taken on content people can see) */
export function isPublic(c: Content): boolean {
  switch (c.type) {
    case 'product_review':
    case 'seller_feedback':
      return c.row.status === 'published' && c.row.visible;
    default:
      return c.row.status === 'published';
  }
}

export function machineOf(type: ContentType) {
  switch (type) {
    case 'product_review':
      return productReviewMachine;
    case 'seller_feedback':
      return sellerFeedbackMachine;
    case 'answer':
      return answerMachine;
    case 'seller_response':
      return sellerResponseMachine;
    case 'question':
      return questionMachine;
    default:
      return null;
  }
}

/** The product a piece of content is about (null for seller feedback and responses to it) */
export async function productOf(repo: ReviewsRepository, c: Content): Promise<string | null> {
  switch (c.type) {
    case 'product_review':
    case 'question':
      return c.row.product_id;
    case 'answer':
      return (await repo.get('questions', c.row.question_id))?.product_id ?? null;
    case 'seller_response':
      if (c.row.target_type !== 'product_review') return null;
      return (await repo.get('product_reviews', c.row.target_id))?.product_id ?? null;
    default:
      return null;
  }
}

export interface StateChange {
  byModeration: boolean;
  reasonCode?: string | null;
  /** Take down the review's photos (media moderation) */
  takedown?: boolean;
  /** One state move only (moderation decisions); otherwise the shortest chain of allowed events */
  oneStep?: boolean;
  /** The trust enforcement the change executes or undoes (reviews.review.removed carries it) */
  trustEnforcementId?: string | null;
}

/**
 * Moves content to `target` along the events allowed, updating the row and recording the events and
 * summary refreshes. Inside the caller's transaction.
 */
export async function moveContent(core: Core, tx: ReviewsRepository, fx: Effects, c: Content, target: string, events: readonly string[], change: StateChange): Promise<Content> {
  const now = core.now();
  const from = c.row.status;
  if (from === target) return c;
  const machine = machineOf(c.type);
  if (machine) {
    const path = (change.oneStep ? oneStep : walk)(machine as never, from as never, target as never, events);
    apply(machine as never, from as never, path as never);
  }
  switch (c.type) {
    case 'product_review': {
      const visible = target === 'published';
      const row = await tx.update('product_reviews', c.row.id, { status: target, visible, ...(visible && !c.row.published_at ? { published_at: now } : {}) });
      await core.touchProduct(tx, fx, row.product_id);
      if (visible) fx.emit('reviews.review.published', { reviewId: row.id, productId: row.product_id, sellerId: row.seller_id, customerId: row.customer_id, rating: row.rating, verified: row.verified });
      if (target === 'removed' || target === 'deleted') {
        if (from !== 'draft')
          fx.emit('reviews.review.removed', { reviewId: row.id, productId: row.product_id, sellerId: row.seller_id, customerId: row.customer_id, byModeration: change.byModeration, reasonCode: change.reasonCode ?? null, trustEnforcementId: change.trustEnforcementId ?? null });
        const media = (row.media_ids as string[]) ?? [];
        if (change.takedown) fx.takedown.push(...media);
        else if (target === 'deleted') fx.detach.push(...media.map((assetId) => ({ assetId, refId: row.id })));
      }
      return { type: c.type, row };
    }
    case 'seller_feedback': {
      const visible = target === 'published';
      const row = await tx.update('seller_feedback', c.row.id, { status: target, visible });
      await core.touchSeller(tx, fx, row.seller_id);
      if (visible) fx.emit('reviews.feedback.published', { feedbackId: row.id, sellerId: row.seller_id, orderId: row.order_id, sentiment: row.sentiment });
      if ((target === 'removed' || target === 'deleted') && (from === 'published' || from === 'held')) fx.emit('reviews.feedback.removed', { feedbackId: row.id, sellerId: row.seller_id });
      return { type: c.type, row };
    }
    case 'question': {
      const row = await tx.update('questions', c.row.id, { status: target });
      await core.touchProduct(tx, fx, row.product_id);
      // sellerIds and officialStore are filled from offers after the commit (Core.flush)
      if (target === 'published' && from === 'pending_review') fx.emit('reviews.question.asked', { questionId: row.id, productId: row.product_id, customerId: row.customer_id, sellerIds: [], officialStore: false });
      return { type: c.type, row };
    }
    case 'answer': {
      const published = target === 'published';
      const row = await tx.update('answers', c.row.id, { status: target, ...(published && !c.row.published_at ? { published_at: now } : {}) });
      const question = await syncAnswerCount(tx, row.question_id);
      if (question) await core.touchProduct(tx, fx, question.product_id);
      if (published && question) fx.emit('reviews.answer.published', answerPublished(row, question));
      return { type: c.type, row };
    }
    case 'seller_response': {
      const published = target === 'published';
      const row = await tx.update('seller_responses', c.row.id, { status: target, ...(published ? { published_at: c.row.published_at ?? now } : {}) });
      const payload = published ? await responsePublished(tx, row) : null;
      if (payload) fx.emit('reviews.response.published', payload);
      return { type: c.type, row };
    }
  }
}

/** reviews.answer.published: the asker is told; sellerId for seller answers */
export const answerPublished = (a: AnswerRec, q: QuestionRec) => ({ answerId: a.id, questionId: q.id, productId: q.product_id, label: labelOf(a), askerCustomerId: q.customer_id, sellerId: a.author_kind === 'seller' ? a.seller_id : null });

/** reviews.response.published: the author of the review or feedback being answered is told */
export async function responsePublished(repo: ReviewsRepository, r: ResponseRec) {
  const target = r.target_type === 'product_review' ? await repo.get('product_reviews', r.target_id) : await repo.get('seller_feedback', r.target_id);
  return target ? { responseId: r.id, sellerId: r.seller_id, targetType: r.target_type, targetId: r.target_id, status: r.status, customerId: target.customer_id } : null;
}

export const labelOf = (a: AnswerRec) =>(a.author_kind === 'seller' ? 'seller' : a.author_kind === 'staff' ? 'marketly_staff' : 'customer');

/** questions.answer_count = published answers */
export async function syncAnswerCount(tx: ReviewsRepository, questionId: string): Promise<QuestionRec | undefined> {
  const n = await tx.count('answers', { question_id: questionId, status: 'published' });
  const q = await tx.get('questions', questionId);
  if (!q) return undefined;
  return q.answer_count === n ? q : tx.update('questions', questionId, { answer_count: n });
}
