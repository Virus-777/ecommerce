/**
 * Wave 2 (web team requests): sellers withdraw a submission and delete a draft (G52a), an optional publication reason
 * (G68), undoing a dismissed check (G73), the new-listing flag and best-seller rank on the store detail (G25e, G25f)
 * and the catalog.view permission (G77).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { auth, api, brand, callers, catalogApp, category, newId, productInput, sellerProduct, uploadImage, type CatalogTestApp } from './helpers.js';

const resolveBySource = vi.fn(async () => 1);
const rank = { rank: 3, categoryId: newId(), categoryName: 'Speakers', label: '#3 in Speakers', updatedAt: '2026-10-16T08:00:00.000Z' };

let t: CatalogTestApp;
let a: ReturnType<typeof api>;
let cat: { id: string };
let brandId: string;
beforeAll(async () => {
  t = await catalogApp({ apiStubs: { workqueues: { resolveBySource }, search: { bestSellerRanks: async (ids: string[]) => Object.fromEntries(ids.map((id) => [id, rank])) } } });
  a = api(t);
  cat = await category(t, 'Speakers');
  brandId = (await brand(t, 'Kestrel')).id;
});
afterAll(async () => {
  await t?.app.close();
});
beforeEach(() => resolveBySource.mockClear());

const del = (sellerId: string, id: string) => a.raw('DELETE' as never, `/api/seller/catalog/products/${id}`, auth(callers.seller({ sellerId })));

describe('seller drafts (G52a)', () => {
  it('withdraws a submission before review: back to draft, out of the queue, the work item closed', async () => {
    const sellerId = newId();
    const { id } = await sellerProduct(t, sellerId, { brandId, categoryId: cat.id });
    const res = await a.seller(sellerId, 'POST', `/products/${id}/withdraw`, { reason: 'Wrong photos' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ reviewState: 'draft' });
    expect(resolveBySource).toHaveBeenCalledWith(`product_review:${id}`, expect.objectContaining({ note: 'Submission withdrawn by the seller' }));
    const queue = (await a.admin('GET', '/review-queue?limit=100')).json().items.map((p: { product: { id: string } }) => p.product.id);
    expect(queue).not.toContain(id);
    // a draft cannot be withdrawn again; another seller does not see it
    expect((await a.seller(sellerId, 'POST', `/products/${id}/withdraw`, {})).statusCode).toBe(409);
    expect((await a.seller(newId(), 'POST', `/products/${id}/withdraw`, {})).statusCode).toBe(404);
    // and it can be submitted again
    expect((await a.seller(sellerId, 'POST', `/products/${id}/submit`, {})).statusCode).toBe(200);
  });

  it('refuses to withdraw a listed product', async () => {
    const sellerId = newId();
    const { id } = await sellerProduct(t, sellerId, { brandId, categoryId: cat.id, approve: true });
    expect((await a.seller(sellerId, 'POST', `/products/${id}/withdraw`, {})).statusCode).toBe(409);
    expect((await del(sellerId, id)).statusCode).toBe(409);
  });

  it('deletes a draft, but not one waiting for review', async () => {
    const sellerId = newId();
    const { id } = await sellerProduct(t, sellerId, { brandId, categoryId: cat.id });
    expect((await del(sellerId, id)).statusCode).toBe(409);
    await a.seller(sellerId, 'POST', `/products/${id}/withdraw`, {});
    expect((await del(sellerId, id)).statusCode).toBe(204);
    expect((await a.seller(sellerId, 'GET' as never, `/products/${id}`)).statusCode).toBe(404);
    // a fresh draft that was never submitted
    const image = await uploadImage(t, { sellerId });
    const draft = (await a.seller(sellerId, 'POST', '/products', productInput({ brandId, categoryId: cat.id, imageIds: [image] }))).json();
    expect((await del(sellerId, draft.product.id)).statusCode).toBe(204);
  });
});

describe('publication reason (G68)', () => {
  it('is optional: a default text is recorded', async () => {
    const { id } = await sellerProduct(t, newId(), { brandId, categoryId: cat.id, approve: true });
    const res = await a.admin('POST', `/products/${id}/publication`, { publication: 'hidden' });
    expect(res.statusCode, res.body).toBe(200);
    expect(t.eventsNamed('catalog.product.publication_changed').at(-1)!.payload).toMatchObject({ productId: id, to: 'hidden', reason: 'Hidden from the store by staff' });
  });
});

describe('undo a dismissed check (G73)', () => {
  it('opens the duplicate finding again, one candidate or all', async () => {
    const first = await sellerProduct(t, newId(), { brandId, categoryId: cat.id, model: 'KS-900', approve: true });
    const second = await sellerProduct(t, newId(), { brandId, categoryId: cat.id, model: 'KS-900', approve: true });
    const p = await sellerProduct(t, newId(), { brandId, categoryId: cat.id, model: 'ks 900' });
    expect((await a.admin('POST', `/products/${p.id}/checks/duplicate/dismiss`, { reason: 'Not a duplicate' })).json()).toMatchObject({ duplicateSuspected: false });
    const one = await a.admin('POST', `/products/${p.id}/checks/duplicate/restore`, { matchedProductId: first.id });
    expect(one.statusCode, one.body).toBe(200);
    expect(one.json().duplicateCandidates.map((d: { id: string }) => d.id)).toEqual([first.id]);
    const all = (await a.admin('POST', `/products/${p.id}/checks/duplicate/restore`, {})).json();
    expect(all.duplicateCandidates.map((d: { id: string }) => d.id)).toEqual(expect.arrayContaining([first.id, second.id]));
    expect(all.duplicateSuspected).toBe(true);
    // nothing left to restore
    expect((await a.admin('POST', `/products/${p.id}/checks/duplicate/restore`, {})).statusCode).toBe(404);
  });
});

describe('store product detail (G25e, G25f)', () => {
  it('carries the new-listing flag and the best-seller rank from search', async () => {
    const { id } = await sellerProduct(t, newId(), { brandId, categoryId: cat.id, approve: true });
    const res = await a.store(`/products/${id}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ isNewListing: true, bestSellerRank: rank });
  });
});

describe('catalog.view (G77)', () => {
  it('admin catalog reads need the view key', async () => {
    const viewer = auth(callers.staff(['catalog.view']));
    for (const path of ['/products', '/products/stats', '/review-queue', '/categories', '/brands', '/corrections']) {
      expect((await a.admin('GET', path, undefined, viewer)).statusCode, path).toBe(200);
    }
    expect((await a.admin('GET', '/products', undefined, auth(callers.staff(['catalog.products.review'])))).statusCode).toBe(403);
  });
});
