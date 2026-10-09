/**
 * SKU enrollment: which seller offers are stored and shipped by Marketly, with packed dimensions and weight,
 * size tier, labelling and restricted-item checks; staff review; activation when stock is received; the seller
 * stopping the service for a SKU. Also the in-process answers isServiceOffer and stockOwner.
 */
import { AppError } from '../../../kernel/errors/index.js';
import { isUuid, newId } from '../../../kernel/lib/ids.js';
import type { PageRequest } from '../../../kernel/lib/pagination.js';
import type { SkuEnrollment, SkuEnrollmentInput } from '../../../spec/fulfillment-service.js';
import { skuEnrollmentMachine } from '../domain/state-machines.js';
import { dimensionIssues, restriction, sizeTier } from '../domain/rules.js';
import type { FulfillmentServiceRepository, SkuRec } from '../ports.js';
import { invalid, notFound, Part, type By } from './core.js';

type State = SkuEnrollment['state'];

export class SkusPart extends Part {
  async ownSku(sellerId: string, id: string): Promise<SkuRec> {
    const row = isUuid(id) ? await this.repo.get('sku_enrollments', id) : undefined;
    if (!row || row.seller_id !== sellerId) throw notFound('SKU');
    return row;
  }

  async list(sellerId: string, q: { state?: string; q?: string }, page: PageRequest) {
    const res = await this.repo.page('sku_enrollments', { seller_id: sellerId, ...(q.state ? { state: q.state } : {}) }, page, {
      order: { column: 'id', direction: 'desc' },
      ...(q.q?.trim() ? { search: { columns: ['sku', 'barcode'], term: q.q } } : {}),
    });
    return { ...res, items: await this.parts.views.skus(res.items) };
  }

  /** Staff: one seller's SKUs with the stock held by the company per group */
  async listForSeller(sellerId: string, page: PageRequest) {
    const res = await this.repo.page('sku_enrollments', { seller_id: sellerId }, page, { order: { column: 'id', direction: 'desc' } });
    return { ...res, items: await this.parts.views.skus(res.items) };
  }

  async enroll(sellerId: string, input: SkuEnrollmentInput, by: By): Promise<SkuEnrollment> {
    const enrollment = await this.parts.enrollment.requireOpen(sellerId, 'enroll SKUs');
    const issues = dimensionIssues(input.dimensionsCm, input.weightGrams);
    if (issues.length) throw invalid(issues);
    const why = restriction(input.dimensionsCm, input.weightGrams, input.hazmat);
    if (why) throw this.core.error('SKU_RESTRICTED', why, { offerId: input.offerId });
    // the offer's stock item (one per seller offer) gives the product and the seller SKU; another seller's offer is not found
    const item = (await this.ctx.use('inventory').getStockForOffers([input.offerId], { sellerId }))[input.offerId];
    if (!item || item.archived) throw notFound('Offer');
    const existing = await this.repo.findOne('sku_enrollments', { offer_id: input.offerId });
    if (existing) {
      if (existing.seller_id !== sellerId) throw notFound('Offer');
      throw new AppError('ILLEGAL_TRANSITION', existing.state === 'inactive' ? 'This offer is already enrolled: send stock in an inbound shipment to use the service again' : 'This offer is already enrolled', {
        machine: 'SKU enrollment',
        from: existing.state,
        event: 'enroll',
        skuEnrollmentId: existing.id,
      });
    }
    const used = await this.repo.count('sku_enrollments', { seller_id: sellerId, state: ['pending', 'approved', 'active'] });
    if (used + 1 > enrollment.max_skus) throw this.core.error('CAPACITY_EXCEEDED', `Your allowance is ${enrollment.max_skus} SKUs and ${used} are enrolled`, { maxSkus: enrollment.max_skus, usedSkus: used });
    const barcode = input.barcode?.trim() || null;
    const row: SkuRec = {
      id: newId(),
      seller_id: sellerId,
      offer_id: input.offerId,
      product_id: item.productId,
      sku: item.sku,
      dimensions: { length: input.dimensionsCm.length, width: input.dimensionsCm.width, height: input.dimensionsCm.height },
      weight_grams: input.weightGrams,
      size_tier: sizeTier(input.dimensionsCm, input.weightGrams),
      barcode,
      // units without a scannable barcode get our unit label (label fee per unit)
      label_required: !barcode,
      restricted: false,
      restriction_reason: null,
      state: skuEnrollmentMachine.initial,
      inventory_item_id: item.id,
    };
    if (!(await this.repo.insertIfNew('sku_enrollments', row))) throw new AppError('ILLEGAL_TRANSITION', 'This offer is already enrolled', { machine: 'SKU enrollment', from: 'pending', event: 'enroll' });
    void by;
    return this.parts.views.sku(row);
  }

  async deactivate(sellerId: string, id: string, by: By): Promise<SkuEnrollment> {
    const before = await this.ownSku(sellerId, id);
    skuEnrollmentMachine.next(before.state as State, 'deactivate');
    const balances = await this.repo.balances([before.id]);
    const available = Math.max(0, balances.get(before.id)?.available ?? 0);
    if (available > 0) {
      const removals = await this.repo.find('removal_orders', { seller_id: sellerId, state: ['requested', 'approved', 'processing'] });
      const covered = removals.flatMap((r) => r.lines).filter((l) => l.skuEnrollmentId === before.id && l.fromGroup === 'available').reduce((n, l) => n + l.quantity, 0);
      if (covered < available) throw this.core.error('STOCK_REMAINING', `${available} units of this SKU are still available in our warehouse; request their removal first`, { available, coveredByRemovals: covered });
    }
    const after = await this.repo.transaction(async (tx) => {
      const row = (await tx.get('sku_enrollments', id, { forUpdate: true }))!;
      return tx.update('sku_enrollments', id, { state: skuEnrollmentMachine.next(row.state as State, 'deactivate') });
    });
    void by;
    return this.parts.views.sku(after);
  }

  async review(id: string, body: { approve: boolean; reason?: string | null; sizeTier?: SkuEnrollment['sizeTier'] | null }, by: By): Promise<SkuEnrollment> {
    if (!body.approve && !body.reason?.trim()) throw invalid([{ path: 'reason', message: 'Tell the seller why the SKU is rejected' }]);
    const after = await this.repo.transaction(async (tx) => {
      const before = isUuid(id) ? await tx.get('sku_enrollments', id, { forUpdate: true }) : undefined;
      if (!before) throw notFound('SKU');
      const state = skuEnrollmentMachine.next(before.state as State, body.approve ? 'approve' : 'reject');
      return tx.update('sku_enrollments', id, {
        state,
        ...(body.sizeTier ? { size_tier: body.sizeTier } : {}),
        ...(body.approve ? {} : { restricted: true, restriction_reason: body.reason!.trim() }),
      });
    });
    void by;
    return this.parts.views.sku(after);
  }

  /** Received stock activates approved or inactive SKUs (inside the receiving transaction) */
  async activateWithStock(tx: FulfillmentServiceRepository, skuIds: readonly string[]): Promise<void> {
    for (const id of new Set(skuIds)) {
      const s = await tx.get('sku_enrollments', id, { forUpdate: true });
      if (s && skuEnrollmentMachine.can(s.state as State, 'activate')) await tx.update('sku_enrollments', id, { state: skuEnrollmentMachine.next(s.state as State, 'activate') });
    }
  }

  /* ---------------------------------------------------------------- in-process */

  /** Fulfilled by Marketly: an active SKU of an active enrollment (suspension stops new service-offer sales) */
  async isServiceOffer(offerId: string): Promise<boolean> {
    if (!isUuid(offerId)) return false;
    const sku = await this.repo.findOne('sku_enrollments', { offer_id: offerId, state: 'active' });
    if (!sku) return false;
    const e = await this.repo.findOne('enrollments', { seller_id: sku.seller_id });
    return e?.state === 'active';
  }

  /** Seller stock items enrolled in the service are the seller's; anything else in our warehouse is company stock */
  async stockOwner(stockItemId: string): Promise<{ kind: 'company' | 'seller'; sellerId?: string }> {
    const sku = isUuid(stockItemId) ? await this.repo.findOne('sku_enrollments', { inventory_item_id: stockItemId }) : undefined;
    return sku ? { kind: 'seller', sellerId: sku.seller_id } : { kind: 'company' };
  }
}
