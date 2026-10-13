/**
 * SKU enrollment: which seller offers are stored and shipped by Marketly, with packed dimensions and weight,
 * size tier, labelling and restricted-item checks; staff review; activation when a service receipt with sellable
 * units is confirmed; the seller stopping the service for a SKU (the item sells from the seller's own location
 * again, decision D4). Also the in-process answers isServiceOffer, getServiceTerms, getServiceLocation and stockOwner.
 */
import { AppError } from '../../../kernel/errors/index.js';
import { isUuid, newId } from '../../../kernel/lib/ids.js';
import type { PageRequest } from '../../../kernel/lib/pagination.js';
import type { ServiceTerms, SkuEnrollment, SkuEnrollmentInput } from '../../../spec/fulfillment-service.js';
import { skuEnrollmentMachine } from '../domain/state-machines.js';
import { dimensionIssues, restriction, sizeTier } from '../domain/rules.js';
import type { SkuRec } from '../ports.js';
import type { FulfillmentServiceRepository } from '../repository.js';
import { invalid, notFound, Part, type By, type ServiceLocation } from './core.js';

type State = SkuEnrollment['state'];

/** Enrollment states in which Marketly still fulfils an active SKU (sellable only while active, decision D5) */
const SERVING = ['active', 'suspended', 'offboarding'];

/** Shipping profile id when no Official Store profile exists (the terms are then not sellable: service_unavailable) */
const NO_PROFILE = '00000000-0000-0000-0000-000000000000';

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
    const why = restriction(input.dimensionsCm, input.weightGrams, input.hazmat === true);
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
      hazmat: input.hazmat === true,
      notes: input.notes?.trim() || null,
      state: skuEnrollmentMachine.initial,
      inventory_item_id: item.id,
    };
    if (!(await this.repo.insertIfAbsent('sku_enrollments', row))) throw new AppError('ILLEGAL_TRANSITION', 'This offer is already enrolled', { machine: 'SKU enrollment', from: 'pending', event: 'enroll' });
    const names = await this.core.sellerNames([sellerId]);
    await this.core.raise({
      queueKey: 'fulfillment.enrollments',
      kind: 'application_waiting',
      title: `Review SKU ${row.sku} for Fulfilled by Marketly`,
      summary: `${names.get(sellerId) ?? 'Seller'} · ${item.label} · ${row.size_tier}${row.notes ? ` · ${row.notes}` : ''}`,
      subject: { type: 'offer', id: row.offer_id, ref: row.sku, label: item.label },
      sellerId,
      dedupeKey: `fs_sku:${row.id}`,
    });
    void by;
    return this.parts.views.sku(row);
  }

  /**
   * The seller stops the service for a SKU: no units may be available at the service location (else
   * STOCK_REMAINING; reserved and the other groups finish through orders, returns and removals). The item sells from
   * the seller's own location again (inventory.setServiceLocation null), then offers hears it.
   */
  async deactivate(sellerId: string, id: string, by: By): Promise<SkuEnrollment> {
    const before = await this.ownSku(sellerId, id);
    skuEnrollmentMachine.next(before.state as State, 'deactivate');
    const balances = await this.repo.balances([before.id]);
    let available = Math.max(0, balances.get(before.id)?.available ?? 0);
    const location = await this.core.serviceLocation();
    if (location && before.inventory_item_id) {
      const levels = await this.ctx
        .use('inventory')
        .getLevels([before.inventory_item_id], location.locationId)
        .catch((err) => void this.ctx.log.warn({ err, skuEnrollmentId: before.id }, 'fulfillment-service: inventory levels unavailable'));
      available = Math.max(available, levels?.[before.inventory_item_id]?.available ?? 0);
    }
    if (available > 0) throw this.core.error('STOCK_REMAINING', `${available} units of this SKU are still available in our warehouse; request their removal first`, { available });
    await this.core.setServiceLocation(before, null, by.actor, { strict: true });
    const after = await this.repo.transaction(async (tx) => {
      const row = (await tx.get('sku_enrollments', id, { forUpdate: true }))!;
      return tx.update('sku_enrollments', id, { state: skuEnrollmentMachine.next(row.state as State, 'deactivate') });
    });
    this.core.serviceChanged([after], { fulfilledBy: 'seller', sellable: true, reason: 'sku_deactivated' }, by);
    return this.parts.views.sku(after);
  }

  async review(id: string, body: { approve: boolean; reason?: string | null; sizeTier?: SkuEnrollment['sizeTier'] | null }, by: By): Promise<SkuEnrollment> {
    if (!body.approve && !body.reason?.trim()) throw invalid([{ path: 'reason', message: 'Tell the seller why the SKU is rejected' }]);
    const { before, after } = await this.repo.transaction(async (tx) => {
      const before = isUuid(id) ? await tx.get('sku_enrollments', id, { forUpdate: true }) : undefined;
      if (!before) throw notFound('SKU');
      const state = skuEnrollmentMachine.next(before.state as State, body.approve ? 'approve' : 'reject');
      const after = await tx.update('sku_enrollments', id, {
        state,
        ...(body.sizeTier ? { size_tier: body.sizeTier } : {}),
        ...(body.approve ? {} : { restricted: true, restriction_reason: body.reason!.trim() }),
      });
      return { before, after };
    });
    const reason = body.reason?.trim() || (body.approve ? 'Approved for Fulfilled by Marketly' : '');
    await this.core.resolveWork(`fs_sku:${id}`, `${body.approve ? 'Approved' : 'Rejected'}: ${reason}`, by.actor);
    await this.core.notifySeller(after.seller_id, 'seller.fulfillment.sku_reviewed', { sku: after.sku, approved: body.approve, reason }, { kind: 'queue', id: after.id, ref: after.sku, label: body.approve ? 'Plan an inbound shipment' : 'View SKU', screen: 'seller/inventory' }, `fs:sku:${after.id}:review`);
    await this.core.audit(
      {
        action: 'fulfillment-service.sku.review',
        actionLabel: body.approve ? 'Approved a SKU for Fulfilled by Marketly' : 'Rejected a SKU for Fulfilled by Marketly',
        category: 'catalog',
        target: { type: 'fulfillment_sku', id: after.id, ref: after.sku, label: after.sku, sellerId: after.seller_id, screen: 'admin/sellers' },
        before: { state: before.state, sizeTier: before.size_tier },
        after: { state: after.state, sizeTier: after.size_tier, restrictionReason: after.restriction_reason },
        reason: body.reason?.trim() || null,
        visibleToSeller: true,
      },
      by,
    );
    return this.parts.views.sku(after);
  }

  /** Confirmed sellable stock activates approved or inactive SKUs (inside the confirmation transaction); the activated ones */
  async activateWithStock(tx: FulfillmentServiceRepository, skuIds: readonly string[]): Promise<SkuRec[]> {
    const out: SkuRec[] = [];
    for (const id of new Set(skuIds)) {
      const s = await tx.get('sku_enrollments', id, { forUpdate: true });
      if (s && skuEnrollmentMachine.can(s.state as State, 'activate')) out.push(await tx.update('sku_enrollments', id, { state: skuEnrollmentMachine.next(s.state as State, 'activate') }));
    }
    return out;
  }

  /**
   * After the commit of an activation: the item sells from the service location (inventory.setServiceLocation),
   * then offers hears offer.service_changed (sellable while the enrollment is active).
   */
  async activated(skus: readonly SkuRec[], by: { actor: By['actor']; requestId?: string }) {
    if (!skus.length) return;
    const location = await this.core.serviceLocation();
    if (!location) {
      this.ctx.log.error({ skus: skus.map((s) => s.id) }, 'fulfillment-service: SKUs activated without a service location');
      return;
    }
    const enrollments = new Map((await this.repo.find('enrollments', { seller_id: [...new Set(skus.map((s) => s.seller_id))] })).map((e) => [e.seller_id, e.state]));
    for (const s of skus) {
      if (!(await this.core.setServiceLocation(s, location.locationId, by.actor, { strict: false }))) continue;
      this.core.serviceChanged([s], { fulfilledBy: 'marketly_service', sellable: enrollments.get(s.seller_id) === 'active', reason: 'sku_activated' }, by);
    }
  }

  /* ---------------------------------------------------------------- in-process */

  /** Marketly fulfils the offer, sellable or not: an active SKU, an enrollment still served and a service location */
  async isServiceOffer(offerId: string): Promise<boolean> {
    if (!isUuid(offerId)) return false;
    const sku = await this.repo.findOne('sku_enrollments', { offer_id: offerId, state: 'active' });
    if (!sku) return false;
    const e = await this.repo.findOne('enrollments', { seller_id: sku.seller_id });
    if (!e || !SERVING.includes(e.state)) return false;
    return Boolean(await this.core.serviceLocation());
  }

  /** Customer-facing terms of Marketly-fulfilled offers (null: not Marketly-fulfilled) */
  async serviceTerms(offerIds: readonly string[]): Promise<Record<string, ServiceTerms | null>> {
    const ids = [...new Set(offerIds.filter(isUuid))];
    const out: Record<string, ServiceTerms | null> = Object.fromEntries(offerIds.map((id) => [id, null]));
    if (!ids.length) return out;
    const skus = await this.repo.find('sku_enrollments', { offer_id: ids, state: 'active' });
    if (!skus.length) return out;
    const enrollments = new Map((await this.repo.find('enrollments', { seller_id: [...new Set(skus.map((s) => s.seller_id))] })).map((e) => [e.seller_id, e]));
    const settings = await this.core.serviceSettings();
    const location = await this.core.serviceLocation(settings.locationId);
    if (!location) return out;
    const official = await this.core.soft('shipping', 'official default profile', (s) => s.getOfficialDefaultProfile());
    const profileId = settings.profileId ?? official?.profileId ?? null;
    const businessDays = settings.businessDays ?? official?.handlingDays ?? 1;
    const sameDayCutoff = settings.sameDayCutoff ?? official?.sameDayCutoff ?? null;
    for (const s of skus) {
      const e = enrollments.get(s.seller_id);
      if (!e || !SERVING.includes(e.state) || !s.inventory_item_id) continue;
      const notSellableReason = e.state === 'suspended' ? 'enrollment_suspended' : e.state === 'offboarding' ? 'enrollment_offboarding' : !profileId ? 'service_unavailable' : null;
      out[s.offer_id] = {
        offerId: s.offer_id,
        sellerId: s.seller_id,
        skuEnrollmentId: s.id,
        stockItemId: s.inventory_item_id,
        sellable: !notSellableReason,
        notSellableReason,
        locationId: location.locationId,
        shipsFrom: location.shipsFrom,
        dispatch: { businessDays, sameDayCutoff },
        shippingProfileId: profileId ?? NO_PROFILE,
        parcel: { weightGrams: s.weight_grams, dimensionsCm: s.dimensions },
      };
    }
    return out;
  }

  async serviceLocation(): Promise<ServiceLocation | null> {
    return this.core.serviceLocation();
  }

  /** Seller stock items enrolled in the service are the seller's; anything else in our warehouse is company stock */
  async stockOwner(stockItemId: string): Promise<{ kind: 'company' | 'seller'; sellerId?: string }> {
    const sku = isUuid(stockItemId) ? await this.repo.findOne('sku_enrollments', { inventory_item_id: stockItemId }) : undefined;
    return sku ? { kind: 'seller', sellerId: sku.seller_id } : { kind: 'company' };
  }
}
