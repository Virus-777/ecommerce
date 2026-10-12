/**
 * Engine contract: the same scenarios for every engine (engine-contract.test.ts: MongoDB and the OpenSearch
 * adapter on the in-memory fake; opensearch.integration.test.ts: a live cluster). They pin down what the
 * engines must agree on where the card offer ("eo") matters most: card-offer prices under offer filters and
 * price sorts, facet counts and ranges, availability, ranking factors, spelling correction, similar and
 * popular products, admin lookups, per-seller counts, live changes and a full reindex. The whole search
 * suite also runs on the OpenSearch adapter with SEARCH_TEST_ENGINE=opensearch (docs/02 §9).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OFFICIAL_STORE_NAME } from '../../../spec/common.js';
import { ADMIN, boot, ean, newId, STORE, type Engine, type Kit } from './helpers.js';

const organic = (body: any) => body.items.filter((h: any) => h.kind === 'organic');
const ids = (body: any) => organic(body).map((h: any) => h.product.productId);

export function engineContract(engine: Engine) {
  describe(`${engine} engine`, () => {
    let k: Kit;
    let w: Awaited<ReturnType<typeof setup>>;

    async function setup() {
      const world = k.world;
      const audio = world.category('Audio');
      const speakers = world.category('Speakers', {
        parentId: audio.id,
        filters: [{ name: 'Color', options: ['Black', 'White'] }],
      });
      const nova = world.brand('Nova');
      const alpha = world.seller('Alpha Audio');
      const beta = world.seller('Beta Sound');
      // studio: featured official (in stock); a cheaper seller offer; a used out-of-stock one; a dearer in-stock one
      const studio = world.product({
        title: 'Nova studio monitor speaker',
        categoryId: speakers.id,
        brand: nova,
        variants: [{ options: { Color: 'Black' }, gtin: ean(801) }],
      });
      const studioOfficial = world.offer(studio.id, {
        price: 30000,
        sellerId: null,
        dispatchDays: 1,
      });
      const studioAlpha = world.offer(studio.id, {
        price: 25000,
        sellerId: alpha.id,
      });
      const studioUsed = world.offer(studio.id, {
        price: 20000,
        sellerId: beta.id,
        condition: 'used_good',
        stock: 'out_of_stock',
        status: 'out_of_stock',
      });
      world.offer(studio.id, { price: 35000, sellerId: beta.id });
      world.featured.set(studio.id, studioOfficial.id);
      // travel: the featured offer is out of stock; others in stock
      const travel = world.product({
        title: 'Nova travel speaker',
        categoryId: speakers.id,
        brand: nova,
        variants: [{ options: { Color: 'White' }, gtin: ean(802) }],
      });
      const travelAlpha = world.offer(travel.id, {
        price: 15000,
        sellerId: alpha.id,
        stock: 'out_of_stock',
        status: 'out_of_stock',
      });
      const travelBeta = world.offer(travel.id, {
        price: 18000,
        sellerId: beta.id,
        dispatchDays: 2,
      });
      world.offer(travel.id, { price: 22000, sellerId: null });
      world.featured.set(travel.id, travelAlpha.id);
      // party: one seller offer, ships today, free delivery
      const party = world.product({
        title: 'Pulse party speaker',
        categoryId: speakers.id,
        variants: [{ options: { Color: 'Black' }, gtin: ean(803) }],
      });
      const partyBeta = world.offer(party.id, {
        price: 27000,
        sellerId: beta.id,
        dispatchDays: 0,
        free: true,
      });
      // mini: only an out-of-stock official offer
      const mini = world.product({
        title: 'Pulse mini speaker',
        categoryId: speakers.id,
        variants: [{ options: { Color: 'White' }, gtin: ean(804) }],
      });
      world.offer(mini.id, {
        price: 9000,
        sellerId: null,
        stock: 'out_of_stock',
        status: 'out_of_stock',
      });
      world.ratings.set(studio.id, { average: 4.6, count: 10 });
      for (const p of [studio, travel, party, mini]) await k.index(p.id);
      for (const s of [alpha, beta])
        await k.emit('sellers', 'sellers.seller.approved', {
          sellerId: s.id,
          applicationId: newId(),
          storeName: s.storeName,
          ownerAccountId: newId(),
          categoryIds: [],
          returnAddress: {
            name: 'R',
            line1: '1 Main St',
            city: 'Austin',
            region: 'TX',
            postalCode: '73301',
            country: 'US',
          },
          returnContact: 'r@example.com',
        });
      return {
        audio,
        speakers,
        nova,
        alpha,
        beta,
        studio,
        travel,
        party,
        mini,
        studioOfficial,
        studioAlpha,
        studioUsed,
        travelAlpha,
        travelBeta,
        partyBeta,
      };
    }

    beforeAll(async () => {
      k = await boot({ engine });
      w = await setup();
    });
    afterAll(async () => {
      await k?.close();
    });

    const products = async (qs: string) => {
      const r = await k.call('GET', `${STORE}/products?${qs}`);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      return r.body;
    };
    const facets = async (qs: string) => {
      const r = await k.call('GET', `${STORE}/facets?${qs}`);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      return r.body;
    };
    const card = (body: any, productId: string) => organic(body).find((h: any) => h.product.productId === productId)?.product;

    it('price sorts follow the card offer: featured first, else the cheapest in-stock match', async () => {
      const asc = await products('category=speakers&sort=price_asc');
      expect(ids(asc)).toEqual([w.travel.id, w.party.id, w.studio.id]);
      expect(organic(asc).map((h: any) => h.product.price.amount)).toEqual([18000, 27000, 30000]);
      expect(card(asc, w.travel.id)).toMatchObject({
        offerId: w.travelBeta.id,
        priceIsFrom: true,
      });
      expect(ids(await products('category=speakers&sort=price_desc'))).toEqual([w.studio.id, w.party.id, w.travel.id]);
      // with out-of-stock products the featured offer leads even when it is out of stock
      const all = await products('category=speakers&sort=price_asc&availability=include_out_of_stock');
      expect(organic(all).map((h: any) => [h.product.productId, h.product.price.amount])).toEqual([
        [w.mini.id, 9000],
        [w.travel.id, 15000],
        [w.party.id, 27000],
        [w.studio.id, 30000],
      ]);
      expect(all.total).toBe(4);
    });

    it('price sorts page through the merged order', async () => {
      const first = await products('category=speakers&sort=price_asc&availability=include_out_of_stock&limit=3');
      expect(ids(first)).toEqual([w.mini.id, w.travel.id, w.party.id]);
      const second = await products(`category=speakers&sort=price_asc&availability=include_out_of_stock&limit=3&cursor=${first.nextCursor}`);
      expect(ids(second)).toEqual([w.studio.id]);
      expect(organic(second)[0].position).toBe(4);
    });

    it('offer filters pick the matching offer and price it', async () => {
      const alpha = await products('category=speakers&seller=alpha-audio&availability=include_out_of_stock&sort=price_asc');
      expect(organic(alpha).map((h: any) => [h.product.productId, h.product.offerId, h.product.price.amount])).toEqual([
        [w.travel.id, w.travelAlpha.id, 15000],
        [w.studio.id, w.studioAlpha.id, 25000],
      ]);
      const used = await products('category=speakers&condition=used&availability=include_out_of_stock');
      expect(organic(used).map((h: any) => [h.product.productId, h.product.offerId, h.product.condition])).toEqual([[w.studio.id, w.studioUsed.id, 'used']]);
      const range = await products('category=speakers&priceMin=24000&priceMax=26000');
      expect(organic(range).map((h: any) => [h.product.productId, h.product.offerId])).toEqual([[w.studio.id, w.studioAlpha.id]]);
      expect(ids(await products('category=speakers&delivery=ships_today'))).toEqual([w.party.id]);
    });

    it('facets: card-offer price range, availability by card offer, seller and condition counts', async () => {
      const c = await facets('category=speakers');
      const facet = (key: string) => c.facets.find((f: any) => f.key === key);
      // the range spans card-offer prices (a dearer non-card offer does not widen it)
      expect(facet('price').range).toMatchObject({
        min: { amount: 18000 },
        max: { amount: 30000 },
      });
      expect(facet('availability').values).toEqual([
        { value: 'in_stock', label: 'In stock now', count: 2, selected: true },
        {
          value: 'include_out_of_stock',
          label: 'Include out of stock',
          count: 4,
          selected: false,
        },
      ]);
      expect(Object.fromEntries(facet('seller').values.map((v: any) => [v.label, v.count]))).toEqual({ [OFFICIAL_STORE_NAME]: 2, 'Alpha Audio': 1, 'Beta Sound': 3 });
      expect(facet('condition').values.map((v: any) => [v.value, v.count])).toEqual([
        ['new', 3],
        ['used', 0],
        ['refurbished', 0],
      ]);
      expect(facet('delivery').values.map((v: any) => [v.value, v.count])).toEqual([
        ['free', 1],
        ['ships_today', 1],
      ]);
      expect(facet('brand').values.map((v: any) => [v.label, v.count])).toEqual([['Nova', 2]]);
      expect(facet('rating').values.map((v: any) => [v.value, v.count])).toEqual([
        ['4', 1],
        ['3', 1],
        ['2', 1],
        ['1', 1],
      ]);
      expect(facet('color').values.map((v: any) => [v.value, v.count])).toEqual([
        ['Black', 2],
        ['White', 1],
      ]);
      expect(c.totalLabel).toBe('3 results from 3 sellers, including the Official Store');
      const outOfStock = await facets('category=speakers&availability=include_out_of_stock&condition=used');
      expect(outOfStock.facets.find((f: any) => f.key === 'condition').values.map((v: any) => [v.value, v.count])).toEqual([
        ['new', 4],
        ['used', 1],
        ['refurbished', 0],
      ]);
    });

    it('ranking factors other than text relevance are the same numbers', async () => {
      const r = await k.call('GET', `${ADMIN}/explain?q=nova+speaker`, k.staff);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const studio = r.body.find((x: any) => x.productId === w.studio.id);
      const travel = r.body.find((x: any) => x.productId === w.travel.id);
      expect(studio.factors).toMatchObject({
        in_stock: 0.2,
        featured_offer: 0.1,
        delivery_speed: 0.05,
        rating: 0.092,
        conversion: 0,
        gtin: 0,
      });
      expect(studio.factors.text_relevance).toBeGreaterThan(0);
      expect(travel.factors).toMatchObject({
        in_stock: 0.2,
        featured_offer: 0.1,
        delivery_speed: 0.0333,
        rating: 0,
        conversion: 0,
      });
      expect(r.body.map((x: any) => x.productId)).toEqual([w.studio.id, w.travel.id]);
    });

    it('a GTIN finds its product first', async () => {
      expect(ids(await products(`q=${ean(803)}`))).toEqual([w.party.id]);
    });

    it('similar, popular, lookups and per-seller counts', async () => {
      const similar = await k.svc.similarProducts([w.studio.id], 5);
      expect(similar[w.studio.id]).toEqual([w.travel.id, w.party.id]);
      const lookup = await k.call('GET', `/api/admin/search/lookup?q=pulse`, k.staff);
      expect(lookup.status, JSON.stringify(lookup.body)).toBe(200);
      expect(
        lookup.body.groups
          .find((g: any) => g.kind === 'products')
          .items.map((i: any) => i.title)
          .sort(),
      ).toEqual(['Pulse mini speaker', 'Pulse party speaker']);
      const byGtin = await k.call('GET', `/api/admin/search/lookup?q=${ean(802)}`, k.staff);
      expect(byGtin.body.groups.find((g: any) => g.kind === 'products').items[0].title).toBe('Nova travel speaker');
      const chips = await k.svc.sellerCategoryCounts([w.alpha.id, w.beta.id]);
      expect(chips[w.alpha.id]!.map((c) => [c.slug, c.count])).toEqual([['speakers', 2]]);
      expect(chips[w.beta.id]!.map((c) => [c.slug, c.count])).toEqual([['speakers', 3]]);
      const sug = (await k.call('GET', `${STORE}/suggestions?q=nov`)).body;
      expect(sug.brands).toEqual([expect.objectContaining({ name: 'Nova', productCount: 2 })]);
      expect(sug.products.map((p: any) => p.productId).sort()).toEqual([w.studio.id, w.travel.id].sort());
      const empty = await facets('q=nova&condition=refurbished');
      expect(empty.emptyGuidance.popular.map((p: any) => p.productId)).toEqual(expect.arrayContaining([w.studio.id]));
    });

    it('typo tolerance: a misspelled word is corrected from the index words', async () => {
      const c = await facets('q=travle+speakr');
      expect(c.query).toMatchObject({
        correctedTo: 'travel speaker',
        correctionApplied: true,
      });
      expect(c.total).toBe(1);
      const typing = (await k.call('GET', `${STORE}/suggestions?q=pulse+speakr`)).body;
      expect(typing.queries[0]).toMatchObject({ text: 'pulse speaker' });
    });

    it('changes reach the engine: price, stock and removal', async () => {
      await k.emit('offers', 'offers.offer.price_changed', {
        offerId: w.partyBeta.id,
        productId: w.party.id,
        variantId: w.partyBeta.variantId,
        ownerType: 'seller',
        sellerId: w.beta.id,
        from: { amount: 27000, currency: 'USD' },
        to: { amount: 12000, currency: 'USD' },
        termsVersion: 2,
      });
      expect(ids(await products('category=speakers&sort=price_asc'))).toEqual([w.party.id, w.travel.id, w.studio.id]);
      await k.emit('inventory', 'inventory.stock.changed', {
        stockItemId: newId(),
        offerId: w.partyBeta.id,
        ownerType: 'seller',
        sellerId: w.beta.id,
        productId: w.party.id,
        variantId: w.partyBeta.variantId,
        available: 0,
        reserved: 0,
        previousAvailable: 4,
        state: 'out_of_stock',
        archived: false,
        cause: 'sale',
      });
      expect(ids(await products('category=speakers&sort=price_asc'))).toEqual([w.travel.id, w.studio.id]);
      await k.emit('catalog', 'catalog.product.publication_changed', {
        productId: w.mini.id,
        from: 'active',
        to: 'hidden',
        reason: 'Recall',
      });
      expect(ids(await products('category=speakers&availability=include_out_of_stock'))).not.toContain(w.mini.id);
      // a full reindex rebuilds everything from the source modules and keeps answering the same
      k.world.offers.get(w.partyBeta.id)!.price = 12000;
      k.world.offers.get(w.partyBeta.id)!.stock = 'out_of_stock';
      k.world.products.get(w.mini.id)!.purchasable = false;
      const before = ids(await products('category=speakers&availability=include_out_of_stock&sort=price_asc'));
      await k.job('search.full-reindex');
      expect(ids(await products('category=speakers&availability=include_out_of_stock&sort=price_asc'))).toEqual(before);
    });
  });
}
