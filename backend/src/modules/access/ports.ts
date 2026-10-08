/**
 * What the access service needs from the outside world, database-agnostic.
 * The Postgres adapter lives in infra/postgres/; a MongoDB switch would add infra/mongo/.
 */

/** Persistence for this module's own tables: access.roles, access.permissions, access.role_permissions, access.role_assignments, access.role_coverage, access.approval_actions, access.approval_limits, access.limit_changes, access.approval_requests, access.approval_decisions, access.away_periods, access.away_coverage. */
export interface AccessRepository {}
