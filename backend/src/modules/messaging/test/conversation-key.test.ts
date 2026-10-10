/**
 * The conversation key is `unique nulls not distinct (kind, customer_id, seller_id, application_id, order_id,
 * order_item_id, return_id, case_id)` (migration 0003), and 0003 folds rows that already share a key into the oldest.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { buildTestApp } from '../../../testing/app.js';
import { m0003ConversationKeyNullsNotDistinct } from '../infra/postgres/migrations/0003_conversation_key_nulls_not_distinct.js';

let app: FastifyInstance;
beforeAll(async () => {
  app = await buildTestApp({ only: ['messaging'] });
});
afterAll(async () => {
  await app?.close();
});

const db = () => app.kernel.database.kysely.withSchema('messaging') as any;
const at = (minutes: number) => new Date(Date.UTC(2026, 9, 1, 12, minutes));

function conversation(over: Record<string, unknown>) {
  return {
    id: newId(),
    kind: 'staff_seller',
    customer_id: null,
    guest_session_id: null,
    seller_id: null,
    order_id: null,
    order_item_id: null,
    return_id: null,
    case_id: null,
    application_id: null,
    started_by_staff_id: null,
    subject: JSON.stringify({ kind: 'seller_account', title: 'Account' }),
    status: 'open',
    locked_reason: null,
    reply_state: 'none',
    reply_due_at: null,
    awaiting_since: null,
    created_at: at(0),
    last_message_at: at(0),
    archive_after: null,
    ...over,
  };
}
const participant = (conversationId: string, kind: string, id: string, unread: number) => ({
  conversation_id: conversationId,
  kind,
  participant_id: id,
  name: id,
  label: kind,
  joined_at: at(0),
  joined_from_case_id: null,
  last_read_message_id: null,
  unread_count: unread,
});
const message = (conversationId: string, minute: number, clientId: string | null, authorId = 'staff-1') => ({
  id: newId(),
  conversation_id: conversationId,
  kind: 'text',
  author_kind: 'staff',
  author_id: authorId,
  author_label: 'Marketly Support',
  body: `at ${minute}`,
  original_body: null,
  media_ids: JSON.stringify([]),
  redactions: JSON.stringify([]),
  hidden: false,
  hidden_reason: null,
  client_message_id: clientId,
  at: at(minute),
});

describe('conversation key', () => {
  it('refuses a second conversation with the same key, null key columns included', async () => {
    const sellerId = newId();
    await db().insertInto('conversations').values(conversation({ seller_id: sellerId })).execute();
    const err = await db()
      .insertInto('conversations')
      .values(conversation({ seller_id: sellerId }))
      .execute()
      .catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe('23505');
    // another kind or application is another conversation
    await db().insertInto('conversations').values(conversation({ seller_id: sellerId, application_id: newId() })).execute();
    // pass 3: the case is a link, not part of the key, except for support conversations
    const sameWithCase = await db()
      .insertInto('conversations')
      .values(conversation({ seller_id: sellerId, case_id: newId() }))
      .execute()
      .catch((e: unknown) => e);
    expect((sameWithCase as { code?: string }).code).toBe('23505');
    const customerId = newId();
    const orderId = newId();
    await db().insertInto('conversations').values(conversation({ kind: 'support', customer_id: customerId, order_id: orderId, case_id: newId() })).execute();
    await db().insertInto('conversations').values(conversation({ kind: 'support', customer_id: customerId, order_id: orderId, case_id: newId() })).execute();
  });

  it('migration 0003 folds existing duplicates into the oldest conversation of their key', async () => {
    const k = app.kernel.database;
    // the state before 0003: the old five-column index, where null columns never collide
    await k.exec(`drop index messaging.conversations_key_idx;
create unique index conversations_old_key_idx on messaging.conversations (customer_id, seller_id, order_id, order_item_id, return_id);`);
    const sellerId = newId();
    const keeper = conversation({ seller_id: sellerId, created_at: at(1), last_message_at: at(2) });
    const dupA = conversation({ seller_id: sellerId, created_at: at(3), last_message_at: at(9) });
    const dupB = conversation({ seller_id: sellerId, created_at: at(4), last_message_at: at(5) });
    await db().insertInto('conversations').values([keeper, dupA, dupB]).execute();
    await db()
      .insertInto('participants')
      .values([
        participant(keeper.id, 'seller', sellerId, 1),
        participant(dupA.id, 'seller', sellerId, 2),
        participant(dupB.id, 'seller', sellerId, 3),
        participant(dupA.id, 'staff', 'staff-2', 4),
      ])
      .execute();
    const kept = message(keeper.id, 2, 'c-1');
    const moved = message(dupA.id, 9, 'c-1'); // same author and client id as a keeper message
    const plain = message(dupB.id, 5, 'c-2');
    await db().insertInto('messages').values([kept, moved, plain]).execute();
    const logId = newId();
    await db().insertInto('staff_access_log').values({ id: logId, conversation_id: dupB.id, staff_id: newId(), reason: 'Review', case_id: null, at: at(6) }).execute();

    await k.exec(`begin;\n${m0003ConversationKeyNullsNotDistinct.sql}\ncommit;`);

    const rows = await db().selectFrom('conversations').select(['id', 'last_message_at']).where('seller_id', '=', sellerId).execute();
    expect(rows.map((r: any) => r.id)).toEqual([keeper.id]);
    expect(new Date(rows[0].last_message_at).toISOString()).toBe(at(9).toISOString());
    const parts = await db().selectFrom('participants').select(['conversation_id', 'kind', 'participant_id', 'unread_count']).where('conversation_id', 'in', [keeper.id, dupA.id, dupB.id]).orderBy('kind').execute();
    expect(parts).toEqual([
      { conversation_id: keeper.id, kind: 'seller', participant_id: sellerId, unread_count: 6 },
      { conversation_id: keeper.id, kind: 'staff', participant_id: 'staff-2', unread_count: 4 },
    ]);
    const msgs = await db().selectFrom('messages').select(['id', 'conversation_id', 'client_message_id']).where('id', 'in', [kept.id, moved.id, plain.id]).execute();
    const byId = new Map(msgs.map((m: any) => [m.id, m]));
    expect(msgs.every((m: any) => m.conversation_id === keeper.id)).toBe(true);
    expect(byId.get(kept.id)).toMatchObject({ client_message_id: 'c-1' });
    expect(byId.get(moved.id)).toMatchObject({ client_message_id: null });
    expect(byId.get(plain.id)).toMatchObject({ client_message_id: 'c-2' });
    const log = await db().selectFrom('staff_access_log').select('conversation_id').where('id', '=', logId).execute();
    expect(log).toEqual([{ conversation_id: keeper.id }]);

    // the old index is gone and the new one refuses a duplicate
    const indexes = await app.kernel.database.kysely
      .selectFrom('pg_indexes')
      .select('indexname')
      .where('schemaname', '=', 'messaging')
      .where('tablename', '=', 'conversations')
      .execute();
    expect(indexes.map((i: any) => i.indexname)).toContain('conversations_key_idx');
    expect(indexes.map((i: any) => i.indexname)).not.toContain('conversations_old_key_idx');
    const err = await db()
      .insertInto('conversations')
      .values(conversation({ seller_id: sellerId }))
      .execute()
      .catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe('23505');
  });

  it('migration 0004 keys guests by order, merges case duplicates with aliases and recomputes reply state and unread', async () => {
    const k = app.kernel.database;
    // the state before 0004 (the 0003 test above left the 0003 key in place)
    await k.exec(`alter table messaging.conversations drop column if exists locked_by_enforcement_id; drop table if exists messaging.conversation_aliases;`);
    const sellerId = newId();
    const customerId = newId();
    const orderId = newId();
    // the same order conversation twice, once linked to a case (the old key kept case_id)
    const keeper = conversation({ kind: 'order', customer_id: customerId, seller_id: sellerId, order_id: orderId, created_at: at(1), last_message_at: at(2), reply_state: 'replied' });
    const dup = conversation({ kind: 'order', customer_id: customerId, seller_id: sellerId, order_id: orderId, case_id: newId(), created_at: at(3), last_message_at: at(8), reply_state: 'awaiting_seller', awaiting_since: at(8), reply_due_at: at(8 + 60 * 24 * 365 * 10) });
    await db().insertInto('conversations').values([keeper, dup]).execute();
    await db().insertInto('participants').values([participant(keeper.id, 'customer', customerId, 0), participant(keeper.id, 'seller', sellerId, 0), participant(dup.id, 'seller', sellerId, 0)]).execute();
    const custMsg = (cid: string, minute: number) => ({ ...message(cid, minute, null, customerId), author_kind: 'customer' });
    const sellerMsg = (cid: string, minute: number) => ({ ...message(cid, minute, null, sellerId), author_kind: 'seller' });
    await db().insertInto('messages').values([custMsg(keeper.id, 1), sellerMsg(keeper.id, 2), custMsg(dup.id, 8)]).execute();
    // a guest conversation written before D-M2: the participant and messages are the session
    const guestOrder = newId();
    const guestConv = conversation({ kind: 'order', seller_id: sellerId, order_id: guestOrder, guest_session_id: 'sess-1', created_at: at(1) });
    await db().insertInto('conversations').values(guestConv).execute();
    await db().insertInto('participants').values([{ ...participant(guestConv.id, 'customer', 'sess-1', 0), name: 'Ana' }]).execute();
    await db().insertInto('messages').values([{ ...message(guestConv.id, 1, 'g-1', 'sess-1'), author_kind: 'customer' }]).execute();

    const { m0004Pass3KeysGuestsAliases } = await import('../infra/postgres/migrations/0004_pass3_keys_guests_aliases.js');
    await k.exec(`begin;\n${m0004Pass3KeysGuestsAliases.sql}\ncommit;`);

    const kept = await db().selectFrom('conversations').selectAll().where('order_id', '=', orderId).execute();
    expect(kept.map((r: any) => r.id)).toEqual([keeper.id]);
    // the case moved to the kept row as a link; the reply state follows the merged messages
    expect(kept[0]).toMatchObject({ case_id: dup.case_id, reply_state: 'awaiting_seller' });
    expect(new Date(kept[0].awaiting_since).toISOString()).toBe(at(8).toISOString());
    expect(await db().selectFrom('conversation_aliases').select(['old_id', 'conversation_id']).execute()).toEqual([{ old_id: dup.id, conversation_id: keeper.id }]);
    const seller = await db().selectFrom('participants').selectAll().where('conversation_id', '=', keeper.id).where('kind', '=', 'seller').executeTakeFirst();
    expect(seller.unread_count).toBe(2);
    const guestParts = await db().selectFrom('participants').select(['kind', 'participant_id', 'name']).where('conversation_id', '=', guestConv.id).execute();
    expect(guestParts).toEqual([{ kind: 'guest', participant_id: `order:${guestOrder}`, name: 'Ana' }]);
    const guestMsgs = await db().selectFrom('messages').select(['author_kind', 'author_id']).where('conversation_id', '=', guestConv.id).execute();
    expect(guestMsgs).toEqual([{ author_kind: 'guest', author_id: `order:${guestOrder}` }]);
    const indexes = (await k.kysely.selectFrom('pg_indexes').select('indexname').where('schemaname', '=', 'messaging').where('tablename', '=', 'conversations').execute()).map((i: any) => i.indexname);
    expect(indexes).toEqual(expect.arrayContaining(['conversations_key_idx', 'conversations_support_key_idx']));
  });
});
