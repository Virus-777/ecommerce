/**
 * Returns of Marketly-fulfilled items received at our warehouse (decision D7): a service return per returned order
 * item (units Returned in the ledger and in inventory at the service location, returns processing fee), returns'
 * proposed stock outcome from its inspection, and the staff decision on the seller-owned units (decision D8):
 * restocked → Available, unsellable or to be removed → Unsellable (damaged_held), disposed → gone, with the fee.
 */
import { AppError } from '../../../kernel/errors/index.js';
import type { EventPayload } from '../../../kernel/events/index.js';
import { isUuid, newId } from '../../../kernel/lib/ids.js';
import type { PageRequest } from '../../../kernel/lib/pagination.js';
import type { ServiceReturn } from '../../../spec/fulfillment-service.js';
import { SYSTEM } from '../domain/rules.js';
import type { RequestItem, ServiceReturnRec, StockGroup } from '../ports.js';
import { invalid, notFound, Part, type By, type InventoryGroup, type ServiceReason } from './core.js';

type Outcome = 'restocked' | 'unsellable' | 'removal' | 'disposed';

const OUTCOME: Record<Outcome, { to: StockGroup | null; inventory: InventoryGroup | null; reasonCode: ServiceReason; movement: string; reason: string }> = {
  restocked: { to: 'available', inventory: 'available', reasonCode: 'service_return_restocked', movement: 'restocked', reason: 'Return inspected: sellable' },
  unsellable: { to: 'unsellable', inventory: 'damaged_held', reasonCode: 'service_return_unsellable', movement: 'unsellable', reason: 'Return inspected: unsellable' },
  removal: { to: 'unsellable', inventory: 'damaged_held', reasonCode: 'service_return_unsellable', movement: 'unsellable', reason: 'Return inspected: to be sent back to the seller' },
  disposed: { to: null, inventory: null, reasonCode: 'service_return_disposed', movement: 'disposed', reason: 'Return inspected: disposed' },
};

export class ReturnsPart extends Part {
  async list(sellerId: string, q: { outcome?: string }, page: PageRequest) {
    const res = await this.repo.page('service_returns', { seller_id: sellerId, ...(q.outcome ? { outcome: q.outcome } : {}) }, page, { order: { column: 'id', direction: 'desc' } });
    return { ...res, items: await this.parts.views.returns(res.items) };
  }

  /**
   * returns.return.received for a Marketly-fulfilled group: each returned item of a shipped request becomes a service
   * return (unique per return and order item); the units enter Returned; returns processing is charged.
   */
  async onReturnReceived(e: EventPayload<'returns.return.received'>): Promise<void> {
    if (e.fulfilledBy !== 'marketly_service' || e.ownerType !== 'seller' || !e.sellerId || !isUuid(e.returnId) || !isUuid(e.orderId)) return;
    const requests = await this.repo.find('fulfillment_requests', { order_id: e.orderId, seller_id: e.sellerId });
    const byItem = new Map<string, RequestItem>();
    for (const r of requests) for (const i of r.items) byItem.set(i.orderItemId, i);
    const lines = (e.items ?? []).filter((i) => i.quantity > 0 && byItem.has(i.orderItemId));
    if (!lines.length) return;
    const skus = new Map((await this.repo.find('sku_enrollments', { id: [...new Set(lines.map((l) => byItem.get(l.orderItemId)!.skuEnrollmentId))] })).map((s) => [s.id, s]));
    const schedule = await this.core.currentSchedule();
    const created: ServiceReturnRec[] = [];
    await this.repo.transaction(async (tx) => {
      await tx.lockSkus([...skus.keys()]);
      for (const l of lines) {
        const item = byItem.get(l.orderItemId)!;
        const sku = skus.get(item.skuEnrollmentId);
        if (!sku) continue;
        const row: ServiceReturnRec = { id: newId(), return_id: e.returnId, return_ref: e.ref, order_item_id: l.orderItemId, seller_id: e.sellerId!, sku_enrollment_id: sku.id, quantity: l.quantity, outcome: 'pending', proposed_outcome: null, inspection_note: null, evidence_media_ids: [], inspected_at: null };
        if (!(await tx.insertIfAbsent('service_returns', row))) continue; // redelivered
        // the movement that brings the units in carries the service return's id and the return ref
        await this.core.move(tx, { id: row.id, sellerId: e.sellerId!, skuEnrollmentId: sku.id, movement: 'returned', quantity: l.quantity, from: null, to: 'returned', reference: e.ref, reason: 'Customer return received', actor: SYSTEM });
        await this.core.accrue(tx, { sellerId: e.sellerId!, rateType: 'returns_processing_per_unit', sizeTier: sku.size_tier, units: l.quantity, reference: e.ref, key: `returns_processing:${e.returnId}:${l.orderItemId}` }, schedule.rates);
        created.push(row);
      }
    });
    if (!created.length) return;
    const location = await this.core.serviceLocation();
    for (const row of created) {
      const sku = skus.get(row.sku_enrollment_id)!;
      await this.core.moveStock({ key: `fs:return-received:${row.id}`, sku, from: null, to: 'returned', quantity: row.quantity, reasonCode: 'service_return_received', ref: { kind: 'service_return', id: row.id, label: `Return ${row.return_ref}` }, actor: SYSTEM }, { strict: false, location });
    }
    this.ctx.log.info({ returnId: e.returnId, serviceReturns: created.length }, 'fulfillment-service: service returns received');
  }

  /** returns.return.inspected: returns' proposed stock outcome, for staff to confirm with recordReturnOutcome */
  async onReturnInspected(e: EventPayload<'returns.return.inspected'>): Promise<void> {
    if (e.fulfilledBy !== 'marketly_service' || !isUuid(e.returnId) || !isUuid(e.orderItemId)) return;
    await this.repo.updateWhere('service_returns', { return_id: e.returnId, order_item_id: e.orderItemId, outcome: 'pending' }, { proposed_outcome: e.proposedStockOutcome || null });
  }

  async recordOutcome(id: string, body: { outcome: Outcome; note: string; evidenceIds?: string[] | null }, by: By): Promise<ServiceReturn> {
    const note = body.note?.trim();
    if (!note) throw invalid([{ path: 'note', message: 'Describe what the inspection found' }]);
    const how = OUTCOME[body.outcome];
    if (!how) throw invalid([{ path: 'outcome', message: 'Choose restocked, unsellable, removal or disposed' }]);
    const before = isUuid(id) ? await this.repo.get('service_returns', id) : undefined;
    if (!before) throw notFound('Service return');
    if (before.outcome !== 'pending') throw new AppError('ILLEGAL_TRANSITION', 'This return already has an inspection outcome', { machine: 'Service return', from: before.outcome, event: body.outcome });
    const sku = (await this.repo.get('sku_enrollments', before.sku_enrollment_id))!;
    const schedule = await this.core.currentSchedule();
    // inventory first: the single stock decision for the returned units (decision D8)
    await this.core.moveStock({ key: `fs:return-outcome:${id}`, sku, from: 'returned', to: how.inventory, quantity: before.quantity, reasonCode: how.reasonCode, ref: { kind: 'service_return', id, label: `Return ${before.return_ref}` }, actor: by.actor }, { strict: true });
    const after = await this.repo.transaction(async (tx) => {
      const locked = (await tx.get('service_returns', id, { forUpdate: true }))!;
      if (locked.outcome !== 'pending') throw new AppError('ILLEGAL_TRANSITION', 'This return already has an inspection outcome', { machine: 'Service return', from: locked.outcome, event: body.outcome });
      await this.core.move(tx, { sellerId: locked.seller_id, skuEnrollmentId: locked.sku_enrollment_id, movement: how.movement, quantity: locked.quantity, from: 'returned', to: how.to, reference: locked.return_ref || locked.return_id, reason: `${how.reason}. ${note}`, actor: by.actor });
      if (body.outcome === 'disposed') {
        await this.core.accrue(tx, { sellerId: locked.seller_id, rateType: 'disposal_per_unit', sizeTier: sku.size_tier, units: locked.quantity, reference: locked.return_ref || null, key: `disposal:return:${id}` }, schedule.rates);
      }
      return tx.update('service_returns', id, { outcome: body.outcome, inspection_note: note, evidence_media_ids: body.evidenceIds ?? [], inspected_at: this.now() });
    });
    this.core.publish('fulfillment-service.return.inspected', { serviceReturnId: id, returnId: after.return_id, sellerId: after.seller_id, outcome: after.outcome }, by);
    await this.core.notifySeller(after.seller_id, 'seller.fulfillment.return_inspected', { return: { ref: after.return_ref }, outcome: after.outcome }, { kind: 'return', id: after.return_id, ref: after.return_ref, label: 'View return', screen: 'seller/inventory' }, `fs:return:${id}`);
    await this.core.audit(
      {
        action: 'fulfillment-service.return.outcome',
        actionLabel: 'Recorded the inspection outcome of a returned service unit',
        category: 'returns',
        target: { type: 'service_return', id, ref: after.return_ref, label: `Return ${after.return_ref} · ${sku.sku}`, sellerId: after.seller_id, screen: 'ops/return-inspection' },
        before: { outcome: before.outcome, proposedOutcome: before.proposed_outcome },
        after: { outcome: after.outcome, quantity: after.quantity },
        reason: note,
        evidence: body.evidenceIds ?? null,
      },
      by,
    );
    return (await this.parts.views.returns([after]))[0]!;
  }
}
