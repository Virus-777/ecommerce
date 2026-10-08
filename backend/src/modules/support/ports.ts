/**
 * What the support service needs from the outside world, database-agnostic.
 * The Postgres adapter lives in infra/postgres/; a MongoDB switch would add infra/mongo/.
 */

/** Persistence for this module's own tables: support.case_categories, support.cases, support.case_items, support.case_messages, support.case_evidence, support.case_offers, support.case_remedies, support.case_appeals, support.case_events. */
export interface SupportRepository {}
