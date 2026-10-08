import type { Kysely } from 'kysely';
import type { AuditDb } from '../../../../spec/audit.js';
import type { AuditRepository } from '../../ports.js';

/** Postgres adapter for AuditRepository. `db` is scoped to the `audit` schema. */
export function createPostgresAuditRepository(db: Kysely<AuditDb>): AuditRepository {
  return {};
}
