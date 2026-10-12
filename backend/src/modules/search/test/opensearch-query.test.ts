/** OpenSearch adapter, pure parts: query translation (exact request bodies), documents, scripts, configuration. */
import { describe, expect, it } from 'vitest';
import { readSearchEngineConfig } from '../infra/config.js';
import { OsApi, createOpenSearchClient } from '../infra/opensearch/client.js';
import { cardOrder, cutoffText, docOf, fieldsOf, sourceOf } from '../infra/opensearch/document.js';
import { createOpenSearchEngine } from '../infra/opensearch/engine.js';
import { MAPPING_VERSION, productIndexBody, TEXT_FIELDS } from '../infra/opensearch/mapping.js';
import { ProductIndex } from '../infra/opensearch/products-index.js';
import { countBody, facetsBody, offerConds, priceRangeBodies, priceStreamBodies, priceStreams, scoredQuery, searchBody, summaryBody, textMatch, textQuery, where, type Weights } from '../infra/opensearch/query.js';
import { DOC_FACTORS, EO_FACTORS, EO_KEY, EO_MAX_RANK, SCRIPT_TWINS, TEXT_RELEVANCE, VERSIONED_WRITE, docFactors, eoFactors } from '../infra/opensearch/scripts.js';
import { similarity } from '../infra/opensearch/trigram.js';
import type { DocRow, EngineQuery, OfferRow } from '../ports.js';
import { testOpenSearchConfig } from './helpers.js';
import { fakeClientOptions, FakeOpenSearch } from './opensearch-fake/connection.js';

const silentLog = { info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {}, child: () => silentLog } as never;
const W: Weights = { text_relevance: 0.4, in_stock: 0.2, featured_offer: 0.1, delivery_speed: 0.1, rating: 0.1, conversion: 0.1 };
const q = (o: Partial<EngineQuery> = {}): EngineQuery => ({ text: null, filters: { inStockOnly: true }, marketTime: '14:30', ...o });
const FIELDS = [...TEXT_FIELDS];
const word = (w: string) => ({ multi_match: { query: w, type: 'cross_fields', operator: 'and', fields: FIELDS } });
const phrase = (p: string) => ({ multi_match: { query: p, type: 'phrase', fields: FIELDS } });
const inStock = { term: { 'offers.in_stock': true } };
const nestedOffers = (filters: object[]) => ({ nested: { path: 'offers', query: filters.length ? { bool: { filter: filters } } : { match_all: {} } } });

describe('text', () => {
  it('every group must match, any alternative of a group; phrases match as phrases', () => {
    expect(textQuery([['wireless'], ['earbuds', 'earphones', 'in-ear headphones']])).toEqual({
      bool: { must: [word('wireless'), { bool: { should: [word('earbuds'), word('earphones'), phrase('in-ear headphones')], minimum_should_match: 1 } }] },
    });
    expect(textQuery([])).toBeNull();
  });

  it('words or a GTIN; nothing when there are neither', () => {
    expect(textMatch(q({ text: { groups: [['lamp']], gtin: '04000000001052' } }))).toEqual({ bool: { should: [{ bool: { must: [word('lamp')] } }, { term: { gtins: '04000000001052' } }], minimum_should_match: 1 } });
    expect(textMatch(q({ text: { groups: [], gtin: '04000000001052' } }))).toEqual({ term: { gtins: '04000000001052' } });
    expect(textMatch(q({ text: { groups: [], gtin: null } }))).toEqual({ match_none: {} });
    expect(textMatch(q())).toBeNull();
  });
});

describe('filters', () => {
  const f = { inStockOnly: true, sellerIds: ['s1'], official: true, conditions: ['used' as const], priceMin: 100, priceMax: 900, freeDelivery: true, shipsToday: true, maxDispatchDays: 3 };

  it('offer conditions, each left out for its own facet', () => {
    expect(offerConds(f)).toEqual([
      { bool: { should: [{ terms: { 'offers.seller_id': ['s1'] } }, { term: { 'offers.official': true } }], minimum_should_match: 1 } },
      { terms: { 'offers.condition': ['used'] } },
      { range: { 'offers.price': { gte: 100, lte: 900 } } },
      inStock,
      { term: { 'offers.free_delivery': true } },
      { term: { 'offers.dispatch_days': 0 } },
      { range: { 'offers.dispatch_days': { lte: 3 } } },
    ]);
    expect(offerConds(f, 'seller')).toHaveLength(6);
    expect(offerConds(f, 'delivery')).toEqual([expect.anything(), expect.anything(), expect.anything(), inStock]);
    expect(offerConds({ inStockOnly: false, priceMax: 50 })).toEqual([{ range: { 'offers.price': { lte: 50 } } }]);
  });

  it('document filters with the card offer; facets leave one out', () => {
    const query = q({
      productIds: ['p1'],
      excludeProductIds: ['p2'],
      filters: { inStockOnly: true, categoryIds: ['c1'], brandIds: ['b1'], minRating: 4, onSale: true, listedSince: new Date('2026-10-01T00:00:00Z'), shipsToday: true, attributes: [{ key: 'color', values: ['White '] }] },
    });
    const cutoff = { bool: { should: [{ bool: { must_not: [{ exists: { field: 'same_day_cutoff' } }] } }, { range: { same_day_cutoff: { gt: '14:30:00' } } }], minimum_should_match: 1 } };
    expect(where(query)).toEqual([
      { terms: { product_id: ['p1'] } },
      { bool: { must_not: [{ terms: { product_id: ['p2'] } }] } },
      { terms: { category_path_ids: ['c1'] } },
      { terms: { brand_id: ['b1'] } },
      { range: { rating: { gte: 4 } } },
      { term: { on_sale: true } },
      { range: { first_listed_at: { gte: '2026-10-01T00:00:00.000Z' } } },
      cutoff,
      { nested: { path: 'attrs', query: { bool: { filter: [{ term: { 'attrs.k': 'color' } }, { terms: { 'attrs.vl': ['white'] } }] } } } },
      nestedOffers([inStock, { term: { 'offers.dispatch_days': 0 } }]),
    ]);
    expect(where(query, 'delivery')).not.toContainEqual(cutoff);
    expect(where(query, 'delivery').at(-1)).toEqual(nestedOffers([inStock]));
    expect(where(query, 'attr:color')).toHaveLength(9);
    expect(where(q({ productIds: [] }))[0]).toEqual({ match_none: {} });
  });
});

describe('search requests', () => {
  const cardOffer = (conds: object[]) => ({
    function_score: {
      query: {
        nested: {
          path: 'offers',
          score_mode: 'max',
          query: { function_score: { query: conds.length ? { bool: { filter: conds } } : { match_all: {} }, script_score: { script: { source: EO_KEY, params: { maxRank: EO_MAX_RANK } } }, boost_mode: 'replace' } },
          inner_hits: { name: 'eo', size: 1, sort: [{ 'offers.card_rank': { order: 'asc' } }] },
        },
      },
      script_score: { script: { source: EO_FACTORS, params: { w_in_stock: 0.2, w_delivery: 0.1 } } },
      boost_mode: 'replace',
    },
  });
  const docFactorsQ = { function_score: { query: { match_all: {} }, script_score: { script: { source: DOC_FACTORS, params: { w_featured: 0.1, w_rating: 0.1, w_conversion: 0.1, minRatings: 3 } } }, boost_mode: 'replace' } };

  it('recommended: filters, the card offer and the ranking policy as summed scores', () => {
    const query = q({ text: { groups: [['lamp']], gtin: null }, filters: { inStockOnly: true, brandIds: ['b1'] } });
    expect(searchBody(query, 'recommended', W, { offset: 20, limit: 10 })).toEqual({
      from: 20,
      size: 10,
      track_total_hits: true,
      query: {
        bool: {
          filter: [{ bool: { must: [word('lamp')] } }, { terms: { brand_id: ['b1'] } }],
          must: [cardOffer([inStock]), docFactorsQ],
          should: [{ function_score: { query: { bool: { must: [word('lamp')] } }, script_score: { script: { source: TEXT_RELEVANCE, params: { w: 0.4 } } }, boost_mode: 'replace' } }],
        },
      },
      sort: [{ _score: { order: 'desc' } }, { product_id: { order: 'asc' } }],
      _source: { excludes: ['category_text', 'attributes_text', 'description', 'attrs'] },
    });
  });

  it('a GTIN scores 1; field sorts keep scores for ties', () => {
    const body = searchBody(q({ text: { groups: [], gtin: '04000000001052' }, filters: { inStockOnly: false } }), 'rating', W, { offset: 0, limit: 5 });
    expect(body.track_scores).toBe(true);
    expect(body.query.bool.should).toEqual([{ constant_score: { filter: { term: { gtins: '04000000001052' } }, boost: 1 } }]);
    expect(body.query.bool.must[0]).toEqual(cardOffer([]));
    expect(body.sort).toEqual([{ rating: { order: 'desc', missing: '_last' } }, { rating_count: { order: 'desc' } }, { _score: { order: 'desc' } }, { product_id: { order: 'asc' } }]);
    expect(searchBody(q(), 'newest', W, { offset: 0, limit: 5 }).sort).toEqual([{ first_listed_at: { order: 'desc' } }, { product_id: { order: 'asc' } }]);
    expect(searchBody(q(), 'best_selling', W, { offset: 0, limit: 5 }).sort).toEqual([{ sales_30d: { order: 'desc' } }, { _score: { order: 'desc' } }, { product_id: { order: 'asc' } }]);
  });

  it('price sorts: one stream per card-offer tier, sorted by that tier`s lowest matching price', () => {
    const featured = { term: { 'offers.featured': true } };
    const sort = (filters: object[]) => ({ 'offers.price': { order: 'asc', mode: 'min', nested: { path: 'offers', filter: { bool: { filter: filters } } } } });
    // in stock required: featured, then in-stock offers (no out-of-stock tier)
    expect(priceStreams({ inStockOnly: true }, 'asc')).toEqual([
      { filter: nestedOffers([inStock, featured]), sort: sort([inStock, featured]) },
      { filter: { bool: { filter: [nestedOffers([inStock, inStock])], must_not: [nestedOffers([inStock, featured])] } }, sort: sort([inStock, inStock]) },
    ]);
    // out of stock included: a third tier, products whose matching offers are all out of stock
    const all = priceStreams({ inStockOnly: false, conditions: ['new'] }, 'desc');
    const cond = { terms: { 'offers.condition': ['new'] } };
    expect(all).toHaveLength(3);
    expect(all[2]).toEqual({
      filter: { bool: { filter: [nestedOffers([cond])], must_not: [nestedOffers([cond, featured]), nestedOffers([cond, inStock])] } },
      sort: { 'offers.price': { order: 'desc', mode: 'min', nested: { path: 'offers', filter: { bool: { filter: [cond] } } } } },
    });
    const bodies = priceStreamBodies(q(), 'asc', W, { offset: 10, limit: 5 });
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toMatchObject({ from: 0, size: 15, track_total_hits: true, track_scores: true, sort: [sort([inStock, featured]), { _score: { order: 'desc' } }, { product_id: { order: 'asc' } }] });
    expect(bodies[0]!.query.bool.filter).toEqual([nestedOffers([inStock, featured])]);
  });

  it('count and summary', () => {
    expect(countBody(q())).toEqual({ query: { bool: { filter: [nestedOffers([inStock])] } } });
    expect(summaryBody(q())).toEqual({
      size: 0,
      track_total_hits: true,
      query: { bool: { filter: [nestedOffers([inStock])] } },
      aggs: {
        offers: {
          nested: { path: 'offers' },
          aggs: { matching: { filter: { bool: { filter: [inStock] } }, aggs: { sellers: { cardinality: { field: 'offers.seller_key', precision_threshold: 40_000 } }, official: { filter: { term: { 'offers.official': true } } } } } },
        },
      },
    });
  });

  it('facets: one aggregation per facet, counted against the other filters', () => {
    const query = q({ text: { groups: [['lamp']], gtin: null }, filters: { inStockOnly: true, brandIds: ['b1'], sellerIds: ['s1'], attributes: [{ key: 'color', values: ['white'] }] } });
    const body = facetsBody(query, ['color', 'size']);
    expect(body.size).toBe(0);
    expect(body.query).toEqual({ bool: { filter: [{ bool: { must: [word('lamp')] } }] } });
    expect(Object.keys(body.aggs)).toEqual(['categories', 'brands', 'sellers', 'conditions', 'ratings', 'availability', 'delivery', 'attributes', 'attr:color']);
    const seller = { terms: { 'offers.seller_id': ['s1'] } };
    const attr = { nested: { path: 'attrs', query: { bool: { filter: [{ term: { 'attrs.k': 'color' } }, { terms: { 'attrs.vl': ['white'] } }] } } } };
    // the brand facet leaves the brand filter out, keeps the others
    expect(body.aggs.brands.filter).toEqual({ bool: { filter: [attr, nestedOffers([seller, inStock])] } });
    // the seller facet: offers matching every offer filter but the seller, products counted once
    expect(body.aggs.sellers).toEqual({
      filter: { bool: { filter: [{ terms: { brand_id: ['b1'] } }, attr, nestedOffers([inStock])] } },
      aggs: {
        o: {
          nested: { path: 'offers' },
          aggs: {
            m: {
              filter: { bool: { filter: [inStock] } },
              aggs: { v: { terms: { field: 'offers.seller_id', size: 10_000 }, aggs: { p: { reverse_nested: {} } } }, official: { filter: { term: { 'offers.official': true } } , aggs: { p: { reverse_nested: {} } } } },
            },
          },
        },
      },
    });
    // unfiltered attribute keys share one aggregation; a filtered key leaves its own filter out
    expect(body.aggs.attributes.aggs.a.aggs.k.filter).toEqual({ terms: { 'attrs.k': ['size'] } });
    expect(body.aggs['attr:color'].filter).toEqual({ bool: { filter: [{ terms: { brand_id: ['b1'] } }, nestedOffers([seller, inStock])] } });
    // price range: first product of each price stream, both directions, price filter left out
    const ranges = priceRangeBodies(q({ filters: { inStockOnly: true, priceMin: 500 } }));
    expect(ranges.map((r) => r.order)).toEqual(['asc', 'asc', 'desc', 'desc']);
    expect(ranges[0]!.body).toMatchObject({ size: 1, _source: false, query: { bool: { filter: [nestedOffers([inStock, { term: { 'offers.featured': true } }])] } } });
  });

  it('the scored query adds stream filters without changing the score', () => {
    const extra = { term: { on_sale: true } };
    const a = scoredQuery(q(), W);
    const b = scoredQuery(q(), W, [extra]);
    expect(b.bool.must).toEqual(a.bool.must);
    expect(b.bool.filter).toEqual([...a.bool.filter, extra]);
  });
});

describe('documents', () => {
  const doc = {
    product_id: 'p1',
    slug: 'lamp',
    title: 'Nordic desk lamp',
    brand_id: null,
    brand_name: null,
    category_id: 'c2',
    category_path_ids: ['c1', 'c2'],
    attributes: { color: ['White', 'Black'] },
    variant_count: 1,
    variant_options: [],
    image: null,
    seller_ids: ['s1'],
    has_official: true,
    conditions: ['new'],
    offer_count: 3,
    featured_offer_id: 'o3',
    featured_price: 3000,
    featured_seller_name: 'Official Store',
    featured_official: true,
    min_price: 2000,
    max_price: 3000,
    currency: 'USD',
    was_price: null,
    deal_ends_at: null,
    on_sale: false,
    gtins: [],
    variant_gtins: {},
    badges: [],
    in_stock: true,
    low_stock: false,
    free_delivery: false,
    fastest_dispatch_days: 1,
    same_day_cutoff: '9:05',
    rating: '4.5',
    rating_count: 12,
    sales_30d: 3,
    first_listed_at: new Date('2026-09-01T00:00:00Z'),
    popularity: '3',
    terms: null,
    title_norm: 'nordic desk lamp',
    version: 7,
    indexed_at: new Date('2026-10-01T00:00:00Z'),
    best_seller_rank: null,
    best_seller_category_id: null,
  } as unknown as DocRow;
  const offer = (id: string, price: number, inStock: boolean, sellerId: string | null): OfferRow =>
    ({ offer_id: id, product_id: 'p1', variant_id: 'v1', seller_id: sellerId, official: !sellerId, condition: 'new', price, in_stock: inStock, free_delivery: false, dispatch_days: 1, featured_eligible: true }) as OfferRow;
  const offers = [offer('o1', 2000, false, 's1'), offer('o2', 2500, true, 's1'), offer('o4', 2500, true, 's2'), offer('o3', 3000, true, null)];

  it('card order: featured, in stock, cheapest, offer id', () => {
    expect(cardOrder(doc, offers).map((o) => o.offer_id)).toEqual(['o3', 'o2', 'o4', 'o1']);
  });

  it('fields carry nested offers with card ranks and attributes; a full source adds the texts', () => {
    const f = fieldsOf(doc, offers) as any;
    expect(f.offers.map((o: any) => [o.offer_id, o.card_rank, o.featured, o.seller_key])).toEqual([
      ['o3', 0, true, 'official'],
      ['o2', 1, false, 's1'],
      ['o4', 2, false, 's2'],
      ['o1', 3, false, 's1'],
    ]);
    expect(f.attrs).toEqual([
      { k: 'color', v: 'White', vl: 'white' },
      { k: 'color', v: 'Black', vl: 'black' },
    ]);
    expect(f).toMatchObject({ version: 7, same_day_cutoff: '09:05:00', rating: 4.5, popularity: 3, first_listed_at: '2026-09-01T00:00:00.000Z' });
    expect(f).not.toHaveProperty('description');
    const full = sourceOf({ doc, offers, texts: { title: 'Nordic desk lamp', brand: '', category: 'Home Lighting', attributes: 'White Black', description: 'A lamp.' } }) as any;
    expect(full).toMatchObject({ title: 'Nordic desk lamp', category_text: 'Home Lighting', attributes_text: 'White Black', description: 'A lamp.' });
    // every mapped field is known to the mapping (dynamic: strict)
    const mapped = Object.keys(productIndexBody({ shards: 1, replicas: 0 }).mappings.properties);
    expect(Object.keys(full).filter((k) => !mapped.includes(k))).toEqual([]);
  });

  it('the read-model row comes back from _source', () => {
    const back = docOf(JSON.parse(JSON.stringify(sourceOf({ doc, offers }))));
    expect(back).toMatchObject({ product_id: 'p1', rating: '4.5', popularity: '3', same_day_cutoff: '09:05:00', attributes: { color: ['White', 'Black'] }, featured_offer_id: 'o3' });
    expect(back.first_listed_at).toEqual(new Date('2026-09-01T00:00:00Z'));
    expect(cutoffText('15:00:00')).toBe('15:00:00');
    expect(cutoffText(null)).toBeNull();
  });

  it('the mapping is versioned and strict', () => {
    const body = productIndexBody({ shards: 2, replicas: 1 });
    expect(body.mappings).toMatchObject({ dynamic: 'strict', _meta: { mappingVersion: MAPPING_VERSION } });
    expect(body.settings.index).toEqual({ number_of_shards: 2, number_of_replicas: 1, max_result_window: 10_000 });
    expect(body.settings.analysis.analyzer.text_en.filter).toEqual(['en_possessive', 'lowercase', 'asciifolding', 'en_stop', 'en_stem']);
    expect(body.mappings.properties.offers.type).toBe('nested');
  });
});

describe('scripts and their twins', () => {
  it('the card-offer key carries rank, stock and dispatch; the factors read it back', () => {
    const doc = (v: Record<string, unknown>) => (f: string) => (f in v ? [v[f] as never] : []);
    const key = SCRIPT_TWINS[EO_KEY]!.score!({ maxRank: EO_MAX_RANK }, doc({ 'offers.card_rank': 2, 'offers.dispatch_days': 3, 'offers.in_stock': true }), 0);
    expect(key).toBe((EO_MAX_RANK - 2) * 128 + 64 + 3);
    expect(Math.fround(key)).toBe(key);
    const factors = SCRIPT_TWINS[EO_FACTORS]!.score!({ w_in_stock: 0.2, w_delivery: 0.1 }, doc({}), key);
    expect(factors).toBeCloseTo(0.2 + 0.1 / 4, 10);
    expect(eoFactors({ w_in_stock: 0.2, w_delivery: 0.1 }, { inStock: false, dispatchDays: 0 })).toEqual({ in_stock: 0, delivery_speed: 0.1 });
    // a lower rank always wins the max
    const rank0 = SCRIPT_TWINS[EO_KEY]!.score!({ maxRank: EO_MAX_RANK }, doc({ 'offers.card_rank': 0, 'offers.dispatch_days': 63, 'offers.in_stock': false }), 0);
    expect(rank0).toBeGreaterThan(key);
  });

  it('document factors: featured, rating with enough reviews, conversion', () => {
    const w = { w_featured: 0.1, w_rating: 0.1, w_conversion: 0.1, minRatings: 3 };
    const f = docFactors(w, { featured: true, ratingCount: 12, rating: 4.5, popularity: 100 });
    expect(f.featured_offer).toBe(0.1);
    expect(f.rating).toBeCloseTo(0.09, 12);
    expect(f.conversion).toBeCloseTo(0.1, 12);
    expect(f.total).toBeCloseTo(0.29, 12);
    expect(docFactors(w, { featured: false, ratingCount: 2, rating: 5, popularity: 0 }).total).toBe(0);
  });

  it('versioned writes never put an older document back; partial writes keep the texts', () => {
    const run = (source: Record<string, unknown>, doc: Record<string, unknown>, full: boolean) => {
      const ctx = { _source: structuredClone(source), op: 'index' };
      SCRIPT_TWINS[VERSIONED_WRITE]!.update!({ doc, full }, ctx);
      return ctx;
    };
    expect(run({ version: 5, title: 'a', description: 'd' }, { version: 4, title: 'old' }, false)).toEqual({ _source: { version: 5, title: 'a', description: 'd' }, op: 'none' });
    expect(run({ version: 5, title: 'a', description: 'd' }, { version: 6, title: 'b' }, false)._source).toEqual({ version: 6, title: 'b', description: 'd' });
    expect(run({ version: 5, title: 'a', description: 'd' }, { version: 6, title: 'b' }, true)._source).toEqual({ version: 6, title: 'b' });
  });

  it('trigram similarity matches pg_trgm', () => {
    expect(similarity('word', 'words')).toBeCloseTo(4 / 7, 6);
    expect(similarity('headphnes', 'headphones')).toBeGreaterThan(0.5);
    expect(similarity('abc', '')).toBe(0);
  });
});

describe('configuration', () => {
  it('mongo by default; opensearch needs a URL; credentials are a username and password or an API key', () => {
    expect(readSearchEngineConfig({})).toEqual({ engine: 'mongo' });
    expect(readSearchEngineConfig({ SEARCH_ENGINE: 'opensearch', OPENSEARCH_URL: 'https://a:9200, https://b:9200', OPENSEARCH_USERNAME: 'u', OPENSEARCH_PASSWORD: 'p' })).toEqual({
      engine: 'opensearch',
      opensearch: { nodes: ['https://a:9200', 'https://b:9200'], auth: { username: 'u', password: 'p' }, indexPrefix: 'marketly', shards: 1, replicas: 1, refresh: 'false', requestTimeoutMs: 10_000, bulkAttempts: 3, aliasCacheMs: 5_000 },
    });
    expect(readSearchEngineConfig({ SEARCH_ENGINE: 'opensearch', OPENSEARCH_URL: 'http://x', OPENSEARCH_API_KEY: 'k', OPENSEARCH_INDEX_PREFIX: 'shop' })).toMatchObject({ opensearch: { auth: { apiKey: 'k' }, indexPrefix: 'shop' } });
    expect(() => readSearchEngineConfig({ SEARCH_ENGINE: 'opensearch' })).toThrow(/OPENSEARCH_URL/);
    expect(() => readSearchEngineConfig({ SEARCH_ENGINE: 'opensearch', OPENSEARCH_URL: 'http://x', OPENSEARCH_USERNAME: 'u' })).toThrow(/go together/);
    expect(() => readSearchEngineConfig({ SEARCH_ENGINE: 'elastic' })).toThrow(/SEARCH_ENGINE/);
    expect(() => readSearchEngineConfig({ SEARCH_ENGINE: 'opensearch', OPENSEARCH_URL: 'http://x', OPENSEARCH_INDEX_PREFIX: 'Bad Prefix' })).toThrow(/OPENSEARCH_INDEX_PREFIX/);
  });

  it('an API key is sent as an Authorization header; basic auth through the client', () => {
    const withKey = createOpenSearchClient(testOpenSearchConfig({ auth: { apiKey: 'secret' } }));
    expect((withKey as any).transport.headers.authorization).toBe('ApiKey secret');
  });
});

describe('requests on the wire', () => {
  it('the engine sends the translated bodies to the alias', async () => {
    const fake = new FakeOpenSearch();
    const cfg = testOpenSearchConfig();
    const os = new OsApi(createOpenSearchClient(cfg, fakeClientOptions(fake)));
    const log = silentLog;
    const index = new ProductIndex(os, { cfg, log });
    const engine = createOpenSearchEngine({ os, index, log, terms: { isTerm: async () => false, similarTermWords: async () => [], hasTermPrefix: async () => false }, repo: { terms: async () => [] }, termEngine: { suggestTerms: async () => [] } });
    const query = q({ text: { groups: [['lamp']], gtin: null } });
    expect(await engine.count(query)).toBe(0);
    const first = fake.requests.find((r) => r.path.startsWith('/test-products-'))!;
    expect(first).toMatchObject({ method: 'PUT', body: { aliases: { 'test-products': {} }, mappings: { _meta: { mappingVersion: MAPPING_VERSION } } } });
    expect(fake.requests.at(-1)).toEqual({ method: 'POST', path: '/test-products/_count', query: {}, body: countBody(query) });
    await engine.search(query, 'price_asc', W, { offset: 0, limit: 3 });
    const msearch = fake.requests.at(-1)!;
    expect(msearch.path).toBe('/_msearch');
    expect(msearch.body).toEqual(priceStreamBodies(query, 'asc', W, { offset: 0, limit: 3 }).flatMap((b) => [{ index: 'test-products' }, b]));
  });
});
