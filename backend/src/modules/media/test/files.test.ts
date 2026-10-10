/**
 * Bytes over HTTP with each storage the API can run on (memory, local disk): upload through
 * PUT /uploads/{id}/content (streamed, limited), processing, and downloads at GET /files/{bucket}/{key}
 * whose signed link the auth middleware verifies (tampered → 401, expired → 403), with ranges,
 * conditional requests and cache headers; keys outside storage are never served.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileLinkSecret, signFileLink } from '../../../kernel/auth/file-links.js';
import { newId } from '../../../kernel/lib/ids.js';
import type { StorageProvider } from '../ports.js';
import { auth, callers, mediaApp, pdf, png, putContent, startUpload, uploadFile, type MediaTestApp } from './helpers.js';

const pathOf = (url: string) => {
  const u = new URL(url);
  return u.pathname + u.search;
};

describe.each(['memory', 'local'] as const)('files over HTTP with %s storage', (kind) => {
  let t: MediaTestApp;
  let storage: StorageProvider;
  let dir = '';
  const get = (url: string, headers: Record<string, string> = {}, method: 'GET' | 'HEAD' = 'GET') => t.app.inject({ method, url: pathOf(url), headers });
  const sign = (link: Parameters<typeof signFileLink>[1]) => signFileLink(fileLinkSecret(t.app.kernel.config, 'media'), link);

  beforeAll(async () => {
    if (kind === 'local') dir = await mkdtemp(join(tmpdir(), 'marketly-files-'));
    t = await mediaApp({ storage: kind, dir: dir && join(dir, 'media') });
    storage = t.media.providers.storage;
  });
  afterAll(async () => {
    await t?.app.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('runs on the configured adapter', () => {
    expect(t.app.kernel.config.media.storage).toBe(kind);
    expect(storage.viaApi).toBe(true);
  });

  it('upload → process → download: a public rendition by its permanent link, as an <img src> would (no token)', async () => {
    const { asset } = await uploadFile(t, 'seller', callers.seller(), { purpose: 'product_image', body: png(1200, 1200, { seed: `public-${kind}` }) });
    expect(asset.status).toBe('ready');
    expect(asset.url).toMatch(/^http:\/\/localhost:4000\/files\/marketly-public\/renditions\/.+\/medium\.webp\?sig=/);
    const res = await get(asset.url!);
    expect(res.statusCode, res.body).toBe(200);
    const key = `renditions/${asset.id}/medium.webp`;
    expect(Buffer.from(res.rawPayload).equals(Buffer.from((await storage.get('marketly-public', key))!))).toBe(true);
    expect(res.headers).toMatchObject({
      'content-type': 'image/webp',
      'cache-control': 'public, max-age=3600',
      'accept-ranges': 'bytes',
      'x-content-type-options': 'nosniff',
      'content-length': String(res.rawPayload.length),
    });
    expect(res.headers.etag).toMatch(/^"[0-9a-f]+"$/);
    expect(res.headers['content-security-policy']).toContain('sandbox');
    expect(res.headers['content-disposition']).toBeUndefined();
    // renditions in the asset all open
    for (const r of asset.renditions) expect((await get(r.url, {}, 'HEAD')).statusCode).toBe(200);
  });

  it('upload → process → download: a private document through its short-lived signed link', async () => {
    const seller = callers.seller();
    const body = pdf(2);
    const { asset } = await uploadFile(t, 'seller', seller, { purpose: 'verification_document', fileName: 'license.pdf', contentType: 'application/pdf', body });
    const link = (await t.app.inject({ method: 'GET', url: `/api/seller/media/assets/${asset.id}/download`, headers: auth(seller) })).json();
    expect(link.url).toMatch(/\/files\/marketly-private\/originals\/.+\.pdf\?exp=\d+&ct=application%2Fpdf&cd=attachment.+&sig=/);
    const res = await get(link.url);
    expect(res.statusCode, res.body).toBe(200);
    expect(Buffer.from(res.rawPayload).equals(body)).toBe(true);
    expect(res.headers).toMatchObject({ 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="license.pdf"', 'cache-control': 'private, no-store' });
  });

  it('refuses tampered links (401) and expired ones (403) in the middleware', async () => {
    const { asset } = await uploadFile(t, 'store', callers.customer(), { purpose: 'return_evidence', body: png(800, 800, { seed: `private-${kind}` }) });
    const [ref] = await t.media.refs([asset.id]); // private: an inline link valid downloadUrlTtlMinutes
    expect((await get(ref!.url)).statusCode).toBe(200);
    expect((await get(ref!.url)).headers['cache-control']).toMatch(/^private, max-age=(599|600)$/);
    const sig = /[?&]sig=([^&]+)/.exec(ref!.url)![1]!;
    const tampered = [
      ref!.url.replace('/renditions/', '/originals/'), // another file
      ref!.url.replace(sig, `${sig.startsWith('A') ? 'B' : 'A'}${sig.slice(1)}`), // a forged signature
      ref!.url.replace(/&sig=[^&]+/, ''), // none
      ref!.url.replace('marketly-private', 'marketly-public'), // another bucket
      ref!.url.replace(/exp=\d+/, (m) => `exp=${Number(m.slice(4)) + 3600}`), // a longer life
    ];
    for (const bad of tampered) {
      const res = await get(bad);
      expect(res.statusCode, bad).toBe(401);
      expect(res.json().error).toMatchObject({ code: 'UNAUTHORIZED', details: { reason: expect.stringMatching(/^link_(invalid|missing)$/) } });
    }
    // a valid Bearer token does not replace the signature
    expect((await t.app.inject({ url: pathOf(ref!.url).replace(/\?.*/, ''), headers: auth(callers.staff()) })).statusCode).toBe(401);
    t.clock.advance(11 * 60_000);
    try {
      const res = await get(ref!.url);
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toMatchObject({ code: 'FORBIDDEN', details: { reason: 'link_expired' } });
    } finally {
      t.clock.advance(-11 * 60_000);
    }
  });

  it('serves byte ranges, HEAD and conditional requests', async () => {
    const body = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251));
    await storage.put('marketly-private', 'generated/range-test.bin', body, 'application/octet-stream');
    const url = sign({ bucket: 'marketly-private', key: 'generated/range-test.bin', expiresAt: new Date(t.clock.now().getTime() + 60_000), contentType: 'application/octet-stream', disposition: 'inline' });

    let res = await t.app.inject({ url, headers: { range: 'bytes=10-19' } });
    expect(res.statusCode).toBe(206);
    expect(res.headers).toMatchObject({ 'content-range': 'bytes 10-19/1000', 'content-length': '10' });
    expect(Buffer.from(res.rawPayload).equals(body.subarray(10, 20))).toBe(true);
    res = await t.app.inject({ url, headers: { range: 'bytes=-5' } });
    expect(res.headers['content-range']).toBe('bytes 995-999/1000');
    expect(Buffer.from(res.rawPayload).equals(body.subarray(995))).toBe(true);
    res = await t.app.inject({ url, headers: { range: 'bytes=990-' } });
    expect(res.statusCode).toBe(206);
    expect(res.rawPayload.length).toBe(10);
    res = await t.app.inject({ url, headers: { range: 'bytes=900-5000' } });
    expect(res.headers['content-range']).toBe('bytes 900-999/1000');
    res = await t.app.inject({ url, headers: { range: 'bytes=1000-' } });
    expect(res.statusCode).toBe(416);
    expect(res.headers['content-range']).toBe('bytes */1000');
    // several ranges or a malformed header: the whole file
    res = await t.app.inject({ url, headers: { range: 'bytes=0-1,5-6' } });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.length).toBe(1000);

    res = await t.app.inject({ method: 'HEAD', url });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-length']).toBe('1000');
    expect(res.rawPayload.length).toBe(0);
    const etag = res.headers.etag as string;
    res = await t.app.inject({ url, headers: { 'if-none-match': etag } });
    expect(res.statusCode).toBe(304);
    expect(res.rawPayload.length).toBe(0);
    // If-Range with an old version: the whole new file
    res = await t.app.inject({ url, headers: { range: 'bytes=0-9', 'if-range': '"old"' } });
    expect(res.statusCode).toBe(200);
    res = await t.app.inject({ url, headers: { range: 'bytes=0-9', 'if-range': etag } });
    expect(res.statusCode).toBe(206);
  });

  it('never serves a key outside storage, even with a valid signature (path traversal)', async () => {
    if (dir) await writeFile(join(dir, 'secret.txt'), 'outside the media folder');
    // signed by the API's own key: storage still refuses the key (404); a URL whose dot segments a client
    // normalises no longer matches its signature (401)
    const links = [
      ...['../secret.txt', '../../secret.txt', 'originals/../../secret.txt', '..', '.meta/x', 'a\\..\\..\\secret.txt'].map((key) => ({ bucket: 'marketly-private', key })),
      ...['..', '.meta', 'marketly-private/..'].map((bucket) => ({ bucket, key: 'secret.txt' })),
    ];
    for (const l of links) {
      const res = await t.app.inject({ url: sign({ ...l, expiresAt: new Date(t.clock.now().getTime() + 60_000) }) });
      expect([401, 404], `${l.bucket}/${l.key}: ${res.statusCode}`).toContain(res.statusCode);
      expect(res.body).not.toContain('outside the media folder');
    }
    // encoded traversal without a signature never reaches storage
    expect((await t.app.inject({ url: '/files/marketly-private/..%2F..%2Fsecret.txt' })).statusCode).toBe(401);
    expect((await t.app.inject({ url: '/files/../secret.txt' })).statusCode).toBe(401);
  });

  it('answers 404 for a signed link to a file that is gone', async () => {
    const res = await t.app.inject({ url: sign({ bucket: 'marketly-private', key: `originals/${newId()}.png`, expiresAt: new Date(t.clock.now().getTime() + 60_000) }) });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('streams an upload into storage and refuses more than the ticket allows, keeping nothing', async () => {
    const seller = callers.seller();
    const start = async (sizeBytes: number) => (await startUpload(t, 'seller', seller, { purpose: 'product_image', sizeBytes })).json();
    // a declared Content-Length above the ticket: refused before reading
    let ticket = await start(100);
    let res = await putContent(t, ticket, seller, Buffer.alloc(150));
    expect(res.statusCode).toBe(413);
    expect(res.json().error).toMatchObject({ code: 'FILE_TOO_LARGE', details: { maxBytes: 100, receivedBytes: 150 } });
    expect(res.headers.connection).toBe('close');
    // chunked (no Content-Length): counted while it streams
    ticket = await start(100);
    res = await t.app.inject({
      method: 'PUT',
      url: pathOf(ticket.url),
      headers: { ...auth(seller), 'content-type': 'image/png' },
      payload: Readable.from([Buffer.alloc(60, 1), Buffer.alloc(60, 2), Buffer.alloc(60, 3)]),
    });
    expect(res.statusCode, res.body).toBe(413);
    expect(res.json().error.details).toMatchObject({ maxBytes: 100 });
    expect(res.json().error.details.receivedBytes).toBeGreaterThan(100);
    expect(await storage.head('marketly-private', `originals/${ticket.assetId}.png`)).toBeNull();
    // the right size, chunked, is stored whole
    const body = png(900, 900, { seed: `chunked-${kind}` });
    ticket = await start(body.length);
    res = await t.app.inject({ method: 'PUT', url: pathOf(ticket.url), headers: { ...auth(seller), 'content-type': 'image/png' }, payload: Readable.from([body.subarray(0, 50), body.subarray(50)]) });
    expect(res.statusCode, res.body).toBe(204);
    expect(await storage.head('marketly-private', `originals/${ticket.assetId}.png`)).toMatchObject({ sizeBytes: body.length, contentType: 'image/png' });
  });

  it('over a real socket: a chunked upload streams in, the file streams out in ranges', async () => {
    const address = await t.app.listen({ port: 0, host: '127.0.0.1' });
    const seller = callers.seller();
    const body = Buffer.concat([pdf(3), Buffer.alloc(256 * 1024, 7)]); // several socket reads
    const ticket = (await startUpload(t, 'seller', seller, { purpose: 'verification_document', fileName: 'big.pdf', contentType: 'application/pdf', sizeBytes: body.length })).json();
    const parts = [body.subarray(0, 1000), body.subarray(1000, 100_000), body.subarray(100_000)];
    const put = await fetch(address + pathOf(ticket.url), {
      method: 'PUT',
      headers: { ...auth(seller), 'content-type': 'application/pdf' },
      body: new ReadableStream({ pull: (c) => (parts.length ? c.enqueue(parts.shift()!) : c.close()) }),
      duplex: 'half',
    } as RequestInit);
    expect(put.status, await put.text()).toBe(204);
    expect((await storage.head('marketly-private', `originals/${ticket.assetId}.pdf`))?.sizeBytes).toBe(body.length);

    const url = address + (sign({ bucket: 'marketly-private', key: `originals/${ticket.assetId}.pdf`, expiresAt: new Date(t.clock.now().getTime() + 60_000), contentType: 'application/pdf' }));
    const whole = await fetch(url);
    expect(whole.status).toBe(200);
    expect(Buffer.from(await whole.arrayBuffer()).equals(body)).toBe(true);
    const part = await fetch(url, { headers: { range: `bytes=${body.length - 100}-` } });
    expect(part.status).toBe(206);
    expect(Buffer.from(await part.arrayBuffer()).equals(body.subarray(body.length - 100))).toBe(true);
    expect((await fetch(url.replace('sig=', 'sig=x'))).status).toBe(401);
  });

  it('serves the placeholder at the same public link after a takedown, and the photo again after restore', async () => {
    const { asset } = await uploadFile(t, 'seller', callers.seller(), { purpose: 'product_image', body: png(1000, 1000, { seed: `takedown-${kind}` }) });
    const before = await get(asset.url!);
    await t.app.inject({ method: 'POST', url: `/api/admin/media/assets/${asset.id}/remove`, headers: auth(callers.staff()), payload: { reason: 'Rights complaint', showPlaceholder: true } });
    const during = await get(asset.url!);
    expect(during.statusCode).toBe(200);
    expect(during.headers['content-type']).toBe('image/png');
    expect(during.headers.etag).not.toBe(before.headers.etag);
    expect((await get(asset.url!, { 'if-none-match': before.headers.etag as string })).statusCode).toBe(200); // cached copies revalidate to the placeholder
    await t.app.inject({ method: 'POST', url: `/api/admin/media/assets/${asset.id}/restore`, headers: auth(callers.staff()), payload: { reason: 'Withdrawn' } });
    expect(Buffer.from((await get(asset.url!)).rawPayload).equals(Buffer.from(before.rawPayload))).toBe(true);
  });
});
