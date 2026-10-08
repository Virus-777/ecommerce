import type { Kysely } from 'kysely';
import type { SearchDb } from '../../../../spec/search.js';
import type { SearchRepository } from '../../ports.js';

/** Postgres adapter for SearchRepository. `db` is scoped to the `search` schema. */
export function createPostgresSearchRepository(db: Kysely<SearchDb>): SearchRepository {
  return {};
}
