import { routes } from '../../../kernel/http/index.js';
import type { Principal, SellerMemberAccess } from '../../../kernel/auth/index.js';
import { endpoints } from '../../../spec/notifications.js';
import type { SellerCaller } from '../app/preferences.js';
import type { NotificationsService } from '../service.js';
import { accountOf } from './store.js';

const callerOf = async (i: { principal: Principal; sellerId: string; sellerAccess: SellerMemberAccess; can(p: string): Promise<boolean> }): Promise<SellerCaller> => ({
  sellerId: i.sellerId,
  accountId: accountOf(i.principal),
  memberId: i.sellerAccess.memberId ?? i.principal.sellerMemberId ?? accountOf(i.principal),
  access: i.sellerAccess,
  canManage: await i.can('notifications.preferences.manage'),
});

/**
 * Seller API: /api/seller/notifications/…  (docs/api/modules/notifications.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const sellerRoutes = (service: NotificationsService) =>
  routes(endpoints, 'seller', {
    /** GET /inbox: Seller workspace notifications */
    listSellerInbox: async ({ principal, sellerAccess, query, page }) =>
      service.listInboxFor({ principal, sellerAccess }, { group: query.group, unreadOnly: query.unreadOnly, actionRequired: query.actionRequired, archived: query.archived }, page),
    /** GET /inbox/summary: Unread, needs action (sorted by deadline) */
    getSellerInboxSummary: async ({ principal, sellerAccess }) => {
      const s = await service.inbox.summary({ principal, sellerAccess });
      return { unread: s.unread, byGroup: s.byGroup, total: s.total, totalByGroup: s.totalByGroup, actionRequired: s.actionRequired, needsAction: s.needsAction };
    },
    /** POST /inbox/{id}/read: Mark one notice as read (for me) */
    markSellerRead: async ({ principal, sellerAccess, params }) => service.inbox.markRead({ principal, sellerAccess }, params.id),
    /** POST /inbox/read-all: Mark all as read (for me) */
    markAllSellerRead: async ({ principal, sellerAccess, body }) => service.inbox.markAll({ principal, sellerAccess }, body.group),
    /** POST /inbox/{id}/archive: Archive one notice (for me) */
    archiveSellerNotice: async ({ principal, sellerAccess, params }) => service.inbox.archive({ principal, sellerAccess }, params.id),
    /** POST /inbox/archive-all: Archive all (or one group) for me */
    archiveAllSellerNotices: async ({ principal, sellerAccess, body }) => service.inbox.archiveAll({ principal, sellerAccess }, { group: body.group, readOnly: body.readOnly }),
    /** GET /preferences: Who hears about what (all members) */
    getSellerPreferences: async (i) => service.prefs.sellerPreferences(await callerOf(i)),
    /** PUT /preferences/members/{memberId}: Set one member's topics and channel */
    updateMemberPreferences: async (i) => service.prefs.updateMember(await callerOf(i), i.params.memberId, i.body, { actor: i.actor, requestId: i.requestId }),
    /** POST /push-devices: Register the Android app for seller push notices */
    registerSellerPushDevice: async ({ principal, sellerId, body }) => service.prefs.registerDevice({ accountId: accountOf(principal), audience: 'seller', sellerId }, body),
    /** DELETE /push-devices/{id}: Stop seller push notices on a device */
    removeSellerPushDevice: async ({ principal, sellerId, params }) => {
      await service.prefs.removeDevice({ accountId: accountOf(principal), audience: 'seller', sellerId }, params.id);
    },
  });
