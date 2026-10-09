#!/usr/bin/env tsx
/**
 * Development tokens (EdDSA JWTs signed with this machine's dev key), accepted while DEV_TOKENS is on
 * (never in production), so every API area can be called before identity issues real sessions.
 *
 *   npm run token -- visitor [--audience store|seller|admin]
 *   npm run token -- customer
 *   npm run token -- seller [--seller <uuid>] [--permissions a,b]   owner unless --permissions is given
 *   npm run token -- staff  [--permissions catalog.products.review,…] all permissions by default
 */
import { parseArgs } from 'node:util';
import { devClaims, type DevKind } from '../src/kernel/auth/dev.js';
import { devSigner, signAccessToken, type Audience } from '../src/kernel/auth/tokens.js';
import { loadConfig } from '../src/kernel/config/index.js';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { permissions: { type: 'string' }, seller: { type: 'string' }, account: { type: 'string' }, audience: { type: 'string' } },
});
const kind = (positionals[0] ?? 'visitor') as DevKind;
if (!['visitor', 'customer', 'seller', 'staff'].includes(kind)) {
  console.error('Usage: npm run token -- <visitor|customer|seller|staff> [--permissions a,b] [--seller <uuid>] [--account <uuid>] [--audience store|seller|admin]');
  process.exit(1);
}
const config = loadConfig();
if (!config.devTokens) {
  console.error('DEV_TOKENS is off: development tokens are only accepted in development and tests.');
  process.exit(1);
}
const signer = devSigner({ file: config.devSigning.file });
const claims = devClaims(kind, { permissions: values.permissions?.split(','), sellerId: values.seller, accountId: values.account, audience: values.audience as Audience | undefined });
// 12 hours, so a token lasts a working day of manual testing
console.log(signAccessToken(signer, claims, { issuer: config.auth.issuer, ttlSeconds: 12 * 3600 }));
