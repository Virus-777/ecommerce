/**
 * The daily reconciliation of the ownership ledger with inventory at the service location (inventory.getLevels),
 * stock differences (one per SKU and day, with a fulfillment.reconciliation work item) and the staff decision on
 * each (decision D11): adjust the ledger to inventory, reimburse the seller (approval action
 * fulfillment-service.reimbursements.approve) or leave it. Also the ledger following inventory's own adjustments
 * of seller units at the service location (inventory.adjustment.recorded, serviceManaged).
 */
import { format as formatMoney } from '../../../kernel/lib/money.js';
import { AppError } from '../../../kernel/errors/index.js';
import type { EventPayload } from '../../../kernel/events/index.js';
import { isUuid, newId } from '../../../kernel/lib/ids.js';
import type { PageRequest } from '../../../kernel/lib/pagination.js';
import type * as common from '../../../spec/common.js';
import type { StockDifference } from '../../../spec/fulfillment-service.js';
import type { StockQuantities } from '../../../spec/inventory.js';
import { stockDifferenceMachine } from '../domain/state-machines.js';
import { actorText, LEDGER_GROUP, ledgerGroupOf, ledgerLevels, LEVEL_KEYS, levelsDiffer, SYSTEM } from '../domain/rules.js';
import type { Levels, SkuRec, StockDifferenceRec } from '../ports.js';
import { invalid, notFound, Part, type By } from './core.js';
import { REIMBURSE_ACTION } from './inbound.js';

export const DIFFERENCE_TARGET = 'stock_difference';
type Decision = 'adjust_ledger' | 'reimburse' | 'no_change';

const levelsOf = (q: StockQuantities | undefined): Levels => ({ incoming: q?.incoming ?? 0, available: q?.available ?? 0, reserved: q?.reserved ?? 0, damagedHeld: q?.damagedHeld ?? 0, returned: q?.returned ?? 0 });
const fmt = (m: common.Money) => formatMoney(m);

export class DifferencesPart extends Part {
  /* ---------------------------------------------------------------- reconcile job */

  /**
   * Job fulfillment-service.reconcile: per seller SKU, the ledger groups mapped to inventory's against
   * inventory.getLevels at the service location; a SKU that differs gets the day's stock_differences row (refreshed
   * while open) and a work item.
   */
  async reconcile(): Promise<{ checked: number; differences: StockDifferenceRec[] }> {
    const location = await this.core.serviceLocation();
    if (!location) return { checked: 0, differences: [] };
    const day = this.core.today();
    const skus = (await this.repo.find('sku_enrollments', { state: ['approved', 'active', 'inactive'] }, { limit: 50_000 })).filter((s) => s.inventory_item_id);
    const out: StockDifferenceRec[] = [];
    for (let i = 0; i < skus.length; i += 200) {
      const batch = skus.slice(i, i + 200);
      const [balances, levels] = await Promise.all([this.repo.balances(batch.map((s) => s.id)), this.ctx.use('inventory').getLevels(batch.map((s) => s.inventory_item_id!), location.locationId)]);
      for (const s of batch) {
        const ledger = ledgerLevels(balances, s.id);
        const inventory = levelsOf(levels[s.inventory_item_id!]);
        if (!levelsDiffer(ledger, inventory)) continue;
        const row = await this.record(s, day, ledger, inventory);
        if (row) out.push(row);
      }
    }
    if (out.length) this.ctx.log.warn({ count: out.length }, 'fulfillment-service: ownership ledger and inventory differ');
    return { checked: skus.length, differences: out };
  }

  private async record(s: SkuRec, day: string, ledger: Levels, inventory: Levels): Promise<StockDifferenceRec | null> {
    const row: StockDifferenceRec = { id: newId(), seller_id: s.seller_id, sku_enrollment_id: s.id, day, ledger, inventory, state: 'open', decision: null, reason: null, amount: null, approval_request_id: null, decided_by: null, decided_at: null };
    let saved: StockDifferenceRec | null = row;
    if (!(await this.repo.insertIfAbsent('stock_differences', row))) {
      const existing = await this.repo.findOne('stock_differences', { sku_enrollment_id: s.id, day });
      saved = existing?.state === 'open' && !existing.approval_request_id ? await this.repo.update('stock_differences', existing.id, { ledger, inventory }) : null;
    }
    if (!saved) return null;
    const names = await this.core.sellerNames([s.seller_id]);
    const gaps = LEVEL_KEYS.filter((k) => ledger[k] !== inventory[k]).map((k) => `${k} ledger ${ledger[k]} / inventory ${inventory[k]}`);
    await this.core.raise({
      queueKey: 'fulfillment.reconciliation',
      kind: 'manual_task',
      title: `Seller stock difference: ${s.sku}`,
      summary: `${names.get(s.seller_id) ?? 'Seller'} · ${gaps.join('; ')}`,
      subject: { type: 'stock_item', id: s.inventory_item_id!, ref: s.sku, label: s.sku },
      sellerId: s.seller_id,
      dedupeKey: `fs_stock_difference:${s.id}`,
    });
    return saved;
  }

  /* ---------------------------------------------------------------- staff */

  async list(q: { state?: 'open' | 'resolved'; sellerId?: string; day?: string }, page: PageRequest) {
    const where: Record<string, unknown> = {};
    if (q.state) where.state = q.state;
    if (q.sellerId) where.seller_id = q.sellerId;
    if (q.day) where.day = q.day;
    const res = await this.repo.page('stock_differences', where, page, { order: { column: 'id', direction: 'desc' } });
    return { ...res, items: await this.parts.views.differences(res.items) };
  }

  async resolve(id: string, body: { decision: Decision; amount?: common.Money | null; reason: string }, by: By): Promise<StockDifference> {
    const reason = body.reason?.trim();
    if (!reason) throw invalid([{ path: 'reason', message: 'Give the reason for the decision' }]);
    if (!['adjust_ledger', 'reimburse', 'no_change'].includes(body.decision)) throw invalid([{ path: 'decision', message: 'Choose adjust_ledger, reimburse or no_change' }]);
    const before = isUuid(id) ? await this.repo.get('stock_differences', id) : undefined;
    if (!before) throw notFound('Stock difference');
    stockDifferenceMachine.next(before.state, 'resolve');
    if (before.approval_request_id) throw new AppError('ILLEGAL_TRANSITION', 'A reimbursement for this difference is waiting for approval', { machine: 'Stock difference', from: before.state, event: 'resolve', approvalRequestId: before.approval_request_id });
    const sku = (await this.repo.get('sku_enrollments', before.sku_enrollment_id))!;
    let approval: common.ApprovalInfo | null = null;
    if (body.decision === 'reimburse') {
      if (!body.amount || !Number.isSafeInteger(body.amount.amount) || body.amount.amount <= 0) throw invalid([{ path: 'amount', message: 'Enter the amount to reimburse' }]);
      const access = this.ctx.tryUse('access');
      if (access) {
        const principal = this.core.principalOf(by);
        const check = await access.check(principal, REIMBURSE_ACTION, { money: body.amount });
        if (check.decision === 'denied') throw new AppError('FORBIDDEN', check.reason || 'You cannot approve reimbursements');
        if (check.decision === 'approval_required') {
          const req = await access.requestApproval({
            action: REIMBURSE_ACTION,
            target: { type: DIFFERENCE_TARGET, id, ref: sku.sku, label: `Stock difference ${sku.sku} (${before.day})`, sellerId: before.seller_id, screen: 'ops/inventory' },
            amount: body.amount,
            summary: `Reimburse the seller ${fmt(body.amount)} for units of ${sku.sku} lost or damaged at our warehouse`,
            details: { stockDifferenceId: id, day: before.day, ledger: before.ledger, inventory: before.inventory },
            reason,
            requestedBy: principal,
          });
          approval = { required: true, reason: check.reason || 'Above your reimbursement limit', approvalRequestId: req.id, approvers: (check.eligibleApproverRoles ?? []).map((r) => r.name) };
          const pending = await this.repo.update('stock_differences', id, { decision: 'reimburse', amount: body.amount.amount, reason, approval_request_id: req.id });
          await this.audit(before, pending, by, req.id);
          return (await this.parts.views.differences([pending], new Map([[id, approval]])))[0]!;
        }
      }
    }
    const after = await this.apply(id, body.decision, { amount: body.amount ?? null, reason }, by);
    await this.audit(before, after, by, null);
    return (await this.parts.views.differences([after]))[0]!;
  }

  /** Applies a decision (adjust_ledger: the ledger moves to inventory's current levels; reimburse: the credit accrues) */
  private async apply(id: string, decision: Decision, o: { amount: common.Money | null; reason: string; claim?: string }, by: By): Promise<StockDifferenceRec> {
    const before = (await this.repo.get('stock_differences', id))!;
    const sku = (await this.repo.get('sku_enrollments', before.sku_enrollment_id))!;
    let inventory: Levels | null = null;
    if (decision === 'adjust_ledger') {
      const location = await this.core.requireLocation();
      inventory = levelsOf((await this.ctx.use('inventory').getLevels([sku.inventory_item_id!], location.locationId))[sku.inventory_item_id!]);
    }
    const after = await this.repo.transaction(async (tx) => {
      if (o.claim && !(await tx.claim(o.claim))) return null;
      const locked = (await tx.get('stock_differences', id, { forUpdate: true }))!;
      if (locked.state !== 'open') return null;
      if (decision === 'adjust_ledger' && inventory) {
        await tx.lockSkus([sku.id]);
        const ledger = ledgerLevels(await tx.balances([sku.id]), sku.id);
        for (const k of LEVEL_KEYS) {
          const delta = inventory[k] - ledger[k];
          if (!delta) continue;
          const group = LEDGER_GROUP[k];
          await this.core.move(tx, { sellerId: sku.seller_id, skuEnrollmentId: sku.id, movement: 'adjusted', quantity: Math.abs(delta), from: delta > 0 ? null : group, to: delta > 0 ? group : null, reference: `stock-difference:${id}`, reason: `Reconciliation with inventory: ${o.reason}`, actor: by.actor });
        }
      }
      if (decision === 'reimburse') {
        await this.core.accrueReimbursement(tx, { sellerId: sku.seller_id, amount: o.amount!, reference: sku.sku, reason: o.reason, key: `reimbursement:stock-difference:${id}` });
      }
      return tx.update('stock_differences', id, { state: stockDifferenceMachine.next('open', 'resolve'), decision, reason: o.reason, amount: decision === 'reimburse' ? o.amount!.amount : locked.amount, approval_request_id: null, decided_by: actorText(by.actor), decided_at: this.now() });
    });
    if (!after) return (await this.repo.get('stock_differences', id))!;
    if (!(await this.repo.count('stock_differences', { sku_enrollment_id: sku.id, state: 'open' }))) {
      await this.core.resolveWork(`fs_stock_difference:${sku.id}`, `${decision.replace('_', ' ')}: ${o.reason}`, by.actor);
    }
    return after;
  }

  /** access.approval.decided for a stock-difference reimbursement (claimed once per request) */
  async onReimbursementDecided(e: EventPayload<'access.approval.decided'>): Promise<void> {
    if (!isUuid(e.target.id)) return;
    const row = await this.repo.get('stock_differences', e.target.id);
    if (!row || row.state !== 'open' || row.approval_request_id !== e.requestId) return;
    if (e.outcome !== 'approved') {
      // not approved: the difference stays open for another decision
      await this.repo.update('stock_differences', row.id, { decision: null, amount: null, approval_request_id: null });
      return;
    }
    const amount = e.amount ?? (row.amount ? { amount: row.amount, currency: 'USD' } : null);
    if (!amount) return;
    await this.apply(row.id, 'reimburse', { amount, reason: row.reason || 'Approved reimbursement', claim: `approval-decided:${e.requestId}` }, { actor: e.decidedBy ?? SYSTEM });
  }

  private async audit(before: StockDifferenceRec, after: StockDifferenceRec, by: By, approvalRequestId: string | null) {
    const sku = await this.repo.get('sku_enrollments', after.sku_enrollment_id);
    await this.core.audit(
      {
        action: 'fulfillment-service.stock_difference.resolve',
        actionLabel: approvalRequestId ? 'Sent a stock difference reimbursement for approval' : 'Resolved a seller stock difference',
        category: after.decision === 'reimburse' ? 'financial' : 'inventory',
        target: { type: 'stock_difference', id: after.id, ref: sku?.sku ?? null, label: `Stock difference ${sku?.sku ?? ''} (${after.day})`.trim(), sellerId: after.seller_id, screen: 'ops/inventory' },
        before: { state: before.state, ledger: before.ledger, inventory: before.inventory },
        after: { state: after.state, decision: after.decision, amount: after.amount },
        reason: after.reason,
        approvalRequestId,
      },
      by,
    );
  }

  /* ---------------------------------------------------------------- inventory's own adjustments */

  /** inventory.adjustment.recorded (serviceManaged): the ledger follows with an adjusted movement (claimed per movementId) */
  async onAdjustmentRecorded(e: EventPayload<'inventory.adjustment.recorded'>): Promise<void> {
    if (!e.serviceManaged || !isUuid(e.stockItemId) || !(e.quantity > 0)) return;
    const from = ledgerGroupOf(e.fromGroup);
    const to = ledgerGroupOf(e.toGroup);
    if (from === undefined || to === undefined || from === to) return;
    const sku = await this.repo.findOne('sku_enrollments', { inventory_item_id: e.stockItemId });
    if (!sku) return;
    await this.repo.transaction(async (tx) => {
      if (!(await tx.claim(`adjustment-recorded:${e.movementId}`))) return;
      await this.core.move(tx, { sellerId: sku.seller_id, skuEnrollmentId: sku.id, movement: 'adjusted', quantity: e.quantity, from, to, reference: e.movementId, reason: e.reasonCode, actor: e.actor ?? SYSTEM });
    });
  }
}
