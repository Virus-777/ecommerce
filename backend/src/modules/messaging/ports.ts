/**
 * What the messaging service needs from the outside world, database-agnostic.
 * The MongoDB adapter is repository.ts.
 */
import type { PageRequest } from '../../kernel/lib/pagination.js';
import type * as common from '../../spec/common.js';
import type { MessagingDb } from '../../spec/messaging.js';

export type Db = MessagingDb;
export type Table = keyof Db & string;
/** Tables keyed by `id` */
export type IdTable = 'conversations' | 'messages' | 'message_reports' | 'reply_templates' | 'staff_access_log';

export type ConversationRec = Db['conversations'];
export type ParticipantRec = Db['participants'];
export type MessageRec = Db['messages'];
export type ReportRec = Db['message_reports'];
export type TemplateRec = Db['reply_templates'];
export type AccessLogRec = Db['staff_access_log'];
export type ReplyStatsRec = Db['seller_reply_stats'];

/** A column condition: a value (=), a list (in), null (is null) or an operator */
export type Cond<V> = V | readonly V[] | { op: '<' | '<=' | '>' | '>=' | '<>' | 'is not'; value: V | null };
export type Where<R> = { [K in keyof R]?: Cond<R[K]> };

export interface FindOptions<R> {
  orderBy?: [keyof R & string, 'asc' | 'desc'][];
  limit?: number;
  forUpdate?: boolean;
}

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

/** Persistence for this module's own tables: messaging.conversations, messaging.participants, messaging.messages, messaging.message_reports, messaging.reply_templates, messaging.staff_access_log. */
export interface MessagingRepository {
  /** Runs fn in one transaction with a repository bound to it (nested calls reuse it) */
  transaction<T>(fn: (tx: MessagingRepository) => Promise<T>): Promise<T>;
  /** Inbox (ctx.mongo.claim): true the first time this key is claimed; commits with the transaction it runs in */
  claim(key: string): Promise<boolean>;
  /** The kept conversation an old (merged) id now points to */
  aliasOf(id: string): Promise<string | undefined>;

  /* generic */
  get<T extends IdTable>(table: T, id: string, o?: { forUpdate?: boolean }): Promise<Db[T] | undefined>;
  getMany<T extends IdTable>(table: T, ids: readonly string[]): Promise<Db[T][]>;
  find<T extends Table>(table: T, where: Where<Db[T]>, o?: FindOptions<Db[T]>): Promise<Db[T][]>;
  findOne<T extends Table>(table: T, where: Where<Db[T]>, o?: FindOptions<Db[T]>): Promise<Db[T] | undefined>;
  count<T extends Table>(table: T, where: Where<Db[T]>): Promise<number>;
  insert<T extends Table>(table: T, row: Db[T]): Promise<Db[T]>;
  /** Insert unless a unique key already holds the row; true when inserted */
  insertIgnore<T extends Table>(table: T, row: Db[T]): Promise<boolean>;
  update<T extends IdTable>(table: T, id: string, patch: Partial<Db[T]>): Promise<Db[T]>;
  updateWhere<T extends Table>(table: T, where: Where<Db[T]>, patch: Partial<Db[T]>): Promise<number>;
  removeWhere<T extends Table>(table: T, where: Where<Db[T]>): Promise<number>;

  /* conversations */
  /** The conversation with exactly this key (null-safe on every column) */
  findByKey(key: ConversationKey, o?: { forUpdate?: boolean }): Promise<ConversationRec | undefined>;
  inbox(owner: InboxOwner, filter: InboxFilter, page: PageRequest): Promise<common.Page<ConversationRec>>;
  adminSearch(filter: AdminFilter, page: PageRequest): Promise<common.Page<ConversationRec>>;
  /** Conversations a participant row of this kind and id belongs to */
  conversationsOf(kind: string, participantId: string): Promise<ConversationRec[]>;

  /* participants */
  participantsOf(conversationIds: readonly string[]): Promise<ParticipantRec[]>;
  /** Adds one to the unread count of every participant except the author */
  bumpUnread(conversationId: string, except: { kind: string; id: string } | null): Promise<void>;
  /** Messages after a message that someone other than the participant wrote */
  countUnreadAfter(conversationId: string, after: { at: Date; id: string } | null, me: { kind: string; id: string }): Promise<number>;

  /* messages */
  messagesPage(conversationId: string, page: PageRequest): Promise<common.Page<MessageRec>>;
  /** The newest `perConversation` messages of each conversation, newest first */
  recentMessages(conversationIds: readonly string[], perConversation: number): Promise<MessageLine[]>;
  /** Text messages of a seller's customer conversations in a period (statistics), oldest first */
  sellerMessageLines(sellerId: string, from: Date, to: Date): Promise<MessageLine[]>;
  /** Report counts per conversation (any status) */
  reportCounts(conversationIds: readonly string[]): Promise<Map<string, number>>;

  /* jobs */
  dueAwaiting(now: Date, limit: number): Promise<ConversationRec[]>;
  dueArchive(now: Date, limit: number): Promise<ConversationRec[]>;
  sellersActiveSince(since: Date, limit: number): Promise<string[]>;
  /** Writes a seller's rolled-up reply figures (one row per seller) */
  upsertReplyStats(row: ReplyStatsRec): Promise<void>;
  /** Sellers whose reply figures were computed before this time, oldest first */
  staleReplyStats(before: Date, limit: number): Promise<string[]>;
  /** Awaiting and overdue counts, oldest waiting and unread conversations of a seller */
  sellerInbox(sellerId: string): Promise<{ awaiting: number; overdue: number; oldestWaitingSince: Date | null; unreadConversations: number }>;

  /* reports and templates */
  reportsPage(status: string | undefined, page: PageRequest): Promise<common.Page<ReportRec>>;
}
