/**
 * Row types of the messaging collections and the conversation key, inbox and list filters the repository
 * (repository.ts) takes.
 */
import type { MessagingDb } from '../../spec/messaging.js';

export type Db = MessagingDb;
export type TableName = keyof Db & string;
/** Tables keyed by `id` */
export type IdTable = 'conversations' | 'messages' | 'message_reports' | 'reply_templates' | 'staff_access_log';

export type ConversationRec = Db['conversations'];
export type ParticipantRec = Db['participants'];
export type MessageRec = Db['messages'];
export type ReportRec = Db['message_reports'];
export type TemplateRec = Db['reply_templates'];
export type ReplyStatsRec = Db['seller_reply_stats'];

/**
 * The identity of a conversation: one per customer + seller + subject and kind. Columns left undefined are not
 * compared (a guest's conversation is keyed by the order, not the guest session, which changes). case_id is part of
 * the key only for support conversations; for order and staff conversations it is a link.
 */
export interface ConversationKey {
  kind: ConversationRec['kind'];
  customer_id: string | null;
  seller_id: string | null;
  application_id: string | null;
  order_id: string | null;
  order_item_id: string | null;
  return_id: string | null;
  case_id?: string | null;
}

/** Who owns a list of conversations (inbox scope) */
export type InboxOwner =
  /** orderIds: guest orders the session reaches (their conversations are keyed by the order) */
  | { kind: 'customer'; customerId: string | null; guestSessionId: string | null; orderIds?: string[] }
  | { kind: 'seller'; sellerId: string }
  | { kind: 'staff'; staffId: string };

export interface InboxFilter {
  unreadOnly?: boolean;
  /** none | awaiting_seller | replied | overdue, or awaiting_reply (awaiting_seller + overdue) */
  replyState?: string;
  orderId?: string;
  /** Buyer name, seller name, order reference or subject title */
  q?: string;
  /** Seller inbox: overdue first, then awaiting by due time, then newest */
  overdueFirst?: boolean;
}

export interface AdminFilter {
  orderId?: string;
  customerId?: string;
  sellerId?: string;
  caseId?: string;
  /** official_awaiting: Official Store conversations waiting for a staff reply, oldest due first */
  filter?: 'overdue' | 'reported' | 'locked' | 'official_awaiting';
}

/** One message line used for previews, reply labels and statistics */
export interface MessageLine {
  conversation_id: string;
  id: string;
  kind: string;
  author_kind: string | null;
  author_id: string | null;
  author_label: string;
  body: string;
  hidden: boolean;
  at: Date;
}
