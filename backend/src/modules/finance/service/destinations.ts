/**
 * Payout destination verification: micro-deposits confirmed by the owner, then (for a change of account)
 * a recorded Finance review by someone other than the requester. Payouts keep going to the current
 * verified account until the new one is verified; the new one waits destinationChangePauseHours.
 */
import { AppError } from '../../../kernel/errors/index.js';
import type { EventPayload } from '../../../kernel/events/index.js';
import { isUuid } from '../../../kernel/lib/ids.js';
import type { PageRequest } from '../../../kernel/lib/pagination.js';
import type * as common from '../../../spec/common.js';
import type { DestinationCheck, DestinationReview, DestinationStatus } from '../../../spec/finance.js';
import { decodeActor, detId, encodeActor } from '../domain/rules.js';
import { destinationReviewMachine } from '../domain/state-machines.js';
import { toReview } from '../mappers.js';
import type { ReviewRec, Where } from '../ports.js';
import { notFound, Part, type By } from './core.js';

const DEPOSITS = 'Micro-deposits confirmed';
const REAUTH = 'Owner re-authenticated';
const CALLBACK = 'Callback to the registered phone';

export class DestinationsPart extends Part {
  async reviewViews(rows: ReviewRec[]): Promise<DestinationReview[]> {
    const names = await this.core.sellerInfo(rows.map((r) => r.seller_id));
    const dests = new Map((await this.repo.getMany('payout_destinations', rows.map((r) => r.destination_id))).map((d) => [d.id, d]));
    return rows.map((r) => toReview(r, names.get(r.seller_id)?.name ?? 'Seller', dests.get(r.destination_id)?.pause_until ?? null));
  }

  async reviewView(id: string): Promise<DestinationReview> {
    const row = await this.repo.get('destination_reviews', id);
    if (!row) throw notFound('Destination review');
    return (await this.reviewViews([row]))[0]!;
  }

  async list(f: { status?: string | null }, page: PageRequest): Promise<common.Page<DestinationReview>> {
    const where: Where<ReviewRec> = {};
    if (f.status) where.status = f.status;
    const res = await this.repo.page('destination_reviews', where, page, { column: 'requested_at', direction: 'desc' });
    return { ...res, items: await this.reviewViews(res.items) };
  }

  async forSeller(sellerId: string): Promise<{ destination: DestinationStatus; review?: DestinationReview | null }> {
    const d = await this.core.destinationOf(sellerId);
    const latestReview = d.review ?? (await this.repo.findOne('destination_reviews', { seller_id: sellerId }, { orderBy: [['requested_at', 'desc']] }));
    return { destination: d.status, review: latestReview ? await this.reviewView(latestReview.id) : null };
  }

  /** sellers.payout_account.changed: a destination to verify and its review; the current verified one keeps being paid */
  async onAccountChanged(e: EventPayload<'sellers.payout_account.changed'>) {
    if (!isUuid(e.sellerId)) return;
    const destinationId = detId(`destination:${e.changeId}`);
    if (await this.repo.get('payout_destinations', destinationId)) return;
    let sentAt: Date | null = null;
    try {
      sentAt = (await this.core.provider.sendTestDeposits(e.providerDestinationId)).sentAt;
    } catch (err) {
      this.ctx.log.warn({ err, sellerId: e.sellerId }, 'finance: test deposits not sent yet');
    }
    const checks: DestinationCheck[] = [
      { label: DEPOSITS, result: 'pending' },
      { label: REAUTH, result: 'passed' },
      { label: CALLBACK, result: e.isInitial ? 'passed' : 'pending' },
    ];
    await this.repo.transaction(async (tx) => {
      // a newer change replaces a change still under review
      for (const old of await tx.find('destination_reviews', { seller_id: e.sellerId, status: 'under_review' }, { forUpdate: true })) {
        await tx.update('destination_reviews', old.id, { status: this.core.step(destinationReviewMachine, old.status, 'reject'), decided_at: this.now(), decided_by: encodeActor(e.requestedBy), reason: 'Replaced by a newer payout account change' });
        await tx.updateWhere('payout_destinations', { id: old.destination_id, status: 'verification_pending' }, { status: 'rejected' });
      }
      if (!(await tx.insertIgnore('payout_destinations', { id: destinationId, seller_id: e.sellerId, sellers_account_id: e.changeId, label: e.label, provider_destination_id: e.providerDestinationId, status: 'verification_pending', verified_at: null, active: false, pause_until: null, deposits_sent_at: sentAt, deposit_attempts: 0 }))) return;
      await tx.insertIgnore('destination_reviews', { id: detId(`review:${e.changeId}`), seller_id: e.sellerId, destination_id: destinationId, from_label: e.isInitial ? null : (e.previousLabel ?? null), to_label: e.label, requested_by: encodeActor(e.requestedBy)!, requested_at: this.now(), status: destinationReviewMachine.initial, checks: checks as never, decided_by: null, decided_at: null, reason: null });
    });
  }

  async confirmDeposits(sellerId: string, amounts: common.Money[], by: By): Promise<{ destination: DestinationStatus; review?: DestinationReview | null }> {
    const pending = await this.repo.findOne('payout_destinations', { seller_id: sellerId, status: 'verification_pending' }, { orderBy: [['deposits_sent_at', 'desc']] });
    const review = pending ? await this.repo.findOne('destination_reviews', { destination_id: pending.id }) : undefined;
    if (!pending || !review || review.status !== 'under_review') throw new AppError('ILLEGAL_TRANSITION', 'There is no payout account waiting for test deposits', { from: 'none', event: 'confirmDeposits' });
    const checks = (Array.isArray(review.checks) ? review.checks : []) as unknown as DestinationCheck[];
    if (checks.find((c) => c.label === DEPOSITS)?.result === 'passed') throw new AppError('ILLEGAL_TRANSITION', 'The test deposits are already confirmed; the change is with Finance for review', { from: 'deposits_confirmed', event: 'confirmDeposits' });
    const max = await this.core.num('depositConfirmAttempts', 3);
    if (pending.deposit_attempts >= max) {
      const sent = await this.core.provider.sendTestDeposits(pending.provider_destination_id ?? pending.id);
      await this.repo.update('payout_destinations', pending.id, { deposit_attempts: 0, deposits_sent_at: sent.sentAt });
      throw this.ctx.error('DEPOSIT_ATTEMPTS_EXCEEDED', 'No tries left; new test deposits are on their way', { attemptsLeft: 0 });
    }
    const ok = amounts.length === 2 && amounts.every((a) => Number.isSafeInteger(a.amount) && a.amount > 0) && (await this.core.provider.checkTestDeposits(pending.provider_destination_id ?? pending.id, amounts.map((a) => a.amount)));
    if (!ok) {
      const attempts = pending.deposit_attempts + 1;
      await this.repo.update('payout_destinations', pending.id, { deposit_attempts: attempts });
      await this.core.audit({ action: 'finance.destination.deposits_incorrect', actionLabel: 'Entered incorrect test-deposit amounts', category: 'security', target: { type: 'seller', id: sellerId, sellerId, screen: 'seller/finance' }, after: { attemptsLeft: max - attempts }, visibleToSeller: true }, by);
      throw this.ctx.error('DEPOSIT_AMOUNTS_INCORRECT', 'The amounts do not match the test deposits', { attemptsLeft: Math.max(0, max - attempts) });
    }
    const passed = checks.map((c) => (c.label === DEPOSITS ? { ...c, result: 'passed' as const } : c));
    const hasVerified = Boolean(await this.repo.findOne('payout_destinations', { seller_id: sellerId, status: 'verified', active: true }));
    if (!hasVerified && !review.from_label) {
      // first payout account: verified once the owner confirms the deposits
      await this.verify(review.id, passed.map((c) => ({ ...c, result: 'passed' as const })), by, null);
    } else await this.repo.update('destination_reviews', review.id, { checks: passed as never });
    await this.core.audit({ action: 'finance.destination.confirm_deposits', actionLabel: 'Confirmed the payout account test deposits', category: 'financial', target: { type: 'seller', id: sellerId, sellerId, label: pending.label, screen: 'seller/finance' }, visibleToSeller: true }, by);
    return this.forSeller(sellerId);
  }

  /** under_review → verified: the new destination becomes the one paid (after the pause for a change) */
  async verify(reviewId: string, checks: DestinationCheck[], by: By, reason: string | null) {
    const pauseHours = await this.core.num('destinationChangePauseHours', 72);
    const done = await this.repo.transaction(async (tx) => {
      const r = await tx.get('destination_reviews', reviewId, { forUpdate: true });
      if (!r || r.status !== 'under_review') return null;
      const isChange = Boolean(await tx.findOne('payout_destinations', { seller_id: r.seller_id, status: 'verified', active: true }));
      await tx.update('destination_reviews', reviewId, { status: this.core.step(destinationReviewMachine, r.status, 'verify'), checks: checks as never, decided_by: encodeActor(by.actor), decided_at: this.now(), reason });
      for (const old of await tx.find('payout_destinations', { seller_id: r.seller_id, active: true })) await tx.update('payout_destinations', old.id, { active: false, status: old.status === 'verified' ? 'replaced' : old.status });
      await tx.update('payout_destinations', r.destination_id, { status: 'verified', verified_at: this.now(), active: true, pause_until: isChange ? new Date(this.now().getTime() + pauseHours * 3_600_000) : null });
      return r;
    });
    if (done) this.core.publish('finance.destination.verified', { sellerId: done.seller_id, reviewId }, by);
    return done;
  }

  async approve(id: string, reason: string, by: By): Promise<DestinationReview> {
    const r = isUuid(id) ? await this.repo.get('destination_reviews', id) : undefined;
    if (!r) throw notFound('Destination review');
    if (r.status !== 'under_review') this.core.step(destinationReviewMachine, r.status, 'verify');
    const requester = decodeActor(r.requested_by);
    if (by.actor.id && requester?.id && requester.id === by.actor.id) throw this.ctx.error('SAME_APPROVER', 'The reviewer cannot be the person who requested the change');
    // a recorded review by a Finance reviewer: access decides who may (granting access is not authority)
    await this.core.authority(by, 'finance.destinations.approve');
    const checks = (Array.isArray(r.checks) ? r.checks : []) as unknown as DestinationCheck[];
    const pendingChecks = checks.filter((c) => c.label !== CALLBACK && c.result !== 'passed').map((c) => c.label);
    if (pendingChecks.length) throw this.ctx.error('CHECKS_INCOMPLETE', 'Destination verification checks are not all passed', { pending: pendingChecks });
    await this.verify(id, checks.map((c) => ({ ...c, result: 'passed' as const })), by, reason || null);
    await this.core.audit({ action: 'finance.destination.approve', actionLabel: 'Verified a new payout destination', category: 'financial', target: { type: 'seller', id: r.seller_id, sellerId: r.seller_id, label: r.to_label, screen: 'admin/payouts' }, before: { label: r.from_label }, after: { label: r.to_label }, reason, visibleToSeller: true }, by);
    return this.reviewView(id);
  }

  async reject(id: string, reason: string, by: By): Promise<DestinationReview> {
    const r = isUuid(id) ? await this.repo.get('destination_reviews', id) : undefined;
    if (!r) throw notFound('Destination review');
    const status = this.core.step(destinationReviewMachine, r.status, 'reject');
    await this.repo.transaction(async (tx) => {
      await tx.update('destination_reviews', id, { status, decided_by: encodeActor(by.actor), decided_at: this.now(), reason });
      await tx.update('payout_destinations', r.destination_id, { status: 'rejected', active: false });
    });
    this.core.publish('finance.destination.rejected', { sellerId: r.seller_id, reviewId: id, reason }, by);
    await this.core.audit({ action: 'finance.destination.reject', actionLabel: 'Rejected a payout destination change', category: 'financial', target: { type: 'seller', id: r.seller_id, sellerId: r.seller_id, label: r.to_label, screen: 'admin/payouts' }, reason, visibleToSeller: true }, by);
    return this.reviewView(id);
  }
}
