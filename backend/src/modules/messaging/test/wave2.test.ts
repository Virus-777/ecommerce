/**
 * Wave 2: pre-sale conversations about a product (decision G4), the item summary on order subjects (G45b), seller
 * conversations about a return (G55b) and the per-viewer "already reported" flag on messages (G56a).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { OFFICIAL_STORE_ID } from '../../../spec/common.js';
import { harness, placeOrder, SELLER, STORE, tokens, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h.app.close();
});

/** A live offer the product page shows */
function liveOffer(o: { sellerId?: string | null; official?: boolean; status?: string } = {}) {
  const id = newId();
  const sellerId = o.official ? null : (o.sellerId ?? newId());
  if (sellerId) h.sellers.set(sellerId, { storeName: 'Casa Verde Home' });
  h.liveOffers.set(id, { id, ownerType: o.official ? 'official' : 'seller', sellerId, sellerName: o.official ? 'Marketly Official Store' : 'Casa Verde Home', productId: newId(), title: 'Linen duvet cover', status: o.status ?? 'active' });
  return { offerId: id, sellerId, productId: h.liveOffers.get(id)!.productId };
}

describe('pre-sale conversations (G4)', () => {
  it('a signed-in customer messages the seller about a product; the seller answers from its inbox', async () => {
    const customer = newId();
    const me = tokens.customer(customer);
    const offer = liveOffer();
    const res = await h.call('POST', `${STORE}/product-conversations`, me, { offerId: offer.offerId, body: 'Does it come in king size? Mail me at sam@example.com' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const c = res.body.conversation;
    expect(c).toMatchObject({ kind: 'order', replyState: 'awaiting_seller', canSend: true, counterparty: { kind: 'seller', id: offer.sellerId }, subject: { kind: 'product', productId: offer.productId, orderId: null, title: 'Linen duvet cover (catalog)', imageUrl: 'https://cdn.example/duvet.jpg' } });
    // the same contact-detail filter as order messages
    expect(res.body.message.redactions).toContain('contact_details');
    expect(res.body.message.body).not.toContain('sam@example.com');

    // the seller sees it in its inbox and replies
    const seller = tokens.seller(offer.sellerId!);
    const inbox = await h.call('GET', `${SELLER}/conversations`, seller);
    expect(inbox.body.items.map((x: any) => x.id)).toContain(c.id);
    const reply = await h.call('POST', `${SELLER}/conversations/${c.id}/messages`, seller, { body: 'Yes, king size is in stock.' });
    expect(reply.status, JSON.stringify(reply.body)).toBe(201);
    expect((await h.call('GET', `${STORE}/conversations/${c.id}`, me)).body.replyState).toBe('replied');

    // asking again appends to the same conversation; another seller never sees it
    const again = await h.call('POST', `${STORE}/product-conversations`, me, { offerId: offer.offerId, body: 'And in teal?' });
    expect(again.body.conversation.id).toBe(c.id);
    expect((await h.call('GET', `${SELLER}/conversations/${c.id}`, tokens.seller(newId()))).status).toBe(404);
  });

  it('is for signed-in customers and live offers only; the Official Store answers its own offers', async () => {
    const offer = liveOffer();
    expect((await h.call('POST', `${STORE}/product-conversations`, tokens.visitor(), { offerId: offer.offerId, body: 'Hi' })).status).toBeGreaterThanOrEqual(401);
    const removed = liveOffer({ status: 'removed' });
    expect((await h.call('POST', `${STORE}/product-conversations`, tokens.customer(newId()), { offerId: removed.offerId, body: 'Hi' })).status).toBe(404);
    expect((await h.call('POST', `${STORE}/product-conversations`, tokens.customer(newId()), { offerId: newId(), body: 'Hi' })).status).toBe(404);

    const official = liveOffer({ official: true });
    const res = await h.call('POST', `${STORE}/product-conversations`, tokens.customer(newId()), { offerId: official.offerId, body: 'Is this the 2026 model?' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.conversation.counterparty).toMatchObject({ kind: 'official_store' });
    expect(h.named('messaging.message.sent').at(-1)).toMatchObject({ officialStore: true, sellerId: OFFICIAL_STORE_ID, orderId: null });
  });

  it('limits new pre-sale conversations per customer and day; replies are not limited', async () => {
    const customer = newId();
    const me = tokens.customer(customer);
    let first: string | null = null;
    for (let i = 0; i < 10; i++) {
      const r = await h.call('POST', `${STORE}/product-conversations`, me, { offerId: liveOffer().offerId, body: `Question ${i}` });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      first ??= r.body.conversation.id;
    }
    const over = await h.call('POST', `${STORE}/product-conversations`, me, { offerId: liveOffer().offerId, body: 'One more' });
    expect(over.status).toBe(429);
    expect(over.body.error).toMatchObject({ code: 'RATE_LIMITED', details: { retryAfterSeconds: expect.any(Number) } });
    expect((await h.call('POST', `${STORE}/conversations/${first}/messages`, me, { body: 'Still there?' })).status).toBe(201);
    // another customer is not affected
    expect((await h.call('POST', `${STORE}/product-conversations`, tokens.customer(newId()), { offerId: liveOffer().offerId, body: 'Hi' })).status).toBe(201);
  });

  it('respects a messaging restriction', async () => {
    const customer = newId();
    h.restricted.add(customer);
    const res = await h.call('POST', `${STORE}/product-conversations`, tokens.customer(customer), { offerId: liveOffer().offerId, body: 'Hi' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('MESSAGING_RESTRICTED');
  });
});

describe('order conversations: item summary (G45b) and seller conversations about a return (G55b)', () => {
  it('the subject names the items', async () => {
    const o = await placeOrder(h);
    const res = await h.call('POST', `${STORE}/conversations`, tokens.customer(o.customerId!), { with: 'seller', orderId: o.order.id, sellerId: o.sellerA, body: 'Hello' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.conversation.subject).toMatchObject({ kind: 'order', itemSummary: 'Linen duvet cover' });
  });

  it('a seller starts a conversation about a return on its items; Return.conversation finds it', async () => {
    const o = await placeOrder(h);
    const returnId = newId();
    h.returns.push({ orderItemId: o.itemA, returnId, ref: 'RT-261016-0042', status: 'Requested' });
    const seller = tokens.seller(o.sellerA);
    const res = await h.call('POST', `${SELLER}/conversations`, seller, { orderId: o.order.id, returnId, body: 'Could you send a photo of the damage?' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.conversation.subject).toMatchObject({ kind: 'return', returnId, returnRef: 'RT-261016-0042', title: 'Return RT-261016-0042' });
    const found = await h.service.getForSubject({ kind: 'return', id: returnId }, { kind: 'seller', id: o.sellerA });
    expect(found?.id).toBe(res.body.conversation.id);
    // the customer's own start about the same return lands in the same conversation
    const customer = await h.call('POST', `${STORE}/conversations`, tokens.customer(o.customerId!), { with: 'seller', orderId: o.order.id, sellerId: o.sellerA, returnId, body: 'Sure, here it is' });
    expect(customer.body.conversation.id).toBe(res.body.conversation.id);
    // another seller's return is not found
    const otherReturn = newId();
    h.returns.push({ orderItemId: o.itemB, returnId: otherReturn, ref: 'RT-261016-0043', status: 'Requested' });
    expect((await h.call('POST', `${SELLER}/conversations`, seller, { orderId: o.order.id, returnId: otherReturn, body: 'Hi' })).status).toBe(404);
  });
});

describe('messages: viewerReported (G56a)', () => {
  it('is true for the reporter only', async () => {
    const o = await placeOrder(h);
    const me = tokens.customer(o.customerId!);
    const start = await h.call('POST', `${STORE}/conversations`, me, { with: 'seller', orderId: o.order.id, sellerId: o.sellerA, body: 'Hello' });
    const id = start.body.conversation.id;
    const seller = tokens.seller(o.sellerA);
    const rude = await h.call('POST', `${SELLER}/conversations/${id}/messages`, seller, { body: 'Stop asking.' });
    const before = await h.call('GET', `${STORE}/conversations/${id}/messages`, me);
    expect(before.body.items.find((m: any) => m.id === rude.body.id).viewerReported).toBe(false);
    expect((await h.call('POST', `${STORE}/messages/${rude.body.id}/report`, me, { reason: 'abusive' })).status).toBe(201);
    const after = await h.call('GET', `${STORE}/conversations/${id}/messages`, me);
    expect(after.body.items.find((m: any) => m.id === rude.body.id).viewerReported).toBe(true);
    expect(after.body.items.find((m: any) => m.id !== rude.body.id).viewerReported).toBe(false);
    const sellerView = await h.call('GET', `${SELLER}/conversations/${id}/messages`, seller);
    expect(sellerView.body.items.every((m: any) => m.viewerReported === false)).toBe(true);
    const gql = await h.gql('store', me, `query($id: UUID!) { conversation(id: $id) { messages { items { id viewerReported } } } }`, { id });
    expect(gql.errors, JSON.stringify(gql.errors)).toBeUndefined();
    expect(gql.data.conversation.messages.items.find((m: any) => m.id === rude.body.id).viewerReported).toBe(true);
  });
});
