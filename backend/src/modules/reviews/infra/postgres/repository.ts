import { sql, type Kysely } from 'kysely';
import { decodeCursor, encodeCursor, paginate, type PageRequest } from '../../../../kernel/lib/pagination.js';
import type * as common from '../../../../spec/common.js';
import type { Inbox } from '../../../../kernel/events/inbox.js';
import type { ReviewsDb } from '../../../../spec/reviews.js';
import type { ReviewsRepository } from '../../ports.js';

/** jsonb columns per table: values are sent as JSON text (pg would turn JS arrays into PG arrays) */
const JSON_COLUMNS: Record<string, readonly string[]> = {
  product_reviews: ['media_ids'],
  seller_responses: ['rule_check'],
  answers: ['rule_check'],
  moderation_items: ['reasons'],
  product_rating_summaries: ['distribution'],
};

function encode(table: string, row: Record<string, unknown>): Record<string, unknown> {
  const cols = JSON_COLUMNS[table];
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v === undefined) continue;
    out[k] = cols?.includes(k) && v !== null ? JSON.stringify(v) : v;
  }
  return out;
}

const isOp = (v: unknown): v is { op: string; value: unknown } => typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date) && 'op' in v;

function applyWhere(q: any, where: Record<string, unknown>, prefix = ''): any {
  for (const [k, v] of Object.entries(where)) {
    if (v === undefined) continue;
    const col = `${prefix}${k}`;
    if (v === null) q = q.where(col, 'is', null);
    else if (Array.isArray(v)) q = v.length ? q.where(col, 'in', v) : q.where(sql<boolean>`false`);
    else if (isOp(v)) q = q.where(col, v.op, v.value);
    else q = q.where(col, '=', v);
  }
  return q;
}

const like = (s: string) => `%${s.trim().toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** Offset paging for lists sorted by several keys: page mode counts, cursor mode carries the offset */
async function offsetPage<R>(q: any, req: PageRequest, order: (q: any) => any): Promise<common.Page<R>> {
  if (req.mode === 'page') {
    const [countRow, items] = await Promise.all([
      q.clearSelect().clearOrderBy().select(sql<number>`count(*)::int`.as('n')).executeTakeFirst(),
      order(q).limit(req.limit).offset((req.page - 1) * req.limit).execute(),
    ]);
    const total = (countRow as { n: number } | undefined)?.n ?? 0;
    const totalPages = Math.max(1, Math.ceil(total / req.limit));
    return { items, nextCursor: req.page < totalPages ? encodeCursor([req.page * req.limit]) : null, page: req.page, totalPages, total };
  }
  const start = req.cursor ? Number(decodeCursor(req.cursor)[0]) || 0 : 0;
  const rows = (await order(q).limit(req.limit + 1).offset(start).execute()) as R[];
  const items = rows.slice(0, req.limit);
  return { items, nextCursor: rows.length > req.limit ? encodeCursor([start + req.limit]) : null };
}

const notHidden = (contentType: string, idRef: string) =>
  sql<boolean>`not exists (select 1 from reviews.moderation_items m where m.content_type = ${contentType} and m.content_id = ${sql.ref(idRef)} and m.status = 'open' and m.visibility = 'hidden')`;

/** Postgres adapter for ReviewsRepository. `db` is scoped to the `reviews` schema. */
export function createPostgresReviewsRepository(db: Kysely<ReviewsDb>, inbox?: Inbox): ReviewsRepository {
  // generic table access: the row types are checked at the ReviewsRepository boundary
  const d: any = db;

  const repo: ReviewsRepository = {
    async transaction(fn) {
      if (db.isTransaction) return fn(repo);
      return db.transaction().execute((trx) => fn(createPostgresReviewsRepository(trx, inbox)));
    },
    async claim(key) {
      if (!inbox) throw new Error('reviews: no inbox wired');
      return inbox.claim(db, key);
    },
    async insertIgnore(table, row) {
      const r = await d
        .insertInto(table)
        .values(encode(table, row as Record<string, unknown>))
        .onConflict((oc: any) => oc.doNothing())
        .executeTakeFirst();
      return Number(r?.numInsertedOrUpdatedRows ?? 0) > 0;
    },

    /* ---------------------------------------------------------------- generic */
    async get(table, id, o) {
      let q = d.selectFrom(table).selectAll().where('id', '=', id);
      if (o?.forUpdate) q = q.forUpdate();
      return q.executeTakeFirst();
    },
    async getMany(table, ids) {
      if (!ids.length) return [];
      return d.selectFrom(table).selectAll().where('id', 'in', [...new Set(ids)]).execute();
    },
    async find(table, where, o) {
      let q = applyWhere(d.selectFrom(table).selectAll(), where as Record<string, unknown>);
      for (const [c, dir] of o?.orderBy ?? []) q = q.orderBy(c, dir);
      if (o?.limit) q = q.limit(o.limit);
      if (o?.forUpdate) q = q.forUpdate();
      return q.execute();
    },
    async findOne(table, where, o) {
      return (await repo.find(table, where, { ...o, limit: 1 }))[0];
    },
    async count(table, where) {
      const r = await applyWhere(d.selectFrom(table).select(sql<number>`count(*)::int`.as('n')), where as Record<string, unknown>).executeTakeFirst();
      return (r as { n: number } | undefined)?.n ?? 0;
    },
    async insert(table, row) {
      return d.insertInto(table).values(encode(table, row as Record<string, unknown>)).returningAll().executeTakeFirstOrThrow();
    },
    async update(table, id, patch) {
      const values = encode(table, patch as Record<string, unknown>);
      if (!Object.keys(values).length) return (await repo.get(table, id))!;
      return d.updateTable(table).set(values).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
    },
    async updateWhere(table, where, patch) {
      const values = encode(table, patch as Record<string, unknown>);
      if (!Object.keys(values).length) return 0;
      const r = await applyWhere(d.updateTable(table).set(values), where as Record<string, unknown>).executeTakeFirst();
      return Number((r as { numUpdatedRows?: bigint } | undefined)?.numUpdatedRows ?? 0);
    },
    async page(table, where, page, order) {
      const q = applyWhere(d.selectFrom(table).selectAll(), where as Record<string, unknown>);
      return paginate(q, page, order) as never;
    },

    /* ---------------------------------------------------------------- lists */
    async listReviews(f, page) {
      let q = d.selectFrom('product_reviews').selectAll();
      if (f.productId) q = q.where('product_id', '=', f.productId);
      if (f.sellerId) q = q.where('seller_id', '=', f.sellerId);
      if (f.customerId) q = q.where('customer_id', '=', f.customerId);
      if (f.statuses?.length) q = q.where('status', 'in', f.statuses);
      if (f.publicOnly) q = q.where('status', '=', 'published').where('visible', '=', true);
      if (f.stars) q = q.where('rating', '=', f.stars);
      if (f.critical) q = q.where('rating', '<=', 2);
      if (f.verifiedOnly) q = q.where('verified', '=', true);
      if (f.withPhotos) q = q.where(sql<boolean>`jsonb_array_length(media_ids) > 0`);
      if (f.variantIds) q = f.variantIds.length ? q.where('variant_id', 'in', f.variantIds) : q.where(sql<boolean>`false`);
      if (f.needsResponse !== undefined) {
        const exists = sql<boolean>`exists (select 1 from reviews.seller_responses r where r.target_type = 'product_review' and r.target_id = product_reviews.id)`;
        q = q.where(f.needsResponse ? sql<boolean>`not ${exists}` : exists);
      }
      if (f.q?.trim()) {
        const term = like(f.q);
        q = q.where((eb: any) => eb.or([eb(sql`lower(headline)`, 'like', term), eb(sql`lower(body)`, 'like', term), eb(sql`lower(display_name)`, 'like', term)]));
      }
      switch (f.sort) {
        case 'most_helpful':
          return paginate(q, page, { column: 'helpful_count', direction: 'desc' }) as never;
        case 'highest':
          return paginate(q, page, { column: 'rating', direction: 'desc' }) as never;
        case 'lowest':
          return paginate(q, page, { column: 'rating', direction: 'asc' }) as never;
        case 'newest':
          if (f.publicOnly) return paginate(q, page, { column: 'published_at', direction: 'desc' }) as never;
          return paginate(q, page, { column: 'created_at', direction: 'desc' }) as never;
        default:
          return paginate(q, page, { column: 'created_at', direction: 'desc' }) as never;
      }
    },

    async listFeedback(f, page) {
      let q = d.selectFrom('seller_feedback').selectAll();
      if (f.sellerId) q = q.where('seller_id', '=', f.sellerId);
      if (f.customerId) q = q.where('customer_id', '=', f.customerId);
      if (f.statuses?.length) q = q.where('status', 'in', f.statuses);
      if (f.publicOnly) q = q.where('status', '=', 'published').where('visible', '=', true);
      if (f.sentiment) q = q.where('sentiment', '=', f.sentiment);
      if (f.since) q = q.where('created_at', '>=', f.since);
      if (f.needsResponse !== undefined) {
        const exists = sql<boolean>`exists (select 1 from reviews.seller_responses r where r.target_type = 'seller_feedback' and r.target_id = seller_feedback.id)`;
        q = q.where(f.needsResponse ? sql<boolean>`not ${exists}` : exists);
      }
      return paginate(q, page, { column: 'created_at', direction: 'desc' }) as never;
    },

    async listQuestions(f, page) {
      let q = d.selectFrom('questions').selectAll();
      if (f.productId) q = q.where('product_id', '=', f.productId);
      if (f.productIds) q = f.productIds.length ? q.where('product_id', 'in', f.productIds) : q.where(sql<boolean>`false`);
      if (f.statuses?.length) q = q.where('status', 'in', f.statuses);
      if (f.publicOnly) q = q.where('status', '=', 'published').where(notHidden('question', 'questions.id'));
      const anyAnswer = sql<boolean>`exists (select 1 from reviews.answers a where a.question_id = questions.id and a.status = 'published')`;
      if (f.answered !== undefined) q = q.where(f.answered ? anyAnswer : sql<boolean>`not ${anyAnswer}`);
      if (f.answeredBySeller) {
        const bySeller = sql<boolean>`exists (select 1 from reviews.answers a where a.question_id = questions.id and a.author_kind = 'seller' and a.seller_id = ${f.answeredBySeller.sellerId} and a.status = 'published')`;
        q = q.where(f.answeredBySeller.value ? bySeller : sql<boolean>`not ${bySeller}`);
      }
      if (f.q?.trim()) {
        const term = like(f.q);
        q = q.where(
          sql<boolean>`(lower(questions.text) like ${term} or exists (select 1 from reviews.answers a where a.question_id = questions.id and a.status = 'published' and lower(a.text) like ${term}))`,
        );
      }
      switch (f.sort) {
        case 'most_helpful':
          return offsetPage(q, page, (x) => x.orderBy('answer_count', 'desc').orderBy(sql`(select coalesce(max(a.helpful_count), 0) from reviews.answers a where a.question_id = questions.id and a.status = 'published')`, 'desc').orderBy('created_at', 'desc').orderBy('id', 'desc'));
        case 'oldest':
          return paginate(q, page, { column: 'created_at', direction: 'asc' }) as never;
        case 'oldest_unanswered':
          return offsetPage(q, page, (x) => x.orderBy(sql`(answer_count > 0)`, 'asc').orderBy('created_at', 'asc').orderBy('id', 'asc'));
        case 'newest':
        default:
          return paginate(q, page, { column: 'created_at', direction: 'desc' }) as never;
      }
    },

    async answersOf(questionIds, o) {
      if (!questionIds.length) return [];
      let q = d.selectFrom('answers').selectAll().where('question_id', 'in', [...new Set(questionIds)]);
      if (o.publicOnly) q = q.where('status', '=', 'published').where(notHidden('answer', 'answers.id'));
      return q.orderBy('helpful_count', 'desc').orderBy('created_at', 'asc').execute();
    },

    async responsesFor(targetType, targetIds) {
      if (!targetIds.length) return [];
      return d.selectFrom('seller_responses').selectAll().where('target_type', '=', targetType).where('target_id', 'in', [...new Set(targetIds)]).execute();
    },

    async hiddenByReport(contentType, ids) {
      if (!ids.length) return new Set();
      const rows = await d
        .selectFrom('moderation_items')
        .select('content_id')
        .where('content_type', '=', contentType)
        .where('content_id', 'in', [...new Set(ids)])
        .where('status', '=', 'open')
        .where('visibility', '=', 'hidden')
        .execute();
      return new Set(rows.map((r: { content_id: string }) => r.content_id));
    },

    async listModerationItems(f, page) {
      let q = d.selectFrom('moderation_items').selectAll();
      if (f.queue) q = q.where('queue', '=', f.queue);
      if (f.contentType) q = q.where('content_type', '=', f.contentType);
      if (f.status) q = q.where('status', '=', f.status);
      if (f.reason) q = q.where(sql<boolean>`reasons @> ${JSON.stringify([f.reason])}::jsonb`);
      return paginate(q, page, { column: 'first_reported_at', direction: f.status === 'decided' ? 'desc' : 'asc' }) as never;
    },

    async moderationCounts(since) {
      const rows = (await d.selectFrom('moderation_items').select(['queue', 'content_type', 'first_reported_at']).where('status', '=', 'open').execute()) as {
        queue: string;
        content_type: string;
        first_reported_at: Date;
      }[];
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

    async overdueItems(before, limit) {
      return d.selectFrom('moderation_items').selectAll().where('status', '=', 'open').where('first_reported_at', '<', before).orderBy('first_reported_at', 'asc').limit(limit).execute();
    },

    async countReportsByTarget(targetType, targetIds) {
      if (!targetIds.length) return new Map();
      const rows = await d
        .selectFrom('reports')
        .select(['target_id', sql<number>`count(*)::int`.as('n')])
        .where('target_type', '=', targetType)
        .where('target_id', 'in', [...new Set(targetIds)])
        .where('reporter_kind', 'in', ['customer', 'seller', 'trust'])
        .groupBy('target_id')
        .execute();
      return new Map(rows.map((r: { target_id: string; n: number }) => [r.target_id, r.n]));
    },

    /* ---------------------------------------------------------------- votes */
    async upsertVote(row) {
      await d
        .insertInto('helpful_votes')
        .values(row)
        .onConflict((oc: any) => oc.columns(['target_type', 'target_id', 'customer_id']).doUpdateSet({ helpful: row.helpful, at: row.at }))
        .execute();
    },
    async countHelpful(targetType, targetId) {
      return repo.count('helpful_votes', { target_type: targetType, target_id: targetId, helpful: true });
    },
    async votedHelpful(targetType, targetIds, customerId) {
      if (!targetIds.length) return new Set();
      const rows = await d
        .selectFrom('helpful_votes')
        .select('target_id')
        .where('target_type', '=', targetType)
        .where('target_id', 'in', [...new Set(targetIds)])
        .where('customer_id', '=', customerId)
        .where('helpful', '=', true)
        .execute();
      return new Set(rows.map((r: { target_id: string }) => r.target_id));
    },

    /* ---------------------------------------------------------------- read models */
    async recomputeProductSummary(productId, now) {
      const agg = await sql<{ n: number; s: number; w: number; p: number; r1: number; r2: number; r3: number; r4: number; r5: number }>`
        select count(*)::int as n, coalesce(sum(rating), 0)::int as s,
          count(*) filter (where length(trim(body)) > 0)::int as w,
          count(*) filter (where jsonb_array_length(media_ids) > 0)::int as p,
          count(*) filter (where rating = 1)::int as r1, count(*) filter (where rating = 2)::int as r2,
          count(*) filter (where rating = 3)::int as r3, count(*) filter (where rating = 4)::int as r4,
          count(*) filter (where rating = 5)::int as r5
        from reviews.product_reviews where product_id = ${productId} and status = 'published' and visible`.execute(d);
      const a = agg.rows[0]!;
      const answered = (await repo.answeredQuestionCounts([productId])).get(productId) ?? 0;
      const row = {
        product_id: productId,
        rating_count: a.n,
        written_count: a.w,
        sum_ratings: a.s,
        distribution: JSON.stringify({ '1': a.r1, '2': a.r2, '3': a.r3, '4': a.r4, '5': a.r5 }),
        with_photos: a.p,
        answered_questions: answered,
        updated_at: now,
      };
      const { product_id: _id, ...rest } = row;
      return d.insertInto('product_rating_summaries').values(row).onConflict((oc: any) => oc.column('product_id').doUpdateSet(rest)).returningAll().executeTakeFirstOrThrow();
    },

    async recomputeSellerSummary(sellerId, since, positiveThreshold, now) {
      const agg = await sql<{ n: number; pos: number; neu: number; neg: number; yes: number; ds: number; cs: number; cn: number; os: number }>`
        select count(*)::int as n,
          count(*) filter (where overall >= ${positiveThreshold})::int as pos,
          count(*) filter (where overall < ${positiveThreshold} and overall >= ${positiveThreshold - 1})::int as neu,
          count(*) filter (where overall < ${positiveThreshold - 1})::int as neg,
          count(*) filter (where as_described)::int as yes,
          coalesce(sum(dispatch_rating), 0)::int as ds,
          coalesce(sum(communication_rating), 0)::int as cs,
          count(communication_rating)::int as cn,
          coalesce(sum(overall), 0)::int as os
        from reviews.seller_feedback where seller_id = ${sellerId} and status = 'published' and visible and created_at >= ${since}`.execute(d);
      const a = agg.rows[0]!;
      const row = {
        seller_id: sellerId,
        count: a.n,
        positive: a.pos,
        neutral: a.neu,
        negative: a.neg,
        as_described_yes: a.yes,
        dispatch_sum: a.ds,
        communication_sum: a.cs,
        communication_count: a.cn,
        overall_sum: a.os,
        updated_at: now,
      };
      const { seller_id: _id, ...rest } = row;
      return d.insertInto('seller_feedback_summaries').values(row).onConflict((oc: any) => oc.column('seller_id').doUpdateSet(rest)).returningAll().executeTakeFirstOrThrow();
    },

    async productSummaries(productIds) {
      if (!productIds.length) return [];
      return d.selectFrom('product_rating_summaries').selectAll().where('product_id', 'in', [...new Set(productIds)]).execute();
    },
    async sellerSummaries(sellerIds) {
      if (!sellerIds.length) return [];
      return d.selectFrom('seller_feedback_summaries').selectAll().where('seller_id', 'in', [...new Set(sellerIds)]).execute();
    },
    async anonymiseVotes(customerId) {
      const r = await sql`update reviews.helpful_votes set customer_id = gen_random_uuid() where customer_id = ${customerId}`.execute(d);
      return Number(r.numAffectedRows ?? 0);
    },
    async productIdsAfter(after, limit) {
      const r = await sql<{ product_id: string }>`
        select product_id from (
          select product_id from reviews.product_reviews union select product_id from reviews.questions union select product_id from reviews.product_rating_summaries
        ) p where ${after === null ? sql`true` : sql`product_id > ${after}`} order by product_id limit ${limit}`.execute(d);
      return r.rows.map((x) => x.product_id);
    },
    async sellerIdsAfter(after, limit) {
      const r = await sql<{ seller_id: string }>`
        select seller_id from (
          select seller_id from reviews.seller_feedback union select seller_id from reviews.seller_feedback_summaries
        ) s where ${after === null ? sql`true` : sql`seller_id > ${after}`} order by seller_id limit ${limit}`.execute(d);
      return r.rows.map((x) => x.seller_id);
    },
    async answeredQuestionCounts(productIds) {
      if (!productIds.length) return new Map();
      const rows = await d
        .selectFrom('questions')
        .select(['product_id', sql<number>`count(*)::int`.as('n')])
        .where('product_id', 'in', [...new Set(productIds)])
        .where('status', '=', 'published')
        .where(sql<boolean>`exists (select 1 from reviews.answers a where a.question_id = questions.id and a.status = 'published')`)
        .groupBy('product_id')
        .execute();
      return new Map(rows.map((r: { product_id: string; n: number }) => [r.product_id, r.n]));
    },
  };
  return repo;
}
