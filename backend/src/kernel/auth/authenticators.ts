import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Authenticator, Principal, SellerMemberAccess } from './index.js';

type Lookup = (module: 'identity' | 'access' | 'sellers') => any;

/**
 * The production authenticator: asks identity, access and sellers through their public APIs.
 * A disabled identity module means nobody can sign in; a disabled access module means no
 * permissioned admin endpoint is allowed (deny by default).
 */
export function moduleAuthenticator(lookup: Lookup): Authenticator {
  return {
    async authenticate(token) {
      const identity = lookup('identity');
      return identity ? ((await identity.authenticate(token)) as Principal | null) : null;
    },
    async verifyGuestSession(id) {
      const identity = lookup('identity');
      const g = identity ? ((await identity.verifyGuestSession(id)) as { id: string } | null) : null;
      return g ? { id: g.id } : null;
    },
    async hasPermission(principal, key) {
      const access = lookup('access');
      return access ? Boolean(await access.hasPermission(principal, key)) : false;
    },
    async getMemberAccess(sellerId, accountId) {
      const sellers = lookup('sellers');
      return sellers ? ((await sellers.getMemberAccess(sellerId, accountId)) as SellerMemberAccess | null) : null;
    },
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
      return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? { id } : null;
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
