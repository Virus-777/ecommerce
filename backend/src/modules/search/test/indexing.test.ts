/** The index as a read model: consumers (idempotent, order-tolerant), dirty processing and jobs. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { boot, ean, newId, STORE, type Kit } from './helpers.js';

let k: Kit;
let cat: { id: string; slug: string };
let brand: { id: string; slug: string; name: string };
let seller: { id: string; storeName: string };
let n = 0;
beforeAll(async () => {
  k = await boot();
  const root = k.world.category('Kitchen');
  cat = k.world.category('Cookware', { parentId: root.id });
  brand = k.world.brand('Pellar');
  seller = k.world.seller('Casa Verde');
});
afterAll(async () => {
  await k?.close();
});

/** A product with a unique word in its title, and the search for that word */
function product(extra: Partial<Parameters<Kit['world']['product']>[0]> = {}) {
  const word = `skillet${++n}x`;
  const p = k.world.product({ title: `Pellar cast iron ${word}`, categoryId: cat.id, brand, variants: [{ options: {}, gtin: ean(500 + n) }], ...extra });
  const find = async (q = '') => (await k.call('GET', `${STORE}/products?q=${word}${q}`)).body;
  return { p, word, find };
}
const ids = (body: any) => body.items.map((h: any) => h.product.productId);
const offerBase = (o: { id: string; productId: string; variantId: string; sellerId: string | null }) => ({ offerId: o.id, productId: o.productId, variantId: o.variantId, ownerType: o.sellerId ? 'seller' : 'official', sellerId: o.sellerId });

describe('catalog events', () => {
  it('an approved product appears once it has an eligible offer; approving twice keeps one document', async () => {
    const { p, find } = product();
    await k.index(p.id);
    expect(ids(await find())).toEqual([]);
    const o = k.world.offer(p.id, { price: 3900, sellerId: seller.id });
    await k.emit('offers', 'offers.offer.created', { ...offerBase(o), condition: 'new', stockItemId: newId() });
    expect(ids(await find())).toEqual([]);
    await k.job('search.process-dirty');
    expect(ids(await find())).toEqual([p.id]);
    await k.index(p.id);
    await k.index(p.id);
    const r = await find();
    expect(r.items).toHaveLength(1);
    expect(r.items[0].product).toMatchObject({ price: { amount: 3900 }, sellerName: 'Casa Verde', offerCount: 1 });
  });

  it('order-tolerant: an offer event before the product event is indexed when the product arrives', async () => {
    const { p, find } = product();
    const o = k.world.offer(p.id, { price: 4500, sellerId: null });
    await k.emit('offers', 'offers.offer.price_changed', { ...offerBase(o), from: { amount: 5000, currency: 'USD' }, to: { amount: 4500, currency: 'USD' }, termsVersion: 2 });
    await k.emit('inventory', 'inventory.stock.changed', { stockItemId: newId(), offerId: o.id, ownerType: 'official', sellerId: null, variantId: o.variantId, available: 3, reserved: 0, previousAvailable: 0, state: 'in_stock', cause: 'receipt' });
    expect(ids(await find())).toEqual([]);
    await k.index(p.id);
    expect((await find()).items[0].product).toMatchObject({ productId: p.id, price: { amount: 4500 }, official: true });
    // the dirty mark left by the early offer event rebuilds the same document
    await k.job('search.process-dirty');
    expect(ids(await find())).toEqual([p.id]);
  });

  it('hidden or suspended products leave results; active brings them back; updates reindex the title', async () => {
    const { p, word, find } = product();
    k.world.offer(p.id, { price: 2900, sellerId: seller.id });
    await k.index(p.id);
    await k.emit('catalog', 'catalog.product.publication_changed', { productId: p.id, from: 'active', to: 'hidden', reason: 'Recall' });
    expect(ids(await find())).toEqual([]);
    await k.emit('catalog', 'catalog.product.publication_changed', { productId: p.id, from: 'hidden', to: 'active', reason: 'Fixed' });
    expect(ids(await find())).toEqual([p.id]);
    k.world.products.get(p.id)!.title = `Pellar enamel dutch oven ${word}`;
    await k.emit('catalog', 'catalog.product.updated', { productId: p.id, version: 3 });
    expect(ids((await k.call('GET', `${STORE}/products?q=dutch+oven+${word}`)).body)).toEqual([p.id]);
    // a product that is no longer purchasable is removed on rebuild
    k.world.products.get(p.id)!.purchasable = false;
    await k.emit('catalog', 'catalog.product.updated', { productId: p.id, version: 4 });
    expect(ids(await find())).toEqual([]);
  });

  it('a merge drops the duplicate and reindexes the kept product', async () => {
    const a = product();
    const b = product();
    k.world.offer(a.p.id, { price: 1000, sellerId: seller.id });
    k.world.offer(b.p.id, { price: 1100, sellerId: seller.id });
    await k.index(a.p.id);
    await k.index(b.p.id);
    k.world.products.get(b.p.id)!.purchasable = false;
    await k.emit('catalog', 'catalog.product.merged', { keptProductId: a.p.id, duplicateProductId: b.p.id, reason: 'Duplicate' });
    expect(ids(await b.find())).toEqual([]);
    expect(ids(await a.find())).toEqual([a.p.id]);
  });

  it('brand status: inactive brands are not offered as a facet; reactivated ones return', async () => {
    const b = k.world.brand('Tempest');
    const { p, find } = product({ brand: b });
    k.world.offer(p.id, { price: 1500, sellerId: seller.id });
    await k.index(p.id);
    const facetValues = async () => (await k.call('GET', `${STORE}/facets?category=${cat.slug}`)).body.facets.find((f: any) => f.key === 'brand').values.map((v: any) => v.label);
    expect(await facetValues()).toContain('Tempest');
    k.world.brands.get(b.slug)!.active = false;
    await k.emit('catalog', 'catalog.brand.changed', { brandId: b.id, change: 'status', status: 'blocked', sellingPolicy: 'open' });
    expect(await facetValues()).not.toContain('Tempest');
    await k.job('search.process-dirty');
    expect(await facetValues()).not.toContain('Tempest');
    expect(ids(await find())).toEqual([p.id]);
    k.world.brands.get(b.slug)!.active = true;
    await k.emit('catalog', 'catalog.brand.changed', { brandId: b.id, change: 'status', status: 'active', sellingPolicy: 'open' });
    expect(await facetValues()).toContain('Tempest');
  });
});

describe('offers, stock, reviews and promotions events', () => {
  it('price changes update the card in place; a verified compare-at on the featured offer makes a deal', async () => {
    const { p, find } = product();
    const o = k.world.offer(p.id, { price: 5000, sellerId: seller.id });
    k.world.featured.set(p.id, o.id);
    await k.index(p.id);
    await k.emit('offers', 'offers.offer.price_changed', { ...offerBase(o), from: { amount: 5000, currency: 'USD' }, to: { amount: 4000, currency: 'USD' }, compareAt: { amount: 5000, currency: 'USD' }, termsVersion: 2 });
    expect((await find()).items[0].product).toMatchObject({ price: { amount: 4000 }, wasPrice: { amount: 5000 }, discountPct: 20, badges: expect.arrayContaining(['Deal']) });
    expect(ids(await find('&onSale=true'))).toEqual([p.id]);
  });

  it('status changes: paused offers leave; without a live offer the product leaves results', async () => {
    const { p, find } = product();
    const a = k.world.offer(p.id, { price: 2000, sellerId: seller.id });
    const b = k.world.offer(p.id, { price: 2500, sellerId: null });
    await k.index(p.id);
    expect((await find()).items[0].product.offerCount).toBe(2);
    k.world.offers.get(a.id)!.status = 'paused';
    await k.emit('offers', 'offers.offer.status_changed', { ...offerBase(a), from: 'active', to: 'paused' });
    expect((await find()).items[0].product).toMatchObject({ offerCount: 1, price: { amount: 2500 } });
    k.world.offers.get(b.id)!.status = 'removed';
    await k.emit('offers', 'offers.offer.status_changed', { ...offerBase(b), from: 'active', to: 'removed' });
    expect(ids(await find('&availability=include_out_of_stock'))).toEqual([]);
  });

  it('works while offers is not built: events alone keep the offer rows', async () => {
    const { p, find } = product();
    const o = k.world.offer(p.id, { price: 3000, sellerId: seller.id });
    await k.index(p.id);
    k.world.down.add('offers');
    try {
      await k.emit('offers', 'offers.offer.price_changed', { ...offerBase(o), from: { amount: 3000, currency: 'USD' }, to: { amount: 2700, currency: 'USD' }, termsVersion: 2 });
      await k.emit('catalog', 'catalog.product.updated', { productId: p.id, version: 2 });
      await k.job('search.process-dirty');
      expect((await find()).items[0].product).toMatchObject({ price: { amount: 2700 }, offerCount: 1 });
    } finally {
      k.world.down.delete('offers');
    }
  });

  it('stock changes: out of stock drops from default results; low stock shows on the card', async () => {
    const { p, find } = product();
    const o = k.world.offer(p.id, { price: 1200, sellerId: seller.id });
    k.world.featured.set(p.id, o.id);
    await k.index(p.id);
    const stock = (state: string) => k.emit('inventory', 'inventory.stock.changed', { stockItemId: newId(), offerId: o.id, ownerType: 'seller', sellerId: seller.id, variantId: o.variantId, available: state === 'out_of_stock' ? 0 : 2, reserved: 0, previousAvailable: 5, state, cause: 'sale' });
    await stock('low_stock');
    expect((await find()).items[0].product.availability).toBe('low_stock');
    await stock('out_of_stock');
    expect(ids(await find())).toEqual([]);
    expect((await find('&availability=include_out_of_stock')).items[0].product.availability).toBe('out_of_stock');
    await stock('in_stock');
    expect((await find()).items[0].product.availability).toBe('in_stock');
  });

  it('featured offer changes move the card to the new featured offer', async () => {
    const { p, find } = product();
    const a = k.world.offer(p.id, { price: 3000, sellerId: seller.id });
    const b = k.world.offer(p.id, { price: 3200, sellerId: null });
    k.world.featured.set(p.id, a.id);
    await k.index(p.id);
    expect((await find()).items[0].product.offerId).toBe(a.id);
    k.world.featured.set(p.id, b.id);
    await k.emit('offers', 'offers.featured.changed', { productId: p.id, variantId: b.variantId, conditionGroup: 'new', zoneKey: 'default', fromOfferId: a.id, toOfferId: b.id });
    expect((await find()).items[0].product).toMatchObject({ offerId: b.id, price: { amount: 3200 }, official: true, priceIsFrom: false });
  });

  it('published reviews update rating and count (never 0 stars without reviews)', async () => {
    const { p, find } = product();
    k.world.offer(p.id, { price: 3000, sellerId: seller.id });
    await k.index(p.id);
    expect((await find()).items[0].product).toMatchObject({ rating: null, ratingCount: 0 });
    k.world.ratings.set(p.id, { average: 4.46, count: 12 });
    await k.emit('reviews', 'reviews.review.published', { reviewId: newId(), productId: p.id, sellerId: seller.id, rating: 5, verified: true });
    expect((await find()).items[0].product).toMatchObject({ rating: 4.5, ratingCount: 12 });
    expect(ids(await find('&rating=4'))).toEqual([p.id]);
    expect(ids(await find('&rating=5'))).toEqual([]);
  });

  it('campaigns add deal badges with end times and remove them when they end', async () => {
    const { p, find } = product();
    const o = k.world.offer(p.id, { price: 8000, sellerId: seller.id });
    k.world.featured.set(p.id, o.id);
    await k.index(p.id);
    const endsAt = new Date(Date.now() + 86_400_000).toISOString();
    k.world.promos.set(o.id, { price: 6000, regular: 8000, endsAt });
    await k.emit('promotions', 'promotions.campaign.started', { campaignId: newId(), kind: 'flash_sale', offerIds: [o.id], endsAt });
    expect((await find()).items[0].product).toMatchObject({ badges: expect.arrayContaining(['Deal']), dealEndsAt: endsAt });
    await k.job('search.process-dirty');
    expect((await find()).items[0].product).toMatchObject({ price: { amount: 6000 }, wasPrice: { amount: 8000 }, discountPct: 25, badges: expect.arrayContaining(['Deal']) });
    k.world.promos.delete(o.id);
    await k.emit('promotions', 'promotions.campaign.ended', { campaignId: newId(), reason: 'period_over' });
    await k.job('search.process-dirty');
    const card = (await find()).items[0].product;
    expect(card).toMatchObject({ price: { amount: 8000 }, wasPrice: null, dealEndsAt: null });
    expect(card.badges).not.toContain('Deal');
  });
});

describe('sellers events: store suggestions', () => {
  it('approved stores are suggested; suspended and closed ones are not; reinstated ones return', async () => {
    const s = k.world.seller('Northwind Audio');
    const stores = async () => (await k.call('GET', `${STORE}/suggestions?q=northwind`)).body.stores.map((x: any) => x.name);
    const approved = { sellerId: s.id, applicationId: newId(), storeName: s.storeName, ownerAccountId: newId(), categoryIds: [], returnAddress: { name: 'R', line1: '1 Main', city: 'Austin', region: 'TX', postalCode: '73301', country: 'US' }, returnContact: 'r@example.com' };
    await k.emit('sellers', 'sellers.seller.approved', approved);
    await k.emit('sellers', 'sellers.seller.approved', approved);
    expect(await stores()).toEqual(['Northwind Audio']);
    await k.emit('sellers', 'sellers.seller.suspended', { sellerId: s.id, suspensionId: newId(), reasonCode: 'fraud', reason: 'Checks', reviewDate: '2026-11-01', openOrders: 'seller_keeps_fulfilling', appealDeadline: new Date(Date.now() + 86_400_000).toISOString() });
    expect(await stores()).toEqual([]);
    await k.emit('sellers', 'sellers.seller.reinstated', { sellerId: s.id, from: 'suspended', to: 'approved', remainingRestrictionIds: [] });
    expect(await stores()).toEqual(['Northwind Audio']);
    await k.emit('sellers', 'sellers.seller.closed', { sellerId: s.id, reasonCode: 'requested', closedBy: { kind: 'staff', id: newId() } });
    expect(await stores()).toEqual([]);
  });

  it('a restriction marks the seller products for a rebuild', async () => {
    const { p } = product();
    k.world.offer(p.id, { price: 1000, sellerId: seller.id });
    await k.index(p.id);
    const before = (await k.call('GET', '/api/admin/search/index', k.staff)).body.staleDocuments;
    await k.emit('sellers', 'sellers.seller.restricted', { sellerId: seller.id, restrictionId: newId(), reasonCode: 'late_dispatch', reason: 'Late', affectedActivities: ['new_offers'], scope: { conditions: [], categoryIds: [] }, categoryIds: [], appealRoute: '/appeals', appealDeadline: new Date(Date.now() + 86_400_000).toISOString(), reviewDate: '2026-11-01' });
    const after = (await k.call('GET', '/api/admin/search/index', k.staff)).body;
    expect(after.staleDocuments).toBeGreaterThan(before);
    await k.job('search.process-dirty');
    expect((await k.call('GET', '/api/admin/search/index', k.staff)).body.staleDocuments).toBe(0);
  });
});

describe('jobs', () => {
  it('sales counts: orders count units, best selling opens at bestSellingMinOrders, ranks per category', async () => {
    const a = product();
    const b = product();
    k.world.offer(a.p.id, { price: 1000, sellerId: seller.id });
    k.world.offer(b.p.id, { price: 1000, sellerId: seller.id });
    await k.index(a.p.id);
    await k.index(b.p.id);
    const placed = async (productId: string, quantity: number) => {
      const orderId = newId();
      k.world.orders.set(orderId, [{ productId, quantity }]);
      await k.emit('orders', 'orders.order.placed', { orderId, ref: 'MK-261009-00001', checkoutSessionId: newId(), customerId: null, guestEmail: 'g@example.com', paymentIntentId: newId(), paymentState: 'accepted', total: { amount: 1000, currency: 'USD' }, couponCodes: [], groups: [], placedAt: new Date().toISOString() });
    };
    await placed(a.p.id, 200);
    await placed(b.p.id, 250);
    await k.job('search.sales-counts');
    expect((await k.call('GET', `${STORE}/products?category=${cat.slug}&sort=best_selling`)).status).toBe(409);
    await placed(b.p.id, 100);
    await k.job('search.sales-counts');
    const best = await k.call('GET', `${STORE}/products?category=${cat.slug}&sort=best_selling`);
    expect(best.status).toBe(200);
    expect(ids(best.body).slice(0, 2)).toEqual([b.p.id, a.p.id]);
    const ranks = await k.svc.bestSellerRanks([a.p.id, b.p.id, newId()]);
    expect(ranks[b.p.id]).toMatchObject({ rank: 1, categoryId: cat.id, categoryName: 'Cookware', label: '#1 in Cookware' });
    expect(ranks[a.p.id]).toMatchObject({ rank: 2, label: '#2 in Cookware' });
    expect(Object.values(ranks).filter((r) => r === null)).toHaveLength(1);
  });

  it('full reindex rebuilds from the source modules and removes what is gone', async () => {
    const a = product();
    const b = product();
    k.world.offer(a.p.id, { price: 1000, sellerId: seller.id });
    await k.index(a.p.id);
    // b has a live offer but no catalog event reached search; a is no longer purchasable
    k.world.offer(b.p.id, { price: 1000, sellerId: seller.id });
    k.world.products.get(a.p.id)!.purchasable = false;
    await k.job('search.full-reindex');
    expect(ids(await a.find())).toEqual([]);
    expect(ids(await b.find())).toEqual([b.p.id]);
    const rebuilt = k.of('search.index.rebuilt').at(-1);
    expect(rebuilt).toMatchObject({ scope: 'all' });
    expect((await k.call('GET', '/api/admin/search/index', k.staff)).body.lastFullReindexAt).toBeTruthy();
  });

  it('refresh-suggestions and refresh-delivery-flags run over the whole index', async () => {
    await k.job('search.refresh-suggestions');
    await k.job('search.refresh-delivery-flags');
    const sug = (await k.call('GET', `${STORE}/suggestions?q=cookw`)).body;
    expect(sug.categories.map((c: any) => c.categoryScope?.name)).toContain('Cookware');
  });
});
