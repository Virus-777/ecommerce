/**
 * A customer's order problem with real orders and returns: the problem form, the case handled by the seller
 * first, record scope, the seller's offer, the refund through Finance (returns) and payments, resolve and reopen.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { DAY, harness, idem, reportProblem, sellerOrder, tokens, USD, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h?.app.close();
});

describe('contact options and the problem form', () => {
  it('lists customer topics, channels and the seller-first note to anyone', async () => {
    const res = await h.call('GET', '/api/store/support/contact-options', tokens.visitor());
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.topics.map((t: { key: string }) => t.key)).toContain('item_damaged');
    expect(res.body.topics.every((t: { audience: string }) => t.audience === 'customer')).toBe(true);
    expect(res.body.channels.map((c: { kind: string }) => c.kind)).toEqual(['messages', 'email', 'chat', 'phone']);
    expect(res.body.sellerFirstNote).toMatch(/seller answers first/);
  });

  it('prepares the order problem form with the item preselected and who handles it first', async () => {
    const o = await sellerOrder(h);
    const res = await h.call('GET', `/api/store/support/orders/${o.order.id}/problem-context?orderItemId=${o.itemId}`, tokens.customer(o.customerId));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.preselectedItemIds).toEqual([o.itemId]);
    expect(res.body.handledFirstBy).toMatchObject({ kind: 'seller', supportFollowing: true });
    expect(res.body.problemTypes).toEqual(expect.arrayContaining(['damaged', 'wrong_item', 'missing_item', 'other']));
    expect(res.body.sellerReplyDueAt).toBeTruthy();
    expect(res.body.packages[0].items[0]).toMatchObject({ orderItemId: o.itemId, ownerType: 'seller', sellerName: 'Casa Verde Home' });
    expect(res.body.remedyChoices[0]).toMatchObject({ kind: 'refund', amount: USD(4900) });
  });

  it("hides another customer's order", async () => {
    const o = await sellerOrder(h);
    const res = await h.call('GET', `/api/store/support/orders/${o.order.id}/problem-context`, tokens.customer(newId()));
    expect(res.status).toBe(404);
  });

  it('validates the topic and the items', async () => {
    const o = await sellerOrder(h);
    const tok = tokens.customer(o.customerId);
    const noTopic = await h.call('POST', '/api/store/support/cases', tok, { kind: 'customer_help', category: 'nope', message: 'Help' }, idem());
    expect(noTopic.status).toBe(400);
    expect(noTopic.body.error.details.issues[0].path).toBe('category');
    const noItems = await h.call('POST', '/api/store/support/cases', tok, { kind: 'order_problem', category: 'item_damaged', orderId: o.order.id, message: 'Broken' }, idem());
    expect(noItems.status).toBe(400);
    const foreign = await h.call('POST', '/api/store/support/cases', tok, { kind: 'order_problem', category: 'item_damaged', orderId: o.order.id, orderItemIds: [newId()], message: 'Broken' }, idem());
    expect(foreign.status).toBe(400);
  });
});

describe('an order problem about a seller item', () => {
  let o: Awaited<ReturnType<typeof sellerOrder>>;
  let caseId: string;
  let ref: string;

  it('opens with the item identified and goes to the seller first', async () => {
    o = await sellerOrder(h, { price: 4900 });
    const res = await reportProblem(h, { customerId: o.customerId, orderId: o.order.id, itemIds: [o.itemId] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    caseId = res.body.id;
    ref = res.body.ref;
    expect(ref).toMatch(/^CS-\d{6}-\d{4}$/);
    expect(res.body).toMatchObject({ kind: 'order_problem', status: 'waiting_on_seller', statusLabel: 'Waiting on seller', handledBy: { kind: 'seller', supportFollowing: true } });
    expect(res.body.nextAction).toMatchObject({ whoMustAct: 'seller', youNeedToAct: false, note: 'If they miss it, Marketly steps in' });
    expect(res.body.expectedResponse.dueAt).toBeTruthy();
    expect(res.body.items[0]).toMatchObject({ orderItemId: o.itemId, title: 'Linen Throw', sellerName: 'Casa Verde Home' });
    expect(res.body.order).toMatchObject({ id: o.order.id, ref: o.order.ref });
    expect(res.body.can).toMatchObject({ reply: true, escalate: false, appeal: false, reopen: false });
    const opened = h.named('support.case.opened').find((e) => e.caseId === caseId);
    expect(opened).toMatchObject({ ref, kind: 'order_problem', category: 'item_damaged', customerId: o.customerId, contactEmail: 'sam@example.com', sellerId: o.sellerId, orderId: o.order.id, orderItemIds: [o.itemId], handler: 'seller' });
  });

  it('refuses a second case for the same item (DUPLICATE_CASE with the open case)', async () => {
    const res = await reportProblem(h, { customerId: o.customerId, orderId: o.order.id, itemIds: [o.itemId] });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'DUPLICATE_CASE', details: { caseId, ref } });
  });

  it('is only visible to its customer and its seller', async () => {
    expect((await h.call('GET', `/api/store/support/cases/${caseId}`, tokens.customer(o.customerId))).status).toBe(200);
    expect((await h.call('GET', `/api/store/support/cases/${caseId}`, tokens.customer(newId()))).status).toBe(404);
    expect((await h.call('GET', `/api/seller/support/cases/${caseId}`, tokens.seller(o.sellerId))).status).toBe(200);
    expect((await h.call('GET', `/api/seller/support/cases/${caseId}`, tokens.seller(newId()))).status).toBe(404);
    const reply = await h.call('POST', `/api/seller/support/cases/${caseId}/messages`, tokens.seller(newId()), { body: 'Not mine' });
    expect(reply.status).toBe(404);
  });

  it('lists the case for the customer and the seller', async () => {
    const mine = await h.call('GET', '/api/store/support/cases?state=open', tokens.customer(o.customerId));
    expect(mine.status).toBe(200);
    expect(mine.body.items).toHaveLength(1);
    expect(mine.body.items[0]).toMatchObject({ id: caseId, open: true, orderRef: o.order.ref, status: 'waiting_on_seller' });
    expect(mine.body.items[0].expectedReply).toMatch(/^By /);
    const seller = await h.call('GET', '/api/seller/support/cases?scope=customer_cases', tokens.seller(o.sellerId));
    expect(seller.body.items.map((r: { id: string }) => r.id)).toEqual([caseId]);
    expect(seller.body.items[0]).toMatchObject({ marketplaceInvolved: true, orderRef: o.order.ref, nextAction: { whoMustAct: 'seller', youNeedToAct: true } });
    expect((await h.service.listOpenCasesForCustomer(o.customerId, 3)).total).toBe(1);
    expect(await h.service.casesForOrder(o.order.id)).toEqual([{ caseId, ref, status: 'waiting_on_seller', orderItemIds: [o.itemId] }]);
  });

  it('does not let the customer escalate while the seller is within its deadline', async () => {
    const res = await h.call('POST', `/api/store/support/cases/${caseId}/escalate`, tokens.customer(o.customerId), { reason: 'seller_no_reply' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ESCALATION_NOT_AVAILABLE');
    expect(res.body.error.details.availableFrom).toBeTruthy();
  });

  it('the seller replies with a partial refund offer; the customer is asked to answer', async () => {
    const bad = await h.call('POST', `/api/seller/support/cases/${caseId}/messages`, tokens.seller(o.sellerId), { body: 'Sorry!', offer: { kind: 'partial_refund' } });
    expect(bad.status).toBe(400);
    const res = await h.call('POST', `/api/seller/support/cases/${caseId}/messages`, tokens.seller(o.sellerId), { body: 'Sorry about that. We can refund part of it.', offer: { kind: 'partial_refund', amount: USD(2000), note: 'Keep the item' } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe('open');
    expect(res.body.offers).toHaveLength(1);
    expect(res.body.offers[0]).toMatchObject({ from: 'seller', kind: 'partial_refund', amount: USD(2000), status: 'open' });
    const view = await h.call('GET', `/api/store/support/cases/${caseId}`, tokens.customer(o.customerId));
    expect(view.body.nextAction).toMatchObject({ whoMustAct: 'customer', youNeedToAct: true });
    expect(view.body.can).toMatchObject({ respondToOffer: true, escalate: true });
    expect(h.named('support.case.message_added').find((e) => e.caseId === caseId && e.authorRole === 'seller')).toMatchObject({ customerId: o.customerId, contactEmail: 'sam@example.com', sellerId: o.sellerId, audience: 'all' });
  });

  it('accepting the offer creates a refund request in returns (Finance approves; approved is not sent)', async () => {
    const view = await h.call('GET', `/api/store/support/cases/${caseId}`, tokens.customer(o.customerId));
    const offerId = view.body.offers[0].id;
    const res = await h.call('POST', `/api/store/support/cases/${caseId}/offers/${offerId}/respond`, tokens.customer(o.customerId), { accept: true, note: 'OK, thanks' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.offers[0].status).toBe('accepted');
    expect(res.body.remedies).toHaveLength(1);
    const remedy = res.body.remedies[0];
    expect(remedy).toMatchObject({ kind: 'partial_refund', amount: USD(2000), chargedTo: 'seller', status: 'pending_approval', track: ['Requested', 'Approved', 'Processing', 'Sent'], currentStep: 0 });
    expect(remedy.refundRequestId).toBeTruthy();
    expect(h.named('returns.refund.requested').some((e) => e.refundRequestId === remedy.refundRequestId)).toBe(true);
    const again = await h.call('POST', `/api/store/support/cases/${caseId}/offers/${offerId}/respond`, tokens.customer(o.customerId), { accept: true });
    expect(again.status).toBe(409);
    expect(await h.service.hasUnresolvedRemedy(caseId)).toBe(true);
  });

  it('cannot be resolved while the refund is unresolved (REMEDY_PENDING)', async () => {
    const res = await h.call('POST', `/api/admin/support/cases/${caseId}/resolve`, tokens.staff(), { summary: 'Refunded' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('REMEDY_PENDING');
    expect(res.body.error.details.remedies[0].status).toBe('pending_approval');
  });

  it('follows Finance approval and the payment: approved → processing → sent', async () => {
    const view = await h.call('GET', `/api/admin/support/cases/${caseId}`, tokens.staff());
    const rrId = view.body.case.remedies[0].refundRequestId;
    const approved = await h.call('POST', `/api/admin/returns/refunds/${rrId}/approve`, tokens.staff(), { note: 'Seller-funded' }, idem());
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    let c = await h.call('GET', `/api/store/support/cases/${caseId}`, tokens.customer(o.customerId));
    expect(c.body.remedies[0]).toMatchObject({ status: 'in_progress', statusLabel: 'Processing', currentStep: 2 });
    expect(h.calls.refunds.at(-1)).toMatchObject({ origin: 'case', originId: rrId });
    await h.publish('payments', 'payments.refund.sent', { refundId: newId(), ref: 'RF-9', orderId: o.order.id, origin: 'case', originId: rrId, amount: USD(2000), items: [{ orderItemId: o.itemId, title: 'Linen Throw', groupId: o.order.groups[0]!.id, sellerId: o.sellerId, amount: USD(2000) }], destination: 'Visa •••• 4417', sentAt: h.clock.now().toISOString() });
    c = await h.call('GET', `/api/store/support/cases/${caseId}`, tokens.customer(o.customerId));
    expect(c.body.remedies[0]).toMatchObject({ status: 'completed', statusLabel: 'Sent', currentStep: 3 });
    expect(await h.service.hasUnresolvedRemedy(caseId)).toBe(false);
  });

  it('resolves, then the customer reopens within the window', async () => {
    const resolved = await h.call('POST', `/api/admin/support/cases/${caseId}/resolve`, tokens.staff(), { summary: 'Partial refund sent' });
    expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
    expect(resolved.body.case).toMatchObject({ status: 'resolved', can: expect.any(Object) });
    expect(resolved.body.case.reopenUntil).toBeTruthy();
    expect(h.named('support.case.resolved').find((e) => e.caseId === caseId)).toMatchObject({ ref, sellerId: o.sellerId, customerId: o.customerId, contactEmail: 'sam@example.com' });
    expect(h.audits.some((a) => a.action === 'support.case.resolve' && a.target.id === caseId)).toBe(true);
    const replyClosed = await h.call('POST', `/api/store/support/cases/${caseId}/messages`, tokens.customer(o.customerId), { body: 'Hello?' });
    expect(replyClosed.status).toBe(409);
    const view = await h.call('GET', `/api/store/support/cases/${caseId}`, tokens.customer(o.customerId));
    expect(view.body.can.reopen).toBe(true);
    const reopened = await h.call('POST', `/api/store/support/cases/${caseId}/reopen`, tokens.customer(o.customerId), { reason: 'The money never arrived' });
    expect(reopened.status, JSON.stringify(reopened.body)).toBe(200);
    expect(reopened.body).toMatchObject({ status: 'reopened', handledBy: { kind: 'marketplace_support' } });
    expect(h.named('support.case.reopened').find((e) => e.caseId === caseId)).toMatchObject({ reason: 'The money never arrived' });
  });

  it('refuses a reopen after the window (REOPEN_WINDOW_CLOSED)', async () => {
    const resolved = await h.call('POST', `/api/admin/support/cases/${caseId}/resolve`, tokens.staff(), { summary: 'Checked with the bank: it arrived' });
    expect(resolved.status).toBe(200);
    h.clock.advance(31 * DAY);
    const res = await h.call('POST', `/api/store/support/cases/${caseId}/reopen`, tokens.customer(o.customerId), { reason: 'Again' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('REOPEN_WINDOW_CLOSED');
    expect(res.body.error.details.reopenUntil).toBeTruthy();
    const staff = await h.call('POST', `/api/admin/support/cases/${caseId}/reopen`, tokens.staff(), { reason: 'Customer called' });
    expect(staff.status).toBe(200);
    expect(staff.body.case.status).toBe('reopened');
  });
});

describe('the customer and the case conversation', () => {
  it('a customer reply to an information request puts the case back with whoever handles it', async () => {
    const o = await sellerOrder(h);
    const opened = await reportProblem(h, { customerId: o.customerId, orderId: o.order.id, itemIds: [o.itemId], category: 'wrong_item', problemType: 'wrong_item' });
    const id = opened.body.id;
    const ask = await h.call('POST', `/api/admin/support/cases/${id}/request-info`, tokens.staff(), { from: 'customer', question: 'Please send a photo of the label', dueAt: new Date(h.clock.now().getTime() + 2 * DAY).toISOString() });
    expect(ask.status, JSON.stringify(ask.body)).toBe(200);
    expect(ask.body.case.status).toBe('waiting_on_customer');
    const store = await h.call('GET', `/api/store/support/cases/${id}`, tokens.customer(o.customerId));
    expect(store.body).toMatchObject({ statusLabel: 'Waiting on you', nextAction: { whoMustAct: 'customer', youNeedToAct: true } });
    expect(store.body.messages.at(-1)).toMatchObject({ role: 'marketly_staff', audience: 'customer', body: 'Please send a photo of the label' });
    const seller = await h.call('GET', `/api/seller/support/cases/${id}`, tokens.seller(o.sellerId));
    expect(seller.body.messages.some((m: { body: string }) => m.body === 'Please send a photo of the label')).toBe(false);
    const reply = await h.call('POST', `/api/store/support/cases/${id}/messages`, tokens.customer(o.customerId), { body: 'Here it is' });
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    expect(reply.body.status).toBe('waiting_on_seller');
  });

  it('never shows internal notes on store or seller endpoints', async () => {
    const o = await sellerOrder(h);
    const id = (await reportProblem(h, { customerId: o.customerId, orderId: o.order.id, itemIds: [o.itemId] })).body.id;
    const note = await h.call('POST', `/api/admin/support/cases/${id}/messages`, tokens.staff(), { body: 'Seller has a history of this', audience: 'internal' });
    expect(note.status).toBe(200);
    expect(note.body.case.messages.some((m: { role: string }) => m.role === 'internal_note')).toBe(true);
    const store = await h.call('GET', `/api/store/support/cases/${id}`, tokens.customer(o.customerId));
    const seller = await h.call('GET', `/api/seller/support/cases/${id}`, tokens.seller(o.sellerId));
    for (const v of [store.body, seller.body]) expect(v.messages.some((m: { audience: string }) => m.audience === 'internal')).toBe(false);
    expect(h.named('support.case.message_added').some((e) => e.caseId === id && e.audience === 'internal')).toBe(false);
  });

  it('a guest with access to the order opens and reads a case; another session gets 404', async () => {
    const o = await sellerOrder(h, { customerId: null });
    const guest = tokens.visitor();
    const session = JSON.parse(Buffer.from(guest.split('.')[1]!, 'base64url').toString()).sid as string;
    h.guestGrants.add(`${session}:${o.order.id}`);
    const res = await h.call('POST', '/api/store/support/cases', guest, { kind: 'order_problem', category: 'item_damaged', orderId: o.order.id, orderItemIds: [o.itemId], problemType: 'damaged', message: 'Broken' }, idem());
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    // guests are reached through the order's contact email
    expect(h.named('support.case.opened').find((e) => e.caseId === res.body.id)).toMatchObject({ customerId: null, contactEmail: 'gia@example.com' });
    expect((await h.call('GET', `/api/store/support/cases/${res.body.id}`, guest)).status).toBe(200);
    expect((await h.call('GET', `/api/store/support/cases/${res.body.id}`, tokens.visitor())).status).toBe(404);
    const g = await h.service.getCaseForCustomer(null, session, res.body.ref);
    expect(g?.id).toBe(res.body.id);
  });
});
