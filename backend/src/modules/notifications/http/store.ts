import { notImplemented, routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/notifications.js';
import type { NotificationsService } from '../service.js';

/**
 * Store API: /api/store/notifications/…  (docs/api/modules/notifications.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const storeRoutes = (service: NotificationsService) => {
  void service;
  return routes(endpoints, 'store', {
    /** GET /inbox: Customer notifications */
    listInbox: notImplemented,
    /** GET /inbox/summary: Unread badge and counts per group */
    getInboxSummary: notImplemented,
    /** POST /inbox/{id}/read: Mark one notice as read */
    markRead: notImplemented,
    /** POST /inbox/read-all: Mark all (or one group) as read */
    markAllRead: notImplemented,
    /** GET /preferences: What we send and where to change it */
    getCustomerPreferences: notImplemented,
    /** PUT /preferences/push: Turn order-update push notices on or off */
    updateCustomerPushPreference: notImplemented,
    /** POST /push-devices: Register the Android app for push notices */
    registerPushDevice: notImplemented,
    /** DELETE /push-devices/{id}: Stop push notices on a device (sign-out) */
    removePushDevice: notImplemented,
  });
};
