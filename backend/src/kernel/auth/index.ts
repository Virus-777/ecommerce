/**
 * Kernel auth guard. The spec decides who answers each question:
 *   identity.authenticate(accessToken)        → Principal (Bearer token)
 *   identity.verifyGuestSession(id)           → guest session (X-Guest-Session)
 *   access.hasPermission(principal, key)      → staff permissions on admin endpoints
 *   sellers.getMemberAccess(sellerId, account) → seller member permissions on seller endpoints
 * The kernel calls them through the modules' public APIs; it holds no accounts itself.
 *
 * Area rule (identity notes): a token is issued for one audience. Store endpoints take customer or guest
 * sessions, seller endpoints seller sessions (acting for one seller), admin endpoints staff sessions.
 */
import type { FastifyRequest } from 'fastify';
import type { Actor } from '../../spec/common.js';
import { AppError } from '../errors/index.js';
import type { Area, AuthKind } from '../spec/define.js';

/** Mirrors identity.Principal (docs/api/spec/modules/identity.json). */
export interface Principal {
  kind: 'customer' | 'seller' | 'staff' | 'guest';
  accountId?: string | null;
  sessionId?: string | null;
  /** Seller the session acts for (seller audience only) */
  sellerId?: string | null;
  sellerMemberId?: string | null;
  guestSessionId?: string | null;
  authenticatedAt?: string | null;
  twoStepVerifiedAt?: string | null;
  /** Display name for audit actors, when the authenticator knows it */
  name?: string | null;
}

export interface SellerMemberAccess {
  memberId: string;
  role: string;
  permissions: string[];
  isOwner: boolean;
}

/** What the guard needs answered. The default implementation asks identity, access and sellers. */
export interface Authenticator {
  authenticate(accessToken: string): Promise<Principal | null>;
  verifyGuestSession(guestSessionId: string): Promise<{ id: string } | null>;
  hasPermission(principal: Principal, permissionKey: string): Promise<boolean>;
  getMemberAccess(sellerId: string, accountId: string): Promise<SellerMemberAccess | null>;
}

export interface AuthResult {
  principal: Principal | null;
  /** Seller-area requests: the member's access for the seller in the token */
  sellerAccess?: SellerMemberAccess;
}

const bearer = (req: FastifyRequest) => {
  const h = req.headers.authorization;
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1]!.trim() : '';
};

const unauthorized = (message: string) => new AppError('UNAUTHORIZED', message);
const forbidden = (permission: string | undefined, message = 'Your role does not allow this action') =>
  new AppError('FORBIDDEN', message, permission ? { permission } : undefined);

/** Resolve and check the caller for one endpoint. Throws UNAUTHORIZED / FORBIDDEN. */
export async function authorize(
  req: FastifyRequest,
  endpoint: { area: Area; auth: AuthKind; permission?: string },
  auth: Authenticator,
): Promise<AuthResult> {
  const token = bearer(req);
  const guestHeader = req.headers['x-guest-session'];
  const guestId = typeof guestHeader === 'string' && guestHeader ? guestHeader : null;

  if (endpoint.auth === 'provider') return { principal: null }; // webhook signatures are checked by the module's verifier

  let principal: Principal | null = null;
  if (token !== null) {
    principal = token ? await auth.authenticate(token) : null;
    if (!principal && endpoint.auth !== 'anyone') throw unauthorized('The session is missing, expired or revoked');
  }
  if (endpoint.auth === 'anyone') {
    // Optional session: endpoints such as the product page personalise when signed in
    if (principal && !audienceFits(endpoint.area, principal)) principal = null;
    if (!principal && guestId && endpoint.area === 'store') {
      const g = await auth.verifyGuestSession(guestId);
      if (g) principal = { kind: 'guest', guestSessionId: g.id };
    }
    return { principal };
  }

  if (principal && !audienceFits(endpoint.area, principal)) {
    throw unauthorized(`This session is for the ${audienceOf(principal)} area, not ${endpoint.area}`);
  }

  switch (endpoint.auth) {
    case 'shopper': {
      if (principal?.kind === 'customer') {
        if (guestId) principal = { ...principal, guestSessionId: guestId };
        return { principal };
      }
      if (!guestId) throw unauthorized('Sign in or send a guest session (X-Guest-Session)');
      const g = await auth.verifyGuestSession(guestId);
      if (!g) throw unauthorized('The guest session is unknown or expired');
      return { principal: { kind: 'guest', guestSessionId: g.id } };
    }
    case 'customer':
      if (principal?.kind !== 'customer') throw unauthorized('Sign in to continue');
      return { principal };
    case 'seller': {
      if (principal?.kind !== 'seller') throw unauthorized('Sign in to Seller Center');
      if (!principal.sellerId || !principal.accountId) throw new AppError('UNAUTHORIZED', 'Choose the seller account to act for', { reason: 'seller_context_required' });
      const access = await auth.getMemberAccess(principal.sellerId, principal.accountId);
      if (!access) throw forbidden(undefined, 'You are no longer a member of this seller account');
      if (endpoint.permission && !access.isOwner && !access.permissions.includes(endpoint.permission)) throw forbidden(endpoint.permission);
      return { principal: { ...principal, sellerMemberId: access.memberId }, sellerAccess: access };
    }
    case 'staff':
      if (principal?.kind !== 'staff') throw unauthorized('Staff sign-in required');
      if (endpoint.permission && !(await auth.hasPermission(principal, endpoint.permission))) throw forbidden(endpoint.permission);
      return { principal };
  }
  throw unauthorized('Unsupported auth');
}

const audienceOf = (p: Principal) => (p.kind === 'staff' ? 'admin' : p.kind === 'seller' ? 'seller' : 'store');

function audienceFits(area: Area, p: Principal) {
  if (area === 'public') return true;
  return audienceOf(p) === area;
}

/** The Actor recorded in audit entries, timelines and events. */
export function actorOf(p: Principal | null): Actor {
  if (!p) return { kind: 'system' };
  if (p.kind === 'guest') return { kind: 'guest', id: p.guestSessionId ?? null };
  return { kind: p.kind, id: p.accountId ?? null, ...(p.name ? { name: p.name } : {}) };
}
