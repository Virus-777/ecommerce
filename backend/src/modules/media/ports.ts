/**
 * What the media service needs from the outside world, database-agnostic.
 * The Postgres adapter lives in infra/postgres/; a MongoDB switch would add infra/mongo/.
 */

/** Persistence for this module's own tables: media.assets, media.renditions, media.uploads, media.usages, media.processing_jobs, media.upload_counters. */
export interface MediaRepository {}
