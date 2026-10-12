import { randomUUID } from 'node:crypto';
import type { ModuleStore } from '../../../../kernel/mongo/index.js';
import type { Filter, Sort, Table as MongoTable } from '../../../../kernel/mongo/table.js';
import { decodeCursor, encodeCursor, type PageRequest } from '../../../../kernel/lib/pagination.js';
import type * as common from '../../../../spec/common.js';
import type { Db, QuestionRec, ReviewsRepository, Table } from '../../ports.js';

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** ILIKE '%term%' */
const contains = (term: string) => ({ $regex: escapeRegExp(term.trim()), $options: 'i' });

const isOp = (v: unknown): v is { op: string; value: unknown } => typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date) && 'op' in v;

/** A column condition (ports Cond) as a MongoDB condition, with SQL's meaning (`<>` skips nulls) */
function cond(v: unknown): unknown {
  if (v === null) return null;
  if (Array.isArray(v)) return { $in: v };
  if (isOp(v)) {
    switch (v.op) {
      case '<':
        return { $lt: v.value };
      case '<=':
        return { $lte: v.value };
      case '>':
        return { $gt: v.value };
      case '>=':
        return { $gte: v.value };
      case '<>':
        return { $nin: [v.value, null] };
      case 'is not':
        return { $ne: v.value };
      default:
        throw new Error(`reviews: unknown operator ${v.op}`);
    }
  }
  return v;
}

function where(w: Record<string, unknown>): Filter {
  const out: Filter = {};
  for (const [k, v] of Object.entries(w)) if (v !== undefined) out[k] = cond(v);
  return out;
}

const sortOf = (orderBy: [string, 'asc' | 'desc'][] | undefined): Sort | undefined =>
  orderBy?.length ? Object.fromEntries(orderBy.map(([c, d]) => [c, d === 'desc' ? -1 : 1])) : undefined;

const defined = (patch: Record<string, unknown>) => Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));

/** The unique keys of a table besides its primary key (insertIgnore: on conflict do nothing) */
const UNIQUE: Partial<Record<Table, string[]>> = {
  product_reviews: ['customer_id', 'product_id'],
  seller_feedback: ['order_id', 'seller_id', 'customer_id'],
  seller_responses: ['target_type', 'target_id'],
  helpful_votes: ['target_type', 'target_id', 'customer_id'],
};

/** A raw aggregation count of matching documents ($sum of a condition) */
const countIf = (expr: unknown) => ({ $sum: { $cond: [expr, 1, 0] } });

/** MongoDB adapter for ReviewsRepository (docs/04-mongodb-migration.md): one collection per spec table. */
export function createMongoReviewsRepository(store: ModuleStore): ReviewsRepository {
  const t = <T extends Table>(name: T) => store.table<Db[T]>(name) as MongoTable<Db[T]>;
  const reviews = t('product_reviews');
  const feedback = t('seller_feedback');
  const questions = t('questions');
  const answers = t('answers');
  const items = t('moderation_items');

  /** Content ids of a type hidden by an open moderation item (all, or among ids) */
  const hiddenIds = (contentType: string, ids?: readonly string[]) =>
    items.distinct<string>('content_id', { content_type: contentType, status: 'open', visibility: 'hidden', ...(ids ? { content_id: { $in: [...new Set(ids)] } } : {}) });

  /** Target ids with a seller response (EXISTS on seller_responses), narrowed to a seller when one is known */
  const respondedIds = (targetType: string, sellerId?: string) =>
    t('seller_responses').distinct<string>('target_id', { target_type: targetType, ...(sellerId ? { seller_id: sellerId } : {}) });

  /** Rows of an aggregation (on the questions collection) as rows */
  const questionRows = (docs: Record<string, unknown>[]) => docs.map((d) => questions.fromDoc(d));

  /**
   * A page of questions from a pipeline. keyset: (created_at, _id) in one direction, as kernel paginate;
   * offset: sorted by `sort` (several keys), page mode counts, cursor mode carries the offset.
   */
  async function questionsPage(stages: object[], req: PageRequest, order: { keyset: 1 | -1 } | { sort: Record<string, 1 | -1> }): Promise<common.Page<QuestionRec>> {
    const cleanup = { $project: { _answers: 0, _helpful: 0, _answered: 0 } };
    if ('sort' in order) {
      const sort = { $sort: order.sort };
      if (req.mode === 'page') {
        const [r] = await questions.aggregate<{ total: { n: number }[]; items: Record<string, unknown>[] }>([
          ...stages,
          { $facet: { total: [{ $count: 'n' }], items: [sort, { $skip: (req.page - 1) * req.limit }, { $limit: req.limit }, cleanup] } },
        ]);
        const total = r?.total[0]?.n ?? 0;
        const totalPages = Math.max(1, Math.ceil(total / req.limit));
        return { items: questionRows(r?.items ?? []), nextCursor: req.page < totalPages ? encodeCursor([req.page * req.limit]) : null, page: req.page, totalPages, total };
      }
      const start = req.cursor ? Number(decodeCursor(req.cursor)[0]) || 0 : 0;
      const rows = await questions.aggregate<Record<string, unknown>>([...stages, sort, { $skip: start }, { $limit: req.limit + 1 }, cleanup]);
      const items = rows.slice(0, req.limit);
      return { items: questionRows(items), nextCursor: rows.length > req.limit ? encodeCursor([start + req.limit]) : null };
    }
    const dir = order.keyset;
    const sort = { $sort: { created_at: dir, _id: dir } };
    const cursorOf = (d: Record<string, unknown>) => encodeCursor([(d.created_at as Date).toISOString(), d._id]);
    if (req.mode === 'page') {
      const [r] = await questions.aggregate<{ total: { n: number }[]; items: Record<string, unknown>[] }>([
        ...stages,
        { $facet: { total: [{ $count: 'n' }], items: [sort, { $skip: (req.page - 1) * req.limit }, { $limit: req.limit }, cleanup] } },
      ]);
      const total = r?.total[0]?.n ?? 0;
      const totalPages = Math.max(1, Math.ceil(total / req.limit));
      const found = r?.items ?? [];
      const last = found.at(-1);
      return { items: questionRows(found), nextCursor: req.page < totalPages && last ? cursorOf(last) : null, page: req.page, totalPages, total };
    }
    const after: object[] = [];
    if (req.cursor) {
      const [v, id] = decodeCursor(req.cursor);
      const at = new Date(String(v));
      const cmp = dir === -1 ? '$lt' : '$gt';
      after.push({ $match: { $or: [{ created_at: { [cmp]: at } }, { created_at: at, _id: { [cmp]: id } }] } });
    }
    const rows = await questions.aggregate<Record<string, unknown>>([...stages, ...after, sort, { $limit: req.limit + 1 }, cleanup]);
    const found = rows.slice(0, req.limit);
    return { items: questionRows(found), nextCursor: rows.length > req.limit ? cursorOf(found.at(-1)!) : null };
  }

  /** Product or seller ids from several collections (UNION), after `after`, in order */
  async function idsAfter(field: string, sources: MongoTable<any>[], after: string | null, limit: number): Promise<string[]> {
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

  const repo: ReviewsRepository = {
    transaction: (fn) => store.transaction((tx) => fn(createMongoReviewsRepository(tx))),
    claim: (key) => store.claim(key),
    // on conflict do nothing: the table's natural unique key (new rows have fresh ids), else its primary key
    insertIgnore: async (table, row) => Boolean(await t(table).insertIfAbsent(row, UNIQUE[table])),

    /* ---------------------------------------------------------------- generic */
    get: (table, id, o) => t(table).get(id, o),
    getMany: (table, ids) => t(table).getMany([...new Set(ids)]),
    find: (table, w, o) => t(table).find(where(w as Record<string, unknown>), { sort: sortOf(o?.orderBy), limit: o?.limit, forUpdate: o?.forUpdate }),
    findOne: (table, w, o) => t(table).findOne(where(w as Record<string, unknown>), { sort: sortOf(o?.orderBy), forUpdate: o?.forUpdate }),
    count: (table, w) => t(table).count(where(w as Record<string, unknown>)),
    insert: (table, row) => t(table).insert(row),
    async update(table, id, patch) {
      const values = defined(patch as Record<string, unknown>);
      const row = Object.keys(values).length ? await t(table).update(id, values) : await t(table).get(id);
      if (!row) throw new Error(`reviews: ${table} ${id} not found`);
      return row;
    },
    async updateWhere(table, w, patch) {
      const values = defined(patch as Record<string, unknown>);
      if (!Object.keys(values).length) return 0;
      return t(table).updateMany(where(w as Record<string, unknown>), values);
    },
    page: (table, w, page, order) => t(table).page(where(w as Record<string, unknown>), page, order),

    /* ---------------------------------------------------------------- lists */
    async listReviews(f, page) {
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
        const responded = await respondedIds('product_review', f.sellerId);
        and.push({ id: f.needsResponse ? { $nin: responded } : { $in: responded } });
      }
      if (f.q?.trim()) {
        const term = contains(f.q);
        and.push({ $or: [{ headline: term }, { body: term }, { display_name: term }] });
      }
      const filter = and.length ? { $and: and } : {};
      switch (f.sort) {
        case 'most_helpful':
          return reviews.page(filter, page, { column: 'helpful_count', direction: 'desc' });
        case 'highest':
          return reviews.page(filter, page, { column: 'rating', direction: 'desc' });
        case 'lowest':
          return reviews.page(filter, page, { column: 'rating', direction: 'asc' });
        case 'newest':
          if (f.publicOnly) return reviews.page(filter, page, { column: 'published_at', direction: 'desc' });
          return reviews.page(filter, page, { column: 'created_at', direction: 'desc' });
        default:
          return reviews.page(filter, page, { column: 'created_at', direction: 'desc' });
      }
    },

    async listFeedback(f, page) {
      const and: Filter[] = [];
      if (f.sellerId) and.push({ seller_id: f.sellerId });
      if (f.customerId) and.push({ customer_id: f.customerId });
      if (f.statuses?.length) and.push({ status: { $in: f.statuses } });
      if (f.publicOnly) and.push({ status: 'published', visible: true });
      if (f.sentiment) and.push({ sentiment: f.sentiment });
      if (f.since) and.push({ created_at: { $gte: f.since } });
      if (f.needsResponse !== undefined) {
        const responded = await respondedIds('seller_feedback', f.sellerId);
        and.push({ id: f.needsResponse ? { $nin: responded } : { $in: responded } });
      }
      return feedback.page(and.length ? { $and: and } : {}, page, { column: 'created_at', direction: 'desc' });
    },

    async listQuestions(f, page) {
      const and: Filter[] = [];
      if (f.productId) and.push({ product_id: f.productId });
      if (f.productIds) and.push({ product_id: { $in: f.productIds } });
      if (f.statuses?.length) and.push({ status: { $in: f.statuses } });
      if (f.publicOnly) and.push({ status: 'published', id: { $nin: await hiddenIds('question') } });
      const stages: object[] = [{ $match: questions.filter(and.length ? { $and: and } : {}) }];
      const q = f.q?.trim() ? contains(f.q) : undefined;
      const needAnswers = f.answered !== undefined || f.answeredBySeller || q || f.sort === 'most_helpful';
      if (needAnswers) {
        // the published answers of each question (EXISTS / max(helpful_count) subqueries)
        stages.push({
          $lookup: {
            from: 'reviews.answers',
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
          return questionsPage(stages, page, { sort: { answer_count: -1, _helpful: -1, created_at: -1, _id: -1 } });
        case 'oldest':
          return questionsPage(stages, page, { keyset: 1 });
        case 'oldest_unanswered':
          stages.push({ $addFields: { _answered: { $gt: ['$answer_count', 0] } } });
          return questionsPage(stages, page, { sort: { _answered: 1, created_at: 1, _id: 1 } });
        case 'newest':
        default:
          return questionsPage(stages, page, { keyset: -1 });
      }
    },

    async answersOf(questionIds, o) {
      if (!questionIds.length) return [];
      const filter: Filter = { question_id: { $in: [...new Set(questionIds)] } };
      if (o.publicOnly) {
        const published = await answers.find({ ...filter, status: 'published' }, { sort: { helpful_count: -1, created_at: 1 } });
        const hidden = new Set(await hiddenIds('answer', published.map((a) => a.id)));
        return published.filter((a) => !hidden.has(a.id));
      }
      return answers.find(filter, { sort: { helpful_count: -1, created_at: 1 } });
    },

    responsesFor: async (targetType, targetIds) => (targetIds.length ? t('seller_responses').find({ target_type: targetType, target_id: { $in: [...new Set(targetIds)] } }) : []),

    async hiddenByReport(contentType, ids) {
      if (!ids.length) return new Set();
      return new Set(await hiddenIds(contentType, ids));
    },

    listModerationItems(f, page) {
      return items.page(
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
    },

    async moderationCounts(since) {
      const rows = await items.find({ status: 'open' });
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
    },

    overdueItems: (before, limit) => items.find({ status: 'open', first_reported_at: { $lt: before } }, { sort: { first_reported_at: 1 }, limit }),

    async countReportsByTarget(targetType, targetIds) {
      if (!targetIds.length) return new Map();
      const rows = await t('reports').aggregate<{ _id: string; n: number }>([
        { $match: { target_type: targetType, target_id: { $in: [...new Set(targetIds)] }, reporter_kind: { $in: ['customer', 'seller', 'trust'] } } },
        { $group: { _id: '$target_id', n: { $sum: 1 } } },
      ]);
      return new Map(rows.map((r) => [r._id, r.n]));
    },

    /* ---------------------------------------------------------------- votes */
    async upsertVote(row) {
      await t('helpful_votes').upsert(row, { key: ['target_type', 'target_id', 'customer_id'], update: { helpful: row.helpful, at: row.at } });
    },
    countHelpful: (targetType, targetId) => t('helpful_votes').count({ target_type: targetType, target_id: targetId, helpful: true }),
    async votedHelpful(targetType, targetIds, customerId) {
      if (!targetIds.length) return new Set();
      return new Set(await t('helpful_votes').distinct<string>('target_id', { target_type: targetType, target_id: { $in: [...new Set(targetIds)] }, customer_id: customerId, helpful: true }));
    },

    /* ---------------------------------------------------------------- read models */
    async recomputeProductSummary(productId, now) {
      const [a] = await reviews.aggregate<{ n: number; s: number; w: number; p: number; r1: number; r2: number; r3: number; r4: number; r5: number }>([
        { $match: { product_id: productId, status: 'published', visible: true } },
        {
          $group: {
            _id: null,
            n: { $sum: 1 },
            s: { $sum: '$rating' },
            // length(trim(body)) > 0 (PostgreSQL trim removes spaces)
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
      const answered = (await repo.answeredQuestionCounts([productId])).get(productId) ?? 0;
      return t('product_rating_summaries').upsert({
        product_id: productId,
        rating_count: a?.n ?? 0,
        written_count: a?.w ?? 0,
        sum_ratings: a?.s ?? 0,
        distribution: { '1': a?.r1 ?? 0, '2': a?.r2 ?? 0, '3': a?.r3 ?? 0, '4': a?.r4 ?? 0, '5': a?.r5 ?? 0 },
        with_photos: a?.p ?? 0,
        answered_questions: answered,
        updated_at: now,
      });
    },

    async recomputeSellerSummary(sellerId, since, positiveThreshold, now) {
      const [a] = await feedback.aggregate<{ n: number; pos: number; neu: number; neg: number; yes: number; ds: number; cs: number; cn: number; os: number }>([
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
      return t('seller_feedback_summaries').upsert({
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
    },

    productSummaries: (productIds) => t('product_rating_summaries').getMany([...new Set(productIds)]),
    sellerSummaries: (sellerIds) => t('seller_feedback_summaries').getMany([...new Set(sellerIds)]),
    async anonymiseVotes(customerId) {
      // each vote gets its own random id (still counted, no longer linked)
      const votes = t('helpful_votes');
      const rows = await votes.find({ customer_id: customerId });
      for (const v of rows) await votes.updateOne({ target_type: v.target_type, target_id: v.target_id, customer_id: customerId }, { customer_id: randomUUID() });
      return rows.length;
    },
    productIdsAfter: (after, limit) => idsAfter('product_id', [reviews, questions, t('product_rating_summaries')], after, limit),
    sellerIdsAfter: (after, limit) => idsAfter('seller_id', [feedback, t('seller_feedback_summaries')], after, limit),
    async answeredQuestionCounts(productIds) {
      if (!productIds.length) return new Map();
      const qs = await questions.find({ product_id: { $in: [...new Set(productIds)] }, status: 'published' });
      if (!qs.length) return new Map();
      const answered = new Set(await answers.distinct<string>('question_id', { question_id: { $in: qs.map((q) => q.id) }, status: 'published' }));
      const out = new Map<string, number>();
      for (const q of qs) if (answered.has(q.id)) out.set(q.product_id, (out.get(q.product_id) ?? 0) + 1);
      return out;
    },
  };
  return repo;
}
