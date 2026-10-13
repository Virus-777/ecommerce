/**
 * OpenSearch index lifecycle and feeding: versioned index behind an alias, ordered bulk writes with retries,
 * blue/green full reindex with an atomic alias swap, and the repository feed (after commit, failures queued
 * for process-dirty). Runs on the in-memory fake (test/opensearch-fake).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOpenSearchClient, OsApi } from '../providers/opensearch/client.js';
import { MAPPING_VERSION, productIndexBody } from '../providers/opensearch/mapping.js';
import { ProductIndex } from '../providers/opensearch/products-index.js';
import type { DocRow, IndexedDocument } from '../ports.js';
import type { SearchRepository } from '../repository.js';
import { boot, newId, STORE, testOpenSearchConfig, type Kit } from './helpers.js';
import { fakeClientOptions, FakeOpenSearch } from './opensearch-fake/connection.js';

const silentLog = { info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {}, child: () => silentLog } as never;

function setup(o: { bulkAttempts?: number; now?: () => Date } = {}) {
  const fake = new FakeOpenSearch();
  const cfg = testOpenSearchConfig({ bulkAttempts: o.bulkAttempts ?? 3 });
  const os = new OsApi(createOpenSearchClient(cfg, fakeClientOptions(fake)));
  let t = Date.parse('2026-10-10T08:00:00.000Z');
  const now = o.now ?? (() => new Date((t += 1000)));
  const index = new ProductIndex(os, { cfg, log: silentLog, now, sleep: async () => {} });
  return { fake, os, index, cfg };
}

const doc = (id: string, version: number, extra: Partial<DocRow> = {}): DocRow =>
  ({
    product_id: id,
    slug: id,
    title: `Lamp ${id}`,
    brand_id: null,
    brand_name: null,
    category_id: null,
    category_path_ids: [],
    attributes: {},
    variant_count: 1,
    variant_options: [],
    image: null,
    seller_ids: [],
    has_official: true,
    conditions: ['new'],
    offer_count: 1,
    featured_offer_id: null,
    featured_price: null,
    featured_seller_name: null,
    featured_official: false,
    min_price: 1000,
    max_price: 1000,
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
    same_day_cutoff: null,
    rating: null,
    rating_count: 0,
    sales_30d: 0,
    first_listed_at: new Date('2026-09-01T00:00:00Z'),
    popularity: '0',
    terms: null,
    title_norm: `lamp ${id}`,
    version,
    indexed_at: new Date('2026-10-01T00:00:00Z'),
    best_seller_rank: null,
    best_seller_category_id: null,
    ...extra,
  }) as DocRow;
const full = (id: string, version: number, extra: Partial<DocRow> = {}): IndexedDocument => ({ doc: doc(id, version, extra), offers: [], texts: { title: `Lamp ${id}`, brand: '', category: 'Home', attributes: '', description: `The ${id} description` } });
const partial = (id: string, version: number, extra: Partial<DocRow> = {}): IndexedDocument => ({ doc: doc(id, version, extra), offers: [] });

describe('index lifecycle', () => {
  it('creates a versioned index behind the alias once; other servers find it', async () => {
    const { fake, index, os, cfg } = setup();
    const name = await index.ensure();
    expect(name).toMatch(/^test-products-\d{17}$/);
    expect(fake.aliases.get('test-products')).toEqual(new Set([name]));
    await index.ensure();
    expect(fake.requests.filter((r) => r.method === 'PUT')).toHaveLength(1);
    const other = new ProductIndex(os, { cfg, log: silentLog });
    expect(await other.ensure()).toBe(name);
    expect(fake.requests.filter((r) => r.method === 'PUT')).toHaveLength(1);
    expect(await index.describe()).toBe(`opensearch (green, index ${name})`);
    // the server that created it knows it is empty; the others do not reindex again
    expect(await index.needsRebuild()).toBe(`${name}@v${MAPPING_VERSION}`);
    expect(await other.needsRebuild()).toBeNull();
  });

  it('servers starting together create one index', async () => {
    const { fake, os, cfg } = setup();
    const a = new ProductIndex(os, { cfg, log: silentLog });
    const b = new ProductIndex(os, { cfg, log: silentLog });
    const [x, y] = await Promise.all([a.ensure(), b.ensure()]);
    expect(x).toBe(y);
    expect(fake.indices.size).toBe(1);
  });

  it('reports an index built with an older mapping', async () => {
    const { fake, index } = setup();
    const body = productIndexBody({ shards: 1, replicas: 0 });
    fake.handle('PUT', '/test-products-20260101000000000', {}, JSON.stringify({ ...body, mappings: { ...body.mappings, _meta: { mappingVersion: MAPPING_VERSION - 1 } }, aliases: { 'test-products': {} } }));
    expect(await index.describe()).toBe(`opensearch (green, index test-products-20260101000000000, mapping v${MAPPING_VERSION - 1} < v${MAPPING_VERSION}: full reindex needed)`);
    expect(await index.needsRebuild()).toBe(`test-products-20260101000000000@v${MAPPING_VERSION}`);
  });

  it('reports an unreachable cluster', async () => {
    const { fake, index } = setup();
    fake.fail(() => true, { status: 503, body: { error: { type: 'unavailable', reason: 'down' } } }, 10);
    expect(await index.describe()).toMatch(/^opensearch \(unreachable: OpenSearch answered 503/);
  });
});

describe('writes', () => {
  it('full writes carry texts; partial writes keep them; older versions never win; deletes', async () => {
    const { fake, index } = setup();
    expect(await index.write([full('p1', 1), full('p2', 1)], [])).toEqual({ failed: [] });
    expect(await index.write([partial('p1', 2, { title: 'Lamp p1 renamed', in_stock: false })], [])).toEqual({ failed: [] });
    let p1 = fake.docs('test-products').get('p1');
    expect(p1).toMatchObject({ version: 2, title: 'Lamp p1 renamed', in_stock: false, description: 'The p1 description', category_text: 'Home' });
    // an older state arriving late is ignored
    expect(await index.write([full('p1', 1)], [])).toEqual({ failed: [] });
    p1 = fake.docs('test-products').get('p1');
    expect(p1).toMatchObject({ version: 2, in_stock: false });
    // a partial write of a document the index lacks needs a full rebuild
    expect(await index.write([partial('p9', 3)], [])).toEqual({ failed: ['p9'] });
    expect(await index.write([], ['p2', 'gone'])).toEqual({ failed: [] });
    expect([...fake.docs('test-products').keys()]).toEqual(['p1']);
    const bulk = fake.requests.filter((r) => r.path === '/_bulk');
    expect(bulk.every((r) => r.query.require_alias === 'true')).toBe(true);
  });

  it('retries rejected and failed items with backoff, then answers what still fails', async () => {
    const { fake, index } = setup();
    fake.failItems((_a, id) => id === 'p1', 429, 'es_rejected_execution_exception', 1);
    expect(await index.write([full('p1', 1), full('p2', 1)], [])).toEqual({ failed: [] });
    // the retry sent only the rejected item
    const bulk = () => fake.requests.filter((r) => r.path === '/_bulk');
    expect(bulk().map((r) => (r.body as unknown[]).length)).toEqual([4, 2]);
    fake.failItems((_a, id) => id === 'p2', 503, 'unavailable_shards_exception', 5);
    expect(await index.write([full('p2', 2)], [])).toEqual({ failed: ['p2'] });
    expect(bulk()).toHaveLength(2 + 3);
    // a mapping error is not retried
    fake.failItems((_a, id) => id === 'p3', 400, 'mapper_parsing_exception', 1);
    expect(await index.write([full('p3', 1)], [])).toEqual({ failed: ['p3'] });
    expect(bulk()).toHaveLength(6);
    // the cluster does not answer: retried, then the caller hears it
    fake.fail((r) => r.path === '/_bulk', { status: 500, body: { error: { type: 'internal', reason: 'boom' } } }, 3);
    await expect(index.write([full('p4', 1)], [])).rejects.toThrow(/OpenSearch answered 500/);
    fake.fail((r) => r.path === '/_bulk', { status: 500, body: { error: { type: 'internal', reason: 'boom' } } }, 1);
    expect(await index.write([full('p4', 1)], [])).toEqual({ failed: [] });
  });
});

describe('full reindex (blue/green)', () => {
  it('builds a new index while writes go to both, then swaps the alias atomically', async () => {
    const { fake, index } = setup();
    const first = await index.ensure();
    await index.write([full('p1', 1), full('p2', 1), full('p3', 1)], []);
    await index.beginRebuild();
    const building = [...fake.aliases.get('test-products-building')!][0]!;
    expect(building).not.toBe(first);
    // rebuilt documents and live changes reach both indices; a change to a document not rebuilt yet is left to the rebuild
    expect(await index.write([full('p1', 2)], [])).toEqual({ failed: [] });
    expect(await index.write([partial('p2', 2, { in_stock: false })], [])).toEqual({ failed: [] });
    expect(fake.docs(building).get('p1')).toMatchObject({ version: 2 });
    expect(fake.docs(building).has('p2')).toBe(false);
    expect(fake.docs(first).get('p2')).toMatchObject({ version: 2, in_stock: false });
    // queries keep using the live index meanwhile
    expect([...fake.docs('test-products').keys()].sort()).toEqual(['p1', 'p2', 'p3']);
    // p2 could not be rebuilt: its current document is carried over; p3 is gone from the read model
    await index.finishRebuild(true, ['p2']);
    expect(fake.aliases.get('test-products')).toEqual(new Set([building]));
    expect(fake.aliases.has('test-products-building')).toBe(false);
    expect([...fake.docs('test-products').keys()].sort()).toEqual(['p1', 'p2']);
    expect(fake.docs('test-products').get('p2')).toMatchObject({ version: 2, in_stock: false, description: 'The p2 description' });
    const swap = fake.requests.filter((r) => r.path === '/_aliases').at(-1)!;
    expect(swap.body).toEqual({
      actions: [{ remove: { index: first, alias: 'test-products' } }, { add: { index: building, alias: 'test-products' } }, { remove: { index: building, alias: 'test-products-building' } }],
    });
    // the previous index stays for a rollback; the one before it goes
    expect(fake.indices.has(first)).toBe(true);
    await index.beginRebuild();
    const third = [...fake.aliases.get('test-products-building')!][0]!;
    await index.finishRebuild(true, []);
    expect([...fake.indices.keys()].sort()).toEqual([building, third].sort());
    // writes after the swap go to the new live index only
    await index.write([full('p5', 1)], []);
    expect(fake.docs(third).has('p5')).toBe(true);
  });

  it('a failed reindex drops the new index; the live one keeps serving', async () => {
    const { fake, index } = setup();
    const live = await index.ensure();
    await index.beginRebuild();
    const building = [...fake.aliases.get('test-products-building')!][0]!;
    await index.finishRebuild(false, []);
    expect(fake.indices.has(building)).toBe(false);
    expect(fake.aliases.get('test-products')).toEqual(new Set([live]));
    // a reindex that died half-way is cleaned up by the next one
    await index.beginRebuild();
    const stale = [...fake.aliases.get('test-products-building')!][0]!;
    await index.beginRebuild();
    expect(fake.indices.has(stale)).toBe(false);
  });
});

describe('feeding from the read model', () => {
  let k: Kit;
  let productId: string;
  let offerId: string;
  let repo: SearchRepository;
  const search = async (q: string) => (await k.call('GET', `${STORE}/products?q=${q}&availability=include_out_of_stock`)).body.items.map((h: any) => h.product);
  const engineDoc = () => k.fake!.docs('test-products').get(productId);

  beforeAll(async () => {
    k = await boot({ engine: 'opensearch' });
    const cat = k.world.category('Lighting');
    const p = k.world.product({ title: 'Brass floor lamp', categoryId: cat.id });
    productId = p.id;
    offerId = k.world.offer(p.id, { price: 5000 }).id;
    await k.index(p.id);
    repo = (k.svc as unknown as { deps: { repo: SearchRepository } }).deps.repo;
  });
  afterAll(async () => {
    await k?.close();
  });

  it('indexes the rebuilt document with its texts', async () => {
    expect(engineDoc()).toMatchObject({ product_id: productId, title: 'Brass floor lamp', category_text: 'Lighting', offers: [expect.objectContaining({ offer_id: offerId, card_rank: 0, featured: true })] });
    expect((await search('brass'))[0]).toMatchObject({ productId, price: { amount: 5000 } });
  });

  it('a new engine index over a populated read model is filled by a queued full reindex', async () => {
    const status = async () => (await k.call('GET', '/api/admin/search/index', k.staff)).body;
    await k.svc.bootstrapEngineIndex();
    expect((await status()).runningJob).toMatchObject({ scope: 'all', state: 'queued', reason: 'The search engine index is new or was built with an older mapping' });
    await k.job('search.process-dirty');
    expect((await status()).runningJob).toBeNull();
    // once per index and mapping
    await k.svc.bootstrapEngineIndex();
    expect((await status()).runningJob).toBeNull();
    expect((await search('brass'))[0]).toMatchObject({ productId });
  });

  it('passes on only what a transaction committed', async () => {
    const before = k.fake!.requests.length;
    await expect(
      repo.transaction(async (tx) => {
        await tx.updateDocument(productId, { on_sale: true }, new Date());
        throw new Error('rolled back');
      }),
    ).rejects.toThrow('rolled back');
    expect(k.fake!.requests.slice(before).filter((r) => r.path === '/_bulk')).toEqual([]);
    expect(engineDoc()).toMatchObject({ on_sale: false });
    await repo.transaction((tx) => tx.updateDocument(productId, { on_sale: true }, new Date()));
    expect(engineDoc()).toMatchObject({ on_sale: true, description: expect.stringContaining('Brass floor lamp') });
  });

  it('when the engine cannot take a change, the product waits in process-dirty and heals', async () => {
    let down = true;
    k.fake!.fail((r) => down && r.path === '/_bulk', { status: 503, body: { error: { type: 'unavailable', reason: 'down' } } }, Infinity);
    await k.emit('offers', 'offers.offer.price_changed', { offerId, productId, variantId: k.world.offers.get(offerId)!.variantId, ownerType: 'official', sellerId: null, from: { amount: 5000, currency: 'USD' }, to: { amount: 4200, currency: 'USD' }, termsVersion: 2 });
    expect(engineDoc()).toMatchObject({ min_price: 5000 });
    expect((await k.call('GET', '/api/admin/search/index', k.staff)).body.staleDocuments).toBeGreaterThan(0);
    k.world.offers.get(offerId)!.price = 4200;
    down = false;
    await k.job('search.process-dirty');
    expect(engineDoc()).toMatchObject({ min_price: 4200, offers: [expect.objectContaining({ price: 4200 })] });
    expect((await k.call('GET', '/api/admin/search/index', k.staff)).body.staleDocuments).toBe(0);
  });

  it('a change to a document the engine lost is rebuilt in full', async () => {
    k.fake!.handle('POST', '/_bulk', { require_alias: 'true' }, `${JSON.stringify({ delete: { _index: 'test-products', _id: productId } })}\n`);
    await k.emit('reviews', 'reviews.review.published', { reviewId: newId(), productId, sellerId: newId(), rating: 5, verified: true });
    k.world.ratings.set(productId, { average: 5, count: 4 });
    await k.emit('reviews', 'reviews.review.published', { reviewId: newId(), productId, sellerId: newId(), rating: 5, verified: true });
    expect(engineDoc()).toBeUndefined();
    await k.job('search.process-dirty');
    expect(engineDoc()).toMatchObject({ rating: 5, rating_count: 4, title: 'Brass floor lamp', category_text: 'Lighting' });
  });

  it('nightly sales counts reach every document', async () => {
    const orderId = newId();
    k.world.orders.set(orderId, [{ productId, quantity: 7 }]);
    await k.emit('orders', 'orders.order.placed', { orderId, ref: 'MK-261010-00001', checkoutSessionId: newId(), customerId: null, guestEmail: 'g@example.com', paymentIntentId: newId(), paymentState: 'accepted', total: { amount: 1000, currency: 'USD' }, couponCodes: [], groups: [], placedAt: new Date().toISOString(), attemptNo: 1, contactName: 'Guest Shopper' });
    expect(engineDoc()).toMatchObject({ sales_30d: 7 });
    await repo.updateDocument(productId, { sales_30d: 0, popularity: '0' }, new Date());
    await k.job('search.sales-counts');
    expect(engineDoc()).toMatchObject({ sales_30d: 7, popularity: 7 });
  });

  it('a full reindex through the job swaps in a new index', async () => {
    const live = [...k.fake!.aliases.get('test-products')!][0];
    await k.job('search.full-reindex');
    const now = [...k.fake!.aliases.get('test-products')!][0];
    expect(now).not.toBe(live);
    expect((await search('brass')).map((p: any) => p.productId)).toEqual([productId]);
    expect((await k.call('GET', '/api/admin/search/index', k.staff)).body.engine).toBe(`opensearch (green, index ${now})`);
  });
});
