import type { Principal } from '../../../kernel/auth/index.js';
import { routes } from '../../../kernel/http/index.js';
import type * as common from '../../../spec/common.js';
import { endpoints } from '../../../spec/messaging.js';
import type { MessagingService, Viewer } from '../service.js';

/** The staff member behind an Admin Center request */
const staffOf = (principal: Principal, actor: common.Actor): Extract<Viewer, { kind: 'staff' }> => ({
  kind: 'staff',
  accountId: principal.accountId ?? actor.id ?? principal.sessionId,
  name: principal.name ?? actor.name ?? null,
});

/**
 * Admin API: /api/admin/messaging/…  (docs/api/modules/messaging.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const adminRoutes = (service: MessagingService) =>
  routes(endpoints, 'admin', {
    /** GET /conversations: Find conversations by order, customer or seller */
    listAdminConversations: async ({ query, page, principal, actor }) => service.listAdminConversations(query, page, staffOf(principal, actor)),
    /** GET /conversations/{id}/messages: Read a private conversation (reason required, logged) */
    readConversationAsStaff: async ({ params, query, page, principal, actor, requestId }) => service.readConversationAsStaff(staffOf(principal, actor), params.id, query, page, { actor, requestId }),
    /** POST /conversations: Start a Marketly staff conversation with a seller or seller applicant, optionally about an order, items or a return */
    startStaffConversation: async ({ body, principal, actor, requestId }) => service.startStaffConversation(staffOf(principal, actor), body, { actor, requestId }),
    /** POST /conversations/{id}/messages: Post as Marketly Support (joins the conversation) */
    sendStaffMessage: async ({ params, body, principal, actor, requestId }) => service.sendStaffMessage(staffOf(principal, actor), params.id, body, { actor, requestId }),
    /** POST /messages/{id}/hide: Hide a message that breaks the rules */
    hideMessage: async ({ params, body, principal, actor, requestId }) => service.hideMessage(staffOf(principal, actor), params.id, body.reason, { actor, requestId }),
    /** POST /conversations/{id}/lock: Lock or unlock a conversation */
    lockConversation: async ({ params, body, principal, actor, requestId }) => service.lockConversation(staffOf(principal, actor), params.id, body, { actor, requestId }),
    /** GET /reports: Reported messages */
    listMessageReports: async ({ query, page, principal, actor }) => service.listMessageReports(query.status, page, staffOf(principal, actor)),
    /** POST /reports/{id}/decide: Action or dismiss a report */
    decideMessageReport: async ({ params, body, principal, actor, requestId }) => service.decideMessageReport(staffOf(principal, actor), params.id, body, { actor, requestId }),
    /** GET /sellers/{sellerId}/response-stats: A seller's reply performance */
    getSellerResponseAdmin: async ({ params, query }) => service.sellerStatsAdmin(params.sellerId, query),
  });
