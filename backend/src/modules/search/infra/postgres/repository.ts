import { sql, type Kysely } from 'kysely';
import type { Inbox } from '../../../../kernel/events/inbox.js';
import { newId } from '../../../../kernel/lib/ids.js';
import type { SearchDb } from '../../../../spec/search.js';
import type { DocRow, DocWrite, OfferRow, SearchRepository, TermKind } from '../../ports.js';

type Db = Kysely<SearchDb>;

/** jsonb columns are written as JSON text (arrays would otherwise be sent as PostgreSQL arrays) */
const JSON_COLUMNS: Record<string, readonly string[]> = {
  search_documents: ['attributes', 'variant_options', 'image', 'variant_gtins', 'badges'],
  recent_searches: ['filters'],
  query_log: ['filters'],
  ranking_policies: ['factors'],
};

function enc(table: keyof SearchDb, row: object): any {
  const cols = JSON_COLUMNS[table] ?? [];
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v === undefined) continue;
    out[k] = cols.includes(k) && v !== null ? JSON.stringify(v) : v;
  }
  return out;
}

/** ILIKE pattern with the user's text taken literally */
const contains = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** The full-text vector: title A, brand A, category B, attributes C, description D */
const tsvOf = (t: DocWrite['texts']) => sql`
  setweight(to_tsvector('english', ${t.title}), 'A') ||
  setweight(to_tsvector('english', ${t.brand}), 'A') ||
  setweight(to_tsvector('english', ${t.category}), 'B') ||
  setweight(to_tsvector('english', ${t.attributes}), 'C') ||
  setweight(to_tsvector('english', ${t.description}), 'D')`;

/**
 * Postgres adapter for SearchRepository. `db` is scoped to the `search` schema; `inbox` (ctx.inbox) records what
 * idempotent consumers handled, in the same transaction as their effects.
 */
export function createPostgresSearchRepository(db: Db, inbox: Inbox): SearchRepository {
  const repo = (d: Db): SearchRepository => ({
    transaction: (fn) => (d.isTransaction ? fn(repo(d)) : d.transaction().execute((trx) => fn(repo(trx)))),
    claim: (key) => inbox.claim(d, key),

    /* ---------------------------------------------------------------- documents */

    async getDocument(productId) {
      return d.selectFrom('search_documents').selectAll().where('product_id', '=', productId).executeTakeFirst();
    },
    async getDocuments(ids) {
      if (!ids.length) return [];
      return d.selectFrom('search_documents').selectAll().where('product_id', 'in', [...new Set(ids)]).execute();
    },
    async upsertDocument(doc, offers, at) {
      const { texts, ...cols } = doc;
      const row = enc('search_documents', { ...cols, indexed_at: at });
      await d
        .insertInto('search_documents')
        .values({ ...row, version: 1, tsv: tsvOf(texts) } as never)
        .onConflict((oc) => oc.column('product_id').doUpdateSet({ ...row, version: sql`search_documents.version + 1`, tsv: tsvOf(texts) } as never))
        .execute();
      if (offers) {
        await d.deleteFrom('search_offers').where('product_id', '=', doc.product_id).execute();
        if (offers.length) {
          // an offer moved from another product (merge): its old row goes
          await d.deleteFrom('search_offers').where('offer_id', 'in', offers.map((o) => o.offer_id)).execute();
          await d.insertInto('search_offers').values(offers).execute();
        }
      }
    },
    async deleteDocument(productId) {
      await d.deleteFrom('search_offers').where('product_id', '=', productId).execute();
      await d.deleteFrom('search_documents').where('product_id', '=', productId).execute();
    },
    async updateDocument(productId, patch, at) {
      await d
        .updateTable('search_documents')
        .set({ ...enc('search_documents', patch), indexed_at: at, version: sql`version + 1` } as never)
        .where('product_id', '=', productId)
        .execute();
    },
    async offerRows(productIds) {
      if (!productIds.length) return [];
      return d.selectFrom('search_offers').selectAll().where('product_id', 'in', [...new Set(productIds)]).execute();
    },
    async offerRow(offerId) {
      return d.selectFrom('search_offers').selectAll().where('offer_id', '=', offerId).executeTakeFirst();
    },
    async upsertOfferRow(row) {
      await d
        .insertInto('search_offers')
        .values(row)
        .onConflict((oc) => oc.column('offer_id').doUpdateSet(row))
        .execute();
    },
    async updateOfferRow(offerId, patch) {
      if (!Object.keys(patch).length) return;
      await d.updateTable('search_offers').set(patch).where('offer_id', '=', offerId).execute();
    },
    async deleteOfferRow(offerId) {
      await d.deleteFrom('search_offers').where('offer_id', '=', offerId).execute();
    },
    async documentIds(f) {
      let q = d.selectFrom('search_documents').select('product_id');
      if (f.categoryIds) q = q.where(sql<boolean>`category_path_ids && ${f.categoryIds}::uuid[]`);
      if (f.brandIds) q = q.where('brand_id', 'in', f.brandIds.length ? f.brandIds : ['00000000-0000-0000-0000-000000000000']);
      if (f.sellerIds) q = q.where(sql<boolean>`seller_ids && ${f.sellerIds}::uuid[]`);
      if (f.onSale !== undefined) q = q.where('on_sale', '=', f.onSale);
      if (f.productIds) q = q.where('product_id', 'in', f.productIds.length ? f.productIds : ['00000000-0000-0000-0000-000000000000']);
      return (await q.execute()).map((r) => r.product_id);
    },
    async productIdsForOffers(offerIds) {
      if (!offerIds.length) return [];
      const rows = await d.selectFrom('search_offers').select('product_id').distinct().where('offer_id', 'in', offerIds).execute();
      return rows.map((r) => r.product_id);
    },
    async productIdForVariant(variantId) {
      const viaOffer = await d.selectFrom('search_offers').select('product_id').where('variant_id', '=', variantId).executeTakeFirst();
      if (viaOffer) return viaOffer.product_id;
      const viaDoc = await d
        .selectFrom('search_documents')
        .select('product_id')
        .where(sql<boolean>`variant_options @> ${JSON.stringify([{ id: variantId }])}::jsonb`)
        .executeTakeFirst();
      return viaDoc?.product_id;
    },
    async productIdsByGtin(gtin) {
      return d.selectFrom('search_documents').selectAll().where(sql<boolean>`gtins @> ${[gtin]}::text[]`).execute();
    },
    async documentStats() {
      const r = await d
        .selectFrom('search_documents')
        .select([sql<number>`count(*)::int`.as('n'), sql<Date | null>`max(indexed_at)`.as('last')])
        .executeTakeFirstOrThrow();
      const o = await d.selectFrom('search_offers').select(sql<number>`count(*)::int`.as('n')).executeTakeFirstOrThrow();
      return { documents: r.n, offerRows: o.n, lastIndexedAt: r.last ? new Date(r.last) : null };
    },

    /* ---------------------------------------------------------------- sales */

    async recordSales(day, units, sign, at) {
      for (const u of units) {
        if (u.units <= 0) continue;
        const n = sign * u.units;
        await d
          .insertInto('product_sales_daily')
          .values({ product_id: u.productId, day, units: Math.max(n, 0), orders: sign > 0 ? 1 : 0, updated_at: at })
          .onConflict((oc) =>
            oc.columns(['product_id', 'day']).doUpdateSet({
              units: sql`greatest(product_sales_daily.units + ${n}, 0)`,
              orders: sql`greatest(product_sales_daily.orders + ${sign}, 0)`,
              updated_at: at,
            } as never),
          )
          .execute();
        await d
          .updateTable('search_documents')
          .set({ popularity: sql`greatest(popularity + ${n}, 0)`, sales_30d: sql`greatest(sales_30d + ${n}, 0)` } as never)
          .where('product_id', '=', u.productId)
          .execute();
      }
    },
    async sumSales(from) {
      await sql`
        update search.search_documents doc
           set sales_30d = x.units, popularity = x.units
          from (select d2.product_id, coalesce(sum(s.units), 0)::int as units
                  from search.search_documents d2
                  left join search.product_sales_daily s on s.product_id = d2.product_id and s.day >= ${from}::date
                 group by d2.product_id) x
         where x.product_id = doc.product_id
           and (doc.sales_30d <> x.units or doc.popularity <> x.units)`.execute(d);
    },
    async pruneSales(before) {
      await d.deleteFrom('product_sales_daily').where('day', '<', before).execute();
    },
    async platformUnits30d() {
      const r = await d.selectFrom('search_documents').select(sql<number>`coalesce(sum(sales_30d), 0)::int`.as('n')).executeTakeFirstOrThrow();
      return r.n;
    },
    async rankBestSellers(top, enabled) {
      if (!enabled) {
        await d.updateTable('search_documents').set({ best_seller_rank: null, best_seller_category_id: null }).where('best_seller_rank', 'is not', null).execute();
        return;
      }
      await sql`
        with ranked as (
          select product_id, category_id,
                 row_number() over (partition by category_id order by sales_30d desc, rating_count desc, product_id) as r
          from search.search_documents
          where category_id is not null and sales_30d > 0
        )
        update search.search_documents d
           set best_seller_rank = case when ranked.r <= ${top} then ranked.r::int end,
               best_seller_category_id = case when ranked.r <= ${top} then ranked.category_id end
          from ranked
         where ranked.product_id = d.product_id`.execute(d);
      await d.updateTable('search_documents').set({ best_seller_rank: null, best_seller_category_id: null }).where('sales_30d', '<=', 0).execute();
    },
    async bestSellerRows(ids) {
      if (!ids.length) return [];
      return d.selectFrom('search_documents').selectAll().where('product_id', 'in', ids).where('best_seller_rank', 'is not', null).execute();
    },

    /* ---------------------------------------------------------------- dirty documents */

    async markDirty(ids, reason, at) {
      const unique = [...new Set(ids)];
      if (!unique.length) return;
      await d
        .insertInto('dirty_documents')
        .values(unique.map((product_id) => ({ product_id, reason, queued_at: at })))
        .onConflict((oc) => oc.column('product_id').doUpdateSet({ reason, queued_at: at }))
        .execute();
    },
    async takeDirty(limit) {
      return d.selectFrom('dirty_documents').selectAll().orderBy('queued_at').orderBy('product_id').limit(limit).execute();
    },
    async clearDirty(productId, queuedAt) {
      // a product marked again while it was being rebuilt stays queued
      await d.deleteFrom('dirty_documents').where('product_id', '=', productId).where('queued_at', '<=', queuedAt).execute();
    },
    async dirtyStats() {
      const r = await d
        .selectFrom('dirty_documents')
        .select([sql<number>`count(*)::int`.as('n'), sql<Date | null>`min(queued_at)`.as('oldest')])
        .executeTakeFirstOrThrow();
      return { count: r.n, oldest: r.oldest ? new Date(r.oldest) : null };
    },

    /* ---------------------------------------------------------------- suggestion terms */

    async upsertTerm(kind, targetId, term, weight, at) {
      let del = d.deleteFrom('suggestion_terms').where('kind', '=', kind);
      del = targetId ? del.where('target_id', '=', targetId) : del.where('target_id', 'is', null).where('term', '=', term);
      await del.execute();
      await d.insertInto('suggestion_terms').values({ id: newId(), kind, target_id: targetId, term, weight: String(weight), updated_at: at }).execute();
    },
    async deleteTerms(kind, targetIds) {
      if (!targetIds.length) return;
      await d.deleteFrom('suggestion_terms').where('kind', '=', kind).where('target_id', 'in', targetIds).execute();
    },
    async replaceTerms(kind, rows, at) {
      await d.deleteFrom('suggestion_terms').where('kind', '=', kind).execute();
      for (let i = 0; i < rows.length; i += 500) {
        const chunk = rows.slice(i, i + 500);
        if (chunk.length) {
          await d
            .insertInto('suggestion_terms')
            .values(chunk.map((r) => ({ id: newId(), kind, term: r.term, target_id: r.targetId, weight: String(r.weight), updated_at: at })))
            .execute();
        }
      }
    },
    async terms(kind: TermKind, targetIds?: string[]) {
      let q = d.selectFrom('suggestion_terms').selectAll().where('kind', '=', kind);
      if (targetIds) {
        if (!targetIds.length) return [];
        q = q.where('target_id', 'in', targetIds);
      }
      return q.orderBy('weight', 'desc').execute();
    },

    /* ---------------------------------------------------------------- synonyms */

    async listSynonyms(f) {
      let q = d.selectFrom('synonyms').selectAll();
      if (f.active !== undefined) q = q.where('active', '=', f.active);
      if (f.q?.trim()) {
        const pattern = contains(f.q.trim().toLowerCase());
        q = q.where((eb) => eb.or([eb(sql`array_to_string(terms, ' ')`, 'ilike', pattern), eb('from_term', 'ilike', pattern), eb('note', 'ilike', pattern)]));
      }
      return q.orderBy('updated_at', 'desc').orderBy('id').execute();
    },
    async getSynonym(id) {
      return d.selectFrom('synonyms').selectAll().where('id', '=', id).executeTakeFirst();
    },
    async insertSynonym(row) {
      return d.insertInto('synonyms').values(row).returningAll().executeTakeFirstOrThrow();
    },
    async updateSynonym(id, patch) {
      return d.updateTable('synonyms').set(patch).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
    },
    async deleteSynonym(id) {
      await d.deleteFrom('synonyms').where('id', '=', id).execute();
    },
    async activeSynonyms() {
      return d.selectFrom('synonyms').selectAll().where('active', '=', true).execute();
    },

    /* ---------------------------------------------------------------- recent searches */

    async recentSearches(owner, limit) {
      return d
        .selectFrom('recent_searches')
        .selectAll()
        .where('owner_kind', '=', owner.kind)
        .where('owner_id', '=', owner.id)
        .orderBy('searched_at', 'desc')
        .orderBy('id', 'desc')
        .limit(limit)
        .execute();
    },
    async saveRecentSearch(row, max) {
      // the same query and filters again moves to the top instead of repeating
      await d
        .deleteFrom('recent_searches')
        .where('owner_kind', '=', row.owner_kind)
        .where('owner_id', '=', row.owner_id)
        .where(sql<boolean>`lower(query) = lower(${row.query})`)
        .where(sql<boolean>`filters = ${JSON.stringify(row.filters)}::jsonb`)
        .execute();
      await d.insertInto('recent_searches').values(enc('recent_searches', row)).execute();
      await trimRecent(d, { kind: row.owner_kind, id: row.owner_id }, max);
    },
    async deleteRecentSearch(owner, id) {
      const r = await d.deleteFrom('recent_searches').where('id', '=', id).where('owner_kind', '=', owner.kind).where('owner_id', '=', owner.id).executeTakeFirst();
      return Number(r.numDeletedRows) > 0;
    },
    async clearRecentSearches(owner) {
      const r = await d.deleteFrom('recent_searches').where('owner_kind', '=', owner.kind).where('owner_id', '=', owner.id).executeTakeFirst();
      return Number(r.numDeletedRows);
    },
    async moveRecentSearches(from, to, max) {
      const rows = await d.selectFrom('recent_searches').selectAll().where('owner_kind', '=', from.kind).where('owner_id', '=', from.id).execute();
      // the same search on both sides: the newer one stays
      for (const r of rows) {
        const same = (q: { where: any }) =>
          q
            .where('owner_kind', '=', to.kind)
            .where('owner_id', '=', to.id)
            .where(sql<boolean>`lower(query) = lower(${r.query})`)
            .where(sql<boolean>`filters = ${JSON.stringify(r.filters)}::jsonb`);
        const newer = await same(d.selectFrom('recent_searches').select('id')).where('searched_at', '>', r.searched_at).executeTakeFirst();
        if (newer) await d.deleteFrom('recent_searches').where('id', '=', r.id).execute();
        else await same(d.deleteFrom('recent_searches')).execute();
      }
      const moved = await d
        .updateTable('recent_searches')
        .set({ owner_kind: to.kind, owner_id: to.id })
        .where('owner_kind', '=', from.kind)
        .where('owner_id', '=', from.id)
        .executeTakeFirst();
      await trimRecent(d, to, max);
      return Number(moved.numUpdatedRows);
    },
    async pruneRecentSearches(before) {
      const r = await d.deleteFrom('recent_searches').where('searched_at', '<', before).executeTakeFirst();
      return Number(r.numDeletedRows);
    },

    /* ---------------------------------------------------------------- logs */

    async logQuery(row) {
      await d.insertInto('query_log').values(enc('query_log', row)).execute();
    },
    async logClick(row) {
      await d.insertInto('click_log').values(row).execute();
    },
    async searchLogged(searchId) {
      return Boolean(await d.selectFrom('query_log').select('id').where('search_id', '=', searchId).executeTakeFirst());
    },
    async zeroResults(from, to) {
      const rows = await sql<{ query: string; normalized: string; count: number; last_at: Date; last_filters: unknown; correction_offered: boolean }>`
        select distinct on (z.normalized)
               z.raw as query, z.normalized, z.n::int as count, z.last_at, z.filters as last_filters, z.corrected as correction_offered
          from (
            select q.normalized, q.raw, q.filters, q.at,
                   count(*) over (partition by q.normalized) as n,
                   max(q.at) over (partition by q.normalized) as last_at,
                   bool_or(q.corrected_to is not null) over (partition by q.normalized) as corrected
              from search.query_log q
             where q.results = 0 and q.normalized is not null and q.normalized <> '' and q.at >= ${from} and q.at < ${to}
          ) z
         order by z.normalized, z.at desc`.execute(d);
      return rows.rows
        .map((r) => ({ query: r.query ?? r.normalized, normalized: r.normalized, count: r.count, lastAt: new Date(r.last_at), lastFilters: (r.last_filters ?? null) as never, correctionOffered: r.correction_offered }))
        .sort((a, b) => b.count - a.count || b.lastAt.getTime() - a.lastAt.getTime() || a.normalized.localeCompare(b.normalized));
    },
    async popularQueries(since, limit) {
      const rows = await d
        .selectFrom('query_log')
        .select(['normalized', sql<number>`count(*)::int`.as('count')])
        .where('at', '>=', since)
        .where('results', '>', 0)
        .where('normalized', 'is not', null)
        .where('normalized', '<>', '')
        .groupBy('normalized')
        .orderBy(sql`count(*)`, 'desc')
        .orderBy('normalized')
        .limit(limit)
        .execute();
      return rows.map((r) => ({ normalized: r.normalized!, count: r.count }));
    },
    async pruneLogs(before) {
      const q = await d.deleteFrom('query_log').where('at', '<', before).executeTakeFirst();
      const c = await d.deleteFrom('click_log').where('at', '<', before).executeTakeFirst();
      return { queries: Number(q.numDeletedRows), clicks: Number(c.numDeletedRows) };
    },

    /* ---------------------------------------------------------------- reindex jobs */

    async insertJob(row) {
      return d.insertInto('reindex_jobs').values(row).returningAll().executeTakeFirstOrThrow();
    },
    async getJob(id) {
      return d.selectFrom('reindex_jobs').selectAll().where('id', '=', id).executeTakeFirst();
    },
    async updateJob(id, patch) {
      return d.updateTable('reindex_jobs').set(patch).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
    },
    async activeFullJob() {
      return d.selectFrom('reindex_jobs').selectAll().where('scope', '=', 'all').where('state', 'in', ['queued', 'running']).orderBy('id').executeTakeFirst();
    },
    async queuedJobs() {
      return d.selectFrom('reindex_jobs').selectAll().where('state', 'in', ['queued', 'running']).orderBy('id').execute();
    },
    async lastCompletedFullJob() {
      return d.selectFrom('reindex_jobs').selectAll().where('scope', '=', 'all').where('state', '=', 'completed').orderBy('finished_at', 'desc').executeTakeFirst();
    },

    /* ---------------------------------------------------------------- ranking policies */

    async currentPolicy(at) {
      return d.selectFrom('ranking_policies').selectAll().where('effective_from', '<=', at).orderBy('effective_from', 'desc').orderBy('version', 'desc').executeTakeFirst();
    },
    async latestPolicyVersion() {
      const r = await d.selectFrom('ranking_policies').select(sql<number>`coalesce(max(version), 0)::int`.as('v')).executeTakeFirstOrThrow();
      return r.v;
    },
    async insertPolicy(row) {
      return d.insertInto('ranking_policies').values(enc('ranking_policies', row)).returningAll().executeTakeFirstOrThrow();
    },
  });
  return repo(db);
}

async function trimRecent(d: Db, owner: { kind: 'customer' | 'guest'; id: string }, max: number) {
  const keep = await d
    .selectFrom('recent_searches')
    .select('id')
    .where('owner_kind', '=', owner.kind)
    .where('owner_id', '=', owner.id)
    .orderBy('searched_at', 'desc')
    .orderBy('id', 'desc')
    .limit(max)
    .execute();
  let q = d.deleteFrom('recent_searches').where('owner_kind', '=', owner.kind).where('owner_id', '=', owner.id);
  if (keep.length) q = q.where('id', 'not in', keep.map((k) => k.id));
  await q.execute();
}

export type { DocRow, OfferRow };
