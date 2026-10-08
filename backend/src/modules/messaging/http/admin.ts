import { notImplemented, routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/messaging.js';
import type { MessagingService } from '../service.js';

/**
 * Admin API: /api/admin/messaging/…  (docs/api/modules/messaging.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const adminRoutes = (service: MessagingService) =>
  routes(endpoints, 'admin', {
    /** GET /conversations: Find conversations by order, customer or seller */
    listAdminConversations: notImplemented,
    /** GET /conversations/{id}/messages: Read a private conversation (reason required, logged) */
    readConversationAsStaff: notImplemented,
    /** POST /conversations: Start a Marketly staff conversation with a seller or seller applicant, optionally about an order, items or a return */
    startStaffConversation: notImplemented,
    /** POST /conversations/{id}/messages: Post as Marketly Support (joins the conversation) */
    sendStaffMessage: notImplemented,
    /** POST /messages/{id}/hide: Hide a message that breaks the rules */
    hideMessage: notImplemented,
    /** POST /conversations/{id}/lock: Lock or unlock a conversation */
    lockConversation: notImplemented,
    /** GET /reports: Reported messages */
    listMessageReports: notImplemented,
    /** POST /reports/{id}/decide: Action or dismiss a report */
    decideMessageReport: notImplemented,
    /** GET /sellers/{sellerId}/response-stats: A seller's reply performance */
    getSellerResponseAdmin: notImplemented,
  });
