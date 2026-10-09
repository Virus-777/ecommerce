/**
 * Kernel authorization (docs/03-auth-middleware.md). Every request carries a token, verified by
 * middleware before any module code runs (chain.ts). The answers come from the modules that own them,
 * through their public APIs (authorities.ts): identity (tokens, step-up), access (staff permissions),
 * sellers (member access) and customers (customer id of an account).
 */
import type { Actor } from '../../spec/common.js';
import { AppError } from '../errors/index.js';
import type { Area, AuthKind } from '../spec/define.js';
import type { AccessClaims, Audience, TokenFailure } from './tokens.js';

/** The verified caller (mirrors identity.Principal). */
export interface Principal {
  kind: 'visitor' | 'customer' | 'seller' | 'staff';
  audience: Audience;
  /** absent for visitors */
  accountId?: string | null;
  sessionId: string;
  /** Seller the session acts for (seller audience only) */
  sellerId?: string | null;
  sellerMemberId?: string | null;
  /** Store visitors: the visitor session, which is also the guest session */
  guestSessionId?: string | null;
  authenticatedAt?: string | null;
  twoStepVerifiedAt?: string | null;
  name?: string | null;
}

export interface SellerMemberAccess {
  memberId: string;
  role: string;
  permissions: string[];
  isOwner: boolean;
}

/** What the middleware established about a request. */
export interface RequestAuth {
  via: 'token' | 'refresh' | 'provider' | 'bootstrap';
  principal: Principal | null;
  claims?: AccessClaims;
  sellerAccess?: SellerMemberAccess;
  /** refresh endpoints: the session the refresh token belongs to */
  refreshSession?: { sessionId: string; accountId?: string | null; audience: string; kind: string };
  /** webhooks: verified provider and event */
  provider?: { name: string; eventId?: string };
}

export const principalOf = (c: AccessClaims): Principal => ({
  kind: c.kind,
  audience: c.aud,
  accountId: c.sub ?? null,
  sessionId: c.sid,
  sellerId: c.sellerId ?? null,
  sellerMemberId: c.memberId ?? null,
  guestSessionId: c.kind === 'visitor' && c.aud === 'store' ? c.sid : null,
  authenticatedAt: c.authAt ? new Date(c.authAt * 1000).toISOString() : null,
  twoStepVerifiedAt: c.twoStepAt ? new Date(c.twoStepAt * 1000).toISOString() : null,
  name: c.dev?.name ?? null,
});

/* ------------------------------------------------------------------ errors */

/** 401: only token problems carry WWW-Authenticate, so clients refresh only when a refresh can help. */
export const tokenRejected = (reason: TokenFailure | 'invalid') =>
  new AppError('UNAUTHORIZED', reason === 'missing' ? 'This request needs a token' : 'The token is invalid, expired or revoked', { reason: `token_${reason}` });

export const signInRequired = (message = 'Sign in to continue') => new AppError('UNAUTHORIZED', message, { reason: 'sign_in_required' });
export const wrongAudience = (p: Principal, area: Area) => new AppError('WRONG_AUDIENCE', `This token is for the ${p.audience} app, not ${area}`, { tokenAudience: p.audience, area });
export const forbidden = (permission?: string, message = 'Your role does not allow this action') => new AppError('FORBIDDEN', message, permission ? { permission } : undefined);

/* ------------------------------------------------------------------ pure guards (shared by REST and GraphQL) */

const AREA_AUDIENCE: Partial<Record<Area, Audience>> = { store: 'store', seller: 'seller', admin: 'admin' };

/** Audience: the token must be for this API area (public endpoints take any app's token; `account` any signed-in token). */
export function checkAudience(area: Area, auth: AuthKind, p: Principal) {
  if (auth === 'account') {
    if (p.kind === 'visitor') throw signInRequired();
    return;
  }
  const expected = AREA_AUDIENCE[area];
  if (expected && p.audience !== expected) throw wrongAudience(p, area);
}

/** Caller kind: the endpoint's auth kind (spec `auth`). */
export function checkCallerKind(auth: AuthKind, p: Principal) {
  switch (auth) {
    case 'visitor':
    case 'account':
      return;
    case 'shopper':
      if (p.kind !== 'visitor' && p.kind !== 'customer') throw signInRequired();
      return;
    case 'customer':
      if (p.kind !== 'customer') throw signInRequired();
      return;
    case 'seller':
      if (p.kind !== 'seller') throw signInRequired('Sign in to Seller Center');
      return;
    case 'staff':
      if (p.kind !== 'staff') throw signInRequired('Staff sign-in required');
      return;
    default:
      throw signInRequired();
  }
}

/** Seller owners may do everything in their account; other members need the permission. */
export const sellerMayDo = (access: SellerMemberAccess, permission: string | undefined) =>
  !permission || access.isOwner || access.permissions.includes(permission);

/* ------------------------------------------------------------------ actors */

/** The Actor recorded in audit entries, timelines and events. `system` is reserved for jobs and event consumers. */
export function actorOf(auth: RequestAuth | undefined): Actor {
  const p = auth?.principal;
  if (p) {
    if (p.kind === 'visitor') return { kind: 'visitor', id: p.sessionId };
    return { kind: p.kind, id: p.accountId ?? null, ...(p.name ? { name: p.name } : {}) };
  }
  if (auth?.via === 'provider') return { kind: 'provider', name: auth.provider?.name ?? null };
  return { kind: 'anonymous' };
}

/** Only the job scheduler and the event bus act as `system`. */
export const SYSTEM_ACTOR: Actor = Object.freeze({ kind: 'system' });
