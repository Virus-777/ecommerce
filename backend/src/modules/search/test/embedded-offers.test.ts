/**
 * Search documents keep their offers (docs/07-search-speed-plan.md):
 * - the embedded offers stay equal to the offer rows through every repository write, and the full sync rebuilds them;
 * - the engine's pipeline over embedded offers picks exactly what the earlier join over search_offers picked: the same
 *   documents, matching-offer counts and card offers, for random filters and every facet's "leave my filter out".
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { spec } from '../../../spec/search.js';
import { DEFAULT_FACTORS, weightsOf } from '../domain/ranking.js';
import { base, createMongoSearchEngine, scoreStages } from '../mongo-engine.js';
import type { DocRow, DocWrite, EngineFilters, EngineQuery, FacetOmit, OfferRow } from '../ports.js';
import { SearchRepository } from '../repository.js';
import { schemas } from '../schema.js';
import { createMongoTermLookup } from '../terms.js';
import { boot, shop, type Kit } from './helpers.js';

let k: Kit;
const store = () => k.app.kernel.mongo.module('search', spec.collections, schemas);
const repo = () => new SearchRepository(store());
const docsTable = () => store().table<DocRow>('search_documents');
const offersTable = () => store().table<OfferRow>('search_offers');

beforeAll(async () => {
  k = await boot();
  await shop(k);
});
afterAll(async () => {
  await k?.close();
});

/** Every document's embedded offers, and what the offer rows say they should be */
async function embeddedVsRows() {
  const docs = await docsTable().aggregate<{ _id: string; offers: unknown[] | null }>([{ $project: { offers: 1 } }]);
  const rows = await offersTable().find();
  const expected = (id: string) =>
    rows
      .filter((r) => r.product_id === id)
      .map((r) => ({ _id: r.offer_id, variant_id: r.variant_id, seller_id: r.seller_id ?? null, official: r.official, condition: r.condition, price: Number(r.price), in_stock: r.in_stock, free_delivery: r.free_delivery, dispatch_days: Number(r.dispatch_days), featured_eligible: r.featured_eligible }))
      .sort((a, b) => (a._id < b._id ? -1 : 1));
  return docs.map((d) => ({ id: d._id, actual: d.offers ?? [], expected: expected(d._id) }));
}
const expectInStep = async () => {
  for (const d of await embeddedVsRows()) expect(d.actual, d.id).toEqual(d.expected);
};

const offer = (productId: string, o: Partial<OfferRow> = {}): OfferRow => ({ offer_id: newId(), product_id: productId, variant_id: newId(), seller_id: null, official: true, condition: 'new', price: 1000, in_stock: true, free_delivery: false, dispatch_days: 1, featured_eligible: true, ...o });

describe('embedded offers', () => {
  it('stay equal to the offer rows through every repository write', async () => {
    await expectInStep(); // the shop, indexed through the service
    const [a, b] = (await docsTable().find()).slice(0, 2) as [DocRow, DocRow];
    const r = repo();
    const extra = offer(a.product_id, { price: 777, official: false, seller_id: newId() });
    await r.upsertOfferRow(extra);
    await expectInStep();
    await r.updateOfferRow(extra.offer_id, { price: 555, in_stock: false });
    await expectInStep();
    // an offer moved to another product, by upsert and by a rebuilt document
    await r.upsertOfferRow({ ...extra, product_id: b.product_id });
    await expectInStep();
    const { terms: _t, version: _v, indexed_at: _i, offers: _o, ...rest } = (await docsTable().get(a.product_id))!;
    const write = { ...rest, texts: { title: a.title, brand: a.brand_name ?? '', category: '', attributes: '', description: '' } } as unknown as DocWrite;
    await r.upsertDocument(write, [...(await r.offerRows([a.product_id])), { ...extra, product_id: a.product_id }], new Date());
    await expectInStep();
    await r.deleteOfferRow(extra.offer_id);
    await expectInStep();
    // null keeps the offers
    await r.upsertDocument(write, null, new Date());
    await expectInStep();
    // inside a transaction
    await r.transaction(async (tx) => {
      await tx.updateOfferRow((await tx.offerRows([b.product_id]))[0]!.offer_id, { price: 4321 });
    });
    await expectInStep();
  });

  it('are rebuilt for every document by the full sync (migration and after each start)', async () => {
    await docsTable().updateMany({}, { $set: { offers: null } });
    expect((await embeddedVsRows()).some((d) => d.expected.length && !d.actual.length)).toBe(true);
    await repo().embedAllOffers();
    await expectInStep();
  });
});

/* ------------------------------------------------------------------ the earlier pipeline, as the reference */

function refOfferMatch(f: EngineFilters, omit?: FacetOmit): Record<string, unknown> {
  const c: Record<string, unknown>[] = [];
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
/** The earlier base(): the document conditions of the new one, then the join over search_offers */
function refBase(q: EngineQuery, omit?: FacetOmit): Record<string, unknown>[] {
  const [first, , cards] = base(q, omit) as [{ $match: { $and?: unknown[] } & Record<string, unknown> }, unknown, Record<string, unknown>];
  // the new $match is {$and: [docConditions, offerCondition]} or only the offer condition: keep the document part
  const docPart = first.$match.$and ? (first.$match.$and[0] as Record<string, unknown>) : {};
  return [
    { $match: docPart },
    { $lookup: { from: 'search.search_offers', localField: '_id', foreignField: 'product_id', pipeline: [{ $match: refOfferMatch(q.filters, omit) }], as: 'm' } },
    { $match: { 'm.0': { $exists: true } } },
    cards,
  ];
}

describe('the pipeline over embedded offers', () => {
  const sellers = [newId(), newId(), newId()];
  let s = 7;
  const rnd = () => (s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const pick = <T>(a: readonly T[]) => a[Math.floor(rnd() * a.length)]!;
  /** Random offer and document filters over the comparison catalog */
  const randomFilters = (): EngineFilters => {
    const f: EngineFilters = { inStockOnly: rnd() > 0.5 };
    if (rnd() > 0.6) f.sellerIds = [pick(sellers)];
    if (rnd() > 0.8) f.official = true;
    if (rnd() > 0.6) f.conditions = [pick(['new', 'used', 'refurbished'] as const)];
    if (rnd() > 0.6) f.priceMin = 500 + Math.floor(rnd() * 10) * 250;
    if (rnd() > 0.6) f.priceMax = 2000 + Math.floor(rnd() * 10) * 250;
    if (rnd() > 0.7) f.freeDelivery = true;
    if (rnd() > 0.8) f.shipsToday = true;
    if (rnd() > 0.8) f.maxDispatchDays = Math.floor(rnd() * 3);
    if (rnd() > 0.8) f.minRating = 1 + Math.floor(rnd() * 4);
    return f;
  };

  it('gives the same documents, matching offers and card offers as the join it replaces', async () => {
    // a varied catalog: 120 products with 1-4 offers each across sellers, conditions, prices, stock and delivery
    const template = (await docsTable().find())[0]!;
    const { terms: _t, version: _v, indexed_at: _i, offers: _o, ...rest } = template;
    for (let i = 0; i < 120; i++) {
      const id = newId();
      const offers = Array.from({ length: 1 + Math.floor(rnd() * 4) }, (_, j) =>
        offer(id, { official: j === 0 && rnd() > 0.5, seller_id: j === 0 && rnd() > 0.5 ? null : pick(sellers), condition: pick(['new', 'used', 'refurbished']), price: 500 + Math.floor(rnd() * 20) * 250, in_stock: rnd() > 0.3, free_delivery: rnd() > 0.5, dispatch_days: Math.floor(rnd() * 4) }),
      );
      const write = { ...rest, product_id: id, slug: `cmp-${i}`, rating: 1 + Math.floor(rnd() * 5), featured_offer_id: rnd() > 0.3 ? offers[0]!.offer_id : null, texts: { title: `Compare ${i}`, brand: '', category: '', attributes: '', description: '' } } as unknown as DocWrite;
      await repo().upsertDocument(write, offers, new Date());
    }

    const project = { $project: { _id: 1, matching: 1, eo: { _id: 1, variant_id: 1, seller_id: 1, official: 1, condition: 1, price: 1, in_stock: 1, free_delivery: 1, dispatch_days: 1, featured: 1 } } };
    const run = (stages: Record<string, unknown>[]) => docsTable().aggregate([...stages, project, { $sort: { _id: 1 } }]);
    const omits: (FacetOmit | undefined)[] = [undefined, 'seller', 'price', 'condition', 'availability', 'delivery'];
    let compared = 0;
    for (let n = 0; n < 60; n++) {
      const f = randomFilters();
      const q: EngineQuery = { text: null, filters: f, marketTime: '12:00' };
      for (const omit of omits) {
        const [expected, actual] = await Promise.all([run(refBase(q, omit)), run(base(q, omit) as Record<string, unknown>[])]);
        expect(actual, JSON.stringify({ f, omit })).toEqual(expected);
        compared += expected.length;
      }
    }
    expect(compared).toBeGreaterThan(1000);
  });

  it('counts each filter value as the results that filter would give with the others kept (facets in shared passes, price ranges in one)', async () => {
    const engine = createMongoSearchEngine(store(), createMongoTermLookup(store()));
    const count = (filters: EngineFilters) => engine.count({ text: null, filters, marketTime: '12:00' });
    for (let n = 0; n < 25; n++) {
      const f = randomFilters();
      const q: EngineQuery = { text: null, filters: f, marketTime: '12:00' };
      const c = await engine.facets(q, []);
      const label = JSON.stringify(f);
      const { sellerIds: _s, official: _o, ...noSeller } = f;
      for (const [sellerId, n2] of c.sellers) expect(n2, `${label} seller`).toBe(await count({ ...noSeller, sellerIds: [sellerId] }));
      expect(c.official, `${label} official`).toBe(await count({ ...noSeller, official: true }));
      for (const [cond, n2] of c.conditions) expect(n2, `${label} condition`).toBe(await count({ ...f, conditions: [cond as never] }));
      for (const [r, n2] of c.ratings) expect(n2, `${label} rating`).toBe(await count({ ...f, minRating: r }));
      // "In stock" counts products whose card offer is in stock; the card prefers the featured offer even when it is
      // out of stock, so this can be below what the in-stock filter returns (a product with an out-of-stock featured
      // offer and another offer in stock). Known difference, kept as it is: products whose card offer is in stock
      const { inStockOnly: _is, ...noStock } = f;
      const cards = await docsTable().aggregate<{ n: number }>([...(base({ text: null, filters: { ...noStock, inStockOnly: false }, marketTime: '12:00' }) as Record<string, unknown>[]), { $match: { 'eo.in_stock': true } }, { $count: 'n' }]);
      expect(c.inStock, `${label} in stock`).toBe(cards[0]?.n ?? 0);
      expect(c.inStock, `${label} in stock`).toBeLessThanOrEqual(await count({ ...f, inStockOnly: true }));
      expect(c.includingOutOfStock, `${label} all`).toBe(await count({ ...f, inStockOnly: false }));
      const { freeDelivery: _fd, shipsToday: _st, maxDispatchDays: _md, ...noDelivery } = f;
      expect(c.freeDelivery, `${label} free delivery`).toBe(await count({ ...noDelivery, freeDelivery: true }));
      expect(c.shipsToday, `${label} ships today`).toBe(await count({ ...noDelivery, shipsToday: true }));
      for (const b of c.brands) expect(b.count, `${label} brand`).toBe(await count({ ...f, brandIds: [b.id] }));
      for (const [cat, n2] of c.categories) expect(n2, `${label} category`).toBe(await count({ ...f, categoryIds: [cat] }));

      const ranges = [
        { min: null, max: 999 },
        { min: 1000, max: 2499 },
        { min: 2500, max: null },
      ];
      const { priceMin: _a, priceMax: _b, ...noPrice } = f;
      const expected = await Promise.all(ranges.map((r) => count({ ...noPrice, ...(r.min !== null ? { priceMin: r.min } : {}), ...(r.max !== null ? { priceMax: r.max } : {}) })));
      expect(await engine.priceRangeCounts!(q, ranges), `${label} price ranges`).toEqual(expected);
    }
  });
});

/* ------------------------------------------------------------------ step 5: stored card offers and listing ranks */

describe('stored card offers and listing ranks', () => {
  type Off = { _id: string; in_stock: boolean; price: number };
  /** The card offer rule (cards.ts) in plain code: featured first, then in stock, cheapest, offer id */
  const cardOfList = (offers: Off[], featured: string | null) =>
    [...offers].sort((a, b) => Number(b._id === featured) - Number(a._id === featured) || Number(b.in_stock) - Number(a.in_stock) || a.price - b.price || (a._id < b._id ? -1 : a._id > b._id ? 1 : 0))[0];
  const expectCardsInStep = async () => {
    const docs = await docsTable().aggregate<any>([{ $project: { offers: 1, featured_offer_id: 1, card_all: 1, card_all_n: 1, card_in_stock: 1, card_in_stock_n: 1 } }]);
    for (const d of docs) {
      const offers = (d.offers ?? []) as Off[];
      const stock = offers.filter((o) => o.in_stock);
      expect(d.card_all?._id ?? null, `${d._id} card_all`).toBe(cardOfList(offers, d.featured_offer_id ?? null)?._id ?? null);
      expect(d.card_in_stock?._id ?? null, `${d._id} card_in_stock`).toBe(cardOfList(stock, d.featured_offer_id ?? null)?._id ?? null);
      expect(d.card_all_n, `${d._id} card_all_n`).toBe(offers.length);
      expect(d.card_in_stock_n, `${d._id} card_in_stock_n`).toBe(stock.length);
      if (d.card_all) expect(d.card_all.featured).toBe(d.card_all._id === (d.featured_offer_id ?? null));
    }
  };

  const weights = weightsOf(DEFAULT_FACTORS);
  let category = '';
  const sellers = [newId(), newId()];
  let s = 23;
  const rnd = () => (s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;

  it('stay equal to the rule through every write, including a change of featured offer', async () => {
    const template = (await docsTable().find())[0]!;
    category = template.category_path_ids[0]!;
    const { terms: _t, version: _v, indexed_at: _i, offers: _o, ...rest } = template;
    for (let i = 0; i < 150; i++) {
      const id = newId();
      const offers = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () =>
        offer(id, { official: rnd() > 0.5, seller_id: rnd() > 0.5 ? null : sellers[Math.floor(rnd() * 2)]!, price: 500 + Math.floor(rnd() * 10) * 250, in_stock: rnd() > 0.35, dispatch_days: Math.floor(rnd() * 4) }),
      );
      const write = {
        ...rest,
        product_id: id,
        slug: `rank-${i}`,
        brand_id: rnd() > 0.5 ? template.brand_id : newId(),
        rating: 1 + Math.floor(rnd() * 5),
        rating_count: Math.floor(rnd() * 6),
        popularity: String(Math.floor(rnd() * 50)),
        featured_offer_id: rnd() > 0.25 ? offers[0]!.offer_id : null,
        texts: { title: `Ranked ${i}`, brand: '', category: '', attributes: '', description: '' },
      } as unknown as DocWrite;
      await repo().upsertDocument(write, offers, new Date());
    }
    await expectCardsInStep();
    const [a] = await docsTable().find({ product_id: { $in: (await docsTable().find()).map((d) => d.product_id) } }, { limit: 1 });
    const rows = await repo().offerRows([a!.product_id]);
    await repo().updateOfferRow(rows[0]!.offer_id, { in_stock: false, price: 99999 });
    await repo().updateDocument(a!.product_id, { featured_offer_id: rows.at(-1)!.offer_id }, new Date());
    await repo().upsertOfferRow(offer(a!.product_id, { price: 1, in_stock: true }));
    await expectCardsInStep();
    // every write leaves the changed document's rank stale
    expect((await docsTable().get(a!.product_id))!.rank_key).toBeNull();
    await docsTable().updateMany({}, { $set: { card_all: null, card_in_stock: null, card_all_n: null, card_in_stock_n: null } });
    await repo().embedAllOffers();
    await expectCardsInStep();
  });

  it('give a listing exactly the order of the computed recommended score, before and after products change', async () => {
    const engine = createMongoSearchEngine(store(), createMongoTermLookup(store()));
    const project = { $project: { _id: 1 } };
    // the reference: the earlier join, the score computed for every document, sorted
    const reference = async (q: EngineQuery, offset: number, limit: number) =>
      (await docsTable().aggregate<{ _id: string }>([...refBase(q), ...(scoreStages(q, weights) as Record<string, unknown>[]), { $sort: { score: -1, _id: 1 } }, { $skip: offset }, { $limit: limit }, project])).map((d) => d._id);
    const listing = async (q: EngineQuery, offset: number, limit: number) => (await engine.search(q, 'recommended', weights, { offset, limit })).hits.map((h) => h.doc.product_id);
    const queries: EngineQuery[] = [
      { text: null, filters: { inStockOnly: true, categoryIds: [category] }, marketTime: '12:00' },
      { text: null, filters: { inStockOnly: false, categoryIds: [category] }, marketTime: '12:00' },
      { text: null, filters: { inStockOnly: true, categoryIds: [category], minRating: 3 }, marketTime: '12:00' },
      { text: null, filters: { inStockOnly: true }, marketTime: '12:00' },
    ];
    const compare = async () => {
      for (const q of queries) for (const [offset, limit] of [[0, 24], [24, 24], [0, 500]] as const) expect(await listing(q, offset, limit), JSON.stringify({ q: q.filters, offset })).toEqual(await reference(q, offset, limit));
    };
    await compare();
    expect(await docsTable().count({ rank_key: null })).toBe(0);
    // products change: their ranks go stale and the next listing brings them back in order
    const ids = (await docsTable().find({}, { limit: 20 })).map((d) => d.product_id);
    for (const [i, id] of ids.entries()) {
      const rows = await repo().offerRows([id]);
      if (rows[0]) await repo().updateOfferRow(rows[0].offer_id, { in_stock: i % 2 === 0, dispatch_days: i % 4 });
      await repo().updateDocument(id, { rating: String(1 + (i % 5)), rating_count: 3 + (i % 3) }, new Date());
    }
    await repo().recordSales('2026-10-20', ids.slice(0, 5).map((productId) => ({ productId, units: 7 })), 1, new Date());
    expect(await docsTable().count({ rank_key: null })).toBeGreaterThan(0);
    await compare();
    // new weights: every rank is recomputed
    const other = { ...weights, rating: 0.5, conversion: 0 };
    const q = queries[0]!;
    expect((await engine.search(q, 'recommended', other, { offset: 0, limit: 50 })).hits.map((h) => h.doc.product_id)).toEqual(
      (await docsTable().aggregate<{ _id: string }>([...refBase(q), ...(scoreStages(q, other) as Record<string, unknown>[]), { $sort: { score: -1, _id: 1 } }, { $limit: 50 }, project])).map((d) => d._id),
    );
  });

  it('keep filter counts per query for the cache window only, computing each once even when asked at the same time', async () => {
    const q: EngineQuery = { text: null, filters: { inStockOnly: true, categoryIds: [category] }, marketTime: '12:00' };
    const withCache = createMongoSearchEngine(store(), createMongoTermLookup(store()), { facetCacheMs: 60_000 });
    const without = createMongoSearchEngine(store(), createMongoTermLookup(store()));
    const [a, b] = await Promise.all([withCache.facets(q, []), withCache.facets(q, [])]);
    expect(b).toBe(a);
    const before = await without.summary(q);
    // a product leaves the listing: the cached counts stay for their window, uncached ones see it at once
    const gone = (await docsTable().find({ category_path_ids: category, card_in_stock: { $ne: null } }, { limit: 1 }))[0]!;
    const cachedSummary = await withCache.summary(q);
    for (const r of await repo().offerRows([gone.product_id])) await repo().updateOfferRow(r.offer_id, { in_stock: false });
    expect(await withCache.summary(q)).toBe(cachedSummary);
    expect(cachedSummary.total).toBe(before.total);
    expect((await without.summary(q)).total).toBe(before.total - 1);
    // another query is its own entry
    expect(await withCache.facets({ ...q, filters: { ...q.filters, minRating: 4 } }, [])).not.toBe(a);
  });
});
