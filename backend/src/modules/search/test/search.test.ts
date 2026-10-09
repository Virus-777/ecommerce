/** Store search: results and cards, text matching, synonyms, spelling correction, filters, facets, sorts, paging, context. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN, boot, ean, shop, STORE, type Kit } from './helpers.js';

let k: Kit;
let s: Awaited<ReturnType<typeof shop>>;
beforeAll(async () => {
  k = await boot();
  s = await shop(k);
});
afterAll(async () => {
  await k?.close();
});

const ids = (body: any) => body.items.filter((h: any) => h.kind === 'organic').map((h: any) => h.product.productId);

describe('results and product cards', () => {
  it('finds products by words and shows the featured offer on the card', async () => {
    const r = await k.call('GET', `${STORE}/products?q=wireless+headphones`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(ids(r.body)).toEqual([s.wireless.id]);
    const hit = r.body.items[0];
    expect(hit).toMatchObject({ position: 1, kind: 'organic', slot: null, sponsored: null });
    expect(hit.product).toMatchObject({
      productId: s.wireless.id,
      slug: 'aurora-wireless-headphones',
      title: 'Aurora wireless headphones',
      brandName: 'Aurora',
      price: { amount: 18900, currency: 'USD' },
      priceIsFrom: false,
      offerId: s.officialOffer.id,
      sellerName: 'Official Store',
      official: true,
      rating: null,
      ratingCount: 0,
      availability: 'in_stock',
      offerCount: 3,
      variantCue: '2 colors',
      freeDelivery: true,
      badges: ['Official Store'],
    });
    expect(hit.product.deliveryCue).toMatch(/^Free delivery \w{3}, \w{3} \d+$/);
    expect(r.body.total).toBe(1);
  });

  it('stems words and searches brands, categories and attributes', async () => {
    expect(ids((await k.call('GET', `${STORE}/products?q=headphone`)).body)).toContain(s.wireless.id);
    expect(ids((await k.call('GET', `${STORE}/products?q=halcyon`)).body).sort()).toEqual([s.earphones.id, s.speaker.id].sort());
    expect(ids((await k.call('GET', `${STORE}/products?q=speakers`)).body)).toEqual([s.speaker.id]);
  });

  it('excludes out-of-stock products unless asked to include them', async () => {
    expect(ids((await k.call('GET', `${STORE}/products?q=lamp`)).body)).toEqual([]);
    const r = await k.call('GET', `${STORE}/products?q=lamp&availability=include_out_of_stock`);
    expect(ids(r.body)).toEqual([s.lamp.id]);
    expect(r.body.items[0].product.availability).toBe('out_of_stock');
  });

  it('matches a full GTIN in q', async () => {
    expect(ids((await k.call('GET', `${STORE}/products?q=${ean(103)}`)).body)).toEqual([s.earphones.id]);
  });

  it('pages with cursors and page numbers', async () => {
    const first = await k.call('GET', `${STORE}/products?category=electronics&limit=2`);
    expect(first.status).toBe(200);
    expect(first.body.items).toHaveLength(2);
    expect(first.body.total).toBe(3);
    const second = await k.call('GET', `${STORE}/products?category=electronics&limit=2&cursor=${first.body.nextCursor}`);
    expect(second.body.items).toHaveLength(1);
    expect(second.body.items[0].position).toBe(3);
    expect(second.body.nextCursor).toBeNull();
    const page2 = await k.call('GET', `${STORE}/products?category=electronics&limit=2&page=2`);
    expect(page2.body).toMatchObject({ page: 2, totalPages: 2, total: 3 });
  });

  it('sorts by price and refuses best selling without sales history', async () => {
    const asc = await k.call('GET', `${STORE}/products?category=electronics&sort=price_asc`);
    expect(asc.body.items.map((h: any) => h.product.price.amount)).toEqual([4900, 18900, 25900]);
    const desc = await k.call('GET', `${STORE}/products?category=electronics&sort=price_desc`);
    expect(desc.body.items.map((h: any) => h.product.price.amount)).toEqual([25900, 18900, 4900]);
    const best = await k.call('GET', `${STORE}/products?category=electronics&sort=best_selling`);
    expect(best.status).toBe(409);
    expect(best.body.error.code).toBe('SORT_NOT_AVAILABLE');
    const ctx = await k.call('GET', `${STORE}/facets?category=electronics&sort=best_selling`);
    expect(ctx.body.sorts.find((x: any) => x.key === 'best_selling')).toMatchObject({ available: false, selected: false });
    expect(ctx.body.sorts.find((x: any) => x.key === 'recommended')).toMatchObject({ available: true, selected: true });
  });
});

describe('offer-level filters', () => {
  it('Official Store filter shows the company offer at the price listed', async () => {
    const r = await k.call('GET', `${STORE}/products?q=headphones&seller=official`);
    expect(ids(r.body)).toEqual([s.wireless.id]);
    expect(r.body.items[0].product).toMatchObject({ offerId: s.officialOffer.id, price: { amount: 18900 }, priceIsFrom: false, official: true });
  });

  it('a seller filter shows that seller offer; a condition filter its matching offer', async () => {
    const bySeller = await k.call('GET', `${STORE}/products?q=aurora&seller=gadget-grove`);
    expect(bySeller.body.items[0].product).toMatchObject({ offerId: s.groveOffer.id, price: { amount: 17900 }, sellerName: 'Gadget Grove', priceIsFrom: false, official: false });
    const used = await k.call('GET', `${STORE}/products?q=aurora&condition=used`);
    expect(used.body.items[0].product).toMatchObject({ offerId: s.usedOffer.id, price: { amount: 9900 }, condition: 'used', sellerName: 'Casa Verde' });
    const unknown = await k.call('GET', `${STORE}/products?seller=no-such-store`);
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toMatchObject({ code: 'INVALID_FILTER', details: { filter: 'seller' } });
  });

  it('price range applies to offers: the card names the cheapest matching offer as a from price', async () => {
    const r = await k.call('GET', `${STORE}/products?q=aurora&priceMax=18000`);
    expect(r.body.items[0].product).toMatchObject({ offerId: s.usedOffer.id, price: { amount: 9900 }, priceIsFrom: true, sellerName: 'Casa Verde' });
    expect((await k.call('GET', `${STORE}/products?priceMin=30000`)).body.items).toEqual([]);
    const bad = await k.call('GET', `${STORE}/products?priceMin=500&priceMax=100`);
    expect(bad.body.error).toMatchObject({ code: 'INVALID_FILTER', details: { filter: 'priceMin' } });
  });

  it('free delivery, brand and attribute filters', async () => {
    expect(ids((await k.call('GET', `${STORE}/products?category=headphones&delivery=free`)).body).sort()).toEqual([s.wireless.id, s.earphones.id].sort());
    expect(ids((await k.call('GET', `${STORE}/products?brand=halcyon`)).body).sort()).toEqual([s.earphones.id, s.speaker.id].sort());
    expect(ids((await k.call('GET', `${STORE}/products?brand=${s.aurora.id}`)).body)).toEqual([s.wireless.id]);
    const anc = await k.call('GET', `${STORE}/products?category=headphones&attrs=noise_cancelling:active`);
    expect(ids(anc.body)).toEqual([s.wireless.id]);
    const white = await k.call('GET', `${STORE}/products?category=headphones&attrs=color:White`);
    expect(ids(white.body)).toEqual([s.wireless.id]);
    expect(white.body.items[0].product).toMatchObject({ variantId: s.wireless.variants[1]!.id, variantCue: 'White' });
    const badKey = await k.call('GET', `${STORE}/products?category=headphones&attrs=wattage:20`);
    expect(badKey.body.error).toMatchObject({ code: 'INVALID_FILTER', details: { filter: 'wattage' } });
    const badValue = await k.call('GET', `${STORE}/products?category=headphones&attrs=color:Purple`);
    expect(badValue.body.error).toMatchObject({ code: 'INVALID_FILTER', details: { filter: 'color' } });
    const badCategory = await k.call('GET', `${STORE}/products?category=nowhere`);
    expect(badCategory.body.error).toMatchObject({ code: 'INVALID_FILTER', details: { filter: 'category' } });
  });
});

describe('search context', () => {
  it('total, applied filters with removal queries, facets counted against the other filters', async () => {
    const r = await k.call('GET', `${STORE}/facets?category=headphones&brand=aurora&condition=new`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const c = r.body;
    expect(c.total).toBe(1);
    expect(c.totalLabel).toBe('1 result from 2 sellers, including the Official Store');
    expect(c.appliedFilters).toEqual([
      { key: 'brand', value: 'aurora', label: 'Aurora', removeQuery: 'category=headphones&condition=new' },
      { key: 'condition', value: 'new', label: 'New', removeQuery: 'category=headphones&brand=aurora' },
    ]);
    expect(c.clearAllQuery).toBe('category=headphones');
    const facet = (key: string) => c.facets.find((f: any) => f.key === key);
    // brand counts ignore the brand filter itself
    expect(facet('brand').values).toEqual(
      expect.arrayContaining([expect.objectContaining({ value: s.aurora.id, label: 'Aurora', count: 1, selected: true }), expect.objectContaining({ value: s.halcyon.id, label: 'Halcyon', count: 1, selected: false })]),
    );
    expect(facet('condition').values).toEqual([
      { value: 'new', label: 'New', count: 1, selected: true },
      { value: 'used', label: 'Used', count: 1, selected: false },
      { value: 'refurbished', label: 'Refurbished', count: 0, selected: false },
    ]);
    expect(facet('seller').values[0]).toMatchObject({ value: 'official', label: 'Official Store', count: 1, note: 'Shows company offers at the prices listed' });
    expect(facet('price').range).toMatchObject({ min: { amount: 18900 }, max: { amount: 18900 } });
    const anc = facet('noise_cancelling');
    expect(anc).toMatchObject({ group: 'category', groupLabel: 'Headphones features', kind: 'attribute', label: 'Noise cancelling' });
    expect(anc.values).toEqual([{ value: 'Active', label: 'Active', count: 1, selected: false }]);
    expect(c.facets.slice(0, 8).map((f: any) => f.key)).toEqual(['category', 'price', 'brand', 'rating', 'seller', 'condition', 'availability', 'delivery']);
    expect(c.category).toMatchObject({
      category: { id: s.headphones.id, name: 'Headphones', slug: 'headphones' },
      breadcrumb: [{ slug: 'electronics' }, { slug: 'headphones' }],
      subcategories: [],
      sellerCount: 2,
    });
    expect(c.fromPriceNote).toBeTruthy();
    expect(c.rankingNote).toMatch(/Sponsored items are paid placements and are labeled/);
    expect(c.emptyGuidance).toBeNull();
  });

  it('category listing: subcategories with counts; the category is the page, not a filter', async () => {
    const c = (await k.call('GET', `${STORE}/facets?category=electronics`)).body;
    expect(c.appliedFilters).toEqual([]);
    expect(c.category.subcategories).toEqual([
      { id: s.headphones.id, name: 'Headphones', slug: 'headphones', count: 2, comingSoon: false },
      { id: s.speakers.id, name: 'Speakers', slug: 'speakers', count: 1, comingSoon: false },
    ]);
    expect(c.facets.find((f: any) => f.key === 'category').values.map((v: any) => [v.value, v.count])).toEqual([
      ['headphones', 2],
      ['speakers', 1],
    ]);
  });

  it('spelling correction: showing results for … / search instead for …', async () => {
    const c = (await k.call('GET', `${STORE}/facets?q=wireles+headphnes`)).body;
    expect(c.query).toEqual({ raw: 'wireles headphnes', normalized: 'wireles headphnes', correctedTo: 'wireless headphones', correctionApplied: true, searchInsteadFor: 'wireles headphnes' });
    expect(c.total).toBe(1);
    expect(ids((await k.call('GET', `${STORE}/products?q=wireles+headphnes`)).body)).toEqual([s.wireless.id]);
    const exact = (await k.call('GET', `${STORE}/facets?q=wireles+headphnes&exact=true`)).body;
    expect(exact.query.correctionApplied).toBe(false);
    expect(exact.total).toBe(0);
    expect(exact.emptyGuidance).toMatchObject({ title: 'No results for "wireles headphnes"', removableFilters: [], clearAllCount: null });
    expect(exact.emptyGuidance.tips.length).toBeGreaterThan(0);
    expect(exact.emptyGuidance.popular.length).toBeGreaterThan(0);
  });

  it('empty guidance lists each filter with the count it gives when removed', async () => {
    const c = (await k.call('GET', `${STORE}/facets?q=headphones&brand=halcyon&condition=used`)).body;
    expect(c.total).toBe(0);
    expect(c.emptyGuidance.title).toBe('Nothing matches all your filters');
    expect(c.emptyGuidance.removableFilters).toEqual([
      { filter: expect.objectContaining({ key: 'brand', value: 'halcyon', label: 'Halcyon' }), resultCount: 1 },
      { filter: expect.objectContaining({ key: 'condition', value: 'used' }), resultCount: 1 },
    ]);
    expect(c.emptyGuidance.clearAllCount).toBe(2);
    expect(c.emptyGuidance.nearbyCategories).toEqual([expect.objectContaining({ id: s.headphones.id, count: 2 })]);
  });

  it('store match: a seller name gives a store card, never product results', async () => {
    const c = (await k.call('GET', `${STORE}/facets?q=gadget+grove`)).body;
    expect(c.storeMatch).toMatchObject({ sellerId: s.grove.id, name: 'Gadget Grove', slug: 'gadget-grove', verified: true, official: false, positivePct: 98, ratingCount: 120, productCount: 2, location: 'Austin, TX', note: 'Stores are listed here, not mixed into product results.' });
  });
});

describe('synonyms', () => {
  it('a new synonym set takes effect on the next query (no reindex)', async () => {
    expect(ids((await k.call('GET', `${STORE}/products?q=earbuds&exact=true`)).body)).toEqual([]);
    const created = await k.call('POST', `${ADMIN}/synonyms`, k.staff, { terms: ['earbuds', 'earphones', 'In-ear headphones'], kind: 'equivalent' });
    expect(created.status).toBe(201);
    expect(ids((await k.call('GET', `${STORE}/products?q=earbuds`)).body)).toEqual([s.earphones.id]);
    const off = await k.call('PATCH', `${ADMIN}/synonyms/${created.body.id}`, k.staff, { terms: ['earbuds', 'earphones', 'in-ear headphones'], kind: 'equivalent', active: false });
    expect(off.body.active).toBe(false);
    expect(ids((await k.call('GET', `${STORE}/products?q=earbuds&exact=true`)).body)).toEqual([]);
  });

  it('one-way synonyms expand only from their source term', async () => {
    await k.call('POST', `${ADMIN}/synonyms`, k.staff, { terms: ['speaker'], kind: 'one_way', from: 'hifi' });
    expect(ids((await k.call('GET', `${STORE}/products?q=hifi`)).body)).toEqual([s.speaker.id]);
    expect(ids((await k.call('GET', `${STORE}/products?q=speaker`)).body)).toEqual([s.speaker.id]);
  });
});

describe('ranking policy', () => {
  it('serves the default policy, then a published version', async () => {
    const def = await k.call('GET', `${STORE}/ranking-policy`);
    expect(def.body).toMatchObject({ version: 1, publishedBy: { kind: 'system' } });
    expect(def.body.factors.map((f: any) => f.key)).toContain('text_relevance');
    const published = await k.call('POST', `${ADMIN}/ranking-policies`, k.staff, {
      text: 'Relevance first, then price.',
      factors: [
        { key: 'text_relevance', label: 'Relevance', weight: 1 },
        { key: 'in_stock', label: 'In stock', weight: 0.5 },
      ],
      effectiveFrom: new Date(Date.now() - 1000).toISOString(),
      reason: 'Simpler policy',
    });
    expect(published.status).toBe(201);
    expect(published.body).toMatchObject({ version: 2, text: 'Relevance first, then price.', publishedBy: { kind: 'staff' } });
    expect(k.of('search.ranking_policy.published')).toEqual([{ version: 2, effectiveFrom: published.body.effectiveFrom }]);
    expect((await k.call('GET', `${STORE}/ranking-policy`)).body.version).toBe(2);
    const bad = await k.call('POST', `${ADMIN}/ranking-policies`, k.staff, { text: 'x', factors: [{ key: 'vibes', label: 'Vibes', weight: 1 }], effectiveFrom: new Date().toISOString(), reason: 'r' });
    expect(bad.status).toBe(400);
    // results still rank and search keeps working under the new weights
    expect(ids((await k.call('GET', `${STORE}/products?q=headphones`)).body)).toEqual([s.wireless.id, s.earphones.id]);
  });
});
