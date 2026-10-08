/**
 * What the workqueues service needs from the outside world, database-agnostic.
 * The Postgres adapter lives in infra/postgres/; a MongoDB switch would add infra/mongo/.
 */

/** Persistence for this module's own tables: workqueues.queues, workqueues.intake_rules, workqueues.items, workqueues.item_events, workqueues.item_notes, workqueues.saved_filters, workqueues.day_end_reviews, workqueues.routine_templates, workqueues.routine_checks, workqueues.daily_counts. */
export interface WorkqueuesRepository {}
