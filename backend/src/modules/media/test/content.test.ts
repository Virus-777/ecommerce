/** Upload target when storage is served by the API: PUT /api/{area}/media/uploads/{id}/content streams the bytes the ticket allows. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { devClaims } from '../../../kernel/auth/dev.js';
import { token } from '../../../testing/app.js';
import type { StorageProvider } from '../ports.js';
import { auth, callers, mediaApp, png, putContent, sha256, startUpload, type Area, type MediaTestApp } from './helpers.js';

let t: MediaTestApp;
beforeAll(async () => {
  t = await mediaApp();
});
afterAll(async () => {
  await t?.app.close();
});

const purposeOf = { store: 'review_photo', seller: 'product_image', admin: 'content_image' } as const;

async function ticketFor(area: Area, who: string, body: Buffer, extra: { sha256?: string } = {}) {
  const res = await startUpload(t, area, who, { purpose: purposeOf[area], sizeBytes: body.length, ...extra });
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

describe('PUT /uploads/{id}/content (storage served by the API)', () => {
  it('points each area’s tickets at its own content endpoint, with the headers to send', async () => {
    const body = png(800, 800);
    for (const [area, who] of [['store', callers.customer()], ['seller', callers.seller()], ['admin', callers.staff()]] as const) {
      const ticket = await ticketFor(area, who, body);
      expect(ticket.method).toBe('PUT');
      expect(ticket.url).toBe(`http://localhost:80/api/${area}/media/uploads/${ticket.uploadId}/content`);
      expect(ticket.headers).toEqual({ 'content-type': 'image/png' });
    }
  });

  it('accepts the bytes (204), then complete and processing make the file ready, all over HTTP', async () => {
    for (const [area, who] of [['store', callers.customer()], ['seller', callers.seller()], ['admin', callers.staff()]] as const) {
      const body = png(1200, 1200, { seed: area });
      const ticket = await ticketFor(area, who, body, { sha256: sha256(body) });
      const put = await putContent(t, ticket, who, body);
      expect(put.statusCode, put.body).toBe(204);
      const stored = await t.storage.head('marketly-private', `originals/${ticket.assetId}.png`);
      expect(stored).toMatchObject({ sizeBytes: body.length, sha256: sha256(body), contentType: 'image/png' });

      const done = await t.app.inject({ method: 'POST', url: `/api/${area}/media/uploads/${ticket.uploadId}/complete`, headers: auth(who) });
      expect(done.statusCode, done.body).toBe(202);
      expect(done.json()).toMatchObject({ id: ticket.assetId, status: 'processing' });
      await t.app.kernel.jobs.runNow('media.process');
      await t.app.kernel.events.drain();
      const asset = await t.app.inject({ method: 'GET', url: `/api/${area}/media/assets/${ticket.assetId}`, headers: auth(who) });
      expect(asset.statusCode, asset.body).toBe(200);
      // store answers the MediaAsset; Seller Center and Admin Center the MediaAssetDetail
      const json = asset.json();
      expect((area === 'store' ? json : json.asset).status).toBe('ready');
    }
  });

  it('takes any content type (stored under the declared one) and may be sent again before complete', async () => {
    const seller = callers.seller();
    const body = png(900, 900, { seed: 'octet' });
    const ticket = await ticketFor('seller', seller, body);
    expect((await putContent(t, ticket, seller, Buffer.alloc(10), { 'content-type': 'application/octet-stream' })).statusCode).toBe(204);
    // a retry replaces a partial upload
    expect((await putContent(t, ticket, seller, body, { 'content-type': 'application/octet-stream' })).statusCode).toBe(204);
    expect(await t.storage.head('marketly-private', `originals/${ticket.assetId}.png`)).toMatchObject({ sizeBytes: body.length, contentType: 'image/png' });
  });

  it('refuses more bytes than the ticket allows (FILE_TOO_LARGE, 413)', async () => {
    const seller = callers.seller();
    const ticket = await ticketFor('seller', seller, Buffer.alloc(100));
    const res = await putContent(t, ticket, seller, Buffer.alloc(101));
    expect(res.statusCode).toBe(413);
    expect(res.json().error).toMatchObject({ code: 'FILE_TOO_LARGE', details: { maxBytes: 100, receivedBytes: 101 } });
    expect(await t.storage.head('marketly-private', `originals/${ticket.assetId}.png`)).toBeNull();
  });

  it('refuses an expired ticket (UPLOAD_EXPIRED, 410)', async () => {
    const seller = token(devClaims('seller'), 7200); // outlives the clock jump
    const ticket = await ticketFor('seller', seller, Buffer.alloc(100));
    t.clock.advance(16 * 60_000);
    try {
      const res = await putContent(t, ticket, seller, Buffer.alloc(100));
      expect(res.statusCode).toBe(410);
      expect(res.json().error.code).toBe('UPLOAD_EXPIRED');
    } finally {
      t.clock.advance(-16 * 60_000);
    }
  });

  it("is another owner's upload: 404 (another seller, a customer, staff for a seller's upload)", async () => {
    const seller = callers.seller();
    const ticket = await ticketFor('seller', seller, Buffer.alloc(100));
    const id = ticket.uploadId;
    const put = (area: Area, who: string) => t.app.inject({ method: 'PUT', url: `/api/${area}/media/uploads/${id}/content`, headers: { ...auth(who), 'content-type': 'image/png' }, payload: Buffer.alloc(100) });
    for (const res of [await put('seller', callers.seller()), await put('store', callers.customer()), await put('admin', callers.staff())]) {
      expect(res.statusCode, res.body).toBe(404);
      expect(res.json().error.code).toBe('NOT_FOUND');
    }
    // and a customer's upload from another customer
    const customer = callers.customer();
    const mine = await ticketFor('store', customer, Buffer.alloc(100));
    expect((await putContent(t, mine, callers.customer(), Buffer.alloc(100))).statusCode).toBe(404);
    expect(await t.storage.head('marketly-private', `originals/${ticket.assetId}.png`)).toBeNull();
  });

  it('refuses bytes after the upload completed (ILLEGAL_TRANSITION, 409)', async () => {
    const seller = callers.seller();
    const body = png(1000, 1000, { seed: 'done' });
    const ticket = await ticketFor('seller', seller, body);
    expect((await putContent(t, ticket, seller, body)).statusCode).toBe(204);
    expect((await t.app.inject({ method: 'POST', url: `/api/seller/media/uploads/${ticket.uploadId}/complete`, headers: auth(seller) })).statusCode).toBe(202);
    const res = await putContent(t, ticket, seller, png(1000, 1000, { seed: 'swap' }));
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('ILLEGAL_TRANSITION');
    expect((await t.storage.head('marketly-private', `originals/${ticket.assetId}.png`))?.sha256).toBe(sha256(body));
  });

  it('keeps MemoryStorage.acceptSignedPut working with the ticket URL (tests and tools)', async () => {
    const seller = callers.seller();
    const body = png(700, 700, { seed: 'direct' });
    const ticket = await ticketFor('seller', seller, body);
    const { key, object } = await t.storage.acceptSignedPut(ticket.url, body, 'image/png');
    expect(key).toBe(`originals/${ticket.assetId}.png`);
    expect(object.sizeBytes).toBe(body.length);
    await expect(t.storage.acceptSignedPut(ticket.url, Buffer.alloc(body.length + 1), 'image/png')).rejects.toThrow(/EntityTooLarge/);
    await expect(t.storage.acceptSignedPut('http://localhost/api/seller/media/uploads/not-an-id/content', body)).rejects.toThrow(/Not a storage URL/);
  });
});

describe('with a direct-upload storage adapter', () => {
  it('hands out the storage URL and the endpoint answers DIRECT_UPLOAD_ONLY (409)', async () => {
    const providers = t.media.providers as { storage: StorageProvider };
    const dev = providers.storage;
    // a direct-upload adapter (S3-compatible): its own signed URLs, the API never carries the bytes
    const { acceptSignedPut: _a, fetch: _f, size: _s, ...rest } = t.storage;
    const real: StorageProvider = {
      ...rest,
      viaApi: false,
      presignUpload: async ({ bucket, key, contentType }) => ({ method: 'PUT', url: `https://s3.example.test/${bucket}/${key}?X-Amz-Signature=abc`, headers: { 'content-type': contentType }, fields: {} }),
    };
    providers.storage = real;
    try {
      const seller = callers.seller();
      const ticket = await ticketFor('seller', seller, Buffer.alloc(100));
      expect(ticket.url).toBe(`https://s3.example.test/marketly-private/originals/${ticket.assetId}.png?X-Amz-Signature=abc`);
      const res = await t.app.inject({ method: 'PUT', url: `/api/seller/media/uploads/${ticket.uploadId}/content`, headers: { ...auth(seller), 'content-type': 'image/png' }, payload: Buffer.alloc(100) });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('DIRECT_UPLOAD_ONLY');
    } finally {
      providers.storage = dev;
    }
  });
});
