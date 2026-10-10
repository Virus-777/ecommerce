/**
 * Memory storage (MEDIA_STORAGE=memory, the default in tests): objects in a Map, gone when the process
 * stops. Behaves like local-disk storage (the shared contract tests in storage.test.ts run on both):
 * uploads come through the API (PUT /uploads/{id}/content) and downloads are signed links to the API's
 * GET /files/{bucket}/{key} (links.ts).
 *
 * Test helpers: acceptSignedPut() "uploads" the way a direct-upload store would, checking a presigned
 * URL's signature, expiry, size and type (given a ticket's API URL it follows resolveUploadUrl to the
 * signed URL behind it); fetch() follows a download link, verifying it as the middleware does.
 */
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { verifyFileLink } from '../../../../kernel/auth/file-links.js';
import type { Clock } from '../../../../kernel/lib/clock.js';
import { ObjectTooLargeError, type OpenedObject, type PresignedUpload, type StorageProvider, type StoredObject } from '../../ports.js';
import { checkKey } from './keys.js';
import { DEFAULT_BUCKETS, fileLinks, type FileLinkOptions } from './links.js';

/** Where acceptSignedPut's presigned upload URLs point (no network: only acceptSignedPut understands them) */
const UPLOAD_ORIGIN = 'https://storage.marketly.test';

interface Entry extends StoredObject {
  body: Uint8Array;
  lastModified: Date;
}

export interface MemoryStorage extends StorageProvider {
  presignUpload: NonNullable<StorageProvider['presignUpload']>;
  /** What a client's PUT to a presigned upload URL (or an upload ticket's API URL) does: verifies the URL and stores the bytes */
  acceptSignedPut(url: string, body: Uint8Array, contentType?: string): Promise<{ bucket: string; key: string; object: StoredObject }>;
  /** Follows a download link (GET /files/…): the bytes, or null when the link is invalid or expired or the object is gone */
  fetch(url: string): Promise<{ body: Uint8Array; contentType: string | null; disposition: string | null } | null>;
  /** Objects currently stored (tests) */
  size(bucket?: string): number;
}

const encodeKey = (key: string) => key.split('/').map(encodeURIComponent).join('/');
const decodeKey = (path: string) => path.split('/').map(decodeURIComponent).join('/');

/** Reads a stream into memory, refusing more than maxBytes */
export async function collect(body: AsyncIterable<Uint8Array>, maxBytes = Infinity): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let n = 0;
  for await (const chunk of body) {
    n += chunk.byteLength;
    if (n > maxBytes) throw new ObjectTooLargeError(maxBytes, n);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function createMemoryStorage(opts: {
  clock: Clock;
  /** Download links: the API's address and media's file-link key */
  links: Omit<FileLinkOptions, 'buckets'>;
  /** Signs acceptSignedPut's presigned upload URLs (secretFor(config, 'media.storage')) */
  uploadSecret: string;
  buckets?: { public: string; private: string };
  /** The signed upload URL behind an upload ticket's API URL (PUT /api/{area}/media/uploads/{id}/content), or null */
  resolveUploadUrl?: (url: string) => Promise<string | null>;
}): MemoryStorage {
  const buckets = opts.buckets ?? { ...DEFAULT_BUCKETS };
  const links = fileLinks({ ...opts.links, buckets });
  const store = new Map<string, Map<string, Entry>>();
  const bucket = (name: string) => {
    let b = store.get(name);
    if (!b) store.set(name, (b = new Map()));
    return b;
  };
  const sign = (parts: string[]) => createHmac('sha256', opts.uploadSecret).update(parts.join('\n')).digest('hex');
  const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
  const nowSeconds = () => Math.floor(opts.clock.now().getTime() / 1000);
  const meta = ({ body: _b, lastModified: _l, ...m }: Entry): StoredObject => m;
  const entry = (b: string, key: string) => {
    checkKey(b, key);
    return store.get(b)?.get(key);
  };

  const write = (b: string, key: string, body: Uint8Array, contentType: string): StoredObject => {
    checkKey(b, key);
    const e: Entry = {
      body: Uint8Array.from(body),
      sizeBytes: body.byteLength,
      etag: createHash('md5').update(body).digest('hex'),
      sha256: createHash('sha256').update(body).digest('hex'),
      versionId: randomUUID(),
      contentType,
      lastModified: opts.clock.now(),
    };
    bucket(b).set(key, e);
    return meta(e);
  };

  /** Splits a presigned upload URL into bucket, key and query, or null when it isn't one */
  const parseUpload = (url: string) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return null;
    }
    if (u.origin !== UPLOAD_ORIGIN) return null;
    const [, b, ...rest] = u.pathname.split('/');
    if (!b || !rest.length) return null;
    return { bucket: b, key: decodeKey(rest.join('/')), q: u.searchParams };
  };

  return {
    buckets,
    viaApi: true,
    ...links,

    async presignUpload({ bucket: b, key, contentType, maxBytes, expiresAt }): Promise<PresignedUpload> {
      const exp = String(Math.floor(expiresAt.getTime() / 1000));
      const sig = sign(['PUT', b, key, contentType, String(maxBytes), exp]);
      const q = new URLSearchParams({ 'X-Expires': exp, 'X-Max-Bytes': String(maxBytes), 'X-Content-Type': contentType, 'X-Signature': sig });
      return { method: 'PUT', url: `${UPLOAD_ORIGIN}/${b}/${encodeKey(key)}?${q}`, headers: { 'content-type': contentType }, fields: {} };
    },

    async head(b, key) {
      const e = entry(b, key);
      return e ? meta(e) : null;
    },
    async get(b, key) {
      const e = entry(b, key);
      return e ? Uint8Array.from(e.body) : null;
    },
    async put(b, key, body, contentType) {
      return write(b, key, body, contentType);
    },
    async putStream(b, key, body, contentType, o = {}) {
      checkKey(b, key);
      return write(b, key, await collect(body, o.maxBytes), contentType);
    },
    async open(b, key): Promise<OpenedObject | null> {
      const e = entry(b, key);
      if (!e) return null;
      const body = e.body;
      return {
        ...meta(e),
        lastModified: e.lastModified,
        stream: (range) => Readable.from([Buffer.from(range ? body.subarray(range.start, range.end + 1) : body)]),
        close: async () => {},
      };
    },
    async copy(from, to) {
      const e = entry(from.bucket, from.key);
      if (!e) return false;
      write(to.bucket, to.key, e.body, e.contentType ?? 'application/octet-stream');
      return true;
    },
    async delete(b, key) {
      checkKey(b, key);
      store.get(b)?.delete(key);
    },
    async list(b, { prefix = '', after, limit = 1000 } = {}) {
      return [...(store.get(b)?.keys() ?? [])]
        .filter((k) => k.startsWith(prefix) && (!after || k > after))
        .sort()
        .slice(0, limit);
    },

    async acceptSignedPut(url, body, contentType) {
      let p = parseUpload(url);
      if (!p && opts.resolveUploadUrl) {
        const signed = await opts.resolveUploadUrl(url);
        if (signed) p = parseUpload(signed);
      }
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
      let path: string;
      try {
        const u = new URL(url);
        if (u.origin !== new URL(opts.links.baseUrl).origin) return null;
        path = u.pathname + u.search;
      } catch {
        return null;
      }
      const v = verifyFileLink(opts.links.secret, path, opts.clock.now(), { permanentBuckets: new Set([buckets.public]) });
      if (!v.ok) return null;
      const e = store.get(v.link.bucket)?.get(v.link.key);
      return e ? { body: Uint8Array.from(e.body), contentType: v.link.contentType ?? e.contentType ?? null, disposition: v.link.disposition ?? null } : null;
    },

    size: (b) => (b ? (store.get(b)?.size ?? 0) : [...store.values()].reduce((n, m) => n + m.size, 0)),
  };
}
