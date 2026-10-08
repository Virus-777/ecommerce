import type { Kysely } from 'kysely';
import type { IdentityDb } from '../../../../spec/identity.js';
import type { IdentityRepository } from '../../ports.js';

/** Postgres adapter for IdentityRepository. `db` is scoped to the `identity` schema. */
export function createPostgresIdentityRepository(db: Kysely<IdentityDb>): IdentityRepository {
  return {};
}
