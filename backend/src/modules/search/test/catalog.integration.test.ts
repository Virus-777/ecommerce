/**
 * With the real catalog and media (tranche 2): a product created, submitted and approved through catalog's
 * HTTP API reaches the index through catalog.product.approved, with catalog's content, category tree and
 * brand, and the offer's stock comes from the real inventory. offers is not built yet: its listOffersAdmin
 * answer is stubbed (one Official Store offer).
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { auth, buildTestApp, callers, movingClock } from '../../../testing/app.js';
import { ean } from './helpers.js';

let app: FastifyInstance;
const staff = callers.staff();
const offers = new Map<string, { id: string; productId: string; variantId: string; price: number; stockItemId: string }>();

const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
const chunk = (type: string, data: Buffer) => Buffer.concat([u32(data.length), Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
const png = (seed: string) =>
  Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', Buffer.concat([u32(1200), u32(1200), Buffer.from([8, 2, 0, 0, 0])])), chunk('IDAT', Buffer.from(seed, 'latin1')), chunk('IEND', Buffer.alloc(0))]);

async function call(method: string, url: string, body?: unknown, token = staff) {
  const res = await app.inject({ method: method as never, url, headers: auth(token), ...(body !== undefined ? { payload: body as never } : {}) });
  await app.kernel.events.drain();
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

async function uploadImage(): Promise<string> {
  const body = png(newId());
  const res = await call('POST', '/api/admin/media/uploads', { upload: { purpose: 'product_image', fileName: 'photo.png', contentType: 'image/png', sizeBytes: body.length } });
  if (res.status !== 201) throw new Error(`upload: ${res.status} ${JSON.stringify(res.body)}`);
  const media = app.kernel.boot.apis.get('media') as unknown as { providers: { storage: { acceptSignedPut(url: string, body: Uint8Array, type?: string): Promise<unknown> } } };
  await media.providers.storage.acceptSignedPut(res.body.url, body, res.body.headers['content-type']);
  const done = await call('POST', `/api/admin/media/uploads/${res.body.uploadId}/complete`);
  if (done.status !== 202) throw new Error(`complete: ${done.status}`);
  await app.kernel.jobs.runNow('media.process');
  await app.kernel.events.drain();
  return res.body.assetId;
}

beforeAll(async () => {
  app = await buildTestApp({
    only: ['search'],
    clock: movingClock(),
    config: { rateLimits: false },
    apiStubs: {
      offers: {
        listOffersAdmin: async (f: { productId?: string }) => ({
          items: [...offers.values()]
            .filter((o) => !f.productId || o.productId === f.productId)
            .map((o) => ({
              id: o.id,
              ownerType: 'official',
              sellerId: null,
              sellerName: 'Official Store',
              productId: o.productId,
              variantId: o.variantId,
              condition: 'new',
              sellerSku: 'OFF-1',
              stockItemId: o.stockItemId,
              price: { amount: o.price, currency: 'USD' },
              compareAt: null,
              dispatch: { businessDays: 1, sameDayCutoff: null, shipsFrom: 'Reno, NV', label: 'Ships in 1 business day' },
              status: 'active',
              featuredEligibility: { eligible: true, reasons: [], evaluatedAt: new Date().toISOString() },
            })) as never,
          nextCursor: null,
        }),
        listActiveOffersForProduct: async () => [],
        listOwnOffersForProduct: async (_s: string, ids: string[]) => Object.fromEntries(ids.map((id) => [id, []])) as never,
      },
    },
  });
});
afterAll(async () => {
  await app?.close();
});

describe('search with the real catalog', () => {
  it('indexes an approved product with catalog content, category path and brand', async () => {
    const parent = await call('POST', '/api/admin/catalog/categories', { name: 'Audio' });
    expect(parent.status, JSON.stringify(parent.body)).toBe(201);
    const cat = await call('POST', '/api/admin/catalog/categories', { name: 'Headphones', parentId: parent.body.id });
    const brand = await call('POST', '/api/admin/catalog/brands', { name: 'Aurora Sound' });
    expect(brand.status, JSON.stringify(brand.body)).toBe(201);
    const image = await uploadImage();
    const gtin = ean(4242);
    const created = await call('POST', '/api/admin/catalog/products', {
      title: 'Aurora studio headphones',
      brandId: brand.body.brand.id,
      categoryId: cat.body.id,
      description: 'Closed-back studio headphones with a detachable cable and a 40 hour battery for wireless listening.',
      keyFeatures: ['Closed-back', '40 h battery', 'Detachable cable'],
      specs: { 'Battery life': '40 h' },
      includedItems: ['Headphones', 'Cable'],
      imageIds: [image],
      modelNumber: 'AU-STUDIO-1',
      variants: [{ options: { Color: 'Black' }, gtin }],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.product.id as string;
    // the offer's stock lives in the real inventory (offers is stubbed)
    const variantId = created.body.product.variants[0].id as string;
    const offerId = newId();
    const warehouse = await call('POST', '/api/admin/inventory/locations', { code: 'RNO1', name: 'Reno warehouse', address: { name: 'Marketly Reno', line1: '100 Logistics Way', city: 'Reno', region: 'NV', postalCode: '89502', country: 'US' }, timeZone: 'America/Los_Angeles' });
    expect(warehouse.status, JSON.stringify(warehouse.body)).toBe(201);
    const inventory = app.kernel.boot.apis.get('inventory') as { createStockItem(input: unknown): Promise<{ id: string }> };
    const stock = await inventory.createStockItem({ ownerType: 'official', offerId, sku: 'OFF-STUDIO-1', productId: id, variantId, condition: 'new', label: 'Black', initialAvailable: 12 });
    offers.set(id, { id: offerId, productId: id, variantId, price: 21900, stockItemId: stock.id });
    expect((await call('POST', `/api/admin/catalog/products/${id}/submit`)).status).toBe(200);
    const approved = await call('POST', `/api/admin/catalog/products/${id}/approve`, {}, callers.staff()); // a second person approves
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);

    const visitor = callers.visitor();
    const r = await call('GET', '/api/store/search/products?q=studio+headphones', undefined, visitor);
    expect(r.status).toBe(200);
    expect(r.body.items.map((h: any) => h.product.productId)).toEqual([id]);
    expect(r.body.items[0].product).toMatchObject({ title: 'Aurora studio headphones', brandName: 'Aurora Sound', price: { amount: 21900 }, sellerName: 'Official Store', official: true });
    expect(r.body.items[0].product.image?.id).toBe(image);
    // result cards carry the thumbnail (the product page uses detailUrl)
    expect(r.body.items[0].product.image).toMatchObject({ url: expect.stringMatching(/\/thumb\.webp/), width: 320, height: 320, detailUrl: expect.stringMatching(/\/detail\.webp/) });
    // category path (parent included), brand facet, barcode
    expect((await call('GET', `/api/store/search/products?category=${parent.body.slug}`, undefined, visitor)).body.items).toHaveLength(1);
    const ctx = (await call('GET', `/api/store/search/facets?category=${cat.body.slug}`, undefined, visitor)).body;
    expect(ctx.category.breadcrumb.map((c: any) => c.slug)).toEqual([parent.body.slug, cat.body.slug]);
    expect(ctx.facets.find((f: any) => f.key === 'brand').values).toEqual([expect.objectContaining({ value: brand.body.brand.slug, label: 'Aurora Sound', count: 1 })]);
    expect((await call('GET', `/api/store/search/barcodes/${gtin}`, undefined, visitor)).body).toMatchObject({ match: true, productId: id });
    // hiding the product in catalog takes it out of results
    const hidden = await call('POST', `/api/admin/catalog/products/${id}/publication`, { publication: 'hidden', reason: 'Checking a complaint' });
    expect(hidden.status, JSON.stringify(hidden.body)).toBe(200);
    expect((await call('GET', '/api/store/search/products?q=studio+headphones', undefined, visitor)).body.items).toEqual([]);
  });

  it('queues a full reindex when media rebuilt the product images (new thumbnails)', async () => {
    app.kernel.events.publish('media', 'media.product_images.rebuilt', { aspectRatio: '1:1', settingsVersion: 2, rebuilt: 12, flagged: 0, cleared: 0 }, { actor: { kind: 'system' } });
    await app.kernel.events.drain();
    const again = await call('POST', '/api/admin/search/reindex-jobs', { scope: 'all', reason: 'Check' });
    expect(again.status).toBe(409);
    expect(again.body.error).toMatchObject({ code: 'REINDEX_ALREADY_RUNNING' });
  });
});
