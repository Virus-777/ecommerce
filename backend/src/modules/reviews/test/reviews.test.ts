/** Product reviews: Verified Purchase eligibility, writing, editing, deleting, votes, lists, pending and context. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { resolvers } from '../graphql/resolvers.js';
import { boot, DAY, type Kit, LONG, OFFICIAL_STORE_ID, order, product, reviewInput, seller, STORE, tokens } from './helpers.js';

let k: Kit;
beforeAll(async () => {
  k = await boot();
});
afterAll(async () => {
  await k.app.close();
});
beforeEach(() => k.reset());

/** A customer with a delivered item of a fresh product */
function buyer(o: { deliveredDaysAgo?: number; sellerId?: string | null; delivered?: boolean } = {}) {
  const customerId = newId();
  const p = product(k);
  const ord = order(k, customerId, [{ sellerId: o.sellerId === undefined ? seller(k) : o.sellerId, lines: [{ productId: p.productId, delivered: o.delivered ?? true }] }], o.deliveredDaysAgo ?? 1);
  return { customerId, token: tokens.customer(customerId), ...p, ...ord, itemId: ord.itemIds[0]! };
}

describe('writing a review', () => {
  it('publishes a Verified Purchase review that passes the checks and updates the product summary', async () => {
    const b = buyer();
    const res = await k.call('POST', `${STORE}/me/reviews`, b.token, reviewInput(b.itemId, { rating: 4 }));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ status: 'published', statusLabel: 'Published', visibleToShoppers: true, orderItemId: b.itemId, canEdit: true, canDelete: true, canAppeal: false });
    expect(res.body.review).toMatchObject({ productId: b.productId, rating: 4, author: { kind: 'customer', displayName: 'Sam R.', verifiedPurchase: true }, variantLabel: 'Color: Midnight black' });
    expect(k.of('reviews.review.published')).toEqual([{ reviewId: res.body.review.id, productId: b.productId, sellerId: expect.any(String), rating: 4, verified: true }]);
    expect(k.of('reviews.rating.changed')).toContainEqual({ productId: b.productId, sellerId: null, average: 4, count: 1 });
    const summary = await k.call('GET', `${STORE}/products/${b.productId}/rating-summary`, tokens.visitor());
    expect(summary.body).toMatchObject({ productId: b.productId, hasReviews: true, average: 4, ratingCount: 1, writtenCount: 1, withPhotos: 0 });
    expect(summary.body.distribution).toContainEqual({ stars: 4, count: 1, pct: 100 });
  });

  it('shows the honest no-reviews state for a product without reviews', async () => {
    const p = product(k);
    const res = await k.call('GET', `${STORE}/rating-summaries?productIds=${p.productId}`, tokens.visitor());
    expect(res.body).toEqual([{ productId: p.productId, hasReviews: false, average: null, ratingCount: 0, writtenCount: 0, distribution: expect.any(Array), answeredQuestions: 0, withPhotos: 0 }]);
    expect((await k.call('GET', `${STORE}/rating-summaries?productIds=nope`, tokens.visitor())).status).toBe(400);
  });

  it('holds a review that fails the automatic checks for moderation', async () => {
    const b = buyer();
    const res = await k.call('POST', `${STORE}/me/reviews`, b.token, reviewInput(b.itemId, { text: `${LONG} Email me at sam@example.com for details.` }));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'held', visibleToShoppers: false, moderation: { decision: 'hidden_pending_review', appealable: false } });
    expect(k.of('reviews.review.published')).toEqual([]);
    const queue = await k.call('GET', `/api/admin/reviews/moderation-items?queue=auto_held`, tokens.staff());
    const item = queue.body.items.find((i: any) => i.contentId === res.body.review.id);
    expect(item).toMatchObject({ queue: 'auto_held', visibility: 'hidden', reasons: ['personal_information'], reportersLabel: 'system', ruleCheck: { passed: false, failures: ['Contains contact details'] } });
  });

  it('attaches photos as review_photo media owned by the customer and refuses someone else’s file', async () => {
    const b = buyer();
    const photo = newId();
    const res = await k.call('POST', `${STORE}/me/reviews`, b.token, reviewInput(b.itemId, { mediaIds: [photo] }));
    expect(res.status).toBe(201);
    expect(k.callsOf('media.attach')).toEqual([[photo, { module: 'reviews', kind: 'review_photo', refId: res.body.review.id, refLabel: expect.any(String) }, { kind: 'customer', id: b.customerId }]]);
    expect(res.body.review.media).toEqual([{ id: photo, url: `https://cdn.example/${photo}.jpg` }]);
    const summary = await k.call('GET', `${STORE}/products/${b.productId}/rating-summary`, tokens.visitor());
    expect(summary.body.withPhotos).toBe(1);

    const other = buyer();
    const foreign = newId();
    k.foreignAssets.add(foreign);
    const refused = await k.call('POST', `${STORE}/me/reviews`, other.token, reviewInput(other.itemId, { mediaIds: [foreign] }));
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('ASSET_NOT_OWNED');
  });

  it('refuses items that are not delivered, someone else’s items and ended windows', async () => {
    const pending = buyer({ delivered: false });
    const r1 = await k.call('POST', `${STORE}/me/reviews`, pending.token, reviewInput(pending.itemId));
    expect([r1.status, r1.body.error.code]).toEqual([422, 'REVIEW_NOT_ELIGIBLE']);

    const b = buyer();
    const stranger = tokens.customer(newId());
    const r2 = await k.call('POST', `${STORE}/me/reviews`, stranger, reviewInput(b.itemId));
    expect([r2.status, r2.body.error.code]).toEqual([422, 'REVIEW_NOT_ELIGIBLE']);

    const old = buyer({ deliveredDaysAgo: 400 });
    const r3 = await k.call('POST', `${STORE}/me/reviews`, old.token, reviewInput(old.itemId));
    expect([r3.status, r3.body.error.code]).toEqual([422, 'REVIEW_NOT_ELIGIBLE']);
  });

  it('allows one review per customer and product (ALREADY_REVIEWED with the id)', async () => {
    const b = buyer();
    const first = await k.call('POST', `${STORE}/me/reviews`, b.token, reviewInput(b.itemId));
    const again = order(k, b.customerId, [{ sellerId: null, lines: [{ productId: b.productId }] }]);
    const res = await k.call('POST', `${STORE}/me/reviews`, b.token, reviewInput(again.itemIds[0]!));
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'ALREADY_REVIEWED', details: { id: first.body.review.id } });
  });

  it('validates the rating, headline and minimum length', async () => {
    const b = buyer();
    const res = await k.call('POST', `${STORE}/me/reviews`, b.token, reviewInput(b.itemId, { rating: 7, text: 'Too short' }));
    expect(res.status).toBe(400);
    expect(res.body.error.details.issues.map((i: any) => i.path)).toEqual(['rating', 'text']);
  });
});

describe('drafts, edits and deletes', () => {
  it('saves a draft and publishes it with draft: false', async () => {
    const b = buyer();
    const draft = await k.call('POST', `${STORE}/me/reviews`, b.token, reviewInput(b.itemId, { draft: true, text: 'Short for now' }));
    expect(draft.body).toMatchObject({ status: 'draft', visibleToShoppers: false });
    expect(k.of('reviews.review.published')).toEqual([]);
    const tooShort = await k.call('PATCH', `${STORE}/me/reviews/${draft.body.review.id}`, b.token, { draft: false });
    expect(tooShort.status).toBe(400);
    const sent = await k.call('PATCH', `${STORE}/me/reviews/${draft.body.review.id}`, b.token, { draft: false, text: LONG });
    expect(sent.body).toMatchObject({ status: 'published' });
    expect(k.of('reviews.review.published')).toHaveLength(1);
    expect(k.of('reviews.review.updated')).toEqual([]);
  });

  it('re-runs the checks on an edit and publishes updated and published events', async () => {
    const b = buyer();
    const r = await k.call('POST', `${STORE}/me/reviews`, b.token, reviewInput(b.itemId, { rating: 5 }));
    k.reset();
    const edited = await k.call('PATCH', `${STORE}/me/reviews/${r.body.review.id}`, b.token, { rating: 2 });
    expect(edited.body).toMatchObject({ status: 'published', review: { rating: 2, editedAt: expect.any(String) } });
    expect(k.of('reviews.review.updated')).toEqual([{ reviewId: r.body.review.id, productId: b.productId }]);
    expect(k.of('reviews.rating.changed')).toContainEqual({ productId: b.productId, sellerId: null, average: 2, count: 1 });
    const held = await k.call('PATCH', `${STORE}/me/reviews/${r.body.review.id}`, b.token, { text: `${LONG} Visit www.deals-now.com` });
    expect(held.body.status).toBe('held');
    const illegal = await k.call('PATCH', `${STORE}/me/reviews/${r.body.review.id}`, b.token, { rating: 3 });
    expect([illegal.status, illegal.body.error.code]).toEqual([409, 'ILLEGAL_TRANSITION']);
  });

  it('keeps reviews to their author: someone else’s review is 404', async () => {
    const b = buyer();
    const r = await k.call('POST', `${STORE}/me/reviews`, b.token, reviewInput(b.itemId));
    const other = tokens.customer(newId());
    expect((await k.call('PATCH', `${STORE}/me/reviews/${r.body.review.id}`, other, { rating: 1 })).status).toBe(404);
    expect((await k.call('DELETE', `${STORE}/me/reviews/${r.body.review.id}`, other)).status).toBe(404);
  });

  it('deletes a review: removed event, photos detached, summary updated; the product can be reviewed again', async () => {
    const b = buyer();
    const photo = newId();
    const r = await k.call('POST', `${STORE}/me/reviews`, b.token, reviewInput(b.itemId, { mediaIds: [photo] }));
    k.reset();
    expect((await k.call('DELETE', `${STORE}/me/reviews/${r.body.review.id}`, b.token)).status).toBe(204);
    expect(k.of('reviews.review.removed')).toEqual([{ reviewId: r.body.review.id, productId: b.productId, byModeration: false, reasonCode: null }]);
    expect(k.callsOf('media.detach')).toEqual([[photo, { module: 'reviews', kind: 'review_photo', refId: r.body.review.id }]]);
    expect((await k.call('GET', `${STORE}/products/${b.productId}/rating-summary`, tokens.visitor())).body.ratingCount).toBe(0);
    expect((await k.call('GET', `${STORE}/me/reviews`, b.token)).body.items).toEqual([]);
    const again = await k.call('POST', `${STORE}/me/reviews`, b.token, reviewInput(b.itemId));
    expect(again.status).toBe(201);
    expect(again.body.review.id).toBe(r.body.review.id);
  });
});

describe('public list and helpful votes', () => {
  it('lists published reviews with filters, sorting and the viewer’s votes', async () => {
    const p = product(k);
    const ids: string[] = [];
    for (const rating of [5, 2, 4]) {
      const c = newId();
      const o = order(k, c, [{ sellerId: null, lines: [{ productId: p.productId }] }]);
      const r = await k.call('POST', `${STORE}/me/reviews`, tokens.customer(c), reviewInput(o.itemIds[0]!, { rating }));
      ids.push(r.body.review.id);
    }
    const all = await k.call('GET', `${STORE}/products/${p.productId}/reviews?sort=highest`, tokens.visitor());
    expect(all.body.items.map((r: any) => r.rating)).toEqual([5, 4, 2]);
    expect(all.body.items[0].soldBy).toEqual({ sellerId: OFFICIAL_STORE_ID, name: 'Marketly Official Store' });
    const critical = await k.call('GET', `${STORE}/products/${p.productId}/reviews?critical=true`, tokens.visitor());
    expect(critical.body.items.map((r: any) => r.rating)).toEqual([2]);

    const voter = newId();
    const vote = await k.call('POST', `${STORE}/votes`, tokens.customer(voter), { targetType: 'product_review', targetId: ids[1], helpful: true });
    expect(vote.body).toEqual({ helpfulCount: 1 });
    const helpful = await k.call('GET', `${STORE}/products/${p.productId}/reviews?sort=most_helpful`, tokens.customer(voter));
    expect(helpful.body.items[0]).toMatchObject({ id: ids[1], helpfulCount: 1, viewerVotedHelpful: true });
    const undo = await k.call('POST', `${STORE}/votes`, tokens.customer(voter), { targetType: 'product_review', targetId: ids[1], helpful: false });
    expect(undo.body).toEqual({ helpfulCount: 0 });
    const gql = await k.svc.listProductReviews(p.productId, { stars: 4 }, 'newest', {}, null);
    expect(gql.items.map((r) => r.rating)).toEqual([4]);
  });

  it('refuses votes on one’s own review and on unknown reviews', async () => {
    const b = buyer();
    const r = await k.call('POST', `${STORE}/me/reviews`, b.token, reviewInput(b.itemId));
    expect((await k.call('POST', `${STORE}/votes`, b.token, { targetType: 'product_review', targetId: r.body.review.id, helpful: true })).status).toBe(400);
    expect((await k.call('POST', `${STORE}/votes`, b.token, { targetType: 'product_review', targetId: newId(), helpful: true })).status).toBe(404);
  });
});

describe('pending reviews, context and item status', () => {
  it('lists delivered items to review and packages waiting for feedback', async () => {
    const customerId = newId();
    const s = seller(k, 'Casa Verde Home');
    const p1 = product(k, 'Pellar skillet');
    const p2 = product(k, 'Linen throw');
    const o = order(k, customerId, [
      { sellerId: s, lines: [{ productId: p1.productId }] },
      { sellerId: null, lines: [{ productId: p2.productId, delivered: false }] },
    ]);
    const res = await k.call('GET', `${STORE}/me/pending`, tokens.customer(customerId));
    expect(res.body.products).toEqual([expect.objectContaining({ orderItemId: o.itemIds[0], productId: p1.productId, title: 'Pellar skillet', sellerName: 'Casa Verde Home', reviewBy: expect.any(String) })]);
    expect(res.body.sellerFeedback).toEqual([
      expect.objectContaining({ orderId: o.orderId, ownerType: 'seller', sellerId: s, sellerName: 'Casa Verde Home', eligible: true, availableNote: null }),
      expect.objectContaining({ ownerType: 'official', sellerId: null, eligible: false, availableNote: expect.stringContaining('Available after delivery') }),
    ]);
  });

  it('gives the write-a-review context and the per-item status', async () => {
    const b = buyer();
    const ctx = await k.call('GET', `${STORE}/me/review-context/${b.itemId}`, b.token);
    expect(ctx.status).toBe(200);
    expect(ctx.body).toMatchObject({ orderItemId: b.itemId, verifiedPurchase: true, existingReview: null, existingFeedback: null, feedbackEligible: true, minTextLength: 50, maxPhotos: 6, seller: { ownerType: 'seller', name: 'Northwind Audio' } });
    expect(ctx.body.guidelines.length).toBeGreaterThan(0);
    const before = await k.svc.reviewStatusForItems(b.customerId, [b.itemId, newId()]);
    expect(before[0]).toMatchObject({ canReview: true, reviewId: null, feedbackEligible: true, feedbackGiven: false });
    expect(before[1]).toMatchObject({ canReview: false });
    const r = await k.call('POST', `${STORE}/me/reviews`, b.token, reviewInput(b.itemId, { rating: 3 }));
    const after = await k.svc.reviewStatusForItems(b.customerId, [b.itemId]);
    expect(after[0]).toMatchObject({ canReview: false, reviewId: r.body.review.id, status: 'published', statusLabel: 'Published', rating: 3 });
    const ctx2 = await k.call('GET', `${STORE}/me/review-context/${b.itemId}`, b.token);
    expect(ctx2.body.existingReview.review.id).toBe(r.body.review.id);
    const notMine = await k.call('GET', `${STORE}/me/review-context/${b.itemId}`, tokens.customer(newId()));
    expect([notMine.status, notMine.body.error.code]).toEqual([422, 'REVIEW_NOT_ELIGIBLE']);
  });
});

describe('invitations', () => {
  const deliveredEvent = (b: ReturnType<typeof buyer>) => ({ orderId: b.orderId, groupId: b.groups[0]!.groupId, ownerType: 'seller', sellerId: newId(), itemId: b.itemId, quantity: 1, deliveredAt: k.clock.now().toISOString(), returnWindowEndsAt: new Date(k.clock.now().getTime() + 30 * DAY).toISOString(), customerId: b.customerId, contactEmail: 'buyer@example.com' });
  const invitesOf = (customerId: string) => k.of('reviews.invite.due').filter((e) => e.customerId === customerId);
  const runInvites = async () => {
    await k.app.kernel.jobs.runNow('reviews.invites');
    await k.app.kernel.events.drain();
  };

  it('publishes reviews.invite.due inviteDelayDays after delivery (from orders.listDeliveredItems), once', async () => {
    const b = buyer({ deliveredDaysAgo: 0 });
    await k.emit('orders', 'orders.item.delivered', deliveredEvent(b));
    // the event names the customer: orders is not asked who it was
    expect(k.svc.summaries.inviteCustomers.has(b.customerId)).toBe(true);
    expect(k.callsOf('orders.getOrderItem')).toEqual([]);
    await runInvites();
    expect(invitesOf(b.customerId)).toEqual([]);
    k.clock.advance(6 * DAY);
    await runInvites();
    expect(invitesOf(b.customerId)).toEqual([{ customerId: b.customerId, orderItemId: b.itemId, productId: b.productId, sellerId: expect.any(String) }]);
    expect(k.callsOf('orders.listDeliveredItems')).toContainEqual([b.customerId, expect.any(String)]);
    // every delivery is past its invitation time: the customer is no longer watched
    expect(k.svc.summaries.inviteCustomers.has(b.customerId)).toBe(false);
    await k.emit('orders', 'orders.item.delivered', { ...deliveredEvent(b), deliveredAt: new Date(k.clock.now().getTime() - 6 * DAY).toISOString() });
    await runInvites();
    expect(invitesOf(b.customerId)).toHaveLength(1);
    k.clock.advance(-6 * DAY);
  });

  it('survives a restart: the catch-up sweep finds due deliveries and the inbox keeps sent ones from repeating', async () => {
    const sent = buyer({ deliveredDaysAgo: 0 });
    const waiting = buyer({ deliveredDaysAgo: 0 });
    await k.emit('orders', 'orders.item.delivered', deliveredEvent(sent));
    k.clock.advance(6 * DAY);
    await runInvites();
    expect(invitesOf(sent.customerId)).toHaveLength(1);
    // a restart loses the customers heard of from events; the sweep goes through every customer again
    const summaries = k.svc.summaries as unknown as { inviteCustomers: Map<string, Date>; sweep: unknown };
    summaries.inviteCustomers.clear();
    summaries.sweep = {};
    await runInvites();
    expect(invitesOf(sent.customerId)).toHaveLength(1);
    expect(invitesOf(waiting.customerId)).toEqual([{ customerId: waiting.customerId, orderItemId: waiting.itemId, productId: waiting.productId, sellerId: expect.any(String) }]);
    k.clock.advance(-6 * DAY);
  });

  it('sends no invitation for a reviewed product, a cancelled item or a guest', async () => {
    const b = buyer({ deliveredDaysAgo: 0 });
    await k.emit('orders', 'orders.item.delivered', deliveredEvent(b));
    await k.call('POST', `${STORE}/me/reviews`, b.token, reviewInput(b.itemId));
    const c = buyer({ deliveredDaysAgo: 0 });
    await k.emit('orders', 'orders.item.delivered', deliveredEvent(c));
    // cancelled after all: orders no longer lists it as delivered
    const item = k.orders.get(c.orderId)!.groups[0]!.items[0]!;
    Object.assign(item, { state: 'cancelled', deliveredAt: null });
    await k.svc.onItemCancelledFromOrders({ ...deliveredEvent(c) } as never);
    await k.emit('orders', 'orders.item.delivered', { ...deliveredEvent(c), itemId: newId() });
    // a guest's delivery (no customerId) is not watched
    const guestsBefore = k.svc.summaries.inviteCustomers.size;
    await k.emit('orders', 'orders.item.delivered', { ...deliveredEvent(c), itemId: newId(), customerId: null });
    expect(k.svc.summaries.inviteCustomers.size).toBe(guestsBefore);
    k.clock.advance(6 * DAY);
    await runInvites();
    expect(invitesOf(b.customerId)).toEqual([]);
    expect(invitesOf(c.customerId)).toEqual([]);
    k.clock.advance(-6 * DAY);
  });
});

describe('GraphQL fields', () => {
  it('resolves Product.reviewSummary (batched), Product.reviews, Offer.sellerRating and OrderItem.reviewStatus', async () => {
    const gql = resolvers(k.svc) as any;
    const b = buyer();
    await k.call('POST', `${STORE}/me/reviews`, b.token, reviewInput(b.itemId, { rating: 4, showName: false }));
    const other = product(k);
    const ctx = { principal: { kind: 'customer', accountId: b.customerId, sessionId: 's' }, customerId: async () => b.customerId } as any;
    const [s1, s2] = await Promise.all([gql.Product.reviewSummary({ id: b.productId }, {}, ctx), gql.Product.reviewSummary({ id: other.productId }, {}, ctx)]);
    expect(s1).toMatchObject({ productId: b.productId, hasReviews: true, average: 4 });
    expect(s2).toMatchObject({ productId: other.productId, hasReviews: false, average: null });
    const page = await gql.Product.reviews({ id: b.productId }, { sort: 'HIGHEST_RATED' }, ctx);
    expect(page.items[0]).toMatchObject({ rating: 4, author: { kind: 'CUSTOMER', displayName: 'Marketly customer', verifiedPurchase: true }, viewerVotedHelpful: false });
    expect(await page.items[0].orderRef()).toBeNull();
    expect(await page.items[0].reportCount()).toBeNull();
    const rating = await gql.Offer.sellerRating({ id: newId(), ownerType: 'OFFICIAL', sellerId: null }, {}, ctx);
    expect(rating).toMatchObject({ official: true, sellerId: null });
    const status = await gql.OrderItem.reviewStatus({ id: b.itemId }, {}, ctx);
    expect(status).toMatchObject({ canReview: false, status: 'PUBLISHED', rating: 4, feedbackEligible: true });
    expect(await gql.OrderItem.reviewStatus({ id: b.itemId }, {}, { ...ctx, customerId: async () => null })).toBeNull();
    expect(await gql.Product.questions({ id: b.productId }, {}, ctx)).toMatchObject({ items: [] });
  });
});
