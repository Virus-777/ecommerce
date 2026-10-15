/**
 * Wave 2 (web team requests): review keyword search (G6), per-viewer flags (G25a, G25b), answered / awaiting
 * questions (G25c), seller slug on the review context (G18), sellers skipping questions (G56b), the feedback target
 * (G56d) and the decision on decided moderation items (G74).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { ADMIN, boot, type Kit, offer, order, product, reviewInput, seller, SELLER, STORE, tokens } from './helpers.js';

let k: Kit;
beforeAll(async () => {
  k = await boot();
});
afterAll(() => k.app.close());
beforeEach(() => k.reset());

async function review(productId: string, over: Record<string, unknown> = {}, sellerId: string | null = null) {
  const customerId = newId();
  const ord = order(k, customerId, [{ sellerId, lines: [{ productId }] }]);
  const res = await k.call('POST', `${STORE}/me/reviews`, tokens.customer(customerId), reviewInput(ord.itemIds[0]!, over));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return { customerId, reviewId: res.body.review.id as string, itemId: ord.itemIds[0]! };
}

const ask = async (productId: string, text = 'Does the stand tilt and swivel?') => {
  const res = await k.call('POST', `${STORE}/products/${productId}/questions`, tokens.customer(newId()), { text });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
};

describe('product reviews', () => {
  it('searches the headline, text and name with q (G6)', async () => {
    const p = product(k);
    await review(p.productId, { headline: 'Great monitor', text: 'Sharp panel and the stand is sturdy, colours look accurate out of the box.' });
    const b = await review(p.productId, { headline: 'Buzzing noise', text: 'There is a faint coil whine at high refresh rates, otherwise the panel is fine.' });
    const res = await k.call('GET', `${STORE}/products/${p.productId}/reviews?q=coil%20WHINE`, tokens.visitor());
    expect(res.body.items.map((r: any) => r.id)).toEqual([b.reviewId]);
    expect((await k.call('GET', `${STORE}/products/${p.productId}/reviews?q=nothing-like-this`, tokens.visitor())).body.items).toEqual([]);
  });

  it('says whether the signed-in customer reported a review (G25a)', async () => {
    const p = product(k);
    const r = await review(p.productId);
    const reader = newId();
    const before = await k.call('GET', `${STORE}/products/${p.productId}/reviews`, tokens.customer(reader));
    expect(before.body.items[0].viewerReported).toBe(false);
    await k.call('POST', `${STORE}/reports`, tokens.customer(reader), { targetType: 'product_review', targetId: r.reviewId, reason: 'off_topic' });
    const after = await k.call('GET', `${STORE}/products/${p.productId}/reviews`, tokens.customer(reader));
    expect(after.body.items[0].viewerReported).toBe(true);
    expect((await k.call('GET', `${STORE}/products/${p.productId}/reviews`, tokens.visitor())).body.items[0].viewerReported).toBeNull();
  });

  it('gives the seller slug on the review context, null for the Official Store (G18)', async () => {
    const s = seller(k, 'Northwind Audio');
    const p = product(k);
    const customerId = newId();
    const ord = order(k, customerId, [{ sellerId: s, lines: [{ productId: p.productId }] }, { sellerId: null, lines: [{ productId: product(k).productId }] }]);
    const ctx = await k.call('GET', `${STORE}/me/review-context/${ord.itemIds[0]}`, tokens.customer(customerId));
    expect(ctx.body.seller).toMatchObject({ ownerType: 'seller', id: s, slug: 'nw' });
    const official = await k.call('GET', `${STORE}/me/review-context/${ord.itemIds[1]}`, tokens.customer(customerId));
    expect(official.body.seller).toMatchObject({ ownerType: 'official', slug: null });
  });
});

describe('questions', () => {
  it('filters answered and awaiting questions, counts the awaiting ones and flags the viewer’s helpful votes (G25b, G25c)', async () => {
    const p = product(k);
    const answered = await ask(p.productId);
    const waiting = await ask(p.productId, 'Is there a USB-C port with power delivery?');
    const answer = await k.call('POST', `${STORE}/questions/${answered}/answers`, tokens.customer(newId()), { text: 'Yes, it tilts about 20 degrees.' });
    const voter = newId();
    await k.call('POST', `${STORE}/votes`, tokens.customer(voter), { targetType: 'answer', targetId: answer.body.id, helpful: true });
    const ids = async (state: string) => (await k.call('GET', `${STORE}/products/${p.productId}/questions?state=${state}`, tokens.visitor())).body.items.map((q: any) => q.id);
    expect(await ids('answered')).toEqual([answered]);
    expect(await ids('awaiting')).toEqual([waiting]);
    expect((await k.call('GET', `${STORE}/products/${p.productId}/rating-summary`, tokens.visitor())).body).toMatchObject({ answeredQuestions: 1, awaitingQuestions: 1 });
    const mine = await k.call('GET', `${STORE}/products/${p.productId}/questions?state=answered`, tokens.customer(voter));
    expect(mine.body.items[0].answers[0].viewerVotedHelpful).toBe(true);
    const other = await k.call('GET', `${STORE}/products/${p.productId}/questions?state=answered`, tokens.customer(newId()));
    expect(other.body.items[0].answers[0].viewerVotedHelpful).toBe(false);
    expect((await k.call('GET', `${STORE}/products/${p.productId}/questions?state=answered`, tokens.visitor())).body.items[0].answers[0].viewerVotedHelpful).toBeNull();
  });

  it('lets a seller skip a question and put it back (G56b)', async () => {
    const s = seller(k);
    const p = product(k);
    offer(k, p.productId, { sellerId: s });
    const q = await ask(p.productId);
    const open = async () => (await k.call('GET', `${SELLER}/questions`, tokens.seller(s))).body.items.map((r: any) => r.question.id);
    expect(await open()).toEqual([q]);
    const skipped = await k.call('POST', `${SELLER}/questions/${q}/skip`, tokens.seller(s));
    expect(skipped.status, JSON.stringify(skipped.body)).toBe(200);
    expect(skipped.body).toMatchObject({ skipped: true, needsAnswer: false });
    expect((await k.call('POST', `${SELLER}/questions/${q}/skip`, tokens.seller(s))).status).toBe(200);
    expect(await open()).toEqual([]);
    const list = await k.call('GET', `${SELLER}/questions?state=skipped`, tokens.seller(s));
    expect(list.body.items).toEqual([expect.objectContaining({ skipped: true })]);
    // shoppers still see it and other sellers are unaffected
    expect((await k.call('GET', `${STORE}/products/${p.productId}/questions`, tokens.visitor())).body.items).toHaveLength(1);
    const back = await k.call('DELETE', `${SELLER}/questions/${q}/skip`, tokens.seller(s));
    expect(back.body).toMatchObject({ skipped: false, needsAnswer: true });
    expect(await open()).toEqual([q]);
    // a seller without an offer on the product can't skip it
    expect((await k.call('POST', `${SELLER}/questions/${q}/skip`, tokens.seller(seller(k, 'Other')))).status).toBe(404);
  });
});

describe('feedback summary target (G56d)', () => {
  it('carries the target and whether the seller meets it', async () => {
    const s = seller(k, 'Target Store');
    const empty = await k.call('GET', `${SELLER}/feedback-summary`, tokens.seller(s));
    expect(empty.body.target).toEqual({ positivePct: 95, label: 'Target: at least 95% positive', meets: null });
    const customerId = newId();
    const ord = order(k, customerId, [{ sellerId: s, lines: [{ productId: product(k).productId }] }], 2);
    await k.call('POST', `${STORE}/me/feedback`, tokens.customer(customerId), { orderId: ord.orderId, sellerId: s, asDescribed: true, dispatchRating: 5, communicationRating: 5 });
    const res = await k.call('GET', `${STORE}/sellers/${s}/feedback-summary`, tokens.visitor());
    expect(res.body.target).toMatchObject({ positivePct: 95, meets: true });
  });
});

describe('decided moderation items (G74)', () => {
  it('carry the decision: outcome, reason, who and when', async () => {
    const p = product(k);
    const r = await review(p.productId);
    await k.call('POST', `${STORE}/reports`, tokens.customer(newId()), { targetType: 'product_review', targetId: r.reviewId, reason: 'personal_information' });
    const item = (await k.call('GET', `${ADMIN}/moderation-items`, tokens.staff())).body.items.find((i: any) => i.contentId === r.reviewId);
    expect(item.decision).toBeNull();
    const staffId = newId();
    const d = await k.call('POST', `${ADMIN}/moderation-items/${item.id}/decide`, tokens.staff(staffId), { decision: 'remove', reasonCode: 'personal_information' });
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    const decided = (await k.call('GET', `${ADMIN}/moderation-items?status=decided`, tokens.staff())).body.items.find((i: any) => i.id === item.id);
    expect(decided.decision).toMatchObject({ outcome: 'remove', outcomeLabel: 'Removed', reasonCode: 'personal_information', reason: expect.any(String), by: { kind: 'staff', id: staffId }, at: expect.any(String) });
  });
});
