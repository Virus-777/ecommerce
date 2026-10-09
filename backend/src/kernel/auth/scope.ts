/**
 * Record scope (docs/03-auth-middleware.md §7): which rows a caller reaches. Every handler receives
 * `input.scope`; repositories read tenant tables through `scoped(db, scope, spec.tenantTables)`, which
 * adds the owner condition, so another seller's or customer's record is simply not found.
 */
import type { Kysely } from 'kysely';
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

type Tenants = Readonly<Record<string, Readonly<{ seller?: string; customer?: string; visitor?: string }>>>;

/** The owner column and value this scope imposes on a table, if any. */
export function ownerCondition(scope: Scope, tenants: Tenants, table: string): { column: string; value: string | null } | undefined {
  const t = tenants[table];
  if (!t) return undefined;
  if (scope.kind === 'seller' && t.seller) return { column: t.seller, value: scope.sellerId };
  if (scope.kind === 'customer' && t.customer) return { column: t.customer, value: scope.customerId };
  if (scope.kind === 'visitor' && t.visitor) return { column: t.visitor, value: scope.visitorSessionId };
  return undefined;
}

/**
 * Kysely builders that only see the caller's rows on tenant tables. Staff and public scopes read
 * everything (public endpoints only expose public data). An owner whose id isn't known reads nothing.
 */
export function scoped<DB>(db: Kysely<DB>, scope: Scope, tenants: Tenants) {
  const cond = (table: string) => ownerCondition(scope, tenants, table);
  const apply = <Q extends { where: (...a: any[]) => any }>(q: Q, table: string): Q => {
    const c = cond(table);
    return c ? (q.where(c.column as never, c.value === null ? 'is' : '=', c.value as never) as Q) : q;
  };
  return {
    scope,
    selectFrom<T extends keyof DB & string>(table: T) {
      return apply(db.selectFrom(table), table);
    },
    updateTable<T extends keyof DB & string>(table: T) {
      return apply(db.updateTable(table), table);
    },
    deleteFrom<T extends keyof DB & string>(table: T) {
      return apply(db.deleteFrom(table), table);
    },
    /** Inserts are not filtered; the owner column must match the scope */
    ownerValues(table: string): Record<string, string> {
      const c = cond(table);
      return c && c.value !== null ? { [c.column]: c.value } : {};
    },
  };
}
