/**
 * Tranche 3 on top of 1–2, with no stubs and no development tokens: the shopping path.
 *
 *   an approved, launched seller → a product the Catalog Manager approves → an offer with stock
 *   → search finds it → a customer adds it to the cart → the seller lowers the price and the cart
 *   explains the change on the next read (plan scenario 2) → the seller's stock runs out and the line
 *   is kept and marked unavailable instead of disappearing.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withDependencies } from '../kernel/module-system/loader.js';
import { png } from '../modules/media/test/helpers.js';
import { buildTestApp, movingClock } from '../testing/app.js';
import { flows, type Flows } from '../testing/flows.js';

const clock = movingClock();
let app: FastifyInstance;
let f: Flows;
let sellerToken: string;
let catalogToken: string;
let productId: string;
let variantId: string;
let offerId: string;

beforeAll(async () => {
  app = await buildTestApp({
    only: withDependencies(['identity', 'access', 'audit', 'media', 'notifications', 'settings', 'customers', 'sellers', 'catalog', 'inventory', 'offers', 'search', 'cart', 'orders', 'content']),
    clock,
    config: { rateLimits: false },
  });
  f = flows(app, clock);
  const owner = await f.bootstrapOwner();
  const sellerManager = await f.staffWithRoles(owner, 'sam@marketly.test', 'Sam Sellers', ['seller_manager']);
  const catalogManager = await f.staffWithRoles(owner, 'cat@marketly.test', 'Cara Catalog', ['catalog_manager']);
  catalogToken = catalogManager.accessToken;
  const category = await f.call('POST', '/api/admin/catalog/categories', { token: catalogToken, body: { name: 'Headphones', parentId: null } });
  expect(category.status, JSON.stringify(category.body)).toBe(201);
  const brand = await f.call('POST', '/api/admin/catalog/brands', { token: catalogToken, body: { name: 'Aurora Sound' } });
  expect(brand.status, JSON.stringify(brand.body)).toBe(201);

  const ana = await f.customer('ana@example.com');
  const seller = await f.approvedSeller({ applicant: ana, sellerManager, categoryId: category.body.id, storeName: 'Northwind Audio' });
  sellerToken = seller.sellerToken;

  const imageId = await f.upload('seller', sellerToken, { purpose: 'product_image', fileName: 'front.png', contentType: 'image/png', body: png(1600, 1600) });
  const draft = await f.call('POST', '/api/seller/catalog/products', {
    token: sellerToken,
    body: {
      title: 'Aurora wireless headphones',
      brandId: brand.body.brand.id,
      categoryId: category.body.id,
      description: 'Over-ear headphones with active noise cancelling and a 40 hour battery that charges over USB-C.',
      keyFeatures: ['Active noise cancelling', '40 h battery', 'USB-C charging'],
      specs: { 'Battery life': '40 h' },
      includedItems: ['Headphones', 'USB-C cable'],
      imageIds: [imageId],
      modelNumber: 'AU-100',
      variants: [{ options: { Color: 'Black' }, gtin: '4006381333931' }],
    },
  });
  expect(draft.status, JSON.stringify(draft.body)).toBe(201);
  productId = draft.body.product.id;
  variantId = draft.body.product.variants[0].id;
  expect((await f.call('POST', `/api/seller/catalog/products/${productId}/submit`, { token: sellerToken, body: { note: 'First submission' } })).status).toBe(200);
  await f.passLaunchReview({ ...seller, sellerManager });
});
afterAll(async () => {
  await app?.close();
});

describe('the shopping path, end to end', () => {
  it('holds the offer as a draft until the Catalog Manager approves the product, then publishes it', async () => {
    const offerBody = {
      productId,
      variantId,
      condition: 'new',
      price: { amount: 18900, currency: 'USD' },
      sellerSku: 'NW-AU-100',
      quantity: 5,
      dispatchBusinessDays: 1,
      shippingProfileId: crypto.randomUUID(), // shipping is not built yet: profiles are accepted as given
      returnTerms: { kind: 'baseline' },
      warranty: { kind: 'manufacturer', months: 24 },
      publish: true,
    };
    const early = await f.call('POST', '/api/seller/offers/offers', { token: sellerToken, body: offerBody });
    expect(early.status, JSON.stringify(early.body)).toBe(201);
    expect(early.body.offer).toMatchObject({ status: 'draft', publishOnApproval: true }); // product still in review
    offerId = early.body.offer.id;

    const approved = await f.call('POST', `/api/admin/catalog/products/${productId}/approve`, { token: catalogToken, body: {} });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    await app.kernel.events.drain();
    const live = await f.call('GET', `/api/seller/offers/offers/${offerId}`, { token: sellerToken });
    expect(live.body.offer.status).toBe('active');
  });

  it('finds the product in search once the index catches up', async () => {
    await app.kernel.jobs.runNow('search.process-dirty');
    const res = await f.call('GET', '/api/store/search/products?q=aurora+headphones', { token: await f.visitor() });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(JSON.stringify(res.body.items)).toContain(productId);
    const misspelled = await f.call('GET', '/api/store/search/products?q=auroa+hedphones', { token: await f.visitor() });
    expect(JSON.stringify(misspelled.body)).toContain(productId); // corrected spelling still finds it
  });

  let ben: Awaited<ReturnType<Flows['customer']>>;

  it('adds the offer to a customer cart at the seller price', async () => {
    ben = await f.customer('ben@example.com');
    const add = await f.call('POST', '/api/store/cart/cart/items', { token: ben.accessToken, body: { offerId, quantity: 2 } });
    expect(add.status, JSON.stringify(add.body)).toBeLessThan(300);
    const cart = await f.call('GET', '/api/store/cart/cart', { token: ben.accessToken });
    expect(cart.status, JSON.stringify(cart.body)).toBe(200);
    expect(JSON.stringify(cart.body)).toContain(offerId);
    expect(JSON.stringify(cart.body)).toContain('18900');
  });

  it('explains a price drop on the next read instead of silently changing the total', async () => {
    const drop = await f.call('POST', '/api/seller/offers/price-changes', { token: sellerToken, body: { items: [{ offerId, price: { amount: 17900, currency: 'USD' } }] } });
    expect(drop.status, JSON.stringify(drop.body)).toBeLessThan(300);
    await app.kernel.events.drain();
    const cart = await f.call('GET', '/api/store/cart/cart', { token: ben.accessToken });
    const text = JSON.stringify(cart.body);
    expect(text).toContain('17900');
    expect(text).toContain('"kind":"price_decreased"');
  });

  it('keeps the line and marks it unavailable when the stock runs out', async () => {
    const stock = await f.call('GET', '/api/seller/inventory/stock-items', { token: sellerToken });
    expect(stock.status, JSON.stringify(stock.body)).toBe(200);
    const item = JSON.stringify(stock.body).match(/"(?:id|stockItemId)":"([0-9a-f-]{36})"/)?.[1];
    expect(item).toBeDefined();
    const zero = await f.call('POST', `/api/seller/inventory/stock-items/${item}/adjustments`, { token: sellerToken, body: { newAvailable: 0, reasonCode: 'moved_to_another_channel', note: 'Sold elsewhere' } });
    expect(zero.status, JSON.stringify(zero.body)).toBeLessThan(300);
    await app.kernel.events.drain();
    const cart = await f.call('GET', '/api/store/cart/cart', { token: ben.accessToken });
    expect(JSON.stringify(cart.body)).toContain(offerId); // still in the cart
    expect(JSON.stringify(cart.body)).toContain('"kind":"out_of_stock"');
  });
});
