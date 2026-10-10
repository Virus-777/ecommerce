/**
 * Which buckets and keys storage accepts, for every adapter. Keys are '/'-separated segments of
 * letters, digits, '.', '_' and '-' (e.g. originals/<uuid>.png, renditions/<uuid>/thumb.webp), so a key
 * can never climb out of its bucket on a file system ('..', absolute paths, backslashes, drive letters),
 * name a hidden or temporary file (leading '.'), or alias another on Windows (reserved device names,
 * trailing dots).
 */
import { InvalidObjectKeyError } from '../../ports.js';

const BUCKET = /^[a-z0-9][a-z0-9-]{1,62}$/;
const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,254}$/;
/** Windows device names, with or without an extension */
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
const MAX_KEY = 1024;

export const isValidBucket = (bucket: string) => typeof bucket === 'string' && BUCKET.test(bucket);

export function isValidKey(key: string): boolean {
  if (typeof key !== 'string' || !key || key.length > MAX_KEY) return false;
  return key.split('/').every((s) => SEGMENT.test(s) && !s.endsWith('.') && !RESERVED.test(s));
}

/** The key's segments; throws InvalidObjectKeyError when the bucket or key isn't safe */
export function checkKey(bucket: string, key: string): string[] {
  if (!isValidBucket(bucket) || !isValidKey(key)) throw new InvalidObjectKeyError(bucket, key);
  return key.split('/');
}
