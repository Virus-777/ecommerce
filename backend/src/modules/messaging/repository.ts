import type { ModuleStore } from '../../kernel/mongo/index.js';
import type { Filter, Sort, Table as MongoTable } from '../../kernel/mongo/table.js';
import { decodeCursor, encodeCursor, type PageRequest } from '../../kernel/lib/pagination.js';
import { OFFICIAL_STORE_ID, type Page } from '../../spec/common.js';
import type { ConversationRec, Db, InboxOwner, MessageLine, MessagingRepository, Table } from './ports.js';

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** ILIKE '%term%' */
const contains = (term: string) => ({ $regex: escapeRegExp(term.trim()), $options: 'i' });

const isOp = (v: unknown): v is { op: string; value: unknown } => typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date) && 'op' in v;

/** A column condition (ports Cond) as a MongoDB condition, with SQL's meaning (`<>` skips nulls) */
function cond(v: unknown): unknown {
  if (v === null) return null;
  if (Array.isArray(v)) return { $in: v };
  if (isOp(v)) {
    switch (v.op) {
      case '<':
        return { $lt: v.value };
      case '<=':
        return { $lte: v.value };
      case '>':
        return { $gt: v.value };
      case '>=':
        return { $gte: v.value };
      case '<>':
        return { $nin: [v.value, null] };
      case 'is not':
        return { $ne: v.value };
      default:
        throw new Error(`messaging: unknown operator ${v.op}`);
    }
  }
  return v;
}

function where(w: Record<string, unknown>): Filter {
  const out: Filter = {};
  for (const [k, v] of Object.entries(w)) if (v !== undefined) out[k] = cond(v);
  return out;
}

const sortOf = (orderBy: [string, 'asc' | 'desc'][] | undefined): Sort | undefined =>
  orderBy?.length ? Object.fromEntries(orderBy.map(([c, d]) => [c, d === 'desc' ? -1 : 1])) : undefined;

const defined = (patch: Record<string, unknown>) => Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));

/** The participant row that stands for an inbox owner */
function ownerParticipant(owner: InboxOwner): { kind: string; ids: string[] } {
  if (owner.kind === 'seller') return { kind: 'seller', ids: [owner.sellerId] };
  if (owner.kind === 'staff') return { kind: 'staff', ids: [owner.staffId] };
  return { kind: 'customer', ids: [owner.customerId, owner.guestSessionId].filter((x): x is string => !!x) };
}

const PARTICIPANTS = 'messaging.participants';

/** MongoDB adapter for MessagingRepository (docs/04-mongodb-migration.md): one collection per spec table. */
export function createMongoMessagingRepository(store: ModuleStore): MessagingRepository {
  const t = <T extends Table>(name: T) => store.table<Db[T]>(name) as MongoTable<Db[T]>;
  const conversations = t('conversations');
  const participants = t('participants');
  const messages = t('messages');

  /** Conversation ids a participant (kind, one of ids) belongs to, optionally with unread messages */
  const conversationIdsOf = async (kind: string, ids: string[], unreadOnly = false) =>
    ids.length ? participants.distinct<string>('conversation_id', { kind, participant_id: { $in: ids }, ...(unreadOnly ? { unread_count: { $gt: 0 } } : {}) }) : [];

  /**
   * A page of conversations matching a raw (document) pipeline, ordered by a computed sort_key desc and _id desc
   * (keyset cursor on both, as kernel paginate does for a computed column).
   */
  async function pageBySortKey(stages: object[], req: PageRequest): Promise<Page<ConversationRec>> {
    const sort = { $sort: { sort_key: -1, _id: -1 } };
    const toRow = (d: Record<string, unknown>) => {
      const { sort_key: _s, ...doc } = d;
      return conversations.fromDoc(doc);
    };
    const cursorOf = (d: Record<string, unknown>) => encodeCursor([d.sort_key, d._id]);
    if (req.mode === 'page') {
      const [r] = await conversations.aggregate<{ total: { n: number }[]; items: Record<string, unknown>[] }>([
        ...stages,
        { $facet: { total: [{ $count: 'n' }], items: [sort, { $skip: (req.page - 1) * req.limit }, { $limit: req.limit }] } },
      ]);
      const total = r?.total[0]?.n ?? 0;
      const items = r?.items ?? [];
      const totalPages = Math.max(1, Math.ceil(total / req.limit));
      const last = items.at(-1);
      return { items: items.map(toRow), nextCursor: req.page < totalPages && last ? cursorOf(last) : null, page: req.page, totalPages, total };
    }
    const after: object[] = [];
    if (req.cursor) {
      const [v, id] = decodeCursor(req.cursor);
      after.push({ $match: { $or: [{ sort_key: { $lt: Number(v) } }, { sort_key: Number(v), _id: { $lt: id } }] } });
    }
    const rows = await conversations.aggregate<Record<string, unknown>>([...stages, ...after, sort, { $limit: req.limit + 1 }]);
    const items = rows.slice(0, req.limit);
    return { items: items.map(toRow), nextCursor: rows.length > req.limit ? cursorOf(items.at(-1)!) : null };
  }

  /** insertIgnore: the unique key a row may conflict on (on conflict do nothing) */
  const conflictKey = (table: Table, row: Record<string, unknown>): string[] | undefined => {
    if (table === 'participants') return ['conversation_id', 'kind', 'participant_id'];
    if (table === 'messages' && row.author_id != null && row.client_message_id != null) return ['conversation_id', 'author_id', 'client_message_id'];
    return undefined; // the primary key
  };

  const repo: MessagingRepository = {
    transaction: (fn) => store.transaction((tx) => fn(createMongoMessagingRepository(tx))),
    claim: (key) => store.claim(key),
    async aliasOf(id) {
      return (await t('conversation_aliases').get(id))?.conversation_id;
    },

    /* ---------------------------------------------------------------- generic */
    get: (table, id, o) => t(table).get(id, o),
    getMany: (table, ids) => t(table).getMany([...new Set(ids)]),
    find: (table, w, o) => t(table).find(where(w as Record<string, unknown>), { sort: sortOf(o?.orderBy), limit: o?.limit, forUpdate: o?.forUpdate }),
    findOne: (table, w, o) => t(table).findOne(where(w as Record<string, unknown>), { sort: sortOf(o?.orderBy), forUpdate: o?.forUpdate }),
    count: (table, w) => t(table).count(where(w as Record<string, unknown>)),
    insert: (table, row) => t(table).insert(row),
    async insertIgnore(table, row) {
      const key = conflictKey(table, row as Record<string, unknown>);
      return Boolean(await t(table).insertIfAbsent(row, key));
    },
    async update(table, id, patch) {
      const values = defined(patch as Record<string, unknown>);
      const row = Object.keys(values).length ? await t(table).update(id, values) : await t(table).get(id);
      if (!row) throw new Error(`messaging: ${table} ${id} not found`);
      return row;
    },
    async updateWhere(table, w, patch) {
      const values = defined(patch as Record<string, unknown>);
      if (!Object.keys(values).length) return 0;
      return t(table).updateMany(where(w as Record<string, unknown>), values);
    },
    removeWhere: (table, w) => t(table).deleteMany(where(w as Record<string, unknown>)),

    /* ---------------------------------------------------------------- conversations */
    findByKey(key, o) {
      const f: Filter = {};
      for (const [col, value] of Object.entries(key)) if (value !== undefined) f[col] = value;
      return conversations.findOne(f, { sort: { created_at: 1 }, forUpdate: o?.forUpdate });
    },

    async inbox(owner, f, page) {
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
        if (owner.customerId) or.push({ kind: 'staff_seller', application_id: { $ne: null }, id: { $in: await conversationIdsOf('customer', [owner.customerId]) } });
        and.push({ $or: or });
      } else if (owner.kind === 'seller') {
        and.push({ seller_id: owner.sellerId, kind: { $in: ['order', 'staff_seller'] } });
      } else {
        and.push({ id: { $in: await conversationIdsOf('staff', [owner.staffId]) } });
      }
      if (f.orderId) and.push({ order_id: f.orderId });
      if (f.replyState === 'awaiting_reply') and.push({ reply_state: { $in: ['awaiting_seller', 'overdue'] } });
      else if (f.replyState) and.push({ reply_state: f.replyState });
      const guestUnread = Boolean(f.unreadOnly) && owner.kind === 'customer' && !owner.customerId;
      if (f.unreadOnly && !guestUnread) and.push({ id: { $in: await conversationIdsOf(me.kind, me.ids, true) } });

      const stages: object[] = [{ $match: conversations.filter({ $and: and }) }];
      if (guestUnread) {
        // the order's guest participant (order:<order_id>) has unread messages
        stages.push(
          {
            $lookup: {
              from: PARTICIPANTS,
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
          { $lookup: { from: PARTICIPANTS, localField: '_id', foreignField: 'conversation_id', pipeline: [{ $match: { name: term } }, { $limit: 1 }], as: '_named' } },
          { $match: { $or: [{ 'subject.title': term }, { 'subject.orderRef': term }, { 'subject.returnRef': term }, { '_named.0': { $exists: true } }] } },
          { $unset: '_named' },
        );
      }
      // seller inbox: overdue first, then awaiting, then the rest; newest message first within each
      const epoch = { $toLong: '$last_message_at' };
      const rank = { $switch: { branches: [{ case: { $eq: ['$reply_state', 'overdue'] }, then: 3 }, { case: { $eq: ['$reply_state', 'awaiting_seller'] }, then: 2 }], default: 1 } };
      stages.push({ $addFields: { sort_key: { $toDouble: f.overdueFirst ? { $add: [{ $multiply: [rank, 1e13] }, epoch] } : epoch } } });
      return pageBySortKey(stages, page);
    },

    async adminSearch(f, page) {
      const and: Filter[] = [];
      if (f.orderId) and.push({ order_id: f.orderId });
      if (f.customerId) and.push({ customer_id: f.customerId });
      if (f.sellerId) and.push({ seller_id: f.sellerId });
      if (f.caseId) and.push({ case_id: f.caseId });
      if (f.filter === 'overdue') and.push({ reply_state: 'overdue' });
      if (f.filter === 'locked') and.push({ status: 'locked' });
      if (f.filter === 'reported') and.push({ id: { $in: await t('message_reports').distinct<string>('conversation_id') } });
      if (f.filter === 'official_awaiting') {
        // Official Store conversations waiting for a staff reply, oldest due first
        and.push({ kind: 'order', seller_id: OFFICIAL_STORE_ID, reply_state: { $in: ['awaiting_seller', 'overdue'] }, reply_due_at: { $ne: null } });
        return conversations.page({ $and: and }, page, { column: 'reply_due_at', direction: 'asc' });
      }
      return conversations.page(and.length ? { $and: and } : {}, page, { column: 'last_message_at', direction: 'desc' });
    },

    async conversationsOf(kind, participantId) {
      return conversations.getMany(await conversationIdsOf(kind, [participantId]));
    },

    /* ---------------------------------------------------------------- participants */
    participantsOf: async (ids) => (ids.length ? participants.find({ conversation_id: { $in: [...new Set(ids)] } }, { sort: { joined_at: 1, kind: 1 } }) : []),
    async bumpUnread(conversationId, except) {
      await participants.updateMany({ conversation_id: conversationId, ...(except ? { $nor: [{ kind: except.kind, participant_id: except.id }] } : {}) }, { $inc: { unread_count: 1 } });
    },
    countUnreadAfter(conversationId, after, me) {
      return messages.count({
        conversation_id: conversationId,
        // not written by me (an author-less system note counts)
        $nor: [{ author_kind: me.kind, author_id: me.id }],
        ...(after ? { $or: [{ at: { $gt: after.at } }, { at: after.at, id: { $gt: after.id } }] } : {}),
      });
    },

    /* ---------------------------------------------------------------- messages */
    messagesPage: (conversationId, page) => messages.page({ conversation_id: conversationId }, page, { column: 'at', direction: 'desc' }),
    async recentMessages(ids, per) {
      if (!ids.length) return [];
      const docs = await messages.aggregate<Record<string, unknown>>([
        { $match: { conversation_id: { $in: [...new Set(ids)] } } },
        // row_number() over (partition by conversation_id order by at desc, id desc) <= per
        { $sort: { conversation_id: 1, at: -1, _id: -1 } },
        { $group: { _id: '$conversation_id', docs: { $firstN: { input: '$$ROOT', n: per } } } },
        { $unwind: '$docs' },
        { $replaceRoot: { newRoot: '$docs' } },
        { $sort: { conversation_id: 1, at: -1, _id: -1 } },
      ]);
      return docs.map((d) => line(messages.fromDoc(d)));
    },
    async sellerMessageLines(sellerId, from, to) {
      const ids = await conversations.distinct<string>('id', { seller_id: sellerId, kind: 'order' });
      if (!ids.length) return [];
      const rows = await messages.find({ conversation_id: { $in: ids }, kind: 'text', at: { $gte: from, $lt: to } }, { sort: { at: 1, id: 1 } });
      return rows.map(line);
    },
    async reportCounts(ids) {
      if (!ids.length) return new Map();
      const rows = await t('message_reports').aggregate<{ _id: string; n: number }>([
        { $match: { conversation_id: { $in: [...new Set(ids)] } } },
        { $group: { _id: '$conversation_id', n: { $sum: 1 } } },
      ]);
      return new Map(rows.map((r) => [r._id, r.n]));
    },

    /* ---------------------------------------------------------------- jobs */
    dueAwaiting: (now, limit) => conversations.find({ reply_state: 'awaiting_seller', reply_due_at: { $lte: now } }, { sort: { reply_due_at: 1 }, limit }),
    dueArchive: (now, limit) => conversations.find({ status: 'open', archive_after: { $lte: now } }, { sort: { archive_after: 1 }, limit }),
    async upsertReplyStats(row) {
      await t('seller_reply_stats').upsert(row);
    },
    async staleReplyStats(before, limit) {
      const rows = await t('seller_reply_stats').find({ computed_at: { $lt: before } }, { sort: { computed_at: 1 }, limit });
      return rows.map((r) => r.seller_id);
    },
    async sellersActiveSince(since, limit) {
      const rows = await conversations.aggregate<{ _id: string }>([
        { $match: { seller_id: { $ne: null }, last_message_at: { $gte: since } } },
        { $group: { _id: '$seller_id' } },
        { $limit: limit },
      ]);
      return rows.map((r) => r._id);
    },
    async sellerInbox(sellerId) {
      const waiting = ['awaiting_seller', 'overdue'];
      const [agg] = await conversations.aggregate<{ awaiting: number; overdue: number; oldest: Date | null }>([
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
      const unreadIds = await conversationIdsOf('seller', [sellerId], true);
      const unreadConversations = unreadIds.length ? await conversations.count({ id: { $in: unreadIds }, seller_id: sellerId }) : 0;
      return { awaiting: agg?.awaiting ?? 0, overdue: agg?.overdue ?? 0, oldestWaitingSince: agg?.oldest ? new Date(agg.oldest) : null, unreadConversations };
    },

    /* ---------------------------------------------------------------- reports */
    reportsPage: (status, page) => t('message_reports').page(status ? { status } : {}, page, { column: 'created_at', direction: 'desc' }),
  };
  return repo;
}

/** A message row as a message line */
function line(m: Db['messages']): MessageLine {
  return { conversation_id: m.conversation_id, id: m.id, kind: m.kind, author_kind: m.author_kind, author_id: m.author_id, author_label: m.author_label, body: m.body, hidden: m.hidden, at: m.at };
}
