/** Drafts, submission (missing information, checks, brand requests), reviewer decisions, review queue and record scope. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { api, auth, brand, callers, catalogApp, category, ean, newId, productInput, sellerProduct, uploadImage, type CatalogTestApp } from './helpers.js';

let t: CatalogTestApp;
let a: ReturnType<typeof api>;
let cat: { id: string; slug: string };
let brandId: string;
beforeAll(async () => {
  t = await catalogApp();
  a = api(t);
  cat = await category(t, 'Headphones');
  await a.admin('PUT', `/categories/${cat.id}/attributes`, {
    attributes: [{ id: newId(), categoryId: cat.id, name: 'Battery life', kind: 'text', options: [], required: true, filterable: true, variantDefining: false }],
    imageRules: [{ text: 'Minimum 1000 × 1000 px', severity: 'blocking', check: { minWidth: 1000, minHeight: 1000 } }],
  });
  brandId = (await brand(t, 'Aurora')).id;
});
afterAll(async () => {
  await t?.app.close();
});
beforeEach(() => {
  t.events.length = 0;
  t.stubs.audit.record.mockClear();
  t.stubs.sellers.canSell.mockClear();
});

describe('seller drafts', () => {
  it('creates a draft with a reference, attaches images, computes missing and the content score', async () => {
    const sellerId = newId();
    const image = await uploadImage(t, { sellerId });
    const res = await a.seller(sellerId, 'POST', '/products', { title: 'Aurora ANC 700', categoryId: cat.id, imageIds: [image] });
    expect(res.statusCode, res.body).toBe(201);
    const p = res.json();
    expect(p).toMatchObject({ owner: 'seller', ownerSellerId: sellerId, reviewState: 'draft', publication: 'active', version: 1, checks: [], submission: null });
    expect(p.product.ref).toMatch(/^PRD-\d{5}$/);
    expect(p.product.images).toEqual([expect.objectContaining({ id: image })]);
    expect(p.missing).toEqual(expect.arrayContaining(['Brand', 'Description of at least 40 characters', 'At least one variant', 'Battery life']));
    expect(p.contentScore).toBeGreaterThan(0);
    expect(p.contentScore).toBeLessThan(100);
    const media = t.app.kernel.boot.apis.get('media') as unknown as { getAsset(id: string): Promise<{ inUse: boolean }> };
    expect((await media.getAsset(image)).inUse).toBe(true);

    // replacing the image detaches the old one
    const other = await uploadImage(t, { sellerId });
    const upd = await a.seller(sellerId, 'PATCH', `/products/${p.product.id}`, { title: 'Aurora ANC 700', imageIds: [other] });
    expect(upd.statusCode, upd.body).toBe(200);
    expect(upd.json().version).toBe(2);
    expect((await media.getAsset(image)).inUse).toBe(false);
  });

  it("refuses another seller's images and unknown files", async () => {
    const mine = newId();
    const theirs = await uploadImage(t, { sellerId: newId() });
    const res = await a.seller(mine, 'POST', '/products', { title: 'Copycat', imageIds: [theirs] });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('ASSET_NOT_OWNED');
    const unknown = await a.seller(mine, 'POST', '/products', { title: 'Ghost', imageIds: [newId()] });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error.details.issues[0].path).toBe('imageIds');
  });

  it("validates variants, GTIN reuse and brands that can't be chosen", async () => {
    const sellerId = newId();
    const twin = await a.seller(sellerId, 'POST', '/products', { title: 'Twins', variants: [{ options: { Color: 'Red' } }, { options: { color: 'red' } }] });
    expect(twin.statusCode).toBe(400);
    const gtin = ean(990001);
    expect((await a.seller(sellerId, 'POST', '/products', { title: 'First', variants: [{ options: { Color: 'Red' }, gtin }] })).statusCode).toBe(201);
    const reused = await a.seller(newId(), 'POST', '/products', { title: 'Second', variants: [{ options: { Color: 'Red' }, gtin }] });
    expect(reused.statusCode).toBe(400);
    expect(reused.json().error.message).toMatch(/already used by PRD-/);
    const blocked = await brand(t, 'Blocked Brand');
    await a.admin('POST', `/brands/${blocked.id}/status`, { status: 'blocked', reason: 'Counterfeits' });
    const res = await a.seller(sellerId, 'POST', '/products', { title: 'Fake', brandId: blocked.id });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('BRAND_NOT_ACTIVE');
    expect((await a.seller(sellerId, 'POST', '/products', { title: 'Both', brandId, requestedBrand: { name: 'New' } })).statusCode).toBe(400);
  });

  it("record scope: another seller's draft is 404 for reading, editing and submitting", async () => {
    const owner = newId();
    const id = (await a.seller(owner, 'POST', '/products', { title: 'Private draft' })).json().product.id;
    const stranger = newId();
    expect((await a.seller(stranger, 'GET', `/products/${id}`)).statusCode).toBe(404);
    expect((await a.seller(stranger, 'PATCH', `/products/${id}`, { title: 'Mine now' })).statusCode).toBe(404);
    expect((await a.seller(stranger, 'POST', `/products/${id}/submit`, {})).statusCode).toBe(404);
    expect((await a.seller(stranger, 'GET', '/products')).json().items).toEqual([]);
    expect((await a.seller(owner, 'GET', '/products?reviewState=draft')).json().items.map((p: { product: { id: string } }) => p.product.id)).toEqual([id]);
    expect(await t.catalog.getProductForSeller(stranger, id)).toBeNull();
  });

  it('a restriction on product submissions blocks new drafts and submissions', async () => {
    const sellerId = newId();
    t.stubs.sellers.canSell.mockResolvedValueOnce({ allowed: false, reason: 'Product submissions blocked in Headphones until Oct 30', restrictionId: newId() });
    const res = await a.seller(sellerId, 'POST', '/products', { title: 'Blocked', categoryId: cat.id });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toMatch(/blocked in Headphones/);
    expect(t.stubs.sellers.canSell).toHaveBeenCalledWith(sellerId, { activity: 'product_submissions', categoryId: cat.id });
  });
});

describe('submission', () => {
  it('lists what is missing (VALIDATION_FAILED with details.missing), including GTINs unless noGtin', async () => {
    const sellerId = newId();
    const image = await uploadImage(t, { sellerId });
    const input = productInput({ brandId, categoryId: cat.id, imageIds: [image], extra: { variants: [{ options: { Color: 'Black' } }], specs: {} } });
    const id = (await a.seller(sellerId, 'POST', '/products', input)).json().product.id;
    const res = await a.seller(sellerId, 'POST', `/products/${id}/submit`, {});
    expect(res.statusCode).toBe(400);
    expect(res.json().error.details.missing).toEqual(['GTIN on every variant', 'Battery life']);
    await a.seller(sellerId, 'PATCH', `/products/${id}`, { title: input.title, noGtin: true, specs: { 'battery life': '30 h' } });
    const ok = await a.seller(sellerId, 'POST', `/products/${id}/submit`, {});
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ reviewState: 'submitted', missing: [], contentScore: expect.any(Number), checks: [] }); // checks are staff only
  });

  it('creates a submission (SUB ref, kind new, deadlines), runs the checks and publishes catalog.product.submitted', async () => {
    const sellerId = newId();
    const { id } = await sellerProduct(t, sellerId, { brandId, categoryId: cat.id });
    const admin = (await a.admin('GET', `/products/${id}`)).json();
    expect(t.eventsNamed('catalog.product.submitted').map((e) => e.payload)).toEqual([
      { productId: id, ownerSellerId: sellerId, submissionId: admin.submission.id, ref: admin.submission.ref, kind: 'new', title: admin.product.title, reviewDueAt: admin.submission.reviewDeadline.dueAt },
    ]);
    expect(admin.submission).toMatchObject({ ref: expect.stringMatching(/^SUB-\d{6}-\d{4}$/), kind: 'new', state: 'open', note: 'First submission', submittedBy: { kind: 'seller' } });
    expect(admin.submission.reviewDeadline.state).toBe('on_time');
    expect(admin.checks.map((c: { kind: string }) => c.kind)).toEqual(['duplicate', 'image_standard', 'category_fit', 'prohibited_claim', 'brand_authorization', 'restricted_item', 'identifier']);
    expect(admin.checks.find((c: { kind: string }) => c.kind === 'image_standard').result).toBe('pass');
    expect(admin.reviewLog).toEqual([expect.objectContaining({ action: 'submitted', reason: 'First submission' })]);
    // submitting again is an illegal transition
    expect((await a.seller(sellerId, 'POST', `/products/${id}/submit`, {})).statusCode).toBe(409);
    // and a submitted product can't be edited
    expect((await a.seller(sellerId, 'PATCH', `/products/${id}`, { title: 'Changed' })).statusCode).toBe(409);
  });

  it('flags claims, small images, invalid GTINs and duplicates (advisory); a duplicate can be dismissed', async () => {
    const first = await sellerProduct(t, newId(), { brandId, categoryId: cat.id, model: 'ZX-900', approve: true });
    const sellerId = newId();
    // above the product image spec (800 × 800, checked at upload) but under the category's 1000 × 1000
    const small = await uploadImage(t, { sellerId }, { width: 900, height: 900 });
    const input = productInput({ brandId, categoryId: cat.id, imageIds: [small], model: 'zx 900', gtin: '4000000000001', extra: { description: 'FDA approved headphones that cure headaches, the best in the world for everyone.' } });
    const id = (await a.seller(sellerId, 'POST', '/products', input)).json().product.id;
    expect((await a.seller(sellerId, 'POST', `/products/${id}/submit`, {})).statusCode).toBe(200);
    const admin = (await a.admin('GET', `/products/${id}`)).json();
    const check = (k: string) => admin.checks.find((c: { kind: string }) => c.kind === k);
    expect(check('prohibited_claim')).toMatchObject({ result: 'fail', evidence: expect.arrayContaining([expect.objectContaining({ field: 'description', text: 'FDA approved' })]) });
    expect(check('image_standard').result).toBe('fail');
    expect(check('identifier').result).toBe('fail');
    // the model number matches (ZX-900 = zx 900); earlier products with the same brand and title words match too
    expect(check('duplicate')).toMatchObject({ result: 'warn', evidence: expect.arrayContaining([expect.objectContaining({ matchedProductId: first.id, field: 'modelNumber', score: 0.95 })]) });
    expect(admin.duplicateSuspected).toBe(true);
    expect(admin.duplicateCandidates.map((d: { id: string }) => d.id)).toContain(first.id);
    expect((await a.admin('GET', '/products?duplicateSuspected=true')).json().items.map((p: { product: { id: string } }) => p.product.id)).toContain(id);

    const dismissed = await a.admin('POST', `/products/${id}/checks/duplicate/dismiss`, { reason: 'Different bundle', matchedProductId: first.id });
    expect(dismissed.statusCode, dismissed.body).toBe(200);
    // one candidate dismissed: the others stay open
    expect(dismissed.json().duplicateCandidates.map((d: { id: string }) => d.id)).not.toContain(first.id);
    expect(dismissed.json().duplicateSuspected).toBe(dismissed.json().duplicateCandidates.length > 0);
    expect(dismissed.json().reviewLog.at(-1)).toMatchObject({ action: 'check_dismissed', reason: 'Different bundle', fields: { check: 'duplicate', matchedProductId: first.id } });
    expect(t.stubs.audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'catalog.product.check_dismiss' }));
    expect((await a.admin('POST', `/products/${id}/checks/duplicate/dismiss`, { reason: 'x', matchedProductId: newId() })).statusCode).toBe(404);
    // the whole finding dismissed
    const all = await a.admin('POST', `/products/${id}/checks/duplicate/dismiss`, { reason: 'Not a duplicate' });
    expect(all.json()).toMatchObject({ duplicateSuspected: false, duplicateCandidates: [] });
    expect(all.json().checks.find((c: { kind: string }) => c.kind === 'duplicate').dismissal).toMatchObject({ reason: 'Not a duplicate', matchedProductId: null, by: { kind: 'staff' } });
    expect((await a.admin('GET', '/products?duplicateSuspected=true')).json().items.map((p: { product: { id: string } }) => p.product.id)).not.toContain(id);
  });

  it('a requested brand becomes an under_review brand (catalog.brand.requested); approval waits for the brand', async () => {
    const sellerId = newId();
    const image = await uploadImage(t, { sellerId });
    const input = productInput({ categoryId: cat.id, imageIds: [image], extra: { requestedBrand: { name: 'Fjord Sound', website: 'https://fjord.example', note: 'Direct importer' } } });
    const draft = await a.seller(sellerId, 'POST', '/products', input);
    expect(draft.json().requestedBrand).toMatchObject({ name: 'Fjord Sound' });
    expect(draft.json().missing).not.toContain('Brand');
    const id = draft.json().product.id;
    expect((await a.seller(sellerId, 'POST', `/products/${id}/submit`, {})).statusCode).toBe(200);
    const requested = t.eventsNamed('catalog.brand.requested')[0]!.payload as { brandId: string };
    expect(requested).toMatchObject({ name: 'Fjord Sound', sellerId, productId: id });
    // the seller sees its own request in the form; others do not
    expect((await a.seller(sellerId, 'GET', '/brands?q=fjord')).json().items).toHaveLength(1);
    expect((await a.seller(newId(), 'GET', '/brands?q=fjord')).json().items).toHaveLength(0);
    const waiting = (await a.admin('GET', '/brands?status=under_review&requested=true')).json().items;
    expect(waiting.find((b: { brand: { id: string } }) => b.brand.id === requested.brandId).requestedBy).toMatchObject({ sellerId, productId: id });

    const blocked = await a.admin('POST', `/products/${id}/approve`, {});
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe('BRAND_NOT_ACTIVE');
    await a.admin('POST', `/brands/${requested.brandId}/status`, { status: 'active', reason: 'Verified importer' });
    expect((await a.admin('POST', `/products/${id}/approve`, {})).statusCode).toBe(200);
  });

  it('blocking a requested brand returns the submission with changes requested', async () => {
    const sellerId = newId();
    const image = await uploadImage(t, { sellerId });
    const id = (await a.seller(sellerId, 'POST', '/products', productInput({ categoryId: cat.id, imageIds: [image], extra: { requestedBrand: { name: 'Knockoff Beats' } } }))).json().product.id;
    await a.seller(sellerId, 'POST', `/products/${id}/submit`, {});
    const brandReq = t.eventsNamed('catalog.brand.requested')[0]!.payload as { brandId: string };
    await a.admin('POST', `/brands/${brandReq.brandId}/status`, { status: 'blocked', reason: 'Imitation of a protected brand' });
    const p = (await a.seller(sellerId, 'GET', `/products/${id}`)).json();
    expect(p.reviewState).toBe('changes_requested');
    expect(p.reviewLog.at(-1)).toMatchObject({ action: 'changes_requested', reason: expect.stringContaining('Imitation'), fields: { brandId: expect.any(String) } });
    expect(t.eventsNamed('catalog.product.changes_requested')).toHaveLength(1);
  });
});

describe('reviewer decisions', () => {
  it('approve: listed, events, audit, review drafts cleared; approving twice is 409', async () => {
    const sellerId = newId();
    const { id } = await sellerProduct(t, sellerId, { brandId, categoryId: cat.id });
    const draft = await a.admin('PUT', `/products/${id}/review-draft`, { decision: 'approve', reason: 'Looks good', fields: { title: 'ok' } });
    expect(draft.statusCode, draft.body).toBe(200);
    expect(draft.json()).toMatchObject({ decision: 'approve', reason: 'Looks good', fields: { title: 'ok' }, savedBy: { kind: 'staff', id: t.staffId } });
    const view = (await a.admin('GET', `/products/${id}`)).json();
    expect(view.reviewDraft).toMatchObject({ decision: 'approve' });
    expect(view.submission.assignee).toMatchObject({ kind: 'staff', id: t.staffId });

    const res = await a.admin('POST', `/products/${id}/approve`, { note: 'Clean listing' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ reviewState: 'approved', reviewDraft: null, submission: { state: 'decided' } });
    expect(res.json().product.listedAt).toEqual(expect.any(String));
    expect(t.eventsNamed('catalog.product.approved').map((e) => e.payload)).toEqual([{ productId: id, ownerSellerId: sellerId }]);
    expect(t.stubs.audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'catalog.product.approved', target: expect.objectContaining({ type: 'product', id, sellerId }) }));
    expect(await t.catalog.isPurchasable(id)).toBe(true);
    expect((await a.store(`/products/${id}`)).statusCode).toBe(200);
    const again = await a.admin('POST', `/products/${id}/approve`, {});
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('ILLEGAL_TRANSITION');
    expect((await a.admin('PUT', `/products/${id}/review-draft`, { decision: 'reject' })).statusCode).toBe(409);
  });

  it('request changes → edit → resubmitted; reject needs a reason', async () => {
    const sellerId = newId();
    const { id } = await sellerProduct(t, sellerId, { brandId, categoryId: cat.id });
    expect((await a.admin('POST', `/products/${id}/request-changes`, { reason: ' ', fields: {} })).statusCode).toBe(400);
    const res = await a.admin('POST', `/products/${id}/request-changes`, { reason: 'Fix the photos', fields: { imageIds: 'Use a white background' } });
    expect(res.json().reviewState).toBe('changes_requested');
    expect(t.eventsNamed('catalog.product.changes_requested').map((e) => e.payload)).toEqual([{ productId: id, ownerSellerId: sellerId, reason: 'Fix the photos', fields: { imageIds: 'Use a white background' } }]);
    const edit = await a.seller(sellerId, 'PATCH', `/products/${id}`, { title: 'Aurora wireless headphones (white)' });
    expect(edit.statusCode).toBe(200);
    expect(edit.json().submission).toMatchObject({ state: 'decided', lastSavedBy: { kind: 'seller' } });
    const re = await a.seller(sellerId, 'POST', `/products/${id}/submit`, { note: 'New photos' });
    expect(re.json().submission).toMatchObject({ kind: 'resubmitted', state: 'open', note: 'New photos' });
    expect((await a.admin('POST', `/products/${id}/reject`, { reason: '' })).statusCode).toBe(400);
    const rejected = await a.admin('POST', `/products/${id}/reject`, { reason: 'Not a real product' });
    expect(rejected.json().reviewState).toBe('rejected');
    expect(t.eventsNamed('catalog.product.rejected').at(-1)!.payload).toEqual({ productId: id, ownerSellerId: sellerId, reason: 'Not a real product' });
    expect((await a.seller(sellerId, 'POST', `/products/${id}/submit`, {})).statusCode).toBe(409);
  });

  it('review queue: open submissions by deadline; kind and category filters; paused submissions leave the queue', async () => {
    const sellerId = newId();
    const one = await sellerProduct(t, sellerId, { brandId, categoryId: cat.id });
    t.clock.advance(60_000);
    const two = await sellerProduct(t, newId(), { brandId, categoryId: cat.id });
    const queue = (await a.admin('GET', '/review-queue?limit=100')).json();
    const ids = queue.items.map((p: { product: { id: string } }) => p.product.id);
    expect(ids.indexOf(one.id)).toBeLessThan(ids.indexOf(two.id));
    expect((await a.admin('GET', '/review-queue?kind=resubmitted&limit=100')).json().items.map((p: { product: { id: string } }) => p.product.id)).not.toContain(one.id);
    expect((await a.admin('GET', `/review-queue?categoryId=${newId()}`)).json().items).toEqual([]);

    // seller suspended: its submissions pause; reinstated: they come back
    t.app.kernel.events.publish('sellers', 'sellers.seller.suspended', { sellerId, suspensionId: newId(), reasonCode: 'fraud', reason: 'Investigation', reviewDate: '2026-11-01', openOrders: 'seller_keeps_fulfilling', appealDeadline: new Date().toISOString() });
    await t.app.kernel.events.drain();
    const paused = (await a.admin('GET', '/review-queue?limit=100')).json().items.map((p: { product: { id: string } }) => p.product.id);
    expect(paused).not.toContain(one.id);
    expect(paused).toContain(two.id);
    expect((await t.catalog.countProductsForSellers([sellerId]))[sellerId]).toMatchObject({ inReview: 1, pausedSubmissions: 1, submissionsBlocked: false });
    t.app.kernel.events.publish('sellers', 'sellers.seller.reinstated', { sellerId, from: 'suspended', to: 'approved', endedSuspensionId: newId(), remainingRestrictionIds: [] });
    await t.app.kernel.events.drain();
    expect((await a.admin('GET', '/review-queue?limit=100')).json().items.map((p: { product: { id: string } }) => p.product.id)).toContain(one.id);

    // a restriction on another activity changes nothing; one on product submissions pauses
    const base = { sellerId, restrictionId: newId(), reasonCode: 'quality', reason: 'Late dispatch', scope: {}, categoryIds: [], appealRoute: 'Seller Manager', appealDeadline: new Date().toISOString(), reviewDate: '2026-11-01' };
    t.app.kernel.events.publish('sellers', 'sellers.seller.restricted', { ...base, affectedActivities: ['new_offers'] });
    await t.app.kernel.events.drain();
    expect((await t.catalog.countProductsForSellers([sellerId]))[sellerId]!.pausedSubmissions).toBe(0);
    t.app.kernel.events.publish('sellers', 'sellers.seller.restricted', { ...base, affectedActivities: ['product_submissions'], categoryIds: [cat.id] });
    await t.app.kernel.events.drain();
    expect((await t.catalog.countProductsForSellers([sellerId]))[sellerId]!.pausedSubmissions).toBe(1);
    expect((await a.admin('GET', '/products/stats')).json()).toMatchObject({ all: expect.any(Number), inReview: expect.any(Number), missingContent: expect.any(Number) });
  });
});

describe('Official Store products', () => {
  it('staff create, submit and approve; editing an approved product sends it back to review (content_change)', async () => {
    const image = await uploadImage(t, 'staff');
    const created = await a.admin('POST', '/products', productInput({ brandId, categoryId: cat.id, imageIds: [image] }));
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json()).toMatchObject({ owner: 'official', ownerSellerId: null, reviewState: 'draft' });
    const id = created.json().product.id;
    // sellers can't reach Official Store drafts
    expect((await a.seller(newId(), 'GET', `/products/${id}`)).statusCode).toBe(404);
    const sub = await a.admin('POST', `/products/${id}/submit`);
    expect(sub.statusCode, sub.body).toBe(200);
    expect(t.eventsNamed('catalog.product.submitted').map((e) => e.payload)).toContainEqual(expect.objectContaining({ productId: id, ownerSellerId: null, kind: 'new' }));
    // whoever created and submitted it does not approve it
    const own = await a.admin('POST', `/products/${id}/approve`, {});
    expect(own.statusCode).toBe(409);
    expect(own.json().error.code).toBe('SAME_REVIEWER');
    await a.admin('POST', `/products/${id}/approve`, {}, auth(callers.staff())); // a second person approves
    t.events.length = 0;
    const edit = await a.admin('PATCH', `/products/${id}`, { title: 'Aurora wireless headphones, 2nd gen' });
    expect(edit.statusCode, edit.body).toBe(200);
    expect(edit.json()).toMatchObject({ reviewState: 'submitted', submission: { kind: 'content_change', state: 'open' } });
    expect(t.eventsNamed('catalog.product.updated')).toHaveLength(1);
    expect(t.eventsNamed('catalog.product.submitted')).toHaveLength(1);
    // the official routes don't reach seller products
    const sellerOwned = await sellerProduct(t, newId(), { brandId, categoryId: cat.id });
    expect((await a.admin('PATCH', `/products/${sellerOwned.id}`, { title: 'x' })).statusCode).toBe(404);
  });

  it('requires the permissions the spec names', async () => {
    const noPerm = auth(callers.staff(['catalog.products.review']));
    expect((await a.admin('POST', '/products', { title: 'x' }, noPerm)).statusCode).toBe(403);
  });
});

describe('brand rules at approval', () => {
  it('does not approve a submission from a seller the brand does not authorize', async () => {
    const listed = await brand(t, 'Listed Only', { sellingPolicy: 'authorized_list', authorizedSellerIds: [] });
    const { id } = await sellerProduct(t, newId(), { brandId: listed.id, categoryId: cat.id });
    const res = await a.admin('POST', `/products/${id}/approve`, {}, auth(callers.staff()));
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('BRAND_NOT_AUTHORIZED');
  });
});
