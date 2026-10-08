import type { Kysely } from 'kysely';
import type { ReturnsDb } from '../../../../spec/returns.js';
import type { ReturnsRepository } from '../../ports.js';

/** Postgres adapter for ReturnsRepository. `db` is scoped to the `returns` schema. */
export function createPostgresReturnsRepository(db: Kysely<ReturnsDb>): ReturnsRepository {
  return {};
}
