/**
 * Holds (manual and rule-based: chargeback, dispute, new seller, restriction), adjustments with
 * second-reviewer approval, amounts owed and write-offs, and the consumers that place or settle them.
 */
import { AppError } from '../../../kernel/errors/index.js';
import type { EventPayload } from '../../../kernel/events/index.js';
import { isUuid, newId } from '../../../kernel/lib/ids.js';
import type { PageRequest } from '../../../kernel/lib/pagination.js';
import type * as common from '../../../spec/common.js';
import type { Adjustment, AdjustmentInput, AmountOwed, Hold, HoldInput, Reference } from '../../../spec/finance.js';
import { addDays, DAY, detId, encodeActor, fmt, isDate, SYSTEM } from '../domain/rules.js';
import { adjustmentMachine, amountOwedMachine, holdMachine } from '../domain/state-machines.js';
import { toAdjustment, toHold, toOwed } from '../mappers.js';
import type { AdjustmentRec, HoldRec } from '../ports.js';
import type { Where } from '../../../kernel/mongo/index.js';
import type { FinanceRepository } from '../repository.js';
import { invalid, notFound, Outbox, Part, type By, type NewEntry } from './core.js';

const HOLD_DECISION = 'finance.holds.release';

export class HoldsPart extends Part {
  /* ---------------------------------------------------------------- views */

  async holdViews(rows: HoldRec[]): Promise<Hold[]> {
    const names = await this.core.sellerInfo(rows.map((r) => r.seller_id));
    const infos = await this.core.approvalInfos(rows.map((r) => r.approval_request_id));
    return rows.map((r) => toHold(r, names.get(r.seller_id)?.name ?? 'Seller', r.approval_request_id ? (infos.get(r.approval_request_id) ?? null) : null));
  }

  async holdView(id: string): Promise<Hold> {
    const row = await this.repo.get('holds', id);
    if (!row) throw notFound('Hold');
    return (await this.holdViews([row]))[0]!;
  }

  async listHolds(f: { status?: string | null; sellerId?: string | null; reviewDue?: string | null }, page: PageRequest): Promise<common.Page<Hold>> {
    const where: Where<HoldRec> = {};
    if (f.status) where.status = f.status;
    if (f.sellerId) where.seller_id = f.sellerId;
    const today = this.core.today();
    if (f.reviewDue === 'overdue') where.review_date = { op: '<', value: today };
    else if (f.reviewDue === 'today') where.review_date = today;
    else if (f.reviewDue === 'this_week') where.review_date = { op: '<=', value: addDays(today, 7) };
    const res = await this.repo.page('holds', where, page, { column: 'placed_at', direction: 'desc' });
    return { ...res, items: await this.holdViews(res.items) };
  }

  async holdsForReference(references: { kind: string; id: string }[]): Promise<Hold[]> {
    const rows: HoldRec[] = [];
    for (const r of references) rows.push(...(await this.repo.find('holds', { ref_kind: r.kind, ref_id: r.id }, { orderBy: [['placed_at', 'desc']] })));
    const unique = [...new Map(rows.map((r) => [r.id, r])).values()];
    return this.holdViews(unique);
  }

  /* ---------------------------------------------------------------- holds */

  private async posted(tx: FinanceRepository, holdId: string) {
    return Boolean(await tx.findOne('ledger_entries', { source_event_id: `hold:${holdId}:in` }));
  }

  /** Earnings move from available to held (two entries: balance unchanged) */
  private holdEntries(h: HoldRec): NewEntry[] {
    const ref = { kind: (h.ref_kind ?? 'seller') as Reference['kind'], id: h.ref_id ?? h.seller_id };
    const text = `Held: ${h.reason}. Review ${h.review_date}`;
    return [
      { key: `hold:${h.id}:out`, type: 'hold', amount: -h.amount, bucket: 'available', ref, description: text, recordedBy: JSON.parse(h.placed_by) },
      { key: `hold:${h.id}:in`, type: 'hold', amount: h.amount, bucket: 'held', ref, description: text, recordedBy: JSON.parse(h.placed_by) },
    ];
  }

  async place(input: HoldInput & { system?: boolean; id?: string }, by: By): Promise<Hold> {
    const issues: { path: string; message: string }[] = [];
    if (!isUuid(input.sellerId)) issues.push({ path: 'sellerId', message: 'A seller id' });
    if (!Number.isSafeInteger(input.amount.amount) || input.amount.amount <= 0) issues.push({ path: 'amount', message: 'A positive amount' });
    if (!isDate(input.reviewDate) || (!input.system && input.reviewDate < this.core.today())) issues.push({ path: 'reviewDate', message: 'A review date from today' });
    if (!input.reason?.trim()) issues.push({ path: 'reason', message: 'Give the reason the seller will see' });
    if (issues.length) throw invalid(issues, 'The hold is not valid');
    const id = input.id ?? newId();
    let approvalId: string | null = null;
    if (!input.system) {
      const check = await this.core.authority(by, 'finance.holds.place', input.amount.amount);
      if (check.decision === 'approval_required') {
        const req = await this.core.requestApproval(by, {
          action: 'finance.holds.place',
          target: { type: 'hold', id, label: `Hold ${fmt(input.amount.amount, input.amount.currency)}`, sellerId: input.sellerId, screen: 'admin/payouts' },
          amount: input.amount,
          summary: `Hold ${fmt(input.amount.amount, input.amount.currency)} of a seller's earnings (${input.reasonCode.replace(/_/g, ' ')})`,
          details: { reviewDate: input.reviewDate, reasonCode: input.reasonCode },
          reason: input.reason,
        });
        approvalId = req.id;
      }
    }
    const row: HoldRec = {
      id,
      seller_id: input.sellerId,
      amount: input.amount.amount,
      released_amount: 0,
      currency: input.amount.currency || this.core.currency(),
      reason_code: input.reasonCode,
      reason: input.reason.trim(),
      review_date: input.reviewDate,
      ref_kind: input.reference?.kind ?? null,
      ref_id: input.reference?.id ?? null,
      status: holdMachine.initial,
      placed_by: encodeActor(by.actor)!,
      placed_at: this.now(),
      released_at: null,
      release_reason: null,
      approval_request_id: approvalId,
      trust_report_id: input.trustReportId ?? null,
    };
    const out = new Outbox();
    const inserted = await this.repo.transaction(async (tx) => {
      if (!(await tx.insertIfAbsent('holds', row))) return false;
      if (!approvalId) await this.core.post(tx, row.seller_id, this.holdEntries(row), out);
      return true;
    });
    this.core.flush(out, by);
    if (inserted && !approvalId) this.core.publish('finance.hold.placed', { holdId: id, sellerId: row.seller_id, amount: input.amount, reasonCode: row.reason_code, reason: row.reason, reviewDate: row.review_date, trustReportId: input.trustReportId ?? null }, by);
    if (inserted) await this.core.audit({ action: 'finance.hold.place', actionLabel: approvalId ? 'Requested approval for a hold' : 'Placed a hold on seller earnings', category: 'financial', target: { type: 'hold', id, label: row.reason, sellerId: row.seller_id, screen: 'admin/payouts' }, after: { amount: row.amount, reasonCode: row.reason_code, reviewDate: row.review_date }, reason: row.reason, approvalRequestId: approvalId, visibleToSeller: true }, by);
    // above the limit the hold is saved waiting for approval and answered with `approval` (FORMAT.md, Approval responses)
    return this.holdView(id);
  }

  /** release (all or part) or apply (deduct) a hold; above the limit an approval request is created */
  async decide(id: string, op: 'release' | 'apply', body: { amount?: common.Money | null; reason: string }, by: By, o: { system?: boolean } = {}): Promise<Hold> {
    if (!isUuid(id)) throw notFound('Hold');
    const hold = await this.repo.get('holds', id);
    if (!hold) throw notFound('Hold');
    if (!body.reason?.trim()) throw invalid([{ path: 'reason', message: 'Give a reason' }]);
    if (hold.status !== 'active') this.core.step(holdMachine, hold.status, op === 'apply' ? 'apply' : 'release'); // ILLEGAL_TRANSITION
    const remaining = hold.amount - hold.released_amount;
    const amount = body.amount?.amount ?? remaining;
    if (!Number.isSafeInteger(amount) || amount <= 0 || amount > remaining) throw invalid([{ path: 'amount', message: `Up to the ${fmt(remaining, hold.currency)} still held` }]);
    if (!(await this.posted(this.repo, id))) {
      // a hold still waiting for its own approval: withdrawing it cancels the request
      if (op === 'apply') throw new AppError('ILLEGAL_TRANSITION', 'The hold is waiting for approval and holds no money yet', { from: 'pending_approval', event: 'apply' });
      if (hold.approval_request_id) await this.core.optionalDep(() => this.ctx.use('access').cancelApproval(hold.approval_request_id!, by.actor, body.reason));
      await this.repo.update('holds', id, { status: this.core.step(holdMachine, 'active', 'release'), released_at: this.now(), release_reason: body.reason, approval_request_id: null });
      return this.holdView(id);
    }
    if (!o.system) {
      const check = await this.core.authority(by, HOLD_DECISION, amount);
      if (check.decision === 'approval_required') {
        const req = await this.core.requestApproval(by, {
          action: HOLD_DECISION,
          target: { type: 'hold', id, label: hold.reason, sellerId: hold.seller_id, screen: 'admin/payouts' },
          amount: { amount, currency: hold.currency },
          summary: `${op === 'apply' ? 'Apply' : 'Release'} ${fmt(amount, hold.currency)} of a hold (${hold.reason_code.replace(/_/g, ' ')})`,
          details: { op, amount, reason: body.reason },
          reason: body.reason,
        });
        await this.repo.update('holds', id, { approval_request_id: req.id });
        await this.core.audit({ action: `finance.hold.${op}_requested`, actionLabel: `Requested approval to ${op} a hold`, category: 'financial', target: { type: 'hold', id, label: hold.reason, sellerId: hold.seller_id }, reason: body.reason, approvalRequestId: req.id }, by);
        return this.holdView(id); // saved pending: the hold answers with `approval` (FORMAT.md, Approval responses)
      }
    }
    await this.apply(id, op, amount, body.reason, by);
    return this.holdView(id);
  }

  /** Performs a release or application already authorized */
  async apply(id: string, op: 'release' | 'apply', amount: number, reason: string, by: By) {
    const out = new Outbox();
    const res = await this.repo.transaction(async (tx) => {
      const h = await tx.get('holds', id, { forUpdate: true });
      if (!h || h.status !== 'active') return null;
      const remaining = h.amount - h.released_amount;
      const take = Math.min(amount, remaining);
      if (take <= 0) return null;
      const ref = { kind: (h.ref_kind ?? 'seller') as Reference['kind'], id: h.ref_id ?? h.seller_id };
      const n = h.released_amount;
      let released = 0;
      let applied = 0;
      const entries: NewEntry[] = [];
      if (op === 'release') {
        released = take;
        entries.push(
          { key: `hold_release:${h.id}:${n}:out`, type: 'hold_release', amount: -take, bucket: 'held', ref, description: `Released: ${reason}`, recordedBy: by.actor },
          { key: `hold_release:${h.id}:${n}:in`, type: 'hold_release', amount: take, bucket: 'available', ref, description: `Released: ${reason}`, recordedBy: by.actor },
        );
      } else {
        applied = take;
        released = remaining - take;
        entries.push({ key: `hold_apply:${h.id}`, type: h.reason_code === 'chargeback' ? 'chargeback' : 'adjustment', amount: -take, bucket: 'held', ref, description: `Applied: ${reason}`, recordedBy: by.actor });
        if (released > 0)
          entries.push(
            { key: `hold_release:${h.id}:${n}:out`, type: 'hold_release', amount: -released, bucket: 'held', ref, description: 'Released: rest of the hold after it was applied', recordedBy: by.actor },
            { key: `hold_release:${h.id}:${n}:in`, type: 'hold_release', amount: released, bucket: 'available', ref, description: 'Released: rest of the hold after it was applied', recordedBy: by.actor },
          );
      }
      await this.core.post(tx, h.seller_id, entries, out);
      const total = h.released_amount + released;
      const status = op === 'apply' ? this.core.step(holdMachine, h.status, 'apply') : this.core.step(holdMachine, h.status, total >= h.amount ? 'release' : 'partialRelease');
      await tx.update('holds', h.id, { released_amount: total, status, released_at: status === 'active' ? h.released_at : this.now(), release_reason: reason, approval_request_id: null });
      return { h, released, applied };
    });
    this.core.flush(out, by);
    if (!res) return;
    const { h, released, applied } = res;
    if (released > 0) this.core.publish('finance.hold.released', { holdId: h.id, sellerId: h.seller_id, amount: this.money(released), reason }, by);
    if (applied > 0) {
      await this.recordSystemAdjustment({ key: `hold_apply:${h.id}`, sellerId: h.seller_id, direction: 'debit', amount: applied, reasonCode: 'other', reason: `Hold applied (${h.reason_code.replace(/_/g, ' ')}): ${reason}`, reference: { kind: (h.ref_kind ?? 'seller') as Reference['kind'], id: h.ref_id ?? h.seller_id, ref: null }, by, posted: true });
    }
    await this.core.audit({ action: `finance.hold.${op}`, actionLabel: op === 'apply' ? 'Applied a hold as a deduction' : 'Released a hold', category: 'financial', target: { type: 'hold', id: h.id, label: h.reason, sellerId: h.seller_id, screen: 'admin/payouts' }, before: { status: h.status, releasedAmount: h.released_amount }, after: { released, applied }, reason, visibleToSeller: true }, by);
  }

  async extend(id: string, body: { reviewDate: string; reason: string }, by: By): Promise<Hold> {
    if (!isUuid(id)) throw notFound('Hold');
    if (!isDate(body.reviewDate) || body.reviewDate < this.core.today()) throw invalid([{ path: 'reviewDate', message: 'A review date from today' }]);
    if (!body.reason?.trim()) throw invalid([{ path: 'reason', message: 'Give a reason' }]);
    const before = await this.repo.transaction(async (tx) => {
      const h = await tx.get('holds', id, { forUpdate: true });
      if (!h) throw notFound('Hold');
      await tx.update('holds', id, { status: this.core.step(holdMachine, h.status, 'extend'), review_date: body.reviewDate });
      return h;
    });
    await this.core.audit({ action: 'finance.hold.extend', actionLabel: 'Moved a hold review date', category: 'financial', target: { type: 'hold', id, label: before.reason, sellerId: before.seller_id }, before: { reviewDate: before.review_date }, after: { reviewDate: body.reviewDate }, reason: body.reason, visibleToSeller: true }, by);
    return this.holdView(id);
  }

  /* ---------------------------------------------------------------- adjustments */

  async adjustmentViews(rows: AdjustmentRec[]): Promise<Adjustment[]> {
    const names = await this.core.sellerInfo(rows.map((r) => r.seller_id));
    const infos = await this.core.approvalInfos(rows.map((r) => r.approval_request_id));
    return rows.map((r) => toAdjustment(r, names.get(r.seller_id)?.name ?? 'Seller', r.approval_request_id ? (infos.get(r.approval_request_id) ?? null) : null));
  }

  async listAdjustments(f: { sellerId?: string | null; status?: string | null }, page: PageRequest): Promise<common.Page<Adjustment>> {
    const where: Where<AdjustmentRec> = {};
    if (f.sellerId) where.seller_id = f.sellerId;
    if (f.status) where.status = f.status;
    const res = await this.repo.page('adjustments', where, page, { column: 'created_at', direction: 'desc' });
    return { ...res, items: await this.adjustmentViews(res.items) };
  }

  private adjustmentEntry(a: AdjustmentRec): NewEntry {
    return { key: `adjustment:${a.id}`, type: 'adjustment', amount: a.direction === 'credit' ? a.amount : -a.amount, bucket: 'available', ref: { kind: 'adjustment', id: a.id, label: a.ref }, description: `${a.reason} (${a.reason_code.replace(/_/g, ' ')})`, recordedBy: JSON.parse(a.recorded_by) };
  }

  async record(input: AdjustmentInput, by: By, idempotencyKey?: string): Promise<Adjustment> {
    const issues: { path: string; message: string }[] = [];
    if (!isUuid(input.sellerId)) issues.push({ path: 'sellerId', message: 'A seller id' });
    if (!Number.isSafeInteger(input.amount.amount) || input.amount.amount <= 0) issues.push({ path: 'amount', message: 'A positive amount' });
    if (!input.reason?.trim()) issues.push({ path: 'reason', message: 'Give the reason the seller will see' });
    if (issues.length) throw invalid(issues, 'The adjustment is not valid');
    if (idempotencyKey) {
      const prior = await this.repo.findOne('adjustments', { idempotency_key: idempotencyKey });
      if (prior) return (await this.adjustmentViews([prior]))[0]!;
    }
    const check = await this.core.authority(by, 'finance.adjustments.record', input.amount.amount);
    const id = newId();
    const ref = await this.ctx.refs.next('ADJ', { digits: 4 });
    let approvalId: string | null = null;
    if (check.decision === 'approval_required') {
      const req = await this.core.requestApproval(by, {
        action: 'finance.adjustments.record',
        target: { type: 'adjustment', id, ref, label: `${input.direction === 'credit' ? 'Credit' : 'Debit'} ${fmt(input.amount.amount, input.amount.currency)}`, sellerId: input.sellerId, screen: 'admin/seller' },
        amount: input.amount,
        summary: `${input.direction === 'credit' ? 'Credit' : 'Debit'} of ${fmt(input.amount.amount, input.amount.currency)} to a seller (${input.reasonCode.replace(/_/g, ' ')})`,
        details: { direction: input.direction, reasonCode: input.reasonCode, reference: input.reference ?? null },
        reason: input.reason,
      });
      approvalId = req.id;
    }
    const row: AdjustmentRec = {
      id,
      ref,
      seller_id: input.sellerId,
      direction: input.direction,
      amount: input.amount.amount,
      currency: input.amount.currency || this.core.currency(),
      reason_code: input.reasonCode,
      reason: input.reason.trim(),
      ref_kind: input.reference?.kind ?? null,
      ref_id: input.reference?.id ?? null,
      status: this.core.step(adjustmentMachine, adjustmentMachine.initial, approvalId ? 'requireApproval' : 'record'),
      recorded_by: encodeActor(by.actor)!,
      approval_request_id: approvalId,
      idempotency_key: idempotencyKey ?? null,
      created_at: this.now(),
    };
    const out = new Outbox();
    await this.repo.transaction(async (tx) => {
      await tx.insert('adjustments', row);
      if (!approvalId) await this.core.post(tx, row.seller_id, [this.adjustmentEntry(row)], out);
    });
    this.core.flush(out, by);
    if (!approvalId) this.core.publish('finance.adjustment.recorded', { adjustmentId: id, sellerId: row.seller_id, direction: row.direction, amount: input.amount, reasonCode: row.reason_code }, by);
    await this.core.audit({ action: 'finance.adjustment.record', actionLabel: approvalId ? 'Proposed a seller adjustment for approval' : 'Recorded a seller adjustment', category: 'financial', target: { type: 'adjustment', id, ref, label: row.reason, sellerId: row.seller_id, screen: 'admin/seller' }, after: { direction: row.direction, amount: row.amount, reasonCode: row.reason_code, status: row.status }, reason: row.reason, approvalRequestId: approvalId, visibleToSeller: true }, by);
    // above the limit the adjustment is saved pending_approval and answered with `approval` (FORMAT.md, Approval responses)
    return (await this.adjustmentViews([row]))[0]!;
  }

  /** An adjustment that needs no approval (rules: carrier claim paid, hold applied, reconciliation correction approved) */
  async recordSystemAdjustment(o: { key: string; sellerId: string; direction: 'credit' | 'debit'; amount: number; reasonCode: AdjustmentRec['reason_code']; reason: string; reference?: Reference | null; by?: By; posted?: boolean }): Promise<AdjustmentRec> {
    const id = detId(`adjustment:${o.key}`);
    const existing = await this.repo.get('adjustments', id);
    if (existing) return existing;
    const by = o.by ?? { actor: SYSTEM };
    const ref = await this.ctx.refs.next('ADJ', { digits: 4 });
    const row: AdjustmentRec = {
      id,
      ref,
      seller_id: o.sellerId,
      direction: o.direction,
      amount: o.amount,
      currency: this.core.currency(),
      reason_code: o.reasonCode,
      reason: o.reason,
      ref_kind: o.reference?.kind ?? null,
      ref_id: o.reference?.id ?? null,
      status: this.core.step(adjustmentMachine, adjustmentMachine.initial, 'record'),
      recorded_by: encodeActor(by.actor)!,
      approval_request_id: null,
      idempotency_key: null,
      created_at: this.now(),
    };
    const out = new Outbox();
    const inserted = await this.repo.transaction(async (tx) => {
      if (!(await tx.insertIfAbsent('adjustments', row))) return false;
      if (!o.posted) await this.core.post(tx, row.seller_id, [this.adjustmentEntry(row)], out);
      return true;
    });
    this.core.flush(out, by);
    if (inserted) this.core.publish('finance.adjustment.recorded', { adjustmentId: id, sellerId: row.seller_id, direction: row.direction, amount: this.money(row.amount), reasonCode: row.reason_code }, by);
    return (await this.repo.get('adjustments', id))!;
  }

  /* ---------------------------------------------------------------- amounts owed */

  async listOwed(f: { status?: string | null; sellerId?: string | null }, page: PageRequest): Promise<common.Page<AmountOwed>> {
    const where: Where<import('../ports.js').OwedRec> = {};
    if (f.status) where.status = f.status;
    if (f.sellerId) where.seller_id = f.sellerId;
    const res = await this.repo.page('amounts_owed', where, page, { column: 'since', direction: 'desc' });
    const names = await this.core.sellerInfo(res.items.map((r) => r.seller_id));
    const approvals = await this.core.approvalInfos(res.items.map((r) => r.approval_request_id));
    return { ...res, items: res.items.map((r) => toOwed(r, names.get(r.seller_id)?.name ?? 'Seller', approvals)) };
  }

  async owedView(id: string): Promise<AmountOwed> {
    const r = await this.repo.get('amounts_owed', id);
    if (!r) throw notFound('Amount owed');
    return toOwed(r, await this.core.sellerName(r.seller_id), await this.core.approvalInfos([r.approval_request_id]));
  }

  async settle(id: string, body: { method: 'seller_paid' | 'offset' | 'written_off'; amount: common.Money; reason: string }, by: By): Promise<AmountOwed> {
    if (!isUuid(id)) throw notFound('Amount owed');
    const owed = await this.repo.get('amounts_owed', id);
    if (!owed) throw notFound('Amount owed');
    if (owed.status !== 'open') this.core.step(amountOwedMachine, owed.status, 'settle');
    const amount = body.amount.amount;
    if (!Number.isSafeInteger(amount) || amount <= 0 || amount > owed.remaining) throw invalid([{ path: 'amount', message: `Up to the ${fmt(owed.remaining, owed.currency)} still owed` }]);
    if (!body.reason?.trim()) throw invalid([{ path: 'reason', message: 'Give a reason' }]);
    if (body.method === 'written_off') {
      if (owed.approval_request_id) throw new AppError('CONFLICT', 'A write-off of this amount owed is already waiting for approval', { approvalRequestId: owed.approval_request_id });
      const check = await this.core.authority(by, 'finance.writeoffs.approve', amount);
      if (check.decision === 'approval_required') {
        const req = await this.core.requestApproval(by, {
          action: 'finance.writeoffs.approve',
          target: { type: 'amount_owed', id, label: `Amount owed by a seller`, sellerId: owed.seller_id, screen: 'admin/seller' },
          amount: body.amount,
          summary: `Write off ${fmt(amount, owed.currency)} a seller owes`,
          details: { amount, reason: body.reason },
          reason: body.reason,
        });
        // saved pending on the record: the answer is the amount owed with `approval` (FORMAT.md, Approval responses)
        const saved = await this.repo.updateWhere('amounts_owed', { id, approval_request_id: null }, { write_off_amount: amount, write_off_reason: body.reason.trim(), approval_request_id: req.id, note: `Write-off of ${fmt(amount, owed.currency)} waiting for approval (${req.ref})` });
        if (saved) await this.core.audit({ action: 'finance.amount_owed.write_off_requested', actionLabel: 'Requested a write-off', category: 'financial', target: { type: 'amount_owed', id, sellerId: owed.seller_id }, reason: body.reason, approvalRequestId: req.id }, by);
        return this.owedView(id);
      }
    }
    await this.settleNow(id, body.method, amount, body.reason, by);
    return this.owedView(id);
  }

  async settleNow(id: string, method: 'seller_paid' | 'offset' | 'written_off', amount: number, reason: string, by: By) {
    const out = new Outbox();
    const before = await this.repo.transaction(async (tx) => {
      const o = await tx.get('amounts_owed', id, { forUpdate: true });
      if (!o || o.status !== 'open') return null;
      const take = Math.min(amount, o.remaining);
      if (method !== 'offset') await this.core.post(tx, o.seller_id, [{ key: `owed:${o.id}:${method}:${o.remaining}`, type: 'owed_offset', amount: take, bucket: 'available', ref: { kind: 'seller', id: o.seller_id }, description: method === 'seller_paid' ? `Payment received from the seller: ${reason}` : `Written off: ${reason}`, recordedBy: by.actor }], out);
      // a seller's debt written off is a marketplace (platform) loss, never Official Store trading
      if (method === 'written_off') await this.parts.ledger.platformCost(tx, `write_off:${o.id}:${o.remaining}`, { at: this.now(), kind: 'write_off', amount: take, order_id: null, ref_kind: 'amount_owed', ref_id: o.id });
      const remaining = o.remaining - take;
      const event = remaining > 0 ? 'offset' : method === 'written_off' ? 'writeOff' : 'settle';
      const fresh = (await tx.get('amounts_owed', id))!;
      const clearPending = method === 'written_off' ? { write_off_amount: null, write_off_reason: null, approval_request_id: null } : {};
      await tx.update('amounts_owed', id, { remaining: Math.min(remaining, fresh.remaining), status: this.core.step(amountOwedMachine, o.status, event), note: `${method.replace('_', ' ')}: ${reason}`, ...clearPending });
      return o;
    });
    this.core.flush(out, by);
    if (before) await this.core.audit({ action: `finance.amount_owed.${method}`, actionLabel: method === 'written_off' ? 'Wrote off an amount owed' : 'Recorded a settlement of an amount owed', category: 'financial', target: { type: 'amount_owed', id, sellerId: before.seller_id, screen: 'admin/seller' }, before: { remaining: before.remaining }, after: { settled: amount, method }, reason }, by);
  }

  /** Job finance.negative-balance.age: negative balances older than negativeBalanceOwedAfterDays become amounts owed */
  async ageNegativeBalances() {
    const days = await this.core.num('negativeBalanceOwedAfterDays', 30);
    const cutoff = new Date(this.now().getTime() - days * DAY);
    const accounts = await this.repo.find('seller_accounts', { negative_since: { op: '<=', value: cutoff }, available: { op: '<', value: 0 } }, { limit: 500 });
    for (const a of accounts) {
      const owedNow = -a.available;
      const open = await this.repo.findOne('amounts_owed', { seller_id: a.seller_id, status: 'open' });
      if (open) {
        if (open.remaining < owedNow) await this.repo.update('amounts_owed', open.id, { amount: open.amount + (owedNow - open.remaining), remaining: owedNow });
        continue;
      }
      const causes = await this.repo.find('ledger_entries', { seller_id: a.seller_id, type: ['refund_after_payout', 'chargeback', 'adjustment', 'ad_charge', 'label_charge', 'refund'], amount: { op: '<', value: 0 }, at: { op: '>=', value: new Date(a.negative_since!.getTime() - 60 * DAY) } }, { orderBy: [['at', 'desc']], limit: 10 });
      const id = detId(`owed:${a.seller_id}:${a.negative_since!.toISOString()}`);
      const today = this.core.today();
      const row = { id, seller_id: a.seller_id, amount: owedNow, remaining: owedNow, currency: a.currency, since: today, due_by: addDays(today, 30), status: amountOwedMachine.initial, origin: causes.map((c) => ({ kind: c.ref_kind, id: c.ref_id, ref: c.ref_label })) as never, note: `Negative balance not covered within ${days} days`, write_off_amount: null, write_off_reason: null, approval_request_id: null };
      if (await this.repo.insertIfAbsent('amounts_owed', row)) this.core.publish('finance.amount_owed.created', { amountOwedId: id, sellerId: a.seller_id, amount: this.money(owedNow), dueBy: row.due_by });
    }
  }

  /* ---------------------------------------------------------------- approvals finished */

  async onApprovalDecided(e: EventPayload<'access.approval.decided'>) {
    const by: By = { actor: e.decidedBy ?? SYSTEM };
    const approved = e.outcome === 'approved';
    if (e.actionKey === 'finance.holds.place') {
      const h = isUuid(e.target.id) ? await this.repo.get('holds', e.target.id) : undefined;
      if (!h || h.approval_request_id !== e.requestId || h.status !== 'active') return;
      if (!approved) {
        await this.repo.update('holds', h.id, { status: this.core.step(holdMachine, h.status, 'release'), released_at: this.now(), release_reason: `Hold not approved (${e.outcome})${e.reason ? `: ${e.reason}` : ''}`, approval_request_id: null });
        return;
      }
      const out = new Outbox();
      await this.repo.transaction(async (tx) => {
        await tx.update('holds', h.id, { approval_request_id: null });
        await this.core.post(tx, h.seller_id, this.holdEntries(h), out);
      });
      this.core.flush(out, by);
      this.core.publish('finance.hold.placed', { holdId: h.id, sellerId: h.seller_id, amount: { amount: h.amount, currency: h.currency }, reasonCode: h.reason_code, reason: h.reason, reviewDate: h.review_date, trustReportId: h.trust_report_id }, by);
      await this.core.audit({ action: 'finance.hold.place', actionLabel: 'Hold approved and placed', category: 'financial', target: { type: 'hold', id: h.id, label: h.reason, sellerId: h.seller_id }, approvalRequestId: e.requestId, visibleToSeller: true }, by);
      return;
    }
    if (e.actionKey === HOLD_DECISION) {
      const h = isUuid(e.target.id) ? await this.repo.get('holds', e.target.id) : undefined;
      if (!h || h.approval_request_id !== e.requestId) return;
      if (!approved) return void (await this.repo.update('holds', h.id, { approval_request_id: null }));
      const req = await this.ctx.use('access').getApproval(e.requestId);
      const d = (req?.details ?? {}) as { op?: 'release' | 'apply'; amount?: number; reason?: string };
      await this.apply(h.id, d.op === 'apply' ? 'apply' : 'release', Number(d.amount ?? e.amount?.amount ?? h.amount - h.released_amount), d.reason ?? e.reason ?? 'Approved', by);
      return;
    }
    if (e.actionKey === 'finance.adjustments.record') {
      const a = isUuid(e.target.id) ? await this.repo.get('adjustments', e.target.id) : undefined;
      if (!a || a.status !== 'pending_approval' || a.approval_request_id !== e.requestId) return;
      const out = new Outbox();
      await this.repo.transaction(async (tx) => {
        await tx.update('adjustments', a.id, { status: this.core.step(adjustmentMachine, a.status, approved ? 'approve' : 'reject') });
        if (approved) await this.core.post(tx, a.seller_id, [this.adjustmentEntry(a)], out);
      });
      this.core.flush(out, by);
      if (approved) this.core.publish('finance.adjustment.recorded', { adjustmentId: a.id, sellerId: a.seller_id, direction: a.direction, amount: { amount: a.amount, currency: a.currency }, reasonCode: a.reason_code }, by);
      await this.core.audit({ action: approved ? 'finance.adjustment.approve' : 'finance.adjustment.reject', actionLabel: approved ? 'Adjustment approved and recorded' : `Adjustment not approved (${e.outcome})`, category: 'financial', target: { type: 'adjustment', id: a.id, ref: a.ref, sellerId: a.seller_id }, reason: e.reason ?? null, approvalRequestId: e.requestId, visibleToSeller: approved }, by);
      return;
    }
    if (e.actionKey === 'finance.writeoffs.approve') {
      const o = isUuid(e.target.id) ? await this.repo.get('amounts_owed', e.target.id) : undefined;
      // the pending write-off is on the record; one requested before pass 4 (no approval_request_id) keeps its details in access
      if (!o || (o.approval_request_id && o.approval_request_id !== e.requestId)) return;
      const clear = { write_off_amount: null, write_off_reason: null, approval_request_id: null };
      if (o.status !== 'open') return void (o.approval_request_id && (await this.repo.update('amounts_owed', o.id, clear)));
      if (!approved) return void (await this.repo.update('amounts_owed', o.id, { ...clear, note: `Write-off not approved (${e.outcome})${e.reason ? `: ${e.reason}` : ''}` }));
      let amount = o.write_off_amount;
      let reason = o.write_off_reason;
      if (amount === null) {
        const req = await this.ctx.use('access').getApproval(e.requestId);
        const d = (req?.details ?? {}) as { amount?: number; reason?: string };
        amount = Number(d.amount ?? e.amount?.amount ?? o.remaining);
        reason = d.reason ?? null;
      }
      await this.settleNow(o.id, 'written_off', amount, reason ?? 'Write-off approved', by);
    }
  }

  /* ---------------------------------------------------------------- consumers */

  async onChargebackOpened(e: EventPayload<'payments.chargeback.opened'>) {
    if (!e.sellerId) return; // Official Store: a loss is recorded in company trading if it is lost
    const review = e.evidenceDueAt ? this.core.today(new Date(e.evidenceDueAt)) : addDays(this.core.today(), 30);
    await this.place(
      { id: detId(`chargeback_hold:${e.disputeId}`), system: true, sellerId: e.sellerId, amount: e.amount, reasonCode: 'chargeback', reason: `Payment dispute ${e.ref} opened by the customer's bank`, reviewDate: review < this.core.today() ? this.core.today() : review, reference: { kind: 'chargeback', id: e.disputeId, ref: e.ref } },
      { actor: SYSTEM },
    );
    const lots = await this.repo.find('earnings_lots', { order_id: e.orderId, seller_id: e.sellerId });
    if (lots.length) await this.repo.updateWhere('fee_charges', { order_item_id: lots.map((l) => l.order_item_id), status: 'charged' }, { status: 'kept_disputed' });
  }

  async onChargebackDecided(e: EventPayload<'payments.chargeback.decided'>) {
    if (!e.sellerId) {
      if (e.outcome === 'lost') await this.repo.transaction((tx) => this.parts.ledger.trading(tx, `chargeback:${e.disputeId}`, { at: this.now(), kind: 'chargeback_loss', amount: e.amount.amount, order_id: e.orderId, order_item_id: null, variant_id: null, ref_kind: 'chargeback', ref_id: e.disputeId }));
      return;
    }
    const by: By = { actor: SYSTEM };
    const hold = await this.repo.get('holds', detId(`chargeback_hold:${e.disputeId}`));
    const lots = await this.repo.find('earnings_lots', { order_id: e.orderId, seller_id: e.sellerId });
    const itemIds = lots.map((l) => l.order_item_id);
    if (e.outcome === 'won') {
      if (hold?.status === 'active') await this.apply(hold.id, 'release', hold.amount - hold.released_amount, 'Payment dispute won', by);
      if (itemIds.length) await this.repo.updateWhere('fee_charges', { order_item_id: itemIds, status: 'kept_disputed' }, { status: 'charged' });
      return;
    }
    if (hold?.status === 'active') await this.apply(hold.id, 'apply', e.amount.amount, 'Payment dispute lost', by);
    else if (!hold) {
      const out = new Outbox();
      await this.repo.transaction((tx) => this.core.post(tx, e.sellerId!, [{ key: `chargeback:${e.disputeId}`, type: 'chargeback', amount: -e.amount.amount, bucket: 'available', ref: { kind: 'chargeback', id: e.disputeId }, description: 'Payment dispute lost' }], out));
      this.core.flush(out);
    }
    // fee treatment for disputes
    const rule = await this.core.ruleModel(await this.core.activeRule());
    if (rule.treatment.paymentDisputes === 'fee_returned' && lots.length) {
      const out = new Outbox();
      await this.repo.transaction(async (tx) => {
        for (const l of lots) {
          const c = await tx.findOne('fee_charges', { order_item_id: l.order_item_id });
          if (!c || c.fee - c.refunded_fee <= 0) continue;
          const back = c.fee - c.refunded_fee;
          const posted = await this.core.post(tx, l.seller_id, [{ key: `chargeback_fee:${e.disputeId}:${l.order_item_id}`, type: 'fee_refund', amount: back, bucket: l.state === 'pending' ? 'pending' : 'available', ref: { kind: 'chargeback', id: e.disputeId }, description: 'Fee returned on a lost payment dispute', lotId: l.id }], out);
          if (posted.length) await tx.update('fee_charges', c.id, { refunded_fee: c.fee, status: 'reversed' });
        }
      });
      this.core.flush(out);
    } else if (itemIds.length) await this.repo.updateWhere('fee_charges', { order_item_id: itemIds, status: 'kept_disputed' }, { status: 'charged' });
  }

  async onCaseDecided(e: EventPayload<'support.case.decided'>) {
    if (!e.final) return;
    const holds = await this.repo.find('holds', { ref_kind: 'case', ref_id: e.caseId, status: 'active' });
    const by: By = { actor: SYSTEM };
    for (const h of holds) {
      if (!(await this.posted(this.repo, h.id))) continue;
      const charged = e.remedies.filter((r) => r.chargedTo === 'seller' && r.kind === 'goodwill_credit' && r.amount && r.status !== 'cancelled').reduce((s, r) => s + (r.amount?.amount ?? 0), 0);
      const remaining = h.amount - h.released_amount;
      if (charged > 0 && h.seller_id === e.sellerId) await this.apply(h.id, 'apply', Math.min(charged, remaining), `Case ${e.ref} decided (${e.outcome.replace(/_/g, ' ')}): goodwill credit charged to the seller`, by);
      else await this.apply(h.id, 'release', remaining, `Case ${e.ref} decided (${e.outcome.replace(/_/g, ' ')})`, by);
    }
  }

  async onSellerApproved(e: EventPayload<'sellers.seller.approved'>) {
    if (!isUuid(e.sellerId)) return;
    const out = new Outbox();
    await this.repo.transaction((tx) => tx.lockAccount(e.sellerId, this.core.currency(), this.now()).then(() => undefined));
    this.core.flush(out);
    // the new-seller period lives on the account (set once: a later approval event keeps the first period)
    const periodDays = await this.core.num('newSellerPeriodDays', 30);
    const extra = e.recommendedHoldDays ?? (await this.core.num('newSellerHoldDays', 14));
    if (extra > 0 && periodDays > 0) {
      await this.repo.updateWhere('seller_accounts', { seller_id: e.sellerId, new_seller_until: null }, { new_seller_until: addDays(this.core.today(), periodDays), new_seller_extra_days: extra });
    }
    // the seller's first statement is open from approval (statements are never created on read)
    await this.parts.statements.openStatement(e.sellerId);
  }

  async onSellerSuspended(e: EventPayload<'sellers.seller.suspended'>) {
    if (!isUuid(e.sellerId)) return;
    await this.repo.updateWhere('seller_accounts', { seller_id: e.sellerId }, { payouts_blocked_reason: `Account suspended: ${e.reason}` });
    const acct = await this.repo.findOne('seller_accounts', { seller_id: e.sellerId });
    if (acct && acct.available > 0) {
      await this.place({ id: detId(`restriction_hold:${e.suspensionId}`), system: true, sellerId: e.sellerId, amount: this.money(acct.available), reasonCode: 'restriction', reason: `Account suspended: ${e.reason}`, reviewDate: e.reviewDate < this.core.today() ? this.core.today() : e.reviewDate, reference: { kind: 'seller', id: e.sellerId, ref: null }, trustReportId: e.trustReportId ?? null }, { actor: SYSTEM });
    }
    await this.parts.payouts.holdPendingPayouts(e.sellerId, `Account suspended: ${e.reason}`);
  }

  /**
   * sellers.seller.reinstated after a suspension: what the suspension stopped goes again. The payout block it set is
   * cleared, its hold on the available balance is released and the payouts it held go back to pending.
   */
  async onSellerReinstated(e: EventPayload<'sellers.seller.reinstated'>) {
    if (!isUuid(e.sellerId) || e.from !== 'suspended') return;
    const suspended = (r: string | null | undefined) => Boolean(r?.startsWith('Account suspended'));
    const acct = await this.repo.findOne('seller_accounts', { seller_id: e.sellerId });
    if (suspended(acct?.payouts_blocked_reason)) await this.repo.updateWhere('seller_accounts', { seller_id: e.sellerId }, { payouts_blocked_reason: null });
    const hold = e.endedSuspensionId ? await this.repo.get('holds', detId(`restriction_hold:${e.endedSuspensionId}`)) : undefined;
    if (hold?.status === 'active') await this.decide(hold.id, 'release', { reason: 'Suspension ended: account reinstated' }, { actor: SYSTEM }, { system: true });
    await this.parts.payouts.unholdPayouts(e.sellerId, suspended);
  }

  /** Job finance.holds.review-due: holds at their review date go to Finance's queue */
  async reviewDue() {
    const today = this.core.today();
    const due = await this.repo.find('holds', { status: 'active', review_date: { op: '<=', value: today } }, { orderBy: [['review_date', 'asc']], limit: 500 });
    const names = await this.core.sellerInfo(due.map((h) => h.seller_id));
    for (const h of due) {
      await this.core.optional('workqueues', (w) =>
        w.raise({
          sourceModule: 'finance',
          queueKey: 'finance.daily_checks',
          kind: 'hold_review',
          title: `Review hold of ${fmt(h.amount - h.released_amount, h.currency)} on ${names.get(h.seller_id)?.name ?? 'a seller'}`,
          summary: `${h.reason} · review date ${h.review_date}`,
          subject: { type: 'seller', id: h.seller_id, label: names.get(h.seller_id)?.name ?? null },
          sellerId: h.seller_id,
          sellerName: names.get(h.seller_id)?.name ?? null,
          amount: { amount: h.amount - h.released_amount, currency: h.currency },
          priority: h.review_date < today ? 'high' : 'normal',
          dedupeKey: `finance.hold_review:${h.id}`,
        }),
      );
    }
  }
}
