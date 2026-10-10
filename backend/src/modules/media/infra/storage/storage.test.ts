/**
 * The storage contract, run on every adapter the API can be configured with (MEDIA_STORAGE=memory|local),
 * plus what only the local file system can get wrong (paths, temp files, folders).
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { verifyFileLink } from '../../../../kernel/auth/file-links.js';
import { fixedClock } from '../../../../kernel/lib/clock.js';
import { InvalidObjectKeyError, ObjectTooLargeError, type StorageProvider } from '../../ports.js';
import { createLocalStorage } from './local.js';
import { createMemoryStorage } from './memory.js';

const SECRET = 'file-link-secret';
const links = { secret: SECRET, baseUrl: 'https://api.marketly.test' };
const clock = fixedClock(new Date('2026-10-10T12:00:00Z'));
const dirs: string[] = [];

async function newLocal() {
  const dir = await mkdtemp(join(tmpdir(), 'marketly-media-'));
  dirs.push(dir);
  return createLocalStorage({ dir: join(dir, 'media'), links });
}

afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const adapters: [string, () => Promise<StorageProvider>][] = [
  ['memory', async () => createMemoryStorage({ clock, links, uploadSecret: 'upload-secret' })],
  ['local', newLocal],
];

const md5 = (b: Uint8Array) => createHash('md5').update(b).digest('hex');
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const B = 'marketly-private';
async function* chunks(...parts: (string | Buffer)[]) {
  for (const p of parts) yield Buffer.from(p);
}
const readAll = async (s: Readable) => {
  const out: Buffer[] = [];
  for await (const c of s) out.push(Buffer.from(c));
  return Buffer.concat(out);
};

describe.each(adapters)('%s storage (contract)', (_name, make) => {
  let s: StorageProvider;
  beforeEach(async () => {
    s = await make();
  });

  it('serves its bytes through the API (viaApi) from two buckets', () => {
    expect(s.viaApi).toBe(true);
    expect(s.buckets).toEqual({ public: 'marketly-public', private: 'marketly-private' });
  });

  it('stores, describes and returns an object', async () => {
    const body = Buffer.from('hello world');
    const stored = await s.put(B, 'originals/a.png', body, 'image/png');
    expect(stored).toMatchObject({ sizeBytes: body.length, etag: md5(body), sha256: sha256(body), contentType: 'image/png' });
    expect(stored.versionId).toBeTruthy();
    expect(await s.head(B, 'originals/a.png')).toEqual(stored);
    expect(Buffer.from((await s.get(B, 'originals/a.png'))!).equals(body)).toBe(true);
    expect(await s.head(B, 'originals/missing.png')).toBeNull();
    expect(await s.get(B, 'originals/missing.png')).toBeNull();
    expect(await s.open(B, 'originals/missing.png')).toBeNull();
    // the other bucket is another namespace
    expect(await s.head('marketly-public', 'originals/a.png')).toBeNull();
  });

  it('replaces an object as a whole, with a new version', async () => {
    const first = await s.put(B, 'k/x.bin', Buffer.from('first version'), 'application/octet-stream');
    const second = await s.put(B, 'k/x.bin', Buffer.from('v2'), 'text/plain');
    expect(second.versionId).not.toBe(first.versionId);
    expect(await s.head(B, 'k/x.bin')).toMatchObject({ sizeBytes: 2, contentType: 'text/plain', etag: md5(Buffer.from('v2')) });
    expect(Buffer.from((await s.get(B, 'k/x.bin'))!).toString()).toBe('v2');
  });

  it('writes a stream in chunks and hashes it as it goes', async () => {
    const stored = await s.putStream(B, 'streams/a.bin', chunks('abc', 'def', 'ghi'), 'application/octet-stream', { maxBytes: 9 });
    expect(stored).toMatchObject({ sizeBytes: 9, sha256: sha256(Buffer.from('abcdefghi')) });
    expect(Buffer.from((await s.get(B, 'streams/a.bin'))!).toString()).toBe('abcdefghi');
  });

  it('stops a stream above maxBytes and stores nothing (an earlier object stays)', async () => {
    await expect(s.putStream(B, 'streams/big.bin', chunks('12345', '67890', 'x'), 'application/octet-stream', { maxBytes: 8 })).rejects.toBeInstanceOf(ObjectTooLargeError);
    expect(await s.head(B, 'streams/big.bin')).toBeNull();
    await s.put(B, 'streams/keep.bin', Buffer.from('kept'), 'text/plain');
    const err = await s.putStream(B, 'streams/keep.bin', chunks('123', '456'), 'text/plain', { maxBytes: 4 }).catch((e) => e);
    expect(err).toBeInstanceOf(ObjectTooLargeError);
    expect(err).toMatchObject({ maxBytes: 4, receivedBytes: 6 });
    expect(Buffer.from((await s.get(B, 'streams/keep.bin'))!).toString()).toBe('kept');
  });

  it('opens an object for streaming, whole or a byte range', async () => {
    const body = Buffer.from('0123456789');
    const stored = await s.put(B, 'files/digits.txt', body, 'text/plain');
    let o = (await s.open(B, 'files/digits.txt'))!;
    expect(o).toMatchObject({ sizeBytes: 10, etag: stored.etag, contentType: 'text/plain' });
    expect(o.lastModified).toBeInstanceOf(Date);
    expect((await readAll(o.stream())).toString()).toBe('0123456789');
    o = (await s.open(B, 'files/digits.txt'))!;
    expect((await readAll(o.stream({ start: 2, end: 5 }))).toString()).toBe('2345');
    o = (await s.open(B, 'files/digits.txt'))!;
    await o.close(); // opened and released without reading
  });

  it('copies, deletes (idempotently) and lists in key order, in pages', async () => {
    expect(await s.copy({ bucket: B, key: 'none/x' }, { bucket: B, key: 'none/y' })).toBe(false);
    await s.put('marketly-public', 'renditions/r1/thumb.webp', Buffer.from('t'), 'image/webp');
    expect(await s.copy({ bucket: 'marketly-public', key: 'renditions/r1/thumb.webp' }, { bucket: B, key: 'removed/renditions/r1/thumb.webp' })).toBe(true);
    expect(await s.head(B, 'removed/renditions/r1/thumb.webp')).toMatchObject({ sizeBytes: 1, contentType: 'image/webp' });

    for (const key of ['b', 'a-c', 'a/c/d', 'a/b', 'a.z', 'aa/x']) await s.put(B, key, Buffer.from(key), 'text/plain');
    const all = ['a-c', 'a.z', 'a/b', 'a/c/d', 'aa/x', 'b', 'removed/renditions/r1/thumb.webp'];
    expect(all).toEqual([...all].sort());
    expect(await s.list(B)).toEqual(all);
    // paging with after
    const pages: string[] = [];
    let after: string | undefined;
    for (;;) {
      const page = await s.list(B, { after, limit: 2 });
      if (!page.length) break;
      pages.push(...page);
      after = page.at(-1);
    }
    expect(pages).toEqual(all);
    expect(await s.list(B, { prefix: 'a/' })).toEqual(['a/b', 'a/c/d']);
    expect(await s.list(B, { prefix: 'a', after: 'a/b' })).toEqual(['a/c/d', 'aa/x']);

    await s.delete(B, 'a/c/d');
    await s.delete(B, 'a/c/d');
    await s.delete(B, 'never/there');
    expect(await s.head(B, 'a/c/d')).toBeNull();
    expect(await s.list(B, { prefix: 'a/' })).toEqual(['a/b']);
  });

  it.each([
    ['../escape.txt'],
    ['a/../../escape.txt'],
    ['..'],
    ['/etc/passwd'],
    ['a//b'],
    ['a/./b'],
    ['.hidden'],
    ['a\\..\\b'],
    ['C:/Windows/win.ini'],
    ['con'],
    ['nul.txt'],
    ['trailing.'],
    ['with space'],
    ['nul\0byte'],
    [''],
  ])('refuses the key %j (path traversal and unsafe names)', async (key) => {
    await expect(s.put(B, key, Buffer.from('x'), 'text/plain')).rejects.toBeInstanceOf(InvalidObjectKeyError);
    await expect(s.putStream(B, key, chunks('x'), 'text/plain')).rejects.toBeInstanceOf(InvalidObjectKeyError);
    await expect(s.head(B, key)).rejects.toBeInstanceOf(InvalidObjectKeyError);
    await expect(s.get(B, key)).rejects.toBeInstanceOf(InvalidObjectKeyError);
    await expect(s.open(B, key)).rejects.toBeInstanceOf(InvalidObjectKeyError);
    await expect(s.delete(B, key)).rejects.toBeInstanceOf(InvalidObjectKeyError);
  });

  it.each([['..'], ['../x'], ['Upper'], ['a/b'], ['.meta'], ['']])('refuses the bucket %j', async (bucket) => {
    await expect(s.put(bucket, 'k', Buffer.from('x'), 'text/plain')).rejects.toBeInstanceOf(InvalidObjectKeyError);
    await expect(s.head(bucket, 'k')).rejects.toBeInstanceOf(InvalidObjectKeyError);
  });

  it('signs download links the middleware accepts: private ones expire, public ones are permanent', async () => {
    const at = (url: string) => {
      const u = new URL(url);
      expect(u.origin).toBe('https://api.marketly.test');
      return u.pathname + u.search;
    };
    const permanent = { permanentBuckets: new Set(['marketly-public']) };
    const expiresAt = new Date(clock.now().getTime() + 600_000);
    const link = await s.presignDownload({ bucket: B, key: 'docs/license.pdf', expiresAt, fileName: 'license "v2".pdf', contentType: 'application/pdf' });
    const v = verifyFileLink(SECRET, at(link), clock.now(), permanent);
    expect(v).toEqual({ ok: true, link: { bucket: B, key: 'docs/license.pdf', expiresAt: new Date(Math.floor(expiresAt.getTime() / 1000) * 1000), contentType: 'application/pdf', disposition: 'attachment; filename="license _v2_.pdf"' } });
    expect(verifyFileLink(SECRET, at(link), new Date(expiresAt.getTime() + 1000), permanent)).toEqual({ ok: false, reason: 'expired' });
    expect(verifyFileLink('another-secret', at(link), clock.now(), permanent)).toEqual({ ok: false, reason: 'invalid' });

    const pub = s.publicUrl('renditions/r1/medium.webp');
    expect(verifyFileLink(SECRET, at(pub), new Date('2099-01-01'), permanent)).toMatchObject({ ok: true, link: { bucket: 'marketly-public', key: 'renditions/r1/medium.webp', expiresAt: null } });
    // the unsigned location of a private object opens nothing
    expect(verifyFileLink(SECRET, at(s.objectUrl(B, 'renditions/r1/medium.webp')), clock.now(), permanent)).toEqual({ ok: false, reason: 'missing' });
  });
});

describe('local storage on disk', () => {
  it('keeps buckets as folders under the configured directory, metadata and temp files apart', async () => {
    const s = await newLocal();
    await s.put(B, 'originals/a.png', Buffer.from('png'), 'image/png');
    expect(existsSync(join(s.dir, B, 'originals', 'a.png'))).toBe(true);
    expect(existsSync(join(s.dir, '.meta', B, 'originals', 'a.png.json'))).toBe(true);
    expect(await readdir(join(s.dir, '.tmp'))).toEqual([]);
  });

  it('leaves no temp file behind when a write is refused, and nothing outside the directory', async () => {
    const s = await newLocal();
    await expect(s.putStream(B, 'big.bin', chunks('123456'), 'text/plain', { maxBytes: 3 })).rejects.toBeInstanceOf(ObjectTooLargeError);
    await expect(s.put(B, '../../outside.txt', Buffer.from('x'), 'text/plain')).rejects.toBeInstanceOf(InvalidObjectKeyError);
    expect(await readdir(join(s.dir, '.tmp'))).toEqual([]);
    expect(existsSync(join(s.dir, '..', 'outside.txt'))).toBe(false);
    expect(existsSync(join(s.dir, B, 'big.bin'))).toBe(false);
  });

  it('removes emptied folders on delete and ignores stray files it did not write', async () => {
    const s = await newLocal();
    await s.put(B, 'renditions/r9/thumb.webp', Buffer.from('t'), 'image/webp');
    await s.delete(B, 'renditions/r9/thumb.webp');
    expect(existsSync(join(s.dir, B, 'renditions'))).toBe(false);
    expect(existsSync(join(s.dir, B))).toBe(true);
    await mkdir(join(s.dir, B, 'x'), { recursive: true });
    await writeFile(join(s.dir, B, 'x', 'odd name.txt'), 'x');
    await s.put(B, 'x/ok.txt', Buffer.from('ok'), 'text/plain');
    expect(await s.list(B)).toEqual(['x/ok.txt']);
  });

  it('describes a file whose metadata is missing from the file itself', async () => {
    const s = await newLocal();
    await s.put(B, 'm/a.txt', Buffer.from('abc'), 'text/plain');
    await rm(join(s.dir, '.meta', B, 'm', 'a.txt.json'));
    expect(await s.head(B, 'm/a.txt')).toMatchObject({ sizeBytes: 3, contentType: null, sha256: null });
  });

  it('keeps a stream that was opened readable while the object is replaced', async () => {
    const s = await newLocal();
    await s.put(B, 'swap.txt', Buffer.from('old bytes'), 'text/plain');
    const o = (await s.open(B, 'swap.txt'))!;
    await s.put(B, 'swap.txt', Buffer.from('new'), 'text/plain');
    expect((await readAll(o.stream())).toString()).toBe('old bytes');
    expect(Buffer.from((await s.get(B, 'swap.txt'))!).toString()).toBe('new');
  });
});
