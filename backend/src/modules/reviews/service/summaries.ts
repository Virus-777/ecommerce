/**
 * Rating summaries (read models kept on every change and refreshed by the summaries job), duplicate
 * merges, review invitations and the moderation SLA check.
 */
import { isUuid } from '../../../kernel/lib/ids.js';
import type { RatingSummary } from '../../../spec/reviews.js';
import { addDays, distribution, OFFICIAL_STORE_ID, round1, sellerKey } from '../domain/rules.js';
import type { ProductSummaryRec } from '../ports.js';
import { type Core, Effects, SYSTEM } from './core.js';

const BATCH = 200;
/** Deliveries older than inviteDelayDays + this get no invitation (a late reminder is noise) */
const INVITE_GRACE_DAYS = 7;
/** Customers checked per job run (recent deliveries first, then the catch-up sweep) */
const INVITE_CUSTOMERS_PER_RUN = 1000;

export class SummariesPart {
  /**
   * Invitations are computed from orders (listDeliveredItems) in the job, and each is claimed once in the
   * inbox (`invite:<orderItemId>`), so they survive restarts and are never sent twice. The spec has no table
   * of delivered items, so which customers to look at comes from orders.item.delivered (its customerId → latest
   * delivery, kept in memory until every delivery is past its invitation time) and, after a restart (the
   * memory is gone), from a sweep of all customers (customers.searchCustomers) in bounded batches.
   */
  readonly inviteCustomers = new Map<string, Date>();
  /** Cursor of the catch-up sweep; null once it has gone through every customer */
  private sweep: { cursor?: string } | null = {};

  constructor(private readonly core: Core) {}

  /** orders.item.delivered: remember the customer the event names */
  noteDelivery(customerId: string | null | undefined, deliveredAt: Date): void {
    if (!customerId || !isUuid(customerId)) return; // guests get no invitation
    const prev = this.inviteCustomers.get(customerId);
    if (!prev || prev < deliveredAt) this.inviteCustomers.set(customerId, deliveredAt);
  }

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
    const dueBy = addDays(now, -delay);
    const horizon = addDays(now, -(delay + INVITE_GRACE_DAYS));
    // customers with a recent delivery first; then the next batch of the catch-up sweep
    const customers = new Set([...this.inviteCustomers.keys()].slice(0, INVITE_CUSTOMERS_PER_RUN));
    if (this.sweep && customers.size < INVITE_CUSTOMERS_PER_RUN) {
      const page = await this.core.optional('customers', (c) => c.searchCustomers({}, { limit: INVITE_CUSTOMERS_PER_RUN - customers.size, ...(this.sweep?.cursor ? { cursor: this.sweep.cursor } : {}) }));
      for (const c of page?.items ?? []) customers.add(c.id);
      this.sweep = page?.nextCursor ? { cursor: page.nextCursor } : null;
    }
    let sent = 0;
    for (const customerId of customers) {
      const items = await this.core.soft('orders.listDeliveredItems', () => this.core.deliveredItems(customerId, horizon));
      if (!items) continue; // orders could not answer: try again next run
      for (const item of items) {
        if (!this.core.isDelivered(item)) continue;
        const at = new Date(item.deliveredAt!);
        if (at > dueBy || at < horizon) continue;
        if (await this.core.ctx.inbox.seen(this.core.ctx.db, `invite:${item.id}`)) continue;
        const reviewed = await this.core.repo.findOne('product_reviews', { customer_id: customerId, product_id: item.productId, status: { op: '<>', value: 'deleted' } });
        if (reviewed) continue;
        if (!(await this.core.ctx.inbox.claim(this.core.ctx.db, `invite:${item.id}`))) continue;
        const sellerId = item.ownerType === 'official' ? OFFICIAL_STORE_ID : sellerKey(item.sellerId);
        this.core.publish('reviews.invite.due', { customerId, orderItemId: item.id, productId: item.productId, sellerId });
        sent++;
      }
      // every delivery of the customer is past its invitation time: nothing more to wait for
      const latest = this.inviteCustomers.get(customerId);
      if (latest && addDays(latest, delay) <= now) this.inviteCustomers.delete(customerId);
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
