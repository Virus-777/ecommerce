/** Product questions and answers labelled Seller, Marketly staff or Customer. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { ADMIN, boot, type Kit, offer, product, seller, SELLER, STORE, tokens } from './helpers.js';

let k: Kit;
beforeAll(async () => {
  k = await boot();
});
afterAll(async () => {
  await k.app.close();
});
beforeEach(() => k.reset());

const ask = (productId: string, customerId = newId(), text = 'Does the stand tilt and swivel?') => k.call('POST', `${STORE}/products/${productId}/questions`, tokens.customer(customerId), { text });

describe('questions', () => {
  it('publishes a question, tells sellers through reviews.question.asked and shows who usually answers', async () => {
    const p = product(k);
    offer(k, p.productId, { ownerType: 'official' });
    const q = await ask(p.productId);
    expect(q.status, JSON.stringify(q.body)).toBe(201);
    expect(q.body).toMatchObject({ productId: p.productId, productTitle: 'Kestrel 27" monitor', askedBy: 'Sam R.', status: 'published', answers: [], answerCount: 0, answerExpectation: 'The Official Store usually answers within 1 business day.' });
    expect(k.of('reviews.question.asked')).toEqual([{ questionId: q.body.id, productId: p.productId }]);
    const list = await k.call('GET', `${STORE}/products/${p.productId}/questions`, tokens.visitor());
    expect(list.body.items.map((x: any) => x.id)).toEqual([q.body.id]);
  });

  it('sends order questions to order messages and holds questions with links', async () => {
    const p = product(k);
    const order = await ask(p.productId, newId(), 'Where is my order MK-261009-12345? It is late.');
    expect(order.status).toBe(400);
    expect(order.body.error.details.issues[0].message).toMatch(/order messages/);
    const held = await ask(p.productId, newId(), 'Is it cheaper at www.othershop.com than here?');
    expect(held.body.status).toBe('pending_review');
    expect(k.of('reviews.question.asked')).toEqual([]);
    expect((await k.call('GET', `${STORE}/products/${p.productId}/questions`, tokens.visitor())).body.items).toEqual([]);
    expect((await ask(newId())).status).toBe(404);
  });
});

describe('answers', () => {
  it('labels answers from customers, the seller and Marketly staff', async () => {
    const s = seller(k, 'Northwind Audio');
    const p = product(k);
    offer(k, p.productId, { sellerId: s });
    const q = await ask(p.productId);
    const c = await k.call('POST', `${STORE}/questions/${q.body.id}/answers`, tokens.customer(newId()), { text: 'Yes, it tilts about 20 degrees.' });
    expect(c.status).toBe(201);
    expect(c.body).toMatchObject({ label: 'customer', status: 'published', by: { kind: 'customer', displayName: 'Sam R.' } });
    const sa = await k.call('POST', `${SELLER}/questions/${q.body.id}/answers`, tokens.seller(s), { text: 'It tilts and swivels; height adjusts by 10 cm.' });
    expect(sa.body).toMatchObject({ label: 'seller', by: { kind: 'seller', displayName: 'Northwind Audio', sellerId: s } });
    const staffId = newId();
    const st = await k.call('POST', `${ADMIN}/questions/${q.body.id}/answers`, tokens.staff(staffId), { text: 'Marketly confirms: VESA 100 mount included.' });
    expect(st.body).toMatchObject({ label: 'marketly_staff', status: 'published', by: { kind: 'staff', displayName: 'Marketly staff' } });
    expect(k.audits).toEqual([expect.objectContaining({ action: 'reviews.answer.staff', category: 'content', target: expect.objectContaining({ type: 'question', id: q.body.id }) })]);
    expect(k.of('reviews.answer.published').map((e) => e.label)).toEqual(['customer', 'seller', 'marketly_staff']);
    const list = await k.call('GET', `${STORE}/products/${p.productId}/questions`, tokens.visitor());
    expect(list.body.items[0]).toMatchObject({ answerCount: 3, answerExpectation: null });
    expect((await k.call('GET', `${STORE}/products/${p.productId}/rating-summary`, tokens.visitor())).body.answeredQuestions).toBe(1);
  });

  it('refuses sellers without an offer (NOT_AN_OFFER_SELLER) and the asker answering their own question', async () => {
    const p = product(k);
    const asker = newId();
    const q = await ask(p.productId, asker);
    const res = await k.call('POST', `${SELLER}/questions/${q.body.id}/answers`, tokens.seller(seller(k)), { text: 'We sell it too.' });
    expect([res.status, res.body.error.code]).toEqual([403, 'NOT_AN_OFFER_SELLER']);
    expect((await k.call('POST', `${STORE}/questions/${q.body.id}/answers`, tokens.customer(asker), { text: 'Answering myself' })).status).toBe(400);
    expect((await k.call('POST', `${STORE}/questions/${newId()}/answers`, tokens.customer(newId()), { text: 'Hello there' })).status).toBe(404);
  });

  it('holds answers with medical claims and staff answers asking for a second check', async () => {
    const p = product(k);
    const q = await ask(p.productId);
    const med = await k.call('POST', `${STORE}/questions/${q.body.id}/answers`, tokens.customer(newId()), { text: 'This lamp cures depression in a week.' });
    expect(med.body).toMatchObject({ status: 'pending_review' });
    const second = await k.call('POST', `${ADMIN}/questions/${q.body.id}/answers`, tokens.staff(), { text: 'Use the included cable only.', secondCheck: true });
    expect(second.body.status).toBe('pending_review');
    expect(k.of('reviews.answer.published')).toEqual([]);
    const queue = await k.call('GET', `${ADMIN}/moderation-items?queue=qa_check&contentType=answer`, tokens.staff());
    expect(queue.body.items.map((i: any) => i.contentId).sort()).toEqual([med.body.id, second.body.id].sort());
    expect(queue.body.items.find((i: any) => i.contentId === med.body.id)).toMatchObject({ contextText: 'Does the stand tilt and swivel?', reasons: ['medical_claim'] });
  });

  it('counts helpful votes on answers', async () => {
    const p = product(k);
    const q = await ask(p.productId);
    const a = await k.call('POST', `${STORE}/questions/${q.body.id}/answers`, tokens.customer(newId()), { text: 'Yes it does, both ways.' });
    const v = await k.call('POST', `${STORE}/votes`, tokens.customer(newId()), { targetType: 'answer', targetId: a.body.id, helpful: true });
    expect(v.body).toEqual({ helpfulCount: 1 });
  });
});

describe('seller and staff lists', () => {
  it('lists questions on the seller’s products, open ones first', async () => {
    const s = seller(k);
    const p = product(k);
    offer(k, p.productId, { sellerId: s });
    const other = product(k);
    await ask(other.productId);
    const q1 = await ask(p.productId);
    const q2 = await ask(p.productId, newId(), 'What is the refresh rate exactly?');
    await k.call('POST', `${SELLER}/questions/${q1.body.id}/answers`, tokens.seller(s), { text: 'It tilts and swivels.' });
    const open = await k.call('GET', `${SELLER}/questions`, tokens.seller(s));
    expect(open.body.items.map((r: any) => r.question.id)).toEqual([q2.body.id]);
    expect(open.body.items[0]).toMatchObject({ needsAnswer: true, offerSku: 'SKU-1', productImage: { url: 'https://cdn.example/p.jpg' } });
    const answered = await k.call('GET', `${SELLER}/questions?state=answered`, tokens.seller(s));
    expect(answered.body.items.map((r: any) => r.question.id)).toEqual([q1.body.id]);
    expect((await k.call('GET', `${SELLER}/questions?state=all`, tokens.seller(newId()))).body.items).toEqual([]);
  });

  it('lists unanswered questions on Official Store products for staff, oldest first', async () => {
    const official = product(k);
    offer(k, official.productId, { ownerType: 'official' });
    const s = seller(k);
    offer(k, official.productId, { sellerId: s });
    const marketplace = product(k);
    offer(k, marketplace.productId, { sellerId: s });
    const q1 = await ask(official.productId);
    await ask(marketplace.productId);
    const q2 = await ask(official.productId, newId(), 'Is the power supply internal?');
    await k.call('POST', `${STORE}/questions/${q2.body.id}/answers`, tokens.customer(newId()), { text: 'Yes, internal supply.' });
    const res = await k.call('GET', `${ADMIN}/questions?owner=official`, tokens.staff());
    res.body.items = res.body.items.filter((r: any) => [official.productId, marketplace.productId].includes(r.question.productId));
    expect(res.body.items.map((r: any) => r.question.id)).toEqual([q1.body.id, q2.body.id]);
    expect(res.body.items[0]).toMatchObject({ owner: 'both', needsAnswer: true, hasSellerAnswer: false, hasStaffAnswer: false, waiting: expect.any(String) });
    expect(res.body.items[1]).toMatchObject({ needsAnswer: false, waiting: null });
    const unanswered = await k.call('GET', `${ADMIN}/questions?owner=official&answered=false&productId=${official.productId}`, tokens.staff());
    expect(unanswered.body.items.map((r: any) => r.question.id)).toEqual([q1.body.id]);
    const total = await k.svc.listProductQuestions(official.productId, null, { page: 1, limit: 1 });
    expect(total.total).toBe(2);
  });
});
