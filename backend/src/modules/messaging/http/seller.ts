import { notImplemented, routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/messaging.js';
import type { MessagingService } from '../service.js';

/**
 * Seller API: /api/seller/messaging/…  (docs/api/modules/messaging.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const sellerRoutes = (service: MessagingService) =>
  routes(endpoints, 'seller', {
    /** GET /conversations: Order messages with reply deadlines; overdue first */
    listSellerConversations: notImplemented,
    /** GET /conversations/{id}: Conversation with order status and dispatch warning */
    getSellerConversation: notImplemented,
    /** GET /conversations/{id}/messages: Messages, newest first */
    listSellerMessages: notImplemented,
    /** POST /conversations: Message the buyer of one of the seller's orders */
    startSellerConversation: notImplemented,
    /** POST /conversations/{id}/messages: Reply to the buyer */
    sendSellerMessage: notImplemented,
    /** POST /conversations/{id}/read: Mark read */
    markSellerRead: notImplemented,
    /** GET /response-stats: Reply target, average reply time this month, awaiting and overdue counts */
    getSellerResponseStats: notImplemented,
    /** POST /messages/{id}/report: Report an abusive buyer message */
    sellerReportMessage: notImplemented,
    /** GET /templates: Reply templates */
    listTemplates: notImplemented,
    /** POST /templates: Create a reply template */
    createTemplate: notImplemented,
    /** PATCH /templates/{id}: Edit a reply template */
    updateTemplate: notImplemented,
    /** DELETE /templates/{id}: Delete a reply template */
    deleteTemplate: notImplemented,
  });
