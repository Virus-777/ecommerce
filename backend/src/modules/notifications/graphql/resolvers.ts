import type { ModuleResolvers } from '../../../kernel/graphql/index.js';
import type { NotificationsService } from '../service.js';

/**
 * Resolvers for the GraphQL fields this module owns (`@source(module: "notifications", …)` in graphql/schema.ts).
 * A field without a resolver answers NOT_IMPLEMENTED; fields of this module's own types without
 * @source resolve from the parent object.
 *
 * Fields to resolve:
 *   Query.notifications → service.listInbox
 *   Query.unreadNotificationCount → service.unreadCount
 *   Query.notificationInbox → service.inboxSummary
 */
export const resolvers = (service: NotificationsService): ModuleResolvers => ({});
