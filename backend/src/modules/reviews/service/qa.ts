/**
 * Product questions and answers, labelled Seller, Marketly staff or Customer. Only sellers with an offer on
 * the product answer as seller; order-specific questions go to order messages.
 */
import { isUuid, newId } from '../../../kernel/lib/ids.js';
import { pageOf, type PageRequest } from '../../../kernel/lib/pagination.js';
import type * as common from '../../../spec/common.js';
import type * as offers from '../../../spec/offers.js';
import type { AdminQuestionRow, Answer, Question, SellerQuestionRow } from '../../../spec/reviews.js';
import { ageLabel, isOrderSpecific, qaChecks } from '../domain/rules.js';
import { answerMachine } from '../domain/state-machines.js';
import type { AnswerRec, QuestionRec } from '../ports.js';
import { answerPublished, syncAnswerCount } from './content.js';
import { type By, type Core, type CustomerWho, Effects, invalid, notFound, type SellerWho } from './core.js';
import type { FeedbackPart } from './feedback.js';
import type { ModerationPart } from './moderation.js';
import type { Views } from './views.js';

const MIN_QUESTION = 10;
const MAX_TEXT = 1000;
/** Offers read to find the products a seller (or the Official Store) offers */
const OFFER_PAGES = 10;
const LIVE_OFFER = ['active', 'paused', 'out_of_stock'];

type Author = { kind: 'customer'; customerId: string } | { kind: 'seller'; sellerId: string } | { kind: 'staff'; accountId: string; secondCheck: boolean };

export class QaPart {
  feedback!: FeedbackPart;

  constructor(
    private readonly core: Core,
    private readonly views: Views,
    private readonly moderation: ModerationPart,
  ) {}

  /* ================================================================ public */

  /** state answered: with a published answer; awaiting: none yet. viewerCustomerId fills Answer.viewerVotedHelpful */
  async listPublic(
    productId: string,
    search: string | null,
    sort: string | undefined,
    page: PageRequest,
    o: { state?: 'answered' | 'awaiting'; viewerCustomerId?: string | null } = {},
  ): Promise<common.Page<Question>> {
    if (!isUuid(productId)) return pageOf([], page);
    const rows = await this.core.repo.listQuestions(
      {
        productId,
        publicOnly: true,
        ...(search?.trim() ? { q: search } : {}),
        ...(o.state ? { answered: o.state === 'answered' } : {}),
        sort: sort === 'newest' ? 'newest' : 'most_helpful',
      },
      page,
    );
    return { ...rows, items: await this.views.questions(rows.items, { publicOnly: true, viewerCustomerId: o.viewerCustomerId ?? null }) };
  }

  private textIssues(text: string, min: number) {
    const t = text?.trim() ?? '';
    if (t.length < min) return [{ path: 'text', message: min > 1 ? `Write at least ${min} characters` : 'Write your answer' }];
    if (t.length > MAX_TEXT) return [{ path: 'text', message: `Keep it under ${MAX_TEXT.toLocaleString('en-US')} characters` }];
    return [];
  }

  async ask(who: CustomerWho, productId: string, text: string): Promise<Question> {
    if (!who.customerId) throw notFound('Product');
    const product = isUuid(productId) ? await this.core.product(productId) : null;
    if (!product) throw notFound('Product');
    const issues = this.textIssues(text, MIN_QUESTION);
    if (issues.length) throw invalid(issues);
    if (isOrderSpecific(text)) throw invalid([{ path: 'text', message: 'Questions about your order go to the seller in order messages (Your orders → Contact seller)' }], 'This looks like a question about an order');
    const failures = qaChecks(text);
    const displayName = await this.core.shortNameOf(who.customerId);
    const fx = await this.core.prepare(new Effects());
    const now = this.core.now();
    const row = await this.core.repo.transaction(async (tx) => {
      const q = await tx.insert('questions', {
        id: newId(),
        product_id: productId,
        customer_id: who.customerId!,
        display_name: displayName,
        text: text.trim(),
        status: failures.length ? 'pending_review' : 'published',
        answer_count: 0,
        created_at: now,
      });
      if (failures.length) await this.moderation.hold(tx, { type: 'question', id: q.id }, failures);
      else fx.emit('reviews.question.asked', { questionId: q.id, productId, customerId: q.customer_id, sellerIds: [], officialStore: false });
      return q;
    });
    await this.core.flush(fx, who);
    return (await this.views.questions([row], { publicOnly: false }))[0]!;
  }

  /* ================================================================ answers */

  private async answer(questionId: string, text: string, author: Author, by: By): Promise<Answer> {
    const repo = this.core.repo;
    const question = isUuid(questionId) ? await repo.get('questions', questionId) : undefined;
    if (!question || question.status !== 'published' || (author.kind !== 'staff' && (await repo.hiddenByReport('question', [question.id])).size)) throw notFound('Question');
    if (author.kind === 'customer' && question.customer_id === author.customerId) throw invalid([{ path: 'text', message: 'You asked this question: other shoppers and the seller will answer it' }]);
    const issues = this.textIssues(text, 2);
    if (issues.length) throw invalid(issues);
    let displayName: string;
    let sellerId: string | null = null;
    if (author.kind === 'seller') {
      if (!(await this.offersProduct(author.sellerId, question.product_id))) throw this.core.ctx.error('NOT_AN_OFFER_SELLER', 'Only sellers with an offer on this product can answer as the seller.');
      if (await this.feedback.sellerClosed(author.sellerId)) throw this.core.ctx.error('NOT_AN_OFFER_SELLER', 'Closed seller accounts cannot answer questions.');
      sellerId = author.sellerId;
      displayName = (await this.core.sellerNames([author.sellerId])).get(author.sellerId) ?? 'Seller';
    } else if (author.kind === 'staff') {
      displayName = 'Marketly staff';
    } else {
      displayName = await this.core.shortNameOf(author.customerId);
    }
    const failures = qaChecks(text);
    const secondCheck = author.kind === 'staff' && author.secondCheck;
    const status = failures.length || secondCheck ? 'pending_review' : answerMachine.next('pending_review', 'publish');
    const fx = await this.core.prepare(new Effects());
    const now = this.core.now();
    const row = await repo.transaction(async (tx) => {
      const a = await tx.insert('answers', {
        id: newId(),
        question_id: question.id,
        author_kind: author.kind,
        author_id: author.kind === 'customer' ? author.customerId : author.kind === 'seller' ? author.sellerId : author.accountId,
        seller_id: sellerId,
        display_name: displayName,
        text: text.trim(),
        status,
        rule_check: { passed: !failures.length, failures: failures.map((f) => f.label) },
        helpful_count: 0,
        created_at: now,
        published_at: status === 'published' ? now : null,
      });
      if (status === 'published') {
        await syncAnswerCount(tx, question.id);
        await this.core.touchProduct(tx, fx, question.product_id);
        fx.emit('reviews.answer.published', answerPublished(a, question));
      } else {
        await this.moderation.hold(tx, { type: 'answer', id: a.id }, failures.length ? failures : [{ label: 'Second check requested for a staff answer', reason: 'other' }]);
      }
      return a;
    });
    await this.core.flush(fx, by);
    return this.views.answerOut(row);
  }

  answerAsCustomer(who: CustomerWho, questionId: string, text: string) {
    if (!who.customerId) throw notFound('Question');
    return this.answer(questionId, text, { kind: 'customer', customerId: who.customerId }, who);
  }

  answerAsSeller(who: SellerWho, questionId: string, text: string) {
    return this.answer(questionId, text, { kind: 'seller', sellerId: who.sellerId }, who);
  }

  async answerAsStaff(by: By, questionId: string, body: { text: string; secondCheck?: boolean | null }): Promise<Answer> {
    const answer = await this.answer(questionId, body.text, { kind: 'staff', accountId: by.actor.id ?? 'staff', secondCheck: Boolean(body.secondCheck) }, by);
    const q = await this.core.repo.get('questions', questionId);
    await this.core.audit(
      {
        action: 'reviews.answer.staff',
        actionLabel: answer.status === 'published' ? 'Answered a product question as Marketly staff' : 'Answered a product question as Marketly staff (waiting for a second check)',
        category: 'content',
        target: { type: 'question', id: questionId, label: q?.text.slice(0, 80) ?? null },
        relatedTargets: [{ type: 'answer', id: answer.id }, ...(q ? [{ type: 'product', id: q.product_id }] : [])],
        after: { text: answer.text, status: answer.status },
      },
      by,
    );
    return answer;
  }

  /**
   * The author edits an answer: a published answer goes back through the automatic checks (edit), one with an edit
   * request is fixed and resubmitted for review (resubmit). Only the author's own answers (others: NOT_FOUND).
   */
  async editAnswer(author: { kind: 'customer'; customerId: string } | { kind: 'seller'; sellerId: string }, id: string, text: string, by: By): Promise<Answer> {
    const repo = this.core.repo;
    const own = (a: AnswerRec | undefined) => !!a && (author.kind === 'customer' ? a.author_kind === 'customer' && a.author_id === author.customerId : a.author_kind === 'seller' && (a.seller_id ?? a.author_id) === author.sellerId);
    const before = isUuid(id) ? await repo.get('answers', id) : undefined;
    if (!before || !own(before)) throw notFound('Answer');
    const issues = this.textIssues(text, 2);
    if (issues.length) throw invalid(issues);
    const event = before.status === 'edit_requested' ? 'resubmit' : 'edit';
    answerMachine.next(before.status as Answer['status'], event);
    const failures = qaChecks(text);
    const fx = await this.core.prepare(new Effects());
    const now = this.core.now();
    const row = await repo.transaction(async (tx) => {
      const locked = (await tx.get('answers', id, { forUpdate: true }))!;
      const pending = answerMachine.next(locked.status as Answer['status'], event);
      // an edited published answer that passes the checks is published again; a resubmission waits for review
      const status = event === 'edit' && !failures.length ? answerMachine.next(pending, 'publish') : pending;
      const a = await tx.update('answers', id, {
        text: text.trim(),
        status,
        rule_check: { passed: !failures.length, failures: failures.map((f) => f.label) },
        ...(status === 'published' ? { published_at: now } : {}),
      });
      const question = await syncAnswerCount(tx, a.question_id);
      if (question) await this.core.touchProduct(tx, fx, question.product_id);
      if (status === 'published' && question) fx.emit('reviews.answer.published', answerPublished(a, question));
      else await this.moderation.hold(tx, { type: 'answer', id }, failures.length ? failures : [{ label: 'Resubmitted after an edit request', reason: 'other' }]);
      return a;
    });
    await this.core.flush(fx, by);
    return this.views.answerOut(row);
  }

  /* ================================================================ offers */

  /** The seller has a live offer on the product (offers, optional: without it nobody answers as seller) */
  async offersProduct(sellerId: string, productId: string): Promise<boolean> {
    const own = await this.core.optional('offers', (o) => o.listOwnOffersForProduct(sellerId, [productId]));
    return Boolean(own?.[productId]?.some((x) => LIVE_OFFER.includes(x.status)));
  }

  /** Products a seller (or the Official Store) offers, with the seller's SKU per product */
  async offeredProducts(filter: { sellerId?: string; official?: boolean }): Promise<Map<string, offers.Offer> | null> {
    const api = this.core.ctx.tryUse('offers');
    if (!api) return null;
    const out = new Map<string, offers.Offer>();
    let cursor: string | undefined;
    try {
      for (let i = 0; i < OFFER_PAGES; i++) {
        const page = await api.listOffersAdmin({ ...filter, status: LIVE_OFFER }, { limit: 100, ...(cursor ? { cursor } : {}) });
        for (const o of page.items) if (!out.has(o.productId)) out.set(o.productId, o);
        if (!page.nextCursor || !page.items.length) break;
        cursor = page.nextCursor;
      }
    } catch (err) {
      this.core.ctx.log.warn({ err }, 'reviews: offers could not list offered products');
      return null;
    }
    return out;
  }

  /* ================================================================ seller and admin lists */

  async listForSeller(sellerId: string, filter: { state?: string; productId?: string }, page: PageRequest): Promise<common.Page<SellerQuestionRow>> {
    const offered = (await this.offeredProducts({ sellerId })) ?? new Map<string, offers.Offer>();
    let productIds = [...offered.keys()];
    if (filter.productId) productIds = productIds.filter((id) => id === filter.productId);
    const state = filter.state ?? 'open';
    const skipped = await this.core.repo.skippedQuestionIds(sellerId);
    const rows = await this.core.repo.listQuestions(
      {
        productIds,
        publicOnly: true,
        ...(state === 'open' || state === 'answered' ? { answeredBySeller: { sellerId, value: state === 'answered' } } : {}),
        ...(state === 'open' ? { excludeIds: skipped } : {}),
        ...(state === 'skipped' ? { ids: skipped } : {}),
        sort: state === 'open' ? 'oldest' : 'newest',
      },
      page,
    );
    return { ...rows, items: await this.sellerRows(sellerId, rows.items, offered, new Set(skipped)) };
  }

  private async sellerRows(sellerId: string, rows: readonly QuestionRec[], offered: Map<string, offers.Offer>, skipped: Set<string>): Promise<SellerQuestionRow[]> {
    const [questions, products] = await Promise.all([this.views.questions(rows, { publicOnly: true }), this.core.products(rows.map((q) => q.product_id))]);
    return questions.map((question) => {
      const answered = question.answers.some((a) => a.label === 'seller' && a.by.sellerId === sellerId && a.status === 'published');
      return {
        question,
        productImage: this.core.productImage(products.get(question.productId)),
        offerSku: offered.get(question.productId)?.sellerSku ?? null,
        needsAnswer: !answered && !skipped.has(question.id),
        skipped: skipped.has(question.id),
      };
    });
  }

  /**
   * The seller skips (skip = true) or un-skips a question on a product it offers. Only the seller's own open list
   * changes; the question stays published for everyone else.
   */
  async setSkipped(who: SellerWho, questionId: string, skip: boolean): Promise<SellerQuestionRow> {
    const repo = this.core.repo;
    const question = isUuid(questionId) ? await repo.get('questions', questionId) : undefined;
    if (!question || question.status !== 'published' || (await repo.hiddenByReport('question', [question.id])).size) throw notFound('Question');
    const offered = (await this.offeredProducts({ sellerId: who.sellerId })) ?? new Map<string, offers.Offer>();
    if (!offered.has(question.product_id)) throw notFound('Question');
    if (skip) await repo.skipQuestion({ id: newId(), seller_id: who.sellerId, question_id: question.id, skipped_by: who.actor.id ?? 'seller', created_at: this.core.now() });
    else await repo.unskipQuestion(who.sellerId, question.id);
    return (await this.sellerRows(who.sellerId, [question], offered, new Set(skip ? [question.id] : [])))[0]!;
  }

  async listForAdmin(
    filter: { owner?: 'official' | 'seller'; sellerId?: string; productId?: string; answered?: boolean; q?: string; sort?: 'oldest_unanswered' | 'newest' },
    page: PageRequest,
  ): Promise<common.Page<AdminQuestionRow>> {
    let productIds: string[] | undefined;
    const restrict = async (f: { sellerId?: string; official?: boolean }) => {
      const set = [...((await this.offeredProducts(f)) ?? new Map()).keys()];
      productIds = productIds ? productIds.filter((id) => set.includes(id)) : set;
    };
    if (filter.owner === 'official') await restrict({ official: true });
    if (filter.owner === 'seller') await restrict({ official: false });
    if (filter.sellerId) await restrict({ sellerId: filter.sellerId });
    if (filter.productId) productIds = productIds ? productIds.filter((id) => id === filter.productId) : [filter.productId];
    const rows = await this.core.repo.listQuestions(
      {
        ...(productIds ? { productIds } : {}),
        statuses: ['published', 'pending_review'],
        ...(filter.answered !== undefined ? { answered: filter.answered } : {}),
        ...(filter.q?.trim() ? { q: filter.q } : {}),
        sort: filter.sort === 'newest' ? 'newest' : 'oldest_unanswered',
      },
      page,
    );
    const ids = [...new Set(rows.items.map((q) => q.product_id))];
    const [questions, products, owners] = await Promise.all([this.views.questions(rows.items, { publicOnly: false }), this.core.products(ids), this.owners(ids)]);
    const now = this.core.now();
    return {
      ...rows,
      items: questions.map((question, i) => {
        const published = question.answers.filter((a) => a.status === 'published');
        const needsAnswer = !published.length;
        return {
          question,
          productImage: this.core.productImage(products.get(question.productId)),
          owner: owners.get(question.productId) ?? 'seller',
          hasSellerAnswer: published.some((a) => a.label === 'seller'),
          hasStaffAnswer: published.some((a) => a.label === 'marketly_staff'),
          needsAnswer,
          waiting: needsAnswer ? ageLabel(rows.items[i]!.created_at, now) : null,
        };
      }),
    };
  }

  /** Who offers each product: the Official Store, marketplace sellers, or both */
  private async owners(productIds: readonly string[]): Promise<Map<string, 'official' | 'seller' | 'both'>> {
    const out = new Map<string, 'official' | 'seller' | 'both'>();
    await this.core.optional('offers', async (api) => {
      await Promise.all(
        productIds.map(async (id) => {
          const list = await api.listActiveOffersForProduct(id).catch(() => []);
          const official = list.some((o) => o.ownerType === 'official');
          const seller = list.some((o) => o.ownerType === 'seller');
          if (official || seller) out.set(id, official && seller ? 'both' : official ? 'official' : 'seller');
        }),
      );
    });
    return out;
  }

  /* ================================================================ merge */

  async questionsOf(productId: string): Promise<QuestionRec[]> {
    return this.core.repo.find('questions', { product_id: productId });
  }

  answersOf(questionIds: readonly string[]): Promise<AnswerRec[]> {
    return this.core.repo.answersOf(questionIds, { publicOnly: false });
  }
}
