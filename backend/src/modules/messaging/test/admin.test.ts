import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { ADMIN, harness, placeOrder, SELLER, STORE, tokens, type Harness, type Placed } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h.app.close();
});

async function thread(o: Placed) {
  const res = await h.call('POST', `${STORE}/conversations`, tokens.customer(o.customerId!), { with: 'seller', orderId: o.order.id, sellerId: o.sellerA, body: 'Hello, my duvet is torn' });
  expect(res.status).toBe(201);
  return { id: res.body.conversation.id as string, messageId: res.body.message.id as string };
}

describe('admin: finding and reading conversations', () => {
  it('finds conversations by order, customer, seller and filter; a read needs a reason and is logged', async () => {
    const o = await placeOrder(h);
    const t = await thread(o);
    const staffId = newId();
    const staff = tokens.staff(['messaging.conversations.read'], { sub: staffId });
    const byOrder = await h.call('GET', `${ADMIN}/conversations?orderId=${o.order.id}`, staff);
    expect(byOrder.status).toBe(200);
    expect(byOrder.body.items).toEqual([
      expect.objectContaining({ id: t.id, customerName: 'Sam R.', counterparty: expect.objectContaining({ kind: 'seller', name: 'Casa Verde Home' }), status: 'open', replyState: 'awaiting_seller', reportCount: 0 }),
    ]);
    expect((await h.call('GET', `${ADMIN}/conversations?customerId=${o.customerId}`, staff)).body.items).toHaveLength(1);
    expect((await h.call('GET', `${ADMIN}/conversations?sellerId=${o.sellerB}`, staff)).body.items).toHaveLength(0);
    expect((await h.call('GET', `${ADMIN}/conversations?orderId=${o.order.id}&filter=locked`, staff)).body.items).toHaveLength(0);

    const noReason = await h.call('GET', `${ADMIN}/conversations/${t.id}/messages?reason=%20`, staff);
    expect(noReason.status).toBe(400);
    const before = h.audits.length;
    const caseId = newId();
    const read = await h.call('GET', `${ADMIN}/conversations/${t.id}/messages?reason=${encodeURIComponent('Case about a torn duvet')}&caseId=${caseId}`, staff);
    expect(read.status).toBe(200);
    expect(read.body.items.map((m: any) => m.body)).toEqual(['Hello, my duvet is torn']);
    expect(h.audits.slice(before)).toEqual([
      expect.objectContaining({ action: 'messaging.conversation.read', module: 'messaging', reason: 'Case about a torn duvet', target: expect.objectContaining({ type: 'conversation', id: t.id }), actor: expect.objectContaining({ kind: 'staff', id: staffId }) }),
    ]);
    const db = h.app.kernel.database.kysely as any;
    const log = await db.withSchema('messaging').selectFrom('staff_access_log').selectAll().where('conversation_id', '=', t.id).execute();
    expect(log).toEqual([expect.objectContaining({ staff_id: staffId, reason: 'Case about a torn duvet', case_id: caseId })]);
    expect((await h.call('GET', `${ADMIN}/conversations/${newId()}/messages?reason=x`, staff)).status).toBe(404);
  });
});

describe('admin: staff conversations and posting as Marketly Support', () => {
  it('starts a staff conversation with a seller about an order and appends on a second start', async () => {
    const o = await placeOrder(h);
    const staff = tokens.staff(undefined, { name: 'Dana Lee' });
    const body = { sellerId: o.sellerA, orderId: o.order.id, orderItemIds: [o.itemA], subject: 'Late dispatch', body: 'Please ship the duvet today.' };
    const res = await h.call('POST', `${ADMIN}/conversations`, staff, body);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ kind: 'staff_seller', counterparty: { kind: 'seller', id: o.sellerA, name: 'Casa Verde Home' }, subject: { kind: 'order_item', title: 'Late dispatch', orderRef: o.order.ref }, replyState: 'none' });
    expect(h.named('messaging.conversation.started').at(-1)).toMatchObject({ conversationId: res.body.id, kind: 'staff_seller', sellerId: o.sellerA });
    expect(h.named('messaging.message.sent').at(-1)).toMatchObject({ authorKind: 'staff', recipientKinds: ['seller'], sellerId: o.sellerA, customerId: null });
    expect(h.audits.at(-1)).toMatchObject({ action: 'messaging.conversation.staff_start' });

    const again = await h.call('POST', `${ADMIN}/conversations`, staff, { ...body, body: 'Any update?' });
    expect(again.body.id).toBe(res.body.id);
    expect(h.audits.at(-1)).toMatchObject({ action: 'messaging.conversation.staff_message' });

    // the seller sees it in Seller Center with counterparty Marketly Support; the customer never does
    const seller = tokens.seller(o.sellerA);
    const list = await h.call('GET', `${SELLER}/conversations`, seller);
    expect(list.body.items.find((c: any) => c.id === res.body.id)).toMatchObject({ counterparty: { kind: 'marketplace_support', name: 'Marketly Support' }, unreadCount: 2 });
    const msgs = await h.call('GET', `${SELLER}/conversations/${res.body.id}/messages`, seller);
    expect(msgs.body.items[1].authorLabel).toBe('Dana, Marketly Support');
    const reply = await h.call('POST', `${SELLER}/conversations/${res.body.id}/messages`, seller, { body: 'Shipped this morning.' });
    expect(reply.status).toBe(201);
    expect(h.named('messaging.message.sent').at(-1)).toMatchObject({ authorKind: 'seller', recipientKinds: ['staff'] });
    expect((await h.call('GET', `${STORE}/conversations/${res.body.id}`, tokens.customer(o.customerId!))).status).toBe(404);
  });

  it('validates the staff start input', async () => {
    const o = await placeOrder(h);
    const staff = tokens.staff();
    const both = await h.call('POST', `${ADMIN}/conversations`, staff, { sellerId: o.sellerA, applicationId: newId(), subject: 'x', body: 'y' });
    expect(both.status).toBe(400);
    const none = await h.call('POST', `${ADMIN}/conversations`, staff, { subject: 'x', body: 'y' });
    expect(none.status).toBe(400);
    const unknown = await h.call('POST', `${ADMIN}/conversations`, staff, { sellerId: newId(), subject: 'x', body: 'y' });
    expect(unknown.status).toBe(404);
    const notTheirs = await h.call('POST', `${ADMIN}/conversations`, staff, { sellerId: o.sellerA, orderId: o.order.id, orderItemIds: [o.itemB], subject: 'x', body: 'y' });
    expect(notTheirs.status).toBe(400);
    const app = await h.call('POST', `${ADMIN}/conversations`, staff, { applicationId: newId(), subject: 'Missing document', body: 'Please upload your business licence.' });
    expect(app.status).toBe(201);
    expect(app.body.subject).toMatchObject({ kind: 'application', title: 'Missing document' });
  });

  it('posts into a customer conversation as Marketly Support: joins once with a system note', async () => {
    const o = await placeOrder(h);
    const t = await thread(o);
    const caseId = newId();
    h.cases.push({ orderId: o.order.id, caseId, ref: 'CS-261009-0042', status: 'open', orderItemIds: [] });
    const staff = tokens.staff(['messaging.conversations.participate'], { name: 'Ana Cruz' });
    const res = await h.call('POST', `${ADMIN}/conversations/${t.id}/messages`, staff, { body: 'Hi both, I am looking into this.', caseId });
    expect(res.status).toBe(201);
    expect(res.body.authorLabel).toBe('You');
    const customer = tokens.customer(o.customerId!);
    const msgs = await h.call('GET', `${STORE}/conversations/${t.id}/messages`, customer);
    expect(msgs.body.items.map((m: any) => [m.kind, m.body])).toEqual([
      ['text', 'Hi both, I am looking into this.'],
      ['system', 'Marketly Support joined the conversation from case CS-261009-0042'],
      ['text', 'Hello, my duvet is torn'],
    ]);
    expect(msgs.body.items[0].authorLabel).toBe('Ana, Marketly Support');
    expect(h.named('messaging.message.sent').at(-1)).toMatchObject({ authorKind: 'staff', recipientKinds: ['customer', 'seller'] });
    expect(h.audits.at(-1)).toMatchObject({ action: 'messaging.message.staff_post' });
    // staff messages do not change the seller's reply state
    const header = await h.call('GET', `${STORE}/conversations/${t.id}`, customer);
    expect(header.body.replyState).toBe('awaiting_seller');
    expect(header.body.participants.map((p: any) => p.kind)).toContain('staff');
    const second = await h.call('POST', `${ADMIN}/conversations/${t.id}/messages`, staff, { body: 'Update soon.' });
    expect(second.status).toBe(201);
    const count = (await h.call('GET', `${STORE}/conversations/${t.id}/messages`, customer)).body.items.filter((m: any) => m.kind === 'system').length;
    expect(count).toBe(1);
    // the admin search finds it by case
    expect((await h.call('GET', `${ADMIN}/conversations?caseId=${caseId}`, tokens.staff())).body.items.map((c: any) => c.id)).toEqual([t.id]);
  });
});

describe('admin: moderation', () => {
  it('hides a message, locks and unlocks a conversation', async () => {
    const o = await placeOrder(h);
    const t = await thread(o);
    const mod = tokens.staff(['messaging.conversations.moderate']);
    const hide = await h.call('POST', `${ADMIN}/messages/${t.messageId}/hide`, mod, { reason: 'Abusive language' });
    expect(hide.status).toBe(200);
    expect(hide.body).toMatchObject({ hidden: true, hiddenReason: 'Abusive language', body: 'Hello, my duvet is torn' });
    const sellerView = await h.call('GET', `${SELLER}/conversations/${t.id}/messages`, tokens.seller(o.sellerA));
    expect(sellerView.body.items[0]).toMatchObject({ hidden: true, body: '', hiddenReason: expect.stringContaining('Removed by Marketly') });
    expect(h.audits.at(-1)).toMatchObject({ action: 'messaging.message.hide', reason: 'Abusive language' });

    const lock = await h.call('POST', `${ADMIN}/conversations/${t.id}/lock`, mod, { locked: true, reason: 'Fraud investigation' });
    expect(lock.status).toBe(200);
    expect(lock.body).toMatchObject({ status: 'locked', lockedReason: 'Fraud investigation' });
    expect(h.named('messaging.conversation.locked').at(-1)).toEqual({ conversationId: t.id, reason: 'Fraud investigation', lockedBy: expect.objectContaining({ kind: 'staff' }), trustEnforcementId: null, customerId: o.customerId, sellerId: o.sellerA });
    const customer = tokens.customer(o.customerId!);
    const send = await h.call('POST', `${STORE}/conversations/${t.id}/messages`, customer, { body: 'Hello?' });
    expect(send.status).toBe(409);
    expect(send.body.error).toMatchObject({ code: 'CONVERSATION_LOCKED', details: { reason: 'Fraud investigation' } });
    expect((await h.call('POST', `${ADMIN}/conversations/${t.id}/messages`, tokens.staff(), { body: 'x' })).status).toBe(409);
    // still readable
    const header = await h.call('GET', `${STORE}/conversations/${t.id}`, customer);
    expect(header.body).toMatchObject({ status: 'locked', canSend: false });
    expect((await h.call('POST', `${ADMIN}/conversations/${t.id}/lock`, mod, { locked: true, reason: 'again' })).body.error.code).toBe('ILLEGAL_TRANSITION');
    expect((await h.call('GET', `${ADMIN}/conversations?filter=locked&orderId=${o.order.id}`, tokens.staff())).body.items).toHaveLength(1);
    const unlock = await h.call('POST', `${ADMIN}/conversations/${t.id}/lock`, mod, { locked: false, reason: 'Cleared' });
    expect(unlock.body.status).toBe('open');
    expect(h.named('messaging.conversation.unlocked').at(-1)).toEqual({ conversationId: t.id, reason: 'Cleared', unlockedBy: expect.objectContaining({ kind: 'staff' }), trustEnforcementId: null });
    expect((await h.call('POST', `${STORE}/conversations/${t.id}/messages`, customer, { body: 'Hello?' })).status).toBe(201);
    expect((await h.call('POST', `${ADMIN}/messages/${newId()}/hide`, mod, { reason: 'x' })).status).toBe(404);
  });

  it('decides message reports: hide, lock, refer to trust, dismiss', async () => {
    const o = await placeOrder(h);
    const t = await thread(o);
    const seller = tokens.seller(o.sellerA);
    const customer = tokens.customer(o.customerId!);
    const m1 = await h.call('POST', `${SELLER}/conversations/${t.id}/messages`, seller, { body: 'You are an idiot' });
    const m2 = await h.call('POST', `${SELLER}/conversations/${t.id}/messages`, seller, { body: 'Pay me by bank transfer instead' });
    const m3 = await h.call('POST', `${SELLER}/conversations/${t.id}/messages`, seller, { body: 'Ok then' });
    const r1 = (await h.call('POST', `${STORE}/messages/${m1.body.id}/report`, customer, { reason: 'abusive' })).body.reportId;
    const r2 = (await h.call('POST', `${STORE}/messages/${m2.body.id}/report`, customer, { reason: 'off_platform_contact' })).body.reportId;
    const r3 = (await h.call('POST', `${STORE}/messages/${m3.body.id}/report`, customer, { reason: 'other' })).body.reportId;
    const mod = tokens.staff(['messaging.conversations.moderate'], { name: 'Mo D' });

    const open = await h.call('GET', `${ADMIN}/reports?status=open`, mod);
    expect(open.body.items.map((r: any) => r.id)).toEqual(expect.arrayContaining([r1, r2, r3]));
    expect(open.body.items.find((r: any) => r.id === r1)).toMatchObject({ reason: 'abusive', status: 'open', message: { body: 'You are an idiot' }, reporter: { kind: 'customer', id: o.customerId }, subject: { orderId: o.order.id } });

    const d1 = await h.call('POST', `${ADMIN}/reports/${r1}/decide`, mod, { action: 'hide_message', reason: 'Insult' });
    expect(d1.status).toBe(200);
    expect(d1.body).toMatchObject({ status: 'actioned', outcome: 'Message hidden: Insult', decidedBy: { kind: 'staff' }, message: { hidden: true } });
    const d2 = await h.call('POST', `${ADMIN}/reports/${r2}/decide`, mod, { action: 'refer_to_trust', reason: 'Off-platform payment' });
    expect(d2.body).toMatchObject({ status: 'actioned', outcome: expect.stringContaining('Referred to Trust and Risk (TR-261009-0001)') });
    expect(h.signals.at(-1)).toMatchObject({ detector: 'messaging.report', dedupeKey: `messaging:report:${m2.body.id}`, subjects: expect.arrayContaining([expect.objectContaining({ type: 'seller', id: o.sellerA })]) });
    const d3 = await h.call('POST', `${ADMIN}/reports/${r3}/decide`, mod, { action: 'dismiss', reason: 'Not a violation' });
    expect(d3.body.status).toBe('dismissed');
    const twice = await h.call('POST', `${ADMIN}/reports/${r3}/decide`, mod, { action: 'hide_message', reason: 'x' });
    expect(twice.status).toBe(409);
    expect(twice.body.error.code).toBe('ILLEGAL_TRANSITION');
    expect(h.audits.filter((a) => a.action === 'messaging.report.decide')).toHaveLength(3);

    const r4 = (await h.call('POST', `${STORE}/messages/${m3.body.id}/report`, customer, { reason: 'abusive' })).body.reportId;
    const d4 = await h.call('POST', `${ADMIN}/reports/${r4}/decide`, mod, { action: 'lock_conversation', reason: 'Repeated abuse' });
    expect(d4.body.status).toBe('actioned');
    expect((await h.call('GET', `${STORE}/conversations/${t.id}`, customer)).body.status).toBe('locked');
    expect((await h.call('GET', `${ADMIN}/conversations?filter=reported&orderId=${o.order.id}`, tokens.staff())).body.items[0].reportCount).toBe(4);
    expect((await h.service.customerConversationSummaries([o.customerId!]))[o.customerId!]).toMatchObject({ conversationCount: 1, openCount: 0, reportedCount: 1 });
  });
});
