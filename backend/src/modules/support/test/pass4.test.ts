/**
 * Gap pass 4: case facts in columns, goodwill remedies matched on their grant id, escalated → escalated, guest
 * viewers of Order.cases and the customer data export hook.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { spec } from '../../../spec/support.js';
import { schemas } from '../infra/mongo/schema.js';
import { harness, idem, reportProblem, sellerOrder, tokens, USD, type Harness } from './helpers.js';

let h: Harness;
let hw: Harness;
beforeAll(async () => {
  h = await harness();
  hw = await harness({ wallet: true });
});
afterAll(async () => {
  await h?.app.close();
  await hw?.app.close();
});

const raw = async (x: Harness, id: string) => (await x.app.kernel.mongo.module('support', spec.collections, schemas).table<Record<string, any>>('cases').get(id))!;

describe('case facts in columns', () => {
  it('stores what the customer asked for, the seller reply, information requests and escalations in columns', async () => {
    const o = await sellerOrder(h);
    const opened = await h.call('POST', '/api/store/support/cases', tokens.customer(o.customerId), { kind: 'order_problem', category: 'item_damaged', orderId: o.order.id, orderItemIds: [o.itemId], problemType: 'damaged', message: 'Cracked', desiredRemedy: 'replacement', replyChannel: 'phone', callbackPhone: ' +1 503 555 0100 ' }, idem());
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    const id = opened.body.id as string;
    let row = await raw(h, id);
    expect(row).toMatchObject({ problem_type: 'damaged', desired_remedy: 'replacement', callback_phone: '+1 503 555 0100', customer_name: 'Sam Rivera', contact_email: 'sam@example.com', order_ref: o.order.ref, owner_type: 'seller', seller_name: 'Casa Verde Home', city: 'Portland', appeal_window_closed: false, approval_request_id: null });
    expect(row.next_action).not.toHaveProperty('facts');
    expect(row.next_action).toMatchObject({ whoMustAct: 'seller' });

    expect((await h.call('POST', `/api/seller/support/cases/${id}/messages`, tokens.seller(o.sellerId), { body: 'Sorry, checking' })).status).toBe(200);
    row = await raw(h, id);
    expect(row.seller_replied_at).toBeInstanceOf(Date);

    const due = new Date(h.clock.now().getTime() + 86_400_000).toISOString();
    expect((await h.call('POST', `/api/admin/support/cases/${id}/request-info`, tokens.staff(), { from: 'customer', question: 'A photo please', dueAt: due })).status).toBe(200);
    row = await raw(h, id);
    expect(row).toMatchObject({ info_request_from: 'customer', info_request_question: 'A photo please' });
    expect(row.info_request_due_at.toISOString()).toBe(due);
    // the customer's answer closes the information request
    expect((await h.call('POST', `/api/store/support/cases/${id}/messages`, tokens.customer(o.customerId), { body: 'Here it is' })).status).toBe(200);
    row = await raw(h, id);
    expect(row.info_request_from).toBeNull();

    const admin = await h.call('GET', `/api/admin/support/cases/${id}`, tokens.staff());
    expect(admin.body.customer).toMatchObject({ name: 'Sam Rivera', asksFor: 'Replacement', location: 'Portland' });
    // search reads the columns
    const found = await h.call('GET', `/api/admin/support/cases?q=${encodeURIComponent(o.order.ref)}`, tokens.staff());
    expect(found.body.items.map((c: { id: string }) => c.id)).toContain(id);
  });

  it('an escalated case can be escalated again to another team (escalated → escalated)', async () => {
    const o = await sellerOrder(h);
    const opened = await reportProblem(h, { customerId: o.customerId, orderId: o.order.id, itemIds: [o.itemId] });
    const id = opened.body.id as string;
    const first = await h.call('POST', `/api/admin/support/cases/${id}/escalate`, tokens.staff(), { to: 'returns', reason: 'Return needed', convertToDispute: true });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.case).toMatchObject({ status: 'escalated', kind: 'dispute' });
    const second = await h.call('POST', `/api/admin/support/cases/${id}/escalate`, tokens.staff(), { to: 'finance', reason: 'Refund above the limit' });
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body.case.status).toBe('escalated');
    expect(second.body.team).toBe('Finance');
    const row = await raw(h, id);
    expect(row).toMatchObject({ escalated_to: 'finance', escalation_reason: 'Refund above the limit' });
    expect(JSON.parse(row.escalated_by)).toMatchObject({ kind: 'staff' });
    // the customer cannot ask a second time
    expect((await h.call('POST', `/api/store/support/cases/${id}/escalate`, tokens.customer(o.customerId), { reason: 'other' })).status).toBe(409);
  });
});

describe('goodwill remedies keep their grant id', () => {
  it('wallet.goodwill.decided completes the remedy of that grant, not the oldest one of the same amount', async () => {
    const o = await sellerOrder(hw, { price: 4900 });
    const opened = await reportProblem(hw, { customerId: o.customerId, orderId: o.order.id, itemIds: [o.itemId] });
    const id = opened.body.id as string;
    expect((await hw.call('POST', `/api/admin/support/cases/${id}/escalate`, tokens.staff(), { to: 'support_lead', reason: 'Late', convertToDispute: true })).status).toBe(200);
    const decided = await hw.call('POST', `/api/admin/support/cases/${id}/decide`, tokens.staff(), { outcome: 'customer_favored', remedies: [{ kind: 'goodwill_credit', amount: USD(1000) }, { kind: 'goodwill_credit', amount: USD(1000) }], reason: 'Sorry', notifyParties: true }, idem());
    expect(decided.status, JSON.stringify(decided.body)).toBe(200);
    const [g1, g2] = hw.calls.goodwill.slice(-2);
    const remedies = (await hw.service.core.load(id))!.remedies;
    expect(remedies.map((r) => r.goodwill_grant_id)).toEqual([g1!.id, g2!.id]);
    await hw.publish('wallet', 'wallet.goodwill.decided', { grantId: g2!.id, customerId: g2!.customerId, status: 'granted', amount: g2!.amount, caseId: id });
    const after = (await hw.service.core.load(id))!.remedies;
    expect(after.find((r) => r.goodwill_grant_id === g2!.id)!.status).toBe('completed');
    expect(after.find((r) => r.goodwill_grant_id === g1!.id)!.status).toBe('pending_approval');
    // matched by grant id even without the case id
    await hw.publish('wallet', 'wallet.goodwill.decided', { grantId: g1!.id, customerId: g1!.customerId, status: 'rejected', amount: g1!.amount, caseId: null });
    expect((await hw.service.core.load(id))!.remedies.find((r) => r.goodwill_grant_id === g1!.id)!.status).toBe('cancelled');
  });
});

describe('Order.cases for guests (listCasesForOrder)', () => {
  it('a guest session sees the cases of a guest order identity granted it; nobody else does', async () => {
    const o = await sellerOrder(h, { customerId: null });
    const opened = await h.call('POST', '/api/admin/support/cases', tokens.staff(), { kind: 'order_problem', category: 'item_damaged', orderId: o.order.id, orderItemIds: [o.itemId], subject: 'Damaged', message: 'Broken' });
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    const session = newId();
    expect(await h.service.listCasesForOrder(o.order.id, { area: 'store', guestSessionId: session })).toEqual([]);
    h.guestGrants.add(`${session}:${o.order.id}`);
    expect((await h.service.listCasesForOrder(o.order.id, { area: 'store', guestSessionId: session })).map((c) => c.id)).toEqual([opened.body.case.id]);
    expect(await h.service.listCasesForOrder(o.order.id, { area: 'store' })).toEqual([]);
    expect(await h.service.listCasesForOrder(o.order.id, { area: 'store', customerId: newId() })).toEqual([]);
  });
});

describe('exportCustomerData', () => {
  it("exports the customer's cases with the messages they can see (no internal notes or seller-only messages)", async () => {
    const o = await sellerOrder(h);
    const opened = await reportProblem(h, { customerId: o.customerId, orderId: o.order.id, itemIds: [o.itemId], message: 'It arrived cracked' });
    const id = opened.body.id as string;
    expect((await h.call('POST', `/api/admin/support/cases/${id}/messages`, tokens.staff(), { body: 'Internal: check the seller', audience: 'internal' })).status).toBe(200);
    expect((await h.call('POST', `/api/admin/support/cases/${id}/messages`, tokens.staff(), { body: 'Seller only: send tracking', audience: 'seller' })).status).toBe(200);
    expect((await h.call('POST', `/api/admin/support/cases/${id}/messages`, tokens.staff(), { body: 'We are on it', audience: 'all' })).status).toBe(200);
    const sections = await h.service.exportCustomerData({ customerId: o.customerId, accountId: o.customerId });
    expect(sections).toHaveLength(1);
    expect(sections[0]).toMatchObject({ key: 'support-cases', module: 'support', attachmentIds: [] });
    const [rec] = sections[0]!.records as any[];
    expect(rec).toMatchObject({ ref: opened.body.ref, orderRef: o.order.ref, problemType: 'damaged', askedFor: 'refund' });
    const texts = rec.messages.map((m: { text: string }) => m.text);
    expect(texts).toContain('It arrived cracked');
    expect(texts).toContain('We are on it');
    expect(texts.join(' ')).not.toMatch(/Internal|Seller only/);
    expect(rec.messages.find((m: { text: string }) => m.text === 'It arrived cracked').from).toBe('You');
    expect(await h.service.exportCustomerData({ customerId: newId(), accountId: newId() })).toEqual([{ key: 'support-cases', title: 'Help cases', module: 'support', records: [], attachmentIds: [] }]);
  });
});
