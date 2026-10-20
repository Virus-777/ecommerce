/**
 * Signed file links (docs/03-auth-middleware.md §0 "File links"). Files kept on the server (media's
 * memory and local-disk storage) are served by the API at
 *
 *   GET /files/{bucket}/{key}?exp=<unix seconds>&ct=<content type>&cd=<content disposition>&sig=<HMAC>
 *
 * An <img src> or a download link can't send an Authorization header, so the link's own signature is
 * its token: HMAC-SHA256 with the owning module's key (secretFor(config, '<module>.files')) over the
 * exact bucket, key, expiry, content type and disposition. The middleware (chain.ts, auth kind
 * `file-link`) verifies it before any module code runs; changing any part of the link breaks it.
 *
 * Links without `exp` are permanent and only valid for the buckets the file route declares public
 * (product images and other public renditions, whose URLs are stored and embedded in pages).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Config } from '../config/index.js';
import { secretFor } from '../lib/secrets.js';

export const FILES_PREFIX = '/files/';

export interface FileLink {
  bucket: string;
  key: string;
  /** null: a permanent link (public buckets only) */
  expiresAt: Date | null;
  /** Content-Type the file is served with (default: the stored one) */
  contentType?: string | null;
  /** Content-Disposition the file is served with (default: none) */
  disposition?: string | null;
}

export type FileLinkFailure = 'missing' | 'invalid' | 'expired';

/** The key that signs a module's file links: secretFor(config, '<module>.files') */
export const fileLinkSecret = (config: Pick<Config, 'appSecret'>, module: string) => secretFor(config, `${module}.files`);

const encodeKey = (key: string) => key.split('/').map(encodeURIComponent).join('/');

function mac(secret: string, l: { bucket: string; key: string; exp: string; ct: string; cd: string }) {
  return createHmac('sha256', secret).update(['marketly-file-link-v1', 'GET', l.bucket, l.key, l.exp, l.ct, l.cd].join('\n')).digest('base64url');
}

/** Path and query of a signed link (prefix it with the API's public address) */
export function signFileLink(secret: string, link: FileLink): string {
  const exp = link.expiresAt ? String(Math.floor(link.expiresAt.getTime() / 1000)) : '';
  const ct = link.contentType ?? '';
  const cd = link.disposition ?? '';
  const q = new URLSearchParams();
  if (exp) q.set('exp', exp);
  if (ct) q.set('ct', ct);
  if (cd) q.set('cd', cd);
  q.set('sig', mac(secret, { bucket: link.bucket, key: link.key, exp, ct, cd }));
  return `${FILES_PREFIX}${encodeURIComponent(link.bucket)}/${encodeKey(link.key)}?${q}`;
}

/**
 * Verifies a request URL (path and query, as received) against the signing key. The file it names is
 * the one in the link: callers serve `link`, never their own reading of the URL.
 */
/**
 * `secret`: the signing key, or a function giving the key of the module that serves a bucket (undefined: no module
 * serves it, so no link to it is valid).
 */
export function verifyFileLink(
  secret: string | ((bucket: string) => string | undefined),
  url: string,
  now: Date,
  opts: { permanentBuckets: ReadonlySet<string> },
): { ok: true; link: FileLink } | { ok: false; reason: FileLinkFailure } {
  const at = url.indexOf('?');
  const path = at < 0 ? url : url.slice(0, at);
  const q = new URLSearchParams(at < 0 ? '' : url.slice(at + 1));
  if (!path.startsWith(FILES_PREFIX)) return { ok: false, reason: 'invalid' };
  const [rawBucket = '', ...rawKey] = path.slice(FILES_PREFIX.length).split('/');
  let bucket: string;
  let key: string;
  try {
    bucket = decodeURIComponent(rawBucket);
    key = rawKey.map(decodeURIComponent).join('/');
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  const sig = q.get('sig');
  if (!sig) return { ok: false, reason: 'missing' };
  if (!bucket || !key) return { ok: false, reason: 'invalid' };
  const exp = q.get('exp') ?? '';
  const ct = q.get('ct') ?? '';
  const cd = q.get('cd') ?? '';
  const key_ = typeof secret === 'string' ? secret : secret(bucket);
  if (!key_) return { ok: false, reason: 'invalid' };
  const expected = Buffer.from(mac(key_, { bucket, key, exp, ct, cd }));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, reason: 'invalid' };
  let expiresAt: Date | null = null;
  if (exp) {
    if (!/^\d{1,12}$/.test(exp)) return { ok: false, reason: 'invalid' };
    expiresAt = new Date(Number(exp) * 1000);
    if (expiresAt.getTime() < now.getTime()) return { ok: false, reason: 'expired' };
  } else if (!opts.permanentBuckets.has(bucket)) {
    return { ok: false, reason: 'invalid' }; // a link without expiry only opens public files
  }
  return { ok: true, link: { bucket, key, expiresAt, contentType: ct || null, disposition: cd || null } };
}
