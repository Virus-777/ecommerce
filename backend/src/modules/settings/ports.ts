/**
 * What the settings service needs from the outside world, database-agnostic.
 * The Postgres adapter lives in infra/postgres/; a MongoDB switch would add infra/mongo/.
 */

/** Persistence for this module's own tables: settings.definitions, settings.values, settings.changes, settings.change_keys, settings.feature_flags. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface SettingsRepository {}
