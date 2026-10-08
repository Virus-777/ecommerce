import { createHmac, timingSafeEqual } from 'node:crypto';
import { isUuid, newId } from '../lib/ids.js';
import type { PublicApiMap } from '../module-system/public-apis.js';
import type { Authenticator, Principal, SellerMemberAccess } from './index.js';

/** A module's public API if the module is enabled. */
type Lookup = <M extends 'identity' | 'access' | 'sellers'>(module: M) => PublicApiMap[M] | undefined;

/**
 * The production authenticator: asks identity, access and sellers through their public APIs.
 * A disabled identity module means nobody can sign in; a disabled access module means no
 * permissioned admin endpoint is allowed (deny by default).
 */
export function moduleAuthenticator(lookup: Lookup): Authenticator {
  return {
    authenticate: async (token) => (await lookup('identity')?.authenticate(token)) ?? null,
    async verifyGuestSession(id) {
      const g = await lookup('identity')?.verifyGuestSession(id);
      return g ? { id: g.id } : null;
    },
    hasPermission: async (principal, key) => (await lookup('access')?.hasPermission(principal, key)) ?? false,
    getMemberAccess: async (sellerId, accountId) => (await lookup('sellers')?.getMemberAccess(sellerId, accountId)) ?? null,
  };
}

/* ------------------------------------------------------------------ development tokens */

export interface DevTokenClaims extends Principal {
  /** Staff permissions, or the seller member's permissions */
  permissions?: string[];
  /** Seller owner: every seller permission */
  isOwner?: boolean;
  /** Seconds since epoch */
  exp?: number;
}

const sign = (secret: string, body: string) => createHmac('sha256', secret).update(body).digest('base64url');

/**
 * Claims for a development caller: staff get every permission and sellers are owners unless
 * permissions are given.
 */
export function devClaims(kind: 'customer' | 'seller' | 'staff', o: { permissions?: string[]; sellerId?: string; accountId?: string; expiresInSeconds?: number } = {}): DevTokenClaims {
  const base = { accountId: o.accountId ?? newId(), sessionId: newId(), ...(o.expiresInSeconds ? { exp: Math.floor(Date.now() / 1000) + o.expiresInSeconds } : {}) };
  if (kind === 'staff') return { kind, ...base, permissions: o.permissions ?? ['*'] };
  if (kind === 'seller') return { kind, ...base, sellerId: o.sellerId ?? newId(), isOwner: !o.permissions, permissions: o.permissions ?? [] };
  return { kind, ...base };
}

/** `dev.<claims>.<signature>`: lets developers and tests call any area before identity is built. */
export function issueDevToken(secret: string, claims: DevTokenClaims): string {
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `dev.${body}.${sign(secret, body)}`;
}

function readDevToken(secret: string, token: string): DevTokenClaims | null {
  const [prefix, body, sig] = token.split('.');
  if (prefix !== 'dev' || !body || !sig) return null;
  const expected = Buffer.from(sign(secret, body));
  const got = Buffer.from(sig);
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return null;
  const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as DevTokenClaims;
  if (claims.exp && claims.exp * 1000 < Date.now()) return null;
  return claims;
}

/**
 * Accepts development tokens (never enabled in production) and hands every other token to `next`.
 * Guest session ids are accepted as they are when identity can't verify them yet.
 */
export function devAuthenticator(secret: string, next: Authenticator): Authenticator {
  const claimsOf = new WeakMap<Principal, DevTokenClaims>();
  // seller-member access carried by dev seller tokens, keyed by seller and account (bounded)
  const sellerAccess = new Map<string, SellerMemberAccess>();
  return {
    async authenticate(token) {
      if (!token.startsWith('dev.')) return next.authenticate(token);
      const claims = readDevToken(secret, token);
      if (!claims) return null;
      const { permissions: _p, isOwner: _o, exp: _e, ...principal } = claims;
      claimsOf.set(principal, claims);
      if (claims.kind === 'seller' && claims.sellerId && claims.accountId) {
        if (sellerAccess.size > 1000) sellerAccess.clear();
        sellerAccess.set(`${claims.sellerId}:${claims.accountId}`, {
          memberId: claims.sellerMemberId ?? claims.accountId,
          role: claims.isOwner ? 'owner' : 'member',
          permissions: claims.permissions ?? [],
          isOwner: Boolean(claims.isOwner),
        });
      }
      return principal;
    },
    async verifyGuestSession(id) {
      try {
        const g = await next.verifyGuestSession(id);
        if (g) return g;
      } catch {
        /* identity not built yet */
      }
      return isUuid(id) ? { id } : null;
    },
    async hasPermission(principal, key) {
      const c = claimsOf.get(principal);
      if (c) return Boolean(c.permissions?.includes(key) || c.permissions?.includes('*'));
      return next.hasPermission(principal, key);
    },
    async getMemberAccess(sellerId, accountId) {
      return sellerAccess.get(`${sellerId}:${accountId}`) ?? next.getMemberAccess(sellerId, accountId);
    },
  };
}
