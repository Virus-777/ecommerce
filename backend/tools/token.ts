#!/usr/bin/env tsx
/**
 * Development tokens, accepted while DEV_TOKENS is on (never in production), so every API area
 * can be called before identity issues real sessions.
 *
 *   npm run token -- customer
 *   npm run token -- seller [--seller <uuid>] [--permissions a,b]   owner unless --permissions is given
 *   npm run token -- staff  [--permissions catalog.products.review,…] all permissions by default
 */
import { issueDevToken, type DevTokenClaims } from '../src/kernel/auth/authenticators.js';
import { loadConfig } from '../src/kernel/config/index.js';
import { newId } from '../src/kernel/lib/ids.js';

const [kind = 'customer', ...rest] = process.argv.slice(2);
const opt = (k: string) => (rest.includes(`--${k}`) ? rest[rest.indexOf(`--${k}`) + 1] : undefined);
const permissions = opt('permissions')?.split(',');
const { devTokenSecret } = loadConfig();
const base = { accountId: opt('account') ?? newId(), sessionId: newId(), exp: Math.floor(Date.now() / 1000) + 12 * 3600 };

let claims: DevTokenClaims;
if (kind === 'staff') claims = { kind: 'staff', ...base, permissions: permissions ?? ['*'] };
else if (kind === 'seller') claims = { kind: 'seller', ...base, sellerId: opt('seller') ?? newId(), isOwner: !permissions, permissions: permissions ?? [] };
else claims = { kind: 'customer', ...base };

console.log(issueDevToken(devTokenSecret, claims));
