/**
 * Gap pass 3: variant parcel data and list price (sellers, Official Store drafts and the staff PATCH endpoint), the batch
 * public API for other modules, ProductSnapshot images, the reviewTargetBusinessDays setting, trust enforcement
 * reversal, and media usage kinds for brand banners, category images and correction evidence.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { addBusinessDays } from '../domain/rules.js';
import { api, brand, catalogApp, category, newId, productInput, sellerProduct, uploadImage, type CatalogTestApp } from './helpers.js';

let t: CatalogTestApp;
let a: ReturnType<typeof api>;
let cat: { id: string; slug: string };
let child: { id: string; slug: string };
let brandId: string;
const usd = (amount: number) => ({ amount, currency: 'USD' });

beforeAll(async () => {
  t = await catalogApp();
  a = api(t);
  cat = await category(t, 'Audio');
  child = await category(t, 'Earbuds', { parentId: cat.id });
  brandId = (await brand(t, 'Halden')).id;
});
afterAll(async () => {
  await t?.app.close();
});
beforeEach(() => {
  t.events.length = 0;
  t.stubs.audit.record.mockClear();
});

const variantOf = (p: { product: { variants: { id: string }[] } }) => p.product.variants[0]!;

describe('variant parcel data and list price', () => {
  it('sellers send weight and packaged size with the submission; a list price from a seller is refused', async () => {
    const sellerId = newId();
    const image = await uploadImage(t, { sellerId });
    const input = productInput({ brandId, categoryId: child.id, imageIds: [image] });
    const refused = await a.seller(sellerId, 'POST', '/products', { ...input, variants: [{ ...input.variants[0], listPrice: usd(19900) }] });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.details.issues[0].path).toBe('variants[0].listPrice');

    const bad = await a.seller(sellerId, 'POST', '/products', { ...input, variants: [{ ...input.variants[0], weightGrams: 0 }] });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.details.issues[0].path).toBe('variants[0].weightGrams');

    const ok = await a.seller(sellerId, 'POST', '/products', { ...input, variants: [{ ...input.variants[0], weightGrams: 410, lengthCm: 22, widthCm: 18, heightCm: 9 }] });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(variantOf(ok.json())).toMatchObject({ weightGrams: 410, lengthCm: 22, widthCm: 18, heightCm: 9, listPrice: null });

    // a later save without the fields keeps them
    const again = await a.seller(sellerId, 'PATCH', `/products/${ok.json().product.id}`, { title: input.title, variants: [{ options: input.variants[0]!.options, gtin: input.variants[0]!.gtin }] });
    expect(again.statusCode, again.body).toBe(200);
    expect(variantOf(again.json())).toMatchObject({ weightGrams: 410, heightCm: 9 });
  });

  it('Official Store drafts take a list price (market currency only)', async () => {
    const image = await uploadImage(t, 'staff');
    const input = productInput({ brandId, categoryId: child.id, imageIds: [image] });
    const eur = await a.admin('POST', '/products', { ...input, variants: [{ ...input.variants[0], listPrice: { amount: 100, currency: 'EUR' } }] });
    expect(eur.statusCode).toBe(400);
    const created = await a.admin('POST', '/products', { ...input, variants: [{ ...input.variants[0], listPrice: usd(24900), weightGrams: 300 }] });
    expect(created.statusCode, created.body).toBe(201);
    expect(variantOf(created.json())).toMatchObject({ listPrice: usd(24900), weightGrams: 300 });
  });

  it('staff set or clear weight, size and list price on an approved product: logged, versioned, audited, product.updated', async () => {
    const sellerId = newId();
    const { id } = await sellerProduct(t, sellerId, { brandId, categoryId: child.id, approve: true });
    const before = (await a.admin('GET', `/products/${id}`)).json();
    const variantId = variantOf(before).id;
    t.events.length = 0;

    expect((await a.admin('PATCH', `/products/${id}/variants/${newId()}`, { weightGrams: 100, reason: 'x' })).statusCode).toBe(404);
    expect((await a.admin('PATCH', `/products/${id}/variants/${variantId}`, { weightGrams: -1, reason: 'Weighed' })).statusCode).toBe(400);
    expect((await a.admin('PATCH', `/products/${id}/variants/${variantId}`, { weightGrams: 250, reason: ' ' })).statusCode).toBe(400);

    const res = await a.admin('PATCH', `/products/${id}/variants/${variantId}`, { weightGrams: 250, lengthCm: 20, listPrice: usd(19900), reason: 'Weighed in the warehouse' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ reviewState: 'approved', version: before.version + 1 });
    expect(variantOf(res.json())).toMatchObject({ weightGrams: 250, lengthCm: 20, widthCm: null, listPrice: usd(19900) });
    expect(res.json().reviewLog).toContainEqual(
      expect.objectContaining({ action: 'variant_details_changed', reason: 'Weighed in the warehouse', fields: expect.objectContaining({ variantId, weightGrams: '250', listPrice: '19900 USD' }) }),
    );
    expect(t.eventsNamed('catalog.product.updated').map((e) => e.payload)).toEqual([{ productId: id, version: before.version + 1, title: before.product.title }]);
    expect(t.stubs.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'catalog.variant.details_update', before: expect.objectContaining({ weightGrams: null }), after: expect.objectContaining({ weightGrams: 250, listPrice: usd(19900) }) }),
    );

    const cleared = await a.admin('PATCH', `/products/${id}/variants/${variantId}`, { listPrice: null, reason: 'MSRP withdrawn' });
    expect(variantOf(cleared.json())).toMatchObject({ weightGrams: 250, listPrice: null });

    // the same values change nothing
    t.events.length = 0;
    const same = await a.admin('PATCH', `/products/${id}/variants/${variantId}`, { weightGrams: 250, reason: 'Same' });
    expect(same.json().version).toBe(cleared.json().version);
    expect(t.eventsNamed('catalog.product.updated')).toHaveLength(0);

    // other modules read them
    expect(await t.catalog.getParcels([variantId])).toEqual({ [variantId]: { weightGrams: 250, lengthCm: 20, widthCm: null, heightCm: null } });
    const unknown = newId();
    expect((await t.catalog.getParcels([unknown]))[unknown]).toBeNull();
    expect(await t.catalog.getVariants([variantId, unknown])).toEqual([
      expect.objectContaining({ id: variantId, productId: id, productTitle: before.product.title, options: { Color: 'Black' }, weightGrams: 250, lengthCm: 20, listPrice: null }),
    ]);
  });

  it('requires catalog.products.review', async () => {
    const { id } = await sellerProduct(t, newId(), { brandId, categoryId: child.id });
    const variantId = variantOf((await a.admin('GET', `/products/${id}`)).json()).id;
    const { auth, callers } = await import('./helpers.js');
    const res = await a.admin('PATCH', `/products/${id}/variants/${variantId}`, { weightGrams: 1, reason: 'x' }, auth(callers.staff(['catalog.products.edit'])));
    expect(res.statusCode).toBe(403);
  });
});

describe('public API for other modules', () => {
  it('getProducts, searchProducts, listProductIds, getBrands and getCategoryPaths', async () => {
    const sellerId = newId();
    const approved = await sellerProduct(t, sellerId, { brandId, categoryId: child.id, approve: true, title: 'Halden Pulse earbuds', model: 'HP-77' });
    const draft = await sellerProduct(t, sellerId, { brandId, categoryId: child.id, title: 'Halden Pulse case' });

    const records = await t.catalog.getProducts([draft.id, approved.id, newId()]);
    expect(records.map((r) => [r.product.id, r.reviewState, r.publication, r.purchasable, r.ownerSellerId, r.mergedIntoId])).toEqual([
      [draft.id, 'submitted', 'active', false, sellerId, null],
      [approved.id, 'approved', 'active', true, sellerId, null],
    ]);
    await expect(t.catalog.getProducts(Array.from({ length: 201 }, () => newId()))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    const byTitle = await t.catalog.searchProducts({ q: 'Halden Pulse' }, { limit: 10 });
    expect(byTitle.items.map((p) => p.id).sort()).toEqual([approved.id, draft.id].sort());
    expect((await t.catalog.searchProducts({ q: 'Halden Pulse', purchasableOnly: true }, { limit: 10 })).items.map((p) => p.id)).toEqual([approved.id]);
    expect((await t.catalog.searchProducts({ q: 'HP-77' }, { limit: 10 })).items.map((p) => p.id)).toEqual([approved.id]);
    const gtin = (await t.catalog.getProduct(approved.id))!.variants[0]!.gtin!;
    expect((await t.catalog.searchProducts({ q: gtin }, { limit: 10 })).items.map((p) => p.id)).toEqual([approved.id]);
    expect((await t.catalog.searchProducts({ categoryId: cat.id, reviewStates: ['submitted'] }, { limit: 50 })).items.map((p) => p.id)).toContain(draft.id); // subcategories count

    const walk: string[] = [];
    let after: string | null = null;
    do {
      const page: { ids: string[]; nextAfter: string | null } = await t.catalog.listProductIds({ ...(after ? { after } : {}), limit: 2 });
      walk.push(...page.ids);
      after = page.nextAfter;
    } while (after);
    expect(walk).toEqual([...walk].sort());
    expect(walk).toEqual(expect.arrayContaining([approved.id, draft.id]));
    const live = await t.catalog.listProductIds({ limit: 1000, purchasableOnly: true });
    expect(live.ids).toContain(approved.id);
    expect(live.ids).not.toContain(draft.id);
    expect(live.nextAfter).toBeNull();

    const requested = await t.catalog.getBrands([brandId, newId()]);
    expect(requested).toEqual([expect.objectContaining({ id: brandId, name: 'Halden', status: 'active' })]);

    expect(await t.catalog.getCategoryPaths([child.id, newId()])).toEqual({ [child.id]: { categoryId: child.id, names: ['Audio', 'Earbuds'], ids: [cat.id, child.id] } });
  });

  it('snapshotForOrder keeps the main image as a media id and a MediaRef', async () => {
    const { id, image } = await sellerProduct(t, newId(), { brandId, categoryId: child.id, approve: true });
    const variantId = (await t.catalog.getProduct(id))!.variants[0]!.id;
    const snap = await t.catalog.snapshotForOrder(variantId);
    expect(snap).toMatchObject({ productId: id, variantId, imageId: image, image: expect.objectContaining({ id: image }) });
    expect(snap.imageUrl).toBe(snap.image!.url);
  });
});

describe('review target setting', () => {
  it('reviewTargetBusinessDays sets the review deadline and the expected date (one business day later)', async () => {
    const apis = t.app.kernel.boot.apis as Map<string, unknown>;
    apis.set('settings', { get: async (key: string) => (key === 'catalog.reviewTargetBusinessDays' ? 3 : undefined) });
    try {
      const { id } = await sellerProduct(t, newId(), { brandId, categoryId: child.id });
      const sub = (await a.admin('GET', `/products/${id}`)).json().submission;
      const at = new Date(sub.submittedAt);
      expect(sub.reviewDeadline.dueAt).toBe(addBusinessDays(at, 3).toISOString());
      expect(sub.expectedReviewBy).toBe(addBusinessDays(at, 4).toISOString());
      expect(t.eventsNamed('catalog.product.submitted').at(-1)!.payload).toMatchObject({ productId: id, reviewDueAt: sub.reviewDeadline.dueAt });
    } finally {
      apis.delete('settings');
    }
  });
});

describe('trust enforcement reversal', () => {
  const enforcement = (id: string, extra: Record<string, unknown> = {}) => ({
    enforcementId: newId(),
    reportId: newId(),
    action: 'suspend_product',
    ownerTeam: 'catalog',
    targets: [{ type: 'product', id, label: 'x' }],
    reason: 'Counterfeit confirmed',
    params: {},
    alreadyApplied: false,
    ...extra,
  });
  const reversal = (e: ReturnType<typeof enforcement>, extra: Record<string, unknown> = {}) => ({
    enforcementId: e.enforcementId,
    ref: 'EN-261010-0001',
    reportId: e.reportId,
    reportRef: 'TR-261010-0001',
    action: e.action,
    ownerTeam: 'catalog',
    targets: e.targets,
    params: {},
    executionState: 'applied',
    reason: 'Appeal upheld: invoices prove authenticity',
    reversedBy: { kind: 'staff', id: newId(), name: 'Mara Ellis' },
    reversedAt: new Date().toISOString(),
    ...extra,
  });

  it('reactivates a product the reversed enforcement suspended (no override approval), once', async () => {
    const { id } = await sellerProduct(t, newId(), { brandId, categoryId: child.id, approve: true });
    const e = enforcement(id);
    t.app.kernel.events.publish('trust', 'trust.enforcement.recorded', e);
    await t.app.kernel.events.drain();
    const log = (await a.admin('GET', `/products/${id}`)).json().reviewLog.filter((l: { action: string }) => l.action === 'publication_changed');
    expect(log.at(-1).fields).toMatchObject({ to: 'suspended', enforcementId: e.enforcementId, trustReportId: e.reportId });
    t.events.length = 0;
    t.stubs.access.check.mockClear();

    t.app.kernel.events.publish('trust', 'trust.enforcement.reversed', reversal(e));
    t.app.kernel.events.publish('trust', 'trust.enforcement.reversed', reversal(e)); // redelivered
    await t.app.kernel.events.drain();
    const after = (await a.admin('GET', `/products/${id}`)).json();
    expect(after.publication).toBe('active');
    expect(t.stubs.access.check).not.toHaveBeenCalled();
    expect(t.eventsNamed('catalog.product.publication_changed').map((x) => x.payload)).toEqual([
      { productId: id, from: 'suspended', to: 'active', reason: 'Trust and Risk enforcement EN-261010-0001 reversed: Appeal upheld: invoices prove authenticity', trustReportId: e.reportId, trustEnforcementId: e.enforcementId },
    ]);
    expect(await t.catalog.isPurchasable(id)).toBe(true);
  });

  it('leaves alone a product suspended again since, and ignores other actions', async () => {
    const { id } = await sellerProduct(t, newId(), { brandId, categoryId: child.id, approve: true });
    const e = enforcement(id);
    t.app.kernel.events.publish('trust', 'trust.enforcement.recorded', e);
    await t.app.kernel.events.drain();
    // staff reactivate (approval allowed), then a second enforcement suspends it again
    t.stubs.access.check.mockResolvedValueOnce({ decision: 'allowed', action: 'x', reason: 'ok', requiresSecondReviewer: false, approvalsNeeded: 0, eligibleApproverRoles: [], eligibleApprovers: [] });
    expect((await a.admin('POST', `/products/${id}/publication`, { publication: 'active', reason: 'Cleared' })).statusCode).toBe(200);
    const second = enforcement(id);
    t.app.kernel.events.publish('trust', 'trust.enforcement.recorded', second);
    await t.app.kernel.events.drain();
    t.events.length = 0;

    t.app.kernel.events.publish('trust', 'trust.enforcement.reversed', reversal(e));
    t.app.kernel.events.publish('trust', 'trust.enforcement.reversed', reversal(second, { action: 'suspend_offer' }));
    await t.app.kernel.events.drain();
    expect((await a.admin('GET', `/products/${id}`)).json().publication).toBe('suspended');
    expect(t.eventsNamed('catalog.product.publication_changed')).toHaveLength(0);
  });
});

describe('media usage kinds', () => {
  it('attaches brand banners, category images and correction evidence under their own kinds', async () => {
    const media = t.app.kernel.boot.apis.get('media') as { attach: (...args: unknown[]) => Promise<unknown> };
    const attach = vi.spyOn(media, 'attach');
    try {
      const banner = await uploadImage(t, 'staff', { purpose: 'content_image' });
      const b = await a.admin('POST', '/brands', { name: 'Bannered', bannerId: banner });
      expect(b.statusCode, b.body).toBe(201);
      const tile = await uploadImage(t, 'staff', { purpose: 'content_image' });
      const c = await a.admin('POST', '/categories', { name: 'Tiled', imageId: tile });
      expect(c.statusCode, c.body).toBe(201);
      const sellerId = newId();
      const { id } = await sellerProduct(t, newId(), { brandId, categoryId: child.id, approve: true });
      const evidence = await uploadImage(t, { sellerId });
      const s = await a.seller(sellerId, 'POST', `/products/${id}/corrections`, { field: 'title', proposed: 'Halden Pulse 2 earbuds', evidenceIds: [evidence] });
      expect(s.statusCode, s.body).toBe(201);
      const kinds = attach.mock.calls.map((call) => [call[0], (call[1] as { kind: string }).kind]);
      expect(kinds).toEqual(expect.arrayContaining([[banner, 'brand_banner'], [tile, 'category_image'], [evidence, 'correction_evidence']]));
    } finally {
      attach.mockRestore();
    }
  });
});
