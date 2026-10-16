// Values the seed computes: identifiers, tracking numbers and webhook signatures. The seller invitation
// code and payout test deposits come from the dev routes (lib/outbox.mjs); their computed versions below are the
// fallback for a backend without those routes (404).
import { createHash, createHmac, hkdfSync } from 'node:crypto';

/** The dev APP_SECRET used while DEV_TOKENS is on (backend/src/kernel/config/index.ts) */
export const DEV_APP_SECRET = 'dev-app-secret-not-for-production-use-0000';
export const DEV_WEBHOOK_SECRET = 'dev-webhook-secret';

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
