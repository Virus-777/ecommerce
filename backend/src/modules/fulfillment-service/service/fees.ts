/**
 * Fee schedules (versioned, effective dates, seller notice, Business Owner approval) and fee charges: monthly
 * storage and long-term storage from the daily snapshots, posting of accrued charges to the seller ledger
 * through finance (fee.charged), the seller's own fee list, and reversals within the caller's limit.
 *
 * Fees post as service_fee (finance.recordServiceFee); reversals of posted fees are credits against the fee's
 * ledger entry (finance.creditSellerCharge). Reimbursements are seller credits without an original charge
 * (finance.creditSeller, any size; above finance's creditSecondReviewerThreshold they wait for Finance approval).
 * The ledger entry is kept on the charge as ledger_entry_id.
 */
import { AppError } from '../../../kernel/errors/index.js';
import type { EventPayload } from '../../../kernel/events/index.js';
import { isUuid, newId } from '../../../kernel/lib/ids.js';
import type { PageRequest } from '../../../kernel/lib/pagination.js';
import type { FeeCharge, FeeRate, FeeSchedule } from '../../../spec/fulfillment-service.js';
import { serviceFeeChargeMachine } from '../domain/state-machines.js';
import { addDays, CHARGE_LABEL, daysInMonth, FEE_TYPES, previousMonth, round4, SYSTEM, validateRates } from '../domain/rules.js';
import type { ChargeRec } from '../ports.js';
import { invalid, notFound, Part, type By } from './core.js';

export const FEES_ACTION = 'fulfillment-service.fees.change';
export const REVERSE_ACTION = 'fulfillment-service.charges.reverse';
export const SCHEDULE_TARGET = 'fulfillment_fee_schedule';
export const CHARGE_TARGET = 'fulfillment_fee_charge';

const fmt = (amount: number, currency: string) => new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount / 100);

export class FeesPart extends Part {
  /* ---------------------------------------------------------------- schedules */

  async listSchedules(): Promise<FeeSchedule[]> {
    await this.core.syncSchedules();
    const rows = await this.repo.find('fee_schedules', {}, { orderBy: [['effective_at', 'desc']], limit: 200 });
    return rows.map((r) => this.parts.views.schedule(r));
  }

  async sellerSchedule(): Promise<{ current: FeeSchedule; upcoming: FeeSchedule | null }> {
    await this.core.syncSchedules();
    const current = await this.core.currentSchedule();
    const upcoming = await this.repo.findOne('fee_schedules', { state: 'scheduled', effective_at: { op: '>', value: this.now() } }, { orderBy: [['effective_at', 'asc']] });
    return { current: this.parts.views.schedule(current), upcoming: upcoming ? this.parts.views.schedule(upcoming) : null };
  }

  /** Proposes a schedule: Business Owner approval, at least sellerNoticeDays ahead; enrolled sellers are told once approved */
  async createSchedule(body: { version: string; effectiveAt: string; rates: FeeRate[]; reason: string }, by: By): Promise<FeeSchedule> {
    const issues = validateRates(body.rates ?? []);
    const version = body.version?.trim();
    if (!version) issues.push({ path: 'version', message: 'Name the schedule version' });
    if (!body.reason?.trim()) issues.push({ path: 'reason', message: 'Explain the change' });
    const effectiveAt = new Date(body.effectiveAt);
    const notice = await this.core.setting('sellerNoticeDays', 30);
    const earliest = new Date(this.now().getTime() + notice * 86_400_000);
    if (Number.isNaN(effectiveAt.getTime())) issues.push({ path: 'effectiveAt', message: 'Not a valid date' });
    else if (effectiveAt < earliest) issues.push({ path: 'effectiveAt', message: `Sellers get ${notice} days notice: the schedule can start ${earliest.toISOString().slice(0, 10)} at the earliest` });
    for (const t of FEE_TYPES) if (!body.rates?.some((r) => r.type === t)) issues.push({ path: 'rates', message: `Add a rate for ${t}` });
    if (issues.length) throw invalid(issues);
    if (await this.repo.findOne('fee_schedules', { version })) throw invalid([{ path: 'version', message: `Version ${version} already exists` }]);
    const access = this.ctx.tryUse('access');
    if (!access) throw new AppError('APPROVAL_REQUIRED', 'Fee schedule changes need Business Owner approval, which is not available right now');
    const principal = this.core.principalOf(by);
    const check = await access.check(principal, FEES_ACTION);
    if (check.decision === 'denied') throw new AppError('FORBIDDEN', check.reason || 'You cannot propose fee schedules');
    const id = newId();
    const row = await this.repo.insert('fee_schedules', { id, version, effective_at: effectiveAt, rates: body.rates, state: 'draft', approval_request_id: null });
    const audit = (approvalRequestId: string | null) =>
      this.core.audit(
        {
          action: 'fulfillment-service.fee_schedule.create',
          actionLabel: approvalRequestId ? 'Proposed a fulfillment fee schedule' : 'Published a fulfillment fee schedule',
          category: 'financial',
          target: { type: 'fulfillment_fee_schedule', id, ref: version, label: `Fulfillment fee schedule ${version}`, screen: 'admin/settings' },
          after: { version, effectiveAt: effectiveAt.toISOString(), rates: body.rates },
          reason: body.reason.trim(),
          approvalRequestId,
        },
        by,
      );
    if (check.decision === 'allowed') {
      const published = await this.publishSchedule(id, by);
      await audit(null);
      return this.parts.views.schedule(published);
    }
    const req = await access.requestApproval({
      action: FEES_ACTION,
      target: { type: SCHEDULE_TARGET, id, ref: version, label: `Fulfillment fee schedule ${version}`, screen: 'admin/settings' },
      summary: `Fulfillment fee schedule ${version} from ${effectiveAt.toISOString().slice(0, 10)}`,
      details: { version, effectiveAt: effectiveAt.toISOString(), rates: body.rates },
      reason: body.reason.trim(),
      requestedBy: principal,
    });
    const pending = await this.repo.update('fee_schedules', row.id, { approval_request_id: req.id });
    await audit(req.id);
    return this.parts.views.schedule(pending);
  }

  /** Approved: scheduled for its date, and every enrolled seller is told */
  private async publishSchedule(id: string, by: By, claim?: string) {
    let handled = false;
    const row = await this.repo.transaction(async (tx) => {
      if (claim && !(await tx.claim(claim))) {
        handled = true; // the decision was already applied
        return null;
      }
      const s = await tx.get('fee_schedules', id, { forUpdate: true });
      if (!s || s.state !== 'draft') return s ?? null;
      return tx.update('fee_schedules', id, { state: 'scheduled' });
    });
    if (handled) return (await this.repo.get('fee_schedules', id))!;
    if (!row) throw notFound('Fee schedule');
    await this.core.syncSchedules();
    const sellers = await this.repo.find('enrollments', { state: ['approved', 'active', 'suspended', 'offboarding'] }, { limit: 50_000 });
    const effective = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: this.core.tz }).format(row.effective_at);
    for (const e of sellers) {
      await this.core.notifySeller(e.seller_id, 'seller.fulfillment.fee_schedule_changed', { version: row.version, effective }, { kind: 'setting_change', id: row.id, ref: row.version, label: 'View fees', screen: 'seller/finance' }, `fs:schedule:${row.id}`);
    }
    void by;
    return (await this.repo.get('fee_schedules', id))!;
  }

  /** access.approval.decided for fulfillment-service.fees.change (claimed once per request) */
  async onScheduleDecided(e: EventPayload<'access.approval.decided'>): Promise<void> {
    if (!isUuid(e.target.id)) return;
    const row = await this.repo.get('fee_schedules', e.target.id);
    if (!row || row.state !== 'draft') return;
    if (e.outcome === 'approved') await this.publishSchedule(row.id, { actor: e.decidedBy ?? SYSTEM }, `approval-decided:${e.requestId}`);
    else this.ctx.log.info({ scheduleId: row.id, outcome: e.outcome }, 'fulfillment-service: fee schedule not approved');
  }

  /* ---------------------------------------------------------------- charges */

  async listOwn(sellerId: string, q: { type?: string; from?: string; to?: string }, page: PageRequest) {
    const where: Record<string, unknown> = { seller_id: sellerId };
    if (q.type) where.type = q.type;
    if (q.from && q.to) where.period = periodsBetween(q.from.slice(0, 7), q.to.slice(0, 7));
    else if (q.from) where.period = { op: '>=', value: q.from.slice(0, 7) };
    else if (q.to) where.period = { op: '<=', value: q.to.slice(0, 7) };
    const res = await this.repo.page('fee_charges', where, page, { order: { column: 'id', direction: 'desc' } });
    return { ...res, items: res.items.map((c) => this.parts.views.charge(c)) };
  }

  async listAdmin(q: { sellerId?: string; type?: string; state?: string; period?: string }, page: PageRequest) {
    const where: Record<string, unknown> = {};
    if (q.sellerId) where.seller_id = q.sellerId;
    if (q.type) where.type = q.type;
    if (q.state) where.state = q.state;
    if (q.period) where.period = q.period;
    const res = await this.repo.page('fee_charges', where, page, { order: { column: 'id', direction: 'desc' } });
    return { ...res, items: res.items.map((c) => this.parts.views.charge(c)) };
  }

  /** Fees of a market month (not reversed), in minor units */
  async totalFor(sellerId: string, month: string): Promise<{ amount: number; currency: string }> {
    const rows = await this.repo.find('fee_charges', { seller_id: sellerId, period: month, state: ['accrued', 'posted'] });
    return { amount: rows.reduce((n, c) => n + c.amount, 0), currency: rows[0]?.currency ?? 'USD' };
  }

  /** Reverse an accrued or posted charge; above the caller's adjustment limit it needs Finance approval */
  async reverse(id: string, reason: string, by: By): Promise<FeeCharge> {
    const text = reason?.trim();
    if (!text) throw invalid([{ path: 'reason', message: 'Give the reason the seller will see' }]);
    const row = isUuid(id) ? await this.repo.get('fee_charges', id) : undefined;
    if (!row) throw notFound('Fee charge');
    serviceFeeChargeMachine.next(row.state as FeeCharge['state'], 'reverse');
    if (row.state === 'posted') this.creditable(row);
    const access = this.ctx.tryUse('access');
    if (access) {
      const principal = this.core.principalOf(by);
      const amount = this.core.money(Math.abs(row.amount), row.currency);
      const check = await access.check(principal, REVERSE_ACTION, { money: amount });
      if (check.decision === 'denied') throw new AppError('FORBIDDEN', check.reason || 'You cannot reverse fulfillment fees');
      if (check.decision === 'approval_required') {
        const req = await access.requestApproval({
          action: REVERSE_ACTION,
          target: { type: CHARGE_TARGET, id: row.id, ref: row.reference, label: `${CHARGE_LABEL[row.type] ?? row.type} fee ${row.reference ?? row.period ?? ''}`.trim(), sellerId: row.seller_id, screen: 'admin/finance' },
          amount,
          summary: `Reverse a ${fmt(row.amount, row.currency)} fulfillment ${CHARGE_LABEL[row.type]?.toLowerCase() ?? row.type} fee`,
          details: { chargeId: row.id, type: row.type, period: row.period, reference: row.reference, state: row.state },
          reason: text,
          requestedBy: principal,
        });
        await this.auditReversal(row, row, text, by, req.id);
        throw new AppError('APPROVAL_REQUIRED', `${check.reason || 'Above your adjustment limit'}; sent for approval.`, { approvalRequestId: req.id, approval: { required: true, approvalRequestId: req.id, approvers: (check.eligibleApproverRoles ?? []).map((r) => r.name) } });
      }
    }
    const after = (await this.applyReversal(row.id, text, by))!;
    await this.auditReversal(row, after, text, by, null);
    return this.parts.views.charge(after);
  }

  private async auditReversal(before: ChargeRec, after: ChargeRec, reason: string, by: By, approvalRequestId: string | null) {
    await this.core.audit(
      {
        action: 'fulfillment-service.fee.reverse',
        actionLabel: approvalRequestId ? 'Asked to reverse a fulfillment fee' : 'Reversed a fulfillment fee',
        category: 'financial',
        target: { type: 'fulfillment_fee_charge', id: before.id, ref: before.reference, label: `${CHARGE_LABEL[before.type] ?? before.type} fee ${before.reference ?? before.period ?? ''}`.trim(), sellerId: before.seller_id, screen: 'admin/finance' },
        before: { state: before.state, amount: this.core.money(before.amount, before.currency) },
        after: { state: after.state },
        reason,
        approvalRequestId,
        visibleToSeller: true,
      },
      by,
    );
  }

  /**
   * A posted fee is reversed by crediting its ledger entry (finance.creditSellerCharge). A posted reimbursement was
   * itself a credit to the seller: taking it back is a finance adjustment, not a reversal here.
   */
  private creditable(row: ChargeRec): string {
    if (row.amount < 0) throw new AppError('ILLEGAL_TRANSITION', 'This reimbursement is already paid to the seller; take it back with a finance adjustment.', { from: row.state, event: 'reverse', chargeId: row.id });
    if (!row.ledger_entry_id) throw new AppError('ILLEGAL_TRANSITION', 'This fee was posted without its ledger entry; credit the seller with a finance adjustment instead.', { from: row.state, event: 'reverse', chargeId: row.id });
    return row.ledger_entry_id;
  }

  /**
   * accrued → reversed (never reached the ledger), or posted → reversed after crediting the seller ledger for the
   * whole fee (idempotent per charge). `claim`: inbox key of the event being handled; null when already handled.
   */
  private async applyReversal(id: string, reason: string, by: By, claim?: string, o: { creditSettled?: boolean } = {}): Promise<ChargeRec | null> {
    const pre = (await this.repo.get('fee_charges', id))!;
    if (pre.state === 'accrued' && pre.amount < 0 && !o.creditSettled) {
      // an accrued reimbursement may already wait in finance as a seller credit: withdraw it (a posted one is paid)
      const finance = this.ctx.use('finance');
      const idempotencyKey = `fulfillment-service:reimbursement:${id}`;
      const credit = await finance.getSellerCredit({ idempotencyKey });
      if (credit?.status === 'posted') throw new AppError('ILLEGAL_TRANSITION', 'This reimbursement is already paid to the seller; take it back with a finance adjustment.', { from: pre.state, event: 'reverse', chargeId: id });
      if (credit?.status === 'pending_approval') await finance.withdrawSellerCredit({ idempotencyKey, reason });
    }
    if (pre.state === 'posted') {
      await this.ctx.use('finance').creditSellerCharge({
        sellerId: pre.seller_id,
        amount: this.core.money(pre.amount, pre.currency),
        originalEntryId: this.creditable(pre),
        reason,
        idempotencyKey: `fulfillment-service:fee-reversal:${id}`,
      });
    }
    const res = await this.repo.transaction(async (tx) => {
      if (claim && !(await tx.claim(claim))) return null; // already handled
      const before = (await tx.get('fee_charges', id, { forUpdate: true }))!;
      if (before.state === 'reversed') return { after: before, changed: false };
      // posted by the job since we looked: the ledger has not been credited yet
      if (before.state !== pre.state) throw new AppError('CONFLICT', 'The fee was posted meanwhile; reverse it again.');
      const state = serviceFeeChargeMachine.next(before.state as FeeCharge['state'], 'reverse');
      return { after: await tx.update('fee_charges', id, { state, reason }), changed: true };
    });
    if (!res) return null;
    const { after, changed } = res;
    if (changed) this.core.publish('fulfillment-service.fee.reversed', { chargeId: id, sellerId: after.seller_id, amount: this.core.money(after.amount, after.currency), reason, period: after.period }, by);
    return after;
  }

  /** access.approval.decided for fulfillment-service.charges.reverse (claimed once per request) */
  async onReverseDecided(e: EventPayload<'access.approval.decided'>, eventId?: string): Promise<void> {
    if (e.outcome !== 'approved' || !isUuid(e.target.id)) return;
    const row = await this.repo.get('fee_charges', e.target.id);
    if (!row || row.state === 'reversed') return;
    if (row.state === 'posted' && (row.amount < 0 || !row.ledger_entry_id)) {
      this.ctx.log.warn({ chargeId: row.id, approvalRequestId: e.requestId, eventId }, 'fulfillment-service: approved reversal cannot be credited through finance; needs a finance adjustment');
      return;
    }
    let reason = e.reason ?? null;
    try {
      reason = (await this.ctx.tryUse('access')?.getApproval(e.requestId))?.reason ?? reason;
    } catch {
      /* keep the decision note */
    }
    await this.applyReversal(row.id, reason || 'Approved reversal', { actor: e.decidedBy ?? SYSTEM }, `approval-decided:${e.requestId}`);
  }

  /* ---------------------------------------------------------------- posting to finance */

  /**
   * Job fulfillment-service.post-fees: accrued fees go to the seller ledger as service_fee
   * (finance.recordServiceFee), accrued reimbursements as a seller credit (finance.creditSeller); both idempotent
   * per charge. The entry is kept on the charge (ledger_entry_id) and fee.charged is published.
   *
   * A reimbursement above finance's creditSecondReviewerThreshold comes back pending_approval: the charge stays
   * accrued and the next run reads the credit back with finance.getSellerCredit({ idempotencyKey }) instead of
   * asking again (the spec gives this module no finance.seller_credit.decided consumer). Posted → the charge is
   * posted; rejected by Finance (or withdrawn) → the charge is reversed with Finance's decision as the reason.
   */
  async postAll(): Promise<{ posted: number }> {
    const finance = this.ctx.use('finance');
    const due = (await this.repo.find('fee_charges', { state: 'accrued' }, { orderBy: [['id', 'asc']], limit: 2000 })).filter((c) => c.amount !== 0);
    let posted = 0;
    for (const c of due) {
      try {
        let entryId: string;
        if (c.amount > 0) {
          const entry = await finance.recordServiceFee({
            sellerId: c.seller_id,
            amount: this.core.money(c.amount, c.currency),
            kind: c.type,
            reference: { kind: 'fulfillment_service', id: c.id, ref: c.reference ?? `FS-${c.period ?? ''}` },
            description: `Fulfillment service: ${CHARGE_LABEL[c.type] ?? c.type} · ${Number(c.units)} × ${fmt(c.rate, c.currency)}${c.reference ? ` · ${c.reference}` : ''}`,
            idempotencyKey: `fulfillment-service:fee:${c.id}`,
          });
          entryId = entry.id;
        } else {
          const idempotencyKey = `fulfillment-service:reimbursement:${c.id}`;
          const credit =
            (await finance.getSellerCredit({ idempotencyKey })) ??
            (await finance.creditSeller({
              sellerId: c.seller_id,
              amount: this.core.money(-c.amount, c.currency),
              reason: c.reason ?? `Reimbursement${c.reference ? ` for ${c.reference}` : ''}`,
              reference: { kind: 'fulfillment_service', id: c.id, ref: c.reference ?? null },
              idempotencyKey,
            }));
          if (credit.status === 'rejected' || credit.status === 'withdrawn') {
            await this.applyReversal(c.id, credit.status === 'rejected' ? 'Finance did not approve the reimbursement' : 'The reimbursement was withdrawn', { actor: SYSTEM }, undefined, { creditSettled: true });
            continue;
          }
          if (credit.status !== 'posted' || !credit.ledgerEntry) {
            this.ctx.log.info({ chargeId: c.id, creditId: credit.id, approvalRequestId: credit.approvalRequestId }, 'fulfillment-service: reimbursement waits for Finance approval');
            continue;
          }
          entryId = credit.ledgerEntry.id;
        }
        const done = await this.repo.transaction(async (tx) => {
          const locked = await tx.get('fee_charges', c.id, { forUpdate: true });
          if (!locked || locked.state !== 'accrued') return null;
          return tx.update('fee_charges', c.id, { state: serviceFeeChargeMachine.next('accrued', 'post'), posted_at: this.now(), ledger_entry_id: entryId });
        });
        if (done) {
          posted += 1;
          this.core.publish('fulfillment-service.fee.charged', { chargeId: c.id, sellerId: c.seller_id, type: c.type, amount: this.core.money(c.amount, c.currency), reference: c.reference, period: c.period });
        }
      } catch (err) {
        if (err instanceof AppError && err.code === 'NOT_IMPLEMENTED') return { posted };
        this.ctx.log.warn({ err, chargeId: c.id }, 'fulfillment-service: fee not posted');
      }
    }
    return { posted };
  }

  /* ---------------------------------------------------------------- storage fees */

  /**
   * Job fulfillment-service.monthly-storage-fees: the previous month's storage per seller from the daily
   * snapshots (average cubic feet over the month × rate), and long-term storage for units past
   * longTermStorageDays. Idempotent per seller and month.
   */
  async monthlyStorage(month: string = previousMonth(this.core.month())): Promise<{ charges: number }> {
    const from = `${month}-01`;
    const to = addDays(from, daysInMonth(month) - 1);
    const snaps = await this.repo.find('storage_snapshots', { day: { op: '>=', value: from } }, { limit: 500_000 });
    const inMonth = snaps.filter((s) => s.day <= to);
    if (!inMonth.length) return { charges: 0 };
    const days = daysInMonth(month);
    const bySeller = new Map<string, { cubic: number; longTerm: number }>();
    for (const s of inMonth) {
      const t = bySeller.get(s.seller_id) ?? { cubic: 0, longTerm: 0 };
      t.cubic += Number(s.cubic_feet);
      const units = s.units || 0;
      const lt = Number(s.aged_units.longTerm ?? 0);
      t.longTerm += units > 0 ? (Number(s.cubic_feet) * lt) / units : 0;
      bySeller.set(s.seller_id, t);
    }
    const rates = (await this.core.currentSchedule()).rates;
    let charges = 0;
    for (const [sellerId, t] of bySeller) {
      const avg = round4(t.cubic / days);
      const lt = round4(t.longTerm / days);
      const made = await this.repo.transaction(async (tx) => {
        let n = 0;
        if (await this.core.accrue(tx, { sellerId, rateType: 'storage_per_cubic_foot_month', sizeTier: 'any', units: avg, reference: `Storage ${month}`, key: `storage:${sellerId}:${month}`, period: month }, rates)) n += 1;
        if (await this.core.accrue(tx, { sellerId, rateType: 'long_term_storage_per_cubic_foot_month', sizeTier: 'any', units: lt, reference: `Long-term storage ${month}`, key: `long_term_storage:${sellerId}:${month}`, period: month }, rates)) n += 1;
        return n;
      });
      charges += made;
    }
    return { charges };
  }
}

/** Months from..to inclusive (YYYY-MM), at most five years */
function periodsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.split('-').map(Number) as [number, number];
  const [ty, tm] = to.split('-').map(Number) as [number, number];
  while ((y < ty || (y === ty && m <= tm)) && out.length < 60) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}
