/**
 * OpenSearch search engine (production): implements the SearchEngine port over the products index
 * (mapping.ts), with requests built by query.ts, and feeds the index from the read model (SearchIndexFeed,
 * products-index.ts). Suggestion terms stay in PostgreSQL (infra/postgres/terms.ts): term suggestions are
 * answered by the Postgres engine, and spelling correction combines the index's words with the terms' words.
 *
 * Typo tolerance: misspelled words are corrected (service: "Showing results for …") from candidates the index's
 * term suggester finds within two edits (fuzziness), ranked by trigram similarity like the Postgres engine;
 * suggestions while typing match title words with fuzziness AUTO.
 */
import type { FastifyBaseLogger } from 'fastify';
import type { RankingFactorKey } from '../../domain/ranking.js';
import { MIN_RATINGS_FOR_RANK } from '../../domain/ranking.js';
import type { SortKey } from '../../domain/types.js';
import type { EngineHit, EngineQuery, FacetCounts, SearchEngine, SearchIndexFeed, SearchRepository, TermKind, TermRow } from '../../ports.js';
import type { TermLookup } from '../postgres/terms.js';
import type { OsApi } from './client.js';
import { docOf } from './document.js';
import { TEXT_FIELDS } from './mapping.js';
import type { ProductIndex } from './products-index.js';
import { alternative, countBody, facetsBody, HIT_SOURCE, MATCH_ALL, priceRangeBodies, priceStreamBodies, searchBody, summaryBody, type Q, type Weights } from './query.js';
import { docFactors, eoFactors, TEXT_RELEVANCE } from './scripts.js';
import { similarity } from './trigram.js';

export interface OpenSearchEngineDeps {
  os: OsApi;
  index: ProductIndex;
  log: FastifyBaseLogger;
  /** Suggestion terms (PostgreSQL) */
  terms: TermLookup;
  /** Brand suggestion terms mark active brands (brand facet) */
  repo: Pick<SearchRepository, 'terms'>;
  /** Term suggestions are answered by the Postgres engine (suggestion_terms) */
  termEngine: Pick<SearchEngine, 'suggestTerms'>;
}

interface Hit {
  _id: string;
  _score: number | null;
  _source: Record<string, any>;
  sort?: (number | string | null)[];
  inner_hits?: { eo?: { hits: { total: { value: number } | number; hits: { _source: Record<string, any> }[] } } };
}
interface SearchResponse {
  hits: { total?: { value: number } | number; hits: Hit[] };
  aggregations?: Record<string, any>;
  suggest?: Record<string, { options: { text: string }[] }[]>;
}

const totalOf = (t: { value: number } | number | undefined) => (typeof t === 'number' ? t : (t?.value ?? 0));
const likeText = (s: string) => s.replace(/[\\*?]/g, (c) => `\\${c}`);
const words = (s: string) =>
  s
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .slice(0, 8);

/** Every word as a prefix (typing), on the text fields */
const prefixQuery = (prefix: string): Q | null => {
  const w = words(prefix);
  return w.length ? { bool: { must: w.map((x) => ({ multi_match: { query: x, type: 'phrase_prefix', fields: [...TEXT_FIELDS] } })) } } : null;
};

export function createOpenSearchEngine(d: OpenSearchEngineDeps): SearchEngine & { feed: SearchIndexFeed } {
  const { os, index } = d;
  const path = (p: string) => `/${index.alias}${p}`;

  async function search(body: Q): Promise<SearchResponse> {
    await index.ensure();
    return (await os.request<SearchResponse>('POST', path('/_search'), body)).body;
  }

  async function msearch(bodies: Q[]): Promise<SearchResponse[]> {
    if (!bodies.length) return [];
    await index.ensure();
    const r = await os.ndjson<{ responses: (SearchResponse & { error?: { type?: string; reason?: string }; status?: number })[] }>(
      '/_msearch',
      bodies.flatMap((b) => [{ index: index.alias }, b]),
    );
    return r.body.responses.map((x) => {
      if (x.error) throw new Error(`OpenSearch search failed: ${x.error.type ?? ''} ${x.error.reason ?? ''}`.trim());
      return x;
    });
  }

  async function count(body: Q): Promise<number> {
    await index.ensure();
    return (await os.request<{ count: number }>('POST', path('/_count'), body)).body.count;
  }

  function toHit(h: Hit, q: EngineQuery, w: Weights): EngineHit {
    const doc = docOf(h._source);
    const inner = h.inner_hits?.eo?.hits;
    const eo = inner?.hits[0]?._source;
    const score = Number(h._score ?? 0);
    const gtin = q.text?.gtin && doc.gtins.includes(q.text.gtin) ? 1 : 0;
    const ef = eo ? eoFactors({ w_in_stock: w.in_stock, w_delivery: w.delivery_speed }, { inStock: Boolean(eo.in_stock), dispatchDays: Number(eo.dispatch_days) }) : { in_stock: 0, delivery_speed: 0 };
    const df = docFactors(
      { w_featured: w.featured_offer, w_rating: w.rating, w_conversion: w.conversion, minRatings: MIN_RATINGS_FOR_RANK },
      { featured: Boolean(doc.featured_offer_id), ratingCount: doc.rating_count, rating: doc.rating === null ? null : Number(doc.rating), popularity: Number(doc.popularity) },
    );
    // the text part is what the score holds beyond the other factors (scripts.ts TEXT_RELEVANCE)
    const text = q.text?.groups.length ? Math.max(0, score - gtin - ef.in_stock - ef.delivery_speed - df.total) : 0;
    return {
      doc,
      score,
      factors: { text_relevance: text, in_stock: ef.in_stock, featured_offer: df.featured_offer, delivery_speed: ef.delivery_speed, rating: df.rating, conversion: df.conversion, gtin },
      offer: eo
        ? {
            offerId: eo.offer_id,
            variantId: eo.variant_id,
            sellerId: eo.seller_id ?? null,
            official: Boolean(eo.official),
            condition: eo.condition ?? 'new',
            price: Number(eo.price),
            inStock: Boolean(eo.in_stock),
            freeDelivery: Boolean(eo.free_delivery),
            dispatchDays: Number(eo.dispatch_days ?? 0),
            matching: totalOf(inner?.total) || 1,
          }
        : null,
    };
  }

  /** Price sorts: the streams' first offset+limit products merged by card-offer price, score, product id */
  async function priceSearch(q: EngineQuery, order: 'asc' | 'desc', w: Weights, window: { offset: number; limit: number }) {
    const responses = await msearch(priceStreamBodies(q, order, w, window));
    const total = responses.reduce((n, r) => n + totalOf(r.hits.total), 0);
    const all = responses.flatMap((r) => r.hits.hits);
    const dir = order === 'asc' ? 1 : -1;
    all.sort((a, b) => {
      const pa = Number(a.sort?.[0]);
      const pb = Number(b.sort?.[0]);
      if (pa !== pb) return dir * (pa - pb);
      const sa = Number(a._score ?? 0);
      const sb = Number(b._score ?? 0);
      if (sa !== sb) return sb - sa;
      return a._id < b._id ? -1 : a._id > b._id ? 1 : 0;
    });
    return { hits: all.slice(window.offset, window.offset + window.limit), total };
  }

  const engine: SearchEngine & { feed: SearchIndexFeed } = {
    name: 'opensearch',

    feed: {
      write: (upserts, deletes) => index.write(upserts, deletes),
      beginRebuild: () => index.beginRebuild(),
      finishRebuild: (ok, carryOver) => index.finishRebuild(ok, carryOver),
    },

    describe: () => index.describe(),

    async search(q, sort: SortKey, weights: Record<RankingFactorKey, number>, window) {
      if (window.limit <= 0) return { hits: [], total: await count(countBody(q)) };
      if (sort === 'price_asc' || sort === 'price_desc') {
        const { hits, total } = await priceSearch(q, sort === 'price_asc' ? 'asc' : 'desc', weights, window);
        return { hits: hits.map((h) => toHit(h, q, weights)), total };
      }
      const r = await search(searchBody(q, sort, weights, window));
      return { hits: r.hits.hits.map((h) => toHit(h, q, weights)), total: totalOf(r.hits.total) };
    },

    count: (q) => count(countBody(q)),

    async summary(q) {
      const r = await search(summaryBody(q));
      const m = r.aggregations?.offers?.matching;
      return { total: totalOf(r.hits.total), sellers: Number(m?.sellers?.value ?? 0), official: Number(m?.official?.doc_count ?? 0) > 0 };
    },

    async facets(q, attributeKeys) {
      const ranges = priceRangeBodies(q);
      const [main, ...prices] = await msearch([facetsBody(q, attributeKeys), ...ranges.map((r) => r.body)]);
      const a = main!.aggregations ?? {};
      const buckets = (x: any): { key: string; doc_count: number; [k: string]: any }[] => x?.buckets ?? [];

      const brandBuckets = buckets(a.brands?.v);
      const active = new Set((await d.repo.terms('brand', brandBuckets.map((b) => String(b.key)))).map((t) => t.target_id));
      const brands = brandBuckets
        .filter((b) => active.has(String(b.key)))
        .map((b) => ({ id: String(b.key), name: String(buckets(b.name)[0]?.key ?? ''), count: b.doc_count }))
        .sort((x, y) => y.count - x.count || (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));

      const attributes = new Map<string, Map<string, number>>();
      const addAttr = (key: string, valueBuckets: any) => {
        const m = attributes.get(key) ?? new Map<string, number>();
        for (const v of buckets(valueBuckets)) m.set(String(v.key), (m.get(String(v.key)) ?? 0) + Number(v.p?.doc_count ?? 0));
        attributes.set(key, m);
      };
      for (const k of buckets(a.attributes?.a?.k?.k)) addAttr(String(k.key), k.v);
      for (const key of attributeKeys) if (a[`attr:${key}`]) addAttr(key, a[`attr:${key}`].a?.k?.v);

      let min: number | null = null;
      let max: number | null = null;
      ranges.forEach((r, i) => {
        const v = prices[i]?.hits.hits[0]?.sort?.[0];
        if (v === undefined || v === null) return;
        const n = Number(v);
        if (r.order === 'asc') min = min === null ? n : Math.min(min, n);
        else max = max === null ? n : Math.max(max, n);
      });

      const result: FacetCounts = {
        categories: new Map(buckets(a.categories?.v).map((b) => [String(b.key), b.doc_count])),
        brands,
        sellers: new Map(buckets(a.sellers?.o?.m?.v).map((b) => [String(b.key), Number(b.p?.doc_count ?? 0)])),
        official: Number(a.sellers?.o?.m?.official?.p?.doc_count ?? 0),
        conditions: new Map(buckets(a.conditions?.o?.m?.v).map((b) => [String(b.key), Number(b.p?.doc_count ?? 0)])),
        ratings: new Map([1, 2, 3, 4, 5].map((n) => [n, Number(a.ratings?.v?.buckets?.[`r${n}`]?.doc_count ?? 0)])),
        inStock: Number(a.availability?.in_stock?.doc_count ?? 0),
        includingOutOfStock: Number(a.availability?.doc_count ?? 0),
        freeDelivery: Number(a.delivery?.free?.doc_count ?? 0),
        shipsToday: Number(a.delivery?.today?.doc_count ?? 0),
        price: { min, max },
        attributes,
      };
      return result;
    },

    async correctWord(word, threshold) {
      if (word.length < 3 || /\d/.test(word)) return null;
      const [inIndex, isTerm] = await Promise.all([count({ query: alternative(word) }), d.terms.isTerm(word)]);
      if (inIndex > 0 || isTerm) return null;
      const [suggested, termWords] = await Promise.all([
        search({ size: 0, suggest: { w: { text: word, term: { field: 'title_norm', suggest_mode: 'always', max_edits: 2, prefix_length: 0, min_word_length: 3, size: 10 } } } }),
        d.terms.similarTermWords(word, threshold),
      ]);
      const candidates = new Set<string>([...(suggested.suggest?.w?.[0]?.options ?? []).map((o) => o.text), ...termWords.map((t) => t.word)]);
      const best = [...candidates]
        .filter((c) => c.length >= 3 && c !== word)
        .map((c) => ({ w: c, s: similarity(c, word) }))
        .filter((c) => c.s >= threshold)
        .sort((x, y) => y.s - x.s || Math.abs(x.w.length - word.length) - Math.abs(y.w.length - word.length) || (x.w < y.w ? -1 : 1))[0];
      return best?.w ?? null;
    },

    async knownPrefix(prefix) {
      const p = prefix.toLowerCase();
      if ((await count({ query: { prefix: { title_norm: p } } })) > 0) return true;
      return d.terms.hasTermPrefix(p);
    },

    suggestTerms: (kind: TermKind, prefix, threshold, limit): Promise<TermRow[]> => d.termEngine.suggestTerms(kind, prefix, threshold, limit),

    async suggestProducts(prefix, threshold, limit) {
      const p = prefix.toLowerCase();
      const pq = prefixQuery(prefix);
      const matches: Q[] = [...(pq ? [pq] : []), { match: { title_norm: { query: p, fuzziness: 'AUTO', operator: 'and' } } }];
      void threshold; // trigram threshold of the Postgres engine; fuzziness AUTO here
      const r = await search({
        size: limit,
        query: {
          bool: {
            filter: [{ range: { offer_count: { gt: 0 } } }, { bool: { should: matches, minimum_should_match: 1 } }],
            should: [{ constant_score: { filter: { wildcard: { 'title_norm.kw': { value: `*${likeText(p)}*` } } }, boost: 1 } }],
          },
        },
        sort: [{ _score: { order: 'desc' } }, { in_stock: { order: 'desc' } }, { popularity: { order: 'desc' } }, { rating_count: { order: 'desc' } }, { 'title.kw': { order: 'asc' } }],
        _source: HIT_SOURCE,
      });
      return r.hits.hits.map((h) => docOf(h._source));
    },

    async categoriesForPrefix(prefix, limit) {
      const pq = prefixQuery(prefix);
      if (!pq) return [];
      const r = await search({
        size: 0,
        query: { bool: { filter: [{ range: { offer_count: { gt: 0 } } }, { exists: { field: 'category_id' } }, pq] } },
        aggs: { c: { terms: { field: 'category_id', size: limit, order: [{ _count: 'desc' }, { _key: 'asc' }] } } },
      });
      return (r.aggregations?.c?.buckets ?? []).map((b: { key: string; doc_count: number }) => ({ categoryId: String(b.key), count: b.doc_count }));
    },

    async similar(productId, limit) {
      await index.ensure();
      const got = await os.request<{ found?: boolean; _source?: Record<string, any> }>('GET', path(`/_doc/${encodeURIComponent(productId)}`), undefined, { ignore: [404] });
      const base = got.body?.found ? got.body._source : undefined;
      if (!base) return [];
      const same = (field: string, value: unknown): Q => (value == null ? { bool: { must_not: [{ exists: { field } }] } } : { term: { [field]: value } });
      const title: Q = { match: { title_norm: { query: base.title_norm ?? '', minimum_should_match: '30%' } } };
      const related: Q[] = [...(base.category_path_ids?.length ? [{ terms: { category_path_ids: base.category_path_ids } }] : []), ...(base.brand_id ? [{ term: { brand_id: base.brand_id } }] : []), title];
      const r = await search({
        size: limit,
        query: {
          bool: {
            filter: [{ range: { offer_count: { gt: 0 } } }, { term: { in_stock: true } }, { bool: { should: related, minimum_should_match: 1 } }],
            must_not: [{ term: { product_id: productId } }],
            // same category (4), then same brand (2), then title similarity (0..1)
            should: [
              { constant_score: { filter: same('category_id', base.category_id), boost: 4 } },
              { constant_score: { filter: same('brand_id', base.brand_id), boost: 2 } },
              { function_score: { query: title, script_score: { script: { source: TEXT_RELEVANCE, params: { w: 1 } } }, boost_mode: 'replace' } },
            ],
          },
        },
        sort: [{ _score: { order: 'desc' } }, { popularity: { order: 'desc' } }, { product_id: { order: 'asc' } }],
        _source: ['product_id'],
      });
      return r.hits.hits.map((h) => h._id);
    },

    async sellerCategoryCounts(sellerIds) {
      if (!sellerIds.length) return [];
      const r = await search({
        size: 0,
        query: { nested: { path: 'offers', query: { terms: { 'offers.seller_id': sellerIds } } } },
        aggs: {
          o: {
            nested: { path: 'offers' },
            aggs: { s: { filter: { terms: { 'offers.seller_id': sellerIds } }, aggs: { v: { terms: { field: 'offers.seller_id', size: sellerIds.length }, aggs: { p: { reverse_nested: {}, aggs: { c: { terms: { field: 'category_id', size: 10_000 } } } } } } } } },
          },
        },
      });
      const rows: { sellerId: string; categoryId: string; count: number }[] = [];
      for (const s of r.aggregations?.o?.s?.v?.buckets ?? []) for (const c of s.p?.c?.buckets ?? []) rows.push({ sellerId: String(s.key), categoryId: String(c.key), count: c.doc_count });
      return rows.sort((x, y) => y.count - x.count || (x.categoryId < y.categoryId ? -1 : x.categoryId > y.categoryId ? 1 : 0));
    },

    async productCountsBySeller(sellerIds) {
      if (!sellerIds.length) return new Map();
      const r = await search({
        size: 0,
        query: MATCH_ALL,
        aggs: { o: { nested: { path: 'offers' }, aggs: { s: { filter: { terms: { 'offers.seller_id': sellerIds } }, aggs: { v: { terms: { field: 'offers.seller_id', size: sellerIds.length }, aggs: { p: { reverse_nested: {} } } } } } } } },
      });
      return new Map((r.aggregations?.o?.s?.v?.buckets ?? []).map((b: any) => [String(b.key), Number(b.p?.doc_count ?? 0)]));
    },

    async productCountsByBrand(brandIds) {
      if (!brandIds.length) return new Map();
      const r = await search({
        size: 0,
        query: { bool: { filter: [{ range: { offer_count: { gt: 0 } } }, { terms: { brand_id: brandIds } }] } },
        aggs: { b: { terms: { field: 'brand_id', size: brandIds.length } } },
      });
      return new Map((r.aggregations?.b?.buckets ?? []).map((b: any) => [String(b.key), b.doc_count as number]));
    },

    async popular(categoryIds, limit) {
      const r = await search({
        size: limit,
        query: { bool: { filter: [{ range: { offer_count: { gt: 0 } } }, { term: { in_stock: true } }, ...(categoryIds?.length ? [{ terms: { category_path_ids: categoryIds } }] : [])] } },
        sort: [{ popularity: { order: 'desc' } }, { rating_count: { order: 'desc' } }, { rating: { order: 'desc', missing: '_last' } }, { first_listed_at: { order: 'desc' } }, { product_id: { order: 'asc' } }],
        _source: ['product_id'],
      });
      return r.hits.hits.map((h) => h._id);
    },

    async lookupProducts(q, gtin, limit) {
      const norm = q.toLowerCase().trim();
      const match: Q[] = [...(gtin ? [{ term: { gtins: gtin } }] : []), { wildcard: { 'title_norm.kw': { value: `*${likeText(norm)}*` } } }, alternative(norm)];
      const r = await search({
        size: limit,
        query: {
          bool: {
            filter: [{ bool: { should: match, minimum_should_match: 1 } }],
            // GTIN match first, then titles starting with the text
            should: [...(gtin ? [{ constant_score: { filter: { term: { gtins: gtin } }, boost: 2 } }] : []), { constant_score: { filter: { prefix: { 'title_norm.kw': { value: norm } } }, boost: 1 } }],
          },
        },
        sort: [{ _score: { order: 'desc' } }, { popularity: { order: 'desc' } }, { 'title.kw': { order: 'asc' } }],
        _source: HIT_SOURCE,
      });
      return r.hits.hits.map((h) => docOf(h._source));
    },

    async bestSellingAvailable(minOrders) {
      const r = await search({ size: 0, query: MATCH_ALL, aggs: { s: { sum: { field: 'sales_30d' } } } });
      return Number(r.aggregations?.s?.value ?? 0) >= minOrders;
    },
  };
  return engine;
}
