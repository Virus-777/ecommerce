import type { Kysely } from 'kysely';
import type { NotificationsDb } from '../../../../spec/notifications.js';
import type { NotificationsRepository } from '../../ports.js';

/** Postgres adapter for NotificationsRepository. `db` is scoped to the `notifications` schema. */
export function createPostgresNotificationsRepository(db: Kysely<NotificationsDb>): NotificationsRepository {
  return {};
}
