/** Media library, record scope, edits, deletion rules, image checks, downloads, takedown and restore. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { auth, callers, mediaApp, pdf, png, uploadFile, type MediaTestApp } from './helpers.js';

let t: MediaTestApp;
beforeAll(async () => {
  t = await mediaApp();
});
afterAll(async () => {
  await t?.app.close();
});

const get = (url: string, token: string) => t.app.inject({ method: 'GET', url, headers: auth(token) });
const send = (method: 'POST' | 'PATCH' | 'DELETE', url: string, token: string, payload?: unknown) =>
  t.app.inject({ method, url, headers: auth(token), ...(payload === undefined ? {} : { payload: payload as object }) });

describe('record scope', () => {
  it("another seller's or customer's file is 404, never 403", async () => {
    const sellerId = newId();
    const mine = callers.seller({ sellerId });
    const { asset } = await uploadFile(t, 'seller', mine, { purpose: 'product_image', body: png(1000, 1000, { seed: 'scope' }) });
    // any member of the same seller reaches it
    expect((await get(`/api/seller/media/assets/${asset.id}`, callers.seller({ sellerId }))).statusCode).toBe(200);
    for (const [method, path] of [
      ['GET', ''],
      ['PATCH', ''],
      ['DELETE', ''],
      ['GET', '/download'],
      ['POST', '/checks'],
    ] as const) {
      const res = await t.app.inject({ method, url: `/api/seller/media/assets/${asset.id}${path}`, headers: auth(callers.seller()), ...(method === 'GET' || method === 'DELETE' ? {} : { payload: method === 'POST' ? { rules: { aspectRatios: [], formats: [] } } : {} }) });
      expect(res.statusCode, `${method} ${path}`).toBe(404);
    }
    const customer = callers.customer({ accountId: newId() });
    const photo = await uploadFile(t, 'store', customer, { purpose: 'review_photo', body: png(900, 900, { seed: 'review' }) });
    expect((await get(`/api/store/media/assets/${photo.asset.id}`, customer)).statusCode).toBe(200);
    expect((await get(`/api/store/media/assets/${photo.asset.id}`, callers.customer())).statusCode).toBe(404);
    expect((await get(`/api/store/media/assets/${photo.asset.id}`, callers.visitor())).statusCode).toBe(404);
    expect((await get(`/api/store/media/assets/${asset.id}`, customer)).statusCode).toBe(404);
  });

  it('guests reach the uploads of their own guest session', async () => {
    const guest = callers.visitor();
    const { asset } = await uploadFile(t, 'store', guest, { purpose: 'case_evidence', body: png(800, 600, { seed: 'guest' }) });
    expect((await get(`/api/store/media/assets/${asset.id}`, guest)).json()).toMatchObject({ id: asset.id, owner: { kind: 'guest' } });
    expect((await get(`/api/store/media/assets/${asset.id}`, callers.visitor())).statusCode).toBe(404);
  });
});

describe('seller media library', () => {
  it('lists only the seller’s files, with filters', async () => {
    const sellerId = newId();
    const seller = callers.seller({ sellerId });
    const a = await uploadFile(t, 'seller', seller, { purpose: 'product_image', fileName: 'red-shoe.png', body: png(1000, 1000, { seed: 'lib-a' }) });
    const b = await uploadFile(t, 'seller', seller, { purpose: 'store_logo', fileName: 'logo.png', body: png(600, 600, { seed: 'lib-b' }) });
    await uploadFile(t, 'seller', callers.seller(), { purpose: 'product_image', body: png(1000, 1000, { seed: 'lib-other' }) });
    await t.media.attach(a.asset.id, { module: 'catalog', kind: 'product_image', refId: 'p1' }, { kind: 'seller', id: sellerId });

    let res = await get('/api/seller/media/assets', seller);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().items.map((x: { id: string }) => x.id).sort()).toEqual([a.asset.id, b.asset.id].sort());
    res = await get('/api/seller/media/assets?purpose=store_logo', seller);
    expect(res.json().items.map((x: { id: string }) => x.id)).toEqual([b.asset.id]);
    res = await get('/api/seller/media/assets?inUse=true', seller);
    expect(res.json().items).toEqual([expect.objectContaining({ id: a.asset.id, inUse: true, usageCount: 1 })]);
    res = await get('/api/seller/media/assets?inUse=false', seller);
    expect(res.json().items.map((x: { id: string }) => x.id)).toEqual([b.asset.id]);
    res = await get('/api/seller/media/assets?q=RED', seller);
    expect(res.json().items.map((x: { id: string }) => x.id)).toEqual([a.asset.id]);
    res = await get('/api/seller/media/assets?status=rejected', seller);
    expect(res.json().items).toEqual([]);
    res = await get('/api/seller/media/assets?limit=1', seller);
    expect(res.json().items).toHaveLength(1);
    const next = await get(`/api/seller/media/assets?limit=1&cursor=${res.json().nextCursor}`, seller);
    expect(next.json().items).toHaveLength(1);
    expect(next.json().items[0].id).not.toBe(res.json().items[0].id);
  });

  it('detail shows where a file is used, whether it can be deleted, and its history', async () => {
    const sellerId = newId();
    const seller = callers.seller({ sellerId });
    const { asset } = await uploadFile(t, 'seller', seller, { purpose: 'product_image', body: png(1000, 1000, { seed: 'detail' }) });
    const owner = { kind: 'seller' as const, id: sellerId };
    await t.media.attach(asset.id, { module: 'catalog', kind: 'product_image', refId: 'p1', refLabel: 'Trail shoe' }, owner);
    await t.media.attach(asset.id, { module: 'catalog', kind: 'product_image', refId: 'p2' }, owner);
    const res = await get(`/api/seller/media/assets/${asset.id}`, seller);
    expect(res.statusCode, res.body).toBe(200);
    const d = res.json();
    expect(d).toMatchObject({ deletable: false, deleteBlockedReason: 'Used by 2 products', asset: { inUse: true, usageCount: 2 } });
    expect(d.usages).toHaveLength(2);
    expect(d.history.map((h: { label: string }) => h.label)).toEqual(expect.arrayContaining(['Upload started', 'Uploaded', 'Ready to use', 'Attached']));
  });

  it('edits alt text and title', async () => {
    const seller = callers.seller();
    const { asset } = await uploadFile(t, 'seller', seller, { purpose: 'product_image', body: png(1000, 1000, { seed: 'alt' }) });
    let res = await send('PATCH', `/api/seller/media/assets/${asset.id}`, seller, { alt: '  Red trail shoe, side view ', title: 'Hero' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ alt: 'Red trail shoe, side view', title: 'Hero' });
    res = await send('PATCH', `/api/seller/media/assets/${asset.id}`, seller, { title: null });
    expect(res.json()).toMatchObject({ alt: 'Red trail shoe, side view', title: null });
    res = await send('PATCH', `/api/seller/media/assets/${asset.id}`, seller, { alt: 'x'.repeat(301) });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_FAILED');
  });
});

describe('deletion rules', () => {
  it('a file in use cannot be deleted (ASSET_IN_USE); once detached it can (media.asset.deleted)', async () => {
    const sellerId = newId();
    const seller = callers.seller({ sellerId });
    const { asset } = await uploadFile(t, 'seller', seller, { purpose: 'product_image', body: png(1000, 1000, { seed: 'del' }) });
    const usage = { module: 'catalog', kind: 'product_image' as const, refId: 'p9' };
    await t.media.attach(asset.id, usage, { kind: 'seller', id: sellerId });
    let res = await send('DELETE', `/api/seller/media/assets/${asset.id}`, seller);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: 'ASSET_IN_USE', details: { usages: [expect.objectContaining({ module: 'catalog', refId: 'p9' })] } });
    await t.media.detach(asset.id, usage);
    res = await send('DELETE', `/api/seller/media/assets/${asset.id}`, seller);
    expect(res.statusCode, res.body).toBe(204);
    await t.app.kernel.events.drain();
    expect(t.eventsNamed('media.asset.deleted').map((e) => (e.payload as { assetId: string }).assetId)).toContain(asset.id);
    // gone for the owner
    expect((await get(`/api/seller/media/assets/${asset.id}`, seller)).statusCode).toBe(404);
  });

  it('evidence is retained after its last use (ASSET_RETAINED)', async () => {
    const accountId = newId();
    const customer = callers.customer({ accountId });
    const { asset } = await uploadFile(t, 'store', customer, { purpose: 'return_evidence', body: png(800, 800, { seed: 'evidence' }) });
    const usage = { module: 'returns', kind: 'return_evidence' as const, refId: 'RT-1' };
    await t.media.attach(asset.id, usage, { kind: 'customer', id: accountId });
    let res = await send('DELETE', `/api/store/media/assets/${asset.id}`, customer);
    expect(res.json().error.code).toBe('ASSET_IN_USE');
    await t.media.detach(asset.id, usage);
    const after = (await t.media.getAsset(asset.id))!;
    expect(new Date(after.retainUntil!).getTime()).toBe(t.clock.now().getTime() + 730 * 86_400_000);
    res = await send('DELETE', `/api/store/media/assets/${asset.id}`, customer);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: 'ASSET_RETAINED', details: { retainUntil: after.retainUntil } });
    expect(res.json().error.message).toMatch(/Kept as return evidence until/);
  });

  it('a file still processing cannot be deleted (ILLEGAL_TRANSITION)', async () => {
    const seller = callers.seller();
    const { asset } = await uploadFile(t, 'seller', seller, { purpose: 'product_image', body: png(1000, 1000, { seed: 'busy' }) }, { process: false });
    const res = await send('DELETE', `/api/seller/media/assets/${asset.id}`, seller);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('ILLEGAL_TRANSITION');
  });

  it('staff delete only platform and staff files, and the deletion is audited', async () => {
    const staff = callers.staff();
    const { asset } = await uploadFile(t, 'admin', staff, { purpose: 'content_image', body: png(1200, 600, { seed: 'banner' }) });
    const res = await send('DELETE', `/api/admin/media/assets/${asset.id}`, staff);
    expect(res.statusCode, res.body).toBe(204);
    expect(t.audits.find((a) => a.action === 'media.asset.delete' && a.target.id === asset.id)).toMatchObject({ module: 'media', actor: { kind: 'staff' } });
    const sellerFile = await uploadFile(t, 'seller', callers.seller(), { purpose: 'product_image', body: png(1000, 1000, { seed: 'not-platform' }) });
    const refused = await send('DELETE', `/api/admin/media/assets/${sellerFile.asset.id}`, staff);
    expect(refused.statusCode).toBe(403);
    const edit = await send('PATCH', `/api/admin/media/assets/${sellerFile.asset.id}`, staff, { alt: 'x' });
    expect(edit.statusCode).toBe(403);
    const other = await uploadFile(t, 'admin', staff, { purpose: 'content_image', body: png(1200, 600, { seed: 'banner-2' }) });
    const ok = await send('PATCH', `/api/admin/media/assets/${other.asset.id}`, staff, { alt: 'Summer sale banner' });
    expect(ok.json().alt).toBe('Summer sale banner');
  });
});

describe('image checks', () => {
  it('evaluates category rules plus the platform baseline and stores the result', async () => {
    const seller = callers.seller();
    const { asset } = await uploadFile(t, 'seller', seller, { purpose: 'product_image', fileName: 'lifestyle-watermark.png', body: png(800, 600, { seed: 'check' }) });
    const res = await send('POST', `/api/seller/media/assets/${asset.id}/checks`, seller, {
      rules: { minWidth: 1000, aspectRatios: ['1:1'], background: 'white', allowWatermark: false, formats: ['jpeg'] },
      rulesSource: 'catalog category Monitors',
    });
    expect(res.statusCode, res.body).toBe(200);
    const r = res.json();
    expect(r).toMatchObject({ assetId: asset.id, passed: false, rulesSource: 'catalog category Monitors', measured: { width: 800, height: 600, aspect: 1.3333 } });
    expect(r.issues.map((i: { code: string }) => i.code).sort()).toEqual(['background_not_white', 'format_not_allowed', 'too_small', 'watermark', 'wrong_aspect']);
    expect(r.issues.find((i: { code: string }) => i.code === 'too_small').message).toBe('Image is 800 px wide; this needs at least 1,000 px.');
    expect((await t.media.getAsset(asset.id))?.check).toMatchObject({ passed: false, rulesSource: 'catalog category Monitors' });
  });

  it('applies the baseline minimum when the caller sets no size rule; warns about blur and duplicates', async () => {
    const sellerId = newId();
    const seller = callers.seller({ sellerId });
    const body = png(400, 400, { seed: 'dup' });
    await uploadFile(t, 'seller', seller, { purpose: 'product_image', fileName: 'blurry.png', body });
    const second = await uploadFile(t, 'seller', seller, { purpose: 'product_image', fileName: 'blurry-again.png', body });
    const r = await t.media.checkImage(second.asset.id, { aspectRatios: [], formats: [] });
    expect(r.passed).toBe(false);
    expect(r.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'too_small', severity: 'blocking' }),
        expect.objectContaining({ code: 'blurry', severity: 'warning' }),
        expect.objectContaining({ code: 'duplicate', severity: 'warning' }),
      ]),
    );
    expect(r.measured.duplicateOf).toBeTruthy();
    // an explicit size rule (an ad banner) replaces the baseline minimum
    const banner = await t.media.checkImage(second.asset.id, { minWidth: 300, aspectRatios: ['1:1'], formats: [] });
    expect(banner.issues.filter((i) => i.severity === 'blocking')).toEqual([]);
  });

  it('refuses files that are not ready images', async () => {
    const seller = callers.seller();
    const doc = await uploadFile(t, 'seller', seller, { purpose: 'verification_document', fileName: 'id.pdf', contentType: 'application/pdf', body: pdf(1) });
    let res = await send('POST', `/api/seller/media/assets/${doc.asset.id}/checks`, seller, { rules: { aspectRatios: [], formats: [] } });
    expect(res.statusCode).toBe(400);
    const busy = await uploadFile(t, 'seller', seller, { purpose: 'product_image', body: png(1000, 1000, { seed: 'busy-check' }) }, { process: false });
    res = await send('POST', `/api/seller/media/assets/${busy.asset.id}/checks`, seller, { rules: { aspectRatios: [], formats: [] } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('ILLEGAL_TRANSITION');
    // staff can check any image
    const staffCheck = await send('POST', `/api/admin/media/assets/${doc.asset.id}/checks`, callers.staff(), { rules: { aspectRatios: [], formats: [] } });
    expect(staffCheck.statusCode).toBe(400);
  });
});

describe('downloads', () => {
  it('owners get a short-lived signed link to their private file; documents download as attachments', async () => {
    const sellerId = newId();
    const seller = callers.seller({ sellerId });
    const body = pdf(2);
    const { asset } = await uploadFile(t, 'seller', seller, { purpose: 'verification_document', fileName: 'license.pdf', contentType: 'application/pdf', body });
    const res = await get(`/api/seller/media/assets/${asset.id}/download`, seller);
    expect(res.statusCode, res.body).toBe(200);
    const link = res.json();
    expect(link).toMatchObject({ fileName: 'license.pdf', contentType: 'application/pdf', sizeBytes: body.length });
    expect(new Date(link.expiresAt).getTime() - t.clock.now().getTime()).toBe(10 * 60_000);
    const fetched = await t.storage.fetch(link.url);
    expect(Buffer.from(fetched!.body).equals(body)).toBe(true);
    expect(fetched!.disposition).toMatch(/^attachment/);
    // tampered links don't work
    expect(await t.storage.fetch(link.url.replace('license.pdf', 'other.pdf'))).toBeNull();
  });

  it('staff downloads need a reason and are recorded', async () => {
    const { asset } = await uploadFile(t, 'store', callers.customer(), { purpose: 'case_evidence', body: png(800, 800, { seed: 'staff-dl' }) });
    let res = await get(`/api/admin/media/assets/${asset.id}/download?reason=${encodeURIComponent('Case CS-1 review')}`, callers.staff());
    expect(res.statusCode, res.body).toBe(200);
    expect(t.audits.find((a) => a.action === 'media.asset.download' && a.target.id === asset.id)).toMatchObject({ reason: 'Case CS-1 review' });
    res = await get(`/api/admin/media/assets/${asset.id}/download?reason=%20`, callers.staff());
    expect(res.statusCode).toBe(400);
  });

  it('signedDownload (public API) records sensitive purposes', async () => {
    const accountId = newId();
    const { asset } = await uploadFile(t, 'store', callers.customer({ accountId }), { purpose: 'verification_document', fileName: 'id.pdf', contentType: 'application/pdf', body: pdf(1) });
    const link = await t.media.signedDownload(asset.id, { kind: 'staff', accountId: newId() }, 'Seller application review');
    expect(link.url).toMatch(/X-Signature=/);
    expect(t.audits.find((a) => a.action === 'media.asset.download' && a.target.id === asset.id)).toMatchObject({ reason: 'Seller application review', actor: { kind: 'staff' } });
  });
});

describe('takedown and restore', () => {
  it('removes a file even when in use; public URLs serve the placeholder; using modules hear media.asset.removed', async () => {
    const sellerId = newId();
    const seller = callers.seller({ sellerId });
    const { asset } = await uploadFile(t, 'seller', seller, { purpose: 'product_image', body: png(1000, 1000, { seed: 'takedown' }) });
    await t.media.attach(asset.id, { module: 'catalog', kind: 'product_image', refId: 'p1', refLabel: 'Shoe' }, { kind: 'seller', id: sellerId });
    const publicUrl = asset.url!;
    const photo = Buffer.from((await t.storage.fetch(publicUrl))!.body);
    const staff = callers.staff();
    let res = await send('POST', `/api/admin/media/assets/${asset.id}/remove`, staff, { reason: 'Rights complaint', showPlaceholder: true });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ asset: { status: 'removed', inUse: true }, deletable: false });
    const served = await t.storage.fetch(publicUrl);
    expect(served?.contentType).toBe('image/png');
    expect(Buffer.from(served!.body).equals(photo)).toBe(false); // the placeholder, not the photo
    const [ref] = await t.media.refs([asset.id]);
    expect(ref!.url).toMatch(/placeholders\/removed\.png$/);
    await t.app.kernel.events.drain();
    expect(t.eventsNamed('media.asset.removed').at(-1)!.payload).toMatchObject({ assetId: asset.id, reason: 'Rights complaint', usages: [expect.objectContaining({ refId: 'p1' })], by: { kind: 'staff' } });
    expect(t.audits.find((a) => a.action === 'media.asset.remove' && a.target.id === asset.id)).toMatchObject({ reason: 'Rights complaint', visibleToSeller: true });
    // the seller sees the takedown, cannot download the original or remove it twice
    expect((await get(`/api/seller/media/assets/${asset.id}/download`, seller)).statusCode).toBe(409);
    const detail = (await get(`/api/seller/media/assets/${asset.id}`, seller)).json();
    expect(detail.history.map((h: { label: string }) => h.label)).toContain('Took down file');
    res = await send('POST', `/api/admin/media/assets/${asset.id}/remove`, staff, { reason: 'again', showPlaceholder: false });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('ILLEGAL_TRANSITION');

    res = await send('POST', `/api/admin/media/assets/${asset.id}/restore`, staff, { reason: 'Complaint withdrawn' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().asset).toMatchObject({ status: 'ready', url: publicUrl });
    expect(Buffer.from((await t.storage.fetch(publicUrl))!.body).equals(photo)).toBe(true);
    await t.app.kernel.events.drain();
    expect(t.eventsNamed('media.asset.restored').at(-1)!.payload).toMatchObject({ assetId: asset.id, usages: [expect.objectContaining({ refId: 'p1' })] });
    expect(t.audits.find((a) => a.action === 'media.asset.restore')).toMatchObject({ reason: 'Complaint withdrawn' });
    res = await send('POST', `/api/admin/media/assets/${asset.id}/restore`, staff, { reason: 'twice' });
    expect(res.json().error.code).toBe('ILLEGAL_TRANSITION');
  });

  it('without the placeholder, public URLs stop serving', async () => {
    const { asset } = await uploadFile(t, 'seller', callers.seller(), { purpose: 'product_image', body: png(1000, 1000, { seed: 'no-placeholder' }) });
    await send('POST', `/api/admin/media/assets/${asset.id}/remove`, callers.staff(), { reason: 'Privacy', showPlaceholder: false });
    expect(await t.storage.fetch(asset.url!)).toBeNull();
  });

  it('remove (public API) takes a file down for a moderation decision', async () => {
    const { asset } = await uploadFile(t, 'store', callers.customer(), { purpose: 'review_photo', body: png(900, 900, { seed: 'moderation' }) });
    await t.media.remove(asset.id, { reason: 'Review removed for abuse', by: { kind: 'system' } });
    expect(await t.media.getAsset(asset.id)).toMatchObject({ status: 'removed' });
  });
});

describe('admin library', () => {
  it('filters by owner, status and failed checks; private renditions are signed only with view-private', async () => {
    const sellerId = newId();
    const seller = callers.seller({ sellerId });
    const { asset } = await uploadFile(t, 'seller', seller, { purpose: 'product_image', body: png(300, 300, { seed: 'admin-small' }) });
    await t.media.checkImage(asset.id, { minWidth: 1000, aspectRatios: [], formats: [] });
    let res = await get(`/api/admin/media/assets?ownerKind=seller&ownerId=${sellerId}&failedChecks=true`, callers.staff());
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().items.map((x: { id: string }) => x.id)).toEqual([asset.id]);
    res = await get(`/api/admin/media/assets?ownerKind=seller&ownerId=${sellerId}&status=removed`, callers.staff());
    expect(res.json().items).toEqual([]);
    res = await get('/api/admin/media/assets?page=1&limit=2', callers.staff());
    expect(res.json()).toMatchObject({ page: 1 });

    const evidence = await uploadFile(t, 'store', callers.customer(), { purpose: 'return_evidence', body: png(800, 800, { seed: 'admin-private' }) });
    const viewer = callers.staff(['media.assets.view']);
    const plain = (await get(`/api/admin/media/assets/${evidence.asset.id}`, viewer)).json();
    expect(plain.asset.renditions).toEqual([]);
    const full = (await get(`/api/admin/media/assets/${evidence.asset.id}`, callers.staff())).json();
    expect(full.asset.renditions[0].url).toMatch(/X-Signature=/);
  });
});
