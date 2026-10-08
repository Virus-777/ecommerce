import { notImplemented, routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/notifications.js';
import type { NotificationsService } from '../service.js';

/**
 * Seller API: /api/seller/notifications/…  (docs/api/modules/notifications.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const sellerRoutes = (service: NotificationsService) =>
  routes(endpoints, 'seller', {
    /** GET /inbox: Seller workspace notifications */
    listSellerInbox: notImplemented,
    /** GET /inbox/summary: Unread, needs action (sorted by deadline) */
    getSellerInboxSummary: notImplemented,
    /** POST /inbox/{id}/read: Mark one notice as read (for me) */
    markSellerRead: notImplemented,
    /** POST /inbox/read-all: Mark all as read (for me) */
    markAllSellerRead: notImplemented,
    /** GET /preferences: Who hears about what (all members) */
    getSellerPreferences: notImplemented,
    /** PUT /preferences/members/{memberId}: Set one member's topics and channel */
    updateMemberPreferences: notImplemented,
    /** POST /push-devices: Register the Android app for seller push notices */
    registerSellerPushDevice: notImplemented,
    /** DELETE /push-devices/{id}: Stop seller push notices on a device */
    removeSellerPushDevice: notImplemented,
  });
