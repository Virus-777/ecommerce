/**
 * Impression tokens: one signed token per ad on a page view. Tracking events carry it back, so displays,
 * clicks and dismissals are tied to the decision that showed the ad (campaign, creative, visitor, session)
 * without trusting anything else the client sends. HMAC-SHA256 with the module's own key.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export interface ImpressionClaims {
  /** impression id */
  i: string;
  /** campaign id */
  c: string;
  /** creative id */
  k: string;
  /** placement key */
  p: string;
  /** hashed visitor keys: visitor, and customer when signed in */
  v: string[];
  /** session id */
  s: string;
  /** customer id when signed in */
  u: string | null;
  /** page type */
  g: string;
  /** device */
  d: string;
  /** issued at (epoch seconds) */
  t: number;
  /** expires (epoch seconds) */
  e: number;
}

const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export function signImpression(claims: ImpressionClaims, secret: string): string {
  const body = b64(JSON.stringify(claims));
  const mac = createHmac('sha256', secret).update(body).digest().subarray(0, 18);
  return `${body}.${b64(mac)}`;
}

export type TokenCheck = { ok: true; claims: ImpressionClaims } | { ok: false; reason: 'malformed' | 'signature' | 'expired' };

export function verifyImpression(token: string, secret: string, nowMs: number): TokenCheck {
  if (typeof token !== 'string' || token.length > 2048) return { ok: false, reason: 'malformed' };
  const [body, mac, extra] = token.split('.');
  if (!body || !mac || extra !== undefined) return { ok: false, reason: 'malformed' };
  const expected = createHmac('sha256', secret).update(body).digest().subarray(0, 18);
  const given = Buffer.from(mac, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: 'signature' };
  let claims: ImpressionClaims;
  try {
    claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as ImpressionClaims;
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!claims || typeof claims.i !== 'string' || typeof claims.c !== 'string' || !Array.isArray(claims.v)) return { ok: false, reason: 'malformed' };
  if (claims.e * 1000 < nowMs) return { ok: false, reason: 'expired' };
  return { ok: true, claims };
}

/** First-party visitor, customer or (without personalization) session id → the hashed key stored with counters and events */
export const visitorKey = (kind: 'v' | 'c' | 's', id: string, secret: string) => createHash('sha256').update(`${secret}:${kind}:${id}`).digest('base64url').slice(0, 32);

/** Deterministic event id per impression and kind: duplicates of the same event are ignored */
export function eventId(impressionId: string, kind: string): string {
  const h = createHash('sha256').update(`${impressionId}:${kind}`).digest('hex');
  // shaped as a UUID (version 8, RFC 9562 custom) so it fits the uuid column
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${((parseInt(h.slice(16, 17), 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
