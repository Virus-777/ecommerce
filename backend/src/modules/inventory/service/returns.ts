/**
 * Stock outcome of returned items: Returned on receipt, then restock, different condition, damaged stock, repair,
 * return to supplier or write-off.
 */
import { inventoryError } from '../errors.js';
import type { EventEnvelope, EventPayload } from '../../../kernel/events/index.js';
import { isUuid, newId } from '../../../kernel/lib/ids.js';
import { money } from '../../../kernel/lib/money.js';
import type { PageRequest } from '../../../kernel/lib/pagination.js';
import type * as common from '../../../spec/common.js';
import type { MovementRef, RecordReturnOutcomeRequest, ReturnOutcome } from '../../../spec/inventory.js';
import { returnStockOutcomeMachine } from '../domain/state-machines.js';
import { onHand, weightedAverage } from '../domain/rules.js';
import { actorText, SYSTEM_ACTOR, toMovement, toReturnOutcome, unitCostOf } from '../mappers.js';
import type { Row } from '../ports.js';
import { StockTx } from '../stock-tx.js';
import { invalid, notFound, type StaffBy, type Core } from './core.js';
import type { Adjustments } from './adjustments.js';

const RETURN_OUTCOMES = ['restock', 'different_condition', 'damaged_stock', 'repair', 'return_to_supplier', 'write_off'] as const;

type ReturnOutcomeKind = (typeof RETURN_OUTCOMES)[number];

export class Returns {
  constructor(private readonly core: Core, private readonly adjustments: Adjustments) {}

  async #returnOutcomesApi(rows: Row<'return_outcomes'>[]): Promise<ReturnOutcome[]> {
    const movements = await this.core.repo.movementsByRef('return', [...new Set(rows.map((r) => r.return_id))]);
    const items = await this.core.skus([...rows.map((r) => r.stock_item_id), ...movements.map((m) => m.stock_item_id)]);
    return rows.map((r) => {
      const own = movements.filter((m) => m.ref_id === r.return_id && (m.stock_item_id === r.stock_item_id || m.stock_item_id === r.target_stock_item_id));
      return toReturnOutcome(r, items.get(r.stock_item_id), own.map((m) => toMovement(m, items.get(m.stock_item_id)?.sku ?? '')));
    });
  }

  async listReturnOutcomes(query: { state?: string }, page: PageRequest): Promise<common.Page<ReturnOutcome>> {
    const p = await this.core.repo.pageReturnOutcomes(query, page);
    return { ...p, items: await this.#returnOutcomesApi(p.items) };
  }

  async recordReturnOutcome(id: string, body: RecordReturnOutcomeRequest, by: StaffBy): Promise<ReturnOutcome> {
    const o = await this.core.repo.get('return_outcomes', id);
    if (!o) throw notFound('Return outcome');
    returnStockOutcomeMachine.next(o.state as 'pending', 'record');
    const outcome = body.outcome as ReturnOutcomeKind;
    const source = await this.core.item(o.stock_item_id);
    let target: Row<'stock_items'> | undefined;
    if (outcome === 'different_condition') {
      if (!body.targetStockItemId) throw invalid('targetStockItemId', 'Choose the company stock item for the new condition');
      target = await this.core.repo.get('stock_items', body.targetStockItemId);
      if (!target || target.owner_type !== 'official' || target.id === source.id) throw invalid('targetStockItemId', 'Choose another company stock item');
      if (target.archived) throw inventoryError('STOCK_ITEM_ARCHIVED', 'The target stock item is archived');
    }
    const holding = outcome === 'damaged_stock' || outcome === 'repair' || outcome === 'return_to_supplier';
    if (holding && !body.reviewDate) throw inventoryError('REVIEW_DATE_REQUIRED', 'Units kept in Damaged or held need a review date');
    const ref: MovementRef = { kind: 'return', id: o.return_id, label: `Return ${o.return_ref}` };
    const moveReason = outcome === 'return_to_supplier' ? 'return_to_supplier' : `return_${outcome}`;
    let valueAtCost: common.Money | null = null;
    await this.core.stock(
      'return_outcome',
      async (st) => {
        const locked = (await st.tx.get('return_outcomes', id, { forUpdate: true }))!;
        const state = returnStockOutcomeMachine.next(locked.state as 'pending', 'record');
        await st.lock([source.id, ...(target ? [target.id] : [])]);
        const at = st.levels(source.id).find((l) => l.returned >= locked.quantity) ?? st.levels(source.id)[0];
        if (!at) throw inventoryError('GROUP_QUANTITY_EXCEEDED', 'No returned units of this item', { group: 'returned', quantity: 0 });
        const loc = at.location_id;
        const meta = { reason: moveReason, note: body.note ?? null, ref, actor: by.actor };
        if (outcome === 'restock') await st.move(source.id, loc, 'returned', 'available', locked.quantity, meta);
        if (holding) await st.move(source.id, loc, 'returned', 'damaged_held', locked.quantity, { ...meta, hold: { reasonCode: moveReason, reviewDate: body.reviewDate!, reason: body.note ?? null, sourceRef: o.return_ref } });
        if (outcome === 'write_off') {
          await st.move(source.id, loc, 'returned', 'outside', locked.quantity, meta);
          const cost = unitCostOf(st.item(source.id));
          valueAtCost = cost ? money(cost.amount * locked.quantity, cost.currency) : null;
        }
        if (outcome === 'different_condition') {
          await st.move(source.id, loc, 'returned', 'outside', locked.quantity, meta);
          const tgt = st.item(target!.id);
          const targetLoc = st.levels(tgt.id).find((l) => l.location_id === loc)?.location_id ?? st.levels(tgt.id)[0]?.location_id ?? loc;
          // the unit keeps its original cost in the target condition
          const cost = unitCostOf(st.item(source.id));
          if (cost) st.items.set(tgt.id, await st.tx.update('stock_items', tgt.id, { unit_cost_amount: weightedAverage(tgt.unit_cost_amount === null ? null : Number(tgt.unit_cost_amount), onHand(st.total(tgt.id)), cost.amount, locked.quantity) }));
          await st.move(tgt.id, targetLoc, 'outside', 'available', locked.quantity, meta);
        }
        if (body.binCode && outcome !== 'different_condition' && !st.item(source.id).primary_bin_code) await st.tx.update('stock_items', source.id, { primary_bin_code: body.binCode });
        await st.tx.update('return_outcomes', id, { state, recorded_outcome: outcome, target_stock_item_id: target?.id ?? null, recorded_by: actorText(by.actor), recorded_at: st.now });
      },
      this.core.meta(by),
    );
    this.core.ctx.events.publish('inventory.return_outcome.recorded', { returnId: o.return_id, stockItemId: source.id, outcome, targetStockItemId: target?.id ?? null, quantity: o.quantity, valueAtCost }, this.core.meta(by));
    if (outcome === 'write_off') await this.adjustments.reportWriteOff(source, 'outside', o.quantity, { kind: 'return', id: o.return_id, ref: o.return_ref }, by);
    const api = (await this.#returnOutcomesApi([(await this.core.repo.get('return_outcomes', id))!]))[0]!;
    await this.core.audit({ action: 'inventory.return_outcome.record', actionLabel: 'Recorded stock outcome of a return', category: 'returns', target: { type: 'return', id: o.return_id, ref: o.return_ref, label: `${source.sku} · ${o.quantity} unit${o.quantity === 1 ? '' : 's'}`, screen: 'ops/return-inspection' }, after: { outcome, targetStockItemId: target?.id ?? null, valueAtCost }, reason: body.note ?? null }, by);
    return api;
  }

  /**
   * The company stock item of a returned unit: the one the event names when it is company stock, otherwise the
   * company stock item of the variant (new condition first).
   */
  async #returnStockItem(stockItemId: string | null | undefined, variantId: string): Promise<Row<'stock_items'> | undefined> {
    if (stockItemId && isUuid(stockItemId)) {
      const named = await this.core.repo.get('stock_items', stockItemId);
      if (named?.owner_type === 'official') return named;
    }
    return (await this.core.repo.items({ ownerType: 'official', variantIds: [variantId] })).sort((a, b) => Number(b.condition === 'new') - Number(a.condition === 'new'))[0];
  }

  /** Where returned units of an item are put: its first stock location, else the default company location */
  async #returnLocation(itemId: string): Promise<string | undefined> {
    return (await this.core.repo.levels([itemId]))[0]?.location_id ?? (await this.core.officialDefault())?.id;
  }

  /**
   * Adds a return item's units to Returned, once per return item: returns.return.received and (when that event
   * never came) returns.return.inspected claim the same key, so whichever runs first moves the units.
   */
  async #addReturned(st: StockTx, returnId: string, orderItemId: string, itemId: string, locationId: string, quantity: number): Promise<boolean> {
    if (!(await st.tx.claimEvent(`return-units:${returnId}:${orderItemId}`))) return false;
    const short = returnId.slice(0, 8).toUpperCase();
    await st.move(itemId, locationId, 'outside', 'returned', quantity, { reason: 'return_received', ref: { kind: 'return', id: returnId, label: `Return RT-${short}` }, actor: SYSTEM_ACTOR });
    return true;
  }

  /**
   * returns.return.received: Official Store items: add each listed item's units (items[].stockItemId, quantity) to
   * Returned at the receiving warehouse, once per return item. Seller returns are recorded by sellers through adjustments.
   */
  async onReturnReceivedFromReturns(event: EventPayload<'returns.return.received'>): Promise<void> {
    if (event.ownerType !== 'official') return;
    const units: { orderItemId: string; itemId: string; locationId: string; quantity: number }[] = [];
    for (const i of event.items) {
      if (!(i.quantity > 0)) continue;
      const item = await this.#returnStockItem(i.stockItemId, i.variantId);
      const locationId = item && (await this.#returnLocation(item.id));
      if (!item || !locationId) {
        this.core.ctx.log.warn({ returnId: event.returnId, orderItemId: i.orderItemId, variantId: i.variantId }, 'inventory: received return item has no company stock item or location, ignored');
        continue;
      }
      units.push({ orderItemId: i.orderItemId, itemId: item.id, locationId, quantity: i.quantity });
    }
    if (!units.length) return;
    await this.core.stock('return_received', async (st) => {
      await st.lock(units.map((u) => u.itemId));
      for (const u of units) await this.#addReturned(st, event.returnId, u.orderItemId, u.itemId, u.locationId, u.quantity);
    });
  }

  /**
   * returns.return.inspected: Create a pending return stock outcome with the inspector's proposed outcome. The units
   * stay in Returned until the outcome is recorded (recordReturnOutcome moves them); units that never arrived
   * through returns.return.received are added to Returned first, so a missed event loses no stock. Once per return item.
   */
  async onReturnInspectedFromReturns(event: EventPayload<'returns.return.inspected'>, envelope?: Pick<EventEnvelope, 'at'>): Promise<void> {
    if (event.ownerType !== 'official') return;
    const item = await this.#returnStockItem(event.stockItemId, event.variantId);
    if (!item) {
      this.core.ctx.log.warn({ returnId: event.returnId, variantId: event.variantId }, 'inventory: inspected return has no company stock item for its variant, ignored');
      return;
    }
    const location = await this.#returnLocation(item.id);
    if (!location) {
      this.core.ctx.log.warn({ returnId: event.returnId }, 'inventory: no company location for an inspected return, ignored');
      return;
    }
    const proposed = (RETURN_OUTCOMES as readonly string[]).includes(event.proposedStockOutcome) ? event.proposedStockOutcome : 'damaged_stock';
    const quantity = Math.max(1, event.quantity);
    const short = event.returnId.slice(0, 8).toUpperCase();
    await this.core.stock('return_received', async (st) => {
      if (!(await st.tx.claimEvent(`return-inspected:${event.returnId}:${event.orderItemId}`))) return;
      await st.lock([item.id]);
      await this.#addReturned(st, event.returnId, event.orderItemId, item.id, location, quantity);
      const row = await st.tx.insertIfAbsent(
        'return_outcomes',
        {
          id: newId(),
          return_id: event.returnId,
          return_ref: `RT-${short}`,
          order_ref: '',
          stock_item_id: item.id,
          quantity,
          inspected_condition: event.conditionOutcome,
          proposed_outcome: proposed,
          proposed_target_sku: null,
          state: 'pending',
          recorded_outcome: null,
          target_stock_item_id: null,
          recorded_by: null,
          recorded_at: null,
          inspected_at: envelope?.at ? new Date(envelope.at) : st.now,
        },
      );
      if (row) return;
      // another item of the same return and stock item (one outcome per return and stock item): add its units
      // forUpdate: `quantity` is read here and written back below, so the outcome rows are locked first
      const same = (await st.tx.returnOutcomesWhere({ returnId: event.returnId }, { forUpdate: true })).find((o) => o.stock_item_id === item.id);
      if (same?.state === 'pending') await st.tx.update('return_outcomes', same.id, { quantity: same.quantity + quantity });
      else this.core.ctx.log.warn({ returnId: event.returnId, orderItemId: event.orderItemId, stockItemId: item.id }, 'inventory: the stock outcome of this return and item is already recorded; its units stay in Returned');
    });
  }
}
