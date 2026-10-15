/**
 * Seller feedback per seller package (order seller group): as described, dispatch, communication and a
 * comment. Shown on the seller profile only; summarised over sellerRatingPeriodMonths.
 */
import { AppError } from '../../../kernel/errors/index.js';
import { isUuid, newId } from '../../../kernel/lib/ids.js';
import { pageOf, type PageRequest } from '../../../kernel/lib/pagination.js';
import type * as common from '../../../spec/common.js';
import type * as orders from '../../../spec/orders.js';
import type { FeedbackInput, FeedbackUpdateInput, MyFeedback, PendingSellerFeedback, SellerFeedback, SellerFeedbackRow, SellerFeedbackSummary } from '../../../spec/reviews.js';
import { addDays, feedbackLabel, isOfficial, isSellerId, OFFICIAL_STORE_ID, overallScore, pct, reviewChecks, round1, sellerKey, sentimentOf } from '../domain/rules.js';
import { sellerFeedbackMachine } from '../domain/state-machines.js';
import type { FeedbackRec, SellerSummaryRec } from '../ports.js';
import type { ReviewsRepository } from '../repository.js';
import { type Core, type CustomerWho, Effects, invalid, notFound, type Package } from './core.js';
import type { ModerationPart } from './moderation.js';
import type { Views } from './views.js';

const MAX_COMMENT = 1000;
/** Fewer dispatched packages than this in 90 days: no on-time figure */
const MIN_DISPATCHED = 5;

export interface PackageFeedbackState {
  eligible: boolean;
  opensAt: Date | null;
  closesAt: Date | null;
  feedback: FeedbackRec | null;
}

export class FeedbackPart {
  constructor(
    private readonly core: Core,
    private readonly views: Views,
    private readonly moderation: ModerationPart,
  ) {}

  /* ================================================================ eligibility */

  /** Feedback state of the customer's packages, with one lookup of their feedback */
  async states(customerId: string, packages: readonly Package[]): Promise<Map<string, PackageFeedbackState>> {
    const window = await this.core.num('sellerFeedbackWindowDays');
    const rows = packages.length ? await this.core.repo.find('seller_feedback', { customer_id: customerId, order_id: [...new Set(packages.map((p) => p.orderId))], status: { op: '<>', value: 'deleted' } }) : [];
    const now = this.core.now();
    const out = new Map<string, PackageFeedbackState>();
    for (const p of packages) {
      const feedback = rows.find((f) => f.order_id === p.orderId && f.seller_id === p.sellerId) ?? null;
      const opensAt = this.core.packageOpensAt(p);
      const closesAt = opensAt ? addDays(opensAt, window) : null;
      out.set(p.groupId, { eligible: !feedback && Boolean(opensAt && opensAt <= now && closesAt && now <= closesAt), opensAt, closesAt, feedback });
    }
    return out;
  }

  async packageState(customerId: string, pkg: Package): Promise<PackageFeedbackState> {
    return (await this.states(customerId, [pkg])).get(pkg.groupId)!;
  }

  async pendingFor(customerId: string, list: readonly orders.OrderDetail[]): Promise<PendingSellerFeedback[]> {
    const packages = list.flatMap((o) => this.core.packagesOf(o)).filter((p) => p.status !== 'cancelled');
    const states = await this.states(customerId, packages);
    const now = this.core.now();
    const out: PendingSellerFeedback[] = [];
    for (const p of packages) {
      const s = states.get(p.groupId)!;
      if (s.feedback) continue;
      if (s.closesAt && now > s.closesAt) continue;
      const open = Boolean(s.opensAt && s.opensAt <= now);
      out.push({
        orderId: p.orderId,
        orderRef: p.orderRef,
        ownerType: p.ownerType,
        sellerId: p.ownerType === 'official' ? OFFICIAL_STORE_ID : (p.sellerId ?? OFFICIAL_STORE_ID),
        sellerName: p.sellerName,
        packageLabel: p.packageLabel,
        deliveredAt: p.deliveredAt?.toISOString() ?? null,
        eligible: open,
        availableNote: open ? null : s.opensAt ? `Available after delivery (from ${s.opensAt.toISOString().slice(0, 10)})` : 'Available after delivery',
      });
    }
    return out;
  }

  /* ================================================================ write */

  private validate(d: { dispatchRating: number; communicationRating?: number | null; comment?: string | null }, submit: boolean) {
    const issues: { path: string; message: string }[] = [];
    const star = (v: number) => Number.isInteger(v) && v >= 1 && v <= 5;
    if (submit && !star(d.dispatchRating)) issues.push({ path: 'dispatchRating', message: 'Rate dispatch from 1 to 5' });
    if (submit && d.communicationRating != null && !star(d.communicationRating)) issues.push({ path: 'communicationRating', message: 'Rate communication from 1 to 5, or leave it empty' });
    if (d.comment && d.comment.length > MAX_COMMENT) issues.push({ path: 'comment', message: `The comment is too long (${MAX_COMMENT.toLocaleString('en-US')} characters at most)` });
    if (issues.length) throw invalid(issues);
  }

  private clampStar = (v: number) => Math.min(5, Math.max(1, Math.round(Number.isFinite(v) ? v : 1)));

  async create(who: CustomerWho, input: FeedbackInput): Promise<MyFeedback> {
    if (!who.customerId) throw notFound('Order');
    const customerId = who.customerId;
    const order = isUuid(input.orderId) ? (await this.core.orders([input.orderId])).get(input.orderId) : undefined;
    if (!order || order.contact.customerId !== customerId) throw notFound('Order');
    const pkg = this.core.packageFor(order, input.sellerId);
    if (!pkg) throw notFound('Package');
    const state = await this.packageState(customerId, pkg);
    if (state.feedback) throw this.core.ctx.error('ALREADY_REVIEWED', 'You already left feedback for this package. Edit it instead.', { id: state.feedback.id });
    this.assertOpen(pkg, state);
    const draft = Boolean(input.draft);
    this.validate(input, !draft);
    const comment = input.comment?.trim() || null;
    const failures = draft ? [] : reviewChecks(comment);
    const status = draft ? 'draft' : sellerFeedbackMachine.next(sellerFeedbackMachine.next('draft', 'submit'), failures.length ? 'hold' : 'publish');
    const threshold = await this.core.num('positiveThreshold');
    const overall = overallScore({ asDescribed: input.asDescribed, dispatchRating: this.clampStar(input.dispatchRating), communicationRating: input.communicationRating == null ? null : this.clampStar(input.communicationRating) });
    const displayName = await this.core.shortNameOf(customerId);
    const fx = await this.core.prepare(new Effects());
    const now = this.core.now();
    const sellerId = sellerKey(pkg.sellerId);
    const id = await this.core.repo.transaction(async (tx) => {
      const again = await tx.findOne('seller_feedback', { order_id: order.id, seller_id: sellerId, customer_id: customerId }, { forUpdate: true });
      if (again && again.status !== 'deleted') throw this.core.ctx.error('ALREADY_REVIEWED', 'You already left feedback for this package. Edit it instead.', { id: again.id });
      const row: FeedbackRec = {
        id: again?.id ?? newId(),
        seller_id: sellerId,
        order_id: order.id,
        customer_id: customerId,
        display_name: displayName,
        as_described: input.asDescribed,
        dispatch_rating: input.dispatchRating,
        communication_rating: input.communicationRating ?? null,
        overall,
        sentiment: sentimentOf(overall, threshold),
        comment,
        status,
        visible: status === 'published',
        created_at: now,
        edited_at: null,
      };
      if (again) await tx.update('seller_feedback', again.id, row);
      else await tx.insert('seller_feedback', row);
      if (status === 'held') await this.moderation.hold(tx, { type: 'seller_feedback', id: row.id }, failures);
      if (status === 'published') {
        await this.core.touchSeller(tx, fx, sellerId);
        fx.emit('reviews.feedback.published', { feedbackId: row.id, sellerId, orderId: order.id, sentiment: row.sentiment });
      }
      return row.id;
    });
    await this.core.flush(fx, who);
    return this.mine(customerId, id);
  }

  private assertOpen(pkg: Package, state: PackageFeedbackState) {
    if (pkg.status === 'cancelled') throw this.core.ctx.error('REVIEW_NOT_ELIGIBLE', 'This package was cancelled, so there is no seller feedback to leave.');
    if (!state.opensAt || state.opensAt > this.core.now()) {
      throw this.core.ctx.error('FEEDBACK_NOT_YET_AVAILABLE', 'Seller feedback opens once the package is delivered.', { availableFrom: state.opensAt?.toISOString() ?? null });
    }
    if (state.closesAt && this.core.now() > state.closesAt) throw this.core.ctx.error('REVIEW_NOT_ELIGIBLE', 'The time to leave feedback for this package has ended.');
  }

  private async own(customerId: string | null, id: string, o: { forUpdate?: boolean; repo?: ReviewsRepository } = {}): Promise<FeedbackRec> {
    const row = customerId && isUuid(id) ? await (o.repo ?? this.core.repo).get('seller_feedback', id, o) : undefined;
    if (!row || row.customer_id !== customerId || row.status === 'deleted') throw notFound('Feedback');
    return row;
  }

  async mine(customerId: string, id: string): Promise<MyFeedback> {
    return (await this.views.myFeedback([await this.own(customerId, id)]))[0]!;
  }

  async update(who: CustomerWho, id: string, input: FeedbackUpdateInput): Promise<MyFeedback> {
    const customerId = who.customerId;
    const row = await this.own(customerId, id);
    const from = row.status as MyFeedback['status'];
    const submitting = from === 'draft' ? input.draft === false : true;
    const event = from === 'draft' ? (submitting ? 'submit' : null) : 'edit';
    if (event) sellerFeedbackMachine.next(from, event);
    const merged = {
      asDescribed: input.asDescribed ?? row.as_described,
      dispatchRating: input.dispatchRating ?? row.dispatch_rating,
      communicationRating: input.communicationRating === undefined ? row.communication_rating : input.communicationRating,
      comment: input.comment === undefined ? row.comment : input.comment?.trim() || null,
    };
    this.validate(merged, submitting);
    if (from === 'draft' && submitting) {
      const order = (await this.core.orders([row.order_id])).get(row.order_id);
      const pkg = this.core.packageFor(order, row.seller_id);
      if (!pkg) throw notFound('Package');
      this.assertOpen(pkg, { ...(await this.packageState(customerId!, pkg)), feedback: null });
    }
    const failures = submitting ? reviewChecks(merged.comment) : [];
    let status: string = from;
    if (event) status = sellerFeedbackMachine.next(sellerFeedbackMachine.next(from, event), failures.length ? 'hold' : 'publish');
    const threshold = await this.core.num('positiveThreshold');
    const overall = overallScore({ asDescribed: merged.asDescribed, dispatchRating: this.clampStar(merged.dispatchRating), communicationRating: merged.communicationRating == null ? null : this.clampStar(merged.communicationRating) });
    const fx = await this.core.prepare(new Effects());
    const now = this.core.now();
    await this.core.repo.transaction(async (tx) => {
      const locked = await this.own(customerId, id, { forUpdate: true, repo: tx });
      if (locked.status !== from) throw new AppError('CONFLICT', 'Your feedback changed in the meantime. Reload it and try again.');
      const updated = await tx.update('seller_feedback', id, {
        as_described: merged.asDescribed,
        dispatch_rating: merged.dispatchRating,
        communication_rating: merged.communicationRating,
        comment: merged.comment,
        overall,
        sentiment: sentimentOf(overall, threshold),
        status,
        visible: status === 'published',
        ...(from === 'draft' && status !== 'draft' ? { created_at: now } : {}),
        ...(from !== 'draft' ? { edited_at: now } : {}),
      });
      if (status === 'held') await this.moderation.hold(tx, { type: 'seller_feedback', id }, failures);
      if (from !== 'draft' || status !== 'draft') await this.core.touchSeller(tx, fx, locked.seller_id);
      if (status === 'published') fx.emit('reviews.feedback.published', { feedbackId: id, sellerId: locked.seller_id, orderId: locked.order_id, sentiment: updated.sentiment });
    });
    await this.core.flush(fx, who);
    return this.mine(customerId!, id);
  }

  async remove(who: CustomerWho, id: string): Promise<void> {
    const customerId = who.customerId;
    const row = await this.own(customerId, id);
    sellerFeedbackMachine.next(row.status as MyFeedback['status'], 'delete');
    const fx = await this.core.prepare(new Effects());
    await this.core.repo.transaction(async (tx) => {
      const locked = await this.own(customerId, id, { forUpdate: true, repo: tx });
      const status = sellerFeedbackMachine.next(locked.status as MyFeedback['status'], 'delete');
      await tx.update('seller_feedback', id, { status, visible: false });
      await this.core.touchSeller(tx, fx, locked.seller_id);
      if (locked.status === 'published') fx.emit('reviews.feedback.removed', { feedbackId: id, sellerId: locked.seller_id });
      await this.moderation.closeForDeleted(tx, 'seller_feedback', id);
    });
    await this.core.flush(fx, who);
  }

  async listMine(customerId: string | null, page: PageRequest): Promise<common.Page<MyFeedback>> {
    if (!customerId) return pageOf([], page);
    const rows = await this.core.repo.listFeedback({ customerId, statuses: ['draft', 'pending', 'published', 'held', 'removed'] }, page);
    return { ...rows, items: await this.views.myFeedback(rows.items) };
  }

  /* ================================================================ lists */

  async listPublic(sellerId: string, filter: { sentiment?: string }, page: PageRequest): Promise<common.Page<SellerFeedback>> {
    if (!isSellerId(sellerId)) return pageOf([], page);
    const rows = await this.core.repo.listFeedback({ sellerId: sellerKey(sellerId), publicOnly: true, ...(filter.sentiment ? { sentiment: filter.sentiment.toLowerCase() } : {}) }, page);
    return { ...rows, items: await this.views.feedback(rows.items) };
  }

  async listForSeller(sellerId: string, filter: { needsResponse?: boolean; sentiment?: string }, page: PageRequest): Promise<common.Page<SellerFeedbackRow>> {
    const rows = await this.core.repo.listFeedback(
      { sellerId, publicOnly: true, ...(filter.sentiment ? { sentiment: filter.sentiment } : {}), ...(filter.needsResponse !== undefined ? { needsResponse: filter.needsResponse } : {}) },
      page,
    );
    const [list, closed] = await Promise.all([this.views.feedback(rows.items, { internal: true }), this.sellerClosed(sellerId)]);
    const reported = new Set((await this.core.repo.find('reports', { target_type: 'seller_feedback', target_id: rows.items.map((r) => r.id), reporter_kind: 'seller', reporter_id: sellerId, status: 'open' })).map((r) => r.target_id));
    return {
      ...rows,
      items: list.map((feedback) => ({ feedback, canRespond: !feedback.response && !closed, canReport: !reported.has(feedback.id) })),
    };
  }

  async sellerClosed(sellerId: string): Promise<boolean> {
    if (isOfficial(sellerId)) return false;
    const s = await this.core.soft('sellers.getSeller', () => this.core.ctx.use('sellers').getSeller(sellerId));
    return s?.status === 'closed';
  }

  /* ================================================================ summaries */

  async summaries(sellerIds: readonly string[], o: { dispatch?: boolean } = {}): Promise<Map<string, SellerFeedbackSummary>> {
    const keys = [...new Set(sellerIds.filter(isSellerId).map(sellerKey))];
    const out = new Map<string, SellerFeedbackSummary>();
    if (!keys.length) return out;
    const [months, targetPct] = await Promise.all([this.core.num('sellerRatingPeriodMonths'), this.core.num('sellerFeedbackTargetPct')]);
    const rows = await this.core.repo.sellerSummaries(keys);
    const dispatch = o.dispatch === false ? new Map<string, number | null>() : await this.onTime(keys);
    for (const id of keys) {
      const row = rows.find((r) => r.seller_id === id);
      // average overall rating from the summary row (overall_sum / count)
      out.set(id, this.summaryOut(id, row, row && row.count ? row.overall_sum / row.count : undefined, months, dispatch.get(id) ?? null, targetPct));
    }
    return out;
  }

  /** An empty summary (no feedback yet), for ids that are not sellers */
  async emptySummary(sellerId: string): Promise<SellerFeedbackSummary> {
    const [months, targetPct] = await Promise.all([this.core.num('sellerRatingPeriodMonths'), this.core.num('sellerFeedbackTargetPct')]);
    return this.summaryOut(sellerId, undefined, undefined, months, null, targetPct);
  }

  async summary(sellerId: string): Promise<SellerFeedbackSummary> {
    const key = isSellerId(sellerId) ? sellerKey(sellerId) : OFFICIAL_STORE_ID;
    return (await this.summaries([key])).get(key)!;
  }

  summaryOut(sellerId: string, r: SellerSummaryRec | undefined, average: number | undefined, months: number, onTime: number | null, targetPct: number): SellerFeedbackSummary {
    const count = r?.count ?? 0;
    const positivePct = r ? pct(r.positive, count) : null;
    return {
      sellerId: isOfficial(sellerId) ? OFFICIAL_STORE_ID : sellerId,
      official: isOfficial(sellerId),
      periodMonths: months,
      count,
      positivePct,
      neutralPct: r ? pct(r.neutral, count) : null,
      negativePct: r ? pct(r.negative, count) : null,
      asDescribedPct: r ? pct(r.as_described_yes, count) : null,
      avgDispatch: r && count ? round1(r.dispatch_sum / count) : null,
      avgCommunication: r && r.communication_count ? round1(r.communication_sum / r.communication_count) : null,
      label: feedbackLabel(positivePct, count),
      average: count && average != null ? round1(average) : null,
      onTimeDispatchPct: onTime,
      target: { positivePct: targetPct, label: `Target: at least ${targetPct}% positive`, meets: positivePct == null ? null : positivePct >= targetPct },
    };
  }

  /** On-time dispatch over the last 90 days (shipping, optional); null with too few packages */
  private async onTime(sellerIds: readonly string[]): Promise<Map<string, number | null>> {
    const out = new Map<string, number | null>();
    if (!this.core.ctx.tryUse('shipping')) return out;
    const now = this.core.now();
    const range = { from: addDays(now, -90).toISOString().slice(0, 10), to: now.toISOString().slice(0, 10) };
    await Promise.all(
      sellerIds.map(async (id) => {
        const m = await this.core.optional('shipping', (s) => s.dispatchMetrics(isOfficial(id) ? null : id, range));
        out.set(id, m && m.dispatched >= MIN_DISPATCHED ? m.onTimePct : null);
      }),
    );
    return out;
  }
}
