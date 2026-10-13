/** Adjustments with reason codes and second review above the role's limit (access approvals), and held stock review. */
import { AppError, isAppError } from '../../../kernel/errors/index.js';
import { inventoryError } from '../errors.js';
import type { EventPayload } from '../../../kernel/events/index.js';
import { newId } from '../../../kernel/lib/ids.js';
import { money } from '../../../kernel/lib/money.js';
import type { PageRequest } from '../../../kernel/lib/pagination.js';
import type * as common from '../../../spec/common.js';
import type { Adjustment, AdjustmentRequest } from '../../../spec/inventory.js';
import { adjustmentMachine } from '../domain/state-machines.js';
import { addDays, applyMove, GROUP_INFO, FIELD, reasonLabel, type GroupOrOutside } from '../domain/rules.js';
import { actorOf, actorText, isServiceItem, SYSTEM_ACTOR, unitCostOf } from '../mappers.js';
import type { Row } from '../ports.js';
import { levelQty } from '../stock-tx.js';
import { DEFAULT_HOLD_REVIEW_DAYS, invalid, notFound, type By, type StaffBy, type Core } from './core.js';

const APPROVAL_ACTION = 'inventory.adjustments.apply';

export class Adjustments {
  constructor(private readonly core: Core) {}

  /**
   * Company stock, and seller items at their service location (Fulfilled by Marketly: units found, lost or damaged
   * in our warehouse); the latter publish inventory.adjustment.recorded with serviceManaged true.
   */
  async createAdjustment(body: AdjustmentRequest, by: StaffBy): Promise<Adjustment> {
    const item = await this.core.item(body.stockItemId);
    if (item.owner_type !== 'official' && !isServiceItem(item)) await this.core.officialItem(item.id); // the seller's own stock: refused
    return this.requestAdjustment(item, { ...body, locationId: body.locationId ?? null }, by);
  }

  /** A seller item's units at a company location are in Marketly's custody: the fulfillment service's ledger follows them */
  async #serviceManaged(item: Row<'stock_items'>, locationId: string): Promise<boolean> {
    if (item.owner_type !== 'seller') return false;
    if (item.service_location_id === locationId) return true;
    return (await this.core.repo.get('locations', locationId))?.owner_type === 'official';
  }

  async requestAdjustment(
    item: Row<'stock_items'>,
    body: { locationId: string | null; fromGroup: GroupOrOutside; toGroup: GroupOrOutside; quantity: number; reasonCode: string; note?: string | null; reviewDate?: string | null; secondReviewerId?: string | null },
    by: StaffBy,
  ): Promise<Adjustment> {
    if (item.archived) throw inventoryError('STOCK_ITEM_ARCHIVED', 'This stock item is archived');
    if ((body.fromGroup as string) === 'reserved' || (body.toGroup as string) === 'reserved') throw inventoryError('RESERVED_NOT_ADJUSTABLE', 'Reserved units belong to orders; use the reservation or a discrepancy');
    if (body.fromGroup === body.toGroup) throw invalid('toGroup', 'Choose two different stock groups');
    if (!Number.isInteger(body.quantity) || body.quantity <= 0) throw invalid('quantity', 'Quantity must be at least 1');
    if (body.toGroup === 'damaged_held' && !body.reviewDate) throw inventoryError('REVIEW_DATE_REQUIRED', 'Moving units into Damaged or held needs a review date');
    const levels = await this.core.repo.levels([item.id]);
    const service = isServiceItem(item);
    const locationId = body.locationId ?? (service ? item.service_location_id : null) ?? levels[0]?.location_id ?? (await this.core.officialDefault())?.id;
    const location = locationId ? await this.core.repo.get('locations', locationId) : undefined;
    if (!location || location.owner_type !== 'official') throw invalid('locationId', 'Choose a company stock location');
    // seller stock Fulfilled by Marketly is adjusted only where Marketly holds it
    if (item.owner_type === 'seller' && location.id !== item.service_location_id) throw invalid('locationId', 'Seller stock can be adjusted only at its Fulfilled by Marketly location');
    const current = levelQty(levels.find((l) => l.location_id === location.id));
    if (body.fromGroup !== 'outside' && current[FIELD[body.fromGroup]] < body.quantity) {
      const have = current[FIELD[body.fromGroup]];
      throw inventoryError('GROUP_QUANTITY_EXCEEDED', `Only ${have} unit${have === 1 ? '' : 's'} in ${GROUP_INFO[body.fromGroup].label}`, { group: body.fromGroup, quantity: have });
    }
    const unitCost = unitCostOf(item);
    const value = unitCost ? money(unitCost.amount * body.quantity, unitCost.currency) : null;
    const access = this.core.ctx.tryUse('access');
    const check = access ? await access.check(by.principal, APPROVAL_ACTION, { number: body.quantity, ...(value ? { money: value } : {}) }) : null;
    if (check?.decision === 'denied') throw new AppError('FORBIDDEN', check.reason || 'Your role cannot adjust company stock');
    const id = newId();
    const row = {
      id,
      stock_item_id: item.id,
      location_id: location.id,
      from_group: body.fromGroup,
      to_group: body.toGroup,
      quantity: body.quantity,
      reason_code: body.reasonCode,
      note: body.note ?? null,
      review_date: body.reviewDate ?? null,
      approval_request_id: null as string | null,
      requested_by: actorText(by.actor),
      decided_by: null,
      movement_id: null,
      created_at: this.core.now(),
      applied_at: null,
    };
    const summary = `${item.sku}: ${body.quantity} unit${body.quantity === 1 ? '' : 's'} ${body.fromGroup.replace('_', ' ')} → ${body.toGroup.replace('_', ' ')}`;
    const target = { type: 'stock_adjustment', id, ref: item.sku, label: summary };

    if (check?.decision === 'approval_required') {
      const request = await access!.requestApproval({
        action: APPROVAL_ACTION,
        target: { ...target, screen: 'ops/inventory' },
        amount: value,
        quantity: body.quantity,
        summary,
        details: { stockItemId: item.id, sku: item.sku, label: item.label, locationId: location.id, fromGroup: body.fromGroup, toGroup: body.toGroup, quantity: body.quantity, before: current, after: applyMove(current, body.fromGroup, body.toGroup, body.quantity), valueAtCost: value },
        reason: body.note?.trim() || reasonLabel(body.reasonCode),
        requestedBy: by.principal,
        nominatedReviewerId: body.secondReviewerId ?? null,
      });
      let saved: Row<'adjustments'>;
      try {
        saved = (await this.core.repo.insert('adjustments', { ...row, state: adjustmentMachine.next('requested', 'requestReview'), approval_request_id: request.id }))!;
      } catch (err) {
        await access!.cancelApproval(request.id, by.actor, 'The adjustment could not be saved').catch((e) => this.core.ctx.log.warn({ err: e }, 'inventory: could not withdraw approval request'));
        throw err;
      }
      const api = (await this.core.adjustmentsApi([saved]))[0]!;
      await this.core.audit({ action: 'inventory.adjustment.request', actionLabel: 'Sent stock adjustment for second review', category: 'inventory', target: { ...target, screen: 'ops/inventory' }, after: api, reason: body.note ?? reasonLabel(body.reasonCode), approvalRequestId: request.id }, by);
      return api;
    }

    const applied = await this.core.stock(
      'adjustment',
      async (st) => {
        const m = await st.move(item.id, location.id, body.fromGroup, body.toGroup, body.quantity, {
          reason: body.reasonCode,
          note: body.note ?? null,
          ref: { kind: 'adjustment', id, label: `Adjustment ${reasonLabel(body.reasonCode)}` },
          actor: by.actor,
          ...(body.toGroup === 'damaged_held' ? { hold: { reasonCode: body.reasonCode, reviewDate: body.reviewDate!, reason: body.note ?? null } } : {}),
        });
        return st.tx.insert('adjustments', { ...row, state: adjustmentMachine.next('requested', 'apply'), movement_id: m.id, applied_at: st.now });
      },
      this.core.meta(by),
    );
    const api = (await this.core.adjustmentsApi([applied!]))[0]!;
    await this.#publishAdjustmentRecorded(applied!, item, by.actor, by);
    await this.reportWriteOff(item, body.toGroup, body.quantity, { kind: 'adjustment', id }, by);
    await this.core.audit({ action: 'inventory.adjustment.apply', actionLabel: 'Adjusted company stock', category: 'inventory', target: { ...target, screen: 'ops/inventory' }, before: api.before, after: api.after, reason: body.note ?? reasonLabel(body.reasonCode), approvalNote: check?.reason ?? null }, by);
    return api;
  }

  async #publishAdjustmentRecorded(a: Row<'adjustments'>, item: Row<'stock_items'>, actor: common.Actor, by: By) {
    this.core.ctx.events.publish(
      'inventory.adjustment.recorded',
      {
        adjustmentId: a.id,
        movementId: a.movement_id!,
        stockItemId: item.id,
        locationId: a.location_id,
        ownerType: item.owner_type,
        sellerId: item.seller_id,
        serviceManaged: await this.#serviceManaged(item, a.location_id),
        fromGroup: a.from_group,
        toGroup: a.to_group,
        quantity: a.quantity,
        reasonCode: a.reason_code,
        actor,
      },
      this.core.meta(by),
    );
  }

  /** inventory.adjustment.recorded for movements outside an adjustment (discrepancies reported or resolved) */
  async publishMovementsRecorded(movements: Row<'stock_movements'>[], actor: common.Actor, by: By) {
    if (!movements.length) return;
    const items = await this.core.skus(movements.map((m) => m.stock_item_id));
    for (const m of movements) {
      const item = items.get(m.stock_item_id);
      if (!item) continue;
      this.core.ctx.events.publish(
        'inventory.adjustment.recorded',
        {
          adjustmentId: null,
          movementId: m.id,
          stockItemId: item.id,
          locationId: m.location_id,
          ownerType: item.owner_type,
          sellerId: item.seller_id,
          serviceManaged: await this.#serviceManaged(item, m.location_id),
          fromGroup: m.from_group,
          toGroup: m.to_group,
          quantity: m.quantity,
          reasonCode: m.reason_code,
          actor,
        },
        this.core.meta(by),
      );
    }
  }

  /** Units of company stock leaving stock (written off) are reported to finance at cost */
  async reportWriteOff(item: Row<'stock_items'>, to: GroupOrOutside, quantity: number, reference: { kind: 'adjustment' | 'return'; id: string; ref?: string }, by: By) {
    if (to !== 'outside') return;
    const cost = unitCostOf(item);
    const finance = this.core.ctx.tryUse('finance');
    if (!cost || !finance || cost.amount === 0) return;
    try {
      await finance.recordCompanyCost({ kind: 'write_off', amount: money(cost.amount * quantity, cost.currency), reference: { kind: reference.kind, id: reference.id, ref: reference.ref ?? item.sku }, at: this.core.now().toISOString() });
    } catch (err) {
      // the stock has already moved; the write-off is retried by finance reconciliation from the ledger
      this.core.ctx.log.error({ err, stockItemId: item.id, by: by.actor }, 'inventory: write-off could not be reported to finance');
    }
  }

  async listAdjustments(query: { state?: string; stockItemId?: string }, page: PageRequest): Promise<common.Page<Adjustment>> {
    const p = await this.core.repo.pageAdjustments(query, page);
    return { ...p, items: await this.core.adjustmentsApi(p.items) };
  }

  async cancelAdjustment(id: string, reason: string, by: StaffBy): Promise<Adjustment> {
    if (!reason?.trim()) throw invalid('reason', 'Say why you are withdrawing the adjustment');
    const a = await this.core.repo.get('adjustments', id);
    if (!a) throw notFound('Adjustment');
    adjustmentMachine.next(a.state as 'pending_review', 'cancel'); // ILLEGAL_TRANSITION unless waiting for review
    const after = await this.core.repo.transaction(async (tx) => {
      const locked = (await tx.get('adjustments', id, { forUpdate: true }))!;
      return tx.update('adjustments', id, { state: adjustmentMachine.next(locked.state as 'pending_review', 'cancel'), decided_by: actorText(by.actor) });
    });
    if (a.approval_request_id) {
      await this.core.ctx
        .tryUse('access')
        ?.cancelApproval(a.approval_request_id, by.actor, reason)
        .catch((err) => this.core.ctx.log.warn({ err }, 'inventory: could not withdraw approval request'));
    }
    const api = (await this.core.adjustmentsApi([after]))[0]!;
    await this.core.audit({ action: 'inventory.adjustment.cancel', actionLabel: 'Withdrew stock adjustment', category: 'inventory', target: { type: 'stock_adjustment', id, ref: api.sku, label: api.label, screen: 'ops/inventory' }, reason, before: { state: a.state }, after: { state: api.state } }, by);
    return api;
  }

  /** access.approval.decided: Apply or reject adjustments waiting for second review */
  async onApprovalDecidedFromAccess(event: EventPayload<'access.approval.decided'>): Promise<void> {
    if (event.actionKey !== APPROVAL_ACTION) return;
    const a = await this.core.repo.adjustmentByApproval(event.requestId);
    if (!a || a.state !== 'pending_review') {
      if (!a) this.core.ctx.log.info({ requestId: event.requestId }, 'inventory: approval decided for an unknown adjustment, ignored');
      return;
    }
    const decidedBy = event.decidedBy ?? SYSTEM_ACTOR;
    const by: By = { actor: decidedBy };
    if (event.outcome !== 'approved') {
      await this.core.repo.transaction(async (tx) => {
        const locked = (await tx.get('adjustments', a.id, { forUpdate: true }))!;
        if (locked.state !== 'pending_review') return;
        await tx.update('adjustments', a.id, { state: adjustmentMachine.next('pending_review', event.outcome === 'cancelled' ? 'cancel' : 'reject'), decided_by: actorText(decidedBy) });
      });
      return;
    }
    const item = await this.core.item(a.stock_item_id);
    const requester = actorOf(a.requested_by) ?? SYSTEM_ACTOR;
    try {
      const applied = await this.core.stock(
        'adjustment',
        async (st) => {
          const locked = (await st.tx.get('adjustments', a.id, { forUpdate: true }))!;
          if (locked.state !== 'pending_review') return null;
          const m = await st.move(item.id, locked.location_id, locked.from_group as GroupOrOutside, locked.to_group as GroupOrOutside, locked.quantity, {
            reason: locked.reason_code,
            note: locked.note,
            ref: { kind: 'adjustment', id: locked.id, label: `Adjustment ${reasonLabel(locked.reason_code)}` },
            actor: requester,
            approvedBy: decidedBy,
            ...(locked.to_group === 'damaged_held' ? { hold: { reasonCode: locked.reason_code, reviewDate: locked.review_date ?? addDays(this.core.today(), DEFAULT_HOLD_REVIEW_DAYS), reason: locked.note } } : {}),
          });
          return st.tx.update('adjustments', a.id, { state: adjustmentMachine.next('pending_review', 'approve'), decided_by: actorText(decidedBy), movement_id: m.id, applied_at: st.now });
        },
        this.core.meta(by),
      );
      if (!applied) return;
      await this.#publishAdjustmentRecorded(applied, item, requester, by);
      await this.reportWriteOff(item, applied.to_group as GroupOrOutside, applied.quantity, { kind: 'adjustment', id: applied.id }, by);
      await this.core.audit({ action: 'inventory.adjustment.apply', actionLabel: 'Applied stock adjustment after second review', category: 'inventory', target: { type: 'stock_adjustment', id: a.id, ref: item.sku, label: item.label, screen: 'ops/inventory' }, after: { state: 'applied', quantity: a.quantity, fromGroup: a.from_group, toGroup: a.to_group }, reason: event.reason ?? null, approvalRequestId: event.requestId }, by);
    } catch (err) {
      if (!isAppError(err) || err.code !== 'GROUP_QUANTITY_EXCEEDED') throw err;
      // the units moved elsewhere while the adjustment waited: it cannot apply any more
      await this.core.repo.update('adjustments', a.id, { state: adjustmentMachine.next('pending_review', 'reject'), decided_by: actorText(decidedBy) });
      this.core.ctx.log.warn({ adjustmentId: a.id, details: err.details }, 'inventory: approved adjustment no longer fits the stock; marked rejected');
    }
  }

  /** Job inventory.held-stock-review (daily 07:00 market time): Publish inventory.hold.review_due for Damaged or held stock past its review date (work queue for the Inventory Manager) */
  async heldStockReview(): Promise<number> {
    const due = await this.core.repo.dueHeld(this.core.today(), 1000);
    for (const h of due) {
      if (h.quantity <= 0) continue;
      this.core.ctx.events.publish('inventory.hold.review_due', { stockItemId: h.stock_item_id, quantity: h.quantity, reasonCode: h.reason_code, reviewDate: h.review_date }, { actor: SYSTEM_ACTOR });
    }
    return due.length;
  }
}
