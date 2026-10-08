import type { Kysely } from 'kysely';
import type { TrustDb } from '../../../../spec/trust.js';
import type { TrustRepository } from '../../ports.js';

/** Postgres adapter for TrustRepository. `db` is scoped to the `trust` schema. */
export function createPostgresTrustRepository(db: Kysely<TrustDb>): TrustRepository {
  return {};
}
