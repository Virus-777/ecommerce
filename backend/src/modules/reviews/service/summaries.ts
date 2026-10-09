/**
 * Rating summaries (read models kept on every change and refreshed by the summaries job), duplicate
 * merges, review invitations and the moderation SLA check.
 */
import { isUuid } from '../../../kernel/lib/ids.js';
import type { RatingSummary } from '../../../spec/reviews.js';
import { addDays, distribution, round1 } from '../domain/rules.js';
import type { ProductSummaryRec } from '../ports.js';
import { type Core, Effects, SYSTEM } from './core.js';

const BATCH = 200;

interface DeliveredItem {
  orderId: string;
  itemId: string;
  deliveredAt: Date;
}

export class SummariesPart {
  /**
   * Items delivered and waiting for their invitation. The spec has no table for delivered items, so the
   * queue lives in memory (a restart loses the invitations not yet due; see the module report).
   */
  readonly invitations = new Map<string, DeliveredItem>();

  constructor(private readonly core: Core) {}

  summaryOut(productId: string, r: ProductSummaryRec | undefined): RatingSummary {
    const count = r?.rating_count ?? 0;
    return {
      productId,
      hasReviews: count > 0,
      average: count ? round1(r!.sum_ratings / count) : null,
      ratingCount: count,
      writtenCount: r?.written_count ?? 0,
      distribution: distribution((r?.distribution as Record<string, number>) ?? {}, count),
      answeredQuestions: r?.answered_questions ?? 0,
      withPhotos: r?.with_photos ?? 0,
    };
  }

  /** One read of the projection; products without reviews get the honest no-reviews state */
  async ratingSummaries(productIds: readonly string[]): Promise<RatingSummary[]> {
    const ids = [...new Set(productIds.filter(isUuid))];
    const rows = new Map((await this.core.repo.productSummaries(ids)).map((r) => [r.product_id, r]));
    return ids.map((id) => this.summaryOut(id, rows.get(id)));
  }

  /* ---------------------------------------------------------------- merges */

  async moveProductContent(fromProductId: string, toProductId: string, variantId?: string | null): Promise<{ reviews: number; questions: number }> {
    if (!isUuid(fromProductId) || !isUuid(toProductId) || fromProductId === toProductId) return { reviews: 0, questions: 0 };
    const fx = new Effects();
    const moved = await this.core.repo.transaction(async (tx) => {
      const reviews = await tx.find('product_reviews', { product_id: fromProductId }, { forUpdate: true });
      const kept = new Set((await tx.find('product_reviews', { product_id: toProductId })).map((r) => r.customer_id));
      let n = 0;
      for (const r of reviews) {
        // one review per customer per product: the kept product's review stays, the duplicate's stays behind
        if (kept.has(r.customer_id)) continue;
        await tx.update('product_reviews', r.id, { product_id: toProductId, ...(variantId ? { variant_id: variantId } : {}) });
        kept.add(r.customer_id);
        n++;
      }
      const questions = await tx.updateWhere('questions', { product_id: fromProductId }, { product_id: toProductId });
      await this.core.touchProduct(tx, fx, fromProductId);
      await this.core.touchProduct(tx, fx, toProductId);
      return { reviews: n, questions };
    });
    await this.core.flush(fx, { actor: SYSTEM });
    return moved;
  }

  /* ---------------------------------------------------------------- jobs */

  /** Refreshes every product and seller projection (the seller window rolls with time) */
  async refreshAll(): Promise<{ products: number; sellers: number }> {
    let products = 0;
    let after: string | null = null;
    for (;;) {
      const ids = await this.core.repo.productIdsAfter(after, BATCH);
      if (!ids.length) break;
      for (const id of ids) {
        const fx = new Effects();
        await this.core.repo.transaction((tx) => this.core.touchProduct(tx, fx, id));
        if (fx.productRatings.size) products++;
        await this.core.flush(fx, { actor: SYSTEM });
      }
      after = ids.at(-1)!;
      if (ids.length < BATCH) break;
    }
    let sellers = 0;
    after = null;
    const prepared = await this.core.prepare(new Effects());
    for (;;) {
      const ids = await this.core.repo.sellerIdsAfter(after, BATCH);
      if (!ids.length) break;
      for (const id of ids) {
        const fx = new Effects();
        fx.sellerSince = prepared.sellerSince;
        fx.threshold = prepared.threshold;
        await this.core.repo.transaction((tx) => this.core.touchSeller(tx, fx, id));
        if (fx.sellers.size) sellers++;
        await this.core.flush(fx, { actor: SYSTEM });
      }
      after = ids.at(-1)!;
      if (ids.length < BATCH) break;
    }
    return { products, sellers };
  }

  /** Publishes reviews.invite.due for items delivered inviteDelayDays ago that the customer has not reviewed */
  async sendInvitations(): Promise<number> {
    const delay = await this.core.num('inviteDelayDays');
    const now = this.core.now();
    const due = [...this.invitations.values()].filter((i) => addDays(i.deliveredAt, delay) <= now).slice(0, 500);
    if (!due.length) return 0;
    const orders = await this.core.orders(due.map((d) => d.orderId));
    let sent = 0;
    for (const d of due) {
      const order = orders.get(d.orderId);
      const item = order ? this.core.purchasesOf(order).find((p) => p.orderItemId === d.itemId) : undefined;
      const customerId = order?.contact.customerId;
      if (item && customerId && item.delivered) {
        const reviewed = await this.core.repo.findOne('product_reviews', { customer_id: customerId, product_id: item.productId, status: { op: '<>', value: 'deleted' } });
        if (!reviewed) {
          this.core.publish('reviews.invite.due', { customerId, orderItemId: item.orderItemId, productId: item.productId, sellerId: item.sellerId });
          sent++;
        }
      }
      // done either way (unknown orders and guests get no invitation)
      if (order || addDays(d.deliveredAt, delay + 7) <= now) this.invitations.delete(d.itemId);
    }
    return sent;
  }

  async moderationSla(): Promise<number> {
    const hours = await this.core.num('moderationTargetHours');
    const overdue = await this.core.repo.overdueItems(new Date(this.core.now().getTime() - hours * 3_600_000), 200);
    if (overdue.length) {
      this.core.ctx.log.warn(
        { overdue: overdue.length, items: overdue.slice(0, 20).map((i) => ({ id: i.id, queue: i.queue, contentType: i.content_type, since: i.first_reported_at.toISOString() })) },
        `reviews: ${overdue.length} moderation item(s) open longer than ${hours} h`,
      );
    }
    return overdue.length;
  }
}
