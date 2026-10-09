/**
 * Seller ad charges, kept apart from sales commission: accrued per campaign and market day from billable
 * clicks (charged one by one within the limits as they happen), displays (per 1,000) or the fixed daily fee,
 * capped at the daily and total limits; posted to finance as their own statement line
 * (finance.recordAdCharge + advertising.charge.posted); voided before posting or credited after, within the
 * caller's adjustment limit (advertising.charges.void).
 */
import { AppError } from '../../../kernel/errors/index.js';
import type { EventPayload } from '../../../kernel/events/index.js';
import { isUuid, newId } from '../../../kernel/lib/ids.js';
import type { PageRequest } from '../../../kernel/lib/pagination.js';
import type { AdCharge } from '../../../spec/advertising.js';
import type * as common from '../../../spec/common.js';
import { adChargeMachine } from '../domain/state-machines.js';
import type { CampaignRec, ChargeRec } from '../ports.js';
import { invalid, notFound, Part, SYSTEM, type By } from './core.js';

export const VOID_ACTION = 'advertising.charges.void';
export const CHARGE_TARGET = 'ad_charge';
const BASIS: Record<string, AdCharge['basis']> = { cpc: 'clicks', cpm: 'displays', fixed_daily: 'fixed_day' };
const PAID_BILLING = ['cpc', 'cpm', 'fixed_daily'];

export class BillingPart extends Part {
  /* ---------------------------------------------------------------- views */

  async views(rows: readonly ChargeRec[]): Promise<AdCharge[]> {
    const campaigns = new Map(
      (
        await this.repo.getMany(
          'campaigns',
          rows.map((r) => r.campaign_id),
        )
      ).map((c) => [c.id, c]),
    );
    return rows.map((r) => ({
      id: r.id,
      campaignId: r.campaign_id,
      campaignName: campaigns.get(r.campaign_id)?.name ?? 'Campaign',
      sellerId: r.seller_id,
      day: r.day,
      basis: r.basis as AdCharge['basis'],
      units: r.units,
      rate: this.core.money(r.rate, r.currency),
      amount: this.core.money(r.amount, r.currency),
      state: r.state as AdCharge['state'],
      postedAt: r.posted_at?.toISOString() ?? null,
      statementRef: r.statement_ref,
      reason: r.reason,
    }));
  }

  async list(f: { sellerId?: string; campaignId?: string; state?: string; from?: string; to?: string }, page: PageRequest): Promise<common.Page<AdCharge>> {
    const res = await this.repo.listCharges(f, page);
    return { ...res, items: await this.views(res.items) };
  }

  /* ---------------------------------------------------------------- accrual */

  /** Job advertising.accrue-charges: yesterday and today for every paid seller campaign that can still accrue */
  async accrueAll(): Promise<void> {
    const today = this.core.today();
    const yesterday = this.core.addDays(today, -1);
    const since = this.core.dayStart(yesterday);
    const rows = await this.repo.find('campaigns', { billing: PAID_BILLING, seller_id: { op: 'is not', value: null }, status: ['live', 'paused', 'finished', 'archived'], ends_at: { op: '>=', value: since } }, { limit: 5000 });
    for (const c of rows) {
      for (const day of [yesterday, today]) {
        try {
          await this.accrueDay(c.id, day);
        } catch (err) {
          this.ctx.log.warn({ err, campaignId: c.id, day }, 'advertising: charge not accrued');
        }
      }
    }
  }

  /** Delivery so far (finish, seller suspended) */
  async accrueCampaign(campaignId: string): Promise<void> {
    const today = this.core.today();
    for (const day of [this.core.addDays(today, -1), today]) await this.accrueDay(campaignId, day);
  }

  /** One campaign and day: recomputes the accrued charge, capped at the limits (idempotent) */
  async accrueDay(campaignId: string, day: string): Promise<ChargeRec | null> {
    const span = this.core.span(day, day);
    const pre = await this.repo.get('campaigns', campaignId);
    if (!pre?.seller_id || !PAID_BILLING.includes(pre.billing) || pre.rate === null) return null;
    if (pre.starts_at && pre.starts_at.getTime() >= span.to.getTime()) return null;
    const counted = pre.billing === 'cpc' ? await this.repo.clickBilling(campaignId, span) : null;
    const displays = pre.billing === 'cpc' ? 0 : await this.repo.displaysIn(campaignId, span);
    const res = await this.repo.transaction(async (tx) => {
      const c = await tx.get('campaigns', campaignId, { forUpdate: true });
      if (!c) return null;
      const existing = await tx.findOne('ad_charges', { campaign_id: campaignId, day });
      if (existing && existing.state !== 'accrued') return { charge: existing, exhausted: null as 'daily' | 'total' | null, c };
      const prior = existing?.amount ?? 0;
      let units = 0;
      let amount = 0;
      let exhausted: 'daily' | 'total' | null = null;
      if (c.billing === 'cpc') {
        // clicks were charged one by one within the limits; the charge mirrors them
        units = counted!.units;
        amount = counted!.amount;
      } else {
        units = c.billing === 'cpm' ? displays : displays > 0 ? 1 : 0;
        let target = c.billing === 'cpm' ? Math.floor((displays * c.rate!) / 1000) : units ? c.rate! : 0;
        if (c.daily_limit !== null && target >= c.daily_limit) {
          target = c.daily_limit;
          exhausted = 'daily';
        }
        let delta = target - prior;
        if (c.total_limit !== null && delta > 0 && c.spent + delta >= c.total_limit) {
          delta = Math.max(c.total_limit - c.spent, 0);
          exhausted = 'total';
        }
        amount = prior + delta;
        if (delta) await tx.addSpend(c.id, day, delta);
      }
      if (!amount && !existing) return { charge: null, exhausted, c };
      if (!amount && existing) {
        await tx.removeWhere('ad_charges', { id: existing.id, state: 'accrued' });
        return { charge: null, exhausted, c };
      }
      const values = { basis: BASIS[c.billing] ?? 'clicks', units, rate: c.rate!, amount, currency: c.currency };
      const charge = existing
        ? await tx.update('ad_charges', existing.id, values)
        : await tx.insert('ad_charges', { id: newId(), campaign_id: c.id, seller_id: c.seller_id!, day, ...values, state: adChargeMachine.initial, posted_at: null, statement_ref: null, reason: null });
      return { charge, exhausted: exhausted && prior < amount ? exhausted : null, c };
    });
    if (res?.exhausted) await this.limitReached(res.c, res.exhausted);
    return res?.charge ?? null;
  }

  /** advertising.budget.reached; the total limit finishes the campaign (delivery stops at the limit) */
  async limitReached(c: CampaignRec, limit: 'daily' | 'total') {
    this.core.publish('advertising.budget.reached', { campaignId: c.id, sellerId: c.seller_id, limit });
    this.parts.serving.invalidate();
    if (limit === 'total' && ['scheduled', 'live', 'paused'].includes(c.status)) {
      await this.parts.campaigns.finish(c.id, 'budget_reached', 'Total spending limit reached', { actor: SYSTEM }).catch((err) => {
        if (!(err instanceof AppError) || err.code !== 'ILLEGAL_TRANSITION') throw err;
      });
    }
  }

  /* ---------------------------------------------------------------- posting */

  /** Job advertising.post-charges: the previous days' accrued charges go to finance as an ad-charge line */
  async postAll(): Promise<void> {
    await this.accrueAll();
    const finance = this.ctx.tryUse('finance');
    if (!finance) return;
    const today = this.core.today();
    const due = await this.repo.find('ad_charges', { state: 'accrued', day: { op: '<', value: today } }, { orderBy: [['day', 'asc']], limit: 2000 });
    const campaigns = new Map(
      (
        await this.repo.getMany(
          'campaigns',
          due.map((d) => d.campaign_id),
        )
      ).map((c) => [c.id, c]),
    );
    for (const ch of due) {
      const c = campaigns.get(ch.campaign_id);
      try {
        const entry = await finance.recordAdCharge({
          sellerId: ch.seller_id,
          campaignId: ch.campaign_id,
          campaignRef: c?.ref ?? ch.campaign_id,
          period: { from: ch.day, to: ch.day },
          amount: this.core.money(ch.amount, ch.currency),
          description: `${c?.name ?? 'Sponsored campaign'} · ${ch.units} ${ch.basis === 'clicks' ? 'clicks' : ch.basis === 'displays' ? 'displays' : 'day'}`,
        });
        const posted = await this.repo.transaction(async (tx) => {
          const locked = await tx.get('ad_charges', ch.id, { forUpdate: true });
          if (!locked || locked.state !== 'accrued') return null;
          return tx.update('ad_charges', ch.id, { state: adChargeMachine.next('accrued', 'post'), posted_at: this.now(), statement_ref: entry?.statementRef ?? null });
        });
        if (posted) this.core.publish('advertising.charge.posted', { chargeId: ch.id, sellerId: ch.seller_id, campaignId: ch.campaign_id, day: ch.day, amount: this.core.money(ch.amount, ch.currency) });
      } catch (err) {
        if (err instanceof AppError && err.code === 'NOT_IMPLEMENTED') return;
        this.ctx.log.warn({ err, chargeId: ch.id }, 'advertising: charge not posted');
      }
    }
  }

  /* ---------------------------------------------------------------- void and credit */

  /** Void an accrued charge or credit a posted one; above the caller's adjustment limit it needs approval */
  async void(id: string, reason: string, by: By): Promise<AdCharge> {
    const text = reason?.trim();
    if (!text) throw invalid([{ path: 'reason', message: 'Give a reason (invalid traffic, cancelled delivery…)' }]);
    const row = isUuid(id) ? await this.repo.get('ad_charges', id) : undefined;
    if (!row) throw notFound('Charge');
    const event = row.state === 'posted' ? 'credit' : 'void';
    adChargeMachine.next(row.state as AdCharge['state'], event);
    const access = this.ctx.use('access');
    const principal = this.core.principalOf(by);
    const amount = this.core.money(row.amount, row.currency);
    const check = await access.check(principal, VOID_ACTION, { money: amount });
    if (check.decision === 'denied') throw new AppError('FORBIDDEN', check.reason || 'You cannot void ad charges');
    if (check.decision === 'approval_required') {
      const campaign = await this.repo.get('campaigns', row.campaign_id);
      const req = await access.requestApproval({
        action: VOID_ACTION,
        target: { type: CHARGE_TARGET, id: row.id, ref: campaign?.ref ?? null, label: `Ad charge ${row.day} · ${campaign?.name ?? 'campaign'}`, sellerId: row.seller_id, screen: 'admin/ads' },
        amount,
        summary: `${event === 'credit' ? 'Credit' : 'Void'} ad charge of ${amount.amount / 100} ${amount.currency} for ${row.day}`,
        details: { chargeId: row.id, campaignId: row.campaign_id, day: row.day, units: row.units },
        reason: text,
        requestedBy: principal,
      });
      throw new AppError('APPROVAL_REQUIRED', `${check.reason || 'Above your adjustment limit'}; sent for approval.`, { approvalRequestId: req.id, approval: { required: true, approvalRequestId: req.id, approvers: (check.eligibleApproverRoles ?? []).map((r) => r.name) } });
    }
    return (await this.views([await this.apply(row.id, text, by, null)]))[0]!;
  }

  private async apply(id: string, reason: string, by: By, approvalRequestId: string | null): Promise<ChargeRec> {
    const { before, after } = await this.repo.transaction(async (tx) => {
      const before = await tx.get('ad_charges', id, { forUpdate: true });
      if (!before) throw notFound('Charge');
      const event = before.state === 'posted' ? 'credit' : 'void';
      const state = adChargeMachine.next(before.state as AdCharge['state'], event);
      const after = await tx.update('ad_charges', id, { state, reason });
      // the campaign's budget gets the amount back (unused budget is never charged)
      await tx.addSpend(before.campaign_id, before.day, -before.amount);
      return { before, after };
    });
    this.core.publish('advertising.charge.credited', { chargeId: id, sellerId: after.seller_id, amount: this.core.money(after.amount, after.currency), reason }, by);
    await this.core.audit(
      {
        action: before.state === 'posted' ? 'advertising.charge.credit' : 'advertising.charge.void',
        actionLabel: `${before.state === 'posted' ? 'Credited' : 'Voided'} ad charge for ${before.day}`,
        category: 'financial',
        target: { type: CHARGE_TARGET, id, label: `Ad charge ${before.day}`, screen: 'admin/ads' },
        reason,
        before: { state: before.state, amount: before.amount },
        after: { state: after.state },
        approvalRequestId,
        visibleToSeller: true,
      },
      by,
    );
    return after;
  }

  /** access.approval.decided for advertising.charges.void */
  async onVoidDecided(e: EventPayload<'access.approval.decided'>) {
    if (e.outcome !== 'approved' || !isUuid(e.target.id)) return;
    const row = await this.repo.get('ad_charges', e.target.id);
    if (!row || (row.state !== 'accrued' && row.state !== 'posted')) return;
    let reason = e.reason ?? null;
    try {
      reason = (await this.ctx.use('access').getApproval(e.requestId))?.reason ?? reason;
    } catch {
      /* keep the decision note */
    }
    await this.apply(row.id, reason || 'Approved adjustment', { actor: e.decidedBy ?? SYSTEM }, e.requestId);
  }
}
