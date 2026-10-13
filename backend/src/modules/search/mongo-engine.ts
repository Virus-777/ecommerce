/**
 * MongoDB search engine (development and tests; OpenSearch serves production): implements the SearchEngine port
 * with aggregation pipelines over the read model.
 *
 * - Matching: every query word is analysed as text.ts does (stop words dropped, Porter stems) and must be one of
 *   the document's search terms (search_documents.terms, multikey index); every group of the query must match, any
 *   alternative of a group. A phrase matches when all its words do (word order is not checked).
 * - Relevance: the weights of the matched stems (title and brand 1, category 0.4, attributes 0.2, description 0.1),
 *   summed as r and scaled to r / (r + 1) like ts_rank_cd's normalization 32.
 * - The card offer ("eo"): the document's offers that pass the offer filters ($lookup), featured first, then in stock,
 *   then cheapest, then by offer id. Facet counts run the same pipeline without the facet's own filter.
 * - Typing: words as prefixes of the stems; spelling: trigram similarity computed here among the words that start
 *   with the same letter as the misspelled one. Misspelling tolerance is therefore weaker than OpenSearch's fuzziness
 *   (a wrong first letter is not corrected).
 */
import type { ModuleStore } from '../../kernel/mongo/index.js';
import type { RankingFactorKey } from './domain/ranking.js';
import { MIN_RATINGS_FOR_RANK } from './domain/ranking.js';
import type { SortKey } from './domain/types.js';
import type { DocRow, EngineFilters, EngineHit, EngineQuery, FacetCounts, FacetOmit, OfferRow, SearchEngine, TermKind, TermRow } from './ports.js';
import { similarity, trigrams } from './providers/opensearch/trigram.js';
import { rankSimilar, wordsStartingWith, type TermLookup } from './terms.js';
import { escapeRegExp } from '../../kernel/lib/text.js';
import { stems } from './text.js';

type Doc = Record<string, any>;
type Stage = Record<string, unknown>;

const OFFERS = 'search.search_offers';
const DOCUMENTS = 'search.search_documents';
const NONE = { _id: { $in: [] } };
const LN101 = Math.log(101);

/** Stems of each alternative of each group; alternatives without words are left out, and groups left empty */
function analysedGroups(groups: string[][]): string[][][] {
  return groups.map((g) => g.map((alt) => stems(alt)).filter((alt) => alt.length)).filter((g) => g.length);
}

/** Every stem is a search term of the document */
const allTerms = (list: string[]) => ({ $and: list.map((s) => ({ 'terms.t': s })) });

/** Prefix stems while typing ('wireless head' → wireless*, head*), at most 8 words */
const prefixStems = (prefix: string) => stems(prefix).slice(0, 8);
const prefixMatch = (list: string[]) => ({ $and: list.map((s) => ({ 'terms.t': { $regex: `^${escapeRegExp(s)}` } })) });

/**
 * pg_trgm's word_similarity(a, text): the greatest similarity between a's trigrams and any continuous extent of
 * the text's ordered trigrams (word_similarity('word', 'two words') = 0.8)
 */
function wordSimilarity(a: string, text: string): number {
  const ta = trigrams(a);
  if (!ta.size) return 0;
  const ordered = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .flatMap((w) => [...trigrams(w)]);
  let best = 0;
  for (let i = 0; i < ordered.length; i++) {
    const seen = new Set<string>();
    let shared = 0;
    for (let j = i; j < ordered.length; j++) {
      const t = ordered[j]!;
      if (seen.has(t)) continue;
      seen.add(t);
      if (ta.has(t)) shared++;
      best = Math.max(best, shared / (ta.size + seen.size - shared));
    }
  }
  return best;
}

/** Conditions on an offer row */
function offerMatch(f: EngineFilters, omit?: FacetOmit): Doc {
  const c: Doc[] = [];
  if (omit !== 'seller' && (f.sellerIds?.length || f.official)) c.push({ $or: [...(f.sellerIds?.length ? [{ seller_id: { $in: f.sellerIds } }] : []), ...(f.official ? [{ official: true }] : [])] });
  if (omit !== 'condition' && f.conditions?.length) c.push({ condition: { $in: f.conditions } });
  if (omit !== 'price') {
    if (f.priceMin !== undefined) c.push({ price: { $gte: f.priceMin } });
    if (f.priceMax !== undefined) c.push({ price: { $lte: f.priceMax } });
  }
  if (omit !== 'availability' && f.inStockOnly) c.push({ in_stock: true });
  if (omit !== 'delivery') {
    if (f.freeDelivery) c.push({ free_delivery: true });
    if (f.shipsToday) c.push({ dispatch_days: 0 });
    if (f.maxDispatchDays !== undefined) c.push({ dispatch_days: { $lte: f.maxDispatchDays } });
  }
  return c.length ? { $and: c } : {};
}

function textMatch(q: EngineQuery): Doc | null {
  if (!q.text) return null;
  const parts: Doc[] = [];
  if (q.text.groups.length) {
    const groups = analysedGroups(q.text.groups);
    parts.push(groups.length ? { $and: groups.map((g) => ({ $or: g.map(allTerms) })) } : NONE);
  }
  if (q.text.gtin) parts.push({ gtins: q.text.gtin });
  return parts.length ? { $or: parts } : NONE;
}

/** Conditions on the document */
function docMatch(q: EngineQuery, omit?: FacetOmit): Doc {
  const f = q.filters;
  const c: Doc[] = [];
  const text = textMatch(q);
  if (text) c.push(text);
  if (q.productIds) c.push({ _id: { $in: q.productIds } });
  if (q.excludeProductIds?.length) c.push({ _id: { $nin: q.excludeProductIds } });
  if (omit !== 'category' && f.categoryIds?.length) c.push({ category_path_ids: { $in: f.categoryIds } });
  if (omit !== 'brand' && f.brandIds?.length) c.push({ brand_id: { $in: f.brandIds } });
  if (omit !== 'rating' && f.minRating !== undefined) c.push({ rating: { $gte: f.minRating } });
  if (f.onSale) c.push({ on_sale: true });
  if (f.listedSince) c.push({ first_listed_at: { $gte: f.listedSince } });
  if (omit !== 'delivery' && f.shipsToday) c.push({ $or: [{ same_day_cutoff: null }, { same_day_cutoff: { $gt: q.marketTime } }] });
  for (const a of f.attributes ?? []) {
    if (omit === `attr:${a.key}`) continue;
    c.push({ [`attributes.${a.key}`]: { $in: a.values.map((v) => new RegExp(`^${escapeRegExp(v.trim().toLowerCase())}$`, 'i')) } });
  }
  return c.length ? { $and: c } : {};
}

/** Documents with their matching offers (m) and the card offer (eo); documents without a matching offer are left out */
function base(q: EngineQuery, omit?: FacetOmit): Stage[] {
  return [
    { $match: docMatch(q, omit) },
    { $lookup: { from: OFFERS, localField: '_id', foreignField: 'product_id', pipeline: [{ $match: offerMatch(q.filters, omit) }], as: 'm' } },
    { $match: { 'm.0': { $exists: true } } },
    {
      $set: {
        matching: { $size: '$m' },
        eo: {
          $first: {
            $sortArray: {
              input: { $map: { input: '$m', as: 'o', in: { $mergeObjects: ['$$o', { featured: { $eq: ['$$o._id', '$featured_offer_id'] } }] } } },
              sortBy: { featured: -1, in_stock: -1, price: 1, _id: 1 },
            },
          },
        },
      },
    },
  ];
}

/** Text relevance 0..1: the summed weights r of the query's stems found in the document, as r / (r + 1) */
function textRelevance(q: EngineQuery): unknown {
  if (!q.text?.groups.length) return 0;
  const list = [...new Set(analysedGroups(q.text.groups).flat(2))];
  if (!list.length) return 0;
  const weightOf = (s: string) => ({
    $ifNull: [{ $max: { $map: { input: { $filter: { input: { $ifNull: ['$terms', []] }, as: 'x', cond: { $eq: ['$$x.t', s] } } }, as: 'x', in: '$$x.w' } } }, 0],
  });
  return { $let: { vars: { r: { $add: list.map(weightOf) } }, in: { $divide: ['$$r', { $add: ['$$r', 1] }] } } };
}

/** Weighted ranking factors of the recommended sort, each 0..weight, and their sum (score) */
function scoreStages(q: EngineQuery, w: Record<RankingFactorKey, number>): Stage[] {
  const gtin = q.text?.gtin;
  return [
    {
      $set: {
        f: {
          text_relevance: { $multiply: [w.text_relevance, textRelevance(q)] },
          in_stock: { $multiply: [w.in_stock, { $cond: ['$eo.in_stock', 1, 0] }] },
          featured_offer: { $multiply: [w.featured_offer, { $cond: [{ $ne: [{ $ifNull: ['$featured_offer_id', null] }, null] }, 1, 0] }] },
          delivery_speed: { $multiply: [w.delivery_speed, { $divide: [1, { $add: [1, { $ifNull: ['$eo.dispatch_days', 5] }] }] }] },
          rating: { $multiply: [w.rating, { $cond: [{ $gte: ['$rating_count', MIN_RATINGS_FOR_RANK] }, { $divide: [{ $toDouble: { $ifNull: ['$rating', 0] } }, 5] }, 0] }] },
          conversion: { $multiply: [w.conversion, { $min: [1, { $divide: [{ $ln: { $add: [1, { $max: [{ $toDouble: '$popularity' }, 0] }] } }, LN101] }] }] },
          gtin: gtin ? { $cond: [{ $in: [gtin, { $ifNull: ['$gtins', []] }] }, 1, 0] } : 0,
        },
      },
    },
    { $set: { score: { $add: ['$f.gtin', '$f.text_relevance', '$f.in_stock', '$f.featured_offer', '$f.delivery_speed', '$f.rating', '$f.conversion'] } } },
  ];
}

const ORDER: Record<SortKey, Record<string, 1 | -1>> = {
  recommended: { score: -1, _id: 1 },
  price_asc: { 'eo.price': 1, score: -1, _id: 1 },
  price_desc: { 'eo.price': -1, score: -1, _id: 1 },
  newest: { first_listed_at: -1, _id: 1 },
  // MongoDB sorts null lowest: rating desc puts products without a rating last
  rating: { rating: -1, rating_count: -1, score: -1, _id: 1 },
  best_selling: { sales_30d: -1, score: -1, _id: 1 },
};

const byKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function createMongoSearchEngine(store: ModuleStore, terms: TermLookup): SearchEngine {
  const docs = store.table<DocRow>('search_documents');
  const offers = store.table<OfferRow>('search_offers');
  const termRows = store.table<TermRow>('suggestion_terms');
  const agg = <T = Doc>(pipeline: Stage[]) => docs.aggregate<T>(pipeline);
  /** A stored document as a read-model row (its search terms left out) */
  const docOut = (d: Doc): DocRow => ({ ...docs.fromDoc(d), terms: null });
  const count = async (pipeline: Stage[]) => (await agg<{ n: number }>([...pipeline, { $count: 'n' }]))[0]?.n ?? 0;
  const exists = async (match: Doc) => (await agg([{ $match: match }, { $limit: 1 }, { $project: { _id: 1 } }])).length > 0;

  function toHit(r: Doc): EngineHit {
    const { f, eo, score, matching, m: _m, ...doc } = r;
    return {
      doc: docOut(doc),
      score: Number(score),
      factors: {
        text_relevance: Number(f.text_relevance),
        in_stock: Number(f.in_stock),
        featured_offer: Number(f.featured_offer),
        delivery_speed: Number(f.delivery_speed),
        rating: Number(f.rating),
        conversion: Number(f.conversion),
        gtin: Number(f.gtin),
      },
      offer: eo
        ? {
            offerId: eo._id,
            variantId: eo.variant_id,
            sellerId: eo.seller_id ?? null,
            official: Boolean(eo.official),
            condition: eo.condition ?? 'new',
            price: Number(eo.price),
            inStock: Boolean(eo.in_stock),
            freeDelivery: Boolean(eo.free_delivery),
            dispatchDays: Number(eo.dispatch_days ?? 0),
            matching: Number(matching ?? 1),
          }
        : null,
    };
  }

  /** Candidate words for a misspelled word: title words and suggestion term words with its first letter */
  async function candidateWords(word: string): Promise<string[]> {
    const first = word.charAt(0);
    const titles = await agg<{ title_norm: string }>([{ $match: { title_norm: { $regex: `(^| )${escapeRegExp(first)}` } } }, { $project: { _id: 0, title_norm: 1 } }]);
    const fromTerms = await termRows.aggregate<{ term: string }>([{ $match: { term: { $regex: `(^|\\s)${escapeRegExp(first)}`, $options: 'i' } } }, { $project: { _id: 0, term: 1 } }]);
    return wordsStartingWith([...titles.map((t) => t.title_norm), ...fromTerms.map((t) => t.term)], first);
  }

  return {
    name: 'mongo-text',

    async search(q, sort, weights, window) {
      const pipeline = base(q);
      const total = await count(pipeline);
      if (!total || window.limit <= 0) return { hits: [], total };
      const found = await agg([...pipeline, ...scoreStages(q, weights), { $sort: ORDER[sort] }, { $skip: window.offset }, { $limit: window.limit }, { $project: { terms: 0, m: 0 } }]);
      return { hits: found.map(toHit), total };
    },

    count: (q) => count(base(q)),

    async summary(q) {
      const pipeline = base(q);
      const total = await count(pipeline);
      const [s] = await agg<{ sellers: string[]; official: boolean | null }>([
        ...pipeline,
        { $unwind: '$m' },
        { $group: { _id: null, sellers: { $addToSet: { $ifNull: ['$m.seller_id', 'official'] } }, official: { $max: '$m.official' } } },
      ]);
      return { total, sellers: s?.sellers.length ?? 0, official: Boolean(s?.official) };
    },

    async facets(q, attributeKeys) {
      const f = q.filters;

      const categories = new Map(
        (await agg<{ _id: string; n: number }>([...base(q, 'category'), { $unwind: '$category_path_ids' }, { $group: { _id: '$category_path_ids', n: { $sum: 1 } } }])).map((r) => [r._id, r.n]),
      );

      const activeBrands = (await termRows.distinct<string>('target_id', { kind: 'brand', target_id: { $ne: null } })).filter(Boolean);
      const brands = await agg<{ _id: string; name: string | null; n: number }>([
        ...base(q, 'brand'),
        { $match: { brand_id: { $in: activeBrands } } },
        { $group: { _id: '$brand_id', name: { $max: '$brand_name' }, n: { $sum: 1 } } },
        { $sort: { n: -1, name: 1 } },
      ]);

      /** Products per value of an offer field, over the offers that pass the other filters */
      const offerFacet = (omit: 'seller' | 'condition', field: string) =>
        agg<{ _id: string | null; n: number }>([...base(q, omit), { $unwind: '$m' }, { $group: { _id: { v: `$m.${field}`, p: '$_id' } } }, { $group: { _id: '$_id.v', n: { $sum: 1 } } }]);
      const sellerRows = await offerFacet('seller', 'seller_id');
      const conditionRows = await offerFacet('condition', 'condition');
      const official = await count([...base(q, 'seller'), { $match: { 'm.official': true } }]);

      const [ratingRow] = await agg<Record<string, number>>([
        ...base(q, 'rating'),
        { $group: Object.fromEntries([['_id', null], ...[1, 2, 3, 4, 5].map((n) => [`r${n}`, { $sum: { $cond: [{ $gte: ['$rating', n] }, 1, 0] } }])]) },
      ]);

      const [availRow] = await agg<{ in_stock: number; total: number }>([...base(q, 'availability'), { $group: { _id: null, in_stock: { $sum: { $cond: ['$eo.in_stock', 1, 0] } }, total: { $sum: 1 } } }]);

      // free delivery and ships today count products with such an offer among those passing the other filters (m)
      const [deliveryRow] = await agg<{ free: number; today: number }>([
        ...base(q, 'delivery'),
        {
          $group: {
            _id: null,
            free: { $sum: { $cond: [{ $in: [true, '$m.free_delivery'] }, 1, 0] } },
            today: {
              $sum: {
                $cond: [{ $and: [{ $in: [0, '$m.dispatch_days'] }, { $or: [{ $eq: [{ $ifNull: ['$same_day_cutoff', null] }, null] }, { $gt: ['$same_day_cutoff', q.marketTime] }] }] }, 1, 0],
              },
            },
          },
        },
      ]);

      const [priceRow] = await agg<{ min: number | null; max: number | null }>([...base(q, 'price'), { $group: { _id: null, min: { $min: '$eo.price' }, max: { $max: '$eo.price' } } }]);

      const attributes = new Map<string, Map<string, number>>();
      const filtered = new Set((f.attributes ?? []).map((a) => a.key));
      const attrQuery = async (keys: string[], omit?: FacetOmit) => {
        if (!keys.length) return;
        const found = await agg<{ _id: { k: string; v: string }; n: number }>([
          ...base(q, omit),
          { $project: { a: { $objectToArray: { $ifNull: ['$attributes', {}] } } } },
          { $unwind: '$a' },
          { $match: { 'a.k': { $in: keys }, 'a.v': { $type: 'array' } } },
          { $unwind: '$a.v' },
          { $group: { _id: { k: '$a.k', v: '$a.v', p: '$_id' } } },
          { $group: { _id: { k: '$_id.k', v: '$_id.v' }, n: { $sum: 1 } } },
        ]);
        for (const r of found) {
          const m = attributes.get(r._id.k) ?? new Map<string, number>();
          m.set(String(r._id.v), (m.get(String(r._id.v)) ?? 0) + r.n);
          attributes.set(r._id.k, m);
        }
      };
      await attrQuery(attributeKeys.filter((k) => !filtered.has(k)));
      for (const k of attributeKeys.filter((k) => filtered.has(k))) await attrQuery([k], `attr:${k}`);

      const result: FacetCounts = {
        categories,
        brands: brands.map((b) => ({ id: b._id, name: b.name ?? '', count: b.n })),
        sellers: new Map(sellerRows.filter((r) => r._id).map((r) => [r._id!, r.n])),
        official,
        conditions: new Map(conditionRows.filter((r) => r._id).map((r) => [r._id!, r.n])),
        ratings: new Map([1, 2, 3, 4, 5].map((n) => [n, ratingRow?.[`r${n}`] ?? 0])),
        inStock: availRow?.in_stock ?? 0,
        includingOutOfStock: availRow?.total ?? 0,
        freeDelivery: deliveryRow?.free ?? 0,
        shipsToday: deliveryRow?.today ?? 0,
        price: { min: priceRow?.min == null ? null : Number(priceRow.min), max: priceRow?.max == null ? null : Number(priceRow.max) },
        attributes,
      };
      return result;
    },

    async correctWord(word, threshold) {
      if (word.length < 3 || /\d/.test(word)) return null;
      const st = stems(word);
      if ((st.length && (await exists(allTerms(st)))) || (await terms.isTerm(word))) return null;
      return rankSimilar(word, await candidateWords(word), threshold)[0]?.word ?? null;
    },

    async knownPrefix(prefix) {
      const p = prefix.toLowerCase();
      // title_norm like 'p%' or like '% p%'
      if (await exists({ title_norm: { $regex: `(^| )${escapeRegExp(p)}` } })) return true;
      return terms.hasTermPrefix(p);
    },

    async suggestTerms(kind: TermKind, prefix, threshold, limit) {
      const p = prefix.toLowerCase();
      const first = p.charAt(0);
      if (!first) return [];
      // prefix matches, and similarity candidates among the terms with a word starting with the same letter
      const rows = await termRows.aggregate<Doc>([{ $match: { kind, term: { $regex: `(^|\\s)${escapeRegExp(first)}`, $options: 'i' } } }]);
      return rows
        .map((d) => {
          const row = termRows.fromDoc(d);
          const term = row.term.toLowerCase();
          return { row, starts: term.startsWith(p), prefix: term.startsWith(p) || term.includes(` ${p}`), sim: similarity(term, p), wsim: wordSimilarity(p, term) };
        })
        .filter((x) => x.prefix || x.sim >= threshold || x.wsim >= threshold)
        .sort((a, b) => Number(b.starts) - Number(a.starts) || Number(b.row.weight) - Number(a.row.weight) || b.sim - a.sim || byKey(a.row.term, b.row.term))
        .slice(0, limit)
        .map((x) => x.row);
    },

    async suggestProducts(prefix, threshold, limit) {
      const p = prefix.toLowerCase();
      const ps = prefixStems(prefix);
      const first = p.charAt(0);
      const or: Doc[] = [...(ps.length ? [prefixMatch(ps)] : []), ...(first ? [{ title_norm: { $regex: `(^| )${escapeRegExp(first)}` } }] : [])];
      if (!or.length) return [];
      const found = await agg([{ $match: { offer_count: { $gt: 0 }, $or: or } }]);
      const startsWith = (d: Doc) => ps.length > 0 && ps.every((s) => ((d.terms ?? []) as { t: string }[]).some((x) => x.t.startsWith(s)));
      return found
        .filter((d) => startsWith(d) || wordSimilarity(p, d.title_norm) >= threshold)
        .sort(
          (a, b) =>
            Number(b.title_norm.includes(p)) - Number(a.title_norm.includes(p)) ||
            Number(b.in_stock) - Number(a.in_stock) ||
            Number(b.popularity) - Number(a.popularity) ||
            b.rating_count - a.rating_count ||
            byKey(a.title, b.title),
        )
        .slice(0, limit)
        .map(docOut);
    },

    async categoriesForPrefix(prefix, limit) {
      const ps = prefixStems(prefix);
      if (!ps.length) return [];
      const found = await agg<{ _id: string; n: number }>([
        { $match: { offer_count: { $gt: 0 }, category_id: { $ne: null }, ...prefixMatch(ps) } },
        { $group: { _id: '$category_id', n: { $sum: 1 } } },
        { $sort: { n: -1, _id: 1 } },
        { $limit: limit },
      ]);
      return found.map((r) => ({ categoryId: r._id, count: r.n }));
    },

    async similar(productId, limit) {
      const [b] = await agg([{ $match: { _id: productId } }, { $project: { terms: 0 } }]);
      if (!b) return [];
      const titleWords = [...new Set(String(b.title_norm).split(/\s+/).filter(Boolean))];
      const related: Doc[] = [
        ...(b.category_path_ids?.length ? [{ category_path_ids: { $in: b.category_path_ids } }] : []),
        ...(b.brand_id ? [{ brand_id: b.brand_id }] : []),
        // title similarity candidates: a title word in common
        ...(titleWords.length ? [{ title_norm: { $regex: `(^| )(${titleWords.map(escapeRegExp).join('|')})( |$)` } }] : []),
      ];
      if (!related.length) return [];
      const found = await agg([{ $match: { _id: { $ne: productId }, offer_count: { $gt: 0 }, in_stock: true, $or: related } }, { $project: { terms: 0 } }]);
      const overlap = (d: Doc) => (d.category_path_ids ?? []).some((c: string) => (b.category_path_ids ?? []).includes(c));
      return found
        .map((d) => ({ d, s: similarity(d.title_norm, b.title_norm) }))
        .filter(({ d, s }) => overlap(d) || (b.brand_id && d.brand_id === b.brand_id) || s >= 0.3)
        .sort(
          (x, y) =>
            Number((y.d.category_id ?? null) === (b.category_id ?? null)) - Number((x.d.category_id ?? null) === (b.category_id ?? null)) ||
            Number((y.d.brand_id ?? null) === (b.brand_id ?? null)) - Number((x.d.brand_id ?? null) === (b.brand_id ?? null)) ||
            y.s - x.s ||
            Number(y.d.popularity) - Number(x.d.popularity) ||
            byKey(x.d._id, y.d._id),
        )
        .slice(0, limit)
        .map(({ d }) => d._id as string);
    },

    async sellerCategoryCounts(sellerIds) {
      if (!sellerIds.length) return [];
      const found = await offers.aggregate<{ _id: { s: string; c: string }; n: number }>([
        { $match: { seller_id: { $in: sellerIds } } },
        { $lookup: { from: DOCUMENTS, localField: 'product_id', foreignField: '_id', pipeline: [{ $project: { category_id: 1 } }], as: 'd' } },
        { $unwind: '$d' },
        { $match: { 'd.category_id': { $ne: null } } },
        { $group: { _id: { s: '$seller_id', c: '$d.category_id', p: '$product_id' } } },
        { $group: { _id: { s: '$_id.s', c: '$_id.c' }, n: { $sum: 1 } } },
        { $sort: { n: -1, '_id.c': 1 } },
      ]);
      return found.map((r) => ({ sellerId: r._id.s, categoryId: r._id.c, count: r.n }));
    },

    async productCountsBySeller(sellerIds) {
      if (!sellerIds.length) return new Map();
      const found = await offers.aggregate<{ _id: string; n: number }>([
        { $match: { seller_id: { $in: sellerIds } } },
        { $group: { _id: { s: '$seller_id', p: '$product_id' } } },
        { $group: { _id: '$_id.s', n: { $sum: 1 } } },
      ]);
      return new Map(found.map((r) => [r._id, r.n]));
    },

    async productCountsByBrand(brandIds) {
      if (!brandIds.length) return new Map();
      const found = await agg<{ _id: string; n: number }>([{ $match: { offer_count: { $gt: 0 }, brand_id: { $in: brandIds } } }, { $group: { _id: '$brand_id', n: { $sum: 1 } } }]);
      return new Map(found.map((r) => [r._id, r.n]));
    },

    async popular(categoryIds, limit) {
      const found = await agg<{ _id: string }>([
        { $match: { offer_count: { $gt: 0 }, in_stock: true, ...(categoryIds?.length ? { category_path_ids: { $in: categoryIds } } : {}) } },
        { $sort: { popularity: -1, rating_count: -1, rating: -1, first_listed_at: -1, _id: 1 } },
        { $limit: limit },
        { $project: { _id: 1 } },
      ]);
      return found.map((r) => r._id);
    },

    async lookupProducts(q, gtin, limit) {
      const norm = q.toLowerCase().trim();
      const st = stems(norm);
      const or: Doc[] = [...(gtin ? [{ gtins: gtin }] : []), { title_norm: { $regex: escapeRegExp(norm) } }, ...(st.length ? [allTerms(st)] : [])];
      const found = await agg([
        { $match: { $or: or } },
        { $set: { _gtin: gtin ? { $in: [gtin, { $ifNull: ['$gtins', []] }] } : false, _starts: { $eq: [{ $indexOfCP: ['$title_norm', norm] }, 0] } } },
        { $sort: { _gtin: -1, _starts: -1, popularity: -1, title: 1 } },
        { $limit: limit },
        { $project: { terms: 0, _gtin: 0, _starts: 0 } },
      ]);
      return found.map(docOut);
    },

    async bestSellingAvailable(minOrders) {
      const [r] = await agg<{ n: number }>([{ $group: { _id: null, n: { $sum: '$sales_30d' } } }]);
      return (r?.n ?? 0) >= minOrders;
    },
  };
}
