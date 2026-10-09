import type { Principal } from '../../../kernel/auth/index.js';
import { routes } from '../../../kernel/http/index.js';
import type * as common from '../../../spec/common.js';
import { endpoints } from '../../../spec/messaging.js';
import type { MessagingService, Viewer } from '../service.js';

/** The seller team member behind a Seller Center request (conversations belong to the seller, not the member) */
const sellerOf = (sellerId: string, principal: Principal, actor: common.Actor): Extract<Viewer, { kind: 'seller' }> => ({
  kind: 'seller',
  sellerId,
  accountId: principal.accountId ?? null,
  name: principal.name ?? actor.name ?? null,
});

/**
 * Seller API: /api/seller/messaging/…  (docs/api/modules/messaging.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const sellerRoutes = (service: MessagingService) =>
  routes(endpoints, 'seller', {
    /** GET /conversations: Order messages with reply deadlines; overdue first */
    listSellerConversations: async ({ query, page, sellerId, principal, actor }) => service.listSellerConversations(sellerOf(sellerId, principal, actor), query, page),
    /** GET /conversations/{id}: Conversation with order status and dispatch warning */
    getSellerConversation: async ({ params, sellerId, principal, actor }) => service.getConversationFor(sellerOf(sellerId, principal, actor), params.id),
    /** GET /conversations/{id}/messages: Messages, newest first */
    listSellerMessages: async ({ params, page, sellerId, principal, actor }) => service.messagesFor(sellerOf(sellerId, principal, actor), params.id, page),
    /** POST /conversations: Message the buyer of one of the seller's orders */
    startSellerConversation: async ({ body, sellerId, principal, actor, requestId }) => service.startSellerConversation(sellerOf(sellerId, principal, actor), body, { actor, requestId }),
    /** POST /conversations/{id}/messages: Reply to the buyer */
    sendSellerMessage: async ({ params, body, sellerId, principal, actor, requestId }) => service.sendMessage(sellerOf(sellerId, principal, actor), params.id, body, { actor, requestId }),
    /** POST /conversations/{id}/read: Mark read */
    markSellerRead: async ({ params, body, sellerId, principal, actor }) => {
      await service.markRead(sellerOf(sellerId, principal, actor), params.id, body.upToMessageId);
    },
    /** GET /response-stats: Reply target, average reply time this month, awaiting and overdue counts */
    getSellerResponseStats: async ({ sellerId }) => service.sellerStatsThisMonth(sellerId),
    /** POST /messages/{id}/report: Report an abusive buyer message */
    sellerReportMessage: async ({ params, body, sellerId, principal, actor, requestId }) => service.reportMessage(sellerOf(sellerId, principal, actor), params.id, body, { actor, requestId }),
    /** GET /templates: Reply templates */
    listTemplates: async ({ sellerId }) => service.listTemplates(sellerId),
    /** POST /templates: Create a reply template */
    createTemplate: async ({ body, sellerId }) => service.createTemplate(sellerId, body),
    /** PATCH /templates/{id}: Edit a reply template */
    updateTemplate: async ({ params, body, sellerId }) => service.updateTemplate(sellerId, params.id, body),
    /** DELETE /templates/{id}: Delete a reply template */
    deleteTemplate: async ({ params, sellerId }) => {
      await service.deleteTemplate(sellerId, params.id);
    },
  });
