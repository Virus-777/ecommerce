import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { resolvers } from '../graphql/resolvers.js';
import { ADMIN, harness, placeOrder, SELLER, STORE, tokens, type Harness, type Placed } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h.app.close();
});

const DAY = 86_400_000;

async function thread(o: Placed, body = 'Hello') {
  const res = await h.call('POST', `${STORE}/conversations`, tokens.customer(o.customerId!), { with: 'seller', orderId: o.order.id, sellerId: o.sellerA, body });
  expect(res.status).toBe(201);
  return res.body.conversation.id as string;
}

describe('events consumed', () => {
  it('support.case.opened adds Marketly Support with a system note, once', async () => {
    const o = await placeOrder(h);
    const id = await thread(o);
    const other = await h.call('POST', `${STORE}/conversations`, tokens.customer(o.customerId!), { with: 'seller', orderId: o.order.id, sellerId: o.sellerB, body: 'Hi B' });
    const caseId = newId();
    const event = { caseId, ref: 'CS-261009-3381', kind: 'order_problem', category: 'damaged', priority: 'normal', customerId: o.customerId, sellerId: o.sellerA, orderId: o.order.id, orderItemIds: [o.itemA], handler: 'seller' };
    await h.publish('support', 'support.case.opened', event);
    await h.publish('support', 'support.case.opened', event);
    const msgs = await h.call('GET', `${STORE}/conversations/${id}/messages`, tokens.customer(o.customerId!));
    expect(msgs.body.items.filter((m: any) => m.kind === 'system').map((m: any) => m.body)).toEqual(['Marketly Support joined from case CS-261009-3381']);
    const header = await h.call('GET', `${SELLER}/conversations/${id}`, tokens.seller(o.sellerA));
    expect(header.body.participants).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'staff', label: 'Marketly Support', joinedFromCaseId: caseId })]));
    // the other seller's conversation is not about this case
    const otherMsgs = await h.call('GET', `${STORE}/conversations/${other.body.conversation.id}/messages`, tokens.customer(o.customerId!));
    expect(otherMsgs.body.items.some((m: any) => m.kind === 'system')).toBe(false);
    // unknown orders are ignored
    await h.publish('support', 'support.case.opened', { ...event, caseId: newId(), orderId: newId() });
    await h.publish('support', 'support.case.opened', { ...event, caseId: newId(), orderId: null });
  });

  it('orders.order.completed schedules archiving; the archive job archives; a new message about the subject reopens it', async () => {
    const o = await placeOrder(h);
    const id = await thread(o);
    await h.publish('orders', 'orders.order.completed', { orderId: o.order.id, ref: o.order.ref, completedAt: h.clock.now().toISOString() });
    await h.publish('orders', 'orders.order.completed', { orderId: newId(), ref: 'MK-0', completedAt: h.clock.now().toISOString() });
    await h.runJob('messaging.archive');
    const customer = tokens.customer(o.customerId!);
    expect((await h.call('GET', `${STORE}/conversations/${id}`, customer)).body.status).toBe('open');
    h.clock.advance(181 * DAY);
    await h.runJob('messaging.archive');
    const later = tokens.customer(o.customerId!);
    expect((await h.call('GET', `${STORE}/conversations/${id}`, later)).body).toMatchObject({ status: 'archived', canSend: false });
    const send = await h.call('POST', `${STORE}/conversations/${id}/messages`, later, { body: 'Still there?' });
    expect(send.status).toBe(409);
    expect(send.body.error.details.reason).toBe('archived');
    const again = await h.call('POST', `${STORE}/conversations`, later, { with: 'seller', orderId: o.order.id, sellerId: o.sellerA, body: 'The duvet tore again' });
    expect(again.status).toBe(201);
    expect(again.body.conversation).toMatchObject({ id, status: 'open' });
  });

  it('trust.enforcement.recorded locks the conversations it names', async () => {
    const o = await placeOrder(h);
    const id = await thread(o);
    const msg = await h.call('POST', `${SELLER}/conversations/${id}/messages`, tokens.seller(o.sellerA), { body: 'reply' });
    const id2 = await (async () => {
      const r = await h.call('POST', `${STORE}/conversations`, tokens.customer(o.customerId!), { with: 'seller', orderId: o.order.id, sellerId: o.sellerB, body: 'Hi B' });
      return r.body.conversation.id as string;
    })();
    const base = { enforcementId: newId(), reportId: newId(), ownerTeam: 'messaging', reason: 'Harassment', params: {}, appealDeadline: null, alreadyApplied: false };
    await h.publish('trust', 'trust.enforcement.recorded', { ...base, action: 'suspend_offer', ownerTeam: 'offers', targets: [{ type: 'conversation', id }] });
    expect((await h.call('GET', `${STORE}/conversations/${id}`, tokens.customer(o.customerId!))).body.status).toBe('open');
    await h.publish('trust', 'trust.enforcement.recorded', { ...base, action: 'lock_conversation', targets: [{ type: 'conversation', id }, { type: 'message', id: msg.body.id }, { type: 'conversation', id: newId() }] });
    await h.publish('trust', 'trust.enforcement.recorded', { ...base, action: 'lock_conversation', targets: [{ type: 'conversation', id }] });
    const c = await h.call('GET', `${STORE}/conversations/${id}`, tokens.customer(o.customerId!));
    expect(c.body).toMatchObject({ status: 'locked', lockedReason: 'Trust and Risk enforcement: Harassment' });
    expect(h.named('messaging.conversation.locked').filter((e) => e.conversationId === id)).toHaveLength(1);
    expect((await h.call('GET', `${STORE}/conversations/${id2}`, tokens.customer(o.customerId!))).body.status).toBe('open');
  });
});

describe('public API', () => {
  it('answers the in-process callers: unread counts, inbox, order and subject lookups, summaries', async () => {
    const o = await placeOrder(h);
    const returnId = newId();
    h.returns.push({ orderItemId: o.itemA, returnId, ref: 'RT-261009-0077', status: 'approved' });
    const conv = await h.service.findOrStartForOrder({ orderId: o.order.id, sellerId: o.sellerA, orderItemId: o.itemA, returnId });
    expect(conv).toMatchObject({ kind: 'order', subject: { kind: 'return', returnId, returnRef: 'RT-261009-0077' }, counterparty: { kind: 'seller', id: o.sellerA } });
    expect((await h.service.findOrStartForOrder({ orderId: o.order.id, sellerId: o.sellerA, orderItemId: o.itemA, returnId })).id).toBe(conv.id);
    await expect(h.service.findOrStartForOrder({ orderId: o.order.id, sellerId: newId() })).rejects.toMatchObject({ code: 'ORDER_NOT_ELIGIBLE' });

    const note = await h.service.postSystemNote(conv.id, 'Return RT-261009-0077 approved');
    expect(note).toMatchObject({ kind: 'system', body: 'Return RT-261009-0077 approved', author: null });
    await h.call('POST', `${SELLER}/conversations/${conv.id}/messages`, tokens.seller(o.sellerA), { body: 'We will email a label.' });

    // customers passes { kind: 'customer', id: customerId }
    const me = { kind: 'customer' as const, id: o.customerId! };
    expect(await h.service.unreadCount(me)).toBe(2);
    expect(await h.service.unreadSummary(me)).toEqual({ conversations: 1, messages: 2, fromNames: ['Casa Verde Home'] });
    expect(await h.service.unreadCount({ kind: 'customer', id: newId() })).toBe(0);
    expect(await h.service.unreadCount({ kind: 'seller', id: o.sellerA })).toBe(0); // the seller's own reply marks everything before it read

    expect((await h.service.listForOrder(o.order.id, me)).map((c) => c.id)).toEqual([conv.id]);
    expect(await h.service.listForOrder(o.order.id, { kind: 'customer', id: newId() })).toEqual([]);
    expect(await h.service.listForOrder(o.order.id, { kind: 'seller', id: o.sellerB })).toEqual([]);
    expect((await h.service.getForSubject({ kind: 'return', id: returnId }, me))?.id).toBe(conv.id);
    expect((await h.service.getForSubject({ kind: 'order_item', id: o.itemA }, { kind: 'seller', id: o.sellerA }))?.id).toBe(conv.id);
    expect(await h.service.getForSubject({ kind: 'return', id: returnId }, { kind: 'seller', id: o.sellerB })).toBeNull();
    expect((await h.service.getConversation(me, conv.id))?.subject.statusLabel).toBe('approved');
    expect(await h.service.getConversation({ kind: 'customer', id: newId() }, conv.id)).toBeNull();
    const inbox = await h.service.listInbox({ kind: 'seller', id: o.sellerA }, {}, { limit: 10 });
    expect(inbox.items.map((c) => c.id)).toEqual([conv.id]);
    expect((await h.service.listInbox(me, { unreadOnly: true }, {})).items).toHaveLength(1);

    const staffId = newId();
    const withStaff = await h.service.addStaffParticipant(conv.id, { kind: 'staff', id: staffId, name: 'Ana Cruz' }, newId());
    expect(withStaff.participants).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'staff', id: staffId })]));
    expect((await h.service.getConversation({ kind: 'staff', id: staffId }, conv.id))?.id).toBe(conv.id);

    const summaries = await h.service.customerConversationSummaries([o.customerId!, newId()]);
    expect(summaries[o.customerId!]).toMatchObject({ conversationCount: 1, openCount: 1, reportedCount: 0, counterparties: [{ kind: 'seller', sellerId: o.sellerA, name: 'Casa Verde Home', conversationCount: 1 }] });
    expect(JSON.stringify(summaries)).not.toContain('label');
    expect(Object.values(summaries)[1]).toMatchObject({ conversationCount: 0, lastMessageAt: null, counterparties: [] });

    const stats = await h.service.sellerResponseStats(o.sellerA, { from: '2026-01-01', to: '2026-12-31' });
    expect(stats).toMatchObject({ targetHours: 24, awaitingReply: 0, overdue: 0 });
    await h.runJob('messaging.response-stats');
  });

  it('serves the GraphQL fields with the REST record scope', async () => {
    const o = await placeOrder(h);
    const id = await thread(o, 'GraphQL question');
    await h.call('POST', `${SELLER}/conversations/${id}/messages`, tokens.seller(o.sellerA), { body: 'GraphQL answer' });
    const customer = tokens.customer(o.customerId!);
    const store = await h.gql(
      'store',
      customer,
      `{ conversations(unreadOnly: true) { items { id kind status replyState unreadCount lastMessagePreview lastFromMe counterparty { kind name } subject { kind title } messages { items { body fromMe kind redactions author { kind } } } } }
         conversation(id: "${id}") { id canSend privacyNote participants { kind name } } }`,
    );
    expect(store.errors).toBeUndefined();
    expect(store.data.conversations.items).toEqual([
      expect.objectContaining({ id, kind: 'ORDER', status: 'OPEN', replyState: 'REPLIED', unreadCount: 1, lastMessagePreview: 'GraphQL answer', lastFromMe: false, counterparty: { kind: 'SELLER', name: 'Casa Verde Home' } }),
    ]);
    expect(store.data.conversations.items[0].messages.items.map((m: any) => [m.body, m.fromMe, m.author.kind])).toEqual([
      ['GraphQL answer', false, 'SELLER'],
      ['GraphQL question', true, 'CUSTOMER'],
    ]);
    expect(store.data.conversation).toMatchObject({ id, canSend: true });
    const stranger = await h.gql('store', tokens.customer(newId()), `{ conversation(id: "${id}") { id } }`);
    expect(stranger.data.conversation).toBeNull();

    // Customer.unreadMessages (the `me` root needs a real customers profile, so the field resolver is called directly)
    const r = resolvers(h.service);
    const gctx = { area: 'store', principal: { kind: 'customer', accountId: o.customerId, sessionId: 's' }, customerId: async () => o.customerId } as never;
    expect(await r.Customer!.unreadMessages!({ id: o.customerId }, {}, gctx, {} as never)).toEqual({ conversations: 1, messages: 1, fromNames: ['Casa Verde Home'] });
    expect(await r.Customer!.unreadMessages!({ id: newId() }, {}, gctx, {} as never)).toEqual({ conversations: 0, messages: 0, fromNames: [] });
    const adminSummary = await r.Customer!.conversationSummary!({ id: o.customerId }, {}, { area: 'admin' } as never, {} as never);
    expect(adminSummary).toMatchObject({ conversationCount: 1, counterparties: [{ kind: 'SELLER', sellerId: o.sellerA, name: 'Casa Verde Home' }] });
    expect(await r.Seller!.inbox!({ id: o.sellerA }, {}, { area: 'seller', principal: { kind: 'seller', sellerId: o.sellerA } } as never, {} as never)).toMatchObject({ awaitingReply: 0, targetHours: 24 });
    expect(await r.Seller!.inbox!({ id: o.sellerA }, {}, { area: 'seller', principal: { kind: 'seller', sellerId: o.sellerB } } as never, {} as never)).toBeNull();
    expect(await r.Seller!.replyStats!({ id: o.sellerA }, {}, {} as never, {} as never)).toMatchObject({ targetHours: 24, averageReplyMinutes: 0, repliedWithinTargetPct: 100, label: 'Usually replies within an hour', periodDays: 30 });
    const ret = await r.Return!.conversation!({ id: newId() }, {}, gctx, {} as never);
    expect(ret).toBeNull();
    const orderConvs: any = await r.Order!.conversations!({ id: o.order.id }, {}, gctx, {} as never);
    expect(orderConvs.map((c: any) => c.id)).toEqual([id]);

    const seller = await h.gql(
      'seller',
      tokens.seller(o.sellerA),
      `{ sellerConversations(replyState: REPLIED) { items { id replyLabel dispatchWarning counterparty { kind name } } } sellerConversation(id: "${id}") { id privacyNote unreadCount } }`,
    );
    expect(seller.errors).toBeUndefined();
    expect(seller.data.sellerConversations.items).toEqual([expect.objectContaining({ id, replyLabel: expect.stringMatching(/^Replied in /), counterparty: { kind: 'CUSTOMER', name: 'Sam R.' } })]);
    expect(seller.data.sellerConversation).toMatchObject({ id, unreadCount: 0 });
    const otherSeller = await h.gql('seller', tokens.seller(o.sellerB), `{ sellerConversation(id: "${id}") { id } }`);
    expect(otherSeller.data.sellerConversation).toBeNull();
  });

  it('keeps the admin list empty-safe and refuses an empty system note', async () => {
    await expect(h.service.postSystemNote(newId(), 'x')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const o = await placeOrder(h);
    const id = await thread(o);
    await expect(h.service.postSystemNote(id, '  ')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const empty = await h.call('GET', `${ADMIN}/reports?status=dismissed`, tokens.staff());
    expect(empty.status).toBe(200);
  });
});
