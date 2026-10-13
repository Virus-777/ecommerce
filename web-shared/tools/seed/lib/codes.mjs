// Values the seed computes because the API only sends them by email or bank statement (brief §2.4).
import { createHash, createHmac, hkdfSync } from 'node:crypto';

/** The dev APP_SECRET used while DEV_TOKENS is on (backend/src/kernel/config/index.ts) */
export const DEV_APP_SECRET = 'dev-app-secret-not-for-production-use-0000';
export const DEV_WEBHOOK_SECRET = 'dev-webhook-secret';

/* ---------------------------------------------------------------- TOTP (RFC 6238, SHA-1, 30 s, 6 digits) */

function base32(s) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = s.replace(/[\s=-]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out = [];
  for (const c of clean) {
    const i = alphabet.indexOf(c);
    if (i < 0) throw new Error(`not base32: ${c}`);
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function totp(secretBase32, at = Date.now(), stepOffset = 0) {
  const counter = Math.floor(at / 1000 / 30) + stepOffset;
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', base32(secretBase32)).update(msg).digest();
  const o = h[h.length - 1] & 0x0f;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1_000_000).padStart(6, '0');
}

/* ---------------------------------------------------------------- sellers */

/** Seller invitation code (sellers/service/applications.ts codeFor + kernel/lib/secrets.ts secretFor) */
export function sellerInvitationCode(invitationId, appSecret = DEV_APP_SECRET) {
  const key = Buffer.from(hkdfSync('sha256', appSecret, 'marketly', 'sellers.seller-invitation', 32)).toString('hex');
  return createHmac('sha256', key).update(invitationId).digest('hex').slice(0, 12).toUpperCase();
}

/** Provider destination id the dev payout tokenizer gives a bank account (sellers/providers/dev.ts) */
export function providerDestinationId(routing, account) {
  return `pd_dev_${createHash('sha256').update(`${routing.trim()}:${account.trim()}`).digest('hex').slice(0, 24)}`;
}

/** The two micro-deposits (cents) the dev payout provider sends (finance/providers/payouts.ts) */
export function testDeposits(providerDestId) {
  const h = createHash('sha256').update(`deposits:${providerDestId}`).digest();
  return [1 + (h[0] % 98), 1 + (h[1] % 98)];
}

/* ---------------------------------------------------------------- identifiers */

/** EAN-13 with a valid check digit from a 12-digit body */
export function ean13(body12) {
  const body = String(body12).padStart(12, '0').slice(0, 12);
  const sum = [...body].reduce((s, d, i) => s + Number(d) * (i % 2 === 0 ? 1 : 3), 0);
  return body + String((10 - (sum % 10)) % 10);
}

/** A stable 12-digit GTIN body from a key (prefix 08 + hash digits), so reruns produce the same GTINs */
export function gtinFor(key) {
  const h = createHash('sha256').update(`gtin:${key}`).digest();
  const digits = [...h].map((b) => String(b % 10)).join('');
  return ean13(`08${digits.slice(0, 10)}`);
}

const ALNUM = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789';
/** A tracking number in the carrier's format (shipping/domain/tracking.ts), unique per call */
export function trackingNumber(carrier, seed) {
  const h = createHash('sha256').update(`trk:${carrier}:${seed}:${Date.now()}:${Math.random()}`).digest();
  const digits = (n) => [...h].map((b) => String(b % 10)).join('').padEnd(n, '7').slice(0, n);
  switch (carrier) {
    case 'ups':
      return `1Z${[...h].slice(0, 16).map((b) => ALNUM[b % ALNUM.length]).join('')}`;
    case 'usps':
      return `94${digits(20)}`;
    case 'fedex':
      return digits(12);
    default:
      return `1Z${[...h].slice(0, 16).map((b) => ALNUM[b % ALNUM.length]).join('')}`;
  }
}

/* ---------------------------------------------------------------- webhooks */

/** Headers for a provider webhook: HMAC-SHA256 over "<ts>.<raw body>" (kernel/http/webhooks.ts) */
export function signWebhook(rawBody, secret = DEV_WEBHOOK_SECRET, ts = Math.floor(Date.now() / 1000)) {
  const mac = createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex');
  return { 'x-signature': `sha256=${mac}`, 'x-timestamp': String(ts) };
}
