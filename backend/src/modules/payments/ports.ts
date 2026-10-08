/**
 * What the payments service needs from the outside world, database-agnostic.
 * The Postgres adapter lives in infra/postgres/; a MongoDB switch would add infra/mongo/.
 */

/** Persistence for this module's own tables: payments.intents, payments.allocations, payments.captures, payments.provider_calls, payments.refunds, payments.refund_items, payments.refund_log, payments.disputes, payments.saved_methods, payments.webhook_events, payments.ref_sequences. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface PaymentsRepository {}
