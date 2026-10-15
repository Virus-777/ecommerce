import type { Scope } from '../../../kernel/auth/scope.js';
import { routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/messaging.js';
import type { MessagingService, Viewer } from '../service.js';

/** The shopper behind a store request: a signed-in customer or a guest (visitor) session */
export const shopperOf = (scope: Scope, principal: { guestSessionId?: string | null; sessionId: string; kind: string; accountId?: string | null }): Extract<Viewer, { kind: 'customer' }> => {
  if (scope.kind === 'customer') return { kind: 'customer', customerId: scope.customerId, guestSessionId: null, accountId: scope.accountId };
  if (scope.kind === 'visitor') return { kind: 'customer', customerId: null, guestSessionId: principal.guestSessionId ?? scope.visitorSessionId, accountId: null };
  return { kind: 'customer', customerId: null, guestSessionId: principal.kind === 'visitor' ? principal.sessionId : null, accountId: principal.accountId ?? null };
};

/**
 * Store API: /api/store/messaging/…  (docs/api/modules/messaging.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const storeRoutes = (service: MessagingService) =>
  routes(endpoints, 'store', {
    /** GET /conversations: Inbox: conversations with sellers and Marketly support */
    listCustomerConversations: async ({ query, page, scope, principal }) => service.listCustomerConversations(shopperOf(scope, principal), query, page),
    /** GET /conversations/{id}: Conversation header: counterparty, response time, linked order or item and its status */
    getCustomerConversation: async ({ params, scope, principal }) => service.getConversationFor(shopperOf(scope, principal), params.id),
    /** GET /conversations/{id}/messages: Messages, newest first (cursor for older) */
    listCustomerMessages: async ({ params, page, scope, principal }) => service.messagesFor(shopperOf(scope, principal), params.id, page),
    /** POST /product-conversations: Message the seller about one of its products before buying (G4) */
    startProductConversation: async ({ body, scope, principal, actor, requestId }) => service.startProductConversation(shopperOf(scope, principal), body, { actor, requestId }),
    /** POST /conversations: Message a seller or Marketly support about an order, item or return */
    startCustomerConversation: async ({ body, scope, principal, actor, requestId }) => service.startCustomerConversation(shopperOf(scope, principal), body, { actor, requestId }),
    /** POST /conversations/{id}/messages: Send a message with optional photos or files */
    sendCustomerMessage: async ({ params, body, scope, principal, actor, requestId }) => service.sendMessage(shopperOf(scope, principal), params.id, body, { actor, requestId }),
    /** POST /conversations/{id}/read: Mark messages read up to a message */
    markCustomerRead: async ({ params, body, scope, principal }) => {
      await service.markRead(shopperOf(scope, principal), params.id, body.upToMessageId);
    },
    /** GET /unread-count: Unread conversations for the header and account menu */
    customerUnreadCount: async ({ scope, principal }) => service.unreadCounts(shopperOf(scope, principal)),
    /** POST /messages/{id}/report: Report an abusive, promotional or off-platform message */
    customerReportMessage: async ({ params, body, scope, principal, actor, requestId }) => service.reportMessage(shopperOf(scope, principal), params.id, body, { actor, requestId }),
  });
