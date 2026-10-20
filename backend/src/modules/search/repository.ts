import { newId } from '../../kernel/lib/ids.js';
import type { Json } from '../../kernel/lib/json.js';
import { contains, type Filter, type ModuleStore } from '../../kernel/mongo/index.js';
import type { SearchDb } from '../../spec/search.js';
import type { DocRow, DocWrite, OfferRow, PolicyRow, QueryLogRow, RecentRow, ReindexJobRow, SynonymRow, TermKind, TermRow } from './ports.js';
import { termsOf } from './text.js';
import { DERIVED_FIELDS, STORE_CARDS } from './cards.js';

type ClickRow = SearchDb['click_log'];
type SalesRow = SearchDb['product_sales_daily'];
type DirtyRow = SearchDb['dirty_documents'];
type Owner = { kind: 'customer' | 'guest'; id: string };

/** One of `values` (an empty list matches nothing, as an empty IN does) */
const oneOf = (values: readonly unknown[]) => ({ $in: [...new Set(values)] });

/** JSON equality: the same JSON value whatever the key order */
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
 * A product's offer as its search document keeps it (`offers`, docs/07-search-speed-plan.md): the search_offers row as
 * stored (offer id as _id), without product_id. The MongoDB engine reads these instead of joining search_offers.
 */
export interface EmbeddedOffer {
  _id: string;
  variant_id: string;
  seller_id: string | null;
  official: boolean;
  condition: string;
  price: number;
  in_stock: boolean;
  free_delivery: boolean;
  dispatch_days: number;
  featured_eligible: boolean;
}
const embedded = (o: OfferRow): EmbeddedOffer => ({
  _id: o.offer_id,
  variant_id: o.variant_id,
  seller_id: o.seller_id ?? null,
  official: o.official,
  condition: o.condition,
  price: Number(o.price),
  in_stock: o.in_stock,
  free_delivery: o.free_delivery,
  dispatch_days: Number(o.dispatch_days),
  featured_eligible: o.featured_eligible,
});
const embeddedList = (rows: readonly OfferRow[]) => rows.map(embedded).sort((a, b) => (a._id < b._id ? -1 : a._id > b._id ? 1 : 0));

/**
 * Rebuilds every document's `offers` from search_offers in one pass (the migration and a sync after each start: a
 * release that ran before the column existed may have changed offer rows without it). Same shape as `embedded`.
 * A document whose offers changed while this ran (a live offer event) keeps them: the new list is written only where
 * the stored one is still the one read (`_read`).
 */
export const EMBED_OFFERS_PIPELINE: readonly Record<string, unknown>[] = [
  { $lookup: { from: 'search.search_offers', localField: '_id', foreignField: 'product_id', as: 'o' } },
  {
    $project: {
      _read: { $ifNull: ['$offers', null] },
      offers: {
        $sortArray: {
          input: {
            $map: {
              input: '$o',
              as: 'x',
              in: {
                _id: '$$x._id',
                variant_id: '$$x.variant_id',
                seller_id: { $ifNull: ['$$x.seller_id', null] },
                official: '$$x.official',
                condition: '$$x.condition',
                price: '$$x.price',
                in_stock: '$$x.in_stock',
                free_delivery: '$$x.free_delivery',
                dispatch_days: '$$x.dispatch_days',
                featured_eligible: '$$x.featured_eligible',
              },
            },
          },
          sortBy: { _id: 1 },
        },
      },
    },
  },
  {
    $merge: {
      into: 'search.search_documents',
      on: '_id',
      whenMatched: [{ $set: { offers: { $cond: [{ $eq: [{ $ifNull: ['$offers', null] }, '$$new._read'] }, '$$new.offers', '$offers'] } } }, STORE_CARDS],
      whenNotMatched: 'discard',
    },
  },
];

/**
 * The search module's collections (MongoDB, docs/04-mongodb-migration.md): the read model of the index, one
 * collection per spec table. Documents carry their search terms (text.ts), which the MongoDB engine matches.
 * With OpenSearch, index-feed.ts extends this class to pass every committed document write on to the engine.
 */
export class SearchRepository {
  readonly #t;
  readonly #session;

  constructor(protected readonly store: ModuleStore) {
    this.#t = {
      docs: this.store.table<DocRow>('search_documents'),
      offers: this.store.table<OfferRow>('search_offers'),
      terms: this.store.table<TermRow>('suggestion_terms'),
      synonyms: this.store.table<SynonymRow>('synonyms'),
      recent: this.store.table<RecentRow>('recent_searches'),
      queries: this.store.table<QueryLogRow>('query_log'),
      clicks: this.store.table<ClickRow>('click_log'),
      sales: this.store.table<SalesRow>('product_sales_daily'),
      dirty: this.store.table<DirtyRow>('dirty_documents'),
      jobs: this.store.table<ReindexJobRow>('reindex_jobs'),
      policies: this.store.table<PolicyRow>('ranking_policies'),
    };
    this.#session = this.store.session;
  }

  /** fn with a repository bound to one transaction */
  transaction<T>(fn: (tx: SearchRepository) => Promise<T>): Promise<T> {
    return this.store.transaction((tx) => fn(new SearchRepository(tx)));
  }

  /** Claims a key in the inbox (ctx.mongo.claim) within this repository's transaction; false when it was already handled */
  claim(key: string): Promise<boolean> {
    return this.store.claim(key);
  }

  /* ---------------------------------------------------------------- documents */
  getDocument(productId: string): Promise<DocRow | undefined> {
    return this.#t.docs.get(productId);
  }

  getDocuments(ids: string[]): Promise<DocRow[]> {
    return this.#t.docs.getMany([...new Set(ids)]);
  }

  /** Insert or replace a document; `offers` replaces its offer rows and embedded offers (null keeps them) */
  async upsertDocument(doc: DocWrite, offers: OfferRow[] | null, at: Date): Promise<void> {
    // derived fields (embedded offers, card offers, ranks) come from the rows and this repository only: a document
    // read back and written again must not bring old ones
    const { texts, product_id, ...written } = doc as DocWrite & Record<string, unknown>;
    const cols = Object.fromEntries(Object.entries(written).filter(([k]) => !(DERIVED_FIELDS as readonly string[]).includes(k)));
    // version: 1 for a new document, one more for a replaced one. One atomic upsert with $set and $inc, which the
    // Table helpers do not combine (upsert sets, increment only adds), so through the model
    await this.#t.docs.model.updateOne(
      { _id: product_id },
      { $set: this.#t.docs.toDoc({ ...cols, terms: termsOf(texts), indexed_at: at, ...(offers ? { offers: embeddedList(offers) } : {}) }), $inc: { version: 1 } },
      { upsert: true, session: this.#session, runValidators: true },
    );
    if (offers?.length) {
      // an offer moved from another product (merge): its old row goes, and so does that product's embedded copy
      const moved = await this.#t.offers.find({ offer_id: oneOf(offers.map((o) => o.offer_id)) });
      await this.#t.offers.deleteMany({ product_id });
      await this.#t.offers.deleteMany({ offer_id: oneOf(offers.map((o) => o.offer_id)) });
      await this.#t.offers.insertMany(offers);
      await this.#embedOffers(moved.map((r) => r.product_id).filter((id) => id !== product_id));
    } else if (offers) await this.#t.offers.deleteMany({ product_id });
    // the featured offer or the offers may have changed: the stored card offers follow (and the ranks go stale)
    await this.#t.docs.model.updateOne({ _id: product_id }, [STORE_CARDS], { session: this.#session });
  }

  /** Copies the offer rows of these products into their documents' `offers`, and their card offers (after any offer row write) */
  async #embedOffers(productIds: readonly string[]): Promise<void> {
    const ids = [...new Set(productIds)];
    if (!ids.length) return;
    const rows = await this.#t.offers.find({ product_id: oneOf(ids) });
    for (const id of ids) {
      const list = embeddedList(rows.filter((r) => r.product_id === id));
      await this.#t.docs.model.updateOne({ _id: id }, [{ $set: { offers: { $literal: list } } }, STORE_CARDS], { session: this.#session });
    }
  }

  /** Rebuilds every document's `offers` from the offer rows (EMBED_OFFERS_PIPELINE) */
  async embedAllOffers(): Promise<void> {
    await this.#t.docs.aggregate([...EMBED_OFFERS_PIPELINE]);
  }

  async deleteDocument(productId: string): Promise<void> {
    await this.#t.offers.deleteMany({ product_id: productId });
    await this.#t.docs.delete(productId);
  }

  async updateDocument(productId: string, patch: Partial<Omit<DocRow, 'product_id' | 'terms'>>, at: Date): Promise<void> {
    // any field may feed the stored ranks (rating, featured offer…): they go stale
    await this.#t.docs.updateOne({ product_id: productId }, { $set: { ...patch, indexed_at: at, rank_key: null }, $inc: { version: 1 } });
    if ('featured_offer_id' in patch) await this.#t.docs.model.updateOne({ _id: productId }, [STORE_CARDS], { session: this.#session });
  }

  async offerRows(productIds: string[]): Promise<OfferRow[]> {
    if (!productIds.length) return [];
    return this.#t.offers.find({ product_id: oneOf(productIds) });
  }

  offerRow(offerId: string): Promise<OfferRow | undefined> {
    return this.#t.offers.get(offerId);
  }

  async upsertOfferRow(row: OfferRow): Promise<void> {
    const before = await this.#t.offers.get(row.offer_id);
    await this.#t.offers.upsert(row);
    await this.#embedOffers([row.product_id, ...(before ? [before.product_id] : [])]);
  }

  async updateOfferRow(offerId: string, patch: Partial<Omit<OfferRow, 'offer_id' | 'product_id'>>): Promise<void> {
    if (!Object.keys(patch).length) return;
    const row = await this.#t.offers.update(offerId, patch);
    if (row) await this.#embedOffers([row.product_id]);
  }

  async deleteOfferRow(offerId: string): Promise<void> {
    const row = await this.#t.offers.get(offerId);
    await this.#t.offers.delete(offerId);
    if (row) await this.#embedOffers([row.product_id]);
  }

  async documentIds(f: { categoryIds?: string[]; brandIds?: string[]; sellerIds?: string[]; onSale?: boolean; productIds?: string[] }): Promise<string[]> {
    const filter: Filter = {
      ...(f.categoryIds ? { category_path_ids: oneOf(f.categoryIds) } : {}),
      ...(f.brandIds ? { brand_id: oneOf(f.brandIds) } : {}),
      ...(f.sellerIds ? { seller_ids: oneOf(f.sellerIds) } : {}),
      ...(f.onSale !== undefined ? { on_sale: f.onSale } : {}),
      ...(f.productIds ? { product_id: oneOf(f.productIds) } : {}),
    };
    const rows = await this.#t.docs.aggregate<{ _id: string }>([{ $match: this.#t.docs.filter(filter) }, { $project: { _id: 1 } }, { $sort: { _id: 1 } }]);
    return rows.map((r) => r._id);
  }

  /** Brands that have documents, each with the brand name of its first document (by product id) */
  async brandNamesOfDocuments(brandIds: string[]): Promise<Map<string, string | null>> {
    if (!brandIds.length) return new Map();
    const rows = await this.#t.docs.aggregate<{ _id: string; name: string | null }>([
      { $match: { brand_id: oneOf(brandIds) } },
      { $sort: { _id: 1 } },
      { $group: { _id: '$brand_id', name: { $first: '$brand_name' } } },
    ]);
    return new Map(rows.map((r) => [r._id, r.name ?? null]));
  }

  /** Documents with offers, only the fields suggestion terms are made from (not whole documents with their search terms) */
  async liveDocumentSummaries(): Promise<Pick<DocRow, 'product_id' | 'title' | 'brand_id' | 'brand_name' | 'category_path_ids' | 'popularity' | 'rating_count'>[]> {
    const rows = await this.#t.docs.aggregate<Record<string, unknown>>([
      { $match: { offer_count: { $gt: 0 } } },
      { $sort: { _id: 1 } },
      { $project: { title: 1, brand_id: 1, brand_name: 1, category_path_ids: 1, popularity: 1, rating_count: 1 } },
    ]);
    return rows.map((d) => this.#t.docs.fromDoc(d));
  }

  /** One page of document ids after `afterId`, in id order (jobs walk the whole index in bounded batches) */
  async documentIdsAfter(afterId: string | null, limit: number): Promise<string[]> {
    const rows = await this.#t.docs.aggregate<{ _id: string }>([{ $match: afterId ? { _id: { $gt: afterId } } : {} }, { $sort: { _id: 1 } }, { $limit: limit }, { $project: { _id: 1 } }]);
    return rows.map((r) => r._id);
  }

  async productIdsForOffers(offerIds: string[]): Promise<string[]> {
    if (!offerIds.length) return [];
    return this.#t.offers.distinct<string>('product_id', { offer_id: oneOf(offerIds) });
  }

  async productIdForVariant(variantId: string): Promise<string | undefined> {
    const viaOffer = await this.#t.offers.findOne({ variant_id: variantId });
    if (viaOffer) return viaOffer.product_id;
    const viaDoc = await this.#t.docs.aggregate<{ _id: string }>([{ $match: { 'variant_options.id': variantId } }, { $limit: 1 }, { $project: { _id: 1 } }]);
    return viaDoc[0]?._id;
  }

  productIdsByGtin(gtin: string): Promise<DocRow[]> {
    return this.#t.docs.find({ gtins: gtin });
  }

  async documentStats(): Promise<{ documents: number; offerRows: number; lastIndexedAt: Date | null }> {
    const documents = await this.#t.docs.count();
    const last = await this.#t.docs.aggregate<{ last: Date | null }>([{ $group: { _id: null, last: { $max: '$indexed_at' } } }]);
    const offerRows = await this.#t.offers.count();
    return { documents, offerRows, lastIndexedAt: last[0]?.last ? new Date(last[0].last) : null };
  }

  /* ---------------------------------------------------------------- sales */
  /**
   * Adds (sign 1) or subtracts (sign -1) an order's units per product on its market day in product_sales_daily
   * (never below 0), and moves the documents' live counts the same way until the nightly job recomputes them.
   */
  async recordSales(day: string, units: { productId: string; units: number }[], sign: 1 | -1, at: Date): Promise<void> {
    for (const u of units) {
      if (u.units <= 0) continue;
      const n = sign * u.units;
      // greatest(units + n, 0): one atomic upsert per product and day (a pipeline update: increment cannot clamp at 0)
      await this.#t.sales.model.updateOne(
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
        { upsert: true, session: this.#session },
      );
      await this.#t.docs.updateOne({ product_id: u.productId }, [
        {
          $set: {
            popularity: { $toDecimal: { $max: [{ $add: ['$popularity', n] }, 0] } },
            sales_30d: { $max: [{ $add: ['$sales_30d', n] }, 0] },
            // popularity feeds the stored ranks
            rank_key: null,
          },
        },
      ]);
    }
  }

  /** sales_30d (and popularity) = units of the last 30 market days from product_sales_daily, `from` inclusive */
  async sumSales(from: string): Promise<void> {
    const sums = await this.#t.sales.aggregate<{ _id: string; units: number }>([{ $match: { day: { $gte: from } } }, { $group: { _id: '$product_id', units: { $sum: '$units' } } }]);
    const units = new Map(sums.filter((s) => s.units !== 0).map((s) => [s._id, s.units]));
    // documents without sales in the window: 0
    // popularity feeds the stored ranks: a changed document's go stale
    await this.#t.docs.updateMany({ product_id: { $nin: [...units.keys()] }, $or: [{ sales_30d: { $ne: 0 } }, { popularity: { $ne: '0' } }] }, { sales_30d: 0, popularity: '0', rank_key: null });
    const ops = [...units].map(([id, n]) => ({
      updateOne: { filter: { _id: id, $or: [{ sales_30d: { $ne: n } }, { popularity: { $ne: n } }] }, update: { $set: { sales_30d: n, popularity: this.#t.docs.toDoc({ popularity: String(n) }).popularity, rank_key: null } } },
    }));
    for (let i = 0; i < ops.length; i += 500) await this.#t.docs.model.bulkWrite(ops.slice(i, i + 500) as never, { session: this.#session });
  }

  /** Deletes daily rows before `before` (exclusive) */
  async pruneSales(before: string): Promise<void> {
    await this.#t.sales.deleteMany({ day: { $lt: before } });
  }

  async platformUnits30d(): Promise<number> {
    const r = await this.#t.docs.aggregate<{ n: number }>([{ $group: { _id: null, n: { $sum: '$sales_30d' } } }]);
    return r[0]?.n ?? 0;
  }

  async rankBestSellers(top: number, enabled: boolean): Promise<void> {
    if (!enabled) {
      await this.#t.docs.updateMany({ best_seller_rank: { $ne: null } }, { best_seller_rank: null, best_seller_category_id: null });
      return;
    }
    const ranked = await this.#t.docs.aggregate<{ _id: string; category_id: string; r: number }>([
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
    for (let i = 0; i < ops.length; i += 500) await this.#t.docs.model.bulkWrite(ops.slice(i, i + 500) as never, { session: this.#session });
    await this.#t.docs.updateMany({ sales_30d: { $lte: 0 } }, { best_seller_rank: null, best_seller_category_id: null });
  }

  async bestSellerRows(ids: string[]): Promise<DocRow[]> {
    if (!ids.length) return [];
    return this.#t.docs.find({ product_id: oneOf(ids), best_seller_rank: { $ne: null } });
  }

  /* ---------------------------------------------------------------- dirty documents */
  async markDirty(ids: string[], reason: string, at: Date): Promise<void> {
    const unique = [...new Set(ids)];
    if (!unique.length) return;
    await this.#t.dirty.upsertMany(unique.map((product_id) => ({ product_id, reason, queued_at: at })));
  }

  takeDirty(limit: number): Promise<{ product_id: string; reason: string; queued_at: Date }[]> {
    return this.#t.dirty.find({}, { sort: { queued_at: 1, product_id: 1 }, limit });
  }

  async clearDirty(productId: string, queuedAt: Date): Promise<void> {
    // a product marked again while it was being rebuilt stays queued
    await this.#t.dirty.deleteMany({ product_id: productId, queued_at: { $lte: queuedAt } });
  }

  async dirtyStats(): Promise<{ count: number; oldest: Date | null }> {
    const count = await this.#t.dirty.count();
    const oldest = await this.#t.dirty.findOne({}, { sort: { queued_at: 1 } });
    return { count, oldest: oldest?.queued_at ?? null };
  }

  /* ---------------------------------------------------------------- suggestion terms */
  async upsertTerm(kind: TermKind, targetId: string | null, term: string, weight: number, at: Date): Promise<void> {
    await this.#t.terms.deleteMany(targetId ? { kind, target_id: targetId } : { kind, target_id: null, term });
    await this.#t.terms.insert({ id: newId(), kind, target_id: targetId, term, weight: String(weight), updated_at: at });
  }

  async deleteTerms(kind: TermKind, targetIds: string[]): Promise<void> {
    if (!targetIds.length) return;
    await this.#t.terms.deleteMany({ kind, target_id: oneOf(targetIds) });
  }

  async replaceTerms(kind: TermKind, rows: { term: string; targetId: string | null; weight: number }[], at: Date): Promise<void> {
    await this.#t.terms.deleteMany({ kind });
    for (let i = 0; i < rows.length; i += 500) {
      await this.#t.terms.insertMany(rows.slice(i, i + 500).map((r) => ({ id: newId(), kind, term: r.term, target_id: r.targetId, weight: String(r.weight), updated_at: at })));
    }
  }

  async terms(kind: TermKind, targetIds?: string[]): Promise<TermRow[]> {
    if (targetIds && !targetIds.length) return [];
    return this.#t.terms.find({ kind, ...(targetIds ? { target_id: oneOf(targetIds) } : {}) }, { sort: { weight: -1 } });
  }

  /* ---------------------------------------------------------------- synonyms */
  listSynonyms(f: { q?: string; active?: boolean }): Promise<SynonymRow[]> {
    const p = f.q?.trim().toLowerCase();
    return this.#t.synonyms.find(
      {
        ...(f.active !== undefined ? { active: f.active } : {}),
        ...(p ? { $or: [{ terms: contains(p) }, { from_term: contains(p) }, { note: contains(p) }] } : {}),
      },
      { sort: { updated_at: -1, id: 1 } },
    );
  }

  getSynonym(id: string): Promise<SynonymRow | undefined> {
    return this.#t.synonyms.get(id);
  }

  insertSynonym(row: SynonymRow): Promise<SynonymRow> {
    return this.#t.synonyms.insert(row);
  }

  async updateSynonym(id: string, patch: Partial<Omit<SynonymRow, 'id'>>): Promise<SynonymRow> {
    const row = Object.keys(patch).length ? await this.#t.synonyms.update(id, patch) : await this.#t.synonyms.get(id);
    if (!row) throw new Error(`search: synonym ${id} not found`);
    return row;
  }

  async deleteSynonym(id: string): Promise<void> {
    await this.#t.synonyms.delete(id);
  }

  activeSynonyms(): Promise<SynonymRow[]> {
    return this.#t.synonyms.find({ active: true });
  }

  /* ---------------------------------------------------------------- recent searches */
  recentSearches(owner: { kind: 'customer' | 'guest'; id: string }, limit: number): Promise<RecentRow[]> {
    return this.#t.recent.find({ owner_kind: owner.kind, owner_id: owner.id }, { sort: { searched_at: -1, id: -1 }, limit });
  }

  async saveRecentSearch(row: RecentRow, max: number): Promise<void> {
    // the same query and filters again moves to the top instead of repeating
    const same = (await this.#ownerRows({ kind: row.owner_kind, id: row.owner_id })).filter((r) => sameSearch(r, row));
    if (same.length) await this.#t.recent.deleteMany({ id: oneOf(same.map((r) => r.id)) });
    await this.#t.recent.insert(row);
    await this.#trimRecent({ kind: row.owner_kind, id: row.owner_id }, max);
  }

  async deleteRecentSearch(owner: { kind: 'customer' | 'guest'; id: string }, id: string): Promise<boolean> {
    return (await this.#t.recent.deleteMany({ id, owner_kind: owner.kind, owner_id: owner.id })) > 0;
  }

  clearRecentSearches(owner: { kind: 'customer' | 'guest'; id: string }): Promise<number> {
    return this.#t.recent.deleteMany({ owner_kind: owner.kind, owner_id: owner.id });
  }

  async moveRecentSearches(from: { kind: 'customer' | 'guest'; id: string }, to: { kind: 'customer' | 'guest'; id: string }, max: number): Promise<number> {
    const rows = await this.#ownerRows(from);
    // read once and kept in step with the deletes below (was read again for every row)
    let target = await this.#ownerRows(to);
    // the same search on both sides: the newer one stays
    for (const r of rows) {
      const same = target.filter((x) => sameSearch(x, r));
      if (same.some((x) => x.searched_at > r.searched_at)) await this.#t.recent.delete(r.id);
      else if (same.length) {
        await this.#t.recent.deleteMany({ id: oneOf(same.map((x) => x.id)) });
        target = target.filter((x) => !same.includes(x));
      }
    }
    const moved = await this.#t.recent.updateMany({ owner_kind: from.kind, owner_id: from.id }, { owner_kind: to.kind, owner_id: to.id });
    await this.#trimRecent(to, max);
    return moved;
  }

  pruneRecentSearches(before: Date): Promise<number> {
    return this.#t.recent.deleteMany({ searched_at: { $lt: before } });
  }

  /* ---------------------------------------------------------------- logs */
  async logQuery(row: QueryLogRow): Promise<void> {
    await this.#t.queries.insert(row);
  }

  async logClick(row: SearchDb['click_log']): Promise<void> {
    await this.#t.clicks.insert(row);
  }

  searchLogged(searchId: string): Promise<boolean> {
    return this.#t.queries.exists({ search_id: searchId });
  }

  async zeroResults(from: Date, to: Date): Promise<{ query: string; normalized: string; count: number; lastAt: Date; lastFilters: Json | null; correctionOffered: boolean }[]> {
    const rows = await this.#t.queries.aggregate<{ _id: string; query: string | null; count: number; last_at: Date; last_filters: unknown; correction_offered: boolean }>([
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
  }

  async popularQueries(since: Date, limit: number): Promise<{ normalized: string; count: number }[]> {
    const rows = await this.#t.queries.aggregate<{ _id: string; count: number }>([
      { $match: { at: { $gte: since }, results: { $gt: 0 }, normalized: { $nin: [null, ''] } } },
      { $group: { _id: '$normalized', count: { $sum: 1 } } },
      { $sort: { count: -1, _id: 1 } },
      { $limit: limit },
    ]);
    return rows.map((r) => ({ normalized: r._id, count: r.count }));
  }

  async pruneLogs(before: Date): Promise<{ queries: number; clicks: number }> {
    const queries = await this.#t.queries.deleteMany({ at: { $lt: before } });
    const clicks = await this.#t.clicks.deleteMany({ at: { $lt: before } });
    return { queries, clicks };
  }

  /* ---------------------------------------------------------------- reindex jobs */
  insertJob(row: ReindexJobRow): Promise<ReindexJobRow> {
    return this.#t.jobs.insert(row);
  }

  getJob(id: string): Promise<ReindexJobRow | undefined> {
    return this.#t.jobs.get(id);
  }

  async updateJob(id: string, patch: Partial<Omit<ReindexJobRow, 'id'>>): Promise<ReindexJobRow> {
    const row = Object.keys(patch).length ? await this.#t.jobs.update(id, patch) : await this.#t.jobs.get(id);
    if (!row) throw new Error(`search: reindex job ${id} not found`);
    return row;
  }

  activeFullJob(): Promise<ReindexJobRow | undefined> {
    return this.#t.jobs.findOne({ scope: 'all', state: oneOf(['queued', 'running']) }, { sort: { id: 1 } });
  }

  queuedJobs(): Promise<ReindexJobRow[]> {
    return this.#t.jobs.find({ state: oneOf(['queued', 'running']) }, { sort: { id: 1 } });
  }

  // finished_at descending with nulls first: a completed job without a finish time counts as the latest
  async lastCompletedFullJob(): Promise<ReindexJobRow | undefined> {
    return (await this.#t.jobs.findOne({ scope: 'all', state: 'completed', finished_at: null })) ?? this.#t.jobs.findOne({ scope: 'all', state: 'completed' }, { sort: { finished_at: -1 } });
  }

  /* ---------------------------------------------------------------- ranking policies */
  currentPolicy(at: Date): Promise<PolicyRow | undefined> {
    return this.#t.policies.findOne({ effective_from: { $lte: at } }, { sort: { effective_from: -1, version: -1 } });
  }

  async latestPolicyVersion(): Promise<number> {
    return (await this.#t.policies.findOne({}, { sort: { version: -1 } }))?.version ?? 0;
  }

  insertPolicy(row: PolicyRow): Promise<PolicyRow> {
    return this.#t.policies.insert(row);
  }

  /** Keeps an owner's newest `max` recent searches (searched_at desc, id desc) */
  async #trimRecent(owner: Owner, max: number) {
    const extra = await this.#t.recent.find({ owner_kind: owner.kind, owner_id: owner.id }, { sort: { searched_at: -1, id: -1 }, skip: max });
    if (extra.length) await this.#t.recent.deleteMany({ id: oneOf(extra.map((r) => r.id)) });
  }

  #ownerRows(owner: Owner) {
    return this.#t.recent.find({ owner_kind: owner.kind, owner_id: owner.id });
  }
}
