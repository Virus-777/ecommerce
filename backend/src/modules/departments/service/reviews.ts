/**
 * Reviews of companies and games: 1–5 stars and an optional text, one per customer and target (posting again changes
 * it), signed with the customer's first name and last initial. Ratings count visible reviews; staff hide or show
 * reviews in Admin › Departments › Reviews (a hidden review stays hidden when its writer changes it).
 */
import { isAppError } from '../../../kernel/errors/index.js';
import { newId } from '../../../kernel/lib/ids.js';
import type { Page, PageRequest } from '../../../kernel/lib/pagination.js';
import type { DeptReview, RatingSummary, ReviewAdmin, ReviewInput, ReviewModeration } from '../../../spec/departments.js';
import { ratingSummary } from '../domain/play.js';
import type { ReviewRow } from '../ports.js';
import { invalid, notFound, optionalText, unique, type By } from './base.js';
import { DepartmentsBlogs } from './blogs.js';

export type ReviewTargetType = ReviewRow['target_type'];

/** A target as reviews show it */
interface TargetInfo {
  id: string;
  slug: string;
  name: string;
}

export class DepartmentsReviews extends DepartmentsBlogs {
  protected reviewOut(r: ReviewRow, customerId: string | null): DeptReview {
    return { id: r.id, name: r.name, stars: r.stars, text: r.text, date: r.updated_at.toISOString(), mine: Boolean(customerId && r.customer_id === customerId), hidden: r.hidden };
  }

  /** Rating (average, count) per target, from the visible reviews */
  protected async ratingsOf(target: ReviewTargetType, ids: string[]): Promise<Map<string, RatingSummary>> {
    const counts = await this.repo.ratingCounts(target, unique(ids));
    return new Map(unique(ids).map((id) => [id, ratingSummary(counts.get(id))]));
  }

  /** The signed-in customer's review of a target, hidden or not */
  protected async myReviewOf(target: ReviewTargetType, targetId: string, customerId: string | null): Promise<DeptReview | null> {
    if (!customerId) return null;
    const r = await this.repo.reviewOf(target, targetId, customerId);
    return r ? this.reviewOut(r, customerId) : null;
  }

  protected async pageReviewsOf(target: ReviewTargetType, targetId: string, customerId: string | null, stars: number | undefined, page: PageRequest): Promise<Page<DeptReview>> {
    if (stars !== undefined && (!Number.isInteger(stars) || stars < 1 || stars > 5)) throw invalid('stars', 'Use 1 to 5 stars');
    const res = await this.repo.pageVisibleReviews(target, targetId, stars, page);
    return { ...res, items: res.items.map((r) => this.reviewOut(r, customerId)) };
  }

  /** Writes or changes the customer's review of a target (customers.canWriteReviews may refuse it) */
  protected async writeReview(target: ReviewTargetType, targetId: string, customerId: string, accountId: string | null, input: ReviewInput): Promise<DeptReview> {
    if (!Number.isInteger(input.stars) || input.stars < 1 || input.stars > 5) throw invalid('stars', 'Choose 1 to 5 stars');
    const text = optionalText(input.text, 'text', 1000);
    const customers = this.ctx.tryUse('customers');
    if (customers && typeof customers.canWriteReviews === 'function') {
      try {
        const may = await customers.canWriteReviews(customerId);
        if (!may.allowed) throw this.ctx.error('REVIEWS_NOT_ALLOWED', 'This account cannot write reviews right now', { reason: may.reason ?? null });
      } catch (err) {
        // a customer the customers module does not know (no record yet) may review; only a refusal stops it
        if (isAppError(err) && err.code === 'REVIEWS_NOT_ALLOWED') throw err;
        this.ctx.log.debug({ err }, 'departments: canWriteReviews unavailable');
      }
    }
    const now = this.now();
    const row = await this.repo.saveReview({ id: newId(), target_type: target, target_id: targetId, customer_id: customerId, name: await this.customerName(customerId, accountId), stars: input.stars, text, hidden: false, hidden_reason: null, created_at: now, updated_at: now });
    return this.reviewOut(row, customerId);
  }

  /* ---------------------------------------------------------------- admin */

  private async targetsOf(rows: ReviewRow[]): Promise<Map<string, TargetInfo>> {
    const ids = (t: ReviewTargetType) => unique(rows.filter((r) => r.target_type === t).map((r) => r.target_id));
    const [companies, games] = await Promise.all([this.repo.companiesByIds(ids('company')), Promise.all(ids('game').map((id) => this.repo.getGame(id)))]);
    return new Map<string, TargetInfo>([...companies.map((c) => [c.id, { id: c.id, slug: c.slug, name: c.name }] as const), ...games.filter((g) => Boolean(g)).map((g) => [g!.id, { id: g!.id, slug: g!.slug, name: g!.title }] as const)]);
  }

  private async reviewsAdmin(rows: ReviewRow[]): Promise<ReviewAdmin[]> {
    const targets = await this.targetsOf(rows);
    return rows.map((r) => {
      const t = targets.get(r.target_id);
      return { id: r.id, target: { type: r.target_type, id: r.target_id, slug: t?.slug ?? 'deleted', name: t?.name ?? 'Deleted' }, name: r.name, customerId: r.customer_id, stars: r.stars, text: r.text, hidden: r.hidden, hiddenReason: r.hidden_reason, date: r.updated_at.toISOString(), createdAt: r.created_at.toISOString() };
    });
  }

  async listDepartmentReviews(q: { target?: ReviewTargetType; targetId?: string; hidden?: boolean; stars?: number }, page: PageRequest): Promise<Page<ReviewAdmin>> {
    const res = await this.repo.pageAdminReviews(q, page);
    return { ...res, items: await this.reviewsAdmin(res.items) };
  }

  async moderateDepartmentReview(id: string, input: ReviewModeration, by: By): Promise<ReviewAdmin> {
    const before = await this.repo.getReview(id);
    if (!before) throw notFound('Review');
    const reason = input.hidden ? optionalText(input.reason, 'reason', 300) : null;
    const after = (await this.repo.updateReview(id, { hidden: input.hidden, hidden_reason: reason }))!;
    const [out] = await this.reviewsAdmin([after]);
    if (before.hidden !== after.hidden || before.hidden_reason !== after.hidden_reason) {
      const kind = before.target_type === 'company' ? 'company' : 'game';
      await this.audit(
        { action: input.hidden ? 'departments.reviews.hide' : 'departments.reviews.show', actionLabel: input.hidden ? `Hid a ${kind} review` : `Showed a ${kind} review again`, target: { type: `${kind}_review`, id, label: `${out!.target.name} · ${before.stars}★ · ${before.name}` }, before: { hidden: before.hidden, reason: before.hidden_reason }, after: { hidden: after.hidden, reason: after.hidden_reason } },
        by,
      );
    }
    return out!;
  }
}
