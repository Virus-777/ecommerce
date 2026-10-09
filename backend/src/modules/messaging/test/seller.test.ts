import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { harness, placeOrder, SELLER, STORE, tokens, type Harness, type Placed } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h.app.close();
});

const HOUR = 3_600_000;

async function customerAsks(o: Placed, body = 'Where is my order?', sellerId = o.sellerA) {
  const res = await h.call('POST', `${STORE}/conversations`, tokens.customer(o.customerId!), { with: 'seller', orderId: o.order.id, sellerId, body });
  expect(res.status).toBe(201);
  return res.body.conversation.id as string;
}

describe('seller: inbox, replies and reply targets', () => {
  it('replies move the reply state; another seller never sees the conversation', async () => {
    const o = await placeOrder(h);
    const id = await customerAsks(o);
    const seller = tokens.seller(o.sellerA, undefined, 'Marisol Vega');
    const list = await h.call('GET', `${SELLER}/conversations`, seller);
    expect(list.status).toBe(200);
    const row = list.body.items.find((c: any) => c.id === id);
    expect(row).toMatchObject({ counterparty: { kind: 'customer', name: 'Sam R.' }, replyState: 'awaiting_seller', unread: true, unreadCount: 1, replyLabel: expect.stringMatching(/^Reply by /) });

    const header = await h.call('GET', `${SELLER}/conversations/${id}`, seller);
    expect(header.body).toMatchObject({ privacyNote: 'Only you, the buyer and Marketly support can see it', canSend: true, dispatchWarning: null });

    const reply = await h.call('POST', `${SELLER}/conversations/${id}/messages`, seller, { body: 'It ships today, tracking to follow.' });
    expect(reply.status).toBe(201);
    expect(h.named('messaging.message.sent').at(-1)).toMatchObject({ authorKind: 'seller', recipientKinds: ['customer'], sellerId: o.sellerA, customerId: o.customerId });
    const after = await h.call('GET', `${SELLER}/conversations?filter=all`, seller);
    expect(after.body.items.find((c: any) => c.id === id)).toMatchObject({ replyState: 'replied', replyLabel: expect.stringMatching(/^Replied in /), lastFromMe: true });
    // the seller's own reply leaves nothing unread for the seller
    expect(after.body.items.find((c: any) => c.id === id).unreadCount).toBe(0);

    const other = tokens.seller(o.sellerB);
    expect((await h.call('GET', `${SELLER}/conversations/${id}`, other)).status).toBe(404);
    expect((await h.call('GET', `${SELLER}/conversations/${id}/messages`, other)).status).toBe(404);
    expect((await h.call('POST', `${SELLER}/conversations/${id}/messages`, other, { body: 'hi' })).status).toBe(404);
    expect((await h.call('POST', `${SELLER}/conversations/${id}/read`, other, { upToMessageId: reply.body.id })).status).toBe(404);
    expect((await h.call('GET', `${SELLER}/conversations`, other)).body.items.find((c: any) => c.id === id)).toBeUndefined();
  });

  it('refuses promotional messages from sellers', async () => {
    const o = await placeOrder(h);
    const id = await customerAsks(o);
    const seller = tokens.seller(o.sellerA);
    for (const body of ['Use code SAVE20 on your next order!', 'Get 15% off everything this week', 'Check out our new arrivals and follow us on Instagram']) {
      const res = await h.call('POST', `${SELLER}/conversations/${id}/messages`, seller, { body });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(res.body.error.details.issues[0].message).toContain('promotional');
    }
    expect((await h.call('POST', `${SELLER}/conversations/${id}/messages`, seller, { body: 'Sorry for the delay, I can refund the shipping.' })).status).toBe(201);
  });

  it('moves unanswered conversations to overdue (job), lists them first and counts them', async () => {
    const o = await placeOrder(h);
    const first = await customerAsks(o, 'First question');
    h.clock.advance(25 * HOUR);
    // a new question after the deadline: awaiting, not overdue
    const fresh = await customerAsks(o, 'Fresh question', o.sellerB);
    await h.runJob('messaging.reply-deadlines');
    const overdue = h.named('messaging.reply.overdue').find((e) => e.conversationId === first);
    expect(overdue).toMatchObject({ conversationId: first, sellerId: o.sellerA, orderId: o.order.id, dueAt: expect.any(String) });
    expect(h.named('messaging.reply.overdue').find((e) => e.conversationId === fresh)).toBeUndefined();
    // idempotent: running again publishes nothing new for it
    const n = h.named('messaging.reply.overdue').length;
    await h.runJob('messaging.reply-deadlines');
    expect(h.named('messaging.reply.overdue').length).toBe(n);

    const seller = tokens.seller(o.sellerA);
    // a follow-up while overdue keeps the first due time
    expect(await customerAsks(o, 'About the duvet again?')).toBe(first);
    // a newer conversation (about the item) lists after the overdue one
    const newer = await h.call('POST', `${STORE}/conversations`, tokens.customer(o.customerId!), { with: 'seller', orderId: o.order.id, orderItemId: o.itemA, body: 'And the colour?' });
    await h.call('POST', `${SELLER}/conversations/${newer.body.conversation.id}/messages`, seller, { body: 'Teal.' });
    const all = await h.call('GET', `${SELLER}/conversations`, seller);
    expect(all.body.items.map((c: any) => c.id)).toEqual([first, newer.body.conversation.id]);
    const inbox = await h.service.sellerInboxSummary(o.sellerA);
    expect(inbox).toMatchObject({ awaitingReply: 1, overdue: 1, targetHours: 24, oldestWaitingSince: expect.any(String) });
    const list = await h.call('GET', `${SELLER}/conversations?filter=overdue`, seller);
    expect(list.body.items.map((c: any) => c.id)).toEqual([first]);
    expect(list.body.items[0]).toMatchObject({ replyState: 'overdue', replyLabel: expect.stringMatching(/^Overdue /), replyDue: { state: 'overdue' } });
    const awaiting = await h.call('GET', `${SELLER}/conversations?filter=awaiting_reply`, seller);
    expect(awaiting.body.items.map((c: any) => c.id)).toEqual([first]);

    const stats = await h.call('GET', `${SELLER}/response-stats`, seller);
    expect(stats.status).toBe(200);
    expect(stats.body).toMatchObject({ targetHours: 24, awaitingReply: 1, overdue: 1 });
    const day = (offset: number) => new Date(h.clock.now().getTime() + offset * 24 * HOUR).toISOString().slice(0, 10);
    const range = `from=${day(-3)}&to=${day(1)}`;
    const admin = tokens.staff(['messaging.conversations.read']);
    const s1 = await h.call('GET', `/api/admin/messaging/sellers/${o.sellerA}/response-stats?${range}`, admin);
    expect(s1.body).toMatchObject({ awaitingReply: 1, overdue: 1, averageReplyMinutes: 0, repliedWithinTargetPct: 50, period: { from: day(-3), to: day(1) } });

    // the reply ends the round (overdue → replied) and counts in the statistics
    h.clock.advance(HOUR);
    await h.call('POST', `${SELLER}/conversations/${first}/messages`, seller, { body: 'Sorry, shipping now.' });
    const s2 = await h.call('GET', `/api/admin/messaging/sellers/${o.sellerA}/response-stats?${range}`, admin);
    expect(s2.body).toMatchObject({ awaitingReply: 0, overdue: 0, averageReplyMinutes: 13 * 60, repliedWithinTargetPct: 50 });
    const bad = await h.call('GET', `/api/admin/messaging/sellers/${o.sellerA}/response-stats?from=${day(1)}&to=${day(-1)}`, admin);
    expect(bad.status).toBe(400);
  });

  it('starts a conversation with the buyer of the seller’s own order only', async () => {
    const o = await placeOrder(h);
    const seller = tokens.seller(o.sellerB, undefined, 'Pat');
    const res = await h.call('POST', `${SELLER}/conversations`, seller, { orderId: o.order.id, orderItemId: o.itemB, body: 'Your speaker ships tomorrow.' });
    expect(res.status).toBe(201);
    expect(res.body.conversation).toMatchObject({ kind: 'order', replyState: 'none', counterparty: { kind: 'customer', id: o.customerId }, subject: { kind: 'order_item', title: 'Pocket Speaker' } });
    expect(res.body.message.authorLabel).toBe('You');
    const customerView = await h.call('GET', `${STORE}/conversations/${res.body.conversation.id}/messages`, tokens.customer(o.customerId!));
    expect(customerView.body.items[0].authorLabel).toBe('Pat, Pixel & Port');
    expect((await h.call('POST', `${SELLER}/conversations`, seller, { orderId: o.order.id, orderItemId: o.itemA, body: 'x' })).body.error.code).toBe('ORDER_NOT_ELIGIBLE');
    const elsewhere = await h.call('POST', `${SELLER}/conversations`, tokens.seller(newId()), { orderId: o.order.id, body: 'x' });
    expect(elsewhere.status).toBe(422);
  });

  it('manages reply templates (own seller only)', async () => {
    const sellerId = newId();
    const seller = tokens.seller(sellerId);
    const created = await h.call('POST', `${SELLER}/templates`, seller, { name: 'Shipping delay', body: 'Sorry, your order ships tomorrow.' });
    expect(created.status).toBe(201);
    expect((await h.call('GET', `${SELLER}/templates`, seller)).body.map((t: any) => t.name)).toEqual(['Shipping delay']);
    const upd = await h.call('PATCH', `${SELLER}/templates/${created.body.id}`, seller, { name: 'Delay', body: 'Ships tomorrow.' });
    expect(upd.body).toMatchObject({ name: 'Delay', body: 'Ships tomorrow.' });
    const other = tokens.seller(newId());
    expect((await h.call('PATCH', `${SELLER}/templates/${created.body.id}`, other, { name: 'x', body: 'y' })).status).toBe(404);
    expect((await h.call('DELETE', `${SELLER}/templates/${created.body.id}`, other)).status).toBe(404);
    expect((await h.call('GET', `${SELLER}/templates`, other)).body).toEqual([]);
    expect((await h.call('POST', `${SELLER}/templates`, seller, { name: 'Promo', body: 'Use code SAVE10 next time' })).status).toBe(400);
    expect((await h.call('DELETE', `${SELLER}/templates/${created.body.id}`, seller)).status).toBe(204);
    expect((await h.call('GET', `${SELLER}/templates`, seller)).body).toEqual([]);
  });
});
