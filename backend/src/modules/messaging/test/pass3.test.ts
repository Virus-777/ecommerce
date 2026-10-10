/** Pass 3: guests keyed by order, applicants as participants, restrictions, email replies, closure, export hook, aliases */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { ADMIN, harness, placeOrder, SELLER, STORE, tokens, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h.app.close();
});

describe('guests are keyed by the order (D-M2)', () => {
  it('the guest participant exists from the start; any session with order access reads and writes as it', async () => {
    const o = await placeOrder(h, { guest: true });
    // the seller writes first: before pass 3 the guest only joined on their first action
    const start = await h.call('POST', `${SELLER}/conversations`, tokens.seller(o.sellerA), { orderId: o.order.id, body: 'Your duvet ships tomorrow.' });
    expect(start.status, JSON.stringify(start.body)).toBe(201);
    const id = start.body.conversation.id;
    expect(start.body.conversation.participants).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'guest', id: `order:${o.order.id}`, name: 'Gia G.' })]));
    // the guest is told by email (order contact)
    expect(h.named('messaging.message.sent').at(-1)).toMatchObject({ authorKind: 'seller', recipientKinds: ['guest'], customerId: null, contactEmail: 'gia@example.com' });

    const sessionA = newId();
    const sessionB = newId();
    h.guestGrants.add(`${sessionA}:${o.order.id}`);
    h.guestGrants.add(`${sessionB}:${o.order.id}`);
    const reply = await h.call('POST', `${STORE}/conversations/${id}/messages`, tokens.visitor(sessionA), { body: 'Thanks!' });
    expect(reply.status, JSON.stringify(reply.body)).toBe(201);
    expect(reply.body).toMatchObject({ fromMe: true, author: { kind: 'visitor', id: `order:${o.order.id}` } });
    // another session of the same guest sees the conversation and its own message
    const inbox = await h.call('GET', `${STORE}/conversations?orderId=${o.order.id}`, tokens.visitor(sessionB));
    expect(inbox.body.items.map((c: any) => c.id)).toEqual([id]);
    const msgs = await h.call('GET', `${STORE}/conversations/${id}/messages`, tokens.visitor(sessionB));
    expect(msgs.body.items.find((m: any) => m.body === 'Thanks!')).toMatchObject({ fromMe: true });
    // a session without access does not
    expect((await h.call('GET', `${STORE}/conversations/${id}`, tokens.visitor(newId()))).status).toBe(404);
    // the guest's message moves the seller reply state
    expect((await h.call('GET', `${SELLER}/conversations/${id}`, tokens.seller(o.sellerA))).body.replyState).toBe('awaiting_seller');
  });
});

describe('restrictions', () => {
  it('a restricted customer gets MESSAGING_RESTRICTED (403) with the reason', async () => {
    const o = await placeOrder(h);
    h.restricted.add(o.customerId!);
    const res = await h.call('POST', `${STORE}/conversations`, tokens.customer(o.customerId!), { with: 'seller', orderId: o.order.id, sellerId: o.sellerA, body: 'Hi' });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: 'MESSAGING_RESTRICTED', details: { reason: expect.stringContaining('Messaging is paused') } });
    h.restricted.delete(o.customerId!);
  });
});

describe('staff conversations', () => {
  it('adds the applicant when a staff → applicant conversation starts; the applicant reads and answers it', async () => {
    const applicationId = newId();
    const res = await h.call('POST', `${ADMIN}/conversations`, tokens.staff(), { applicationId, subject: 'Missing document', body: 'Please upload your business licence.' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const applicant = `${applicationId.slice(0, -4)}acc1`;
    expect(res.body.participants).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'customer', id: applicant, name: 'Rae Applicant', label: 'Applicant' })]));
    expect(h.named('messaging.message.sent').at(-1)).toMatchObject({ conversationKind: 'staff_seller', authorKind: 'staff', applicantAccountId: applicant, customerId: applicant });
    expect(h.named('messaging.conversation.started').at(-1)).toMatchObject({ conversationId: res.body.id, kind: 'staff_seller', applicationId });
    const me = tokens.customer(applicant);
    const inbox = await h.call('GET', `${STORE}/conversations`, me);
    expect(inbox.body.items.map((c: any) => c.id)).toContain(res.body.id);
    const answer = await h.call('POST', `${STORE}/conversations/${res.body.id}/messages`, me, { body: 'Uploaded it now.' });
    expect(answer.status, JSON.stringify(answer.body)).toBe(201);
    expect((await h.call('GET', `${STORE}/conversations/${res.body.id}`, tokens.customer(newId()))).status).toBe(404);
  });

  it('the case is a link: starting again without the case appends to the same conversation', async () => {
    const o = await placeOrder(h);
    const caseId = newId();
    const first = await h.call('POST', `${ADMIN}/conversations`, tokens.staff(), { sellerId: o.sellerA, orderId: o.order.id, caseId, subject: 'Damaged item', body: 'Please check the photos.' });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const again = await h.call('POST', `${ADMIN}/conversations`, tokens.staff(), { sellerId: o.sellerA, orderId: o.order.id, subject: 'Damaged item', body: 'Any update?' });
    expect(again.body.id).toBe(first.body.id);
  });

  it('support.case.opened adds the case owner (ownerStaffId) when one is assigned', async () => {
    const o = await placeOrder(h);
    const t = await h.call('POST', `${STORE}/conversations`, tokens.customer(o.customerId!), { with: 'seller', orderId: o.order.id, sellerId: o.sellerA, body: 'Broken' });
    const ownerStaffId = newId();
    await h.publish('support', 'support.case.opened', { caseId: newId(), ref: 'CS-261010-0001', kind: 'order_problem', category: 'damaged', priority: 'normal', customerId: o.customerId, sellerId: o.sellerA, orderId: o.order.id, orderItemIds: [], handler: 'seller', ownerStaffId });
    const header = await h.call('GET', `${SELLER}/conversations/${t.body.conversation.id}`, tokens.seller(o.sellerA));
    expect(header.body.participants).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'staff', id: ownerStaffId })]));
  });
});

describe('email replies, account closure and the export hook', () => {
  it('appends an email reply from the customer once; other senders are dropped', async () => {
    const o = await placeOrder(h);
    const t = await h.call('POST', `${STORE}/conversations`, tokens.customer(o.customerId!), { with: 'seller', orderId: o.order.id, sellerId: o.sellerA, body: 'Where is my parcel?' });
    const id = t.body.conversation.id;
    const reply = { module: 'messaging', refId: id, fromEmail: 'Sam@Example.com', accountId: null, text: 'Any news? Call me on 503 555 0142', attachmentAssetIds: [], receivedAt: new Date().toISOString() };
    h.app.kernel.events.publish('notifications', 'notifications.email_reply.received', reply);
    await h.app.kernel.events.drain();
    await h.publish('notifications', 'notifications.email_reply.received', { ...reply, fromEmail: 'stranger@example.com' });
    await h.publish('notifications', 'notifications.email_reply.received', { ...reply, module: 'support' });
    const msgs = await h.call('GET', `${SELLER}/conversations/${id}/messages`, tokens.seller(o.sellerA));
    const fromEmail = msgs.body.items.filter((m: any) => m.body.startsWith('Any news?'));
    expect(fromEmail).toHaveLength(1);
    expect(fromEmail[0]).toMatchObject({ author: { kind: 'customer', id: o.customerId }, redactions: ['contact_details'] });
  });

  it('customers.account.closed: the customer side becomes Former customer; the export hook lists what they can see', async () => {
    const o = await placeOrder(h);
    const me = tokens.customer(o.customerId!);
    const t = await h.call('POST', `${STORE}/conversations`, me, { with: 'seller', orderId: o.order.id, sellerId: o.sellerA, body: 'Is it in stock?' });
    const id = t.body.conversation.id;
    await h.call('POST', `${SELLER}/conversations/${id}/messages`, tokens.seller(o.sellerA), { body: 'Yes, ships today.' });
    const hidden = await h.call('POST', `${SELLER}/conversations/${id}/messages`, tokens.seller(o.sellerA), { body: 'Rude remark' });
    await h.call('POST', `${ADMIN}/messages/${hidden.body.id}/hide`, tokens.staff(['messaging.conversations.moderate']), { reason: 'Rude' });

    const [section] = await h.service.exportCustomerData({ customerId: o.customerId!, accountId: o.customerId! });
    expect(section).toMatchObject({ key: 'messages', title: 'Messages', module: 'messaging', attachmentIds: [] });
    const rec = (section!.records as any[]).find((r) => r.conversationId === id);
    expect(rec).toMatchObject({ with: 'Casa Verde Home', orderRef: o.order.ref });
    expect(rec.messages.map((m: any) => [m.from, m.text])).toEqual([
      ['You', 'Is it in stock?'],
      [expect.any(String), 'Yes, ships today.'],
    ]);
    expect(await h.service.exportCustomerData({ customerId: newId(), accountId: newId() })).toEqual([{ key: 'messages', title: 'Messages', module: 'messaging', records: [], attachmentIds: [] }]);

    const closed = { customerId: o.customerId, userId: o.customerId };
    await h.publish('customers', 'customers.account.closed', closed);
    await h.publish('customers', 'customers.account.closed', closed);
    const seller = await h.call('GET', `${SELLER}/conversations/${id}/messages`, tokens.seller(o.sellerA));
    expect(seller.body.items.find((m: any) => m.body === 'Is it in stock?')).toMatchObject({ authorLabel: 'Former customer' });
    const header = await h.call('GET', `${SELLER}/conversations/${id}`, tokens.seller(o.sellerA));
    expect(header.body.counterparty).toMatchObject({ name: 'Former customer' });
  });
});

describe('conversation aliases and reply figures', () => {
  it('an id merged into another conversation resolves to the kept one; stats carry the median reply time', async () => {
    const o = await placeOrder(h);
    const me = tokens.customer(o.customerId!);
    const t = await h.call('POST', `${STORE}/conversations`, me, { with: 'seller', orderId: o.order.id, sellerId: o.sellerA, body: 'Hello' });
    const id = t.body.conversation.id;
    const oldId = newId();
    await (h.app.kernel.database.kysely.withSchema('messaging') as any).insertInto('conversation_aliases').values({ old_id: oldId, conversation_id: id, merged_at: new Date() }).execute();
    const viaOld = await h.call('GET', `${STORE}/conversations/${oldId}`, me);
    expect(viaOld.status).toBe(200);
    expect(viaOld.body.id).toBe(id);

    h.clock.advance(30 * 60_000);
    await h.call('POST', `${SELLER}/conversations/${id}/messages`, tokens.seller(o.sellerA), { body: 'Hi there' });
    const today = new Date(h.clock.now()).toISOString().slice(0, 10);
    const stats = await h.service.sellerResponseStats(o.sellerA, { from: '2020-01-01', to: today });
    expect(stats).toMatchObject({ medianReplyMinutes: 30, averageReplyMinutes: 30 });
  });
});
