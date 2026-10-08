import { notImplemented } from '../../kernel/errors/index.js';
import type { EventPayload } from '../../kernel/events/index.js';
import type { ModuleContext } from '../../kernel/module-system/index.js';
import type * as common from '../../spec/common.js';
import type { MessagingPublicApi, Conversation, ConversationSummary, Message, ResponseStats, CustomerConversationSummary } from '../../spec/messaging.js';
import type { MessagingRepository } from './ports.js';

export interface MessagingServiceDeps {
  repo: MessagingRepository;
  ctx: ModuleContext<'messaging'>;
}

/**
 * Messaging use cases. Depends only on ports, the event bus, the clock and other modules' public APIs.
 * Each method maps to a publicApi function, a consumed event or a job in docs/api/spec/modules/messaging.json.
 */
export class MessagingService implements MessagingPublicApi {
  readonly #deps: MessagingServiceDeps;

  constructor(deps: MessagingServiceDeps) {
    this.#deps = deps;
  }

  protected get deps(): MessagingServiceDeps {
    return this.#deps;
  }

  /* ---------------- public API (in-process) */

  /** One conversation per customer, seller and subject; reused when it exists */
  async findOrStartForOrder(input: { orderId: string, sellerId: string, orderItemId?: string, returnId?: string }): Promise<Conversation> {
    throw notImplemented('messaging.findOrStartForOrder');
  }

  /** e.g. Marketly Support joined from case CS-261005-3381 */
  async postSystemNote(conversationId: string, text: string): Promise<Message> {
    throw notImplemented('messaging.postSystemNote');
  }

  /** Support joins an order conversation when a case is opened */
  async addStaffParticipant(conversationId: string, staff: common.Actor, caseId: string): Promise<Conversation> {
    throw notImplemented('messaging.addStaffParticipant');
  }

  /** Response time for seller performance and reports */
  async sellerResponseStats(sellerId: string, range: common.DateRange): Promise<ResponseStats> {
    throw notImplemented('messaging.sellerResponseStats');
  }

  /** Badge counts for the account and Seller Center */
  async unreadCount(participant: common.Actor): Promise<number> {
    throw notImplemented('messaging.unreadCount');
  }

  /** Conversations about an order or its items that the participant takes part in (Order.conversations) */
  async listForOrder(orderId: string, participant: common.Actor): Promise<ConversationSummary[]> {
    throw notImplemented('messaging.listForOrder');
  }

  /** The conversation linked to a return, case or item, batched (Return.conversation) */
  async getForSubject(subject: { kind: 'return' | 'case' | 'order_item', id: string }, participant: common.Actor): Promise<Conversation | null> {
    throw notImplemented('messaging.getForSubject');
  }

  /** Unread counts and who wrote, for the account overview tile and header badge */
  async unreadSummary(participant: common.Actor): Promise<{ conversations: number, messages: number, fromNames: string[] }> {
    throw notImplemented('messaging.unreadSummary');
  }

  /** Unanswered and overdue customer messages for the seller dashboard */
  async sellerInboxSummary(sellerId: string): Promise<{ awaitingReply: number, overdue: number, oldestWaitingSince: string | null, unreadConversations: number, targetHours: number }> {
    throw notImplemented('messaging.sellerInboxSummary');
  }

  /** Inbox of a customer or seller; the seller inbox lists overdue first */
  async listInbox(participant: common.Actor, filter: { unreadOnly?: boolean, replyState?: string }, page: common.PageInput): Promise<common.Page<ConversationSummary>> {
    throw notImplemented('messaging.listInbox');
  }

  /** Conversation header and messages for a participant */
  async getConversation(participant: common.Actor, conversationId: string): Promise<Conversation | null> {
    throw notImplemented('messaging.getConversation');
  }

  /** Counts, last message time and counterparties of each customer's conversations for the customer 360; never message content */
  async customerConversationSummaries(customerIds: string[]): Promise<Record<string, CustomerConversationSummary>> {
    throw notImplemented('messaging.customerConversationSummaries');
  }

  /* ---------------- events consumed */

  /** support.case.opened: If the case concerns an order conversation, add Marketly Support as a participant and post a system note */
  async onCaseOpenedFromSupport(event: EventPayload<"support.case.opened">): Promise<void> {
    void event;
    throw notImplemented('messaging consumer of support.case.opened');
  }

  /** orders.order.completed: Schedule archiving of the order's conversations after archiveAfterDays */
  async onOrderCompletedFromOrders(event: EventPayload<"orders.order.completed">): Promise<void> {
    void event;
    throw notImplemented('messaging consumer of orders.order.completed');
  }

  /** trust.enforcement.recorded: Lock conversations named in an abuse enforcement */
  async onEnforcementRecordedFromTrust(event: EventPayload<"trust.enforcement.recorded">): Promise<void> {
    void event;
    throw notImplemented('messaging consumer of trust.enforcement.recorded');
  }

  /* ---------------- jobs */

  /** Job messaging.reply-deadlines (every 10 min): Move awaiting conversations past their due time to overdue and publish messaging.reply.overdue */
  async replyDeadlines(): Promise<void> {
    throw notImplemented('job messaging.reply-deadlines');
  }

  /** Job messaging.archive (daily 04:00 PT): Archive conversations past archiveAfterDays */
  async archive(): Promise<void> {
    throw notImplemented('job messaging.archive');
  }

  /** Job messaging.response-stats (hourly): Roll up seller reply times for performance and Seller Center */
  async responseStats(): Promise<void> {
    throw notImplemented('job messaging.response-stats');
  }
}
