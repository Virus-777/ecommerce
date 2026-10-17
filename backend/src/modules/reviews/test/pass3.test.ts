/** Pass 3: one-move decisions, answer edits, trust keep/remove/reinstate, Official Store responses, SLA work items, closure and export */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { ADMIN, boot, DAY, type Kit, OFFICIAL_STORE_ID, offer, order, product, reviewInput, seller, SELLER, STORE, tokens } from './helpers.js';

let k: Kit;
beforeAll(async () => {
  k = await boot();
});
afterAll(async () => {
  await k.app.close();
});
beforeEach(() => k.reset());

async function published(o: { sellerId?: string | null; rating?: number; text?: string } = {}) {
  const customerId = newId();
  const sellerId = o.sellerId === undefined ? seller(k, 'Gadget Grove') : o.sellerId;
  const p = product(k);
  const ord = order(k, customerId, [{ sellerId, lines: [{ productId: p.productId }] }]);
  const res = await k.call('POST', `${STORE}/me/reviews`, tokens.customer(customerId), reviewInput(ord.itemIds[0]!, { rating: o.rating ?? 4, ...(o.text ? { text: o.text } : {}) }));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return { customerId, author: tokens.customer(customerId), sellerId, reviewId: res.body.review.id as string, status: res.body.status as string, ...p, ...ord };
}
const report = (token: string, targetId: string, targetType = 'product_review', reason = 'off_topic') => k.call('POST', `${STORE}/reports`, token, { targetType, targetId, reason });
const openItem = async (contentId: string) => (await k.call('GET', `${ADMIN}/moderation-items?status=open`, tokens.staff())).body.items.find((i: any) => i.contentId === contentId);
const decide = (itemId: string, body: Record<string, unknown>) => k.call('POST', `${ADMIN}/moderation-items/${itemId}/decide`, tokens.staff(), body);

describe('answers: edit requests and author edits', () => {
  it('a published answer gets an edit request in one move; the author resubmits it; a seller edits its own answer', async () => {
    const p = product(k);
    const s = seller(k, 'Northwind Audio');
    offer(k, p.productId, { sellerId: s });
    const asker = newId();
    const q = await k.call('POST', `${STORE}/products/${p.productId}/questions`, tokens.customer(asker), { text: 'Does the stand tilt and swivel?' });
    k.reset();
    const answerer = newId();
    const a = await k.call('POST', `${STORE}/questions/${q.body.id}/answers`, tokens.customer(answerer), { text: 'Yes, about 20 degrees.' });
    expect(a.body.status).toBe('published');
    // the asker is told
    expect(k.of('reviews.answer.published').at(-1)).toMatchObject({ answerId: a.body.id, askerCustomerId: asker, sellerId: null });

    await report(tokens.customer(newId()), a.body.id, 'answer', 'inaccurate');
    const item = await openItem(a.body.id);
    // bug (pass 3): published → edit_requested was missing from the Answer machine
    const req = await decide(item.id, { decision: 'request_edit', reasonCode: 'inaccurate', editRequest: 'Check the tilt angle in the manual' });
    expect(req.status, JSON.stringify(req.body)).toBe(200);
    expect(req.body.answer.status).toBe('edit_requested');

    // fix round: the author finds the answer with its edit request in Account › Reviews (GET /me/answers)
    const mine = await k.call('GET', STORE + '/me/answers', tokens.customer(answerer));
    expect(mine.status, JSON.stringify(mine.body)).toBe(200);
    expect(mine.body.items).toHaveLength(1);
    expect(mine.body.items[0]).toMatchObject({ questionId: q.body.id, questionText: 'Does the stand tilt and swivel?', productId: p.productId, canEdit: true, answer: { id: a.body.id, status: 'edit_requested' } });
    expect((await k.call('GET', STORE + '/me/answers', tokens.customer(newId()))).body.items).toHaveLength(0);

    expect((await k.call('PATCH', `${STORE}/me/answers/${a.body.id}`, tokens.customer(newId()), { text: 'Not mine' })).status).toBe(404);
    const fixed = await k.call('PATCH', `${STORE}/me/answers/${a.body.id}`, tokens.customer(answerer), { text: 'Yes, it tilts 5 to 25 degrees per the manual.' });
    expect(fixed.status, JSON.stringify(fixed.body)).toBe(200);
    // resubmitted for review
    expect(fixed.body.status).toBe('pending_review');
    expect(await openItem(a.body.id)).toMatchObject({ queue: 'qa_check' });

    const sa = await k.call('POST', `${SELLER}/questions/${q.body.id}/answers`, tokens.seller(s), { text: 'It tilts and swivels.' });
    expect(sa.body.status).toBe('published');
    const edited = await k.call('PATCH', `${SELLER}/answers/${sa.body.id}`, tokens.seller(s), { text: 'It tilts, swivels and adjusts by 10 cm.' });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body).toMatchObject({ status: 'published', text: 'It tilts, swivels and adjusts by 10 cm.' });
    expect(k.of('reviews.answer.published').at(-1)).toMatchObject({ answerId: sa.body.id, sellerId: s, askerCustomerId: asker });
    expect((await k.call('PATCH', `${SELLER}/answers/${sa.body.id}`, tokens.seller(seller(k, 'Other')), { text: 'Hijack' })).status).toBe(404);
  });

  it('an edit request on seller feedback is an illegal move (409)', async () => {
    const s = seller(k, 'Gadget Grove');
    const customerId = newId();
    const p = product(k);
    const ord = order(k, customerId, [{ sellerId: s, lines: [{ productId: p.productId }] }], 2);
    const fb = await k.call('POST', `${STORE}/me/feedback`, tokens.customer(customerId), { orderId: ord.orderId, sellerId: s, asDescribed: true, dispatchRating: 5, communicationRating: 4, comment: 'Well packed and quick.' });
    expect(fb.status, JSON.stringify(fb.body)).toBe(201);
    const rep = await report(tokens.customer(newId()), fb.body.feedback.id, 'seller_feedback');
    expect(rep.status, JSON.stringify(rep.body)).toBe(201);
    const item = await openItem(fb.body.feedback.id);
    const res = await decide(item.id, { decision: 'request_edit', reasonCode: 'off_topic', editRequest: 'x' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ILLEGAL_TRANSITION');
  });
});

describe('trust enforcement', () => {
  it('remove_reviews records the enforcement; its reversal reinstates only what it removed', async () => {
    const r = await published();
    const other = await published();
    // moderation removed the other review first: a reversal must not bring it back
    await report(tokens.customer(newId()), other.reviewId);
    await decide((await openItem(other.reviewId)).id, { decision: 'remove', reasonCode: 'off_topic' });
    const enforcementId = newId();
    const recorded = { enforcementId, reportId: newId(), action: 'remove_reviews', ownerTeam: 'reviews', targets: [{ type: 'review', id: r.reviewId, label: 'r' }, { type: 'review', id: other.reviewId, label: 'o' }], reason: 'Paid ring', params: {}, alreadyApplied: false };
    await k.emit('trust', 'trust.enforcement.recorded', recorded);
    await k.emit('trust', 'trust.enforcement.recorded', recorded);
    // both named reviews are confirmed to trust (the already-removed one too), each once
    const decided = k.of('reviews.moderation.decided').filter((e) => e.trustEnforcementId === enforcementId);
    expect(decided.map((e) => e.contentId).sort()).toEqual([r.reviewId, other.reviewId].sort());
    expect(k.of('reviews.review.removed').filter((e) => e.trustEnforcementId === enforcementId).map((e) => e.reviewId)).toEqual([r.reviewId]);

    k.reset();
    const reversed = { enforcementId, ref: 'EN-1', reportId: recorded.reportId, reportRef: 'TR-1', action: 'remove_reviews', ownerTeam: 'reviews', targets: recorded.targets, params: {}, appliedRef: null, executionState: 'applied', reason: 'Appeal overturned', appealId: null, reversedBy: { kind: 'staff', id: newId() }, reversedAt: new Date().toISOString() };
    await k.emit('trust', 'trust.enforcement.reversed', reversed);
    await k.emit('trust', 'trust.enforcement.reversed', reversed);
    const mine = await k.call('GET', `${STORE}/me/reviews`, r.author);
    expect(mine.body.items[0]).toMatchObject({ status: 'published' });
    expect(k.of('reviews.review.published').filter((e) => e.reviewId === r.reviewId)).toHaveLength(1);
    expect(k.of('reviews.moderation.decided').filter((e) => e.decision === 'reinstate')).toEqual([expect.objectContaining({ contentId: r.reviewId, author: { kind: 'customer', id: r.customerId }, trustEnforcementId: enforcementId })]);
    const theirs = await k.call('GET', `${STORE}/me/reviews`, other.author);
    expect(theirs.body.items[0]).toMatchObject({ status: 'removed' });
  });

  it('keep_reviews decides the open items as kept and publishes held content', async () => {
    const r = await published({ text: 'Great monitor but message me at someone@example.com for a better price deal on these.' });
    expect(r.status).toBe('held');
    const enforcementId = newId();
    await k.emit('trust', 'trust.enforcement.recorded', { enforcementId, reportId: newId(), action: 'keep_reviews', ownerTeam: 'reviews', targets: [{ type: 'review', id: r.reviewId, label: 'r' }], reason: 'Genuine buyer', params: {}, alreadyApplied: false });
    expect(k.of('reviews.moderation.decided')).toEqual([expect.objectContaining({ contentId: r.reviewId, decision: 'keep', reasonCode: 'legitimate_experience', trustEnforcementId: enforcementId })]);
    expect((await k.call('GET', `${STORE}/me/reviews`, r.author)).body.items[0]).toMatchObject({ status: 'published' });
    expect(await openItem(r.reviewId)).toBeUndefined();
  });
});

describe('the Official Store', () => {
  it('lists its reviews and responds publicly as the Official Store', async () => {
    const r = await published({ sellerId: null });
    const list = await k.call('GET', `${ADMIN}/official-store/reviews?needsResponse=true`, tokens.staff());
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body.items).toEqual(expect.arrayContaining([expect.objectContaining({ targetType: 'product_review', review: expect.objectContaining({ id: r.reviewId }), needsResponse: true, canRespond: true, orderRef: r.ref })]));
    const mixed = await k.call('GET', `${ADMIN}/official-store/reviews`, tokens.staff());
    expect(mixed.body.items.some((x: any) => x.review?.id === r.reviewId)).toBe(true);
    // a marketplace seller's review is not the Official Store's
    const sellerReview = await published();
    expect((await k.call('POST', `${ADMIN}/official-store/responses`, tokens.staff(), { targetType: 'product_review', targetId: sellerReview.reviewId, text: 'Thanks!' })).body.error.code).toBe('NOT_AN_OFFER_SELLER');
    const res = await k.call('POST', `${ADMIN}/official-store/responses`, tokens.staff(), { targetType: 'product_review', targetId: r.reviewId, text: 'Thank you for the review!' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(k.of('reviews.response.published').at(-1)).toEqual({ responseId: res.body.id, sellerId: OFFICIAL_STORE_ID, targetType: 'product_review', targetId: r.reviewId, status: 'published', customerId: r.customerId });
    expect((await k.call('POST', `${ADMIN}/official-store/responses`, tokens.staff(), { targetType: 'product_review', targetId: r.reviewId, text: 'Again' })).body.error.code).toBe('RESPONSE_ALREADY_EXISTS');
    const edit = await k.call('PATCH', `${ADMIN}/official-store/responses/${res.body.id}`, tokens.staff(), { text: 'Thank you, enjoy the monitor!' });
    expect(edit.status, JSON.stringify(edit.body)).toBe(200);
    expect(edit.body.text).toBe('Thank you, enjoy the monitor!');
    expect((await k.call('GET', `${ADMIN}/official-store/reviews?needsResponse=true`, tokens.staff())).body.items.some((x: any) => x.review?.id === r.reviewId)).toBe(false);
  });
});

describe('moderation SLA, closure and export', () => {
  it('raises review_moderation_overdue for old open items and resolves it on decision', async () => {
    const r = await published();
    await report(tokens.customer(newId()), r.reviewId);
    const item = await openItem(r.reviewId);
    k.clock.advance(3 * DAY);
    await k.app.kernel.jobs.runNow('reviews.moderation-sla');
    expect(k.callsOf('workqueues.raise').map((c) => c[0])).toContainEqual(expect.objectContaining({ queueKey: 'reviews.moderation', kind: 'review_moderation_overdue', sourceModule: 'reviews', dedupeKey: `review_moderation_overdue:${item.id}`, subject: expect.objectContaining({ type: 'moderation_item', id: item.id }) }));
    await decide(item.id, { decision: 'keep', reasonCode: 'legitimate_experience' });
    expect(k.callsOf('workqueues.resolveBySource').map((c) => c[0])).toContain(`review_moderation_overdue:${item.id}`);
    k.clock.advance(-3 * DAY);
  });

  it('customers.account.closed shows Former customer; the export hook lists the customer content', async () => {
    const r = await published();
    const exported = await k.svc.exportCustomerData({ customerId: r.customerId, accountId: r.customerId });
    expect(exported).toEqual([expect.objectContaining({ key: 'reviews', module: 'reviews', title: 'Reviews and questions' })]);
    expect(exported[0]!.records).toEqual([expect.objectContaining({ type: 'product_review', rating: 4, headline: 'Great monitor', status: 'published' })]);
    await k.emit('customers', 'customers.account.closed', { customerId: r.customerId, userId: r.customerId });
    const list = await k.call('GET', `${STORE}/products/${r.productId}/reviews`, tokens.visitor());
    expect(list.body.items[0].author.displayName).toBe('Former customer');
  });
});
