import type { Kysely } from 'kysely';
import type { FinanceDb } from '../../../../spec/finance.js';
import type { FinanceRepository } from '../../ports.js';

/** Postgres adapter for FinanceRepository. `db` is scoped to the `finance` schema. */
export function createPostgresFinanceRepository(db: Kysely<FinanceDb>): FinanceRepository {
  void db;
  return {};
}
