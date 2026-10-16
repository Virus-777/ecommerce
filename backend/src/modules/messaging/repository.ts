import { orThrow } from '../../kernel/lib/or-throw.js';
import type { PageRequest } from '../../kernel/lib/pagination.js';
import { contains, whereFilter, type Filter, type ModuleStore, type Table, type Where } from '../../kernel/mongo/index.js';
import { OFFICIAL_STORE_ID, type Page } from '../../spec/common.js';
import type { AdminFilter, ConversationKey, ConversationRec, Db, IdTable, InboxFilter, InboxOwner, MessageLine, MessageRec, ParticipantRec, ReplyStatsRec, ReportRec, TableName } from './ports.js';

/** Sort, limit and lock options of the generic find */
export interface FindOptions<R> {
  orderBy?: [keyof R & string, 'asc' | 'desc'][];
  limit?: number;
  forUpdate?: boolean;
}

const sortOf = (orderBy: [string, 'asc' | 'desc'][] | undefined) => (orderBy?.length ? Object.fromEntries(orderBy.map(([c, d]) => [c, d === 'desc' ? -1 : 1] as const)) : undefined);

const defined = (patch: Record<string, unknown>) => Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));

/** The participant row that stands for an inbox owner */
function ownerParticipant(owner: InboxOwner): { kind: string; ids: string[] } {
  if (owner.kind === 'seller') return { kind: 'seller', ids: [owner.sellerId] };
  if (owner.kind === 'staff') return { kind: 'staff', ids: [owner.staffId] };
  return { kind: 'customer', ids: [owner.customerId, owner.guestSessionId].filter((x): x is string => !!x) };
}

/** A message row as a message line */
function line(m: MessageRec): MessageLine {
  return { conversation_id: m.conversation_id, id: m.id, kind: m.kind, author_kind: m.author_kind, author_id: m.author_id, author_label: m.author_label, body: m.body, hidden: m.hidden, at: m.at };
}

/**
 * messaging.conversations, participants, messages, message_reports, reply_templates, staff_access_log,
 * conversation_aliases and seller_reply_stats (MongoDB, docs/04-mongodb-migration.md).
 */
export class MessagingRepository {
  readonly #conversations: Table<ConversationRec>;
  readonly #participants: Table<ParticipantRec>;
  readonly #messages: Table<MessageRec>;

  constructor(private readonly store: ModuleStore) {
    this.#conversations = this.#t('conversations');
    this.#participants = this.#t('participants');
    this.#messages = this.#t('messages');
  }

  #t<T extends TableName>(name: T): Table<Db[T]> {
    return this.store.table<Db[T]>(name);
  }

  /** Runs fn in one transaction with a repository bound to it (nested calls reuse it) */
  transaction<T>(fn: (tx: MessagingRepository) => Promise<T>): Promise<T> {
    return this.store.transaction((tx) => fn(new MessagingRepository(tx)));
  }

  /** Inbox (ctx.mongo.claim): true the first time this key is claimed; commits with the transaction it runs in */
  claim(key: string): Promise<boolean> {
    return this.store.claim(key);
  }

  /** The kept conversation an old (merged) id now points to */
  async aliasOf(id: string): Promise<string | undefined> {
    return (await this.#t('conversation_aliases').get(id))?.conversation_id;
  }

  /* ---------------------------------------------------------------- generic */

  get<T extends IdTable>(table: T, id: string, o?: { forUpdate?: boolean }): Promise<Db[T] | undefined> {
    return this.#t(table).get(id, o);
  }

  getMany<T extends IdTable>(table: T, ids: readonly string[]): Promise<Db[T][]> {
    return this.#t(table).getMany([...new Set(ids)]);
  }

  find<T extends TableName>(table: T, where: Where<Db[T]>, o?: FindOptions<Db[T]>): Promise<Db[T][]> {
    return this.#t(table).find(whereFilter(where), { sort: sortOf(o?.orderBy), limit: o?.limit, forUpdate: o?.forUpdate });
  }

  findOne<T extends TableName>(table: T, where: Where<Db[T]>, o?: FindOptions<Db[T]>): Promise<Db[T] | undefined> {
    return this.#t(table).findOne(whereFilter(where), { sort: sortOf(o?.orderBy), forUpdate: o?.forUpdate });
  }

  count<T extends TableName>(table: T, where: Where<Db[T]>): Promise<number> {
    return this.#t(table).count(whereFilter(where));
  }

  insert<T extends TableName>(table: T, row: Db[T]): Promise<Db[T]> {
    return this.#t(table).insert(row);
  }

  /** Adds a participant unless it is in the conversation already (on conflict do nothing); true when added */
  async addParticipant(row: ParticipantRec): Promise<boolean> {
    return Boolean(await this.#participants.insertIfAbsent(row));
  }

  /** Sets the defined fields of patch; the row after (an empty patch reads it) */
  async update<T extends IdTable>(table: T, id: string, patch: Partial<Db[T]>): Promise<Db[T]> {
    const values = defined(patch as Record<string, unknown>);
    const row = Object.keys(values).length ? await this.#t(table).update(id, values) : await this.#t(table).get(id);
    return orThrow(row, `messaging: ${table} ${id}`);
  }

  async updateWhere<T extends TableName>(table: T, where: Where<Db[T]>, patch: Partial<Db[T]>): Promise<number> {
    const values = defined(patch as Record<string, unknown>);
    if (!Object.keys(values).length) return 0;
    return this.#t(table).updateMany(whereFilter(where), values);
  }

  removeWhere<T extends TableName>(table: T, where: Where<Db[T]>): Promise<number> {
    return this.#t(table).deleteMany(whereFilter(where));
  }

  /* ---------------------------------------------------------------- conversations */

  /** The conversation with exactly this key (null-safe on every column) */
  findByKey(key: ConversationKey, o?: { forUpdate?: boolean }): Promise<ConversationRec | undefined> {
    const f: Filter = {};
    for (const [col, value] of Object.entries(key)) if (value !== undefined) f[col] = value;
    return this.#conversations.findOne(f, { sort: { created_at: 1 }, forUpdate: o?.forUpdate });
  }

  async inbox(owner: InboxOwner, f: InboxFilter, page: PageRequest): Promise<Page<ConversationRec>> {
    const me = ownerParticipant(owner);
    const and: Filter[] = [];
    if (owner.kind === 'customer') {
      if (!me.ids.length) return { items: [], nextCursor: null, total: 0 };
      const guestOrders = (owner.orderIds ?? []).filter(Boolean);
      const mine: Filter[] = [
        ...(owner.customerId ? [{ customer_id: owner.customerId }] : []),
        ...(owner.guestSessionId ? [{ guest_session_id: owner.guestSessionId }] : []),
        // guest conversations are keyed by the order: any session with access to it
        ...(!owner.customerId && guestOrders.length ? [{ customer_id: null, order_id: { $in: guestOrders } }] : []),
      ];
      const or: Filter[] = [{ kind: { $in: ['order', 'support'] }, $or: mine }];
      // a seller applicant's conversations with Marketly staff (the applicant is a customer participant)
      if (owner.customerId) or.push({ kind: 'staff_seller', application_id: { $ne: null }, id: { $in: await this.#conversationIdsOf('customer', [owner.customerId]) } });
      and.push({ $or: or });
    } else if (owner.kind === 'seller') {
      and.push({ seller_id: owner.sellerId, kind: { $in: ['order', 'staff_seller'] } });
    } else {
      and.push({ id: { $in: await this.#conversationIdsOf('staff', [owner.staffId]) } });
    }
    if (f.orderId) and.push({ order_id: f.orderId });
    if (f.replyState === 'awaiting_reply') and.push({ reply_state: { $in: ['awaiting_seller', 'overdue'] } });
    else if (f.replyState) and.push({ reply_state: f.replyState });
    const guestUnread = Boolean(f.unreadOnly) && owner.kind === 'customer' && !owner.customerId;
    if (f.unreadOnly && !guestUnread) and.push({ id: { $in: await this.#conversationIdsOf(me.kind, me.ids, true) } });

    const stages: Filter[] = [{ $match: this.#conversations.filter({ $and: and }) }];
    if (guestUnread) {
      // the order's guest participant (order:<order_id>) has unread messages
      stages.push(
        {
          $lookup: {
            from: this.#participants.name,
            let: { cid: '$_id', guest: { $concat: ['order:', { $ifNull: ['$order_id', ''] }] } },
            pipeline: [{ $match: { $expr: { $and: [{ $eq: ['$conversation_id', '$$cid'] }, { $eq: ['$kind', 'guest'] }, { $eq: ['$participant_id', '$$guest'] }, { $gt: ['$unread_count', 0] }] } } }, { $limit: 1 }],
            as: '_guest_unread',
          },
        },
        { $match: { '_guest_unread.0': { $exists: true } } },
        { $unset: '_guest_unread' },
      );
    }
    if (f.q?.trim()) {
      const term = contains(f.q);
      stages.push(
        { $lookup: { from: this.#participants.name, localField: '_id', foreignField: 'conversation_id', pipeline: [{ $match: { name: term } }, { $limit: 1 }], as: '_named' } },
        { $match: { $or: [{ 'subject.title': term }, { 'subject.orderRef': term }, { 'subject.returnRef': term }, { '_named.0': { $exists: true } }] } },
        { $unset: '_named' },
      );
    }
    // seller inbox: overdue first, then awaiting, then the rest; newest message first within each
    const epoch = { $toLong: '$last_message_at' };
    const rank = { $switch: { branches: [{ case: { $eq: ['$reply_state', 'overdue'] }, then: 3 }, { case: { $eq: ['$reply_state', 'awaiting_seller'] }, then: 2 }], default: 1 } };
    stages.push({ $addFields: { sort_key: { $toDouble: f.overdueFirst ? { $add: [{ $multiply: [rank, 1e13] }, epoch] } : epoch } } });
    return this.#conversations.pageAggregate(stages, page, { key: 'sort_key', direction: 'desc' });
  }

  async adminSearch(f: AdminFilter, page: PageRequest): Promise<Page<ConversationRec>> {
    const and: Filter[] = [];
    if (f.orderId) and.push({ order_id: f.orderId });
    if (f.customerId) and.push({ customer_id: f.customerId });
    if (f.sellerId) and.push({ seller_id: f.sellerId });
    if (f.caseId) and.push({ case_id: f.caseId });
    if (f.filter === 'overdue') and.push({ reply_state: 'overdue' });
    if (f.filter === 'locked') and.push({ status: 'locked' });
    if (f.filter === 'reported') and.push({ id: { $in: await this.#t('message_reports').distinct<string>('conversation_id') } });
    if (f.filter === 'official_awaiting') {
      // Official Store conversations waiting for a staff reply, oldest due first
      and.push({ kind: 'order', seller_id: OFFICIAL_STORE_ID, reply_state: { $in: ['awaiting_seller', 'overdue'] }, reply_due_at: { $ne: null } });
      return this.#conversations.page({ $and: and }, page, { column: 'reply_due_at', direction: 'asc' });
    }
    return this.#conversations.page(and.length ? { $and: and } : {}, page, { column: 'last_message_at', direction: 'desc' });
  }

  /** Conversations a participant row of this kind and id belongs to */
  async conversationsOf(kind: string, participantId: string): Promise<ConversationRec[]> {
    return this.#conversations.getMany(await this.#conversationIdsOf(kind, [participantId]));
  }

  /* ---------------------------------------------------------------- participants */

  async participantsOf(conversationIds: readonly string[]): Promise<ParticipantRec[]> {
    return conversationIds.length ? this.#participants.find({ conversation_id: { $in: [...new Set(conversationIds)] } }, { sort: { joined_at: 1, kind: 1 } }) : [];
  }

  /** Adds one to the unread count of every participant except the author */
  async bumpUnread(conversationId: string, except: { kind: string; id: string } | null): Promise<void> {
    await this.#participants.updateMany({ conversation_id: conversationId, ...(except ? { $nor: [{ kind: except.kind, participant_id: except.id }] } : {}) }, { $inc: { unread_count: 1 } });
  }

  /** Messages after a message that someone other than the participant wrote */
  countUnreadAfter(conversationId: string, after: { at: Date; id: string } | null, me: { kind: string; id: string }): Promise<number> {
    return this.#messages.count({
      conversation_id: conversationId,
      // not written by me (an author-less system note counts)
      $nor: [{ author_kind: me.kind, author_id: me.id }],
      ...(after ? { $or: [{ at: { $gt: after.at } }, { at: after.at, id: { $gt: after.id } }] } : {}),
    });
  }

  /* ---------------------------------------------------------------- messages */

  messagesPage(conversationId: string, page: PageRequest): Promise<Page<MessageRec>> {
    return this.#messages.page({ conversation_id: conversationId }, page, { column: 'at', direction: 'desc' });
  }

  /** The newest `perConversation` messages of each conversation, newest first */
  async recentMessages(conversationIds: readonly string[], perConversation: number): Promise<MessageLine[]> {
    if (!conversationIds.length) return [];
    const docs = await this.#messages.aggregate<Record<string, unknown>>([
      { $match: { conversation_id: { $in: [...new Set(conversationIds)] } } },
      // row_number() over (partition by conversation_id order by at desc, id desc) <= per
      { $sort: { conversation_id: 1, at: -1, _id: -1 } },
      { $group: { _id: '$conversation_id', docs: { $firstN: { input: '$$ROOT', n: perConversation } } } },
      { $unwind: '$docs' },
      { $replaceRoot: { newRoot: '$docs' } },
      { $sort: { conversation_id: 1, at: -1, _id: -1 } },
    ]);
    return docs.map((d) => line(this.#messages.fromDoc(d)));
  }

  /** Text messages of a seller's customer conversations in a period (statistics), oldest first */
  async sellerMessageLines(sellerId: string, from: Date, to: Date): Promise<MessageLine[]> {
    const ids = await this.#conversations.distinct<string>('id', { seller_id: sellerId, kind: 'order' });
    if (!ids.length) return [];
    const rows = await this.#messages.find({ conversation_id: { $in: ids }, kind: 'text', at: { $gte: from, $lt: to } }, { sort: { at: 1, id: 1 } });
    return rows.map(line);
  }

  /** Text messages of every seller's customer conversations in a period (or one seller's), oldest first, with the seller of each */
  async customerMessageLinesBySeller(from: Date, to: Date, sellerId?: string): Promise<(MessageLine & { seller_id: string })[]> {
    const rows = await this.#messages.find({ kind: 'text', at: { $gte: from, $lt: to } }, { sort: { at: 1, id: 1 } });
    const ids = [...new Set(rows.map((r) => r.conversation_id))];
    if (!ids.length) return [];
    const conversations = await this.#conversations.find({ id: { $in: ids }, kind: 'order', ...(sellerId ? { seller_id: sellerId } : { seller_id: { $ne: null } }) });
    const sellerOf = new Map(conversations.map((c) => [c.id, c.seller_id as string]));
    return rows.filter((r) => sellerOf.has(r.conversation_id)).map((r) => ({ ...line(r), seller_id: sellerOf.get(r.conversation_id)! }));
  }

  /** Report counts per conversation (any status) */
  async reportCounts(conversationIds: readonly string[]): Promise<Map<string, number>> {
    if (!conversationIds.length) return new Map();
    const rows = await this.#t('message_reports').aggregate<{ _id: string; n: number }>([
      { $match: { conversation_id: { $in: [...new Set(conversationIds)] } } },
      { $group: { _id: '$conversation_id', n: { $sum: 1 } } },
    ]);
    return new Map(rows.map((r) => [r._id, r.n]));
  }

  /* ---------------------------------------------------------------- jobs */

  dueAwaiting(now: Date, limit: number): Promise<ConversationRec[]> {
    return this.#conversations.find({ reply_state: 'awaiting_seller', reply_due_at: { $lte: now } }, { sort: { reply_due_at: 1 }, limit });
  }

  dueArchive(now: Date, limit: number): Promise<ConversationRec[]> {
    return this.#conversations.find({ status: 'open', archive_after: { $lte: now } }, { sort: { archive_after: 1 }, limit });
  }

  /** Writes a seller's rolled-up reply figures (one row per seller) */
  async upsertReplyStats(row: ReplyStatsRec): Promise<void> {
    await this.#t('seller_reply_stats').upsert(row);
  }

  /** Sellers whose reply figures were computed before this time, oldest first */
  async staleReplyStats(before: Date, limit: number): Promise<string[]> {
    const rows = await this.#t('seller_reply_stats').find({ computed_at: { $lt: before } }, { sort: { computed_at: 1 }, limit });
    return rows.map((r) => r.seller_id);
  }

  async sellersActiveSince(since: Date, limit: number): Promise<string[]> {
    const rows = await this.#conversations.aggregate<{ _id: string }>([
      { $match: { seller_id: { $ne: null }, last_message_at: { $gte: since } } },
      { $group: { _id: '$seller_id' } },
      { $limit: limit },
    ]);
    return rows.map((r) => r._id);
  }

  /** Awaiting and overdue counts, oldest waiting and unread conversations of a seller */
  async sellerInbox(sellerId: string): Promise<{ awaiting: number; overdue: number; oldestWaitingSince: Date | null; unreadConversations: number }> {
    const waiting = ['awaiting_seller', 'overdue'];
    const [agg] = await this.#conversations.aggregate<{ awaiting: number; overdue: number; oldest: Date | null }>([
      { $match: { seller_id: sellerId, kind: 'order' } },
      {
        $group: {
          _id: null,
          awaiting: { $sum: { $cond: [{ $eq: ['$reply_state', 'awaiting_seller'] }, 1, 0] } },
          overdue: { $sum: { $cond: [{ $eq: ['$reply_state', 'overdue'] }, 1, 0] } },
          oldest: { $min: { $cond: [{ $in: ['$reply_state', waiting] }, '$awaiting_since', null] } },
        },
      },
    ]);
    const unreadIds = await this.#conversationIdsOf('seller', [sellerId], true);
    const unreadConversations = unreadIds.length ? await this.#conversations.count({ id: { $in: unreadIds }, seller_id: sellerId }) : 0;
    return { awaiting: agg?.awaiting ?? 0, overdue: agg?.overdue ?? 0, oldestWaitingSince: agg?.oldest ? new Date(agg.oldest) : null, unreadConversations };
  }

  /* ---------------------------------------------------------------- reports */

  reportsPage(status: string | undefined, page: PageRequest): Promise<Page<ReportRec>> {
    return this.#t('message_reports').page(status ? { status } : {}, page, { column: 'created_at', direction: 'desc' });
  }

  /** Conversation ids a participant (kind, one of ids) belongs to, optionally with unread messages */
  async #conversationIdsOf(kind: string, ids: string[], unreadOnly = false): Promise<string[]> {
    return ids.length ? this.#participants.distinct<string>('conversation_id', { kind, participant_id: { $in: ids }, ...(unreadOnly ? { unread_count: { $gt: 0 } } : {}) }) : [];
  }
}
