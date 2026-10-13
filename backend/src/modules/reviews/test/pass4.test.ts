/**
 * Pass 4: seller summaries keep overall_sum (the average comes from the summary row), referrals to Trust and Risk have
 * their own table (no fake 'refer' decisions), and helpful votes of a closed account stay counted without the customer id.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { spec } from '../../../spec/reviews.js';
import { schemas } from '../schema.js';
import { ADMIN, boot, type Kit, order, product, reviewInput, seller, STORE, tokens } from './helpers.js';

let k: Kit;
beforeAll(async () => {
  k = await boot();
});
afterAll(() => k.app.close());
beforeEach(() => k.reset());

const table = (name: string) => k.app.kernel.mongo.module('reviews', spec.collections, schemas).table<any>(name);

async function published() {
  const customerId = newId();
  const sellerId = seller(k, 'Gadget Grove');
  const p = product(k);
  const ord = order(k, customerId, [{ sellerId, lines: [{ productId: p.productId }] }]);
  const res = await k.call('POST', `${STORE}/me/reviews`, tokens.customer(customerId), reviewInput(ord.itemIds[0]!, { rating: 2 }));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return { customerId, sellerId, reviewId: res.body.review.id as string, ...p, ...ord };
}

async function feedback(sellerId: string, dispatchRating: number) {
  const customerId = newId();
  const p = product(k);
  const ord = order(k, customerId, [{ sellerId, lines: [{ productId: p.productId }] }], 2);
  const res = await k.call('POST', `${STORE}/me/feedback`, tokens.customer(customerId), { orderId: ord.orderId, sellerId, asDescribed: true, dispatchRating, communicationRating: dispatchRating, comment: 'Ok' });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.feedback;
}

describe('seller summaries', () => {
  it('keep overall_sum; the average is overall_sum / count', async () => {
    const s = seller(k, 'Sum Store');
    const a = await feedback(s, 5);
    const b = await feedback(s, 2);
    const row = await table('seller_feedback_summaries').get(s);
    expect(row).toMatchObject({ count: 2, overall_sum: a.overall + b.overall });
    const summary = await k.call('GET', `${STORE}/sellers/${s}/feedback-summary`, tokens.visitor());
    expect(summary.body.average).toBe(Math.round(((a.overall + b.overall) / 2) * 10) / 10);
    expect(k.of('reviews.rating.changed').at(-1)).toMatchObject({ sellerId: s, count: 2, average: summary.body.average });
  });
});

describe('referrals', () => {
  it('a referral is a referrals row, not a moderation decision; the history shows it', async () => {
    const r = await published();
    await k.call('POST', `${STORE}/reports`, tokens.customer(newId()), { targetType: 'product_review', targetId: r.reviewId, reason: 'fake_or_paid' });
    const item = (await k.call('GET', `${ADMIN}/moderation-items?status=open`, tokens.staff())).body.items.find((i: any) => i.contentId === r.reviewId);
    const staffId = newId();
    const res = await k.call('POST', `${ADMIN}/moderation-items/${item.id}/refer`, tokens.staff(staffId), { note: 'Burst of reviews' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.history.find((h: any) => h.label === 'Referred to Trust and Risk')).toMatchObject({ detail: 'Burst of reviews' });
    expect(res.body.previousDecision ?? null).toBeNull();
    expect(await table('referrals').find({ moderation_item_id: item.id })).toEqual([
      expect.objectContaining({ content_type: 'product_review', content_id: r.reviewId, author_id: r.customerId, note: 'Burst of reviews' }),
    ]);
    expect(await table('moderation_decisions').find({ moderation_item_id: item.id })).toEqual([]);
  });
});

describe('helpful votes after closure', () => {
  it('stay counted under a random id', async () => {
    const r = await published();
    const voter = newId();
    expect((await k.call('POST', `${STORE}/votes`, tokens.customer(voter), { targetType: 'product_review', targetId: r.reviewId, helpful: true })).body).toEqual({ helpfulCount: 1 });
    await k.emit('customers', 'customers.account.closed', { customerId: voter, userId: voter });
    const votes = await table('helpful_votes').find({ target_id: r.reviewId });
    expect(votes).toHaveLength(1);
    expect(votes[0].customer_id).not.toBe(voter);
    const list = await k.call('GET', `${STORE}/products/${r.productId}/reviews`, tokens.visitor());
    expect(list.body.items[0].helpfulCount).toBe(1);
  });
});
