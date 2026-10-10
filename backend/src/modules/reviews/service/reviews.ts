/**
 * Product reviews: Verified Purchase eligibility from delivered order items, writing, editing and deleting,
 * helpful votes, the public list with filters, the customer's pending list and the write-a-review context.
 */
import { AppError } from '../../../kernel/errors/index.js';
import { isUuid, newId } from '../../../kernel/lib/ids.js';
import { pageOf, type PageRequest } from '../../../kernel/lib/pagination.js';
import type * as common from '../../../spec/common.js';
import type * as orders from '../../../spec/orders.js';
import type { AdminReviewRow, MyReview, PendingReviews, ProductReview, ReviewContext, ReviewInput, ReviewUpdateInput } from '../../../spec/reviews.js';
import { addDays, OFFICIAL_STORE_ID, REVIEW_GUIDELINES, REVIEW_STATUS_LABEL, reviewChecks } from '../domain/rules.js';
import { productReviewMachine } from '../domain/state-machines.js';
import type { ReviewRec, ReviewsRepository } from '../ports.js';
import { type Core, type CustomerWho, Effects, invalid, notFound, type Purchase } from './core.js';
import type { FeedbackPart } from './feedback.js';
import type { ModerationPart } from './moderation.js';
import { validUrl, type Views } from './views.js';

const MAX_HEADLINE = 120;
const MAX_TEXT = 5000;

export interface ItemReviewStatus {
  orderItemId: string;
  canReview: boolean;
  reviewBy: string | null;
  reviewId: string | null;
  status: string | null;
  statusLabel: string | null;
  rating: number | null;
  feedbackEligible: boolean;
  feedbackGiven: boolean;
}

export class ReviewsPart {
  feedback!: FeedbackPart;

  constructor(
    private readonly core: Core,
    private readonly views: Views,
    private readonly moderation: ModerationPart,
  ) {}

  /* ================================================================ public list */

  async listProductReviews(
    productId: string,
    filter: { stars?: number; critical?: boolean; verifiedOnly?: boolean; withPhotos?: boolean; variantLabel?: string; variantId?: string },
    sort: string | undefined,
    page: PageRequest,
    viewerCustomerId: string | null,
  ): Promise<common.Page<ProductReview>> {
    if (!isUuid(productId)) return pageOf([], page);
    let variantIds: string[] | undefined = filter.variantId ? [filter.variantId] : undefined;
    if (filter.variantLabel) {
      const p = await this.core.product(productId);
      const wanted = filter.variantLabel.trim().toLowerCase();
      variantIds = (p?.variants ?? []).filter((v) => (this.core.variantLabel(p, v.id) ?? '').toLowerCase() === wanted || Object.values(v.options).some((o) => o.toLowerCase() === wanted)).map((v) => v.id);
    }
    const s = (['most_helpful', 'newest', 'highest', 'lowest'] as const).find((x) => x === sort?.toLowerCase().replace('_rated', '')) ?? 'most_helpful';
    const rows = await this.core.repo.listReviews(
      {
        productId,
        publicOnly: true,
        ...(filter.stars ? { stars: filter.stars } : {}),
        ...(filter.critical ? { critical: true } : {}),
        ...(filter.verifiedOnly ? { verifiedOnly: true } : {}),
        ...(filter.withPhotos ? { withPhotos: true } : {}),
        ...(variantIds ? { variantIds } : {}),
        sort: s,
      },
      page,
    );
    return { ...rows, items: await this.views.reviews(rows.items, { viewerCustomerId }) };
  }

  /* ================================================================ purchases */

  private requireCustomer(who: CustomerWho): string {
    if (!who.customerId) throw this.core.ctx.error('REVIEW_NOT_ELIGIBLE', 'Only customers with a delivered purchase can review it.');
    return who.customerId;
  }

  /** The customer's delivered order item (orders.getOrderItem), with its order for titles and the package */
  private async eligibleItem(customerId: string, orderItemId: string): Promise<{ item: Purchase; order: orders.OrderDetail | null; reviewBy: Date; open: boolean }> {
    const info = await this.core.orderItem(customerId, orderItemId);
    if (!info || !this.core.isDelivered(info)) throw this.core.ctx.error('REVIEW_NOT_ELIGIBLE', 'You can review an item once it has been delivered to you.');
    const order = (await this.core.orders([info.orderId])).get(info.orderId) ?? null;
    const item = this.core.purchaseOf(info, order);
    const reviewBy = addDays(item.deliveredAt!, await this.core.num('reviewWindowDays'));
    return { item, order, reviewBy, open: this.core.now() <= reviewBy };
  }

  /* ================================================================ write */

  private async validate(input: { rating?: number | null; headline?: string | null; text?: string | null; mediaIds?: string[] | null }, submit: boolean) {
    const issues: { path: string; message: string }[] = [];
    const [minLength, maxPhotos] = await Promise.all([this.core.num('minReviewLength'), this.core.num('maxReviewPhotos')]);
    if (input.rating != null && (!Number.isInteger(input.rating) || input.rating < 1 || input.rating > 5)) issues.push({ path: 'rating', message: 'Choose 1 to 5 stars' });
    if (input.headline != null && input.headline.trim().length > MAX_HEADLINE) issues.push({ path: 'headline', message: `The headline is too long (${MAX_HEADLINE} characters at most)` });
    if (submit && input.headline != null && !input.headline.trim()) issues.push({ path: 'headline', message: 'Add a headline' });
    if (input.text != null && input.text.length > MAX_TEXT) issues.push({ path: 'text', message: `The review is too long (${MAX_TEXT} characters at most)` });
    if (submit && input.text != null && input.text.trim().length < minLength) issues.push({ path: 'text', message: `Write at least ${minLength} characters about the product` });
    if (input.mediaIds && new Set(input.mediaIds).size > maxPhotos) issues.push({ path: 'mediaIds', message: `Add up to ${maxPhotos} photos` });
    if (issues.length) throw invalid(issues);
  }

  /** Photos are the customer's own review_photo uploads (media checks owner and purpose) */
  private async attachPhotos(reviewId: string, mediaIds: readonly string[], who: CustomerWho, label: string) {
    if (!mediaIds.length) return;
    const media = this.core.ctx.tryUse('media');
    if (!media) throw invalid([{ path: 'mediaIds', message: "Photos can't be added right now" }]);
    for (const id of mediaIds) {
      await media.attach(id, { module: 'reviews', kind: 'review_photo', refId: reviewId, refLabel: label }, { kind: 'customer', id: who.accountId ?? who.customerId });
    }
  }

  async create(who: CustomerWho, input: ReviewInput): Promise<MyReview> {
    const customerId = this.requireCustomer(who);
    const { item, open } = await this.eligibleItem(customerId, input.orderItemId);
    const repo = this.core.repo;
    const existing = await repo.findOne('product_reviews', { customer_id: customerId, product_id: item.productId });
    if (existing && existing.status !== 'deleted') throw this.core.ctx.error('ALREADY_REVIEWED', 'You already reviewed this product. Edit your review instead.', { id: existing.id });
    if (!open) throw this.core.ctx.error('REVIEW_NOT_ELIGIBLE', 'The time to review this purchase has ended.');
    const draft = Boolean(input.draft);
    await this.validate(input, !draft);
    const mediaIds = [...new Set(input.mediaIds ?? [])];
    const id = existing?.id ?? newId();
    const displayName = await this.core.shortNameOf(customerId);
    await this.attachPhotos(id, mediaIds, who, `Review of ${item.title}`);
    const failures = draft ? [] : reviewChecks(input.headline, input.text);
    const status = draft ? 'draft' : productReviewMachine.next(productReviewMachine.next('draft', 'submit'), failures.length ? 'hold' : 'publish');
    const fx = await this.core.prepare(new Effects());
    const now = this.core.now();
    const row: ReviewRec = {
      id,
      product_id: item.productId,
      variant_id: item.variantId,
      order_item_id: item.orderItemId,
      order_id: item.orderId,
      seller_id: item.sellerId,
      customer_id: customerId,
      display_name: displayName,
      show_name: input.showName,
      verified: true,
      rating: input.rating,
      headline: input.headline.trim(),
      body: input.text.trim(),
      media_ids: mediaIds,
      status,
      visible: status === 'published',
      helpful_count: 0,
      created_at: now,
      published_at: status === 'published' ? now : null,
      edited_at: null,
    };
    try {
      await repo.transaction(async (tx) => {
        const again = await tx.findOne('product_reviews', { customer_id: customerId, product_id: item.productId }, { forUpdate: true });
        if (again && again.status !== 'deleted') throw this.core.ctx.error('ALREADY_REVIEWED', 'You already reviewed this product. Edit your review instead.', { id: again.id });
        if (again) await tx.update('product_reviews', again.id, { ...row, id: again.id, helpful_count: 0 });
        else await tx.insert('product_reviews', row);
        if (status === 'held') await this.moderation.hold(tx, { type: 'product_review', id }, failures);
        if (status === 'published') {
          await this.core.touchProduct(tx, fx, item.productId);
          fx.emit('reviews.review.published', { reviewId: id, productId: item.productId, sellerId: item.sellerId, rating: input.rating, verified: true });
        }
      });
    } catch (err) {
      if (!existing) await this.detach(id, mediaIds);
      throw err;
    }
    await this.core.flush(fx, who);
    return this.mine(customerId, id);
  }

  private async detach(reviewId: string, mediaIds: readonly string[]) {
    const media = this.core.ctx.tryUse('media');
    for (const assetId of mediaIds) await media?.detach(assetId, { module: 'reviews', kind: 'review_photo', refId: reviewId }).catch(() => undefined);
  }

  private async ownReview(customerId: string | null, id: string, o: { forUpdate?: boolean; repo?: ReviewsRepository } = {}): Promise<ReviewRec> {
    const row = customerId && isUuid(id) ? await (o.repo ?? this.core.repo).get('product_reviews', id, o) : undefined;
    if (!row || row.customer_id !== customerId || row.status === 'deleted') throw notFound('Review');
    return row;
  }

  async mine(customerId: string, id: string): Promise<MyReview> {
    const row = await this.ownReview(customerId, id);
    return (await this.views.myReviews([row], customerId))[0]!;
  }

  /**
   * Edits re-run the checks. A published review edited goes back through them; after an edit request or a
   * removal the fixed review waits for a moderator. A draft stays a draft until draft: false.
   */
  async update(who: CustomerWho, id: string, input: ReviewUpdateInput): Promise<MyReview> {
    const customerId = this.requireCustomerFor404(who);
    const row = await this.ownReview(customerId, id);
    const from = row.status as MyReview['status'];
    const submitting = from === 'draft' ? input.draft === false : true;
    const merged = {
      rating: input.rating ?? row.rating,
      headline: input.headline ?? row.headline,
      text: input.text ?? row.body,
      mediaIds: input.mediaIds ?? ((row.media_ids as string[]) ?? []),
      showName: input.showName ?? row.show_name,
    };
    // the event the author's change makes (ILLEGAL_TRANSITION for held or pending reviews)
    const event = from === 'draft' ? (submitting ? 'submit' : null) : from === 'published' ? 'edit' : 'resubmit';
    if (event) productReviewMachine.next(from, event);
    if (from === 'removed') {
      const outcome = (await this.views.outcomes('product_review', [row])).get(row.id);
      if (outcome?.decision?.reason_code === 'proven_fake') throw new AppError('ILLEGAL_TRANSITION', 'This review was removed after a Trust and Risk investigation and cannot be resubmitted', { machine: 'Product review', from, event: 'resubmit' });
    }
    await this.validate({ ...merged, mediaIds: merged.mediaIds }, submitting);
    if (submitting && from === 'draft') {
      const { open } = await this.eligibleItem(customerId, row.order_item_id);
      if (!open) throw this.core.ctx.error('REVIEW_NOT_ELIGIBLE', 'The time to review this purchase has ended.');
    }
    const newMedia = [...new Set(merged.mediaIds)];
    const oldMedia = (row.media_ids as string[]) ?? [];
    const added = newMedia.filter((m) => !oldMedia.includes(m));
    const dropped = oldMedia.filter((m) => !newMedia.includes(m));
    const product = await this.core.product(row.product_id);
    await this.attachPhotos(row.id, added, who, `Review of ${product?.title ?? 'a product'}`);
    const failures = submitting ? reviewChecks(merged.headline, merged.text) : [];
    const resubmission = from === 'edit_requested' || from === 'removed';
    let status: string = from;
    if (event) {
      const pending = productReviewMachine.next(from, event);
      status = productReviewMachine.next(pending, failures.length || resubmission ? 'hold' : 'publish');
    }
    const fx = await this.core.prepare(new Effects());
    const now = this.core.now();
    fx.detach.push(...dropped.map((assetId) => ({ assetId, refId: row.id })));
    await this.core.repo.transaction(async (tx) => {
      const locked = await this.ownReview(customerId, id, { forUpdate: true, repo: tx });
      if (locked.status !== from) throw new AppError('CONFLICT', 'Your review changed in the meantime. Reload it and try again.');
      const updated = await tx.update('product_reviews', row.id, {
        rating: merged.rating,
        headline: merged.headline.trim(),
        body: merged.text.trim(),
        media_ids: newMedia,
        show_name: merged.showName,
        status,
        visible: status === 'published',
        ...(status === 'published' && !row.published_at ? { published_at: now } : {}),
        ...(from !== 'draft' ? { edited_at: now } : {}),
      });
      if (status === 'held') {
        await this.moderation.hold(tx, { type: 'product_review', id: row.id }, failures.length ? failures : [{ label: 'Resubmitted after a moderation decision', reason: 'other' }], {
          queue: 'auto_held',
          ...(resubmission ? { note: ['Resubmitted after a moderation decision', ...failures.map((f) => f.label)].join('; ') } : {}),
        });
      }
      if (from !== 'draft' || status !== 'draft') await this.core.touchProduct(tx, fx, row.product_id);
      if (from !== 'draft') fx.emit('reviews.review.updated', { reviewId: row.id, productId: row.product_id });
      if (status === 'published') fx.emit('reviews.review.published', { reviewId: row.id, productId: row.product_id, sellerId: row.seller_id, rating: updated.rating, verified: updated.verified });
    });
    await this.core.flush(fx, who);
    return this.mine(customerId, id);
  }

  private requireCustomerFor404(who: CustomerWho): string {
    if (!who.customerId) throw notFound('Review');
    return who.customerId;
  }

  async remove(who: CustomerWho, id: string): Promise<void> {
    const customerId = this.requireCustomerFor404(who);
    const row = await this.ownReview(customerId, id);
    productReviewMachine.next(row.status as MyReview['status'], 'delete');
    const fx = await this.core.prepare(new Effects());
    await this.core.repo.transaction(async (tx) => {
      const locked = await this.ownReview(customerId, id, { forUpdate: true, repo: tx });
      const status = productReviewMachine.next(locked.status as MyReview['status'], 'delete');
      await tx.update('product_reviews', id, { status, visible: false });
      await this.core.touchProduct(tx, fx, locked.product_id);
      if (locked.status !== 'draft') fx.emit('reviews.review.removed', { reviewId: id, productId: locked.product_id, sellerId: locked.seller_id, customerId: locked.customer_id, byModeration: false, reasonCode: null, trustEnforcementId: null });
      fx.detach.push(...((locked.media_ids as string[]) ?? []).map((assetId) => ({ assetId, refId: id })));
      await this.moderation.closeForDeleted(tx, 'product_review', id);
    });
    await this.core.flush(fx, who);
  }

  /** Staff search over all reviews, any status */
  async listAdmin(filter: { productId?: string; sellerId?: string; customerId?: string; status?: string; rating?: number; q?: string }, page: PageRequest): Promise<common.Page<AdminReviewRow>> {
    const rows = await this.core.repo.listReviews(
      {
        ...(filter.productId ? { productId: filter.productId } : {}),
        ...(filter.sellerId ? { sellerId: filter.sellerId } : {}),
        ...(filter.customerId ? { customerId: filter.customerId } : {}),
        ...(filter.status ? { statuses: filter.status.split(',').map((s) => s.trim()).filter(Boolean) } : {}),
        ...(filter.rating ? { stars: filter.rating } : {}),
        ...(filter.q?.trim() ? { q: filter.q } : {}),
        sort: 'newest',
      },
      page,
    );
    const [reviews, orders, reports] = await Promise.all([
      this.views.reviews(rows.items, { internal: true }),
      this.core.orders(rows.items.map((r) => r.order_id)),
      this.core.repo.countReportsByTarget('product_review', rows.items.map((r) => r.id)),
    ]);
    return {
      ...rows,
      items: rows.items.map((r, i) => ({ review: reviews[i]!, status: r.status, orderRef: orders.get(r.order_id)?.ref ?? '', customerId: r.customer_id, reportCount: reports.get(r.id) ?? 0 })),
    };
  }

  async listMine(customerId: string | null, page: PageRequest): Promise<common.Page<MyReview>> {
    if (!customerId) return pageOf([], page);
    const rows = await this.core.repo.listReviews({ customerId, statuses: ['draft', 'pending', 'published', 'held', 'edit_requested', 'removed'] }, page);
    return { ...rows, items: await this.views.myReviews(rows.items, customerId) };
  }

  /* ================================================================ votes */

  async vote(who: CustomerWho, input: { targetType: 'product_review' | 'answer'; targetId: string; helpful: boolean }): Promise<{ helpfulCount: number }> {
    const repo = this.core.repo;
    if (!who.customerId) throw notFound('Content');
    const customerId = who.customerId;
    if (input.targetType === 'product_review') {
      const r = isUuid(input.targetId) ? await repo.get('product_reviews', input.targetId) : undefined;
      if (!r || r.status !== 'published' || !r.visible) throw notFound('Review');
      if (r.customer_id === customerId) throw invalid([{ path: 'targetId', message: "You can't vote on your own review" }]);
    } else {
      const a = isUuid(input.targetId) ? await repo.get('answers', input.targetId) : undefined;
      if (!a || a.status !== 'published' || (await repo.hiddenByReport('answer', [a.id])).size) throw notFound('Answer');
      if (a.author_kind === 'customer' && a.author_id === customerId) throw invalid([{ path: 'targetId', message: "You can't vote on your own answer" }]);
    }
    const now = this.core.now();
    const helpfulCount = await repo.transaction(async (tx) => {
      await tx.upsertVote({ target_type: input.targetType, target_id: input.targetId, customer_id: customerId, helpful: input.helpful, at: now });
      const n = await tx.countHelpful(input.targetType, input.targetId);
      if (input.targetType === 'product_review') await tx.update('product_reviews', input.targetId, { helpful_count: n });
      else await tx.update('answers', input.targetId, { helpful_count: n });
      return n;
    });
    return { helpfulCount };
  }

  /* ================================================================ pending and context */

  async pending(customerId: string | null): Promise<PendingReviews> {
    if (!customerId) return { products: [], sellerFeedback: [] };
    const [window, feedbackWindow] = await Promise.all([this.core.num('reviewWindowDays'), this.core.num('sellerFeedbackWindowDays')]);
    const now = this.core.now();
    // deliveries still inside the review or the feedback window; their orders give titles and packages
    const delivered = (await this.core.deliveredItems(customerId, addDays(now, -Math.max(window, feedbackWindow)))).filter((i) => this.core.isDelivered(i));
    const orders = await this.core.orders(delivered.map((i) => i.orderId));
    const reviewed = new Set(
      (await this.core.repo.find('product_reviews', { customer_id: customerId, status: { op: '<>', value: 'deleted' } })).map((r) => r.product_id),
    );
    const latest = new Map<string, Purchase>();
    for (const p of delivered.map((i) => this.core.purchaseOf(i, orders.get(i.orderId)))) {
      if (!p.delivered || !p.deliveredAt || reviewed.has(p.productId)) continue;
      if (addDays(p.deliveredAt, window) < now) continue;
      const prev = latest.get(p.productId);
      if (!prev || prev.deliveredAt! < p.deliveredAt) latest.set(p.productId, p);
    }
    const products = [...latest.values()]
      .sort((a, b) => b.deliveredAt!.getTime() - a.deliveredAt!.getTime())
      .map((p) => ({
        orderItemId: p.orderItemId,
        orderId: p.orderId,
        orderRef: p.orderRef,
        productId: p.productId,
        title: p.title,
        imageUrl: validUrl(p.imageUrl),
        variantLabel: p.variantLabel,
        deliveredAt: p.deliveredAt!.toISOString(),
        sellerName: p.sellerName,
        reviewBy: addDays(p.deliveredAt!, window).toISOString(),
      }));
    return { products, sellerFeedback: await this.feedback.pendingFor(customerId, [...orders.values()]) };
  }

  async context(who: CustomerWho, orderItemId: string): Promise<ReviewContext> {
    const customerId = this.requireCustomer(who);
    const { item, order, open } = await this.eligibleItem(customerId, orderItemId);
    const repo = this.core.repo;
    const existing = await repo.findOne('product_reviews', { customer_id: customerId, product_id: item.productId, status: { op: '<>', value: 'deleted' } });
    if (!existing && !open) throw this.core.ctx.error('REVIEW_NOT_ELIGIBLE', 'The time to review this purchase has ended.');
    const pkg = order ? this.core.packagesOf(order).find((p) => p.groupId === item.groupId) : undefined;
    const fb = pkg ? await this.feedback.packageState(customerId, pkg) : { eligible: false, feedback: null };
    const product = await this.core.product(item.productId);
    const [minTextLength, maxPhotos] = await Promise.all([this.core.num('minReviewLength'), this.core.num('maxReviewPhotos')]);
    return {
      orderItemId: item.orderItemId,
      orderId: item.orderId,
      orderRef: item.orderRef,
      product: {
        id: item.productId,
        title: product?.title ?? item.title,
        imageUrl: validUrl(this.core.productImage(product)?.url ?? item.imageUrl),
        variantLabel: item.variantLabel,
      },
      deliveredAt: item.deliveredAt!.toISOString(),
      verifiedPurchase: true,
      seller: { ownerType: item.ownerType, id: item.ownerType === 'official' ? OFFICIAL_STORE_ID : (item.sellerId ?? OFFICIAL_STORE_ID), name: item.sellerName },
      existingReview: existing ? (await this.views.myReviews([existing], customerId))[0]! : null,
      existingFeedback: fb.feedback ? (await this.views.myFeedback([fb.feedback]))[0]! : null,
      feedbackEligible: fb.eligible,
      guidelines: REVIEW_GUIDELINES,
      minTextLength,
      maxPhotos,
    };
  }

  /** OrderItem.reviewStatus, batched */
  async statusForItems(customerId: string, orderItemIds: readonly string[]): Promise<ItemReviewStatus[]> {
    const empty = (orderItemId: string): ItemReviewStatus => ({ orderItemId, canReview: false, reviewBy: null, reviewId: null, status: null, statusLabel: null, rating: null, feedbackEligible: false, feedbackGiven: false });
    if (!isUuid(customerId) || !orderItemIds.length) return orderItemIds.map(empty);
    const items = await this.core.orderItems(customerId, orderItemIds);
    const orders = await this.core.orders([...items.values()].map((i) => i.orderId));
    const purchases = new Map([...items.values()].map((i) => [i.id, this.core.purchaseOf(i, orders.get(i.orderId))]));
    const packages = new Map([...orders.values()].flatMap((o) => this.core.packagesOf(o)).map((p) => [p.groupId, p]));
    const window = await this.core.num('reviewWindowDays');
    const reviews = await this.core.repo.find('product_reviews', { customer_id: customerId, status: { op: '<>', value: 'deleted' } });
    const byProduct = new Map(reviews.map((r) => [r.product_id, r]));
    const now = this.core.now();
    const out: ItemReviewStatus[] = [];
    for (const id of orderItemIds) {
      const p = purchases.get(id);
      if (!p) {
        out.push(empty(id));
        continue;
      }
      const review = byProduct.get(p.productId);
      const reviewBy = p.delivered && p.deliveredAt ? addDays(p.deliveredAt, window) : null;
      const pkg = packages.get(p.groupId);
      const fb = pkg ? await this.feedback.packageState(customerId, pkg) : { eligible: false, feedback: null };
      out.push({
        orderItemId: id,
        canReview: Boolean(reviewBy && reviewBy >= now && !review),
        reviewBy: reviewBy?.toISOString() ?? null,
        reviewId: review?.id ?? null,
        status: review?.status ?? null,
        statusLabel: review ? (REVIEW_STATUS_LABEL[review.status] ?? review.status) : null,
        rating: review?.rating ?? null,
        feedbackEligible: fb.eligible,
        feedbackGiven: Boolean(fb.feedback && fb.feedback.status !== 'draft'),
      });
    }
    return out;
  }
}
