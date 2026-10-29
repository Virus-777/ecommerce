/**
 * The MongoDB half of catalog's queries port (queries.ts): the pipelines and regular expressions that were in
 * the repository before it became store-neutral. They are unchanged in meaning — the same stages, the same
 * order, the same patterns — and this file is deleted with MongoDB at the cutover (docs/10 §23 Y4).
 */
import { escapeRegExp } from '../../kernel/lib/text.js';
import type { PageRequest } from '../../kernel/lib/pagination.js';
import { whereFilter } from '../../kernel/mongo/filters.js';
import type { ModuleStore } from '../../kernel/mongo/index.js';
import type { Filter } from '../../kernel/mongo/table.js';
import type { WhereWithOr } from '../../kernel/store/index.js';
import type * as common from '../../spec/common.js';
import type { BrandRow, ProductRow, SubmissionRow } from './ports.js';
import { modelPattern, type CatalogQueries, type ContentState, type LiveCountRow } from './queries.js';

/** catalog.listing_stats, keyed by product id (its `_id`), looked up from a product's own `_id` */
const LISTING = 'catalog.listing_stats';
const lookupListing = (as: string, fields: Filter = { live_offer_count: 1, offer_count: 1 }): Filter => ({
  $lookup: { from: LISTING, localField: '_id', foreignField: '_id', pipeline: [{ $project: fields }], as },
});

/** Products customers can buy: approved, active, not merged */
const LIVE: Filter = { review_state: 'approved', publication: 'active', merged_into_id: null };

/** The Admin catalog's missing-content tab: a content score under 100, or images to re-crop */
const MISSING_CONTENT: Filter = { $or: [{ content_score: { $lt: 100 } }, { 'recrop_media_ids.0': { $exists: true } }] };

/** `filter`, and the missing-content condition when one is asked for ($nor for "nothing missing") */
const withContent = (filter: Filter, missing: ContentState): Filter =>
  missing === undefined ? filter : { $and: [filter, missing ? MISSING_CONTENT : { $nor: [MISSING_CONTENT] }] };

export function mongoCatalogQueries(store: ModuleStore): CatalogQueries {
  const products = store.table<ProductRow>('products');
  const submissions = store.table<SubmissionRow>('submissions');
  const brands = store.table<BrandRow>('brands');
  /** A neutral filter as a filter on row fields; `find`/`page` translate `id` to `_id` themselves */
  const filterOf = (where: WhereWithOr<ProductRow>): Filter => whereFilter(where as Readonly<Record<string, unknown>>);

  return {
    pageProducts(where, missing: ContentState, req: PageRequest): Promise<common.Page<ProductRow>> {
      return products.page(withContent(filterOf(where), missing), req, { column: 'updated_at', direction: 'desc' });
    },

    productsAfterId(where, missing: ContentState, afterId: string | null, limit: number): Promise<ProductRow[]> {
      const f = withContent(filterOf(where), missing);
      return products.find(afterId ? { $and: [f, { id: { $gt: afterId } }] } : f, { sort: { id: 1 }, limit });
    },

    countProducts(where, missing: ContentState): Promise<number> {
      return products.count(withContent(filterOf(where), missing));
    },

    async liveBrandCountsIn(categoryIds): Promise<Map<string, number>> {
      if (!categoryIds.length) return new Map<string, number>();
      const rows = await products.aggregate<{ _id: string; n: number }>([
        { $match: products.filter({ category_id: { $in: [...new Set(categoryIds)] }, brand_id: { $ne: null }, ...LIVE }) },
        lookupListing('l', { live_offer_count: 1 }),
        { $match: { 'l.live_offer_count': { $gt: 0 } } },
        { $group: { _id: '$brand_id', n: { $sum: 1 } } },
      ]);
      return new Map(rows.map((r) => [r._id, r.n]));
    },

    async liveCountsSource(): Promise<LiveCountRow[]> {
      const rows = await products.aggregate<{ _id: string; brand_id: string | null; category_id: string | null; review_state: string; publication: string; l: { live_offer_count: number; offer_count: number }[] }>([
        { $match: products.filter({ merged_into_id: null }) },
        lookupListing('l'),
        { $project: { brand_id: 1, category_id: 1, review_state: 1, publication: 1, 'l.live_offer_count': 1, 'l.offer_count': 1 } },
      ]);
      return rows.map((r) => ({
        id: r._id,
        brand_id: r.brand_id ?? null,
        category_id: r.category_id ?? null,
        live: r.review_state === 'approved' && r.publication === 'active',
        live_offers: r.l[0]?.live_offer_count ?? 0,
        offers: r.l[0]?.offer_count ?? 0,
      }));
    },

    async pausedSubmissionCounts(sellerIds): Promise<Map<string, number>> {
      const out = new Map<string, number>();
      if (!sellerIds.length) return out;
      // only the id and owner of each product (not whole product documents)
      const owned = await products.aggregate<{ _id: string; owner_seller_id: string }>([
        { $match: products.filter({ owner_seller_id: { $in: [...new Set(sellerIds)] } }) },
        { $project: { owner_seller_id: 1 } },
      ]);
      const owners = new Map(owned.map((p) => [p._id, p.owner_seller_id]));
      if (!owners.size) return out;
      const subs = await submissions.find({ product_id: { $in: [...owners.keys()] }, state: 'open', paused_at: { $ne: null } });
      for (const s of subs) {
        const seller = owners.get(s.product_id)!;
        out.set(seller, (out.get(seller) ?? 0) + 1);
      }
      return out;
    },

    productsByModelPrefixes(prefixes, limit): Promise<ProductRow[]> {
      if (!prefixes.length) return Promise.resolve([]);
      return products.find({ ...LIVE, $or: prefixes.map((pre) => ({ model_number: { $regex: modelPattern(pre, false), $options: 'i' } })) }, { limit });
    },

    duplicateCandidates({ productId, modelNormalised, gtinOwnerIds, titleWords }): Promise<ProductRow[]> {
      const any: Filter[] = [];
      if (modelNormalised) any.push({ model_number: { $regex: modelPattern(modelNormalised, true), $options: 'i' } });
      if (gtinOwnerIds.length) any.push({ id: { $in: [...new Set(gtinOwnerIds)] } });
      if (titleWords.length) any.push({ $and: titleWords.map((w) => ({ title: { $regex: escapeRegExp(w.trim()), $options: 'i' } })) });
      if (!any.length) return Promise.resolve([]);
      return products.find({ $and: [{ id: { $ne: productId }, merged_into_id: null, review_state: { $in: ['approved', 'submitted', 'changes_requested'] } }, { $or: any }] }, { limit: 20 });
    },

    /** The same name, any case, ignoring leading and trailing spaces (spaces only, not tabs or new lines) */
    brandByName(name: string): Promise<BrandRow | undefined> {
      return brands.findOne({ name: { $regex: `^ *${escapeRegExp(name.replace(/^ +| +$/g, ''))} *$`, $options: 'i' } }, { sort: { created_at: 1 } });
    },
  };
}
