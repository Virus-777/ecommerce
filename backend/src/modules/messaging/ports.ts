/**
 * What the messaging service needs from the outside world, database-agnostic.
 * The Postgres adapter lives in infra/postgres/; a MongoDB switch would add infra/mongo/.
 */

/** Persistence for this module's own tables: messaging.conversations, messaging.participants, messaging.messages, messaging.message_reports, messaging.reply_templates, messaging.staff_access_log. */
export interface MessagingRepository {}
