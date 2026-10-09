/** Reports, moderation decisions with outcomes for reporter and author, appeals, referrals, seller responses and consumers. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { ADMIN, boot, DAY, type Kit, order, product, reviewInput, seller, SELLER, STORE, tokens } from './helpers.js';

let k: Kit;
beforeAll(async () => {
  k = await boot();
});
afterAll(async () => {
  await k.app.close();
});
beforeEach(() => k.reset());

/** A published review of a product sold by a seller */
async function published(o: { rating?: number; sellerId?: string; photos?: string[] } = {}) {
  const customerId = newId();
  const sellerId = o.sellerId ?? seller(k, 'Gadget Grove');
  const p = product(k);
  const ord = order(k, customerId, [{ sellerId, lines: [{ productId: p.productId }] }]);
  const res = await k.call('POST', `${STORE}/me/reviews`, tokens.customer(customerId), reviewInput(ord.itemIds[0]!, { rating: o.rating ?? 1, ...(o.photos ? { mediaIds: o.photos } : {}) }));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return { customerId, author: tokens.customer(customerId), sellerId, reviewId: res.body.review.id as string, ...p, ...ord };
}

const report = (token: string, targetId: string, reason = 'off_topic', targetType = 'product_review') => k.call('POST', `${STORE}/reports`, token, { targetType, targetId, reason, note: 'Not about the product' });
const itemOf = async (contentId: string) => (await k.call('GET', `${ADMIN}/moderation-items?status=open`, tokens.staff())).body.items.find((i: any) => i.contentId === contentId);

describe('reports', () => {
  it('opens one moderation item per content, keeps the review visible and refuses a second report by the same caller', async () => {
    const r = await published();
    const reporter = newId();
    const first = await report(tokens.customer(reporter), r.reviewId);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ targetType: 'product_review', targetSummary: 'Review of Kestrel 27" monitor by "Sam R."', reason: 'off_topic', status: 'open', statusLabel: 'Under review', outcome: null });
    expect(k.of('reviews.report.created')).toEqual([{ reportId: first.body.id, targetType: 'product_review', targetId: r.reviewId, reason: 'off_topic', reporterKind: 'customer' }]);
    const again = await report(tokens.customer(reporter), r.reviewId);
    expect([again.status, again.body.error.code]).toEqual([409, 'ALREADY_REPORTED']);
    await report(tokens.customer(newId()), r.reviewId, 'inaccurate');
    await k.call('POST', `${SELLER}/reports`, tokens.seller(r.sellerId), { targetType: 'product_review', targetId: r.reviewId, reason: 'harms_sales' });
    const item = await itemOf(r.reviewId);
    expect(item).toMatchObject({ queue: 'reported', visibility: 'visible', reportCount: 3, reasons: ['off_topic', 'inaccurate', 'harms_sales'], reportersLabel: '2 customers, Gadget Grove (seller)', title: 'Kestrel 27" monitor', rating: 1 });
    const list = await k.call('GET', `${STORE}/products/${r.productId}/reviews`, tokens.visitor());
    expect(list.body.items.map((x: any) => x.id)).toEqual([r.reviewId]);
    expect((await report(r.author, r.reviewId)).status).toBe(400);
    expect((await report(tokens.customer(newId()), newId())).status).toBe(404);
  });

  it('hides content reported for personal information while it is reviewed', async () => {
    const r = await published();
    await report(tokens.customer(newId()), r.reviewId, 'personal_information');
    expect((await k.call('GET', `${STORE}/products/${r.productId}/reviews`, tokens.visitor())).body.items).toEqual([]);
    const mine = await k.call('GET', `${STORE}/me/reviews`, r.author);
    expect(mine.body.items[0]).toMatchObject({ status: 'held', statusLabel: 'Hidden: under review', moderation: { decision: 'hidden_pending_review', expectedBy: expect.any(String) } });
    expect(JSON.stringify(mine.body)).not.toContain('Not about the product');
    const summary = await k.call('GET', `${ADMIN}/moderation-items/summary`, tokens.staff());
    expect(summary.body.open).toBeGreaterThan(0);
    expect(summary.body.byQueue.reported).toBeGreaterThan(0);
    expect(summary.body.byContentType.product_review).toBeGreaterThan(0);
  });
});

describe('decisions', () => {
  it('never removes a legitimate negative review for being unfavourable', async () => {
    const r = await published({ rating: 1 });
    await k.call('POST', `${SELLER}/reports`, tokens.seller(r.sellerId), { targetType: 'product_review', targetId: r.reviewId, reason: 'harms_sales' });
    const item = await itemOf(r.reviewId);
    const refused = await k.call('POST', `${ADMIN}/moderation-items/${item.id}/decide`, tokens.staff(), { decision: 'remove', reasonCode: 'legitimate_experience' });
    expect([refused.status, refused.body.error.code]).toEqual([422, 'INVALID_REMOVAL_REASON']);
    const kept = await k.call('POST', `${ADMIN}/moderation-items/${item.id}/decide`, tokens.staff(), { decision: 'keep', reasonCode: 'legitimate_experience' });
    expect(kept.status).toBe(200);
    expect(kept.body.item.status).toBe('decided');
    expect(kept.body.previousDecision).toMatchObject({ decision: 'kept', reasonCode: 'legitimate_experience', appealable: false });
    const reports = await k.call('GET', `${SELLER}/reports`, tokens.seller(r.sellerId));
    expect(reports.body.items[0]).toMatchObject({ status: 'decided', statusLabel: 'Decided', outcome: expect.stringContaining('kept it') });
    const again = await k.call('POST', `${ADMIN}/moderation-items/${item.id}/decide`, tokens.staff(), { decision: 'keep', reasonCode: 'legitimate_experience' });
    expect([again.status, again.body.error.code]).toEqual([409, 'ILLEGAL_TRANSITION']);
    // the same complaint again within the cooldown attaches without reopening
    const repeat = await k.call('POST', `${STORE}/reports`, tokens.customer(newId()), { targetType: 'product_review', targetId: r.reviewId, reason: 'harms_sales' });
    expect(repeat.body).toMatchObject({ status: 'decided', outcome: expect.stringContaining('already reviewed') });
    expect(await itemOf(r.reviewId)).toBeUndefined();
    // a different reason reopens it
    await report(tokens.customer(newId()), r.reviewId, 'spam_or_links');
    expect(await itemOf(r.reviewId)).toMatchObject({ id: item.id, status: 'open', queue: 'reported' });
  });

  it('removes for a policy reason: content, photos, summary, events, audit and both sides see the outcome', async () => {
    const photo = newId();
    const r = await published({ rating: 2, photos: [photo] });
    const reporter = newId();
    await report(tokens.customer(reporter), r.reviewId, 'personal_information');
    const item = await itemOf(r.reviewId);
    const detail = await k.call('GET', `${ADMIN}/moderation-items/${item.id}`, tokens.staff());
    expect(detail.body).toMatchObject({ review: { id: r.reviewId }, purchase: { orderRef: r.ref, verified: true, soldBy: 'Gadget Grove', condition: 'New' }, reports: [expect.objectContaining({ reporter: expect.objectContaining({ kind: 'customer', id: reporter }), reason: 'personal_information' })], helpfulVotes: 0 });
    k.reset();
    const staffId = newId();
    const res = await k.call('POST', `${ADMIN}/moderation-items/${item.id}/decide`, tokens.staff(staffId), { decision: 'remove', reasonCode: 'personal_information', messageToAuthor: 'It shows a home address.' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(k.of('reviews.moderation.decided')).toEqual([
      {
        moderationItemId: item.id,
        contentType: 'product_review',
        contentId: r.reviewId,
        decision: 'remove',
        reasonCode: 'personal_information',
        author: { kind: 'customer', id: r.customerId },
        reporters: [{ kind: 'customer', id: reporter }],
        reporterOutcome: expect.stringContaining('We removed this review'),
        appealUntil: expect.any(String),
      },
    ]);
    expect(Date.parse(k.of('reviews.moderation.decided')[0]!.appealUntil!)).toBeGreaterThan(k.clock.now().getTime());
    expect(k.of('reviews.review.removed')).toEqual([{ reviewId: r.reviewId, productId: r.productId, byModeration: true, reasonCode: 'personal_information' }]);
    expect(k.callsOf('media.remove')).toEqual([[photo, { reason: expect.any(String), by: expect.objectContaining({ kind: 'staff', id: staffId }) }]]);
    expect(k.audits).toEqual([expect.objectContaining({ action: 'reviews.moderation.decide', category: 'content', reason: expect.any(String), actor: expect.objectContaining({ id: staffId }) })]);
    const mine = await k.call('GET', `${STORE}/me/reviews`, r.author);
    expect(mine.body.items[0]).toMatchObject({ status: 'removed', visibleToShoppers: false, canAppeal: true, moderation: { decision: 'removed', reasonCode: 'personal_information', reasonText: 'It shows a home address.', appealable: true, appealBy: expect.any(String) } });
    const theirs = await k.call('GET', `${STORE}/me/reports`, tokens.customer(reporter));
    expect(theirs.body.items[0]).toMatchObject({ status: 'decided', outcome: expect.stringContaining('We removed this review') });
    expect((await k.call('GET', `${STORE}/products/${r.productId}/rating-summary`, tokens.visitor())).body.ratingCount).toBe(0);
  });

  it('requests an edit; the fixed review waits for a moderator', async () => {
    const r = await published();
    await report(tokens.customer(newId()), r.reviewId, 'off_topic');
    const item = await itemOf(r.reviewId);
    const bad = await k.call('POST', `${ADMIN}/moderation-items/${item.id}/decide`, tokens.staff(), { decision: 'request_edit', reasonCode: 'off_topic' });
    expect(bad.status).toBe(400);
    await k.call('POST', `${ADMIN}/moderation-items/${item.id}/decide`, tokens.staff(), { decision: 'request_edit', reasonCode: 'off_topic', editRequest: 'Remove the part about the courier.' });
    const mine = await k.call('GET', `${STORE}/me/reviews`, r.author);
    expect(mine.body.items[0]).toMatchObject({ status: 'edit_requested', canEdit: true, moderation: { decision: 'edit_requested', reasonText: expect.stringContaining('Remove the part about the courier.') } });
    const fixed = await k.call('PATCH', `${STORE}/me/reviews/${r.reviewId}`, r.author, { text: 'Bright, sharp and well built. The stand is sturdy and the menus are easy.' });
    expect(fixed.body).toMatchObject({ status: 'held' });
    const again = await itemOf(r.reviewId);
    expect(again).toMatchObject({ queue: 'auto_held', visibility: 'hidden' });
    const published2 = await k.call('POST', `${ADMIN}/moderation-items/${again.id}/decide`, tokens.staff(), { decision: 'publish', reasonCode: 'legitimate_experience' });
    expect(published2.body.review).toMatchObject({ id: r.reviewId });
    expect((await k.call('GET', `${STORE}/me/reviews`, r.author)).body.items[0].status).toBe('published');
  });

  it('rejects decisions that do not fit the content and lists the policy reasons', async () => {
    const r = await published();
    await report(tokens.customer(newId()), r.reviewId);
    const item = await itemOf(r.reviewId);
    expect((await k.call('POST', `${ADMIN}/moderation-items/${item.id}/decide`, tokens.staff(), { decision: 'reject_response', reasonCode: 'off_topic' })).status).toBe(400);
    const reasons = await k.call('GET', `${ADMIN}/moderation-reasons`, tokens.staff());
    expect(reasons.body.find((x: any) => x.code === 'legitimate_experience')).toMatchObject({ removes: false });
    expect(reasons.body.some((x: any) => x.code === 'harms_sales')).toBe(false);
    expect((await k.call('GET', `${ADMIN}/moderation-items/${newId()}`, tokens.staff())).status).toBe(404);
  });

  it('refers content to Trust and Risk', async () => {
    const r = await published();
    await report(tokens.customer(newId()), r.reviewId, 'fake_or_paid');
    const item = await itemOf(r.reviewId);
    const res = await k.call('POST', `${ADMIN}/moderation-items/${item.id}/refer`, tokens.staff(), { note: 'Burst of 5-star reviews from new accounts' });
    expect(res.status).toBe(200);
    expect(res.body.history.map((h: any) => h.label)).toContain('Referred to Trust and Risk');
    expect(res.body.item.status).toBe('open');
    expect(k.of('reviews.content.referred')).toEqual([{ moderationItemId: item.id, contentType: 'product_review', contentId: r.reviewId, authorId: r.customerId, note: 'Burst of 5-star reviews from new accounts' }]);
    expect(k.audits.map((a) => a.action)).toEqual(['reviews.moderation.refer']);
  });
});

describe('appeals', () => {
  async function removed() {
    const r = await published({ rating: 1 });
    await report(tokens.customer(newId()), r.reviewId, 'spam_or_links');
    const item = await itemOf(r.reviewId);
    const moderator = newId();
    await k.call('POST', `${ADMIN}/moderation-items/${item.id}/decide`, tokens.staff(moderator), { decision: 'remove', reasonCode: 'spam_or_links' });
    return { ...r, itemId: item.id as string, moderator };
  }

  it('is decided by a different moderator; an overturn reinstates the review', async () => {
    const r = await removed();
    const appeal = await k.call('POST', `${STORE}/me/appeals`, r.author, { targetType: 'product_review', targetId: r.reviewId, reason: 'There is no link in my review.' });
    expect(appeal.status).toBe(201);
    expect(appeal.body).toMatchObject({ status: 'submitted' });
    expect(k.of('reviews.appeal.submitted')).toEqual([{ appealId: appeal.body.id, contentType: 'product_review', contentId: r.reviewId }]);
    expect((await k.call('POST', `${STORE}/me/appeals`, r.author, { targetType: 'product_review', targetId: r.reviewId, reason: 'Again' })).status).toBe(409);
    expect((await k.call('POST', `${STORE}/me/appeals`, tokens.customer(newId()), { targetType: 'product_review', targetId: r.reviewId, reason: 'Not mine' })).status).toBe(404);
    const queue = await k.call('GET', `${ADMIN}/moderation-items?queue=appeal`, tokens.staff());
    expect(queue.body.items.map((i: any) => i.id)).toContain(r.itemId);
    expect((await k.call('POST', `${ADMIN}/moderation-items/${r.itemId}/decide`, tokens.staff(), { decision: 'keep', reasonCode: 'legitimate_experience' })).status).toBe(409);
    const list = await k.call('GET', `${ADMIN}/appeals?status=submitted`, tokens.staff());
    expect(list.body.items.find((a: any) => a.id === appeal.body.id)).toMatchObject({ contentType: 'product_review', originalModerator: { kind: 'staff', id: r.moderator }, originalDecision: { decision: 'removed' }, status: 'submitted' });
    const same = await k.call('POST', `${ADMIN}/appeals/${appeal.body.id}/decide`, tokens.staff(r.moderator), { overturn: true, reason: 'ok' });
    expect([same.status, same.body.error.code]).toEqual([409, 'SAME_MODERATOR']);
    k.reset();
    const decided = await k.call('POST', `${ADMIN}/appeals/${appeal.body.id}/decide`, tokens.staff(newId()), { overturn: true, reason: 'The review has no link; restored.' });
    expect(decided.body).toMatchObject({ id: appeal.body.id, status: 'overturned' });
    expect(k.of('reviews.appeal.decided')).toEqual([{ appealId: appeal.body.id, overturned: true }]);
    expect(k.of('reviews.review.published')).toEqual([expect.objectContaining({ reviewId: r.reviewId })]);
    expect(k.audits.map((a) => a.action)).toEqual(['reviews.appeal.decide']);
    const mine = await k.call('GET', `${STORE}/me/reviews`, r.author);
    expect(mine.body.items[0]).toMatchObject({ status: 'published', canAppeal: false, appeal: { status: 'overturned', outcome: 'The review has no link; restored.' } });
    const again = await k.call('POST', `${ADMIN}/appeals/${appeal.body.id}/decide`, tokens.staff(newId()), { overturn: false, reason: 'no' });
    expect([again.status, again.body.error.code]).toEqual([409, 'ILLEGAL_TRANSITION']);
  });

  it('closes after appealWindowDays and refuses appeals without an adverse decision', async () => {
    const r = await removed();
    k.clock.advance(31 * DAY);
    const late = await k.call('POST', `${STORE}/me/appeals`, r.author, { targetType: 'product_review', targetId: r.reviewId, reason: 'Late' });
    k.clock.advance(-31 * DAY);
    expect([late.status, late.body.error.code]).toEqual([409, 'APPEAL_WINDOW_CLOSED']);
    const fine = await published();
    const none = await k.call('POST', `${STORE}/me/appeals`, fine.author, { targetType: 'product_review', targetId: fine.reviewId, reason: 'Why?' });
    expect([none.status, none.body.error.code]).toEqual([409, 'ILLEGAL_TRANSITION']);
  });
});

describe('seller responses', () => {
  it('publishes a response that passes the rules, one per review, editable within the window', async () => {
    const r = await published({ rating: 2 });
    const res = await k.call('POST', `${SELLER}/responses`, tokens.seller(r.sellerId), { targetType: 'product_review', targetId: r.reviewId, text: 'Sorry to hear that. Our support team can help with the settings.' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ fromName: 'Gadget Grove', fromKind: 'seller', status: 'published', ruleCheck: { passed: true, failures: [] }, editableUntil: expect.any(String) });
    expect(k.of('reviews.response.published')).toEqual([{ responseId: res.body.id, sellerId: r.sellerId, targetType: 'product_review', status: 'published' }]);
    const pub = await k.call('GET', `${STORE}/products/${r.productId}/reviews`, tokens.visitor());
    expect(pub.body.items[0].response).toMatchObject({ id: res.body.id, status: 'published', ruleCheck: null, editableUntil: null });
    const dup = await k.call('POST', `${SELLER}/responses`, tokens.seller(r.sellerId), { targetType: 'product_review', targetId: r.reviewId, text: 'Again' });
    expect([dup.status, dup.body.error.code]).toEqual([409, 'RESPONSE_ALREADY_EXISTS']);
    const edited = await k.call('PATCH', `${SELLER}/responses/${res.body.id}`, tokens.seller(r.sellerId), { text: 'Sorry to hear that. A firmware update fixes the flicker.' });
    expect(edited.body).toMatchObject({ status: 'published', text: 'Sorry to hear that. A firmware update fixes the flicker.' });
    expect((await k.call('PATCH', `${SELLER}/responses/${res.body.id}`, tokens.seller(newId()), { text: 'x' })).status).toBe(404);
    k.clock.advance(8 * DAY);
    const closed = await k.call('PATCH', `${SELLER}/responses/${res.body.id}`, tokens.seller(r.sellerId), { text: 'Late edit' });
    k.clock.advance(-8 * DAY);
    expect([closed.status, closed.body.error.code]).toEqual([409, 'RESPONSE_EDIT_WINDOW_CLOSED']);
    const rows = await k.call('GET', `${SELLER}/product-reviews`, tokens.seller(r.sellerId));
    expect(rows.body.items[0]).toMatchObject({ orderRef: r.ref, canRespond: false, respondNote: expect.stringContaining('You responded') });
  });

  it('holds responses offering refunds to change a review, and lets the seller appeal a rejection', async () => {
    const r = await published({ rating: 1 });
    const res = await k.call('POST', `${SELLER}/responses`, tokens.seller(r.sellerId), { targetType: 'product_review', targetId: r.reviewId, text: 'We will refund you in full if you remove this review. Call 555-123-4567.' });
    expect(res.body).toMatchObject({ status: 'held', ruleCheck: { passed: false, failures: expect.arrayContaining(['Offers payment to change a review', 'Contains contact details']) } });
    expect(k.of('reviews.response.published')).toEqual([expect.objectContaining({ status: 'held' })]);
    expect((await k.call('GET', `${STORE}/products/${r.productId}/reviews`, tokens.visitor())).body.items[0].response).toBeNull();
    const item = (await k.call('GET', `${ADMIN}/moderation-items?queue=response_check`, tokens.staff())).body.items.find((i: any) => i.contentId === res.body.id);
    expect(item).toMatchObject({ contentType: 'seller_response', respondingTo: { contentType: 'product_review', rating: 1, title: 'Kestrel 27" monitor' }, author: { kind: 'seller', displayName: 'Gadget Grove' } });
    await k.call('POST', `${ADMIN}/moderation-items/${item.id}/decide`, tokens.staff(), { decision: 'reject_response', reasonCode: 'payment_for_review' });
    const appeal = await k.call('POST', `${SELLER}/appeals`, tokens.seller(r.sellerId), { targetType: 'seller_response', targetId: res.body.id, reason: 'We meant a warranty repair.' });
    expect(appeal.status).toBe(201);
    expect((await k.call('POST', `${SELLER}/appeals`, tokens.seller(newId()), { targetType: 'seller_response', targetId: res.body.id, reason: 'x' })).status).toBe(404);
  });

  it('only lets the seller who sold the item respond, and stops closed sellers', async () => {
    const r = await published();
    const other = seller(k);
    const res = await k.call('POST', `${SELLER}/responses`, tokens.seller(other), { targetType: 'product_review', targetId: r.reviewId, text: 'Hello' });
    expect([res.status, res.body.error.code]).toEqual([403, 'NOT_AN_OFFER_SELLER']);
    const closed = seller(k, 'Gone Shop', 'closed');
    const r2 = await published({ sellerId: closed });
    await k.emit('sellers', 'sellers.seller.closed', { sellerId: closed, reasonCode: 'requested', closedBy: { kind: 'staff', id: newId() } });
    const refused = await k.call('POST', `${SELLER}/responses`, tokens.seller(closed), { targetType: 'product_review', targetId: r2.reviewId, text: 'Thanks' });
    expect(refused.body.error.code).toBe('NOT_AN_OFFER_SELLER');
    expect((await k.call('GET', `${STORE}/products/${r2.productId}/reviews`, tokens.visitor())).body.items).toHaveLength(1);
  });

  it('responds to the seller’s own feedback only', async () => {
    const s = seller(k);
    const customerId = newId();
    const p = product(k);
    const o = order(k, customerId, [{ sellerId: s, lines: [{ productId: p.productId }] }]);
    const fb = await k.call('POST', `${STORE}/me/feedback`, tokens.customer(customerId), { orderId: o.orderId, sellerId: s, asDescribed: true, dispatchRating: 2, comment: 'Slow dispatch.' });
    const res = await k.call('POST', `${SELLER}/responses`, tokens.seller(s), { targetType: 'seller_feedback', targetId: fb.body.feedback.id, text: 'Sorry, a carrier delay held it a day.' });
    expect(res.status).toBe(201);
    expect((await k.call('POST', `${SELLER}/responses`, tokens.seller(newId()), { targetType: 'seller_feedback', targetId: fb.body.feedback.id, text: 'x' })).status).toBe(404);
    const mine = await k.call('GET', `${STORE}/me/feedback`, tokens.customer(customerId));
    expect(mine.body.items[0].feedback.response).toMatchObject({ id: res.body.id, status: 'published' });
  });
});

describe('admin review search and consumers', () => {
  it('searches reviews with report counts', async () => {
    const r = await published();
    await report(tokens.customer(newId()), r.reviewId);
    const res = await k.call('GET', `${ADMIN}/reviews?productId=${r.productId}`, tokens.staff());
    expect(res.body.items).toEqual([expect.objectContaining({ status: 'published', orderRef: r.ref, customerId: r.customerId, reportCount: 1 })]);
  });

  it('removes content named in a trust enforcement and lets the author see why', async () => {
    const photo = newId();
    const r = await published({ photos: [photo] });
    const reporter = newId();
    await report(tokens.customer(reporter), r.reviewId, 'fake_or_paid');
    const sellerReporter = seller(k, 'Rival Store');
    await k.call('POST', `${SELLER}/reports`, tokens.seller(sellerReporter), { targetType: 'product_review', targetId: r.reviewId, reason: 'fake_or_paid' });
    k.reset();
    await k.emit('trust', 'trust.enforcement.recorded', { enforcementId: newId(), reportId: newId(), action: 'remove_reviews', ownerTeam: 'reviews', targets: [{ type: 'review', id: r.reviewId, label: 'review' }], reason: 'Paid review ring', params: {}, alreadyApplied: false });
    expect(k.of('reviews.review.removed')).toEqual([{ reviewId: r.reviewId, productId: r.productId, byModeration: true, reasonCode: 'proven_fake' }]);
    expect(k.of('reviews.moderation.decided')).toEqual([
      {
        moderationItemId: expect.any(String),
        contentType: 'product_review',
        contentId: r.reviewId,
        decision: 'remove',
        reasonCode: 'proven_fake',
        author: { kind: 'customer', id: r.customerId },
        reporters: [
          { kind: 'customer', id: reporter },
          { kind: 'seller', id: sellerReporter },
        ],
        reporterOutcome: 'We removed this review after a Trust and Risk investigation.',
        appealUntil: null,
      },
    ]);
    expect(k.callsOf('media.remove').map((c) => c[0])).toEqual([photo]);
    const mine = await k.call('GET', `${STORE}/me/reviews`, r.author);
    expect(mine.body.items[0]).toMatchObject({ status: 'removed', canEdit: false, canAppeal: false, moderation: { decision: 'removed', reasonCode: 'proven_fake' } });
    expect(await k.svc.removeContentForEnforcement([r.reviewId], newId(), 'again')).toBe(0);
    await k.emit('trust', 'trust.enforcement.recorded', { enforcementId: newId(), reportId: newId(), action: 'remove_reviews', ownerTeam: 'reviews', targets: [{ type: 'review', id: newId(), label: 'x' }], reason: 'x', params: {}, alreadyApplied: true });
  });

  it('moves reviews and questions to the kept product on a merge', async () => {
    const r = await published({ rating: 4 });
    const kept = product(k);
    await k.call('POST', `${STORE}/products/${r.productId}/questions`, tokens.customer(newId()), { text: 'Is there a USB-C port on it?' });
    k.reset();
    await k.emit('catalog', 'catalog.product.merged', { keptProductId: kept.productId, duplicateProductId: r.productId, reason: 'duplicate' });
    expect((await k.call('GET', `${STORE}/products/${kept.productId}/rating-summary`, tokens.visitor())).body).toMatchObject({ ratingCount: 1, average: 4 });
    expect((await k.call('GET', `${STORE}/products/${kept.productId}/questions`, tokens.visitor())).body.items).toHaveLength(1);
    expect(k.of('reviews.rating.changed')).toEqual(expect.arrayContaining([expect.objectContaining({ productId: kept.productId, count: 1 }), expect.objectContaining({ productId: r.productId, count: 0 })]));
    expect(await k.svc.moveProductContent(r.productId, kept.productId)).toEqual({ reviews: 0, questions: 0 });
  });

  it('flags overdue moderation items in the SLA job', async () => {
    const r = await published();
    await report(tokens.customer(newId()), r.reviewId);
    k.clock.advance(3 * DAY);
    expect(await k.svc.summaries.moderationSla()).toBeGreaterThan(0);
    const summary = await k.call('GET', `${ADMIN}/moderation-items/summary`, tokens.staff());
    expect(summary.body.overdue).toBeGreaterThan(0);
    k.clock.advance(-3 * DAY);
    await k.app.kernel.jobs.runNow('reviews.moderation-sla');
  });
});
