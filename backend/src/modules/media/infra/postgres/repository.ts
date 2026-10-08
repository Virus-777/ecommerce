import type { Kysely } from 'kysely';
import type { MediaDb } from '../../../../spec/media.js';
import type { MediaRepository } from '../../ports.js';

/** Postgres adapter for MediaRepository. `db` is scoped to the `media` schema. */
export function createPostgresMediaRepository(db: Kysely<MediaDb>): MediaRepository {
  return {};
}
