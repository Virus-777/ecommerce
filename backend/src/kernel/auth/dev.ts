/**
 * Development and test tokens: the same JWT format as identity's tokens, signed with the dev key.
 * Never accepted in production (config refuses DEV_TOKENS there). Every dev token carries a `dev` claim
 * (honoured only on dev-key tokens), which is what makes the dev re-auth proofs apply.
 */
import { newId } from '../lib/ids.js';
import type { AccessClaims, Audience } from './tokens.js';

export type DevKind = 'visitor' | 'customer' | 'seller' | 'staff';
export type DevClaims = Omit<AccessClaims, 'iat' | 'exp' | 'jti' | 'iss'>;

export interface DevOptions {
  /** Staff permissions (default: all), or a seller member's permissions (default: owner) */
  permissions?: string[];
  sellerId?: string;
  accountId?: string;
  /**
   * Sellers: the member id. Default none: the middleware uses the account's real member id when it is a
   * member of the seller (else the account id), so per-member rows never go under a made-up id.
   */
  memberId?: string;
  /** Visitors: which app (default store) */
  audience?: Audience;
}

export function devClaims(kind: DevKind, o: DevOptions = {}): DevClaims {
  const sid = newId();
  const now = Math.floor(Date.now() / 1000);
  switch (kind) {
    case 'visitor':
      return { aud: o.audience ?? 'store', kind, sid, dev: {} };
    case 'customer':
      return { aud: 'store', kind, sub: o.accountId ?? newId(), sid, authAt: now, dev: {} };
    case 'seller': {
      const sub = o.accountId ?? newId();
      return { aud: 'seller', kind, sub, sid, authAt: now, sellerId: o.sellerId ?? newId(), ...(o.memberId ? { memberId: o.memberId } : {}), dev: { isOwner: !o.permissions, permissions: o.permissions ?? [] } };
    }
    case 'staff':
      return { aud: 'admin', kind, sub: o.accountId ?? newId(), sid, authAt: now, dev: { permissions: o.permissions ?? ['*'] } };
  }
}
