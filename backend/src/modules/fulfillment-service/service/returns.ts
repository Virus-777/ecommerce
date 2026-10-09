/**
 * Returns of service offers received at our warehouse: a service return per SKU (units Returned, returns
 * processing fee), then the inspection outcome on the seller-owned units (restocked → Available again,
 * unsellable or to be removed → Unsellable, disposed → gone, with the disposal fee).
 */
import { AppError } from '../../../kernel/errors/index.js';
import type { EventPayload } from '../../../kernel/events/index.js';
import { isUuid, newId } from '../../../kernel/lib/ids.js';
import type { PageRequest } from '../../../kernel/lib/pagination.js';
import type { ServiceReturn } from '../../../spec/fulfillment-service.js';
import { SYSTEM } from '../domain/rules.js';
import type { RequestItem, ServiceReturnRec, StockGroup } from '../ports.js';
import { invalid, notFound, Part, type By } from './core.js';

const OUTCOME: Record<'restocked' | 'unsellable' | 'removal' | 'disposed', { to: StockGroup | null; movement: string; reason: string }> = {
  restocked: { to: 'available', movement: 'restocked', reason: 'Return inspected: sellable' },
  unsellable: { to: 'unsellable', movement: 'unsellable', reason: 'Return inspected: unsellable' },
  removal: { to: 'unsellable', movement: 'unsellable', reason: 'Return inspected: to be sent back to the seller' },
  disposed: { to: null, movement: 'disposed', reason: 'Return inspected: disposed' },
};

export class ReturnsPart extends Part {
  async list(sellerId: string, q: { outcome?: string }, page: PageRequest) {
    const res = await this.repo.page('service_returns', { seller_id: sellerId, ...(q.outcome ? { outcome: q.outcome } : {}) }, page, { order: { column: 'id', direction: 'desc' } });
    return { ...res, items: await this.parts.views.returns(res.items) };
  }

  /** returns.return.received: units of service offers back at our warehouse */
  async onReturnReceived(e: EventPayload<'returns.return.received'>): Promise<void> {
    if (e.ownerType !== 'seller' || !e.sellerId || !isUuid(e.returnId)) return;
    if (await this.repo.count('service_returns', { return_id: e.returnId })) return;
    if (!(await this.repo.count('sku_enrollments', { seller_id: e.sellerId }))) return;
    const returns = this.ctx.tryUse('returns');
    if (!returns) return;
    // the return's items: returns knows which order items a return covers; we know which we shipped
    const shipped = await this.parts.requests.shippedItems(e.sellerId);
    if (!shipped.length) return;
    const byItem = new Map<string, RequestItem>(shipped.map((s) => [s.item.orderItemId, s.item]));
    let ref: string | null = null;
    const covered: string[] = [];
    const ids = [...byItem.keys()];
    for (let i = 0; i < ids.length; i += 200) {
      const states = await returns.returnStateForItems(ids.slice(i, i + 200)).catch(() => []);
      for (const s of states) {
        if (s.returnId === e.returnId) {
          covered.push(s.orderItemId);
          ref = s.ref ?? ref;
        }
      }
    }
    if (!covered.length) return;
    const quantities = new Map<string, number>();
    if (ref) {
      const detail = await this.core.soft('returns', 'return detail', (r) => r.getReturnForSeller(e.sellerId!, ref!));
      for (const it of detail?.detail.items ?? []) quantities.set(it.orderItemId, it.quantity);
    }
    const lines = new Map<string, number>();
    for (const orderItemId of covered) {
      const item = byItem.get(orderItemId)!;
      const n = quantities.get(orderItemId) ?? Math.max(1, item.picked);
      lines.set(item.skuEnrollmentId, (lines.get(item.skuEnrollmentId) ?? 0) + n);
    }
    const skus = new Map((await this.repo.find('sku_enrollments', { id: [...lines.keys()] })).map((s) => [s.id, s]));
    const schedule = await this.core.currentSchedule();
    const created: ServiceReturnRec[] = [];
    await this.repo.transaction(async (tx) => {
      await tx.lockSkus([...lines.keys()]);
      for (const [skuId, quantity] of lines) {
        if (await tx.findOne('service_returns', { return_id: e.returnId, sku_enrollment_id: skuId })) continue;
        const id = newId();
        const row = await tx.insert('service_returns', { id, return_id: e.returnId, seller_id: e.sellerId!, sku_enrollment_id: skuId, quantity, outcome: 'pending', inspection_note: null, evidence_media_ids: [], inspected_at: null });
        // the movement that brings the units in carries the service return's id and the return ref
        await this.core.move(tx, { id, sellerId: e.sellerId!, skuEnrollmentId: skuId, movement: 'returned', quantity, from: null, to: 'returned', reference: ref ?? e.returnId, reason: 'Customer return received', actor: SYSTEM });
        await this.core.accrue(tx, { sellerId: e.sellerId!, rateType: 'returns_processing_per_unit', sizeTier: skus.get(skuId)?.size_tier ?? 'any', units: quantity, reference: ref, key: `returns_processing:${e.returnId}:${skuId}` }, schedule.rates);
        created.push(row);
      }
    });
    if (created.length) this.ctx.log.info({ returnId: e.returnId, serviceReturns: created.length }, 'fulfillment-service: service returns received');
  }

  async recordOutcome(id: string, body: { outcome: 'restocked' | 'unsellable' | 'removal' | 'disposed'; note: string; evidenceIds?: string[] | null }, by: By): Promise<ServiceReturn> {
    const note = body.note?.trim();
    if (!note) throw invalid([{ path: 'note', message: 'Describe what the inspection found' }]);
    const how = OUTCOME[body.outcome];
    if (!how) throw invalid([{ path: 'outcome', message: 'Choose restocked, unsellable, removal or disposed' }]);
    const before = isUuid(id) ? await this.repo.get('service_returns', id) : undefined;
    if (!before) throw notFound('Service return');
    const sku = (await this.repo.get('sku_enrollments', before.sku_enrollment_id))!;
    const schedule = await this.core.currentSchedule();
    const after = await this.repo.transaction(async (tx) => {
      const locked = (await tx.get('service_returns', id, { forUpdate: true }))!;
      if (locked.outcome !== 'pending') throw new AppError('ILLEGAL_TRANSITION', 'This return already has an inspection outcome', { machine: 'Service return', from: locked.outcome, event: body.outcome });
      const receipt = await tx.get('ownership_ledger', id);
      await this.core.move(tx, { sellerId: locked.seller_id, skuEnrollmentId: locked.sku_enrollment_id, movement: how.movement, quantity: locked.quantity, from: 'returned', to: how.to, reference: receipt?.reference ?? locked.return_id, reason: `${how.reason}. ${note}`, actor: by.actor });
      if (body.outcome === 'disposed') {
        await this.core.accrue(tx, { sellerId: locked.seller_id, rateType: 'disposal_per_unit', sizeTier: sku.size_tier, units: locked.quantity, reference: receipt?.reference ?? null, key: `disposal:return:${id}` }, schedule.rates);
      }
      return tx.update('service_returns', id, { outcome: body.outcome, inspection_note: note, evidence_media_ids: body.evidenceIds ?? [], inspected_at: this.now() });
    });
    if (body.outcome === 'restocked') {
      await this.core.adjustInventory(after.seller_id, sku.inventory_item_id, after.quantity, after.return_id, by.actor).catch((err) => this.ctx.log.warn({ err, serviceReturnId: id }, 'fulfillment-service: restocked units not added to inventory'));
    }
    this.core.publish('fulfillment-service.return.inspected', { serviceReturnId: id, returnId: after.return_id, sellerId: after.seller_id, outcome: after.outcome }, by);
    return (await this.parts.views.returns([after]))[0]!;
  }
}
