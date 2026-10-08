/**
 * Development storage: objects in memory, presigned URLs signed with HMAC-SHA256 and an expiry, the
 * way S3 presigned URLs work. No network: the URLs point at storage.marketly.test, and tests (or a
 * dev tool) "upload" through acceptSignedPut(), which checks the signature, expiry, size and type
 * exactly as the real store would. An S3-compatible adapter replaces it behind StorageProvider.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { Clock } from '../../../../kernel/lib/clock.js';
import type { PresignedUpload, StorageProvider, StoredObject } from '../../ports.js';

const STORAGE_ORIGIN = 'https://storage.marketly.test';
const CDN_ORIGIN = 'https://cdn.marketly.test';

interface Entry extends StoredObject {
  body: Uint8Array;
}

export interface DevStorage extends StorageProvider {
  /** What a client's PUT to a presigned upload URL does: verifies the URL and stores the bytes */
  acceptSignedPut(url: string, body: Uint8Array, contentType?: string): Promise<{ bucket: string; key: string; object: StoredObject }>;
  /** Follows a presigned download URL (or a public CDN URL): the bytes, or null when the link is invalid or expired */
  fetch(url: string): Promise<{ body: Uint8Array; contentType: string | null; disposition: string | null } | null>;
  /** Objects currently stored (tests) */
  size(bucket?: string): number;
}

const encodeKey = (key: string) => key.split('/').map(encodeURIComponent).join('/');
const decodeKey = (path: string) => path.split('/').map(decodeURIComponent).join('/');

export function createDevStorage(opts: { secret: string; clock: Clock; buckets?: { public: string; private: string } }): DevStorage {
  const buckets = opts.buckets ?? { public: 'marketly-public', private: 'marketly-private' };
  const store = new Map<string, Map<string, Entry>>();
  let version = 0;
  const bucket = (name: string) => {
    let b = store.get(name);
    if (!b) store.set(name, (b = new Map()));
    return b;
  };
  const sign = (parts: string[]) => createHmac('sha256', opts.secret).update(parts.join('\n')).digest('hex');
  const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
  const nowSeconds = () => Math.floor(opts.clock.now().getTime() / 1000);

  const write = (b: string, key: string, body: Uint8Array, contentType: string): StoredObject => {
    const entry: Entry = {
      body,
      sizeBytes: body.byteLength,
      etag: createHash('md5').update(body).digest('hex'),
      sha256: createHash('sha256').update(body).digest('hex'),
      versionId: String(++version),
      contentType,
    };
    bucket(b).set(key, entry);
    const { body: _b, ...meta } = entry;
    return meta;
  };

  /** Splits a storage URL into bucket, key and query, or null when it isn't one of ours */
  const parse = (url: string) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return null;
    }
    if (u.origin !== STORAGE_ORIGIN) return null;
    const [, b, ...rest] = u.pathname.split('/');
    if (!b || !rest.length) return null;
    return { bucket: b, key: decodeKey(rest.join('/')), q: u.searchParams };
  };

  return {
    buckets,

    async presignUpload({ bucket: b, key, contentType, maxBytes, expiresAt }): Promise<PresignedUpload> {
      const exp = String(Math.floor(expiresAt.getTime() / 1000));
      const sig = sign(['PUT', b, key, contentType, String(maxBytes), exp]);
      const q = new URLSearchParams({ 'X-Expires': exp, 'X-Max-Bytes': String(maxBytes), 'X-Content-Type': contentType, 'X-Signature': sig });
      return { method: 'PUT', url: `${STORAGE_ORIGIN}/${b}/${encodeKey(key)}?${q}`, headers: { 'content-type': contentType }, fields: {} };
    },

    async presignDownload({ bucket: b, key, expiresAt, fileName, contentType, inline }) {
      const exp = String(Math.floor(expiresAt.getTime() / 1000));
      const disposition = `${inline ? 'inline' : 'attachment'}; filename="${fileName.replace(/["\\\r\n]/g, '_')}"`;
      const sig = sign(['GET', b, key, contentType, disposition, exp]);
      const q = new URLSearchParams({ 'X-Expires': exp, 'X-Content-Type': contentType, 'X-Disposition': disposition, 'X-Signature': sig });
      return `${STORAGE_ORIGIN}/${b}/${encodeKey(key)}?${q}`;
    },

    publicUrl: (key) => `${CDN_ORIGIN}/${encodeKey(key)}`,
    objectUrl: (b, key) => `${STORAGE_ORIGIN}/${b}/${encodeKey(key)}`,

    async head(b, key) {
      const e = store.get(b)?.get(key);
      if (!e) return null;
      const { body: _b, ...meta } = e;
      return meta;
    },
    async get(b, key) {
      return store.get(b)?.get(key)?.body ?? null;
    },
    async put(b, key, body, contentType) {
      return write(b, key, body, contentType);
    },
    async copy(from, to) {
      const e = store.get(from.bucket)?.get(from.key);
      if (!e) return false;
      write(to.bucket, to.key, e.body, e.contentType ?? 'application/octet-stream');
      return true;
    },
    async delete(b, key) {
      store.get(b)?.delete(key);
    },
    async list(b, { prefix = '', after, limit = 1000 } = {}) {
      return [...(store.get(b)?.keys() ?? [])]
        .filter((k) => k.startsWith(prefix) && (!after || k > after))
        .sort()
        .slice(0, limit);
    },

    async acceptSignedPut(url, body, contentType) {
      const p = parse(url);
      if (!p) throw new Error('Not a storage URL');
      const exp = p.q.get('X-Expires') ?? '';
      const max = p.q.get('X-Max-Bytes') ?? '';
      const type = p.q.get('X-Content-Type') ?? '';
      const expected = sign(['PUT', p.bucket, p.key, type, max, exp]);
      if (!same(expected, p.q.get('X-Signature') ?? '')) throw new Error('SignatureDoesNotMatch');
      if (Number(exp) < nowSeconds()) throw new Error('AccessDenied: Request has expired');
      if (body.byteLength > Number(max)) throw new Error('EntityTooLarge');
      if (contentType !== undefined && contentType !== type) throw new Error('SignatureDoesNotMatch: content-type');
      return { bucket: p.bucket, key: p.key, object: write(p.bucket, p.key, body, type) };
    },

    async fetch(url) {
      if (url.startsWith(`${CDN_ORIGIN}/`)) {
        const e = store.get(buckets.public)?.get(decodeKey(url.slice(CDN_ORIGIN.length + 1)));
        return e ? { body: e.body, contentType: e.contentType ?? null, disposition: null } : null;
      }
      const p = parse(url);
      if (!p) return null;
      const exp = p.q.get('X-Expires') ?? '';
      const type = p.q.get('X-Content-Type') ?? '';
      const disposition = p.q.get('X-Disposition') ?? '';
      if (!same(sign(['GET', p.bucket, p.key, type, disposition, exp]), p.q.get('X-Signature') ?? '')) return null;
      if (Number(exp) < nowSeconds()) return null;
      const e = store.get(p.bucket)?.get(p.key);
      return e ? { body: e.body, contentType: type, disposition } : null;
    },

    size: (b) => (b ? (store.get(b)?.size ?? 0) : [...store.values()].reduce((n, m) => n + m.size, 0)),
  };
}
