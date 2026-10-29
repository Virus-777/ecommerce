/**
 * Product images and the product image spec (media.productImage): images flagged for re-crop after a ratio change
 * (imagesToRecrop, missing-content tab, catalog.images.recrop_needed, products stay live), staff images off the spec
 * refused on products, and category aspect ratios ignored in favour of the global one.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EventEnvelope } from '../../../kernel/events/index.js';
import { api, brand, catalogApp, catalogTable, category, newId, productInput, sellerProduct, uploadImage, type CatalogTestApp } from './helpers.js';

let t: CatalogTestApp;
let a: ReturnType<typeof api>;
let cat: { id: string };
let brandId: string;
const recropNeeded: EventEnvelope[] = [];
beforeAll(async () => {
  t = await catalogApp();
  a = api(t);
  cat = await category(t, 'Kettles');
  await a.admin('PUT', `/categories/${cat.id}/attributes`, {
    attributes: [],
    // a category ratio other than the global 1:1: ignored for product photos
    imageRules: [{ text: 'Portrait 4:5', severity: 'blocking', check: { aspectRatios: ['4:5'], minWidth: 800 } }],
  });
  brandId = (await brand(t, 'Steamline')).id;
  t.app.kernel.events.subscribe('test', 'catalog.images.recrop_needed', (e) => void recropNeeded.push(e));
});
afterAll(async () => {
  await t?.app.close();
});

/** What media publishes when the ratio changes (media.rebuild-product-renditions) */
async function recropChanged(sellerId: string, items: { assetId: string; productId: string; recrop: boolean; kind?: 'product_image' | 'variant_image' }[]) {
  t.app.kernel.events.publish(
    'media',
    'media.product_images.recrop_changed',
    {
      aspectRatio: '4:5',
      items: items.map((i) => ({
        assetId: i.assetId,
        owner: { kind: 'seller', id: sellerId, label: null },
        recrop: i.recrop,
        usages: [{ module: 'catalog', kind: i.kind ?? 'product_image', refId: i.productId, refLabel: null, evidence: false, attachedAt: new Date().toISOString(), detachedAt: null }],
      })),
    },
    { actor: { kind: 'system' } },
  );
  await t.app.kernel.events.drain();
}

describe('images to re-crop', () => {
  it('flags the product (seller and admin views, missing-content tab), tells the seller once, keeps it live; replacing the image clears it', async () => {
    const sellerId = newId();
    const { id, image } = await sellerProduct(t, sellerId, { brandId, categoryId: cat.id, approve: true });
    const statsBefore = (await a.admin('GET', '/products/stats')).json().missingContent;

    await recropChanged(sellerId, [{ assetId: image, productId: id, recrop: true }]);
    const own = (await a.seller(sellerId, 'GET', `/products/${id}`)).json();
    expect(own).toMatchObject({ imagesToRecrop: [image], publication: 'active', reviewState: 'approved' });
    expect((await a.admin('GET', `/products/${id}`)).json().imagesToRecrop).toEqual([image]);
    const missing = (await a.admin('GET', `/products?missingContent=true&sellerId=${sellerId}`)).json();
    expect(missing.items.map((p: { product: { id: string } }) => p.product.id)).toEqual([id]);
    expect((await a.admin('GET', '/products/stats')).json().missingContent).toBe(statsBefore + 1);
    // and the other tab leaves it out: "nothing missing" is the negation of both halves at once
    expect((await a.admin('GET', `/products?missingContent=false&sellerId=${sellerId}`)).json().items).toEqual([]);
    expect(recropNeeded.at(-1)?.payload).toEqual({ sellerId, productIds: [id], imageCount: 1, aspectRatio: '4:5' });
    // the same flag again: no second notice
    const notices = recropNeeded.length;
    await recropChanged(sellerId, [{ assetId: image, productId: id, recrop: true }]);
    expect(recropNeeded).toHaveLength(notices);
    // still buyable
    expect((await t.catalog.isPurchasable(id))).toBe(true);

    // the image fits again (the ratio changed back): the flag clears
    await recropChanged(sellerId, [{ assetId: image, productId: id, recrop: false }]);
    expect((await a.seller(sellerId, 'GET', `/products/${id}`)).json().imagesToRecrop).toEqual([]);
    expect((await a.admin('GET', `/products?missingContent=true&sellerId=${sellerId}`)).json().items).toEqual([]);
    // the flagged list is now empty rather than unset, and an empty list is not "images to re-crop"
    expect((await a.admin('GET', `/products?missingContent=false&sellerId=${sellerId}`)).json().items.map((p: { product: { id: string } }) => p.product.id)).toEqual([id]);
    // nor is an unset one: the column is nullable and a row that predates the flag has no list at all
    await catalogTable(t.app, 'products').update(id, { recrop_media_ids: null });
    expect((await a.admin('GET', `/products?missingContent=true&sellerId=${sellerId}`)).json().items).toEqual([]);
    expect((await a.admin('GET', `/products?missingContent=false&sellerId=${sellerId}`)).json().items.map((p: { product: { id: string } }) => p.product.id)).toEqual([id]);
  });

  it('a draft keeps only the flagged images it still uses when saved; variant images count too', async () => {
    const sellerId = newId();
    const first = await uploadImage(t, { sellerId });
    const second = await uploadImage(t, { sellerId });
    const input = productInput({ brandId, categoryId: cat.id, imageIds: [first, second] });
    const id = (await a.seller(sellerId, 'POST', '/products', input)).json().product.id as string;
    await recropChanged(sellerId, [
      { assetId: first, productId: id, recrop: true },
      { assetId: second, productId: id, recrop: true, kind: 'variant_image' },
    ]);
    expect((await a.seller(sellerId, 'GET', `/products/${id}`)).json().imagesToRecrop.sort()).toEqual([first, second].sort());
    const saved = await a.seller(sellerId, 'PATCH', `/products/${id}`, { ...input, imageIds: [second] });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().imagesToRecrop).toEqual([second]);
    // a draft has no notice of its own beyond the seller event
    expect(recropNeeded.at(-1)?.payload).toMatchObject({ sellerId, productIds: [id], imageCount: 2 });
  });
});

describe('the product image spec on products', () => {
  it('refuses a staff image off the spec on an Official Store product, with the form field', async () => {
    const wide = await uploadImage(t, 'staff', { width: 1600, height: 800 });
    const res = await a.admin('POST', '/products', productInput({ brandId, categoryId: cat.id, imageIds: [wide] }));
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({
      code: 'VALIDATION_FAILED',
      message: 'Crop the image to 1:1. The Seller Center crops it for you when you upload.',
      details: { issues: [{ path: 'imageIds', message: 'Crop the image to 1:1. The Seller Center crops it for you when you upload.' }] },
    });
    const square = await uploadImage(t, 'staff', { width: 1000, height: 1000 });
    expect((await a.admin('POST', '/products', productInput({ brandId, categoryId: cat.id, imageIds: [square] }))).statusCode).toBe(201);
  });

  it("ignores a category's own aspect ratio: square images pass the image standard", async () => {
    const sellerId = newId();
    const { id } = await sellerProduct(t, sellerId, { brandId, categoryId: cat.id });
    const check = (await a.admin('GET', `/products/${id}`)).json().checks.find((c: { kind: string }) => c.kind === 'image_standard');
    expect(check).toMatchObject({ result: 'pass' });
  });

  it('serves product images in the detail size with a thumbnail URL', async () => {
    const sellerId = newId();
    const { id, image } = await sellerProduct(t, sellerId, { brandId, categoryId: cat.id, approve: true });
    const product = (await a.store(`/products/${id}`)).json();
    const images = product.product?.images ?? product.images;
    expect(images[0]).toMatchObject({ id: image, url: expect.stringMatching(/\/detail\.webp/), thumbUrl: expect.stringMatching(/\/thumb\.webp/), detailUrl: expect.stringMatching(/\/detail\.webp/) });
  });
});
