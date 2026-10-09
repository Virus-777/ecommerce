import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { flows } from '../../../testing/flows.js';
import { harness, placeOrder, STORE, SELLER, ADMIN, tokens, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h.app.close();
});

describe('store: starting conversations', () => {
  it('starts a conversation with the seller about an item, then appends to it', async () => {
    const o = await placeOrder(h);
    const me = tokens.customer(o.customerId!);
    const before = h.named('messaging.conversation.started').length;
    const res = await h.call('POST', `${STORE}/conversations`, me, { with: 'seller', orderId: o.order.id, orderItemId: o.itemA, body: 'Hi, can you ship before Friday?', clientMessageId: 'c-1' });
    expect(res.status).toBe(201);
    const c = res.body.conversation;
    expect(c).toMatchObject({
      kind: 'order',
      status: 'open',
      replyState: 'awaiting_seller',
      canSend: true,
      counterparty: { kind: 'seller', id: o.sellerA, name: 'Casa Verde Home', verified: true },
      subject: { kind: 'order_item', orderId: o.order.id, orderRef: o.order.ref, orderItemId: o.itemA, title: 'Linen duvet cover', packageLabel: expect.any(String) },
      privacyNote: 'Only you, Casa Verde Home and Marketly support can see it',
      rulesNote: expect.stringContaining('No promotional messages'),
    });
    expect(c.replyDue.state).toBe('on_time');
    expect(new Date(c.replyDue.dueAt).getTime() - new Date(res.body.message.at).getTime()).toBe(24 * 3_600_000);
    expect(res.body.message).toMatchObject({ kind: 'text', fromMe: true, authorLabel: 'You', body: 'Hi, can you ship before Friday?', redactions: [], hidden: false, clientMessageId: 'c-1' });
    expect(h.named('messaging.conversation.started').slice(before)).toEqual([{ conversationId: c.id, kind: 'order', orderId: o.order.id, sellerId: o.sellerA }]);
    expect(h.named('messaging.message.sent').at(-1)).toEqual({
      messageId: res.body.message.id,
      conversationId: c.id,
      authorKind: 'customer',
      recipientKinds: ['seller'],
      customerId: o.customerId,
      sellerId: o.sellerA,
      orderId: o.order.id,
    });

    // same subject: the existing conversation is reused, no second "started"
    const again = await h.call('POST', `${STORE}/conversations`, me, { with: 'seller', orderId: o.order.id, sellerId: o.sellerA, orderItemId: o.itemA, body: 'Also, is it machine washable?' });
    expect(again.status).toBe(201);
    expect(again.body.conversation.id).toBe(c.id);
    expect(h.named('messaging.conversation.started').slice(before)).toHaveLength(1);

    // a resend with the same clientMessageId returns the first message
    const resend = await h.call('POST', `${STORE}/conversations/${c.id}/messages`, me, { body: 'Hi, can you ship before Friday?', clientMessageId: 'c-1' });
    expect(resend.status).toBe(201);
    expect(resend.body.id).toBe(res.body.message.id);
    const list = await h.call('GET', `${STORE}/conversations/${c.id}/messages`, me);
    expect(list.body.items.map((m: any) => m.body)).toEqual(['Also, is it machine washable?', 'Hi, can you ship before Friday?']);

    // a different subject (the whole order with the other seller) is a new conversation
    const other = await h.call('POST', `${STORE}/conversations`, me, { with: 'seller', orderId: o.order.id, sellerId: o.sellerB, body: 'Hello' });
    expect(other.body.conversation.id).not.toBe(c.id);
    expect(other.body.conversation.subject).toMatchObject({ kind: 'order', title: `Order ${o.order.ref}` });
  });

  it('refuses orders that are not the customer’s, sellers outside the order and unknown items', async () => {
    const o = await placeOrder(h);
    const stranger = tokens.customer(newId());
    const res = await h.call('POST', `${STORE}/conversations`, stranger, { with: 'seller', orderId: o.order.id, sellerId: o.sellerA, body: 'Hi' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('ORDER_NOT_ELIGIBLE');
    const me = tokens.customer(o.customerId!);
    const wrongSeller = await h.call('POST', `${STORE}/conversations`, me, { with: 'seller', orderId: o.order.id, sellerId: newId(), body: 'Hi' });
    expect(wrongSeller.status).toBe(422);
    expect(wrongSeller.body.error.code).toBe('ORDER_NOT_ELIGIBLE');
    const mismatch = await h.call('POST', `${STORE}/conversations`, me, { with: 'seller', orderId: o.order.id, sellerId: o.sellerB, orderItemId: o.itemA, body: 'Hi' });
    expect(mismatch.status).toBe(422);
    const noItem = await h.call('POST', `${STORE}/conversations`, me, { with: 'seller', orderId: o.order.id, orderItemId: newId(), body: 'Hi' });
    expect(noItem.status).toBe(404);
    const ambiguous = await h.call('POST', `${STORE}/conversations`, me, { with: 'seller', orderId: o.order.id, body: 'Hi' });
    expect(ambiguous.status).toBe(400);
    expect(ambiguous.body.error.code).toBe('VALIDATION_FAILED');
    const empty = await h.call('POST', `${STORE}/conversations`, me, { with: 'seller', orderId: o.order.id, sellerId: o.sellerA, body: '   ' });
    expect(empty.body.error.code).toBe('VALIDATION_FAILED');
    const unknownReturn = await h.call('POST', `${STORE}/conversations`, me, { with: 'seller', orderId: o.order.id, sellerId: o.sellerA, returnId: newId(), body: 'Hi' });
    expect(unknownReturn.status).toBe(404);
  });

  it('messages the Official Store through one of its items (no seller reply state)', async () => {
    const o = await placeOrder(h);
    const me = tokens.customer(o.customerId!);
    const res = await h.call('POST', `${STORE}/conversations`, me, { with: 'seller', orderId: o.order.id, orderItemId: o.itemO, body: 'Does the skillet come seasoned?' });
    expect(res.status).toBe(201);
    expect(res.body.conversation).toMatchObject({ counterparty: { kind: 'official_store', name: 'Marketly Official Store' }, replyState: 'none' });
    expect(h.named('messaging.message.sent').at(-1)).toMatchObject({ authorKind: 'customer', recipientKinds: ['staff'], sellerId: null });
  });

  it('starts a Marketly support conversation about a case, and about a return with the seller', async () => {
    const o = await placeOrder(h);
    const caseId = newId();
    h.cases.push({ orderId: o.order.id, caseId, ref: 'CS-261009-0001', status: 'open', orderItemIds: [o.itemB] });
    const returnId = newId();
    h.returns.push({ orderItemId: o.itemA, returnId, ref: 'RT-261009-0001', status: 'requested' });
    const me = tokens.customer(o.customerId!);
    const support = await h.call('POST', `${STORE}/conversations`, me, { with: 'marketplace_support', orderId: o.order.id, caseId, body: 'The speaker arrived broken' });
    expect(support.status).toBe(201);
    expect(support.body.conversation).toMatchObject({ kind: 'support', counterparty: { kind: 'marketplace_support', name: 'Marketly Support' }, subject: { kind: 'case', caseId, caseRef: 'CS-261009-0001' } });
    const ret = await h.call('POST', `${STORE}/conversations`, me, { with: 'seller', orderId: o.order.id, orderItemId: o.itemA, returnId, body: 'When will you pick it up?' });
    expect(ret.status).toBe(201);
    expect(ret.body.conversation.subject).toMatchObject({ kind: 'return', returnId, returnRef: 'RT-261009-0001', statusLabel: 'requested' });
    const unknownCase = await h.call('POST', `${STORE}/conversations`, me, { with: 'marketplace_support', orderId: o.order.id, caseId: newId(), body: 'Hi' });
    expect(unknownCase.status).toBe(404);
  });

  it('lets a guest with order access message the seller', async () => {
    const o = await placeOrder(h, { guest: true });
    const sid = newId();
    const guest = tokens.visitor(sid);
    const denied = await h.call('POST', `${STORE}/conversations`, guest, { with: 'seller', orderId: o.order.id, sellerId: o.sellerA, body: 'Hi' });
    expect(denied.status).toBe(422);
    h.guestGrants.add(`${sid}:${o.order.id}`);
    const res = await h.call('POST', `${STORE}/conversations`, guest, { with: 'seller', orderId: o.order.id, sellerId: o.sellerA, body: 'Hi, guest here' });
    expect(res.status).toBe(201);
    const inbox = await h.call('GET', `${STORE}/conversations`, guest);
    expect(inbox.body.items.map((c: any) => c.id)).toEqual([res.body.conversation.id]);
    expect(h.named('messaging.message.sent').at(-1)).toMatchObject({ customerId: null, sellerId: o.sellerA });
  });

  it('refuses new messages from a customer with a messaging restriction', async () => {
    const o = await placeOrder(h);
    h.restricted.add(o.customerId!);
    const me = tokens.customer(o.customerId!);
    const res = await h.call('POST', `${STORE}/conversations`, me, { with: 'seller', orderId: o.order.id, sellerId: o.sellerA, body: 'Hi' });
    expect(res.status).toBe(403);
    expect(res.body.error.message).toContain('Messaging is paused');
    h.restricted.delete(o.customerId!);
  });
});

describe('store: inbox, read state and record scope', () => {
  it('lists the inbox with unread counts, marks read and hides other customers’ conversations', async () => {
    const o = await placeOrder(h);
    const me = tokens.customer(o.customerId!);
    const start = await h.call('POST', `${STORE}/conversations`, me, { with: 'seller', orderId: o.order.id, sellerId: o.sellerA, body: 'Is the duvet in stock?' });
    const id = start.body.conversation.id;
    const seller = tokens.seller(o.sellerA, undefined, 'Marisol Vega');
    const r1 = await h.call('POST', `${SELLER}/conversations/${id}/messages`, seller, { body: 'Yes, it ships tomorrow.' });
    expect(r1.status).toBe(201);
    expect(r1.body.authorLabel).toBe('You');
    await h.call('POST', `${SELLER}/conversations/${id}/messages`, seller, { body: 'Tracking follows.' });

    expect((await h.call('GET', `${STORE}/unread-count`, me)).body).toEqual({ conversations: 1, messages: 2 });
    const inbox = await h.call('GET', `${STORE}/conversations?unreadOnly=true`, me);
    expect(inbox.body.items).toHaveLength(1);
    expect(inbox.body.items[0]).toMatchObject({ id, unread: true, unreadCount: 2, lastMessagePreview: 'Tracking follows.', lastFromMe: false, replyState: 'replied', replyLabel: null });
    const msgs = await h.call('GET', `${STORE}/conversations/${id}/messages`, me);
    expect(msgs.body.items[0]).toMatchObject({ authorLabel: 'Marisol, Casa Verde Home', fromMe: false, author: { kind: 'seller', id: o.sellerA } });

    const read = await h.call('POST', `${STORE}/conversations/${id}/read`, me, { upToMessageId: r1.body.id });
    expect(read.status).toBe(204);
    expect((await h.call('GET', `${STORE}/unread-count`, me)).body).toEqual({ conversations: 1, messages: 1 });
    await h.call('POST', `${STORE}/conversations/${id}/read`, me, { upToMessageId: msgs.body.items[0].id });
    expect((await h.call('GET', `${STORE}/unread-count`, me)).body).toEqual({ conversations: 0, messages: 0 });
    // reading an older message never moves the marker back
    await h.call('POST', `${STORE}/conversations/${id}/read`, me, { upToMessageId: r1.body.id });
    expect((await h.call('GET', `${STORE}/unread-count`, me)).body.messages).toBe(0);
    expect((await h.call('GET', `${STORE}/conversations?q=casa`, me)).body.items).toHaveLength(1);
    expect((await h.call('GET', `${STORE}/conversations?q=nothing-like-this`, me)).body.items).toHaveLength(0);
    expect((await h.call('GET', `${STORE}/conversations?orderId=${o.order.id}`, me)).body.items).toHaveLength(1);

    const header = await h.call('GET', `${STORE}/conversations/${id}`, me);
    expect(header.status).toBe(200);
    expect(header.body.participants.map((p: any) => p.kind)).toEqual(['customer', 'seller']);
    expect(header.body.subject.statusLabel).toEqual(expect.any(String));

    const stranger = tokens.customer(newId());
    expect((await h.call('GET', `${STORE}/conversations/${id}`, stranger)).status).toBe(404);
    expect((await h.call('GET', `${STORE}/conversations/${id}/messages`, stranger)).status).toBe(404);
    expect((await h.call('POST', `${STORE}/conversations/${id}/messages`, stranger, { body: 'hi' })).status).toBe(404);
    expect((await h.call('POST', `${STORE}/conversations/${id}/read`, stranger, { upToMessageId: r1.body.id })).status).toBe(404);
    expect((await h.call('POST', `${STORE}/messages/${r1.body.id}/report`, stranger, { reason: 'abusive' })).status).toBe(404);
    expect((await h.call('GET', `${STORE}/conversations`, stranger)).body.items).toHaveLength(0);
    expect((await h.call('POST', `${STORE}/conversations/${id}/read`, me, { upToMessageId: newId() })).status).toBe(404);
  });

  it('masks contact details and outside links; staff see the original', async () => {
    const o = await placeOrder(h);
    const me = tokens.customer(o.customerId!);
    const res = await h.call('POST', `${STORE}/conversations`, me, {
      with: 'seller',
      orderId: o.order.id,
      sellerId: o.sellerA,
      body: `Order ${o.order.ref}: email me at sam@example.com or call (503) 555-0142, photos at https://imgs.example.net/x`,
    });
    expect(res.status).toBe(201);
    const m = res.body.message;
    expect(m.body).toBe(`Order ${o.order.ref}: email me at [contact details hidden] or call [contact details hidden], photos at [link hidden]`);
    expect(m.redactions).toEqual(['contact_details', 'link']);
    const seller = tokens.seller(o.sellerA);
    const sellerView = await h.call('GET', `${SELLER}/conversations/${res.body.conversation.id}/messages`, seller);
    expect(sellerView.body.items[0].body).not.toContain('sam@example.com');
    const staff = await h.call('GET', `${ADMIN}/conversations/${res.body.conversation.id}/messages?reason=${encodeURIComponent('Case CS-1 check')}`, tokens.staff());
    expect(staff.body.items[0].body).toContain('sam@example.com');
  });

  it('sends photos uploaded as message attachments; other files are refused', async () => {
    const o = await placeOrder(h);
    const me = tokens.customer(o.customerId!);
    const f = flows(h.app, h.clock);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const photo = await f.upload('store', me, { purpose: 'message_attachment', fileName: 'damage.png', contentType: 'image/png', body: png });
    const res = await h.call('POST', `${STORE}/conversations`, me, { with: 'seller', orderId: o.order.id, sellerId: o.sellerA, body: '', mediaIds: [photo] });
    expect(res.status).toBe(201);
    expect(res.body.message.attachments.map((a: any) => a.id)).toEqual([photo]);
    const seller = await h.call('GET', `${SELLER}/conversations/${res.body.conversation.id}/messages`, tokens.seller(o.sellerA));
    expect(seller.body.items[0].attachments).toHaveLength(1);
    expect((await h.call('GET', `${SELLER}/conversations`, tokens.seller(o.sellerA))).body.items[0].lastMessagePreview).toBe('Sent an attachment');

    const evidence = await f.upload('store', me, { purpose: 'case_evidence', fileName: 'e.png', contentType: 'image/png', body: png });
    const bad = await h.call('POST', `${STORE}/conversations/${res.body.conversation.id}/messages`, me, { body: 'see', mediaIds: [evidence] });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details.issues[0].path).toBe('mediaIds[0]');
    // someone else's file is not found
    const other = tokens.customer(newId());
    const foreign = await f.upload('store', other, { purpose: 'message_attachment', fileName: 'x.png', contentType: 'image/png', body: png });
    const stolen = await h.call('POST', `${STORE}/conversations/${res.body.conversation.id}/messages`, me, { body: 'see', mediaIds: [foreign] });
    expect(stolen.status).toBe(400);
    const tooMany = await h.call('POST', `${STORE}/conversations/${res.body.conversation.id}/messages`, me, { body: 'see', mediaIds: Array.from({ length: 6 }, () => newId()) });
    expect(tooMany.body.error.details.issues[0]).toMatchObject({ path: 'mediaIds' });
  });

  it('reports a message once per reporter; own and system messages cannot be reported', async () => {
    const o = await placeOrder(h);
    const me = tokens.customer(o.customerId!);
    const start = await h.call('POST', `${STORE}/conversations`, me, { with: 'seller', orderId: o.order.id, sellerId: o.sellerA, body: 'Hi' });
    const id = start.body.conversation.id;
    const reply = await h.call('POST', `${SELLER}/conversations/${id}/messages`, tokens.seller(o.sellerA), { body: 'Pay me outside the site and I give a better price' });
    const rep = await h.call('POST', `${STORE}/messages/${reply.body.id}/report`, me, { reason: 'off_platform_contact', note: 'Asked to pay outside' });
    expect(rep.status).toBe(201);
    expect(rep.body).toEqual({ reportId: expect.any(String), status: 'open' });
    expect(h.named('messaging.message.reported').at(-1)).toEqual({ reportId: rep.body.reportId, messageId: reply.body.id, reason: 'off_platform_contact' });
    const again = await h.call('POST', `${STORE}/messages/${reply.body.id}/report`, me, { reason: 'abusive' });
    expect(again.body.reportId).toBe(rep.body.reportId);
    const own = await h.call('POST', `${STORE}/messages/${start.body.message.id}/report`, me, { reason: 'abusive' });
    expect(own.status).toBe(400);
    const sellerRep = await h.call('POST', `${SELLER}/messages/${start.body.message.id}/report`, tokens.seller(o.sellerA), { reason: 'abusive' });
    expect(sellerRep.status).toBe(201);
    expect((await h.call('POST', `${SELLER}/messages/${start.body.message.id}/report`, tokens.seller(o.sellerB), { reason: 'abusive' })).status).toBe(404);
  });
});
