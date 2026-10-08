import type { Kysely } from 'kysely';
import type { SupportDb } from '../../../../spec/support.js';
import type { SupportRepository } from '../../ports.js';

/** Postgres adapter for SupportRepository. `db` is scoped to the `support` schema. */
export function createPostgresSupportRepository(db: Kysely<SupportDb>): SupportRepository {
  return {};
}
