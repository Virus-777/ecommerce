/** Upload flow: signed direct uploads, completion (client and storage webhook), processing. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { devClaims } from '../../../kernel/auth/dev.js';
import { signWebhook, token } from '../../../testing/app.js';
import { EICAR } from '../providers/scanner.js';
import { auth, callers, jpeg, mediaApp, mediaTable, mp4, pdf, png, sha256, startUpload, uploadFile, type MediaTestApp } from './helpers.js';

let t: MediaTestApp;
beforeAll(async () => {
  t = await mediaApp();
});
afterAll(async () => {
  await t?.app.close();
});

const webhook = (path: string, body: unknown) => {
  const raw = JSON.stringify(body);
  return t.app.inject({ method: 'POST', url: `/webhooks/media${path}`, headers: { 'content-type': 'application/json', 'x-event-id': newId(), ...signWebhook('dev-webhook-secret', raw) }, payload: raw });
};

describe('starting an upload', () => {
  it('issues an expiring upload URL (201): with development storage, this API in the same area', async () => {
    const res = await startUpload(t, 'seller', callers.seller(), { purpose: 'product_image', fileName: 'shoe.png', contentType: 'image/png', sizeBytes: 2048 });
    expect(res.statusCode, res.body).toBe(201);
    const ticket = res.json();
    expect(ticket).toMatchObject({ method: 'PUT', maxBytes: 2048, headers: { 'content-type': 'image/png' }, fields: {} });
    expect(new URL(ticket.url).pathname).toBe(`/api/seller/media/uploads/${ticket.uploadId}/content`);
    // the signed storage URL behind it (what a real storage adapter hands out)
    expect(await t.media.signedStorageUrlFor(ticket.url)).toMatch(/^https:\/\/storage\.marketly\.test\/.+X-Signature=/);
    expect(new Date(ticket.expiresAt).getTime() - t.clock.now().getTime()).toBe(15 * 60_000);
    const asset = await t.media.getAsset(ticket.assetId);
    expect(asset).toMatchObject({ status: 'pending_upload', kind: 'image', visibility: 'public', owner: { kind: 'seller' } });
  });

  it('refuses purposes the caller may not upload (PURPOSE_NOT_ALLOWED)', async () => {
    let res = await startUpload(t, 'store', callers.customer(), { purpose: 'product_image' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('PURPOSE_NOT_ALLOWED');
    // guests may upload return and case evidence only
    res = await startUpload(t, 'store', callers.visitor(), { purpose: 'review_photo' });
    expect(res.json().error.code).toBe('PURPOSE_NOT_ALLOWED');
    res = await startUpload(t, 'store', callers.visitor(), { purpose: 'return_evidence' });
    expect(res.statusCode, res.body).toBe(201);
    expect((await t.media.getAsset(res.json().assetId))?.owner.kind).toBe('guest');
    res = await startUpload(t, 'seller', callers.seller(), { purpose: 'review_photo' });
    expect(res.json().error.code).toBe('PURPOSE_NOT_ALLOWED');
  });

  it('checks the type (FILE_TYPE_NOT_ALLOWED, 415) and size (FILE_TOO_LARGE, 413) for the purpose', async () => {
    let res = await startUpload(t, 'seller', callers.seller(), { purpose: 'product_image', fileName: 'a.pdf', contentType: 'application/pdf' });
    expect(res.statusCode).toBe(415);
    expect(res.json().error).toMatchObject({ code: 'FILE_TYPE_NOT_ALLOWED', details: { allowed: ['jpeg', 'png', 'webp', 'heic'] } });
    res = await startUpload(t, 'seller', callers.seller(), { purpose: 'ad_creative', sizeBytes: 6 * 1024 * 1024 });
    expect(res.statusCode).toBe(413);
    expect(res.json().error).toMatchObject({ code: 'FILE_TOO_LARGE', details: { maxBytes: 5 * 1024 * 1024 } });
    res = await startUpload(t, 'seller', callers.seller(), { purpose: 'bulk_file', fileName: 'prices.csv', contentType: 'text/csv' });
    expect(res.statusCode, res.body).toBe(201);
    res = await startUpload(t, 'seller', callers.seller(), { purpose: 'product_image', sizeBytes: 0 });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_FAILED');
  });

  it('limits customer uploads per day (QUOTA_EXCEEDED)', async () => {
    const customer = callers.customer({ accountId: newId() });
    for (let i = 0; i < 50; i++) expect((await startUpload(t, 'store', customer, { purpose: 'review_photo' })).statusCode).toBe(201);
    const res = await startUpload(t, 'store', customer, { purpose: 'review_photo' });
    expect(res.statusCode).toBe(429);
    expect(res.json().error).toMatchObject({ code: 'QUOTA_EXCEEDED', details: { limit: 50 } });
  });

  it('enforces the seller storage quota (QUOTA_EXCEEDED)', async () => {
    const seller = callers.seller();
    const res = await startUpload(t, 'seller', seller, { purpose: 'product_video', fileName: 'v.mp4', contentType: 'video/mp4', sizeBytes: 400 * 1024 * 1024 });
    expect(res.statusCode).toBe(201);
    // 20 GB quota: pretend the seller already stores almost all of it
    const assetId = res.json().assetId;
    await mediaTable(t.app, 'assets').update(assetId, { size_bytes: 20 * 1024 ** 3 - 100 });
    const again = await startUpload(t, 'seller', seller, { purpose: 'product_image', sizeBytes: 1000 });
    expect(again.statusCode).toBe(429);
    expect(again.json().error.code).toBe('QUOTA_EXCEEDED');
  });

  it('staff uploads belong to the platform, evidence to the staff member', async () => {
    const accountId = newId();
    const staff = callers.staff(undefined, { sub: accountId });
    let res = await startUpload(t, 'admin', staff, { purpose: 'content_image' });
    expect((await t.media.getAsset(res.json().assetId))?.owner).toMatchObject({ kind: 'platform', id: null });
    res = await startUpload(t, 'admin', staff, { purpose: 'inspection_photo' });
    expect((await t.media.getAsset(res.json().assetId))?.owner).toMatchObject({ kind: 'staff', id: accountId });
    res = await startUpload(t, 'admin', staff, { purpose: 'content_image' }, { ownerKind: 'staff' });
    expect((await t.media.getAsset(res.json().assetId))?.owner).toMatchObject({ kind: 'staff', id: accountId });
    res = await startUpload(t, 'admin', staff, { purpose: 'review_photo' });
    expect(res.json().error.code).toBe('PURPOSE_NOT_ALLOWED');
  });
});

describe('completing an upload', () => {
  it('starts processing (202) once the bytes are stored, and is idempotent', async () => {
    const seller = callers.seller();
    const body = png(1200, 1200);
    const res = await startUpload(t, 'seller', seller, { purpose: 'product_image', sizeBytes: body.length, sha256: sha256(body) });
    const ticket = res.json();
    await t.storage.acceptSignedPut(ticket.url, body, 'image/png');
    const done = await t.app.inject({ method: 'POST', url: `/api/seller/media/uploads/${ticket.uploadId}/complete`, headers: auth(seller) });
    expect(done.statusCode, done.body).toBe(202);
    expect(done.json()).toMatchObject({ id: ticket.assetId, status: 'processing' });
    const again = await t.app.inject({ method: 'POST', url: `/api/seller/media/uploads/${ticket.uploadId}/complete`, headers: auth(seller) });
    expect(again.statusCode).toBe(202);
    expect(again.json().status).toBe('processing');
  });

  it('answers UPLOAD_INCOMPLETE while the object is missing or short', async () => {
    const seller = callers.seller();
    const res = await startUpload(t, 'seller', seller, { purpose: 'product_image', sizeBytes: 500 });
    const ticket = res.json();
    let done = await t.app.inject({ method: 'POST', url: `/api/seller/media/uploads/${ticket.uploadId}/complete`, headers: auth(seller) });
    expect(done.statusCode).toBe(409);
    expect(done.json().error.code).toBe('UPLOAD_INCOMPLETE');
    await t.storage.acceptSignedPut(ticket.url, Buffer.alloc(100), 'image/png');
    done = await t.app.inject({ method: 'POST', url: `/api/seller/media/uploads/${ticket.uploadId}/complete`, headers: auth(seller) });
    expect(done.json().error).toMatchObject({ code: 'UPLOAD_INCOMPLETE', details: { expectedBytes: 500, receivedBytes: 100 } });
  });

  it('answers CHECKSUM_MISMATCH (422) when the bytes differ from the declared sha256', async () => {
    const seller = callers.seller();
    const body = png(800, 800);
    const res = await startUpload(t, 'seller', seller, { purpose: 'product_image', sizeBytes: body.length, sha256: sha256(Buffer.from('other')) });
    const ticket = res.json();
    await t.storage.acceptSignedPut(ticket.url, body, 'image/png');
    const done = await t.app.inject({ method: 'POST', url: `/api/seller/media/uploads/${ticket.uploadId}/complete`, headers: auth(seller) });
    expect(done.statusCode).toBe(422);
    expect(done.json().error.code).toBe('CHECKSUM_MISMATCH');
    expect((await t.media.getAsset(ticket.assetId))?.status).toBe('pending_upload');
  });

  it('answers UPLOAD_EXPIRED after the signed URL expired without bytes', async () => {
    const seller = token(devClaims('seller'), 7200); // outlives the clock jump
    const ticket = (await startUpload(t, 'seller', seller, { purpose: 'product_image' })).json();
    t.clock.advance(16 * 60_000);
    try {
      await expect(t.storage.acceptSignedPut(ticket.url, Buffer.alloc(100), 'image/png')).rejects.toThrow(/expired/);
      const done = await t.app.inject({ method: 'POST', url: `/api/seller/media/uploads/${ticket.uploadId}/complete`, headers: auth(seller) });
      expect(done.statusCode).toBe(410);
      expect(done.json().error.code).toBe('UPLOAD_EXPIRED');
    } finally {
      t.clock.advance(-16 * 60_000);
    }
  });

  it("is another owner's upload: 404", async () => {
    const ticket = (await startUpload(t, 'seller', callers.seller(), { purpose: 'product_image' })).json();
    const res = await t.app.inject({ method: 'POST', url: `/api/seller/media/uploads/${ticket.uploadId}/complete`, headers: auth(callers.seller()) });
    expect(res.statusCode).toBe(404);
    const store = await t.app.inject({ method: 'POST', url: `/api/store/media/uploads/${ticket.uploadId}/complete`, headers: auth(callers.customer()) });
    expect(store.statusCode).toBe(404);
  });

  it('the storage notification completes uploads whose client never called complete (idempotent)', async () => {
    const seller = callers.seller();
    const body = png(900, 900, { seed: 'webhook' });
    const ticket = (await startUpload(t, 'seller', seller, { purpose: 'product_image', sizeBytes: body.length })).json();
    const { bucket, key, object } = await t.storage.acceptSignedPut(ticket.url, body, 'image/png');
    const event = { bucket, key, versionId: object.versionId, sizeBytes: object.sizeBytes, etag: object.etag, at: t.clock.now().toISOString() };
    let res = await webhook('/storage-events', { events: [event, { ...event, key: 'unknown/key' }] });
    expect(res.statusCode, res.body).toBe(204);
    expect((await t.media.getAsset(ticket.assetId))?.status).toBe('processing');
    res = await webhook('/storage-events', { events: [event] });
    expect(res.statusCode).toBe(204);
    // the client's complete afterwards just answers the current state
    const done = await t.app.inject({ method: 'POST', url: `/api/seller/media/uploads/${ticket.uploadId}/complete`, headers: auth(seller) });
    expect(done.statusCode).toBe(202);
  });

  it('refuses unsigned storage notifications', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/webhooks/media/storage-events', payload: { events: [] } });
    expect(res.statusCode).toBe(401);
  });
});

describe('processing', () => {
  it('scans, strips metadata, builds renditions and the baseline check, then publishes media.asset.ready', async () => {
    const before = t.eventsNamed('media.asset.ready').length;
    const { asset } = await uploadFile(t, 'seller', callers.seller(), { purpose: 'product_image', fileName: 'boots.jpg', contentType: 'image/jpeg', body: jpeg(1600, 1200) });
    expect(asset).toMatchObject({ status: 'ready', width: 1600, height: 1200, contentType: 'image/jpeg' });
    expect(asset.readyAt).toBeTruthy();
    const sizes = [...new Set(asset.renditions.map((r) => r.size))];
    expect(sizes).toEqual(['thumb', 'small', 'medium', 'large', 'zoom']);
    const zoom = asset.renditions.find((r) => r.size === 'zoom' && r.format === 'webp')!;
    expect(zoom).toMatchObject({ width: 1600, height: 1200 }); // never upscaled
    expect(asset.renditions.find((r) => r.size === 'thumb')).toMatchObject({ width: 160, height: 120 });
    expect(asset.url).toBe(asset.renditions.find((r) => r.size === 'medium' && r.format === 'webp')!.url);
    expect(asset.check).toMatchObject({ passed: true, rulesSource: 'Platform baseline', measured: { width: 1600, height: 1200 } });
    // public renditions carry no EXIF/GPS
    const served = await t.storage.fetch(asset.url!);
    expect(Buffer.from(served!.body).includes('GPSLatitude')).toBe(false);
    await t.app.kernel.events.drain();
    const ready = t.eventsNamed('media.asset.ready').slice(before);
    expect(ready.map((e) => e.payload)).toContainEqual(expect.objectContaining({ assetId: asset.id, kind: 'image', purpose: 'product_image' }));
  });

  it('auto-orients: EXIF orientation 6 swaps the sides', async () => {
    const { asset } = await uploadFile(t, 'store', callers.customer(), { purpose: 'return_evidence', fileName: 'phone.jpg', contentType: 'image/jpeg', body: jpeg(4032, 3024, { orientation: 6 }) });
    expect(asset).toMatchObject({ status: 'ready', width: 3024, height: 4032, visibility: 'private', url: null });
    // private renditions are signed links, only through the owner's views
    expect(asset.renditions[0]!.url).toMatch(/\/files\/marketly-private\/.+[?&]exp=.+&sig=/);
  });

  it('rejects malware, corrupt files and files whose bytes are another type (media.asset.rejected)', async () => {
    const seller = callers.seller();
    const infected = await uploadFile(t, 'seller', seller, { purpose: 'product_image', fileName: 'eicar.png', body: png(800, 800) });
    expect(infected.asset).toMatchObject({ status: 'rejected', rejectionReason: expect.stringMatching(/Malware/) });
    const sig = await uploadFile(t, 'seller', seller, { purpose: 'bulk_file', fileName: 'prices.csv', contentType: 'text/csv', body: Buffer.from(`sku,price\n${EICAR}\n`) });
    expect(sig.asset.status).toBe('rejected');
    const corrupt = await uploadFile(t, 'seller', seller, { purpose: 'product_image', body: Buffer.from('not really a png') });
    expect(corrupt.asset).toMatchObject({ status: 'rejected', rejectionReason: 'The file is unsupported or corrupt.' });
    const disguised = await uploadFile(t, 'seller', seller, { purpose: 'product_image', fileName: 'doc.png', body: pdf(1) });
    expect(disguised.asset.rejectionReason).toMatch(/really a PDF/);
    await t.app.kernel.events.drain();
    const rejected = t.eventsNamed('media.asset.rejected').map((e) => (e.payload as { assetId: string }).assetId);
    expect(rejected).toEqual(expect.arrayContaining([infected.asset.id, corrupt.asset.id, disguised.asset.id]));
  });

  it('counts PDF pages', async () => {
    const { asset } = await uploadFile(t, 'seller', callers.seller(), { purpose: 'verification_document', fileName: 'license.pdf', contentType: 'application/pdf', body: pdf(3) });
    expect(asset).toMatchObject({ status: 'ready', kind: 'document', pageCount: 3, visibility: 'private', renditions: [] });
  });

  it('transcodes product videos: ready when the provider reports back (idempotent), rejected on failure', async () => {
    const seller = callers.seller();
    const { asset } = await uploadFile(t, 'seller', seller, { purpose: 'product_video', fileName: 'demo.mp4', contentType: 'video/mp4', body: mp4(12) });
    expect(asset).toMatchObject({ status: 'processing', durationSeconds: 12 });
    const job = t.processor.transcodes.find((x) => x.assetId === asset.id)!;
    const outputs = [
      { size: 'poster', url: `https://cdn.marketly.test/renditions/${asset.id}/poster.jpeg`, width: 1920, height: 1080, format: 'jpeg', bytes: 1000 },
      { size: 'video_720', url: `https://cdn.marketly.test/renditions/${asset.id}/video_720.mp4`, width: 1280, height: 720, format: 'mp4', bytes: 100000 },
      { size: 'video_1080', url: `https://cdn.marketly.test/renditions/${asset.id}/video_1080.mp4`, width: 1920, height: 1080, format: 'mp4', bytes: 200000 },
    ];
    let res = await webhook('/processing-results', { providerJobId: job.providerJobId, status: 'succeeded', outputs, durationSeconds: 12.4 });
    expect(res.statusCode, res.body).toBe(204);
    res = await webhook('/processing-results', { providerJobId: job.providerJobId, status: 'failed', outputs: [], error: 'late duplicate' });
    expect(res.statusCode).toBe(204);
    const ready = (await t.media.getAsset(asset.id))!;
    expect(ready).toMatchObject({ status: 'ready', width: 1920, height: 1080, durationSeconds: 12.4, url: t.storage.publicUrl(`renditions/${asset.id}/poster.jpeg`) });
    expect(ready.renditions).toHaveLength(3);

    const second = await uploadFile(t, 'seller', seller, { purpose: 'product_video', fileName: 'demo2.mp4', contentType: 'video/mp4', body: mp4(5) });
    const job2 = t.processor.transcodes.find((x) => x.assetId === second.asset.id)!;
    await webhook('/processing-results', { providerJobId: job2.providerJobId, status: 'failed', outputs: [], error: 'Unsupported codec' });
    expect(await t.media.getAsset(second.asset.id)).toMatchObject({ status: 'rejected', rejectionReason: 'Unsupported codec' });
    // unknown jobs are ignored
    expect((await webhook('/processing-results', { providerJobId: 'nope', status: 'succeeded', outputs: [] })).statusCode).toBe(204);
  });

  it('retries provider failures with backoff, then rejects', async () => {
    const seller = callers.seller();
    const { ticket } = await uploadFile(t, 'seller', seller, { purpose: 'product_image', fileName: 'flaky.png', body: png(700, 700, { seed: 'flaky' }) }, { process: false });
    const scanner = t.media.providers.scanner;
    const original = scanner.scan;
    scanner.scan = async () => {
      throw new Error('scanner unavailable');
    };
    try {
      for (let attempt = 1; attempt <= 5; attempt++) {
        await t.app.kernel.jobs.runNow('media.process');
        t.clock.advance(60 * 60_000);
      }
    } finally {
      scanner.scan = original;
      t.clock.advance(-5 * 60 * 60_000);
    }
    expect(await t.media.getAsset(ticket.assetId)).toMatchObject({ status: 'rejected', rejectionReason: expect.stringMatching(/could not be processed/) });
  });
});
