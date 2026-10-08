import type { Kysely } from 'kysely';
import type { SettingsDb } from '../../../../spec/settings.js';
import type { SettingsRepository } from '../../ports.js';

/** Postgres adapter for SettingsRepository. `db` is scoped to the `settings` schema. */
export function createPostgresSettingsRepository(db: Kysely<SettingsDb>): SettingsRepository {
  void db;
  return {};
}
