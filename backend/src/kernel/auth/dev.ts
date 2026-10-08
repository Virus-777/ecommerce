/**
 * Development and test tokens: the same JWT format as identity's tokens, signed with the dev key.
 * Never accepted in production (config refuses DEV_TOKENS there).
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
  /** Visitors: which app (default store) */
  audience?: Audience;
}

export function devClaims(kind: DevKind, o: DevOptions = {}): DevClaims {
  const sid = newId();
  const now = Math.floor(Date.now() / 1000);
  switch (kind) {
    case 'visitor':
      return { aud: o.audience ?? 'store', kind, sid };
    case 'customer':
      return { aud: 'store', kind, sub: o.accountId ?? newId(), sid, authAt: now };
    case 'seller': {
      const sub = o.accountId ?? newId();
      return { aud: 'seller', kind, sub, sid, authAt: now, sellerId: o.sellerId ?? newId(), memberId: sub, dev: { isOwner: !o.permissions, permissions: o.permissions ?? [] } };
    }
    case 'staff':
      return { aud: 'admin', kind, sub: o.accountId ?? newId(), sid, authAt: now, twoStepAt: now, dev: { permissions: o.permissions ?? ['*'] } };
  }
}
