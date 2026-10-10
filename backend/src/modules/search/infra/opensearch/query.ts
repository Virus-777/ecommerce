/**
 * EngineQuery → OpenSearch request bodies (pure; unit-tested with exact bodies in test/opensearch-query.test.ts).
 * Semantics follow the Postgres engine (infra/postgres/engine.ts):
 *
 * - Text: every group must match, any alternative of a group (synonyms are expanded by the service before the
 *   engine sees the query, so a synonym change applies on the next query without reindexing). A word matches
 *   across the text fields (cross_fields, english analysis), a phrase as a phrase. A full GTIN matches too.
 * - The card offer ("eo") is the matching offer with the lowest card_rank; a product matches only with one.
 * - Recommended score = text relevance + ranking-policy factors (scripts.ts), summed by a bool query.
 * - Price sorts use the card offer's price, exactly: products are split into streams by which tier their card
 *   offer comes from (featured / in stock / any), each stream sorted by a nested min over that tier, then merged.
 * - Facet counts are computed against the other active filters (one filter aggregation per facet).
 */
import type { RankingFactorKey } from '../../domain/ranking.js';
import { MIN_RATINGS_FOR_RANK } from '../../domain/ranking.js';
import type { SortKey } from '../../domain/types.js';
import type { EngineFilters, EngineQuery, FacetOmit } from '../../ports.js';
import { TEXT_FIELDS } from './mapping.js';
import { DOC_FACTORS, EO_FACTORS, EO_KEY, EO_MAX_RANK, TEXT_RELEVANCE } from './scripts.js';

export type Q = Record<string, any>;
export type Weights = Record<RankingFactorKey, number>;

export const MATCH_ALL: Q = { match_all: {} };
export const MATCH_NONE: Q = { match_none: {} };

/** Fields a hit does not need (cards are built from the read-model fields) */
export const HIT_SOURCE = { excludes: ['category_text', 'attributes_text', 'description', 'attrs'] };

export const filterQ = (filters: Q[]): Q => (filters.length ? { bool: { filter: filters } } : MATCH_ALL);
export const nested = (path: 'offers' | 'attrs', filters: Q[]): Q => ({ nested: { path, query: filterQ(filters) } });

/* ------------------------------------------------------------------ text */

export function alternative(alt: string): Q {
  return alt.includes(' ')
    ? { multi_match: { query: alt, type: 'phrase', fields: [...TEXT_FIELDS] } }
    : { multi_match: { query: alt, type: 'cross_fields', operator: 'and', fields: [...TEXT_FIELDS] } };
}

/** Every group must match; any alternative of a group */
export function textQuery(groups: string[][]): Q | null {
  if (!groups.length) return null;
  return { bool: { must: groups.map((g) => (g.length === 1 ? alternative(g[0]!) : { bool: { should: g.map(alternative), minimum_should_match: 1 } })) } };
}

/** Words or a GTIN (nothing when the words are empty and there is no GTIN) */
export function textMatch(q: EngineQuery): Q | null {
  if (!q.text) return null;
  const parts: Q[] = [];
  const t = textQuery(q.text.groups);
  if (t) parts.push(t);
  if (q.text.gtin) parts.push({ term: { gtins: q.text.gtin } });
  if (!parts.length) return MATCH_NONE;
  return parts.length === 1 ? parts[0]! : { bool: { should: parts, minimum_should_match: 1 } };
}

/* ------------------------------------------------------------------ filters */

/** Conditions on an offer (nested path offers) */
export function offerConds(f: EngineFilters, omit?: FacetOmit): Q[] {
  const c: Q[] = [];
  if (omit !== 'seller' && (f.sellerIds?.length || f.official)) {
    const parts: Q[] = [];
    if (f.sellerIds?.length) parts.push({ terms: { 'offers.seller_id': f.sellerIds } });
    if (f.official) parts.push({ term: { 'offers.official': true } });
    c.push(parts.length === 1 ? parts[0]! : { bool: { should: parts, minimum_should_match: 1 } });
  }
  if (omit !== 'condition' && f.conditions?.length) c.push({ terms: { 'offers.condition': f.conditions } });
  if (omit !== 'price' && (f.priceMin !== undefined || f.priceMax !== undefined)) {
    c.push({ range: { 'offers.price': { ...(f.priceMin !== undefined ? { gte: f.priceMin } : {}), ...(f.priceMax !== undefined ? { lte: f.priceMax } : {}) } } });
  }
  if (omit !== 'availability' && f.inStockOnly) c.push({ term: { 'offers.in_stock': true } });
  if (omit !== 'delivery') {
    if (f.freeDelivery) c.push({ term: { 'offers.free_delivery': true } });
    if (f.shipsToday) c.push({ term: { 'offers.dispatch_days': 0 } });
    if (f.maxDispatchDays !== undefined) c.push({ range: { 'offers.dispatch_days': { lte: f.maxDispatchDays } } });
  }
  return c;
}

/** Same-day dispatch still possible: no cutoff, or a cutoff after the market time */
export const cutoffOk = (marketTime: string): Q => ({
  bool: { should: [{ bool: { must_not: [{ exists: { field: 'same_day_cutoff' } }] } }, { range: { same_day_cutoff: { gt: `${marketTime.slice(0, 5)}:00` } } }], minimum_should_match: 1 },
});

/** Document-level filters with the facet each belongs to (null: never left out) */
export function docFilters(q: EngineQuery): { omit: FacetOmit | null; q: Q }[] {
  const f = q.filters;
  const out: { omit: FacetOmit | null; q: Q }[] = [];
  const text = textMatch(q);
  if (text) out.push({ omit: null, q: text });
  if (q.productIds) out.push({ omit: null, q: q.productIds.length ? { terms: { product_id: q.productIds } } : MATCH_NONE });
  if (q.excludeProductIds?.length) out.push({ omit: null, q: { bool: { must_not: [{ terms: { product_id: q.excludeProductIds } }] } } });
  if (f.categoryIds?.length) out.push({ omit: 'category', q: { terms: { category_path_ids: f.categoryIds } } });
  if (f.brandIds?.length) out.push({ omit: 'brand', q: { terms: { brand_id: f.brandIds } } });
  if (f.minRating !== undefined) out.push({ omit: 'rating', q: { range: { rating: { gte: f.minRating } } } });
  if (f.onSale) out.push({ omit: null, q: { term: { on_sale: true } } });
  if (f.listedSince) out.push({ omit: null, q: { range: { first_listed_at: { gte: f.listedSince.toISOString() } } } });
  if (f.shipsToday) out.push({ omit: 'delivery', q: cutoffOk(q.marketTime) });
  for (const a of f.attributes ?? []) {
    out.push({ omit: `attr:${a.key}`, q: nested('attrs', [{ term: { 'attrs.k': a.key } }, { terms: { 'attrs.vl': a.values.map((v) => v.trim().toLowerCase()) } }]) });
  }
  return out;
}

/** Products with a card offer under the offer filters */
export const hasCardOffer = (f: EngineFilters, omit?: FacetOmit): Q => nested('offers', offerConds(f, omit));

/** Every filter (one left out for a facet's counts), the card offer included */
export function where(q: EngineQuery, omit?: FacetOmit): Q[] {
  return [...docFilters(q).filter((d) => !omit || d.omit !== omit).map((d) => d.q), hasCardOffer(q.filters, omit)];
}

/* ------------------------------------------------------------------ scoring */

/** The card offer: scored with its key (scripts.ts EO_KEY), returned as inner hit 'eo' with the number of matching offers */
export function cardOfferClause(f: EngineFilters, w: Weights): Q {
  return {
    function_score: {
      query: {
        nested: {
          path: 'offers',
          score_mode: 'max',
          query: { function_score: { query: filterQ(offerConds(f)), script_score: { script: { source: EO_KEY, params: { maxRank: EO_MAX_RANK } } }, boost_mode: 'replace' } },
          inner_hits: { name: 'eo', size: 1, sort: [{ 'offers.card_rank': { order: 'asc' } }] },
        },
      },
      script_score: { script: { source: EO_FACTORS, params: { w_in_stock: w.in_stock, w_delivery: w.delivery_speed } } },
      boost_mode: 'replace',
    },
  };
}

export const docFactorsClause = (w: Weights): Q => ({
  function_score: {
    query: MATCH_ALL,
    script_score: { script: { source: DOC_FACTORS, params: { w_featured: w.featured_offer, w_rating: w.rating, w_conversion: w.conversion, minRatings: MIN_RATINGS_FOR_RANK } } },
    boost_mode: 'replace',
  },
});

/** Filters, card offer and recommended score (text relevance + ranking policy factors + GTIN) */
export function scoredQuery(q: EngineQuery, w: Weights, extraFilters: Q[] = []): Q {
  const should: Q[] = [];
  const text = q.text?.groups.length ? textQuery(q.text.groups) : null;
  if (text) should.push({ function_score: { query: text, script_score: { script: { source: TEXT_RELEVANCE, params: { w: w.text_relevance } } }, boost_mode: 'replace' } });
  if (q.text?.gtin) should.push({ constant_score: { filter: { term: { gtins: q.text.gtin } }, boost: 1 } });
  return {
    bool: {
      filter: [...docFilters(q).map((d) => d.q), ...extraFilters],
      must: [cardOfferClause(q.filters, w), docFactorsClause(w)],
      ...(should.length ? { should } : {}),
    },
  };
}

/* ------------------------------------------------------------------ sorts */

const BY_ID = { product_id: { order: 'asc' } };
const BY_SCORE = { _score: { order: 'desc' } };

export const FIELD_SORTS: Record<Exclude<SortKey, 'price_asc' | 'price_desc'>, Q[]> = {
  recommended: [BY_SCORE, BY_ID],
  newest: [{ first_listed_at: { order: 'desc' } }, BY_ID],
  rating: [{ rating: { order: 'desc', missing: '_last' } }, { rating_count: { order: 'desc' } }, BY_SCORE, BY_ID],
  best_selling: [{ sales_30d: { order: 'desc' } }, BY_SCORE, BY_ID],
};

export interface PriceStream {
  /** Which products: their card offer comes from this tier */
  filter: Q;
  /** The card offer's price: the lowest price among the tier's matching offers */
  sort: Q;
}

/**
 * Products split by where their card offer comes from: the featured offer matches; else an in-stock offer
 * matches (the cheapest is the card offer); else only out-of-stock offers match (the cheapest).
 */
export function priceStreams(f: EngineFilters, order: 'asc' | 'desc', omit?: FacetOmit): PriceStream[] {
  const conds = offerConds(f, omit);
  const featured = [...conds, { term: { 'offers.featured': true } }];
  const inStock = [...conds, { term: { 'offers.in_stock': true } }];
  const sort = (filters: Q[]): Q => ({ 'offers.price': { order, mode: 'min', nested: { path: 'offers', filter: filterQ(filters) } } });
  const streams: PriceStream[] = [
    { filter: nested('offers', featured), sort: sort(featured) },
    { filter: { bool: { filter: [nested('offers', inStock)], must_not: [nested('offers', featured)] } }, sort: sort(inStock) },
  ];
  // with in stock required every matching offer is in stock: the third tier is empty
  if (!(f.inStockOnly && omit !== 'availability')) {
    streams.push({ filter: { bool: { filter: [nested('offers', conds)], must_not: [nested('offers', featured), nested('offers', inStock)] } }, sort: sort(conds) });
  }
  return streams;
}

/* ------------------------------------------------------------------ request bodies */

export function searchBody(q: EngineQuery, sort: Exclude<SortKey, 'price_asc' | 'price_desc'>, w: Weights, window: { offset: number; limit: number }): Q {
  return {
    from: window.offset,
    size: window.limit,
    track_total_hits: true,
    ...(sort === 'recommended' ? {} : { track_scores: true }),
    query: scoredQuery(q, w),
    sort: FIELD_SORTS[sort],
    _source: HIT_SOURCE,
  };
}

/** One body per price stream; each returns the first offset+limit products of its stream */
export function priceStreamBodies(q: EngineQuery, order: 'asc' | 'desc', w: Weights, window: { offset: number; limit: number }): Q[] {
  return priceStreams(q.filters, order).map((s) => ({
    from: 0,
    size: window.offset + window.limit,
    track_total_hits: true,
    track_scores: true,
    query: scoredQuery(q, w, [s.filter]),
    sort: [s.sort, BY_SCORE, BY_ID],
    _source: HIT_SOURCE,
  }));
}

export const countBody = (q: EngineQuery): Q => ({ query: filterQ(where(q)) });

export function summaryBody(q: EngineQuery): Q {
  return {
    size: 0,
    track_total_hits: true,
    query: filterQ(where(q)),
    aggs: {
      offers: {
        nested: { path: 'offers' },
        aggs: {
          matching: {
            filter: filterQ(offerConds(q.filters)),
            aggs: { sellers: { cardinality: { field: 'offers.seller_key', precision_threshold: 40_000 } }, official: { filter: { term: { 'offers.official': true } } } },
          },
        },
      },
    },
  };
}

const TERMS_SIZE = 10_000;
const reverse = { p: { reverse_nested: {} } };

/** Facet counts in one request: each facet counted against the other active filters */
export function facetsBody(q: EngineQuery, attributeKeys: string[]): Q {
  const f = q.filters;
  const always = docFilters(q).filter((d) => d.omit === null).map((d) => d.q);
  const rest = (omit?: FacetOmit): Q => filterQ([...docFilters(q).filter((d) => d.omit !== null && d.omit !== omit).map((d) => d.q), hasCardOffer(f, omit)]);
  const offerFacet = (omit: 'seller' | 'condition', field: string, extra: Q = {}): Q => ({
    filter: rest(omit),
    aggs: { o: { nested: { path: 'offers' }, aggs: { m: { filter: filterQ(offerConds(f, omit)), aggs: { v: { terms: { field, size: TERMS_SIZE }, aggs: reverse }, ...extra } } } } },
  });
  const availConds = offerConds(f, 'availability');
  const featuredOffer = [...availConds, { term: { 'offers.featured': true } }];
  const deliveryConds = offerConds(f, 'delivery');
  const filtered = new Set((f.attributes ?? []).map((a) => a.key));
  const unfiltered = attributeKeys.filter((k) => !filtered.has(k));

  const aggs: Q = {
    categories: { filter: rest('category'), aggs: { v: { terms: { field: 'category_path_ids', size: TERMS_SIZE } } } },
    brands: { filter: rest('brand'), aggs: { v: { terms: { field: 'brand_id', size: TERMS_SIZE }, aggs: { name: { terms: { field: 'brand_name.raw', size: 1, order: { _key: 'desc' } } } } } } },
    sellers: offerFacet('seller', 'offers.seller_id', { official: { filter: { term: { 'offers.official': true } }, aggs: reverse } }),
    conditions: offerFacet('condition', 'offers.condition'),
    ratings: { filter: rest('rating'), aggs: { v: { filters: { filters: Object.fromEntries([1, 2, 3, 4, 5].map((n) => [`r${n}`, { range: { rating: { gte: n } } }])) } } } },
    availability: {
      filter: rest('availability'),
      aggs: {
        // the card offer is in stock: the featured offer matches and is in stock, or it does not match and an in-stock one does
        in_stock: {
          filter: {
            bool: {
              should: [
                nested('offers', [...featuredOffer, { term: { 'offers.in_stock': true } }]),
                { bool: { must_not: [nested('offers', featuredOffer)], filter: [nested('offers', [...availConds, { term: { 'offers.in_stock': true } }])] } },
              ],
              minimum_should_match: 1,
            },
          },
        },
      },
    },
    delivery: {
      filter: rest('delivery'),
      aggs: {
        free: { filter: nested('offers', [{ term: { 'offers.free_delivery': true } }, ...deliveryConds]) },
        today: { filter: { bool: { filter: [cutoffOk(q.marketTime), nested('offers', [{ term: { 'offers.dispatch_days': 0 } }, ...deliveryConds])] } } },
      },
    },
  };
  if (unfiltered.length) {
    aggs.attributes = {
      filter: rest(),
      aggs: { a: { nested: { path: 'attrs' }, aggs: { k: { filter: { terms: { 'attrs.k': unfiltered } }, aggs: { k: { terms: { field: 'attrs.k', size: TERMS_SIZE }, aggs: { v: { terms: { field: 'attrs.v', size: TERMS_SIZE }, aggs: reverse } } } } } } } },
    };
  }
  for (const key of attributeKeys.filter((k) => filtered.has(k))) {
    aggs[`attr:${key}`] = {
      filter: rest(`attr:${key}`),
      aggs: { a: { nested: { path: 'attrs' }, aggs: { k: { filter: { term: { 'attrs.k': key } }, aggs: { v: { terms: { field: 'attrs.v', size: TERMS_SIZE }, aggs: reverse } } } } } },
    };
  }
  return { size: 0, track_total_hits: true, query: filterQ(always), aggs };
}

/** Lowest and highest card-offer price with the price filter left out: the first product of each price stream */
export function priceRangeBodies(q: EngineQuery): { order: 'asc' | 'desc'; body: Q }[] {
  const base = where(q, 'price').slice(0, -1);
  return (['asc', 'desc'] as const).flatMap((order) =>
    priceStreams(q.filters, order, 'price').map((s) => ({ order, body: { size: 1, track_total_hits: false, _source: false, query: filterQ([...base, s.filter]), sort: [s.sort] } })),
  );
}
