#!/usr/bin/env tsx
/**
 * Development tokens, accepted while DEV_TOKENS is on (never in production), so every API area
 * can be called before identity issues real sessions.
 *
 *   npm run token -- customer
 *   npm run token -- seller [--seller <uuid>] [--permissions a,b]   owner unless --permissions is given
 *   npm run token -- staff  [--permissions catalog.products.review,…] all permissions by default
 */
import { parseArgs } from 'node:util';
import { devClaims, issueDevToken } from '../src/kernel/auth/authenticators.js';
import { loadConfig } from '../src/kernel/config/index.js';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { permissions: { type: 'string' }, seller: { type: 'string' }, account: { type: 'string' } },
});
const kind = positionals[0] ?? 'customer';
if (kind !== 'customer' && kind !== 'seller' && kind !== 'staff') {
  console.error('Usage: npm run token -- <customer|seller|staff> [--permissions a,b] [--seller <uuid>] [--account <uuid>]');
  process.exit(1);
}
const claims = devClaims(kind, {
  permissions: values.permissions?.split(','),
  sellerId: values.seller,
  accountId: values.account,
  expiresInSeconds: 12 * 3600,
});
console.log(issueDevToken(loadConfig().devTokenSecret, claims));
