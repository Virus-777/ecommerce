/** Listing read model (offer events, counts job), matching, corrections, merges, bulk edits, exports, snapshots and GraphQL. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { api, auth, brand, callers, catalogApp, category, newId, registeredDatasets, sellerProduct, uploadImage, type CatalogTestApp } from './helpers.js';

let t: CatalogTestApp;
let a: ReturnType<typeof api>;
let parent: { id: string; slug: string };
let cat: { id: string; slug: string };
let brandRow: { id: string; slug: string };
beforeAll(async () => {
  t = await catalogApp();
  a = api(t);
  parent = await category(t, 'Electronics');
  cat = await category(t, 'Keyboards', { parentId: parent.id });
  brandRow = await brand(t, 'Kestrel Keys');
});
afterAll(async () => {
  await t?.app.close();
});
beforeEach(() => {
  t.events.length = 0;
  t.stubs.audit.record.mockClear();
});

const offerEvents = async (o: { productId: string; variantId: string; sellerId: string | null; status: string; price?: number; available?: number }) => {
  const offerId = newId();
  const base = { offerId, productId: o.productId, variantId: o.variantId, ownerType: o.sellerId ? 'seller' : 'official', sellerId: o.sellerId };
  t.app.kernel.events.publish('offers', 'offers.offer.created', { ...base, condition: 'new', stockItemId: newId() });
  t.app.kernel.events.publish('offers', 'offers.offer.status_changed', { ...base, from: 'draft', to: o.status });
  if (o.price) t.app.kernel.events.publish('offers', 'offers.offer.price_changed', { ...base, from: { amount: o.price + 500, currency: 'USD' }, to: { amount: o.price, currency: 'USD' }, termsVersion: 2 });
  t.app.kernel.events.publish('inventory', 'inventory.stock.changed', { stockItemId: newId(), offerId, ownerType: base.ownerType, sellerId: o.sellerId, variantId: o.variantId, available: o.available ?? 4, reserved: 0, previousAvailable: 0, state: (o.available ?? 4) > 0 ? 'in_stock' : 'out_of_stock', cause: 'receipt' });
  await t.app.kernel.events.drain();
  return offerId;
};
const variantOf = async (productId: string) => (await t.catalog.getProduct(productId))!.variants[0]!.id;

describe('listing read model and counts', () => {
  it('offer and stock events build listing columns; the counts job fills category and brand counts', async () => {
    const sellerId = newId();
    const { id } = await sellerProduct(t, sellerId, { brandId: brandRow.id, categoryId: cat.id, approve: true, model: 'KK-75' });
    const v = await variantOf(id);
    await offerEvents({ productId: id, variantId: v, sellerId, status: 'active', price: 12900 });
    await offerEvents({ productId: id, variantId: v, sellerId: null, status: 'active', price: 11900 });
    await offerEvents({ productId: id, variantId: v, sellerId: newId(), status: 'paused', price: 9900 });
    // an event for a product catalog doesn't know is ignored
    t.app.kernel.events.publish('offers', 'offers.offer.created', { offerId: newId(), productId: newId(), variantId: newId(), ownerType: 'seller', sellerId, condition: 'new', stockItemId: newId() });
    await t.app.kernel.events.drain();

    const row = (await a.admin('GET', `/products/${id}`)).json();
    expect(row).toMatchObject({ offerCount: 3, liveOfferCount: 2, bestPrice: { amount: 11900, currency: 'USD' }, offerNote: 'Gadget Grove offer paused · 2 other offers live' });

    expect((await a.store(`/categories`)).json().find((c: { id: string }) => c.id === parent.id).productCount).toBe(0);
    await t.app.kernel.jobs.runNow('catalog.refresh-counts');
    const store = (await a.store('/categories')).json().find((c: { id: string }) => c.id === parent.id);
    expect(store).toMatchObject({ productCount: 1, offerCount: null, children: [expect.objectContaining({ id: cat.id, productCount: 1 })] });
    expect((await a.admin('GET', '/categories')).json().find((c: { id: string }) => c.id === parent.id).offerCount).toBe(2);
    const popular = (await a.store(`/brands?sort=popular&categorySlug=${parent.slug}`)).json();
    expect(popular.items).toEqual([expect.objectContaining({ id: brandRow.id, productCount: 1 })]);
    expect((await a.store(`/brands?categorySlug=${cat.slug}`)).json().items).toEqual([expect.objectContaining({ id: brandRow.id, productCount: 1 })]);
    const brandAdmin = (await a.admin('GET', `/brands?q=kestrel`)).json().items[0];
    expect(brandAdmin).toMatchObject({ offerCount: 2, sellerCount: 2, pageLive: true });
    expect((await a.store(`/brands/${brandRow.slug}`)).json().productCount).toBe(1);
    expect((await a.admin('GET', '/products/stats')).json().offers).toBeGreaterThanOrEqual(3);
  });
});

describe('catalog matching', () => {
  it('matches by GTIN, model (bundle variants) and title; only approved, active products; with the caller own offers', async () => {
    const sellerId = newId();
    const { id } = await sellerProduct(t, newId(), { brandId: brandRow.id, categoryId: cat.id, approve: true, model: 'HA-ANC700', title: 'Halcyon ANC700 headphones' });
    await sellerProduct(t, newId(), { brandId: brandRow.id, categoryId: cat.id, approve: false, model: 'HA-ANC700X', title: 'Halcyon draft' });
    const gtin = (await t.catalog.getProduct(id))!.variants[0]!.gtin!;
    const offerId = newId();
    t.stubs.offers.listOwnOffersForProduct.mockResolvedValueOnce({ [id]: [{ id: offerId, variantId: (await variantOf(id)), condition: 'new' }] } as never);
    const res = await a.seller(sellerId, 'GET', '/match?q=HA-ANC700-TB');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().items).toEqual([expect.objectContaining({ product: expect.objectContaining({ id }), matchedOn: 'model', matchQuality: 'same_model_different_bundle', modelNumber: 'HA-ANC700', myOffers: [expect.objectContaining({ offerId, variantLabel: 'Black', condition: 'new' })] })]);
    expect((await a.seller(sellerId, 'GET', `/match?q=x&gtin=${gtin}`)).json().items[0]).toMatchObject({ matchedOn: 'gtin', matchQuality: 'exact' });
    expect((await a.seller(sellerId, 'GET', '/match?q=Halcyon')).json().items.map((m: { product: { id: string } }) => m.product.id)).toEqual([id]);
  });
});

describe('corrections', () => {
  it('a seller suggests, staff accept (applied, version bump) or decline; identity fields reopen review', async () => {
    const { id } = await sellerProduct(t, newId(), { brandId: brandRow.id, categoryId: cat.id, approve: true });
    const other = newId();
    const evidence = await uploadImage(t, { sellerId: other });
    expect((await a.seller(other, 'POST', `/products/${id}/corrections`, { field: 'colour', proposed: 'x' })).statusCode).toBe(400);
    const s1 = await a.seller(other, 'POST', `/products/${id}/corrections`, { field: 'title', proposed: 'Kestrel Keys K2 mechanical keyboard', evidenceIds: [evidence] });
    expect(s1.statusCode, s1.body).toBe(201);
    expect(s1.json()).toMatchObject({ productId: id, sellerId: other, state: 'open', current: expect.stringContaining('Aurora'), evidence: [expect.objectContaining({ id: evidence })] });
    expect(t.eventsNamed('catalog.correction.suggested').map((e) => e.payload)).toEqual([{ suggestionId: s1.json().id, productId: id }]);
    expect((await a.admin('GET', '/corrections')).json().items.map((c: { id: string }) => c.id)).toContain(s1.json().id);

    const version = (await t.catalog.getProductAdmin(id))!.version;
    const acc = await a.admin('POST', `/corrections/${s1.json().id}/decide`, { accept: true, reason: 'Matches the box' });
    expect(acc.statusCode, acc.body).toBe(200);
    expect(acc.json()).toMatchObject({ state: 'accepted', decisionReason: 'Matches the box' });
    const after = (await t.catalog.getProductAdmin(id))!;
    expect(after).toMatchObject({ reviewState: 'approved', version: version + 1, product: { title: 'Kestrel Keys K2 mechanical keyboard' } });
    expect(t.eventsNamed('catalog.product.updated').map((e) => e.payload)).toEqual([{ productId: id, version: version + 1 }]);
    expect(t.eventsNamed('catalog.correction.decided').map((e) => e.payload)).toEqual([{ suggestionId: s1.json().id, accepted: true }]);
    expect((await a.admin('POST', `/corrections/${s1.json().id}/decide`, { accept: false, reason: 'x' })).statusCode).toBe(409);

    const s3 = (await a.seller(other, 'POST', `/products/${id}/corrections`, { field: 'specs.Switch', proposed: 'Brown' })).json();
    expect((await a.admin('POST', `/corrections/${s3.id}/decide`, { accept: false, reason: 'No evidence' })).json().state).toBe('declined');

    const s2 = (await a.seller(other, 'POST', `/products/${id}/corrections`, { field: 'modelNumber', proposed: 'KK-K2-RGB' })).json();
    await a.admin('POST', `/corrections/${s2.id}/decide`, { accept: true, reason: 'Model printed on the base' });
    const reopened = (await a.admin('GET', `/products/${id}`)).json();
    expect(reopened).toMatchObject({ reviewState: 'submitted', submission: { kind: 'content_change', state: 'open' }, product: { modelNumber: 'KK-K2-RGB' } });
    expect((await a.admin('GET', '/review-queue?kind=correction&limit=100')).json().items.map((p: { product: { id: string } }) => p.product.id)).toContain(id);

    // while it is back in review, and for drafts of other sellers, there is nothing to correct
    expect((await a.seller(other, 'POST', `/products/${id}/corrections`, { field: 'title', proposed: 'x' })).statusCode).toBe(404);
    const draft = (await a.seller(newId(), 'POST', '/products', { title: 'Hidden draft' })).json().product.id;
    expect((await a.seller(other, 'POST', `/products/${draft}/corrections`, { field: 'title', proposed: 'x' })).statusCode).toBe(404);
  });
});

describe('merges', () => {
  it('previews and merges a duplicate as a new variation: offers move, the old product redirects, one event per record', async () => {
    const keep = await sellerProduct(t, newId(), { brandId: brandRow.id, categoryId: cat.id, approve: true });
    const dupSeller = newId();
    const dup = await sellerProduct(t, dupSeller, { brandId: brandRow.id, categoryId: cat.id, approve: true });
    const sub = await sellerProduct(t, newId(), { brandId: brandRow.id, categoryId: cat.id });
    await offerEvents({ productId: dup.id, variantId: await variantOf(dup.id), sellerId: dupSeller, status: 'paused', price: 5000 });
    const body = { keepProductId: keep.id, merges: [{ productId: dup.id, asNewVariant: { Color: 'Lavender' } }, { productId: sub.id }], reason: 'Same keyboard' };

    expect((await a.admin('POST', '/products/merge/preview', { ...body, merges: [{ productId: keep.id }] })).statusCode).toBe(400);
    const preview = await a.admin('POST', '/products/merge/preview', body);
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json()).toMatchObject({
      keepProductId: keep.id,
      records: [
        { productId: dup.id, kind: 'product', action: 'new_variant', variantLabel: 'Lavender', offers: 1, reviews: 4 },
        { productId: sub.id, kind: 'submission', action: 'by_options', offers: 0 },
      ],
      offersMoved: 1,
      offersOnSaleAfter: 0,
      reviewsMoved: 8,
      reviewsAfter: 12,
      ratingAfter: 4.5,
      questionsMoved: 4,
      pastOrders: 16,
      redirects: 2,
      sellersNotified: [{ sellerId: dupSeller, name: 'Gadget Grove', offers: 1 }],
    });

    const res = await a.admin('POST', '/products/merge', body);
    expect(res.statusCode, res.body).toBe(200);
    const r = res.json();
    expect(r).toMatchObject({ keptProductId: keep.id, movedOffers: 1, movedReviews: 8 });
    const newVariantId = r.merged[0].newVariantId;
    expect(newVariantId).toEqual(expect.any(String));
    expect(t.eventsNamed('catalog.product.merged').map((e) => e.payload)).toEqual([
      { keptProductId: keep.id, duplicateProductId: dup.id, newVariantId, intoVariantId: null, reason: 'Same keyboard' },
      { keptProductId: keep.id, duplicateProductId: sub.id, newVariantId: null, intoVariantId: null, reason: 'Same keyboard' },
    ]);
    const kept = (await a.admin('GET', `/products/${keep.id}`)).json();
    expect(kept.product.variants.map((v: { options: Record<string, string> }) => v.options.Color)).toEqual(['Black', 'Lavender']);
    expect(kept.offerCount).toBe(1);
    expect((await a.store(`/products/${dup.id}`)).json().id).toBe(keep.id); // redirects
    expect((await a.admin('GET', `/products/${sub.id}`)).json().submission.state).toBe('decided');
    expect((await a.admin('POST', '/products/merge', body)).statusCode).toBe(409);
    expect(t.stubs.audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'catalog.product.merge' }));
  });
});

describe('bulk edits, exports, snapshots and seller counts', () => {
  it('bulk edit previews with dryRun, then applies category and publication changes', async () => {
    const one = await sellerProduct(t, newId(), { brandId: brandRow.id, categoryId: cat.id, approve: true });
    const two = await sellerProduct(t, newId(), { brandId: brandRow.id, categoryId: cat.id, approve: true });
    const target = await category(t, 'Mechanical keyboards', { parentId: parent.id });
    const dry = await a.admin('POST', '/products/bulk', { productIds: [one.id, two.id, newId()], change: { categoryId: target.id, publication: 'hidden' }, reason: 'Re-categorise', dryRun: true });
    expect(dry.statusCode, dry.body).toBe(200);
    expect(dry.json()).toMatchObject({ affected: 2, errors: [expect.objectContaining({ code: 'NOT_FOUND' })] });
    expect((await t.catalog.getProduct(one.id))!.categoryId).toBe(cat.id);
    const done = await a.admin('POST', '/products/bulk', { productIds: [one.id, two.id], change: { categoryId: target.id, publication: 'hidden' }, reason: 'Re-categorise', dryRun: false });
    expect(done.json().affected).toBe(2);
    expect((await t.catalog.getProductAdmin(one.id))).toMatchObject({ publication: 'hidden', product: { categoryId: target.id } });
    expect(t.eventsNamed('catalog.product.publication_changed')).toHaveLength(2);
  });

  it('exports through reports (audited) and serves the rows to staff only', async () => {
    const res = await a.admin('POST', '/products/exports', { filters: { reviewState: 'approved' }, format: 'xlsx' });
    expect(res.statusCode, res.body).toBe(202);
    expect(t.stubs.reports.requestExport).toHaveBeenCalledWith(expect.objectContaining({ dataset: 'catalog.admin.products', format: 'xlsx', filters: expect.objectContaining({ reviewState: 'approved' }) }));
    expect(registeredDatasets).toContainEqual(expect.objectContaining({ key: 'catalog.admin.products', owner: 'catalog' })); // registered at boot
    expect(t.stubs.audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'catalog.products.export' }));
    const rows = await t.catalog.exportRows('catalog.admin.products', { reviewState: 'approved' }, { kind: 'staff', accountId: t.staffId });
    expect(rows.rows.length).toBeGreaterThan(0);
    expect(rows.rows[0]).toMatchObject({ ref: expect.stringMatching(/^PRD-/), reviewState: 'approved' });
    await expect(t.catalog.exportRows('catalog.admin.products', {}, { kind: 'seller', accountId: newId() })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(t.catalog.exportRows('other.dataset', {}, { kind: 'staff' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('snapshotForOrder freezes title, category, brand, options and version; countProductsForSellers counts by state', async () => {
    const sellerId = newId();
    const { id } = await sellerProduct(t, sellerId, { brandId: brandRow.id, categoryId: cat.id, approve: true });
    await a.seller(sellerId, 'POST', '/products', { title: 'A draft' });
    const p = (await t.catalog.getProduct(id))!;
    const snap = await t.catalog.snapshotForOrder(p.variants[0]!.id);
    expect(snap).toMatchObject({ productId: id, variantId: p.variants[0]!.id, categoryId: cat.id, title: p.title, brandName: 'Kestrel Keys', options: { Color: 'Black' }, imageUrl: expect.any(String) });
    await expect(t.catalog.snapshotForOrder(newId())).rejects.toMatchObject({ code: 'NOT_FOUND' });
    t.stubs.sellers.canSell.mockResolvedValueOnce({ allowed: false, reason: 'Product submissions blocked in Keyboards until Oct 30' });
    expect((await t.catalog.countProductsForSellers([sellerId]))[sellerId]).toEqual({
      approved: 1, inReview: 0, changesRequested: 0, rejected: 0, drafts: 1, submissionsBlocked: true, blockedNote: 'Product submissions blocked in Keyboards until Oct 30', pausedSubmissions: 0,
    });
  });
});

describe('GraphQL', () => {
  const gql = (area: 'store' | 'seller' | 'admin', token: string, query: string, variables: Record<string, unknown> = {}) =>
    t.app.inject({ method: 'POST', url: `/graphql/${area}`, headers: { ...auth(token), 'content-type': 'application/json' }, payload: { query, variables } });

  it('store product, categories; seller myProduct with review fields only for the submitter; admin checks', async () => {
    const owner = newId();
    const { id } = await sellerProduct(t, owner, { brandId: brandRow.id, categoryId: cat.id, approve: true });
    const store = await gql('store', callers.visitor(), 'query($id: UUID!) { product(id: $id) { id title brand { name } category { name filters { name } } specs { name value } variants { options { name value } } } categories { name } }', { id });
    expect(store.json().errors).toBeUndefined();
    expect(store.json().data.product).toMatchObject({ id, brand: { name: 'Kestrel Keys' }, category: { name: 'Keyboards' }, specs: [{ name: 'Battery life', value: '40 h' }], variants: [{ options: [{ name: 'Color', value: 'Black' }] }] });

    const q = 'query($id: UUID!) { myProduct(id: $id) { id reviewState submittedByMe reviewLog { action } missing submission { ref } } }';
    const mine = await gql('seller', callers.seller({ sellerId: owner }), q, { id });
    expect(mine.json().data.myProduct).toMatchObject({ reviewState: 'APPROVED', submittedByMe: true, reviewLog: [{ action: 'submitted' }, { action: 'approved' }] });
    const theirs = await gql('seller', callers.seller({ sellerId: newId() }), q, { id });
    expect(theirs.json().data.myProduct).toMatchObject({ reviewState: 'APPROVED', submittedByMe: false, reviewLog: null, missing: null, submission: null });

    const admin = await gql('admin', callers.staff(), 'query($id: UUID!) { productAdmin(id: $id) { ref reviewState owner { type sellerId } checks { kind result } submission { kind state } } }', { id });
    expect(admin.json().errors).toBeUndefined();
    expect(admin.json().data.productAdmin).toMatchObject({ reviewState: 'APPROVED', owner: { type: 'SELLER', sellerId: owner }, submission: { kind: 'NEW', state: 'DECIDED' } });
    expect(admin.json().data.productAdmin.checks).toHaveLength(7);
  });
});
