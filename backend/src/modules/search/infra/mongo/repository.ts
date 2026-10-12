import type { ModuleStore } from '../../../../kernel/mongo/index.js';
import type { Filter } from '../../../../kernel/mongo/table.js';
import { newId } from '../../../../kernel/lib/ids.js';
import type { SearchDb } from '../../../../spec/search.js';
import type { DocRow, OfferRow, PolicyRow, QueryLogRow, RecentRow, ReindexJobRow, SearchRepository, SynonymRow, TermKind, TermRow } from '../../ports.js';
import { escapeRegExp, termsOf } from './text.js';

type ClickRow = SearchDb['click_log'];
type SalesRow = SearchDb['product_sales_daily'];
type DirtyRow = SearchDb['dirty_documents'];
type Owner = { kind: 'customer' | 'guest'; id: string };

/** One of `values` (an empty list matches nothing, as an empty IN does) */
const oneOf = (values: readonly unknown[]) => ({ $in: [...new Set(values)] });
/** ILIKE '%q%' with the text taken literally */
const contains = (q: string) => ({ $regex: escapeRegExp(q), $options: 'i' });

/** jsonb equality: the same JSON value whatever the key order */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v instanceof Date) return JSON.stringify(v.toISOString());
  if (v && typeof v === 'object') {
    return `{${Object.keys(v)
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}
/** The same recent search: lower(query) and the filters */
const sameSearch = (a: { query: string; filters: unknown }, b: { query: string; filters: unknown }) => a.query.toLowerCase() === b.query.toLowerCase() && canonical(a.filters) === canonical(b.filters);

/**
 * MongoDB adapter for SearchRepository (docs/04-mongodb-migration.md): the read model of the index, one
 * collection per spec table. Documents carry their search terms (text.ts), which the MongoDB engine matches.
 */
export function createMongoSearchRepository(store: ModuleStore): SearchRepository {
  const t = {
    docs: store.table<DocRow>('search_documents'),
    offers: store.table<OfferRow>('search_offers'),
    terms: store.table<TermRow>('suggestion_terms'),
    synonyms: store.table<SynonymRow>('synonyms'),
    recent: store.table<RecentRow>('recent_searches'),
    queries: store.table<QueryLogRow>('query_log'),
    clicks: store.table<ClickRow>('click_log'),
    sales: store.table<SalesRow>('product_sales_daily'),
    dirty: store.table<DirtyRow>('dirty_documents'),
    jobs: store.table<ReindexJobRow>('reindex_jobs'),
    policies: store.table<PolicyRow>('ranking_policies'),
  };
  const session = store.session;

  /** Keeps an owner's newest `max` recent searches (searched_at desc, id desc) */
  async function trimRecent(owner: Owner, max: number) {
    const extra = await t.recent.find({ owner_kind: owner.kind, owner_id: owner.id }, { sort: { searched_at: -1, id: -1 }, skip: max });
    if (extra.length) await t.recent.deleteMany({ id: oneOf(extra.map((r) => r.id)) });
  }
  const ownerRows = (owner: Owner) => t.recent.find({ owner_kind: owner.kind, owner_id: owner.id });

  const repo: SearchRepository = {
    transaction: (fn) => store.transaction((tx) => fn(createMongoSearchRepository(tx))),
    claim: (key) => store.claim(key),

    /* ---------------------------------------------------------------- documents */

    getDocument: (productId) => t.docs.get(productId),
    getDocuments: (ids) => t.docs.getMany([...new Set(ids)]),
    async upsertDocument(doc, offers, at) {
      const { texts, product_id, ...cols } = doc;
      // version: 1 for a new document, one more for a replaced one
      await t.docs.model.updateOne(
        { _id: product_id },
        { $set: t.docs.toDoc({ ...cols, terms: termsOf(texts), indexed_at: at }), $inc: { version: 1 } },
        { upsert: true, session, runValidators: true },
      );
      if (offers) {
        await t.offers.deleteMany({ product_id });
        if (offers.length) {
          // an offer moved from another product (merge): its old row goes
          await t.offers.deleteMany({ offer_id: oneOf(offers.map((o) => o.offer_id)) });
          await t.offers.insertMany(offers);
        }
      }
    },
    async deleteDocument(productId) {
      await t.offers.deleteMany({ product_id: productId });
      await t.docs.delete(productId);
    },
    async updateDocument(productId, patch, at) {
      await t.docs.updateOne({ product_id: productId }, { $set: { ...patch, indexed_at: at }, $inc: { version: 1 } });
    },
    async offerRows(productIds) {
      if (!productIds.length) return [];
      return t.offers.find({ product_id: oneOf(productIds) });
    },
    offerRow: (offerId) => t.offers.get(offerId),
    async upsertOfferRow(row) {
      await t.offers.upsert(row);
    },
    async updateOfferRow(offerId, patch) {
      if (!Object.keys(patch).length) return;
      await t.offers.update(offerId, patch);
    },
    async deleteOfferRow(offerId) {
      await t.offers.delete(offerId);
    },
    async documentIds(f) {
      const filter: Filter = {
        ...(f.categoryIds ? { category_path_ids: oneOf(f.categoryIds) } : {}),
        ...(f.brandIds ? { brand_id: oneOf(f.brandIds) } : {}),
        ...(f.sellerIds ? { seller_ids: oneOf(f.sellerIds) } : {}),
        ...(f.onSale !== undefined ? { on_sale: f.onSale } : {}),
        ...(f.productIds ? { product_id: oneOf(f.productIds) } : {}),
      };
      const rows = await t.docs.aggregate<{ _id: string }>([{ $match: t.docs.filter(filter) }, { $project: { _id: 1 } }, { $sort: { _id: 1 } }]);
      return rows.map((r) => r._id);
    },
    async productIdsForOffers(offerIds) {
      if (!offerIds.length) return [];
      return t.offers.distinct<string>('product_id', { offer_id: oneOf(offerIds) });
    },
    async productIdForVariant(variantId) {
      const viaOffer = await t.offers.findOne({ variant_id: variantId });
      if (viaOffer) return viaOffer.product_id;
      const viaDoc = await t.docs.aggregate<{ _id: string }>([{ $match: { 'variant_options.id': variantId } }, { $limit: 1 }, { $project: { _id: 1 } }]);
      return viaDoc[0]?._id;
    },
    productIdsByGtin: (gtin) => t.docs.find({ gtins: gtin }),
    async documentStats() {
      const documents = await t.docs.count();
      const last = await t.docs.aggregate<{ last: Date | null }>([{ $group: { _id: null, last: { $max: '$indexed_at' } } }]);
      const offerRows = await t.offers.count();
      return { documents, offerRows, lastIndexedAt: last[0]?.last ? new Date(last[0].last) : null };
    },

    /* ---------------------------------------------------------------- sales */

    async recordSales(day, units, sign, at) {
      for (const u of units) {
        if (u.units <= 0) continue;
        const n = sign * u.units;
        // greatest(units + n, 0): one atomic upsert per product and day
        await t.sales.model.updateOne(
          { product_id: u.productId, day },
          [
            {
              $set: {
                units: { $max: [{ $add: [{ $ifNull: ['$units', 0] }, n] }, 0] },
                orders: { $max: [{ $add: [{ $ifNull: ['$orders', 0] }, sign] }, 0] },
                updated_at: at,
              },
            },
          ],
          { upsert: true, session },
        );
        await t.docs.updateOne({ product_id: u.productId }, [
          {
            $set: {
              popularity: { $toDecimal: { $max: [{ $add: ['$popularity', n] }, 0] } },
              sales_30d: { $max: [{ $add: ['$sales_30d', n] }, 0] },
            },
          },
        ]);
      }
    },
    async sumSales(from) {
      const sums = await t.sales.aggregate<{ _id: string; units: number }>([{ $match: { day: { $gte: from } } }, { $group: { _id: '$product_id', units: { $sum: '$units' } } }]);
      const units = new Map(sums.filter((s) => s.units !== 0).map((s) => [s._id, s.units]));
      // documents without sales in the window: 0
      await t.docs.updateMany({ product_id: { $nin: [...units.keys()] }, $or: [{ sales_30d: { $ne: 0 } }, { popularity: { $ne: '0' } }] }, { sales_30d: 0, popularity: '0' });
      const ops = [...units].map(([id, n]) => ({
        updateOne: { filter: { _id: id, $or: [{ sales_30d: { $ne: n } }, { popularity: { $ne: n } }] }, update: { $set: { sales_30d: n, popularity: t.docs.toDoc({ popularity: String(n) }).popularity } } },
      }));
      for (let i = 0; i < ops.length; i += 500) await t.docs.model.bulkWrite(ops.slice(i, i + 500) as never, { session });
    },
    async pruneSales(before) {
      await t.sales.deleteMany({ day: { $lt: before } });
    },
    async platformUnits30d() {
      const r = await t.docs.aggregate<{ n: number }>([{ $group: { _id: null, n: { $sum: '$sales_30d' } } }]);
      return r[0]?.n ?? 0;
    },
    async rankBestSellers(top, enabled) {
      if (!enabled) {
        await t.docs.updateMany({ best_seller_rank: { $ne: null } }, { best_seller_rank: null, best_seller_category_id: null });
        return;
      }
      const ranked = await t.docs.aggregate<{ _id: string; category_id: string; r: number }>([
        { $match: { category_id: { $ne: null }, sales_30d: { $gt: 0 } } },
        // row_number() over (partition by category_id order by sales_30d desc, rating_count desc, product_id)
        { $sort: { category_id: 1, sales_30d: -1, rating_count: -1, _id: 1 } },
        { $group: { _id: '$category_id', ids: { $push: '$_id' } } },
        { $unwind: { path: '$ids', includeArrayIndex: 'i' } },
        { $project: { _id: '$ids', category_id: '$_id', r: { $add: ['$i', 1] } } },
      ]);
      const ops = ranked.map((x) => ({
        updateOne: { filter: { _id: x._id }, update: { $set: x.r <= top ? { best_seller_rank: x.r, best_seller_category_id: x.category_id } : { best_seller_rank: null, best_seller_category_id: null } } },
      }));
      for (let i = 0; i < ops.length; i += 500) await t.docs.model.bulkWrite(ops.slice(i, i + 500) as never, { session });
      await t.docs.updateMany({ sales_30d: { $lte: 0 } }, { best_seller_rank: null, best_seller_category_id: null });
    },
    async bestSellerRows(ids) {
      if (!ids.length) return [];
      return t.docs.find({ product_id: oneOf(ids), best_seller_rank: { $ne: null } });
    },

    /* ---------------------------------------------------------------- dirty documents */

    async markDirty(ids, reason, at) {
      const unique = [...new Set(ids)];
      if (!unique.length) return;
      await t.dirty.upsertMany(unique.map((product_id) => ({ product_id, reason, queued_at: at })));
    },
    takeDirty: (limit) => t.dirty.find({}, { sort: { queued_at: 1, product_id: 1 }, limit }),
    async clearDirty(productId, queuedAt) {
      // a product marked again while it was being rebuilt stays queued
      await t.dirty.deleteMany({ product_id: productId, queued_at: { $lte: queuedAt } });
    },
    async dirtyStats() {
      const count = await t.dirty.count();
      const oldest = await t.dirty.findOne({}, { sort: { queued_at: 1 } });
      return { count, oldest: oldest?.queued_at ?? null };
    },

    /* ---------------------------------------------------------------- suggestion terms */

    async upsertTerm(kind, targetId, term, weight, at) {
      await t.terms.deleteMany(targetId ? { kind, target_id: targetId } : { kind, target_id: null, term });
      await t.terms.insert({ id: newId(), kind, target_id: targetId, term, weight: String(weight), updated_at: at });
    },
    async deleteTerms(kind, targetIds) {
      if (!targetIds.length) return;
      await t.terms.deleteMany({ kind, target_id: oneOf(targetIds) });
    },
    async replaceTerms(kind, rows, at) {
      await t.terms.deleteMany({ kind });
      for (let i = 0; i < rows.length; i += 500) {
        await t.terms.insertMany(rows.slice(i, i + 500).map((r) => ({ id: newId(), kind, term: r.term, target_id: r.targetId, weight: String(r.weight), updated_at: at })));
      }
    },
    async terms(kind: TermKind, targetIds?: string[]) {
      if (targetIds && !targetIds.length) return [];
      return t.terms.find({ kind, ...(targetIds ? { target_id: oneOf(targetIds) } : {}) }, { sort: { weight: -1 } });
    },

    /* ---------------------------------------------------------------- synonyms */

    listSynonyms(f) {
      const p = f.q?.trim().toLowerCase();
      return t.synonyms.find(
        {
          ...(f.active !== undefined ? { active: f.active } : {}),
          ...(p ? { $or: [{ terms: contains(p) }, { from_term: contains(p) }, { note: contains(p) }] } : {}),
        },
        { sort: { updated_at: -1, id: 1 } },
      );
    },
    getSynonym: (id) => t.synonyms.get(id),
    insertSynonym: (row) => t.synonyms.insert(row),
    async updateSynonym(id, patch) {
      const row = Object.keys(patch).length ? await t.synonyms.update(id, patch) : await t.synonyms.get(id);
      if (!row) throw new Error(`search: synonym ${id} not found`);
      return row;
    },
    async deleteSynonym(id) {
      await t.synonyms.delete(id);
    },
    activeSynonyms: () => t.synonyms.find({ active: true }),

    /* ---------------------------------------------------------------- recent searches */

    recentSearches: (owner, limit) => t.recent.find({ owner_kind: owner.kind, owner_id: owner.id }, { sort: { searched_at: -1, id: -1 }, limit }),
    async saveRecentSearch(row, max) {
      // the same query and filters again moves to the top instead of repeating
      const same = (await ownerRows({ kind: row.owner_kind, id: row.owner_id })).filter((r) => sameSearch(r, row));
      if (same.length) await t.recent.deleteMany({ id: oneOf(same.map((r) => r.id)) });
      await t.recent.insert(row);
      await trimRecent({ kind: row.owner_kind, id: row.owner_id }, max);
    },
    async deleteRecentSearch(owner, id) {
      return (await t.recent.deleteMany({ id, owner_kind: owner.kind, owner_id: owner.id })) > 0;
    },
    clearRecentSearches: (owner) => t.recent.deleteMany({ owner_kind: owner.kind, owner_id: owner.id }),
    async moveRecentSearches(from, to, max) {
      const rows = await ownerRows(from);
      // the same search on both sides: the newer one stays
      for (const r of rows) {
        const same = (await ownerRows(to)).filter((x) => sameSearch(x, r));
        if (same.some((x) => x.searched_at > r.searched_at)) await t.recent.delete(r.id);
        else if (same.length) await t.recent.deleteMany({ id: oneOf(same.map((x) => x.id)) });
      }
      const moved = await t.recent.updateMany({ owner_kind: from.kind, owner_id: from.id }, { owner_kind: to.kind, owner_id: to.id });
      await trimRecent(to, max);
      return moved;
    },
    pruneRecentSearches: (before) => t.recent.deleteMany({ searched_at: { $lt: before } }),

    /* ---------------------------------------------------------------- logs */

    async logQuery(row) {
      await t.queries.insert(row);
    },
    async logClick(row) {
      await t.clicks.insert(row);
    },
    searchLogged: (searchId) => t.queries.exists({ search_id: searchId }),
    async zeroResults(from, to) {
      const rows = await t.queries.aggregate<{ _id: string; query: string | null; count: number; last_at: Date; last_filters: unknown; correction_offered: boolean }>([
        { $match: { results: 0, normalized: { $nin: [null, ''] }, at: { $gte: from, $lt: to } } },
        { $sort: { normalized: 1, at: -1 } },
        {
          $group: {
            _id: '$normalized',
            query: { $first: '$raw' },
            last_filters: { $first: '$filters' },
            count: { $sum: 1 },
            last_at: { $max: '$at' },
            correction_offered: { $max: { $ne: [{ $ifNull: ['$corrected_to', null] }, null] } },
          },
        },
      ]);
      return rows
        .map((r) => ({ query: r.query ?? r._id, normalized: r._id, count: r.count, lastAt: new Date(r.last_at), lastFilters: (r.last_filters ?? null) as never, correctionOffered: Boolean(r.correction_offered) }))
        .sort((a, b) => b.count - a.count || b.lastAt.getTime() - a.lastAt.getTime() || a.normalized.localeCompare(b.normalized));
    },
    async popularQueries(since, limit) {
      const rows = await t.queries.aggregate<{ _id: string; count: number }>([
        { $match: { at: { $gte: since }, results: { $gt: 0 }, normalized: { $nin: [null, ''] } } },
        { $group: { _id: '$normalized', count: { $sum: 1 } } },
        { $sort: { count: -1, _id: 1 } },
        { $limit: limit },
      ]);
      return rows.map((r) => ({ normalized: r._id, count: r.count }));
    },
    async pruneLogs(before) {
      const queries = await t.queries.deleteMany({ at: { $lt: before } });
      const clicks = await t.clicks.deleteMany({ at: { $lt: before } });
      return { queries, clicks };
    },

    /* ---------------------------------------------------------------- reindex jobs */

    insertJob: (row) => t.jobs.insert(row),
    getJob: (id) => t.jobs.get(id),
    async updateJob(id, patch) {
      const row = Object.keys(patch).length ? await t.jobs.update(id, patch) : await t.jobs.get(id);
      if (!row) throw new Error(`search: reindex job ${id} not found`);
      return row;
    },
    activeFullJob: () => t.jobs.findOne({ scope: 'all', state: oneOf(['queued', 'running']) }, { sort: { id: 1 } }),
    queuedJobs: () => t.jobs.find({ state: oneOf(['queued', 'running']) }, { sort: { id: 1 } }),
    // finished_at descending with nulls first: a completed job without a finish time counts as the latest
    async lastCompletedFullJob() {
      return (await t.jobs.findOne({ scope: 'all', state: 'completed', finished_at: null })) ?? t.jobs.findOne({ scope: 'all', state: 'completed' }, { sort: { finished_at: -1 } });
    },

    /* ---------------------------------------------------------------- ranking policies */

    currentPolicy: (at) => t.policies.findOne({ effective_from: { $lte: at } }, { sort: { effective_from: -1, version: -1 } }),
    async latestPolicyVersion() {
      return (await t.policies.findOne({}, { sort: { version: -1 } }))?.version ?? 0;
    },
    insertPolicy: (row) => t.policies.insert(row),
  };
  return repo;
}
