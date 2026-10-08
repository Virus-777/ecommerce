import type { Kysely } from 'kysely';
import type { MessagingDb } from '../../../../spec/messaging.js';
import type { MessagingRepository } from '../../ports.js';

/** Postgres adapter for MessagingRepository. `db` is scoped to the `messaging` schema. */
export function createPostgresMessagingRepository(db: Kysely<MessagingDb>): MessagingRepository {
  void db;
  return {};
}
