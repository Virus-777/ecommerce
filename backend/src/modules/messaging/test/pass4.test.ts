/**
 * Pass 4: seller reply figures in seller_reply_stats (no in-process cache), the GUEST participant kind in GraphQL,
 * customer actors carry the customer id, and refer_to_trust without trust answers TRUST_UNAVAILABLE.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { ADMIN, harness, placeOrder, SELLER, STORE, table, tokens, type Harness } from './helpers.js';

let h: Harness;
let noTrust: Harness;
beforeAll(async () => {
  h = await harness();
  noTrust = await harness({ trust: false });
});
afterAll(async () => {
  await h?.app.close();
  await noTrust?.app.close();
});

const stats = (x: Harness, sellerId: string) => table(x, 'seller_reply_stats').get(sellerId);

describe('seller_reply_stats', () => {
  it('the job rolls up 30-day reply figures; a conversation reads its seller label from the table', async () => {
    const o = await placeOrder(h);
    const start = await h.call('POST', `${STORE}/conversations`, tokens.customer(o.customerId!), { with: 'seller', orderId: o.order.id, sellerId: o.sellerA, body: 'Is it in stock?' });
    expect(start.status, JSON.stringify(start.body)).toBe(201);
    const id = start.body.conversation.id;
    h.clock.advance(3 * 3_600_000);
    expect((await h.call('POST', `${SELLER}/conversations/${id}/messages`, tokens.seller(o.sellerA), { body: 'Yes, ships today' })).status).toBe(201);
    await h.runJob('messaging.response-stats');
    const row = await stats(h, o.sellerA);
    expect(row).toMatchObject({ seller_id: o.sellerA, replied: 1, replied_within_target: 1, decided: 1, average_reply_minutes: 180, median_reply_minutes: 180 });
    const view = await h.call('GET', `${STORE}/conversations/${id}`, tokens.customer(o.customerId!));
    expect(view.body.counterparty).toMatchObject({ kind: 'seller', responseTimeLabel: 'Usually replies within 3 hours' });
  });

  it('a seller without a row is computed on first use', async () => {
    const o = await placeOrder(h);
    const start = await h.call('POST', `${STORE}/conversations`, tokens.customer(o.customerId!), { with: 'seller', orderId: o.order.id, sellerId: o.sellerA, body: 'Hello' });
    await table(h, 'seller_reply_stats').delete(o.sellerA);
    expect((await h.call('GET', `${STORE}/conversations/${start.body.conversation.id}`, tokens.customer(o.customerId!))).status).toBe(200);
    expect(await stats(h, o.sellerA)).toMatchObject({ seller_id: o.sellerA, replied: 0 });
  });
});

describe('participants', () => {
  it('GraphQL shows the buyer of a guest order as GUEST', async () => {
    const o = await placeOrder(h, { guest: true });
    const start = await h.call('POST', `${SELLER}/conversations`, tokens.seller(o.sellerA), { orderId: o.order.id, body: 'Your order ships tomorrow.' });
    expect(start.status, JSON.stringify(start.body)).toBe(201);
    const res = await h.gql('seller', tokens.seller(o.sellerA), `{ sellerConversation(id: "${start.body.conversation.id}") { participants { kind id } } }`);
    expect(res.errors).toBeUndefined();
    expect(res.data.sellerConversation.participants).toEqual(expect.arrayContaining([{ kind: 'GUEST', id: `order:${o.order.id}` }]));
  });

  it('a customer actor is the customer id: unread counts by customer id, not by account id', async () => {
    const o = await placeOrder(h);
    const start = await h.call('POST', `${SELLER}/conversations`, tokens.seller(o.sellerA), { orderId: o.order.id, body: 'A question about your order' });
    expect(start.status, JSON.stringify(start.body)).toBe(201);
    expect(await h.service.unreadCount({ kind: 'customer', id: o.customerId! })).toBeGreaterThan(0);
    expect(await h.service.unreadCount({ kind: 'customer', id: newId() })).toBe(0);
  });
});

describe('refer_to_trust without the trust module', () => {
  it('answers TRUST_UNAVAILABLE (422) and leaves the report open', async () => {
    const o = await placeOrder(noTrust);
    const start = await noTrust.call('POST', `${STORE}/conversations`, tokens.customer(o.customerId!), { with: 'seller', orderId: o.order.id, sellerId: o.sellerA, body: 'Hello' });
    const m = await noTrust.call('POST', `${SELLER}/conversations/${start.body.conversation.id}/messages`, tokens.seller(o.sellerA), { body: 'Pay me by bank transfer' });
    const reportId = (await noTrust.call('POST', `${STORE}/messages/${m.body.id}/report`, tokens.customer(o.customerId!), { reason: 'off_platform_contact' })).body.reportId;
    const res = await noTrust.call('POST', `${ADMIN}/reports/${reportId}/decide`, tokens.staff(['messaging.conversations.moderate']), { action: 'refer_to_trust', reason: 'Off-platform payment' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('TRUST_UNAVAILABLE');
    const open = await noTrust.call('GET', `${ADMIN}/reports?status=open`, tokens.staff(['messaging.conversations.moderate']));
    expect(open.body.items.map((r: { id: string }) => r.id)).toContain(reportId);
  });
});
