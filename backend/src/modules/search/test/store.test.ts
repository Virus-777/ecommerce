/** Store extras: suggestions, recent searches, sponsored hits, cards, similar products, barcodes and clicks. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auth, boot, callers, ean, newId, shop, STORE, type Kit } from './helpers.js';

let k: Kit;
let s: Awaited<ReturnType<typeof shop>>;
beforeAll(async () => {
  k = await boot();
  s = await shop(k);
});
afterAll(async () => {
  await k?.close();
});

describe('suggestions while typing', () => {
  it('queries, categories, brands, stores and products, tolerating misspellings', async () => {
    // popular queries come from searches that found something
    for (let i = 0; i < 3; i++) await k.call('GET', `${STORE}/facets?q=wireless+headphones`);
    await k.call('GET', `${STORE}/facets?q=nothing+like+this`);
    await k.job('search.refresh-suggestions');
    const r = await k.call('GET', `${STORE}/suggestions?q=wirel`);
    expect(r.status).toBe(200);
    expect(r.body.queries[0]).toEqual({ text: 'wireless headphones', matchedPrefix: 'wirel', categoryScope: null });
    expect(r.body.queries.map((q: any) => q.text)).not.toContain('nothing like this');
    expect(r.body.products.map((p: any) => p.productId)).toEqual([s.wireless.id]);
    expect(r.body.products[0]).toMatchObject({ slug: 'aurora-wireless-headphones', fromPrice: { amount: 9900, currency: 'USD' }, sellerName: 'Official Store' });
    expect(r.body.categories).toEqual([expect.objectContaining({ text: 'wireless headphones', categoryScope: { id: s.headphones.id, name: 'Headphones', slug: 'headphones' } })]);
    const brands = (await k.call('GET', `${STORE}/suggestions?q=halc`)).body.brands;
    expect(brands).toEqual([{ brandId: s.halcyon.id, name: 'Halcyon', slug: 'halcyon', logo: null, productCount: 2 }]);
    const stores = (await k.call('GET', `${STORE}/suggestions?q=gadget`)).body.stores;
    expect(stores).toEqual([{ sellerId: s.grove.id, name: 'Gadget Grove', slug: 'gadget-grove', logo: null, verified: true, productCount: 2, summary: 'Seller store · 2 products in headphones' }]);
    // misspelled: 'speakr' still finds the speaker and offers the fixed query
    const typo = (await k.call('GET', `${STORE}/suggestions?q=bookshelf+speakr`)).body;
    expect(typo.queries[0]).toEqual({ text: 'bookshelf speaker', matchedPrefix: '', categoryScope: null });
    expect(typo.products.map((p: any) => p.productId)).toContain(s.speaker.id);
    const cat = (await k.call('GET', `${STORE}/suggestions?q=headph`)).body.categories;
    expect(cat[0]).toMatchObject({ text: 'Headphones', categoryScope: { id: s.headphones.id } });
  });

  it('per-group limit', async () => {
    const r = await k.call('GET', `${STORE}/suggestions?q=h&limit=1`);
    for (const g of ['queries', 'categories', 'brands', 'stores', 'products']) expect(r.body[g].length).toBeLessThanOrEqual(1);
  });
});

describe('recent searches', () => {
  it('a guest session keeps its own list: newest first, no repeats, remove one, clear all', async () => {
    const guest = callers.visitor();
    for (const q of ['lamp', 'speaker', 'lamp']) await k.call('GET', `${STORE}/facets?q=${q}`, guest);
    await k.call('GET', `${STORE}/facets?q=headphones&brand=aurora`, guest);
    const list = (await k.call('GET', `${STORE}/recent-searches`, guest)).body;
    expect(list.map((r: any) => [r.query, r.filtersLabel])).toEqual([
      ['headphones', 'Aurora'],
      ['lamp', null],
      ['speaker', null],
    ]);
    // another guest sees nothing and cannot delete this guest's entry
    const other = callers.visitor();
    expect((await k.call('GET', `${STORE}/recent-searches`, other)).body).toEqual([]);
    expect((await k.call('DELETE', `${STORE}/recent-searches/${list[0].id}`, other)).status).toBe(404);
    expect((await k.call('DELETE', `${STORE}/recent-searches/${list[0].id}`, guest)).status).toBe(204);
    expect((await k.call('GET', `${STORE}/recent-searches`, guest)).body.map((r: any) => r.query)).toEqual(['lamp', 'speaker']);
    // suggestions include them for the session, filtered by the prefix
    expect((await k.call('GET', `${STORE}/suggestions?q=la`, guest)).body.recent.map((r: any) => r.query)).toEqual(['lamp']);
    expect((await k.call('DELETE', `${STORE}/recent-searches`, guest)).status).toBe(204);
    expect((await k.call('GET', `${STORE}/recent-searches`, guest)).body).toEqual([]);
  });

  it('keeps at most recentSearchesMax per session', async () => {
    const guest = callers.visitor();
    for (let i = 0; i < 12; i++) await k.call('GET', `${STORE}/facets?q=lamp${i}`, guest);
    const list = (await k.call('GET', `${STORE}/recent-searches`, guest)).body;
    expect(list).toHaveLength(10);
    expect(list[0].query).toBe('lamp11');
  });

  it('customers: saved only while recent searches are on; turning it off deletes them', async () => {
    const accountId = newId();
    const customerId = newId();
    k.world.customers.set(accountId, { id: customerId, recentSearches: false });
    const customer = callers.customer({ accountId } as never, { sub: accountId } as never);
    await k.call('GET', `${STORE}/facets?q=lamp`, customer);
    expect((await k.call('GET', `${STORE}/recent-searches`, customer)).body).toEqual([]);
    k.world.customers.get(accountId)!.recentSearches = true;
    await k.call('GET', `${STORE}/facets?q=speaker`, customer);
    expect((await k.call('GET', `${STORE}/recent-searches`, customer)).body.map((r: any) => r.query)).toEqual(['speaker']);
    k.world.customers.get(accountId)!.recentSearches = false;
    await k.emit('customers', 'customers.marketing_preferences.changed', { customerId, emailPromotions: false, smsPromotions: false, pushPromotions: false, wishlistAlerts: false, source: 'profile', personalizedRecommendations: false, recentSearches: false });
    k.world.customers.get(accountId)!.recentSearches = true;
    expect((await k.call('GET', `${STORE}/recent-searches`, customer)).body).toEqual([]);
  });

  it('a claimed guest session merges its recent searches into the account', async () => {
    const accountId = newId();
    const customerId = newId();
    k.world.customers.set(accountId, { id: customerId, recentSearches: true });
    const sid = newId();
    const guest = callers.visitor({} as never, { sid } as never);
    await k.call('GET', `${STORE}/facets?q=speaker`, guest);
    await k.call('GET', `${STORE}/facets?q=lamp`, guest);
    const customer = callers.customer({ accountId } as never, { sub: accountId } as never);
    await k.call('GET', `${STORE}/facets?q=speaker`, customer);
    await k.emit('identity', 'identity.guest_session.claimed', { guestSessionId: sid, accountId });
    expect((await k.call('GET', `${STORE}/recent-searches`, customer)).body.map((r: any) => r.query)).toEqual(['speaker', 'lamp']);
    expect((await k.call('GET', `${STORE}/recent-searches`, guest)).body).toEqual([]);
  });
});

describe('sponsored hits', () => {
  it('advertising fills a labelled top row on the first page of search; organic ranks are unchanged', async () => {
    k.world.sponsored = [{ position: 1, productId: s.speaker.id, offerId: s.speakerOffer.id, price: 24900, advertiser: 'Casa Verde' }];
    try {
      const r = await k.call('GET', `${STORE}/products?q=halcyon`);
      expect(r.body.items[0]).toMatchObject({ kind: 'sponsored', slot: 'top_row', position: 1, product: { productId: s.speaker.id, price: { amount: 24900 }, offerId: s.speakerOffer.id }, sponsored: { label: 'Sponsored', advertiserName: 'Casa Verde', impressionToken: `imp-${s.speakerOffer.id}` } });
      const organic = r.body.items.filter((h: any) => h.kind === 'organic');
      expect(organic.map((h: any) => h.position)).toEqual([1, 2]);
      // category listings: inline at advertising's positions
      const cat = await k.call('GET', `${STORE}/products?category=electronics`);
      expect(cat.body.items[0]).toMatchObject({ kind: 'sponsored', slot: 'inline' });
      // not on later pages, and none when advertising cannot answer
      const later = await k.call('GET', `${STORE}/products?q=halcyon&limit=1&page=2`);
      expect(later.body.items.every((h: any) => h.kind === 'organic')).toBe(true);
      k.world.down.add('advertising');
      expect((await k.call('GET', `${STORE}/products?q=halcyon`)).body.items.every((h: any) => h.kind === 'organic')).toBe(true);
    } finally {
      k.world.down.delete('advertising');
      k.world.sponsored = [];
    }
  });
});

describe('cards, similar products, barcodes and clicks', () => {
  it('cards for a list of ids keep the order and leave out unknown products', async () => {
    const r = await k.call('GET', `${STORE}/cards?ids=${s.speaker.id},${newId()},${s.wireless.id}`);
    expect(r.body.map((c: any) => c.productId)).toEqual([s.speaker.id, s.wireless.id]);
    const official = await k.svc.getProductCards([s.wireless.id], { sellerId: s.grove.id });
    expect(official[0]).toMatchObject({ offerId: s.groveOffer.id, sellerName: 'Gadget Grove' });
  });

  it('similar in-stock products: same category first', async () => {
    const r = await k.call('GET', `${STORE}/products/${s.wireless.id}/similar?limit=2`);
    expect(r.body.map((c: any) => c.productId)).toEqual([s.earphones.id, s.speaker.id]);
    expect(await k.svc.similarProducts([s.earphones.id], 1)).toEqual({ [s.earphones.id]: [s.wireless.id] });
  });

  it('barcodes resolve to the product and the variant carrying the GTIN; unknown codes are unavailable searches', async () => {
    const hit = await k.call('GET', `${STORE}/barcodes/${ean(102)}`);
    expect(hit.body).toMatchObject({ code: `0${ean(102)}`, match: true, productId: s.wireless.id, variantId: s.wireless.variants[1]!.id, slug: 'aurora-wireless-headphones', card: { productId: s.wireless.id, variantId: s.wireless.variants[1]!.id } });
    const unknown = ean(999);
    const miss = await k.call('GET', `${STORE}/barcodes/${unknown}`);
    expect(miss.body).toMatchObject({ match: false, productId: null, fallbackQuery: unknown });
    const bad = await k.call('GET', `${STORE}/barcodes/4006381333932`);
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('VALIDATION_FAILED');
    const day = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);
    const stats = await k.svc.zeroResultStats(day(-1), day(1));
    expect(stats.find((z) => z.normalized === unknown)).toMatchObject({ count: 1, correctionOffered: false });
  });

  it('records clicks on results', async () => {
    const ctx = (await k.call('GET', `${STORE}/facets?q=speaker`)).body;
    const r = await k.call('POST', `${STORE}/searches/${ctx.searchId}/clicks`, k.visitor, { productId: s.speaker.id, position: 1, sponsored: false });
    expect(r.status).toBe(204);
    const rows = await k.app.kernel.mongo.db.collection('search.click_log').find({ search_id: ctx.searchId }).toArray();
    expect(rows).toHaveLength(1);
  });
});

describe('public API for other modules', () => {
  it('searchProducts: collections without sponsored slots', async () => {
    const r = await k.svc.searchProducts({ filters: { categoryIds: [s.electronics.id] }, sort: 'price_asc', limit: 2 });
    expect(r.items.map((c) => c.productId)).toEqual([s.earphones.id, s.wireless.id]);
    expect(r.total).toBe(3);
    expect(r.nextCursor).toBeTruthy();
    expect((await k.svc.searchProducts({ q: 'speaker' })).items.map((c) => c.productId)).toEqual([s.speaker.id]);
  });

  it('runSearch, listCategoryProducts and listSellerProducts', async () => {
    const r = await k.svc.runSearch({ q: 'headphones', filters: {} }, {});
    expect(r.items[0]).toMatchObject({ productId: s.wireless.id, match: { position: 1, offerId: s.officialOffer.id, priceIsFrom: false } });
    expect(r.sponsoredSlots).toEqual([{ placement: 'search_top_row', kind: 'top_row', positions: [], maxItems: 4 }]);
    expect(r.page).toMatchObject({ nextCursor: null, total: 2 });
    const c = await k.svc.listCategoryProducts('headphones', { filters: { attributes: [{ key: 'noise_cancelling', values: ['Active'] }] } }, {});
    expect(c!.items.map((i) => i.productId)).toEqual([s.wireless.id]);
    expect(c!.context.category?.category.slug).toBe('headphones');
    expect(c!.sponsoredSlots.map((x) => x.kind)).toEqual(['banner', 'inline']);
    expect(await k.svc.listCategoryProducts('no-such-category', {}, {})).toBeNull();
    const seller = await k.svc.listSellerProducts(s.casa.id, { filters: { sellerIds: [s.grove.id] } }, {});
    expect(seller.items.map((i) => i.productId).sort()).toEqual([s.wireless.id, s.speaker.id].sort());
    expect(seller.items.find((i) => i.productId === s.wireless.id)!.match.offerId).toBe(s.usedOffer.id);
    expect(seller.context.storeMatch).toBeNull();
    expect(seller.sponsoredSlots).toEqual([]);
    expect(seller.context.facets.map((f) => f.key)).not.toContain('seller');
  });

  it('sellerCategoryCounts: storefront chips', async () => {
    const r = await k.svc.sellerCategoryCounts([s.casa.id, newId()]);
    expect(r[s.casa.id]!.map((c) => [c.slug, c.count]).sort()).toEqual([
      ['headphones', 1],
      ['home', 1],
      ['speakers', 1],
    ]);
    expect(Object.values(r)[1]).toEqual([]);
  });
});

describe('GraphQL', () => {
  it('Query.search returns products with their search match, facets and sponsored placeholders', async () => {
    const res = await k.app.inject({
      method: 'POST',
      url: '/graphql/store',
      headers: auth(k.visitor),
      payload: {
        query: `{ search(query: "headphones", filters: { conditions: [NEW] }, sort: PRICE_ASC) {
          searchId total totalLabel query { raw correctionApplied }
          items { id title searchMatch { position priceIsFrom badges } related(limit: 1) { id } }
          facets { key group kind values { value count selected } }
          sorts { key selected }
          sponsoredSlots { placement kind maxItems }
          category { category { slug } }
        } }`,
      },
    });
    const body = res.json();
    expect(body.errors).toBeUndefined();
    const r = body.data.search;
    expect(r.total).toBe(2);
    expect(r.items.map((i: any) => i.id)).toEqual([s.earphones.id, s.wireless.id]);
    expect(r.items[0].searchMatch).toMatchObject({ position: 1, priceIsFrom: false });
    expect(r.items[0].related).toEqual([{ id: s.wireless.id }]);
    expect(r.facets[0]).toMatchObject({ key: 'category', group: 'UNIVERSAL', kind: 'CATEGORY' });
    expect(r.sorts.find((x: any) => x.selected).key).toBe('PRICE_ASC');
    expect(r.sponsoredSlots).toEqual([{ placement: 'search_top_row', kind: 'TOP_ROW', maxItems: 4 }]);
  });

  it('Query.categoryProducts and Query.searchSuggestions', async () => {
    const res = await k.app.inject({
      method: 'POST',
      url: '/graphql/store',
      headers: auth(k.visitor),
      payload: {
        query: `{ categoryProducts(slug: "electronics") { total category { category { slug name } breadcrumb { slug } subcategories { slug count } } items { id } }
                  searchSuggestions(prefix: "halc") { query brands { brand { id slug } productCount } products { id } } }`,
      },
    });
    const body = res.json();
    expect(body.errors).toBeUndefined();
    expect(body.data.categoryProducts).toMatchObject({ total: 3, category: { category: { slug: 'electronics', name: 'Electronics' }, breadcrumb: [{ slug: 'electronics' }] } });
    expect(body.data.searchSuggestions.brands).toEqual([{ brand: { id: s.halcyon.id, slug: 'halcyon' }, productCount: 2 }]);
    expect(body.data.searchSuggestions.products.map((p: any) => p.id).sort()).toEqual([s.earphones.id, s.speaker.id].sort());
  });
});
