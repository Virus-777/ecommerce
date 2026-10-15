import { randomUUID } from 'node:crypto';
import { orThrow } from '../../kernel/lib/or-throw.js';
import { decodeCursor, encodeCursor, type PageRequest } from '../../kernel/lib/pagination.js';
import { contains, whereFilter, type Filter, type ModuleStore, type Table, type Where } from '../../kernel/mongo/index.js';
import type * as common from '../../spec/common.js';
import type {
  AnswerRec,
  Db,
  FeedbackListFilter,
  FeedbackRec,
  IdTable,
  ItemRec,
  ModerationListFilter,
  ProductSummaryRec,
  QuestionListFilter,
  QuestionRec,
  ResponseRec,
  ReviewListFilter,
  ReviewRec,
  SellerSummaryRec,
  TableName,
  VoteRec,
} from './ports.js';

/** Sort, limit and lock options of the generic find */
export interface FindOptions<R> {
  orderBy?: [keyof R & string, 'asc' | 'desc'][];
  limit?: number;
  forUpdate?: boolean;
}

const sortOf = (orderBy: [string, 'asc' | 'desc'][] | undefined) => (orderBy?.length ? Object.fromEntries(orderBy.map(([c, d]) => [c, d === 'desc' ? -1 : 1] as const)) : undefined);

const defined = (patch: Record<string, unknown>) => Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));

/** A raw aggregation count of matching documents ($sum of a condition) */
const countIf = (expr: unknown) => ({ $sum: { $cond: [expr, 1, 0] } });

/** Fields the question list pipelines add (dropped before the rows are returned) */
const QUESTION_CLEANUP = { $project: { _answers: 0, _helpful: 0, _answered: 0 } };

/**
 * reviews.product_reviews, seller_feedback, seller_responses, questions, answers, helpful_votes, reports,
 * moderation_items, moderation_decisions, referrals, appeals, review_invites and the rating summaries
 * (MongoDB, docs/04-mongodb-migration.md).
 */
export class ReviewsRepository {
  readonly #reviews: Table<ReviewRec>;
  readonly #feedback: Table<FeedbackRec>;
  readonly #questions: Table<QuestionRec>;
  readonly #answers: Table<AnswerRec>;
  readonly #items: Table<ItemRec>;

  constructor(private readonly store: ModuleStore) {
    this.#reviews = this.#t('product_reviews');
    this.#feedback = this.#t('seller_feedback');
    this.#questions = this.#t('questions');
    this.#answers = this.#t('answers');
    this.#items = this.#t('moderation_items');
  }

  #t<T extends TableName>(name: T): Table<Db[T]> {
    return this.store.table<Db[T]>(name);
  }

  transaction<R>(fn: (tx: ReviewsRepository) => Promise<R>): Promise<R> {
    return this.store.transaction((tx) => fn(new ReviewsRepository(tx)));
  }

  /** Inbox (ctx.mongo.claim): true the first time this key is claimed; commits with the transaction it runs in */
  claim(key: string): Promise<boolean> {
    return this.store.claim(key);
  }

  /** Inserts unless a unique key of the table already holds the row (on conflict do nothing); true when inserted */
  async insertIfAbsent<T extends TableName>(table: T, row: Db[T]): Promise<boolean> {
    return Boolean(await this.#t(table).insertIfAbsent(row));
  }

  /* ---------------------------------------------------------------- generic table access */

  get<T extends IdTable>(table: T, id: string, o?: { forUpdate?: boolean }): Promise<Db[T] | undefined> {
    return this.#t(table).get(id, o);
  }

  getMany<T extends IdTable>(table: T, ids: readonly string[]): Promise<Db[T][]> {
    return this.#t(table).getMany([...new Set(ids)]);
  }

  find<T extends TableName>(table: T, where: Where<Db[T]>, o?: FindOptions<Db[T]>): Promise<Db[T][]> {
    return this.#t(table).find(whereFilter(where), { sort: sortOf(o?.orderBy), limit: o?.limit, forUpdate: o?.forUpdate });
  }

  findOne<T extends TableName>(table: T, where: Where<Db[T]>, o?: FindOptions<Db[T]>): Promise<Db[T] | undefined> {
    return this.#t(table).findOne(whereFilter(where), { sort: sortOf(o?.orderBy), forUpdate: o?.forUpdate });
  }

  count<T extends TableName>(table: T, where: Where<Db[T]>): Promise<number> {
    return this.#t(table).count(whereFilter(where));
  }

  insert<T extends TableName>(table: T, row: Db[T]): Promise<Db[T]> {
    return this.#t(table).insert(row);
  }

  /** Sets the defined fields of patch; the row after (an empty patch reads it) */
  async update<T extends IdTable>(table: T, id: string, patch: Partial<Db[T]>): Promise<Db[T]> {
    const values = defined(patch as Record<string, unknown>);
    const row = Object.keys(values).length ? await this.#t(table).update(id, values) : await this.#t(table).get(id);
    return orThrow(row, `reviews: ${table} ${id}`);
  }

  async updateWhere<T extends TableName>(table: T, where: Where<Db[T]>, patch: Partial<Db[T]>): Promise<number> {
    const values = defined(patch as Record<string, unknown>);
    if (!Object.keys(values).length) return 0;
    return this.#t(table).updateMany(whereFilter(where), values);
  }

  page<T extends TableName>(table: T, where: Where<Db[T]>, page: PageRequest, order: { column: keyof Db[T] & string; direction: 'asc' | 'desc' }): Promise<common.Page<Db[T]>> {
    return this.#t(table).page(whereFilter(where), page, order);
  }

  /* ---------------------------------------------------------------- lists */

  async listReviews(f: ReviewListFilter, page: PageRequest): Promise<common.Page<ReviewRec>> {
    const and: Filter[] = [];
    if (f.productId) and.push({ product_id: f.productId });
    if (f.sellerId) and.push({ seller_id: f.sellerId });
    if (f.customerId) and.push({ customer_id: f.customerId });
    if (f.statuses?.length) and.push({ status: { $in: f.statuses } });
    if (f.publicOnly) and.push({ status: 'published', visible: true });
    if (f.stars) and.push({ rating: f.stars });
    if (f.critical) and.push({ rating: { $lte: 2 } });
    if (f.verifiedOnly) and.push({ verified: true });
    if (f.withPhotos) and.push({ 'media_ids.0': { $exists: true } });
    if (f.variantIds) and.push({ variant_id: { $in: f.variantIds } });
    if (f.needsResponse !== undefined) {
      const responded = await this.#respondedIds('product_review', f.sellerId);
      and.push({ id: f.needsResponse ? { $nin: responded } : { $in: responded } });
    }
    if (f.q?.trim()) {
      const term = contains(f.q);
      and.push({ $or: [{ headline: term }, { body: term }, { display_name: term }] });
    }
    const filter = and.length ? { $and: and } : {};
    switch (f.sort) {
      case 'most_helpful':
        return this.#reviews.page(filter, page, { column: 'helpful_count', direction: 'desc' });
      case 'highest':
        return this.#reviews.page(filter, page, { column: 'rating', direction: 'desc' });
      case 'lowest':
        return this.#reviews.page(filter, page, { column: 'rating', direction: 'asc' });
      case 'newest':
        if (f.publicOnly) return this.#reviews.page(filter, page, { column: 'published_at', direction: 'desc' });
        return this.#reviews.page(filter, page, { column: 'created_at', direction: 'desc' });
      default:
        return this.#reviews.page(filter, page, { column: 'created_at', direction: 'desc' });
    }
  }

  async listFeedback(f: FeedbackListFilter, page: PageRequest): Promise<common.Page<FeedbackRec>> {
    const and: Filter[] = [];
    if (f.sellerId) and.push({ seller_id: f.sellerId });
    if (f.customerId) and.push({ customer_id: f.customerId });
    if (f.statuses?.length) and.push({ status: { $in: f.statuses } });
    if (f.publicOnly) and.push({ status: 'published', visible: true });
    if (f.sentiment) and.push({ sentiment: f.sentiment });
    if (f.since) and.push({ created_at: { $gte: f.since } });
    if (f.needsResponse !== undefined) {
      const responded = await this.#respondedIds('seller_feedback', f.sellerId);
      and.push({ id: f.needsResponse ? { $nin: responded } : { $in: responded } });
    }
    return this.#feedback.page(and.length ? { $and: and } : {}, page, { column: 'created_at', direction: 'desc' });
  }

  async listQuestions(f: QuestionListFilter, page: PageRequest): Promise<common.Page<QuestionRec>> {
    const and: Filter[] = [];
    if (f.productId) and.push({ product_id: f.productId });
    if (f.productIds) and.push({ product_id: { $in: f.productIds } });
    if (f.ids) and.push({ id: { $in: f.ids } });
    if (f.excludeIds?.length) and.push({ id: { $nin: f.excludeIds } });
    if (f.statuses?.length) and.push({ status: { $in: f.statuses } });
    if (f.publicOnly) and.push({ status: 'published', id: { $nin: await this.#hiddenIds('question') } });
    const stages: Filter[] = [{ $match: this.#questions.filter(and.length ? { $and: and } : {}) }];
    const q = f.q?.trim() ? contains(f.q) : undefined;
    const needAnswers = f.answered !== undefined || f.answeredBySeller || q || f.sort === 'most_helpful';
    if (needAnswers) {
      // the published answers of each question (EXISTS / max(helpful_count) subqueries)
      stages.push({
        $lookup: {
          from: this.#answers.name,
          localField: '_id',
          foreignField: 'question_id',
          pipeline: [{ $match: { status: 'published' } }, { $project: { author_kind: 1, seller_id: 1, text: 1, helpful_count: 1 } }],
          as: '_answers',
        },
      });
      const match: Filter[] = [];
      if (f.answered !== undefined) match.push({ '_answers.0': { $exists: f.answered } });
      if (f.answeredBySeller) {
        const bySeller = { $elemMatch: { author_kind: 'seller', seller_id: f.answeredBySeller.sellerId } };
        match.push(f.answeredBySeller.value ? { _answers: bySeller } : { _answers: { $not: bySeller } });
      }
      if (q) match.push({ $or: [{ text: q }, { _answers: { $elemMatch: { text: q } } }] });
      if (match.length) stages.push({ $match: { $and: match } });
    }
    switch (f.sort) {
      case 'most_helpful':
        stages.push({ $addFields: { _helpful: { $max: [0, { $ifNull: [{ $max: '$_answers.helpful_count' }, 0] }] } } });
        return this.#questionsByOffset(stages, page, { answer_count: -1, _helpful: -1, created_at: -1, _id: -1 });
      case 'oldest':
        return this.#questions.pageAggregate([...stages, QUESTION_CLEANUP], page, { key: 'created_at', direction: 'asc' });
      case 'oldest_unanswered':
        stages.push({ $addFields: { _answered: { $gt: ['$answer_count', 0] } } });
        return this.#questionsByOffset(stages, page, { _answered: 1, created_at: 1, _id: 1 });
      case 'newest':
      default:
        return this.#questions.pageAggregate([...stages, QUESTION_CLEANUP], page, { key: 'created_at', direction: 'desc' });
    }
  }

  /** Answers of questions; publicOnly leaves out unpublished answers and ones hidden by an open report */
  async answersOf(questionIds: readonly string[], o: { publicOnly: boolean }): Promise<AnswerRec[]> {
    if (!questionIds.length) return [];
    const filter: Filter = { question_id: { $in: [...new Set(questionIds)] } };
    if (o.publicOnly) {
      const published = await this.#answers.find({ ...filter, status: 'published' }, { sort: { helpful_count: -1, created_at: 1 } });
      const hidden = new Set(await this.#hiddenIds('answer', published.map((a) => a.id)));
      return published.filter((a) => !hidden.has(a.id));
    }
    return this.#answers.find(filter, { sort: { helpful_count: -1, created_at: 1 } });
  }

  async responsesFor(targetType: string, targetIds: readonly string[]): Promise<ResponseRec[]> {
    return targetIds.length ? this.#t('seller_responses').find({ target_type: targetType, target_id: { $in: [...new Set(targetIds)] } }) : [];
  }

  /** Content ids among `ids` hidden by an open moderation item (questions, answers, responses) */
  async hiddenByReport(contentType: string, ids: readonly string[]): Promise<Set<string>> {
    if (!ids.length) return new Set();
    return new Set(await this.#hiddenIds(contentType, ids));
  }

  listModerationItems(f: ModerationListFilter, page: PageRequest): Promise<common.Page<ItemRec>> {
    return this.#items.page(
      {
        ...(f.queue ? { queue: f.queue } : {}),
        ...(f.contentType ? { content_type: f.contentType } : {}),
        ...(f.status ? { status: f.status } : {}),
        // reasons @> [reason]
        ...(f.reason ? { reasons: f.reason } : {}),
      },
      page,
      { column: 'first_reported_at', direction: f.status === 'decided' ? 'desc' : 'asc' },
    );
  }

  async moderationCounts(since: Date): Promise<{ open: number; byQueue: Record<string, number>; byContentType: Record<string, number>; overdue: number; oldestOpenAt: Date | null }> {
    const rows = await this.#items.find({ status: 'open' });
    const byQueue: Record<string, number> = {};
    const byContentType: Record<string, number> = {};
    let overdue = 0;
    let oldest: Date | null = null;
    for (const r of rows) {
      byQueue[r.queue] = (byQueue[r.queue] ?? 0) + 1;
      byContentType[r.content_type] = (byContentType[r.content_type] ?? 0) + 1;
      if (r.first_reported_at < since) overdue++;
      if (!oldest || r.first_reported_at < oldest) oldest = r.first_reported_at;
    }
    return { open: rows.length, byQueue, byContentType, overdue, oldestOpenAt: oldest };
  }

  overdueItems(before: Date, limit: number): Promise<ItemRec[]> {
    return this.#items.find({ status: 'open', first_reported_at: { $lt: before } }, { sort: { first_reported_at: 1 }, limit });
  }

  async countReportsByTarget(targetType: string, targetIds: readonly string[]): Promise<Map<string, number>> {
    if (!targetIds.length) return new Map();
    const rows = await this.#t('reports').aggregate<{ _id: string; n: number }>([
      { $match: { target_type: targetType, target_id: { $in: [...new Set(targetIds)] }, reporter_kind: { $in: ['customer', 'seller', 'trust'] } } },
      { $group: { _id: '$target_id', n: { $sum: 1 } } },
    ]);
    return new Map(rows.map((r) => [r._id, r.n]));
  }

  /* ---------------------------------------------------------------- helpful votes */

  async upsertVote(row: VoteRec): Promise<void> {
    await this.#t('helpful_votes').upsert(row, { key: ['target_type', 'target_id', 'customer_id'], update: { helpful: row.helpful, at: row.at } });
  }

  countHelpful(targetType: string, targetId: string): Promise<number> {
    return this.#t('helpful_votes').count({ target_type: targetType, target_id: targetId, helpful: true });
  }

  async votedHelpful(targetType: string, targetIds: readonly string[], customerId: string): Promise<Set<string>> {
    if (!targetIds.length) return new Set();
    return new Set(await this.#t('helpful_votes').distinct<string>('target_id', { target_type: targetType, target_id: { $in: [...new Set(targetIds)] }, customer_id: customerId, helpful: true }));
  }

  /* ---------------------------------------------------------------- read models */

  async recomputeProductSummary(productId: string, now: Date): Promise<ProductSummaryRec> {
    const [a] = await this.#reviews.aggregate<{ n: number; s: number; w: number; p: number; r1: number; r2: number; r3: number; r4: number; r5: number }>([
      { $match: { product_id: productId, status: 'published', visible: true } },
      {
        $group: {
          _id: null,
          n: { $sum: 1 },
          s: { $sum: '$rating' },
          // a body with more than spaces (spaces only are trimmed)
          w: countIf({ $gt: [{ $strLenCP: { $trim: { input: { $ifNull: ['$body', ''] }, chars: ' ' } } }, 0] }),
          p: countIf({ $gt: [{ $size: { $cond: [{ $isArray: '$media_ids' }, '$media_ids', []] } }, 0] }),
          r1: countIf({ $eq: ['$rating', 1] }),
          r2: countIf({ $eq: ['$rating', 2] }),
          r3: countIf({ $eq: ['$rating', 3] }),
          r4: countIf({ $eq: ['$rating', 4] }),
          r5: countIf({ $eq: ['$rating', 5] }),
        },
      },
    ]);
    const answered = (await this.answeredQuestionCounts([productId])).get(productId) ?? 0;
    return this.#t('product_rating_summaries').upsert({
      product_id: productId,
      rating_count: a?.n ?? 0,
      written_count: a?.w ?? 0,
      sum_ratings: a?.s ?? 0,
      distribution: { '1': a?.r1 ?? 0, '2': a?.r2 ?? 0, '3': a?.r3 ?? 0, '4': a?.r4 ?? 0, '5': a?.r5 ?? 0 },
      with_photos: a?.p ?? 0,
      answered_questions: answered,
      updated_at: now,
    });
  }

  async recomputeSellerSummary(sellerId: string, since: Date, positiveThreshold: number, now: Date): Promise<SellerSummaryRec> {
    const [a] = await this.#feedback.aggregate<{ n: number; pos: number; neu: number; neg: number; yes: number; ds: number; cs: number; cn: number; os: number }>([
      { $match: { seller_id: sellerId, status: 'published', visible: true, created_at: { $gte: since } } },
      {
        $group: {
          _id: null,
          n: { $sum: 1 },
          pos: countIf({ $gte: ['$overall', positiveThreshold] }),
          neu: countIf({ $and: [{ $lt: ['$overall', positiveThreshold] }, { $gte: ['$overall', positiveThreshold - 1] }] }),
          neg: countIf({ $lt: ['$overall', positiveThreshold - 1] }),
          yes: countIf({ $eq: ['$as_described', true] }),
          ds: { $sum: '$dispatch_rating' },
          cs: { $sum: '$communication_rating' },
          // count(communication_rating): rows where it is not null
          cn: countIf({ $ne: [{ $ifNull: ['$communication_rating', null] }, null] }),
          os: { $sum: '$overall' },
        },
      },
    ]);
    return this.#t('seller_feedback_summaries').upsert({
      seller_id: sellerId,
      count: a?.n ?? 0,
      positive: a?.pos ?? 0,
      neutral: a?.neu ?? 0,
      negative: a?.neg ?? 0,
      as_described_yes: a?.yes ?? 0,
      dispatch_sum: a?.ds ?? 0,
      communication_sum: a?.cs ?? 0,
      communication_count: a?.cn ?? 0,
      overall_sum: a?.os ?? 0,
      updated_at: now,
    });
  }

  productSummaries(productIds: readonly string[]): Promise<ProductSummaryRec[]> {
    return this.#t('product_rating_summaries').getMany([...new Set(productIds)]);
  }

  sellerSummaries(sellerIds: readonly string[]): Promise<SellerSummaryRec[]> {
    return this.#t('seller_feedback_summaries').getMany([...new Set(sellerIds)]);
  }

  /** customers.account.closed: the customer's helpful votes move to a random id each (still counted, no longer linked) */
  async anonymiseVotes(customerId: string): Promise<number> {
    const votes = this.#t('helpful_votes');
    const rows = await votes.find({ customer_id: customerId });
    for (const v of rows) await votes.updateOne({ target_type: v.target_type, target_id: v.target_id, customer_id: customerId }, { customer_id: randomUUID() });
    return rows.length;
  }

  /** Product ids with reviews or questions, in batches (summaries job) */
  productIdsAfter(after: string | null, limit: number): Promise<string[]> {
    return this.#idsAfter('product_id', [this.#reviews, this.#questions, this.#t('product_rating_summaries')], after, limit);
  }

  sellerIdsAfter(after: string | null, limit: number): Promise<string[]> {
    return this.#idsAfter('seller_id', [this.#feedback, this.#t('seller_feedback_summaries')], after, limit);
  }

  /** Questions with at least one published answer per product */
  async answeredQuestionCounts(productIds: readonly string[]): Promise<Map<string, number>> {
    if (!productIds.length) return new Map();
    const qs = await this.#questions.find({ product_id: { $in: [...new Set(productIds)] }, status: 'published' });
    if (!qs.length) return new Map();
    const answered = new Set(await this.#answers.distinct<string>('question_id', { question_id: { $in: qs.map((q) => q.id) }, status: 'published' }));
    const out = new Map<string, number>();
    for (const q of qs) if (answered.has(q.id)) out.set(q.product_id, (out.get(q.product_id) ?? 0) + 1);
    return out;
  }

  /** Published questions without a published answer per product (hidden ones left out, like the public list) */
  async awaitingQuestionCounts(productIds: readonly string[]): Promise<Map<string, number>> {
    if (!productIds.length) return new Map();
    const filter = { product_id: { $in: [...new Set(productIds)] }, status: 'published', answer_count: 0, id: { $nin: await this.#hiddenIds('question') } };
    const rows = await this.#questions.aggregate<{ _id: string; n: number }>([{ $match: this.#questions.filter(filter) }, { $group: { _id: '$product_id', n: { $sum: 1 } } }]);
    return new Map(rows.map((r) => [r._id, r.n]));
  }

  /** The seller skips a question (once: repeating it keeps the first row) */
  async skipQuestion(row: Db['question_skips']): Promise<void> {
    await this.#t('question_skips').insertIfAbsent(row);
  }

  async unskipQuestion(sellerId: string, questionId: string): Promise<void> {
    await this.#t('question_skips').deleteMany({ seller_id: sellerId, question_id: questionId });
  }

  /** Question ids the seller skipped (all, or among ids) */
  skippedQuestionIds(sellerId: string, ids?: readonly string[]): Promise<string[]> {
    return this.#t('question_skips').distinct<string>('question_id', { seller_id: sellerId, ...(ids ? { question_id: { $in: [...new Set(ids)] } } : {}) });
  }

  /** Target ids among ids the reporter has reported (any status) */
  reportedBy(targetType: string, targetIds: readonly string[], reporter: { kind: string; id: string }): Promise<string[]> {
    if (!targetIds.length) return Promise.resolve([]);
    return this.#t('reports').distinct<string>('target_id', { target_type: targetType, target_id: { $in: [...new Set(targetIds)] }, reporter_kind: reporter.kind, reporter_id: reporter.id });
  }

  /* ---------------------------------------------------------------- helpers */

  /** Content ids of a type hidden by an open moderation item (all, or among ids) */
  #hiddenIds(contentType: string, ids?: readonly string[]): Promise<string[]> {
    return this.#items.distinct<string>('content_id', { content_type: contentType, status: 'open', visibility: 'hidden', ...(ids ? { content_id: { $in: [...new Set(ids)] } } : {}) });
  }

  /** Target ids with a seller response (EXISTS on seller_responses), narrowed to a seller when one is known */
  #respondedIds(targetType: string, sellerId?: string): Promise<string[]> {
    return this.#t('seller_responses').distinct<string>('target_id', { target_type: targetType, ...(sellerId ? { seller_id: sellerId } : {}) });
  }

  /**
   * A page of questions sorted by several keys (some computed): page mode counts, cursor mode carries the offset
   * (the order has no single key to continue after).
   */
  async #questionsByOffset(stages: Filter[], req: PageRequest, order: Record<string, 1 | -1>): Promise<common.Page<QuestionRec>> {
    const sort = { $sort: order };
    const rowsOf = (docs: Record<string, unknown>[]) => docs.map((d) => this.#questions.fromDoc(d));
    if (req.mode === 'page') {
      const [r] = await this.#questions.aggregate<{ total: { n: number }[]; items: Record<string, unknown>[] }>([
        ...stages,
        { $facet: { total: [{ $count: 'n' }], items: [sort, { $skip: (req.page - 1) * req.limit }, { $limit: req.limit }, QUESTION_CLEANUP] } },
      ]);
      const total = r?.total[0]?.n ?? 0;
      const totalPages = Math.max(1, Math.ceil(total / req.limit));
      return { items: rowsOf(r?.items ?? []), nextCursor: req.page < totalPages ? encodeCursor([req.page * req.limit]) : null, page: req.page, totalPages, total };
    }
    const start = req.cursor ? Number(decodeCursor(req.cursor)[0]) || 0 : 0;
    const rows = await this.#questions.aggregate<Record<string, unknown>>([...stages, sort, { $skip: start }, { $limit: req.limit + 1 }, QUESTION_CLEANUP]);
    const items = rows.slice(0, req.limit);
    return { items: rowsOf(items), nextCursor: rows.length > req.limit ? encodeCursor([start + req.limit]) : null };
  }

  /** Product or seller ids from several collections (UNION), after `after`, in order */
  async #idsAfter(field: string, sources: Table<any>[], after: string | null, limit: number): Promise<string[]> {
    const all = new Set<string>();
    for (const source of sources) {
      // the field as stored (the primary key of a summary table is _id)
      const stored = Object.keys(source.filter({ [field]: 1 }))[0]!;
      const rows = await source.aggregate<{ _id: string }>([
        ...(after === null ? [] : [{ $match: { [stored]: { $gt: after } } }]),
        { $group: { _id: `$${stored}` } },
        { $sort: { _id: 1 } },
        { $limit: limit },
      ]);
      for (const r of rows) all.add(r._id);
    }
    return [...all].sort().slice(0, limit);
  }
}
