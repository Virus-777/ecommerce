import { notImplemented, routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/notifications.js';
import type { NotificationsService } from '../service.js';

/**
 * Admin API: /api/admin/notifications/…  (docs/api/modules/notifications.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const adminRoutes = (service: NotificationsService) =>
  routes(endpoints, 'admin', {
    /** GET /inbox: My staff notices (routed by role, including roles I cover as backup) */
    listStaffInbox: notImplemented,
    /** GET /inbox/summary: Counts and today's routing for my roles */
    getStaffInboxSummary: notImplemented,
    /** POST /inbox/{id}/read: Mark one notice as read (for me) */
    markStaffRead: notImplemented,
    /** POST /inbox/read-all: Mark all as read (for me) */
    markAllStaffRead: notImplemented,
    /** GET /my-preferences: My email preferences for staff notices */
    getMyStaffPreferences: notImplemented,
    /** PUT /my-preferences: Change my email preferences */
    updateMyStaffPreferences: notImplemented,
    /** GET /topics: Audience × event × channel matrix with delivery stats */
    getTopicMatrix: notImplemented,
    /** PUT /topics/{key}/channels: Turn channels on or off for a topic */
    updateTopicChannels: notImplemented,
    /** GET /templates: Templates */
    listTemplates: notImplemented,
    /** GET /templates/{id}: Template editor: topic, variables, live and draft versions, history */
    getTemplate: notImplemented,
    /** POST /templates/{id}/versions: Start a draft (from the live version, or restore an older one) */
    createDraftVersion: notImplemented,
    /** PATCH /templates/{id}/versions/{versionId}: Edit a draft (returns validation) */
    updateDraftVersion: notImplemented,
    /** POST /templates/{id}/versions/{versionId}/preview: Render with sample or real data on desktop or phone */
    previewVersion: notImplemented,
    /** POST /templates/{id}/versions/{versionId}/test-send: Send a test to my own email (or an allowed staff address) */
    testSendVersion: notImplemented,
    /** POST /templates/{id}/versions/{versionId}/publish: Publish a draft as the live version */
    publishVersion: notImplemented,
    /** POST /templates/{id}/versions/{versionId}/discard: Discard a draft */
    discardDraftVersion: notImplemented,
    /** GET /deliveries: Delivery log */
    listDeliveries: notImplemented,
    /** GET /deliveries/{id}: One delivery with provider events */
    getDelivery: notImplemented,
    /** POST /deliveries/{id}/retry: Retry a failed delivery */
    retryDelivery: notImplemented,
    /** GET /stats: Delivery rate, bounces, failures, queue size */
    getDeliveryStats: notImplemented,
    /** GET /suppressions: Bounced, complained or blocked addresses */
    listSuppressions: notImplemented,
    /** POST /suppressions/{id}/remove: Allow sending again (address fixed or confirmed by the person) */
    removeSuppression: notImplemented,
    /** GET /broadcasts: Promotional broadcasts */
    listBroadcasts: notImplemented,
    /** POST /broadcasts: Draft a broadcast to opted-in customers or sellers */
    createBroadcast: notImplemented,
    /** POST /broadcasts/{id}/schedule: Schedule a broadcast */
    scheduleBroadcast: notImplemented,
    /** POST /broadcasts/{id}/cancel: Cancel a draft or scheduled broadcast */
    cancelBroadcast: notImplemented,
  });
