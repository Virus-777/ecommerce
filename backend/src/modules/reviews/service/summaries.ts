/**
 * Rating summaries (read models kept on every change and refreshed by the summaries job), duplicate
 * merges, review invitations and the moderation SLA check.
 */
import { isUuid } from '../../../kernel/lib/ids.js';
import type * as common from '../../../spec/common.js';
import type { RatingSummary } from '../../../spec/reviews.js';
import { addDays, CONTENT_NOUN, type ContentType, distribution, OFFICIAL_STORE_ID, round1, sellerKey } from '../domain/rules.js';
import type { ProductSummaryRec } from '../ports.js';
import { type Core, Effects, SYSTEM } from './core.js';

const BATCH = 200;
/** Invitations due longer ago than this are dropped (a late reminder is noise) */
const INVITE_GRACE_DAYS = 7;
/** Batches of due invitations per job run */
const INVITE_ROUNDS = 25;
const FORMER_CUSTOMER = 'Former customer';

export class SummariesPart {
  constructor(private readonly core: Core) {}

  /**
   * orders.item.delivered: the delivered item waits for its review invitation in review_invites (decision D-R2),
   * due inviteDelayDays after delivery, so invitations survive restarts and are sent once. Guests get none.
   */
  async noteDelivery(e: { orderId: string; itemId: string; ownerType: 'official' | 'seller'; sellerId?: string | null; deliveredAt: string; customerId?: string | null }): Promise<void> {
    if (!e.customerId || !isUuid(e.customerId)) return;
    const info = await this.core.soft('orders.getOrderItem', () => this.core.ctx.use('orders').getOrderItem(e.itemId));
    if (!info) {
      this.core.ctx.log.info({ itemId: e.itemId }, 'reviews: delivered item unknown to orders; no invitation');
      return;
    }
    const delay = await this.core.num('inviteDelayDays');
    const deliveredAt = new Date(e.deliveredAt);
    await this.core.repo.insertIfAbsent('review_invites', {
      order_item_id: e.itemId,
      order_id: e.orderId,
      customer_id: e.customerId,
      product_id: info.productId,
      seller_id: e.ownerType === 'official' ? OFFICIAL_STORE_ID : sellerKey(e.sellerId),
      delivered_at: deliveredAt,
      due_at: addDays(deliveredAt, delay),
      state: 'pending',
      sent_at: null,
      updated_at: this.core.now(),
    });
  }

  /** orders.item.cancelled: a pending invitation of the item is cancelled */
  async cancelInvite(orderItemId: string): Promise<void> {
    if (!isUuid(orderItemId)) return;
    await this.core.repo.updateWhere('review_invites', { order_item_id: orderItemId, state: 'pending' }, { state: 'cancelled', updated_at: this.core.now() });
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

  /**
   * Job reviews.invites: publishes reviews.invite.due for pending review_invites past due_at whose item is still
   * unreviewed (marked sent; each claimed once in the inbox as invite:<orderItemId>); reviewed items become reviewed,
   * and invitations more than a week late are dropped (a late reminder is noise).
   */
  async sendInvitations(): Promise<number> {
    const now = this.core.now();
    const tooLate = addDays(now, -INVITE_GRACE_DAYS);
    let sent = 0;
    for (let round = 0; round < INVITE_ROUNDS; round++) {
      const due = await this.core.repo.find('review_invites', { state: 'pending', due_at: { op: '<=', value: now } }, { orderBy: [['due_at', 'asc']], limit: BATCH });
      for (const inv of due) {
        const reviewed = await this.core.repo.findOne('product_reviews', { customer_id: inv.customer_id, product_id: inv.product_id, status: { op: '<>', value: 'deleted' } });
        if (reviewed || inv.due_at < tooLate) {
          await this.core.repo.updateWhere('review_invites', { order_item_id: inv.order_item_id, state: 'pending' }, { state: reviewed ? 'reviewed' : 'cancelled', updated_at: now });
          continue;
        }
        const claimed = await this.core.repo.transaction(async (tx) => {
          if (!(await tx.claim(`invite:${inv.order_item_id}`))) {
            await tx.updateWhere('review_invites', { order_item_id: inv.order_item_id }, { state: 'sent', updated_at: now });
            return false;
          }
          await tx.updateWhere('review_invites', { order_item_id: inv.order_item_id }, { state: 'sent', sent_at: now, updated_at: now });
          return true;
        });
        if (!claimed) continue;
        this.core.publish('reviews.invite.due', { customerId: inv.customer_id, orderItemId: inv.order_item_id, productId: inv.product_id, sellerId: inv.seller_id });
        sent++;
      }
      if (due.length < BATCH) break;
    }
    return sent;
  }

  /**
   * Job reviews.moderation-sla: a review_moderation_overdue work item in reviews.moderation for every open moderation
   * item older than moderationTargetHours (dedupe review_moderation_overdue:<moderationItemId>); it is resolved when
   * the item is decided.
   */
  async moderationSla(): Promise<number> {
    const hours = await this.core.num('moderationTargetHours');
    const overdue = await this.core.repo.overdueItems(new Date(this.core.now().getTime() - hours * 3_600_000), 200);
    for (const item of overdue) {
      await this.core.optional('workqueues', (w) =>
        w.raise({
          queueKey: 'reviews.moderation',
          kind: 'review_moderation_overdue',
          sourceModule: 'reviews',
          title: `${CONTENT_NOUN[item.content_type as ContentType] ?? 'Content'} waiting for moderation over ${hours} h`,
          summary: `Queue ${item.queue}; first reported ${item.first_reported_at.toISOString().slice(0, 16).replace('T', ' ')} UTC (${item.report_count} report${item.report_count === 1 ? '' : 's'})`,
          subject: { type: 'moderation_item', id: item.id, label: CONTENT_NOUN[item.content_type as ContentType] ?? item.content_type },
          dueAt: new Date(item.first_reported_at.getTime() + hours * 3_600_000).toISOString(),
          priority: 'high',
          dedupeKey: `review_moderation_overdue:${item.id}`,
          links: [{ label: 'Open moderation item', screen: 'admin/reviews', id: item.id }],
        }),
      );
    }
    if (overdue.length) this.core.ctx.log.info({ overdue: overdue.length }, `reviews: ${overdue.length} moderation item(s) open longer than ${hours} h`);
    return overdue.length;
  }

  /**
   * customers.account.closed: display names on the customer's reviews, feedback, questions and answers become
   * Former customer (the content stays published); their helpful votes stay counted under a random id each (no link
   * to the customer); their reports stay counted without the customer id; pending invitations are cancelled.
   */
  async anonymise(customerId: string): Promise<void> {
    if (!isUuid(customerId)) return;
    const now = this.core.now();
    await this.core.repo.transaction(async (tx) => {
      await tx.updateWhere('product_reviews', { customer_id: customerId }, { display_name: FORMER_CUSTOMER });
      await tx.updateWhere('seller_feedback', { customer_id: customerId }, { display_name: FORMER_CUSTOMER });
      await tx.updateWhere('questions', { customer_id: customerId }, { display_name: FORMER_CUSTOMER });
      await tx.updateWhere('answers', { author_kind: 'customer', author_id: customerId }, { display_name: FORMER_CUSTOMER });
      await tx.updateWhere('reports', { reporter_kind: 'customer', reporter_id: customerId }, { reporter_id: null });
      await tx.updateWhere('review_invites', { customer_id: customerId, state: 'pending' }, { state: 'cancelled', updated_at: now });
      await tx.anonymiseVotes(customerId);
    });
  }

  /**
   * Export hook: the customer's product reviews, seller feedback, questions, answers and the reports they made, with
   * status and moderation outcome; their review photos go into the ZIP.
   */
  async exportFor(customerId: string): Promise<common.CustomerDataSection[]> {
    if (!isUuid(customerId)) return [];
    const repo = this.core.repo;
    const [reviews, feedback, questions, answers, reports] = await Promise.all([
      repo.find('product_reviews', { customer_id: customerId }, { orderBy: [['created_at', 'asc']] }),
      repo.find('seller_feedback', { customer_id: customerId }, { orderBy: [['created_at', 'asc']] }),
      repo.find('questions', { customer_id: customerId }, { orderBy: [['created_at', 'asc']] }),
      repo.find('answers', { author_kind: 'customer', author_id: customerId }, { orderBy: [['created_at', 'asc']] }),
      repo.find('reports', { reporter_kind: 'customer', reporter_id: customerId }, { orderBy: [['created_at', 'asc']] }),
    ]);
    const products = await this.core.products([...reviews.map((r) => r.product_id), ...questions.map((q) => q.product_id)]);
    const names = await this.core.sellerNames(feedback.map((f) => f.seller_id));
    const decisions = await this.latestDecisions([...reviews.map((r) => r.id), ...feedback.map((f) => f.id), ...questions.map((q) => q.id), ...answers.map((a) => a.id)]);
    const outcome = (id: string) => decisions.get(id) ?? null;
    const records = [
      ...reviews.map((r) => ({ type: 'product_review', product: products.get(r.product_id)?.title ?? r.product_id, rating: r.rating, headline: r.headline, text: r.body, status: r.status, writtenAt: r.created_at.toISOString(), moderation: outcome(r.id) })),
      ...feedback.map((f) => ({ type: 'seller_feedback', seller: this.core.sellerName(names, f.seller_id), asDescribed: f.as_described, dispatchRating: f.dispatch_rating, communicationRating: f.communication_rating, comment: f.comment, status: f.status, writtenAt: f.created_at.toISOString(), moderation: outcome(f.id) })),
      ...questions.map((q) => ({ type: 'question', product: products.get(q.product_id)?.title ?? q.product_id, text: q.text, status: q.status, writtenAt: q.created_at.toISOString(), moderation: outcome(q.id) })),
      ...answers.map((a) => ({ type: 'answer', text: a.text, status: a.status, writtenAt: a.created_at.toISOString(), moderation: outcome(a.id) })),
      ...reports.map((r) => ({ type: 'report', about: r.target_type, reason: r.reason, note: r.note, status: r.status, outcome: r.outcome_text, reportedAt: r.created_at.toISOString() })),
    ];
    const attachmentIds = [...new Set(reviews.flatMap((r) => (r.media_ids as string[] | null) ?? []))];
    return [{ key: 'reviews', title: 'Reviews and questions', module: 'reviews', records, attachmentIds }];
  }

  /** The latest moderation outcome per content id ('removed: spam_or_links') */
  private async latestDecisions(contentIds: readonly string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const ids = [...new Set(contentIds)];
    if (!ids.length) return out;
    const items = await this.core.repo.find('moderation_items', { content_id: ids });
    if (!items.length) return out;
    const decisions = await this.core.repo.find('moderation_decisions', { moderation_item_id: items.map((i) => i.id) }, { orderBy: [['decided_at', 'asc']] });
    const contentOf = new Map(items.map((i) => [i.id, i.content_id]));
    for (const d of decisions) out.set(contentOf.get(d.moderation_item_id)!, `${d.decision}: ${d.reason_code}`);
    return out;
  }

}
