/**
 * What the trust service needs from the outside world, database-agnostic.
 * The Postgres adapter lives in infra/postgres/; a MongoDB switch would add infra/mongo/.
 */

/** Persistence for this module's own tables: trust.reports, trust.report_subjects, trust.evidence, trust.evidence_requests, trust.recommendations, trust.enforcements, trust.enforcement_targets, trust.appeals, trust.report_notes, trust.report_events, trust.detection_rules, trust.risk_signals. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface TrustRepository {}
