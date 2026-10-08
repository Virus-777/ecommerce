import { notImplemented, routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/messaging.js';
import type { MessagingService } from '../service.js';

/**
 * Store API: /api/store/messaging/…  (docs/api/modules/messaging.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const storeRoutes = (service: MessagingService) => {
  void service;
  return routes(endpoints, 'store', {
    /** GET /conversations: Inbox: conversations with sellers and Marketly support */
    listCustomerConversations: notImplemented,
    /** GET /conversations/{id}: Conversation header: counterparty, response time, linked order or item and its status */
    getCustomerConversation: notImplemented,
    /** GET /conversations/{id}/messages: Messages, newest first (cursor for older) */
    listCustomerMessages: notImplemented,
    /** POST /conversations: Message a seller or Marketly support about an order, item or return */
    startCustomerConversation: notImplemented,
    /** POST /conversations/{id}/messages: Send a message with optional photos or files */
    sendCustomerMessage: notImplemented,
    /** POST /conversations/{id}/read: Mark messages read up to a message */
    markCustomerRead: notImplemented,
    /** GET /unread-count: Unread conversations for the header and account menu */
    customerUnreadCount: notImplemented,
    /** POST /messages/{id}/report: Report an abusive, promotional or off-platform message */
    customerReportMessage: notImplemented,
  });
};
