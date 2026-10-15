import { AppError } from '../../../kernel/errors/index.js';
import { routes } from '../../../kernel/http/index.js';
import type { Principal } from '../../../kernel/auth/index.js';
import { endpoints } from '../../../spec/notifications.js';
import type { NotificationsService } from '../service.js';

/** The signed-in account behind a request (customer, seller member or staff) */
export const accountOf = (p: Principal): string => {
  if (!p.accountId) throw new AppError('UNAUTHORIZED', 'Sign in to continue', { reason: 'sign_in_required' });
  return p.accountId;
};

/**
 * Store API: /api/store/notifications/…  (docs/api/modules/notifications.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const storeRoutes = (service: NotificationsService) =>
  routes(endpoints, 'store', {
    /** GET /inbox: Customer notifications */
    listInbox: async ({ principal, query, page }) => service.listInboxFor({ principal }, { group: query.group, unreadOnly: query.unreadOnly, archived: query.archived }, page),
    /** GET /inbox/summary: Unread badge and counts per group */
    getInboxSummary: async ({ principal }) => {
      const s = await service.inbox.summary({ principal });
      return { unread: s.unread, byGroup: s.byGroup, total: s.total, totalByGroup: s.totalByGroup, actionRequired: s.actionRequired, needsAction: s.needsAction };
    },
    /** POST /inbox/{id}/read: Mark one notice as read */
    markRead: async ({ principal, params }) => service.inbox.markRead({ principal }, params.id),
    /** POST /inbox/read-all: Mark all (or one group) as read */
    markAllRead: async ({ principal, body }) => service.inbox.markAll({ principal }, body.group),
    /** POST /inbox/{id}/archive: Archive one notice (for me) */
    archiveNotice: async ({ principal, params }) => service.inbox.archive({ principal }, params.id),
    /** POST /inbox/archive-all: Archive all (or one group) for me */
    archiveAllNotices: async ({ principal, body }) => service.inbox.archiveAll({ principal }, { group: body.group, readOnly: body.readOnly }),
    /** GET /preferences: What we send and where to change it */
    getCustomerPreferences: async ({ principal }) => service.prefs.customerPreferences(accountOf(principal)),
    /** PUT /preferences/push: Turn order-update push notices on or off */
    updateCustomerPushPreference: async ({ principal, body }) => service.prefs.updateCustomerPush(accountOf(principal), body.orderUpdates),
    /** POST /push-devices: Register the Android app for push notices */
    registerPushDevice: async ({ principal, body }) => service.prefs.registerDevice({ accountId: accountOf(principal), audience: 'customer', sellerId: null }, body),
    /** DELETE /push-devices/{id}: Stop push notices on a device (sign-out) */
    removePushDevice: async ({ principal, params }) => {
      await service.prefs.removeDevice({ accountId: accountOf(principal), audience: 'customer', sellerId: null }, params.id);
    },
  });
