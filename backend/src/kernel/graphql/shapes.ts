/**
 * REST shapes → GraphQL shapes that every module resolver needs the same way.
 */
import type { Actor } from '../../spec/common.js';

/**
 * Actor.kind (common.json) → GraphQL ActorKind. The schema has five kinds: a visitor (guest session) and an
 * anonymous caller (no session yet, e.g. the app's first call) are both GUEST; a provider callback
 * (payment provider, carrier) and the platform's own jobs are both SYSTEM.
 */
export const ACTOR_KIND: Readonly<Record<Actor['kind'], 'CUSTOMER' | 'GUEST' | 'SELLER' | 'STAFF' | 'SYSTEM'>> = Object.freeze({
  customer: 'CUSTOMER',
  visitor: 'GUEST',
  anonymous: 'GUEST',
  seller: 'SELLER',
  staff: 'STAFF',
  provider: 'SYSTEM',
  system: 'SYSTEM',
});

/** GraphQL ActorKind of a REST actor kind (unknown kinds are SYSTEM) */
export const actorKind = (kind: string | null | undefined) => ACTOR_KIND[kind as Actor['kind']] ?? 'SYSTEM';

/** GraphQL Actor { kind, id, name } of a REST actor, null for none */
export const gqlActor = (a: { kind: string; id?: string | null; name?: string | null } | null | undefined) => (a ? { kind: actorKind(a.kind), id: a.id ?? null, name: a.name ?? null } : null);
