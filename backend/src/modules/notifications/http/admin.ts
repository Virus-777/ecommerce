import { routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/notifications.js';
import type { NotificationsService } from '../service.js';
import { accountOf } from './store.js';

/**
 * Admin API: /api/admin/notifications/…  (docs/api/modules/notifications.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const adminRoutes = (service: NotificationsService) =>
  routes(endpoints, 'admin', {
    /** GET /inbox: My staff notices (routed by role, including roles I cover as backup) */
    listStaffInbox: async ({ principal, query, page }) => service.listInboxFor({ principal }, { group: query.area, unreadOnly: query.unreadOnly, view: query.view, archived: query.archived }, page),
    /** GET /inbox/summary: Counts and today's routing for my roles */
    getStaffInboxSummary: async ({ principal }) => service.inbox.staffSummary({ principal }),
    /** POST /inbox/{id}/read: Mark one notice as read (for me) */
    markStaffRead: async ({ principal, params }) => service.inbox.markRead({ principal }, params.id),
    /** POST /inbox/read-all: Mark all as read (for me) */
    markAllStaffRead: async ({ principal, body }) => service.inbox.markAll({ principal }, body.area),
    /** POST /inbox/{id}/unread: Mark one notice as unread (for me) */
    markStaffUnread: async ({ principal, params }) => service.inbox.markUnread({ principal }, params.id),
    /** POST /inbox/{id}/archive: Archive one notice (for me) */
    archiveStaffNotice: async ({ principal, params }) => service.inbox.archive({ principal }, params.id),
    /** POST /inbox/archive-all: Archive all (or one area) for me */
    archiveAllStaffNotices: async ({ principal, body }) => service.inbox.archiveAll({ principal }, { group: body.area, readOnly: body.readOnly }),
    /** GET /my-preferences: My email preferences for staff notices */
    getMyStaffPreferences: async ({ principal }) => service.prefs.staffPreferences(accountOf(principal)),
    /** PUT /my-preferences: Change my email preferences */
    updateMyStaffPreferences: async ({ principal, body }) => service.prefs.updateStaffPreferences(accountOf(principal), body),
    /** GET /topics: Audience × event × channel matrix with delivery stats */
    getTopicMatrix: async () => service.admin.topicMatrix(),
    /** PUT /topics/{key}/channels: Turn channels on or off for a topic */
    updateTopicChannels: async ({ params, body, actor, requestId }) => service.admin.updateTopicChannels(params.key, body, { actor, requestId }),
    /** GET /templates: Templates */
    listTemplates: async ({ query, page }) => service.admin.listTemplates(query, page),
    /** GET /templates/{id}: Template editor: topic, variables, live and draft versions, history */
    getTemplate: async ({ params }) => service.admin.getTemplate(params.id),
    /** POST /templates/{id}/versions: Start a draft (from the live version, or restore an older one) */
    createDraftVersion: async ({ params, body, actor, requestId }) => service.admin.createDraft(params.id, body ?? {}, { actor, requestId }),
    /** PATCH /templates/{id}/versions/{versionId}: Edit a draft (returns validation) */
    updateDraftVersion: async ({ params, body }) => service.admin.updateDraft(params.id, params.versionId, body),
    /** POST /templates/{id}/versions/{versionId}/preview: Render with sample or real data on desktop or phone */
    previewVersion: async ({ params, body }) => service.admin.preview(params.id, params.versionId, body ?? {}),
    /** POST /templates/{id}/versions/{versionId}/test-send: Send a test to my own email (or an allowed staff address) */
    testSendVersion: async ({ params, body, principal, actor, requestId }) => service.admin.testSend(params.id, params.versionId, body ?? {}, principal, { actor, requestId }),
    /** POST /templates/{id}/versions/{versionId}/publish: Publish a draft as the live version */
    publishVersion: async ({ params, body, actor, requestId }) => service.admin.publish(params.id, params.versionId, body ?? {}, { actor, requestId }),
    /** POST /templates/{id}/versions/{versionId}/discard: Discard a draft */
    discardDraftVersion: async ({ params }) => service.admin.discard(params.id, params.versionId),
    /** GET /deliveries: Delivery log */
    listDeliveries: async ({ query, page }) => service.admin.listDeliveries(query, page),
    /** GET /deliveries/{id}: One delivery with provider events */
    getDelivery: async ({ params }) => service.admin.getDelivery(params.id),
    /** POST /deliveries/{id}/retry: Retry a failed delivery */
    retryDelivery: async ({ params, body, actor, requestId }) => service.admin.retryDelivery(params.id, body, { actor, requestId }),
    /** GET /stats: Delivery rate, bounces, failures, queue size */
    getDeliveryStats: async ({ query }) => service.admin.stats(query.days ?? 7),
    /** GET /suppressions: Bounced, complained or blocked addresses */
    listSuppressions: async ({ query, page }) => service.admin.listSuppressions(query, page),
    /** POST /suppressions/{id}/remove: Allow sending again (address fixed or confirmed by the person) */
    removeSuppression: async ({ params, body, actor, requestId }) => service.admin.removeSuppression(params.id, body, { actor, requestId }),
    /** GET /broadcasts: Promotional broadcasts */
    listBroadcasts: async ({ query, page }) => service.admin.listBroadcasts(query, page),
    /** POST /broadcasts: Draft a broadcast to opted-in customers or sellers */
    createBroadcast: async ({ body, actor, requestId }) => service.admin.createBroadcast(body, { actor, requestId }),
    /** POST /broadcasts/{id}/schedule: Schedule a broadcast */
    scheduleBroadcast: async ({ params, body, actor, requestId }) => service.admin.scheduleBroadcast(params.id, body, { actor, requestId }),
    /** POST /broadcasts/{id}/cancel: Cancel a draft or scheduled broadcast */
    cancelBroadcast: async ({ params, body, actor, requestId }) => service.admin.cancelBroadcast(params.id, body, { actor, requestId }),
    /** GET /announcements: Announcements sent to sellers, newest first */
    listAnnouncements: async ({ page }) => service.announcements.list(page),
    /** POST /announcements: Send a message from Marketly to sellers (in-app and email) */
    sendAnnouncement: async ({ body, actor, requestId }) => service.announcements.send(body, { actor, requestId }),
  });
