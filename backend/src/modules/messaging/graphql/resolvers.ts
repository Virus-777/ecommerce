import type { ModuleResolvers } from '../../../kernel/graphql/index.js';
import type { MessagingService } from '../service.js';

/**
 * Resolvers for the GraphQL fields this module owns (`@source(module: "messaging", …)` in graphql/schema.ts).
 * A field without a resolver answers NOT_IMPLEMENTED; fields of this module's own types without
 * @source resolve from the parent object.
 *
 * Fields to resolve:
 *   Order.conversations → service.listForOrder
 *   Return.conversation → service.getForSubject
 *   Customer.unreadMessages → service.unreadSummary
 *   Customer.conversationSummary → service.customerConversationSummaries
 *   Seller.inbox → service.sellerInboxSummary
 *   Seller.replyStats → service.sellerResponseStats
 *   Query.conversations → service.listInbox
 *   Query.conversation → service.getConversation
 *   Query.sellerConversations → service.listInbox
 *   Query.sellerConversation → service.getConversation
 */
export const resolvers = (service: MessagingService): ModuleResolvers => {
  void service;
  return {};
};
