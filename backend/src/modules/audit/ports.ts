/**
 * What the audit service needs from the outside world, database-agnostic.
 * The Postgres adapter lives in infra/postgres/; a MongoDB switch would add infra/mongo/.
 */

/** Persistence for this module's own tables: audit.entries, audit.entry_targets, audit.approval_states, audit.retention, audit.integrity_checks. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface AuditRepository {}
