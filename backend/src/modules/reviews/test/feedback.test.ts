/** Seller feedback per package, kept apart from product reviews, and the 12-month seller summary. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { resolvers } from '../graphql/resolvers.js';
import { boot, DAY, type Kit, OFFICIAL_STORE_ID, order, product, reviewInput, seller, SELLER, STORE, tokens } from './helpers.js';

let k: Kit;
beforeAll(async () => {
  k = await boot();
});
afterAll(async () => {
  await k.app.close();
});
beforeEach(() => k.reset());

function delivered(sellerId: string | null, o: { deliveredDaysAgo?: number; delivered?: boolean; arrivalTo?: string } = {}) {
  const customerId = newId();
  const p = product(k);
  const ord = order(k, customerId, [{ sellerId, lines: [{ productId: p.productId, delivered: o.delivered ?? true }], ...(o.arrivalTo ? { arrivalTo: o.arrivalTo } : {}) }], o.deliveredDaysAgo ?? 2);
  return { customerId, token: tokens.customer(customerId), ...p, ...ord };
}

const input = (orderId: string, sellerId: string, over: Record<string, unknown> = {}) => ({ orderId, sellerId, asDescribed: true, dispatchRating: 5, communicationRating: 4, comment: 'Well packed and quick.', ...over });

describe('leaving feedback', () => {
  it('publishes feedback for a delivered package and updates the seller summary', async () => {
    const s = seller(k, 'Gadget Grove');
    const b = delivered(s);
    const res = await k.call('POST', `${STORE}/me/feedback`, b.token, input(b.orderId, s));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ status: 'published', statusLabel: 'Published', canEdit: true, canDelete: true });
    expect(res.body.feedback).toMatchObject({ sellerId: s, sellerName: 'Gadget Grove', overall: 5, sentiment: 'positive', dimensions: { asDescribed: true, dispatchRating: 5, communicationRating: 4 }, orderRef: b.ref, packageLabel: 'Package 1 of 1', itemTitle: 'Kestrel 27" monitor' });
    expect(k.of('reviews.feedback.published')).toEqual([{ feedbackId: res.body.feedback.id, sellerId: s, orderId: b.orderId, sentiment: 'positive' }]);
    expect(k.of('reviews.rating.changed')).toEqual([{ productId: null, sellerId: s, average: 5, count: 1 }]);
    const summary = await k.call('GET', `${STORE}/sellers/${s}/feedback-summary`, tokens.visitor());
    expect(summary.body).toEqual({ sellerId: s, official: false, periodMonths: 12, count: 1, positivePct: 100, neutralPct: 0, negativePct: 0, asDescribedPct: 100, avgDispatch: 5, avgCommunication: 4, label: '100% positive · 1 rating', average: 5, onTimeDispatchPct: 95, target: { positivePct: 95, label: 'Target: at least 95% positive', meets: true } });
    // never on the product page
    expect((await k.call('GET', `${STORE}/products/${b.productId}/rating-summary`, tokens.visitor())).body.ratingCount).toBe(0);
  });

  it('caps the overall score when the item was not as described and counts it negative', async () => {
    const s = seller(k);
    const b = delivered(s);
    const res = await k.call('POST', `${STORE}/me/feedback`, b.token, input(b.orderId, s, { asDescribed: false, communicationRating: null }));
    expect(res.body.feedback).toMatchObject({ overall: 2, sentiment: 'negative' });
    const summary = await k.svc.getSellerFeedbackSummary(s);
    expect(summary).toMatchObject({ count: 1, negativePct: 100, asDescribedPct: 0, avgCommunication: null, label: '0% positive · 1 rating' });
  });

  it('opens only after delivery (FEEDBACK_NOT_YET_AVAILABLE) and once per package (ALREADY_REVIEWED)', async () => {
    const s = seller(k);
    const notYet = delivered(s, { delivered: false });
    const r1 = await k.call('POST', `${STORE}/me/feedback`, notYet.token, input(notYet.orderId, s));
    expect([r1.status, r1.body.error.code]).toEqual([422, 'FEEDBACK_NOT_YET_AVAILABLE']);
    expect(r1.body.error.details.availableFrom).toEqual(expect.any(String));

    const late = delivered(s, { delivered: false, arrivalTo: new Date(k.clock.now().getTime() - 2 * DAY).toISOString().slice(0, 10) });
    expect((await k.call('POST', `${STORE}/me/feedback`, late.token, input(late.orderId, s))).status).toBe(201);

    const b = delivered(s);
    const first = await k.call('POST', `${STORE}/me/feedback`, b.token, input(b.orderId, s));
    const again = await k.call('POST', `${STORE}/me/feedback`, b.token, input(b.orderId, s));
    expect([again.status, again.body.error.code, again.body.error.details.id]).toEqual([409, 'ALREADY_REVIEWED', first.body.feedback.id]);

    const old = delivered(s, { deliveredDaysAgo: 120 });
    expect((await k.call('POST', `${STORE}/me/feedback`, old.token, input(old.orderId, s))).body.error.code).toBe('REVIEW_NOT_ELIGIBLE');
    expect((await k.call('POST', `${STORE}/me/feedback`, tokens.customer(newId()), input(b.orderId, s))).status).toBe(404);
  });

  it('feedbackSummariesForSellers answers every id as getSellerFeedbackSummary does, in one batch', async () => {
    const good = seller(k);
    const poor = seller(k);
    const none = seller(k);
    const g = delivered(good);
    expect((await k.call('POST', `${STORE}/me/feedback`, g.token, input(g.orderId, good))).status).toBe(201);
    const p = delivered(poor);
    expect((await k.call('POST', `${STORE}/me/feedback`, p.token, input(p.orderId, poor, { asDescribed: false }))).status).toBe(201);
    const ids = [good, poor, none, OFFICIAL_STORE_ID, 'not-a-seller', good];

    const batch = await k.svc.feedbackSummariesForSellers(ids);
    expect([...batch.keys()]).toEqual([good, poor, none, OFFICIAL_STORE_ID, 'not-a-seller']);
    for (const id of ids) expect(batch.get(id)).toEqual(await k.svc.getSellerFeedbackSummary(id));
    expect(batch.get(good)).toMatchObject({ count: 1, positivePct: 100 });
    expect(batch.get(poor)).toMatchObject({ count: 1, negativePct: 100 });
    expect(batch.get(none)).toMatchObject({ sellerId: none, count: 0, positivePct: null, label: 'No feedback yet' });

    // dispatch: false: the same summaries without shipping's on-time dispatch
    const quick = await k.svc.feedbackSummariesForSellers(ids, { dispatch: false });
    for (const id of ids) expect(quick.get(id)).toEqual({ ...batch.get(id), onTimeDispatchPct: null });
    expect(await k.svc.feedbackSummariesForSellers([])).toEqual(new Map());
  });

  it('takes Official Store feedback under the Official Store id', async () => {
    const b = delivered(null);
    const res = await k.call('POST', `${STORE}/me/feedback`, b.token, input(b.orderId, OFFICIAL_STORE_ID));
    expect(res.status).toBe(201);
    expect(res.body.feedback).toMatchObject({ sellerId: OFFICIAL_STORE_ID, sellerName: 'Marketly Official Store' });
    const summary = await k.call('GET', `${STORE}/sellers/${OFFICIAL_STORE_ID}/feedback-summary`, tokens.visitor());
    expect(summary.body).toMatchObject({ sellerId: OFFICIAL_STORE_ID, official: true, count: expect.any(Number) });
    const ratings = await k.svc.getOfferSellerRatings([{ offerId: 'o1', ownerType: 'official', sellerId: null }]);
    expect(ratings.o1).toMatchObject({ official: true, sellerId: OFFICIAL_STORE_ID });
  });

  it('saves a draft, checks the ratings on submit, edits and deletes', async () => {
    const s = seller(k);
    const b = delivered(s);
    const draft = await k.call('POST', `${STORE}/me/feedback`, b.token, input(b.orderId, s, { draft: true, dispatchRating: 0 }));
    expect(draft.body.status).toBe('draft');
    const bad = await k.call('PATCH', `${STORE}/me/feedback/${draft.body.feedback.id}`, b.token, { draft: false });
    expect(bad.status).toBe(400);
    const sent = await k.call('PATCH', `${STORE}/me/feedback/${draft.body.feedback.id}`, b.token, { draft: false, dispatchRating: 3, communicationRating: 3 });
    expect(sent.body).toMatchObject({ status: 'published', feedback: { overall: 3, sentiment: 'neutral' } });
    const edited = await k.call('PATCH', `${STORE}/me/feedback/${draft.body.feedback.id}`, b.token, { dispatchRating: 5, communicationRating: 5 });
    expect(edited.body.feedback).toMatchObject({ overall: 5, sentiment: 'positive', editedAt: expect.any(String) });
    expect((await k.call('PATCH', `${STORE}/me/feedback/${draft.body.feedback.id}`, tokens.customer(newId()), { dispatchRating: 1 })).status).toBe(404);
    k.reset();
    expect((await k.call('DELETE', `${STORE}/me/feedback/${draft.body.feedback.id}`, b.token)).status).toBe(204);
    expect(k.of('reviews.feedback.removed')).toEqual([{ feedbackId: draft.body.feedback.id, sellerId: s }]);
    expect((await k.svc.getSellerFeedbackSummary(s)).count).toBe(0);
  });
});

describe('lists', () => {
  it('shows feedback publicly (no order reference), to the seller with respond/report flags, and to the author', async () => {
    const s = seller(k, 'Casa Verde Home');
    const b1 = delivered(s);
    const b2 = delivered(s);
    await k.call('POST', `${STORE}/me/feedback`, b1.token, input(b1.orderId, s));
    await k.call('POST', `${STORE}/me/feedback`, b2.token, input(b2.orderId, s, { dispatchRating: 1, communicationRating: 1, comment: 'Slow.' }));
    const pub = await k.call('GET', `${STORE}/sellers/${s}/feedback?sentiment=negative`, tokens.visitor());
    expect(pub.body.items).toHaveLength(1);
    expect(pub.body.items[0]).toMatchObject({ sentiment: 'negative', orderRef: null, packageLabel: null, comment: 'Slow.' });
    const own = await k.call('GET', `${SELLER}/feedback?needsResponse=true`, tokens.seller(s));
    expect(own.body.items).toHaveLength(2);
    expect(own.body.items[0]).toMatchObject({ canRespond: true, canReport: true, feedback: { orderRef: expect.stringMatching(/^MK-/) } });
    const other = await k.call('GET', `${SELLER}/feedback`, tokens.seller(newId()));
    expect(other.body.items).toEqual([]);
    const mine = await k.call('GET', `${STORE}/me/feedback`, b1.token);
    expect(mine.body.items.map((x: any) => x.feedback.orderId)).toEqual([b1.orderId]);
    const summary = await k.call('GET', `${SELLER}/feedback-summary`, tokens.seller(s));
    expect(summary.body).toMatchObject({ count: 2, positivePct: 50, negativePct: 50, average: 3 });
    const gql = resolvers(k.svc);
    const ctx = { principal: null } as any;
    const page = await (gql.Seller!.feedback as any)({ id: s }, { sentiment: 'POSITIVE' }, ctx);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ sentiment: 'POSITIVE', asDescribed: true, dispatchRating: 5 });
    expect(await page.items[0].orderRef()).toBeNull();
    const rating = await (gql.Seller!.rating as any)({ id: s }, {}, ctx);
    expect(rating).toMatchObject({ count: 2, positivePct: 50 });
  });

  it('rolls the 12-month window in the summaries job and announces the change', async () => {
    const s = seller(k);
    const b = delivered(s);
    await k.call('POST', `${STORE}/me/feedback`, b.token, input(b.orderId, s));
    k.reset();
    k.clock.advance(400 * DAY);
    await k.app.kernel.jobs.runNow('reviews.summaries');
    await k.app.kernel.events.drain();
    expect(k.of('reviews.rating.changed')).toContainEqual({ productId: null, sellerId: s, average: null, count: 0 });
    expect((await k.svc.getSellerFeedbackSummary(s)).label).toBe('No feedback yet');
    k.clock.advance(-400 * DAY);
    await k.app.kernel.jobs.runNow('reviews.summaries');
  });

  it('keeps feedback separate from product reviews in the pending list', async () => {
    const s = seller(k);
    const b = delivered(s);
    await k.call('POST', `${STORE}/me/reviews`, b.token, reviewInput(b.itemIds[0]!));
    const pending = await k.call('GET', `${STORE}/me/pending`, b.token);
    expect(pending.body.products).toEqual([]);
    expect(pending.body.sellerFeedback).toHaveLength(1);
    await k.call('POST', `${STORE}/me/feedback`, b.token, input(b.orderId, s));
    expect((await k.call('GET', `${STORE}/me/pending`, b.token)).body.sellerFeedback).toEqual([]);
    const status = await k.svc.reviewStatusForItems(b.customerId, [b.itemIds[0]!]);
    expect(status[0]).toMatchObject({ feedbackEligible: false, feedbackGiven: true });
  });
});
