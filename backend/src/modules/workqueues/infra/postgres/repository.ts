import type { Kysely } from 'kysely';
import type { WorkqueuesDb } from '../../../../spec/workqueues.js';
import type { WorkqueuesRepository } from '../../ports.js';

/** Postgres adapter for WorkqueuesRepository. `db` is scoped to the `workqueues` schema. */
export function createPostgresWorkqueuesRepository(db: Kysely<WorkqueuesDb>): WorkqueuesRepository {
  void db;
  return {};
}
