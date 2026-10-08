import type { Kysely } from 'kysely';
import type { ContentDb } from '../../../../spec/content.js';
import type { ContentRepository } from '../../ports.js';

/** Postgres adapter for ContentRepository. `db` is scoped to the `content` schema. */
export function createPostgresContentRepository(db: Kysely<ContentDb>): ContentRepository {
  void db;
  return {};
}
