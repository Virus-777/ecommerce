import type { Kysely } from 'kysely';
import type { AccessDb } from '../../../../spec/access.js';
import type { AccessRepository } from '../../ports.js';

/** Postgres adapter for AccessRepository. `db` is scoped to the `access` schema. */
export function createPostgresAccessRepository(db: Kysely<AccessDb>): AccessRepository {
  void db;
  return {};
}
