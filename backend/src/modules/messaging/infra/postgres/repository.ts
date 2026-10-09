import { sql, type Kysely } from 'kysely';
import { paginate } from '../../../../kernel/lib/pagination.js';
import type { MessagingDb } from '../../../../spec/messaging.js';
import type { ConversationRec, InboxOwner, MessageLine, MessagingRepository } from '../../ports.js';

/** jsonb columns per table: values are sent as JSON text (pg would turn JS arrays into PG arrays) */
const JSON_COLUMNS: Record<string, readonly string[]> = {
  conversations: ['subject'],
  messages: ['media_ids', 'redactions'],
};

function encode(table: string, row: Record<string, unknown>): Record<string, unknown> {
  const cols = JSON_COLUMNS[table];
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v === undefined) continue;
    out[k] = cols?.includes(k) && v !== null ? JSON.stringify(v) : v;
  }
  return out;
}

const isOp = (v: unknown): v is { op: string; value: unknown } => typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date) && 'op' in v;

function applyWhere(q: any, where: Record<string, unknown>): any {
  for (const [k, v] of Object.entries(where)) {
    if (v === undefined) continue;
    if (v === null) q = q.where(k, 'is', null);
    else if (Array.isArray(v)) q = v.length ? q.where(k, 'in', v) : q.where(sql<boolean>`false`);
    else if (isOp(v)) q = q.where(k, v.op, v.value);
    else q = q.where(k, '=', v);
  }
  return q;
}

const like = (s: string) => `%${s.trim().toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** The participant row that stands for an inbox owner */
function ownerParticipant(owner: InboxOwner): { kind: string; ids: string[] } {
  if (owner.kind === 'seller') return { kind: 'seller', ids: [owner.sellerId] };
  if (owner.kind === 'staff') return { kind: 'staff', ids: [owner.staffId] };
  return { kind: 'customer', ids: [owner.customerId, owner.guestSessionId].filter((x): x is string => !!x) };
}

/** Postgres adapter for MessagingRepository. `db` is scoped to the `messaging` schema. */
export function createPostgresMessagingRepository(db: Kysely<MessagingDb>): MessagingRepository {
  // generic table access: the row types are checked at the MessagingRepository boundary
  const d: any = db;

  const repo: MessagingRepository = {
    async transaction(fn) {
      if (db.isTransaction) return fn(repo);
      return db.transaction().execute((trx) => fn(createPostgresMessagingRepository(trx)));
    },

    /* ---------------------------------------------------------------- generic */
    async get(table, id, o) {
      let q = d.selectFrom(table).selectAll().where('id', '=', id);
      if (o?.forUpdate) q = q.forUpdate();
      return q.executeTakeFirst();
    },
    async getMany(table, ids) {
      if (!ids.length) return [];
      return d.selectFrom(table).selectAll().where('id', 'in', [...new Set(ids)]).execute();
    },
    async find(table, where, o) {
      let q = applyWhere(d.selectFrom(table).selectAll(), where as Record<string, unknown>);
      for (const [c, dir] of o?.orderBy ?? []) q = q.orderBy(c, dir);
      if (o?.limit) q = q.limit(o.limit);
      if (o?.forUpdate) q = q.forUpdate();
      return q.execute();
    },
    async findOne(table, where, o) {
      return (await repo.find(table, where, { ...o, limit: 1 }))[0];
    },
    async count(table, where) {
      const r = await applyWhere(d.selectFrom(table).select(sql<number>`count(*)::int`.as('n')), where as Record<string, unknown>).executeTakeFirst();
      return (r as { n: number } | undefined)?.n ?? 0;
    },
    async insert(table, row) {
      return d.insertInto(table).values(encode(table, row as Record<string, unknown>)).returningAll().executeTakeFirstOrThrow();
    },
    async insertIgnore(table, row) {
      const r = await d
        .insertInto(table)
        .values(encode(table, row as Record<string, unknown>))
        .onConflict((oc: any) => oc.doNothing())
        .executeTakeFirst();
      return Number(r?.numInsertedOrUpdatedRows ?? 0) > 0;
    },
    async update(table, id, patch) {
      const values = encode(table, patch as Record<string, unknown>);
      if (!Object.keys(values).length) return (await repo.get(table, id))!;
      return d.updateTable(table).set(values).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
    },
    async updateWhere(table, where, patch) {
      const values = encode(table, patch as Record<string, unknown>);
      if (!Object.keys(values).length) return 0;
      const r = await applyWhere(d.updateTable(table).set(values), where as Record<string, unknown>).executeTakeFirst();
      return Number(r?.numUpdatedRows ?? 0);
    },
    async removeWhere(table, where) {
      const r = await applyWhere(d.deleteFrom(table), where as Record<string, unknown>).executeTakeFirst();
      return Number(r?.numDeletedRows ?? 0);
    },

    /* ---------------------------------------------------------------- conversations */
    async findByKey(key, o) {
      let q = d.selectFrom('conversations').selectAll();
      for (const [col, value] of Object.entries(key)) {
        if (value === undefined) continue;
        q = value === null ? q.where(col, 'is', null) : q.where(col, '=', value);
      }
      q = q.orderBy('created_at', 'asc').limit(1);
      if (o?.forUpdate) q = q.forUpdate();
      return q.executeTakeFirst();
    },

    async inbox(owner, f, page) {
      const me = ownerParticipant(owner);
      let inner = d.selectFrom('conversations as c').selectAll('c');
      if (owner.kind === 'customer') {
        if (!me.ids.length) return { items: [], nextCursor: null, total: 0 };
        inner = inner.where('c.kind', 'in', ['order', 'support']).where((eb: any) =>
          eb.or([...(owner.customerId ? [eb('c.customer_id', '=', owner.customerId)] : []), ...(owner.guestSessionId ? [eb('c.guest_session_id', '=', owner.guestSessionId)] : [])]),
        );
      } else if (owner.kind === 'seller') {
        inner = inner.where('c.seller_id', '=', owner.sellerId).where('c.kind', 'in', ['order', 'staff_seller']);
      } else {
        inner = inner.where(sql<boolean>`exists (select 1 from messaging.participants p where p.conversation_id = c.id and p.kind = 'staff' and p.participant_id = ${owner.staffId})`);
      }
      if (f.orderId) inner = inner.where('c.order_id', '=', f.orderId);
      if (f.replyState === 'awaiting_reply') inner = inner.where('c.reply_state', 'in', ['awaiting_seller', 'overdue']);
      else if (f.replyState) inner = inner.where('c.reply_state', '=', f.replyState);
      if (f.unreadOnly) {
        inner = inner.where(
          sql<boolean>`exists (select 1 from messaging.participants p where p.conversation_id = c.id and p.kind = ${me.kind} and p.participant_id in (${sql.join(me.ids)}) and p.unread_count > 0)`,
        );
      }
      if (f.q?.trim()) {
        const term = like(f.q);
        inner = inner.where(
          sql<boolean>`(lower(c.subject->>'title') like ${term} or lower(coalesce(c.subject->>'orderRef', '')) like ${term} or lower(coalesce(c.subject->>'returnRef', '')) like ${term}
            or exists (select 1 from messaging.participants p where p.conversation_id = c.id and lower(p.name) like ${term}))`,
        );
      }
      const epoch = sql`extract(epoch from c.last_message_at) * 1000`;
      const rank = f.overdueFirst ? sql`(case c.reply_state when 'overdue' then 3 when 'awaiting_seller' then 2 else 1 end) * 1e13 + ` : sql``;
      inner = inner.select(sql<number>`(${rank}${epoch})::float8`.as('sort_key'));
      const q = d.selectFrom(inner.as('x')).selectAll();
      const res = await paginate(q, page, { column: 'sort_key', direction: 'desc' });
      return { ...res, items: (res.items as (ConversationRec & { sort_key?: number })[]).map(({ sort_key: _s, ...c }) => c as ConversationRec) };
    },

    async adminSearch(f, page) {
      let q = d.selectFrom('conversations as c').selectAll('c');
      if (f.orderId) q = q.where('c.order_id', '=', f.orderId);
      if (f.customerId) q = q.where('c.customer_id', '=', f.customerId);
      if (f.sellerId) q = q.where('c.seller_id', '=', f.sellerId);
      if (f.caseId) q = q.where('c.case_id', '=', f.caseId);
      if (f.filter === 'overdue') q = q.where('c.reply_state', '=', 'overdue');
      if (f.filter === 'locked') q = q.where('c.status', '=', 'locked');
      if (f.filter === 'reported') q = q.where(sql<boolean>`exists (select 1 from messaging.message_reports r where r.conversation_id = c.id)`);
      return paginate(q, page, { column: 'c.last_message_at', direction: 'desc', id: 'c.id' });
    },

    async conversationsOf(kind, participantId) {
      return d
        .selectFrom('conversations as c')
        .innerJoin('participants as p', 'p.conversation_id', 'c.id')
        .selectAll('c')
        .where('p.kind', '=', kind)
        .where('p.participant_id', '=', participantId)
        .execute();
    },

    /* ---------------------------------------------------------------- participants */
    async participantsOf(ids) {
      if (!ids.length) return [];
      return d.selectFrom('participants').selectAll().where('conversation_id', 'in', [...new Set(ids)]).orderBy('joined_at', 'asc').orderBy('kind', 'asc').execute();
    },
    async bumpUnread(conversationId, except) {
      let q = d.updateTable('participants').set({ unread_count: sql`unread_count + 1` }).where('conversation_id', '=', conversationId);
      if (except) q = q.where(sql<boolean>`not (kind = ${except.kind} and participant_id = ${except.id})`);
      await q.execute();
    },
    async countUnreadAfter(conversationId, after, me) {
      let q = d
        .selectFrom('messages')
        .select(sql<number>`count(*)::int`.as('n'))
        .where('conversation_id', '=', conversationId)
        .where(sql<boolean>`not (coalesce(author_kind, '') = ${me.kind} and coalesce(author_id, '') = ${me.id})`);
      if (after) q = q.where(sql<boolean>`(at, id) > (${after.at}, ${after.id})`);
      const r = await q.executeTakeFirst();
      return (r as { n: number } | undefined)?.n ?? 0;
    },

    /* ---------------------------------------------------------------- messages */
    async messagesPage(conversationId, page) {
      return paginate(d.selectFrom('messages').selectAll().where('conversation_id', '=', conversationId), page, { column: 'at', direction: 'desc' });
    },
    async recentMessages(ids, per) {
      if (!ids.length) return [];
      const rows = await sql<MessageLine & { rn: number }>`
        select * from (
          select conversation_id, id, kind, author_kind, author_id, author_label, body, hidden, at,
                 row_number() over (partition by conversation_id order by at desc, id desc) as rn
          from messaging.messages where conversation_id in (${sql.join([...new Set(ids)])})
        ) t where rn <= ${per} order by conversation_id, at desc, id desc`.execute(db);
      return rows.rows.map(({ rn: _rn, ...m }) => ({ ...m, at: new Date(m.at) }));
    },
    async sellerMessageLines(sellerId, from, to) {
      const rows = await d
        .selectFrom('messages as m')
        .innerJoin('conversations as c', 'c.id', 'm.conversation_id')
        .select(['m.conversation_id', 'm.id', 'm.kind', 'm.author_kind', 'm.author_id', 'm.author_label', 'm.body', 'm.hidden', 'm.at'])
        .where('c.seller_id', '=', sellerId)
        .where('c.kind', '=', 'order')
        .where('m.kind', '=', 'text')
        .where('m.at', '>=', from)
        .where('m.at', '<', to)
        .orderBy('m.at', 'asc')
        .orderBy('m.id', 'asc')
        .execute();
      return rows as MessageLine[];
    },
    async reportCounts(ids) {
      if (!ids.length) return new Map();
      const rows = await d
        .selectFrom('message_reports')
        .select(['conversation_id', sql<number>`count(*)::int`.as('n')])
        .where('conversation_id', 'in', [...new Set(ids)])
        .groupBy('conversation_id')
        .execute();
      return new Map((rows as { conversation_id: string; n: number }[]).map((r) => [r.conversation_id, r.n]));
    },

    /* ---------------------------------------------------------------- jobs */
    async dueAwaiting(now, limit) {
      return d.selectFrom('conversations').selectAll().where('reply_state', '=', 'awaiting_seller').where('reply_due_at', '<=', now).orderBy('reply_due_at', 'asc').limit(limit).execute();
    },
    async dueArchive(now, limit) {
      return d.selectFrom('conversations').selectAll().where('status', '=', 'open').where('archive_after', '<=', now).orderBy('archive_after', 'asc').limit(limit).execute();
    },
    async sellersActiveSince(since, limit) {
      const rows = await d.selectFrom('conversations').select('seller_id').distinct().where('seller_id', 'is not', null).where('last_message_at', '>=', since).limit(limit).execute();
      return (rows as { seller_id: string }[]).map((r) => r.seller_id);
    },
    async sellerInbox(sellerId) {
      const agg = (await d
        .selectFrom('conversations')
        .select([
          sql<number>`count(*) filter (where reply_state = 'awaiting_seller')::int`.as('awaiting'),
          sql<number>`count(*) filter (where reply_state = 'overdue')::int`.as('overdue'),
          sql<Date | null>`min(awaiting_since) filter (where reply_state in ('awaiting_seller', 'overdue'))`.as('oldest'),
        ])
        .where('seller_id', '=', sellerId)
        .where('kind', '=', 'order')
        .executeTakeFirst()) as { awaiting: number; overdue: number; oldest: Date | string | null };
      const unread = (await d
        .selectFrom('participants as p')
        .innerJoin('conversations as c', 'c.id', 'p.conversation_id')
        .select(sql<number>`count(*)::int`.as('n'))
        .where('c.seller_id', '=', sellerId)
        .where('p.kind', '=', 'seller')
        .where('p.participant_id', '=', sellerId)
        .where('p.unread_count', '>', 0)
        .executeTakeFirst()) as { n: number };
      return { awaiting: agg.awaiting, overdue: agg.overdue, oldestWaitingSince: agg.oldest ? new Date(agg.oldest) : null, unreadConversations: unread.n };
    },

    /* ---------------------------------------------------------------- reports */
    async reportsPage(status, page) {
      let q = d.selectFrom('message_reports').selectAll();
      if (status) q = q.where('status', '=', status);
      return paginate(q, page, { column: 'created_at', direction: 'desc' });
    },
  };
  return repo;
}
