import type { Kysely } from 'kysely';
import type { ReportsDb } from '../../../../spec/reports.js';
import type { ReportsRepository } from '../../ports.js';

/** Postgres adapter for ReportsRepository. `db` is scoped to the `reports` schema. */
export function createPostgresReportsRepository(db: Kysely<ReportsDb>): ReportsRepository {
  void db;
  return {};
}
