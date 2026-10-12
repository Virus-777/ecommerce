/**
 * Record scope (docs/03-auth-middleware.md §7): which records a caller reaches. Every handler receives
 * `input.scope`; services and repositories filter tenant records by it (the owning seller, customer or
 * visitor session), so another seller's or customer's record is simply not found.
 */
import type { EndpointScope } from '../spec/define.js';
import type { Principal, RequestAuth } from './index.js';

export type Scope =
  | { kind: 'public' }
  | { kind: 'staff' }
  | { kind: 'seller'; sellerId: string; memberId: string | null }
  | { kind: 'customer'; accountId: string; customerId: string | null }
  | { kind: 'visitor'; visitorSessionId: string };

export function scopeFor(endpointScope: EndpointScope, auth: RequestAuth | undefined, customerId: string | null): Scope {
  const p: Principal | null | undefined = auth?.principal;
  switch (endpointScope) {
    case 'staff':
      return { kind: 'staff' };
    case 'own-seller':
    case 'own-member':
      return p?.sellerId ? { kind: 'seller', sellerId: p.sellerId, memberId: p.sellerMemberId ?? null } : { kind: 'public' };
    case 'own-customer':
    case 'guest-order':
      if (p?.kind === 'customer' && p.accountId) return { kind: 'customer', accountId: p.accountId, customerId };
      if (p?.kind === 'visitor') return { kind: 'visitor', visitorSessionId: p.sessionId };
      if (p?.accountId) return { kind: 'customer', accountId: p.accountId, customerId }; // `account` endpoints
      return { kind: 'public' };
    default:
      return { kind: 'public' };
  }
}
