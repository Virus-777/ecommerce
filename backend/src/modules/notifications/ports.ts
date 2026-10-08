/**
 * What the notifications service needs from the outside world, database-agnostic.
 * The Postgres adapter lives in infra/postgres/; a MongoDB switch would add infra/mongo/.
 */

/** Persistence for this module's own tables: notifications.topics, notifications.templates, notifications.template_versions, notifications.notices, notifications.notice_recipients, notifications.scheduled_notifications, notifications.deliveries, notifications.delivery_events, notifications.member_preferences, notifications.staff_preferences, notifications.push_devices, notifications.suppressions, notifications.broadcasts. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface NotificationsRepository {}
