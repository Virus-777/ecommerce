/**
 * After approval: receipt (seller address, warehouse dock, or staff for a platform-handled return),
 * inspection with its draft and checklist, evidence, and the remedy: a refund request, or a replacement
 * or exchange with stock reserved through inventory and its own shipment.
 */
import { AppError, isAppError } from '../../../kernel/errors/index.js';
import { isUuid, newId } from '../../../kernel/lib/ids.js';
import { money } from '../../../kernel/lib/money.js';
import { OFFICIAL_STORE_ID } from '../../../spec/common.js';
import type * as common from '../../../spec/common.js';
import type * as offers from '../../../spec/offers.js';
import type { InspectionDraft, InspectionInput, InspectionQueueRow, RemedyInput, Replacement, ReturnEvidence } from '../../../spec/returns.js';
import { replacementMachine, returnMachine, returnShipmentMachine } from '../domain/state-machines.js';
import { actorText, human, is, LIVE_REFUND, type ReturnStatus } from '../domain/rules.js';
import type { ReplacementRec, ReturnRec } from '../ports.js';
import type { ReturnsRepository } from '../repository.js';
import { Batch, illegal, invalid, invalidField, notFound, SYSTEM, type Agg, type By, type Core } from './core.js';
import type { Refunds } from './refunds.js';
import type { Views } from './views.js';

export class Handling {
  constructor(
    private readonly core: Core,
    private readonly views: Views,
    private readonly refunds: Refunds,
  ) {}

  private target(agg: Agg) {
    return { type: 'return', id: agg.ret.id, ref: agg.ret.ref, label: `Return ${agg.ret.ref}`, sellerId: agg.ret.seller_id, screen: 'admin/return' };
  }

  /** Records files a record uses (media usage); media off → the ids are kept as given */
  async attach(ids: string[], kind: 'return_evidence' | 'inspection_photo', refId: string, refLabel: string, owner: { kind: 'seller' | 'staff' | 'customer' | 'guest' | 'platform'; id?: string | null }) {
    const media = this.core.ctx.tryUse('media');
    if (!media || !ids.length) return;
    for (const id of [...new Set(ids)]) await media.attach(id, { module: 'returns', kind, refId, refLabel }, owner);
  }

  /* ---------------------------------------------------------------- receipt */

  async receive(id: string, o: { receivedAt?: string | null; note?: string | null; trackingNumber?: string | null; rescanOk?: boolean }, by: By, agg: Agg): Promise<void> {
    const r = agg.ret;
    if (o.rescanOk && (r.status === 'received' || r.status === 'awaiting_remedy' || r.status === 'completed')) return; // the warehouse scanned it again
    returnMachine.next(r.status as ReturnStatus, 'receive');
    const now = this.core.now();
    const at = o.receivedAt ? new Date(o.receivedAt) : now;
    if (Number.isNaN(at.getTime())) throw invalidField('receivedAt', 'Enter a valid date');
    if (at.getTime() > now.getTime() + 5 * 60_000) throw invalidField('receivedAt', 'The receipt time cannot be in the future');
    await this.core.write(id, by, async (tx, a, batch) => {
      const status = returnMachine.next(a.ret.status as ReturnStatus, 'receive');
      await tx.update('returns', id, { status, received_at: at, updated_at: now });
      const sh = this.core.shipmentOf(a);
      if (sh) {
        const patch: Partial<typeof sh> = { delivered_at: sh.delivered_at ?? at };
        if (returnShipmentMachine.can(sh.status as never, 'deliver')) patch.status = returnShipmentMachine.next(sh.status as never, 'deliver');
        if (o.trackingNumber && !sh.tracking_number) patch.tracking_number = o.trackingNumber;
        await tx.update('return_shipments', sh.id, patch);
      }
      await this.core.timeline(tx, id, [
        { kind: 'received', label: `Return received at ${a.ret.terms_snapshot.meta.destination.name}`, detail: 'It will be inspected next.', visibility: 'customer', actor: by.actor },
        ...(o.note ? [{ kind: 'note', label: 'Receipt note', detail: o.note, visibility: 'seller' as const, actor: by.actor }] : []),
      ]);
      batch.push('returns.return.received', { returnId: id, ...this.core.refs(a.ret), ...this.core.recipient(a.ret), ...this.core.owner(a.ret), items: this.core.returnedItems(a), receivedAt: at.toISOString() });
    });
  }

  /* ---------------------------------------------------------------- inspection */

  async startInspection(id: string, inspectorId: string | null | undefined, by: By, agg: Agg): Promise<InspectionQueueRow> {
    const r = agg.ret;
    if (r.status !== 'received') throw illegal('Only received returns can be inspected', { from: r.status });
    const me = by.actor.id ?? null;
    const target = inspectorId ?? me;
    if (target !== me && !(await by.can?.('returns.requests.manage'))) throw new AppError('FORBIDDEN', 'Assigning another inspector needs returns.requests.manage');
    if (r.inspector?.id === target) return this.views.inspectionRow(agg);
    let name: string | null = target === me ? (by.actor.name ?? null) : null;
    if (target && target !== me) name = ((await this.core.soft('access', 'staff ref', (a) => a.getStaffRef(target))) as { name?: string } | undefined)?.name ?? null;
    const inspector: common.Actor = { kind: 'staff', id: target, name };
    const now = this.core.now();
    await this.core.write(id, by, async (tx, a) => {
      if (a.ret.status !== 'received') throw illegal('Only received returns can be inspected', { from: a.ret.status });
      await tx.update('returns', id, { inspector, inspection_started_at: now, updated_at: now });
      await this.core.timeline(tx, id, [{ kind: 'inspection_started', label: `Inspection started by ${name ?? 'staff'}`, visibility: 'staff', actor: by.actor }]);
    });
    await this.core.audit({ action: 'returns.inspection.start', actionLabel: `Started inspecting return ${r.ref}`, target: this.target(agg), before: { inspector: r.inspector }, after: { inspector } }, by);
    return this.views.inspectionRow((await this.core.load(id))!);
  }

  async saveDraft(id: string, body: { inspection: unknown; remedy?: unknown }, by: By, agg: Agg, withRemedy: boolean): Promise<InspectionDraft> {
    const allowed: ReturnStatus[] = withRemedy ? ['received', 'awaiting_remedy'] : ['received'];
    if (!is(allowed, agg.ret.status)) throw illegal('There is nothing to inspect yet', { from: agg.ret.status });
    const row = await this.core.repo.upsertDraft({ return_id: id, inspection: body.inspection ?? {}, remedy: withRemedy ? (body.remedy ?? null) : (agg.draft?.remedy ?? null), saved_by: by.actor, saved_at: this.core.now() });
    return { inspection: row.inspection, remedy: row.remedy, savedBy: row.saved_by, savedAt: row.saved_at.toISOString() };
  }

  async recordInspection(id: string, input: InspectionInput, by: By, agg: Agg, party: 'seller' | 'staff'): Promise<void> {
    const r = agg.ret;
    returnMachine.next(r.status as ReturnStatus, 'inspect');
    const issues: { path: string; message: string }[] = [];
    if (input.conditionOutcome === 'missing_parts' && !input.missingParts?.length) issues.push({ path: 'missingParts', message: 'List the missing parts' });
    if (input.proposedStockOutcome === 'different_condition' && !input.regradeCondition?.trim()) issues.push({ path: 'regradeCondition', message: 'Say which condition it is sold in, e.g. Used – Like new' });
    (input.checks ?? []).forEach((c, n) => !c.label?.trim() && issues.push({ path: `checks.${n}.label`, message: 'Name the check' }));
    if (issues.length) throw invalid(issues);
    const max = Number(await this.core.ctx.settings.get('maxPhotosPerReturn')) || 6;
    if ((input.mediaIds?.length ?? 0) > max * 2) throw invalidField('mediaIds', `At most ${max * 2} photos`);
    const inspectionId = newId();
    await this.attach(input.mediaIds ?? [], 'inspection_photo', inspectionId, `Inspection of ${r.ref}`, party === 'seller' ? { kind: 'seller', id: r.seller_id } : { kind: 'staff', id: by.actor.id ?? null });
    const now = this.core.now();
    await this.core.write(id, by, async (tx, a, batch) => {
      const status = returnMachine.next(a.ret.status as ReturnStatus, 'inspect');
      await tx.update('returns', id, { status, updated_at: now });
      await tx.insert('inspections', {
        id: inspectionId,
        return_id: id,
        inspected_by: actorText(by.actor),
        inspected_at: now,
        condition_outcome: input.conditionOutcome,
        grade: input.grade,
        checks: (input.checks ?? []).map((c) => ({ key: c.key ?? null, label: c.label.trim(), passed: c.passed })),
        missing_parts: input.missingParts ?? [],
        notes: input.notes?.trim() || null,
        media_ids: input.mediaIds ?? [],
        proposed_stock_outcome: input.proposedStockOutcome,
        regrade_condition: input.regradeCondition?.trim() || null,
        stock_outcome_recorded_by: null,
        stock_outcome_recorded_at: null,
      });
      if (a.draft) await tx.remove('inspection_drafts', id);
      await this.core.timeline(tx, id, [
        { kind: 'inspected', label: `Inspected: ${human(input.conditionOutcome)}`, detail: input.conditionOutcome === 'as_described' ? 'Your refund or replacement follows.' : 'We will explain any change to your refund.', visibility: 'customer', actor: by.actor },
        { kind: 'inspection_detail', label: `Grade ${human(input.grade)}, proposed stock outcome ${human(input.proposedStockOutcome)}`, detail: input.notes ?? null, visibility: 'seller', actor: by.actor },
      ]);
      for (const i of this.core.returnedItems(a)) {
        batch.push('returns.return.inspected', { returnId: id, ...this.core.refs(a.ret), ...this.core.recipient(a.ret), ...this.core.owner(a.ret), conditionOutcome: input.conditionOutcome, proposedStockOutcome: input.proposedStockOutcome, orderItemId: i.orderItemId, variantId: i.variantId, stockItemId: i.stockItemId ?? null, quantity: i.quantity });
      }
    });
    if (party === 'staff') {
      await this.core.audit({ action: 'returns.inspection.record', actionLabel: `Recorded the inspection of return ${r.ref}`, target: this.target(agg), after: input }, by);
    }
  }

  /* ---------------------------------------------------------------- evidence */

  async addEvidence(id: string, body: { kind: ReturnEvidence['kind']; mediaIds: string[]; note?: string | null }, by: By, agg: Agg, party: 'seller' | 'staff'): Promise<ReturnEvidence> {
    if (!body.mediaIds.length && !body.note?.trim()) throw invalidField('mediaIds', 'Add a file or a note');
    const r = agg.ret;
    const evidenceId = newId();
    await this.attach(body.mediaIds, 'return_evidence', r.id, `Return ${r.ref}`, party === 'seller' ? { kind: 'seller', id: r.seller_id } : { kind: 'staff', id: by.actor.id ?? null });
    const now = this.core.now();
    const row = await this.core.repo.insert('return_evidence', { id: evidenceId, return_id: r.id, kind: body.kind, media_ids: body.mediaIds, note: body.note?.trim() || null, party, added_by: by.actor, added_at: now, case_id: null });
    await this.core.timeline(this.core.repo, r.id, [{ kind: 'evidence', label: `Evidence added: ${human(body.kind)}`, detail: body.note ?? null, visibility: 'staff', actor: by.actor }]);
    await this.core.audit({ action: 'returns.evidence.add', actionLabel: `Added evidence to return ${r.ref}`, target: this.target(agg), after: { kind: body.kind, mediaIds: body.mediaIds, note: body.note ?? null }, visibleToSeller: true }, by);
    const refs = await this.views.refs(row.media_ids);
    return this.views.evidenceView(row, refs);
  }

  /* ---------------------------------------------------------------- remedy */

  /**
   * seller: the seller approves its own refund (requested → approved → processing); staff (Official Store or
   * platform-handled): the refund request goes to Finance as under_review. Replacements reserve stock.
   */
  async remedy(id: string, input: RemedyInput, by: By, agg: Agg, mode: 'seller' | 'admin'): Promise<void> {
    const r = agg.ret;
    if (mode === 'seller') this.core.sellerMayAct(r);
    if (mode === 'seller' && r.platform_handling) throw illegal('Marketly is handling this return now', { from: r.status });
    if (mode === 'admin' && r.owner_type === 'seller' && !r.platform_handling) throw illegal('The seller decides the remedy unless Marketly takes over', { from: r.status });
    if (r.status !== 'awaiting_remedy') throw illegal('Inspect the return before deciding the remedy', { from: r.status, allowed: [] });
    const live = agg.refunds.find((x) => is(LIVE_REFUND, x.status));
    // retry of a seller refund whose hand-over did not go through (idempotent endpoint)
    if (live && mode === 'seller' && live.status === 'requested' && live.source === 'seller') {
      await this.refunds.approveAndHandOver(live.id, by.actor, by);
      return;
    }
    if (live) throw this.refunds.duplicate(live);
    if (agg.replacements.some((x) => x.status !== 'cancelled')) throw illegal('A replacement is already on its way', { from: r.status });
    if (input.kind === 'replacement' || input.kind === 'exchange') {
      await this.createReplacement(agg, input, by);
      if (agg.draft) await this.core.repo.remove('inspection_drafts', id);
    } else {
      const plan = await this.refunds.plan(agg, input);
      const ref = await this.core.refundRef();
      const rr = await this.core.write(id, by, async (tx, a, batch) => {
        if (a.ret.status !== 'awaiting_remedy') throw illegal('The return changed; reload it', { from: a.ret.status });
        const rec = await this.refunds.insertForReturn(tx, a, plan, { source: mode === 'seller' ? 'seller' : 'return', status: mode === 'seller' ? 'requested' : 'under_review', by, reasonCode: input.kind, reason: input.explanation ?? null, ref });
        if (a.draft) await tx.remove('inspection_drafts', id);
        if (mode === 'admin') batch.push('returns.refund.requested', { refundRequestId: rec.id, orderId: rec.order_id, total: { amount: rec.total, currency: rec.currency }, source: rec.source });
        return rec;
      });
      if (mode === 'seller') await this.refunds.approveAndHandOver(rr.id, by.actor, by);
    }
    if (mode === 'admin') await this.core.audit({ action: 'returns.remedy.decide', actionLabel: `Decided the remedy for return ${r.ref}: ${human(input.kind)}`, category: 'financial', target: this.target(agg), after: input, reason: input.explanation ?? null }, by);
  }

  /* ---------------------------------------------------------------- replacements */

  /**
   * The offer an exchange takes its unit from: another variant of the same product, sold by the same seller,
   * at the original unit price (different-price exchanges are phase 4). offers is optional: without it
   * exchanges are refused with REMEDY_NOT_AVAILABLE.
   */
  async exchangeOffer(o: { ownerType: 'official' | 'seller'; sellerId: string | null; productId: string; unitPrice: number; variantId: string }): Promise<offers.Offer> {
    const api = this.core.ctx.tryUse('offers');
    if (!api) throw this.core.error('REMEDY_NOT_AVAILABLE', 'Exchanges are not available right now; choose a refund instead', { remedy: 'exchange' });
    const owner = o.ownerType === 'official' ? OFFICIAL_STORE_ID : o.sellerId;
    if (!owner) throw this.core.error('EXCHANGE_NOT_ALLOWED', 'This item cannot be exchanged', { reason: 'different_seller' });
    const list = (await api.listOwnOffersForProduct(owner, [o.productId]))[o.productId] ?? [];
    const forVariant = list.filter((x) => x.variantId === o.variantId && x.productId === o.productId);
    if (!forVariant.length) throw this.core.error('EXCHANGE_NOT_ALLOWED', 'Choose another size or color of the same product from the same seller', { reason: 'different_product', variantId: o.variantId });
    const own = forVariant.filter((x) => x.ownerType === o.ownerType && (o.ownerType === 'official' || x.sellerId === o.sellerId));
    if (!own.length) throw this.core.error('EXCHANGE_NOT_ALLOWED', 'This size or color is not sold by the same seller', { reason: 'different_seller', variantId: o.variantId });
    const live = own.filter((x) => x.status === 'active' || x.status === 'out_of_stock');
    if (!live.length) throw this.core.error('EXCHANGE_NOT_ALLOWED', 'This size or color is not sold right now', { reason: 'not_offered', variantId: o.variantId });
    const same = live.find((x) => x.price.amount === o.unitPrice);
    if (!same) throw this.core.error('EXCHANGE_NOT_ALLOWED', 'Exchanges are only for the same price; return the item for a refund instead', { reason: 'different_price', variantId: o.variantId, unitPrice: money(o.unitPrice, live[0]!.price.currency), price: live[0]!.price });
    return same;
  }

  /** The stock item (and its offer) a replacement or exchange takes units from */
  private async source(agg: Agg, input: RemedyInput): Promise<{ variantId: string; stockItemId: string; offerId: string; kind: 'replacement' | 'exchange' }> {
    const r = agg.ret;
    const item = agg.items[0]!;
    const meta = r.terms_snapshot.meta;
    if (input.kind === 'replacement') {
      const stockItemId = meta.stockItems?.[item.order_item_id];
      const offerId = meta.offers?.[item.order_item_id];
      if (!stockItemId || !offerId) throw this.core.error('REMEDY_NOT_AVAILABLE', 'A replacement is not available for this item', { remedy: 'replacement' });
      return { variantId: item.variant_id, stockItemId, offerId, kind: 'replacement' };
    }
    const variantId = input.exchangeVariantId ?? r.exchange_variant_id;
    if (!variantId) throw invalidField('exchangeVariantId', 'Choose the variant to exchange for');
    const offer = await this.exchangeOffer({ ownerType: r.owner_type, sellerId: r.seller_id, productId: item.product_id, unitPrice: item.unit_price, variantId });
    return { variantId, stockItemId: offer.stockItemId, offerId: offer.id, kind: 'exchange' };
  }

  /** Whether a replacement or exchange can be offered (stock and terms) */
  async checkReplacement(agg: Agg, input: RemedyInput): Promise<void> {
    const remedies = agg.ret.terms_snapshot.terms.remedies;
    if (!remedies.includes(input.kind as 'replacement' | 'exchange')) throw this.core.error('REMEDY_NOT_AVAILABLE', `${human(input.kind)} is not offered for this item`, { remedy: input.kind });
    const s = await this.source(agg, input);
    const quantity = agg.items.reduce((n, i) => n + i.quantity, 0);
    const avail = await this.core.ctx.use('inventory').getAvailability([s.stockItemId]);
    if ((avail[s.stockItemId]?.available ?? 0) < quantity) throw this.core.error('REMEDY_NOT_AVAILABLE', 'No stock left for a replacement; offer a refund instead', { remedy: input.kind });
  }

  /**
   * Allocates replacement stock with inventory.allocateForOrder (no expiry, so a slow seller or warehouse
   * never loses the unit). No stock → REMEDY_NOT_AVAILABLE.
   */
  private async allocate(o: { key: string; orderId: string; orderRef?: string; kind: 'replacement' | 'exchange'; replacementId: string; ref?: string; stockItemId: string; quantity: number; orderItemId: string; actor: common.Actor }): Promise<string> {
    try {
      const reservation = await this.core.ctx.use('inventory').allocateForOrder({
        key: o.key,
        orderId: o.orderId,
        ...(o.orderRef ? { orderRef: o.orderRef } : {}),
        source: { kind: o.kind, id: o.replacementId, ...(o.ref ? { ref: o.ref } : {}) },
        lines: [{ stockItemId: o.stockItemId, quantity: o.quantity, orderItemId: o.orderItemId }],
        actor: o.actor,
      });
      return reservation.id;
    } catch (err) {
      if (isAppError(err) && /STOCK|RESERV/.test(err.code)) throw this.core.error('REMEDY_NOT_AVAILABLE', 'No stock left for a replacement; offer a refund instead', { remedy: o.kind });
      throw err;
    }
  }

  /** Releases a replacement's allocation (cancelled replacement); a failure is logged, never thrown */
  private async release(reservationId: string | null, reason: string) {
    if (!reservationId) return;
    try {
      await this.core.ctx.use('inventory').releaseHold(reservationId, reason);
    } catch (err) {
      this.core.ctx.log.warn({ err, reservationId }, 'returns: replacement allocation could not be released');
    }
  }

  async createReplacement(agg: Agg, input: RemedyInput, by: By): Promise<void> {
    const r = agg.ret;
    const remedies = r.terms_snapshot.terms.remedies;
    if (!remedies.includes(input.kind as 'replacement' | 'exchange')) throw this.core.error('REMEDY_NOT_AVAILABLE', `${human(input.kind)} is not offered for this item`, { remedy: input.kind });
    const s = await this.source(agg, input);
    const item = agg.items.find((i) => i.variant_id === s.variantId) ?? agg.items[0]!;
    const quantity = agg.items.reduce((n, i) => n + i.quantity, 0);
    const replacementId = newId();
    // one allocation per attempt: a replacement cancelled for lack of stock can be tried again later
    const reservationId = await this.allocate({ key: `replacement:${r.id}:${agg.replacements.length + 1}`, orderId: r.order_id, orderRef: r.order_ref, kind: s.kind, replacementId, ref: r.ref, stockItemId: s.stockItemId, quantity, orderItemId: item.order_item_id, actor: by.actor });
    const now = this.core.now();
    try {
      await this.core.write(r.id, by, async (tx, a, batch) => {
        if (a.replacements.some((x) => x.status !== 'cancelled')) throw illegal('A replacement is already on its way', { from: a.ret.status });
        await tx.insert('replacements', {
          id: replacementId,
          return_id: r.id,
          case_id: null,
          order_id: r.order_id,
          kind: s.kind,
          status: replacementMachine.next('pending', 'reserve'),
          order_item_id: item.order_item_id,
          variant_id: s.variantId,
          offer_id: s.offerId,
          quantity,
          reservation_id: reservationId,
          shipping_shipment_id: null,
          cancel_reason: null,
          idempotency_key: null,
          created_at: now,
          shipped_at: null,
          delivered_at: null,
        });
        await this.core.timeline(tx, r.id, [{ kind: 'replacement', label: s.kind === 'exchange' ? 'Exchange on the way' : 'Replacement on the way', detail: `${item.title} × ${quantity}, no charge`, visibility: 'customer', actor: by.actor }]);
        batch.push('returns.replacement.created', { replacementId, returnId: r.id, caseId: null, orderId: r.order_id, ...this.core.recipient(a.ret), orderItemId: item.order_item_id, ownerType: r.owner_type, sellerId: r.seller_id, variantId: s.variantId, offerId: s.offerId, quantity, kind: s.kind });
      });
    } catch (err) {
      await this.release(reservationId, 'The replacement could not be recorded');
      throw err;
    }
  }

  /**
   * A replacement decided on a support case without a return (lost or damaged parcel). Same variant by
   * default; variantId only for a same-product, same-price exchange. Same key returns the same replacement.
   */
  async requestReplacement(input: { caseId: string; orderId: string; orderItemId: string; quantity: number; variantId?: string; reason: string; requestedBy: common.Actor }, idempotencyKey: string): Promise<Replacement> {
    const key = idempotencyKey?.trim() || `case:${input.caseId}:${input.orderItemId}`;
    const existing = (await this.core.repo.find('replacements', { idempotency_key: key }))[0];
    if (existing) return this.replacementView(existing);
    if (!input.reason?.trim()) throw invalidField('reason', 'Say why the item is replaced');
    const orders = this.core.ctx.use('orders');
    const info = isUuid(input.orderItemId) ? await orders.getOrderItem(input.orderItemId) : null;
    if (!info || info.orderId !== input.orderId) throw notFound('Order item');
    if (!['shipped', 'delivered', 'return_requested', 'returned'].includes(info.state)) throw this.core.error('REMEDY_NOT_AVAILABLE', 'A replacement is only possible once the item was delivered or reported lost', { remedy: 'replacement', state: info.state });
    if (!Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > info.quantity) throw invalidField('quantity', `Replace 1 to ${info.quantity} units`);
    const order = await orders.getOrder(info.orderId);
    const line = order?.groups.flatMap((g) => g.items).find((i) => i.id === info.id);
    let kind: 'replacement' | 'exchange' = 'replacement';
    let variantId = info.variantId;
    let stockItemId = info.stockItemId;
    let offerId = info.offerId;
    if (input.variantId && input.variantId !== info.variantId) {
      const offer = await this.exchangeOffer({ ownerType: info.ownerType, sellerId: info.sellerId ?? null, productId: info.productId, unitPrice: line?.unitPrice.amount ?? -1, variantId: input.variantId });
      kind = 'exchange';
      variantId = input.variantId;
      stockItemId = offer.stockItemId;
      offerId = offer.id;
    }
    // a return on the same case covering the item takes the replacement (it completes when the replacement ships)
    const open = await this.core.repo.find('returns', { case_id: input.caseId, order_id: info.orderId, status: { op: 'not in', value: ['completed', 'cancelled', 'rejected'] } });
    const covering = open.length ? await this.core.repo.find('return_items', { return_id: open.map((r) => r.id), order_item_id: info.id }) : [];
    const ret = open.find((r) => covering.some((i) => i.return_id === r.id)) ?? null;
    if (ret) {
      const live = (await this.core.repo.find('replacements', { return_id: ret.id })).find((x) => x.status !== 'cancelled');
      if (live) return this.replacementView(live);
    }
    const replacementId = newId();
    const reservationId = await this.allocate({ key: `replacement:case:${key}`, orderId: info.orderId, orderRef: info.orderRef, kind, replacementId, stockItemId, quantity: input.quantity, orderItemId: info.id, actor: input.requestedBy });
    const now = this.core.now();
    let row: ReplacementRec;
    try {
      row = await this.core.repo.insert('replacements', {
        id: replacementId,
        return_id: ret?.id ?? null,
        case_id: input.caseId,
        order_id: info.orderId,
        kind,
        status: replacementMachine.next('pending', 'reserve'),
        order_item_id: info.id,
        variant_id: variantId,
        offer_id: offerId,
        quantity: input.quantity,
        reservation_id: reservationId,
        shipping_shipment_id: null,
        cancel_reason: null,
        idempotency_key: key,
        created_at: now,
        shipped_at: null,
        delivered_at: null,
      });
    } catch (err) {
      // a concurrent call with the same key won: answer with its replacement
      const again = (await this.core.repo.find('replacements', { idempotency_key: key }))[0];
      if (again) return this.replacementView(again);
      await this.release(reservationId, 'The replacement could not be recorded');
      throw err;
    }
    if (ret) await this.core.timeline(this.core.repo, ret.id, [{ kind: 'replacement', label: kind === 'exchange' ? 'Exchange on the way' : 'Replacement on the way', detail: `Decided on the support case, × ${input.quantity}, no charge`, visibility: 'customer', actor: input.requestedBy }]);
    this.core.publish(
      'returns.replacement.created',
      {
        replacementId,
        returnId: ret?.id ?? null,
        caseId: input.caseId,
        orderId: info.orderId,
        customerId: info.customerId ?? order?.contact.customerId ?? null,
        contactEmail: order?.contact.email ?? null,
        orderItemId: info.id,
        ownerType: info.ownerType,
        sellerId: info.ownerType === 'seller' ? (info.sellerId ?? null) : null,
        variantId,
        offerId,
        quantity: input.quantity,
        kind,
      },
      { actor: input.requestedBy },
    );
    await this.core.audit(
      {
        action: 'returns.replacement.create',
        actionLabel: `Created a ${kind} for order ${info.orderRef} (case decision)`,
        target: { type: 'replacement', id: replacementId, ref: info.orderRef, label: `${kind === 'exchange' ? 'Exchange' : 'Replacement'} for ${info.orderRef}`, sellerId: info.sellerId ?? null, screen: 'admin/order' },
        relatedTargets: [{ type: 'order', id: info.orderId, ref: info.orderRef }],
        after: { caseId: input.caseId, orderItemId: info.id, quantity: input.quantity, variantId, kind },
        reason: input.reason,
      },
      { actor: input.requestedBy },
    );
    return this.replacementView(row, line ? { title: line.title, options: line.product.options ?? {}, variantId: line.product.variantId } : undefined);
  }

  /** A replacement in the API shape; items of a return come from the return, others from the order */
  async replacementView(rep: ReplacementRec, item?: { title: string; options: Record<string, string>; variantId: string }): Promise<Replacement> {
    if (!item && rep.return_id) {
      const agg = await this.core.load(rep.return_id);
      if (agg) return this.views.replacement(rep, agg);
    }
    if (!item) {
      const order = await this.core.quiet('order for replacement', () => this.core.ctx.use('orders').getOrder(rep.order_id));
      const line = order?.groups.flatMap((g) => g.items).find((i) => i.id === rep.order_item_id);
      if (line) item = { title: line.title, options: line.product.options ?? {}, variantId: line.product.variantId };
    }
    return this.views.replacementOf(rep, item);
  }

  /** Who owns a replacement (its return's seller, or the order item's for case replacements) */
  private async ownerOf(rep: ReplacementRec): Promise<{ ownerType: 'official' | 'seller'; sellerId: string | null; ret?: ReturnRec } | null> {
    if (rep.return_id) {
      const ret = await this.core.repo.get('returns', rep.return_id);
      return ret ? { ownerType: ret.owner_type, sellerId: ret.seller_id, ret } : null;
    }
    const info = await this.core.quiet('order item owner', () => this.core.ctx.use('orders').getOrderItem(rep.order_item_id));
    return info ? { ownerType: info.ownerType, sellerId: info.ownerType === 'seller' ? (info.sellerId ?? null) : null } : null;
  }

  /**
   * Cancels a replacement or exchange not shipped yet (seller: its own; staff: any): releases the allocation
   * and publishes returns.replacement.cancelled. A return goes back to awaiting a remedy so a refund can be
   * issued instead; support hears about case replacements through the event.
   */
  async cancelReplacement(id: string, reason: string, by: By, viewer: { area: 'admin' } | { area: 'seller'; sellerId: string }): Promise<Replacement> {
    const rep = isUuid(id) ? await this.core.repo.get('replacements', id) : undefined;
    if (!rep) throw notFound('Replacement');
    const owner = await this.ownerOf(rep);
    if (viewer.area === 'seller' && (!owner || owner.ownerType !== 'seller' || owner.sellerId !== viewer.sellerId)) throw notFound('Replacement');
    if (viewer.area === 'seller' && owner?.ret) this.core.sellerMayAct(owner.ret);
    if (!reason?.trim()) throw invalidField('reason', 'Say why the replacement is cancelled');
    const why = reason.trim();
    const now = this.core.now();
    const { before, after } = await this.core.repo.transaction(async (tx) => {
      const before = (await tx.get('replacements', id, { forUpdate: true }))!;
      const status = replacementMachine.next(before.status as Replacement['status'], 'cancel');
      const after = await tx.update('replacements', id, { status, cancel_reason: why });
      if (after.return_id) {
        await this.core.timeline(tx, after.return_id, [
          { kind: 'replacement_cancelled', label: after.kind === 'exchange' ? 'Exchange cancelled' : 'Replacement cancelled', detail: why, visibility: 'customer', actor: by.actor },
        ]);
      }
      return { before, after };
    });
    void now;
    await this.release(before.reservation_id, why);
    this.core.publish(
      'returns.replacement.cancelled',
      { replacementId: id, returnId: after.return_id, caseId: after.case_id, orderId: after.order_id, orderItemId: after.order_item_id, ownerType: owner?.ownerType ?? 'official', sellerId: owner?.sellerId ?? null, reason: why, by: by.actor },
      by,
    );
    await this.core.audit(
      {
        action: 'returns.replacement.cancel',
        actionLabel: `Cancelled ${after.kind === 'exchange' ? 'an exchange' : 'a replacement'}`,
        target: { type: 'replacement', id, label: after.kind === 'exchange' ? 'Exchange' : 'Replacement', sellerId: owner?.sellerId ?? null, screen: 'admin/returns' },
        relatedTargets: [{ type: 'order', id: after.order_id }],
        before: { status: before.status },
        after: { status: after.status },
        reason: why,
        visibleToSeller: true,
      },
      by,
    );
    return this.replacementView(after);
  }

  /** The live replacement a shipping event is about: by return, or (case replacements) by order and items */
  async replacementFor(e: { returnId?: string | null; orderId: string; lines: { orderItemId: string }[]; shipmentId: string }): Promise<ReplacementRec | undefined> {
    const byShipment = isUuid(e.shipmentId) ? (await this.core.repo.find('replacements', { shipping_shipment_id: e.shipmentId }))[0] : undefined;
    if (byShipment) return byShipment;
    if (isUuid(e.returnId)) return (await this.core.repo.find('replacements', { return_id: e.returnId }, { orderBy: [['created_at', 'desc']] })).find((x) => x.status !== 'cancelled');
    if (!isUuid(e.orderId)) return undefined;
    const items = new Set(e.lines.map((l) => l.orderItemId));
    const rows = await this.core.repo.find('replacements', { order_id: e.orderId, return_id: null, status: ['pending', 'reserved', 'shipped'] }, { orderBy: [['created_at', 'asc']] });
    return rows.find((x) => items.has(x.order_item_id)) ?? (items.size ? undefined : rows[0]);
  }

  /** shipping.shipment.dispatched for a replacement shipment: shipped; a return awaiting its remedy completes */
  async replacementShipped(rep: ReplacementRec, shipmentId: string, at: string): Promise<void> {
    const batch = new Batch({ actor: SYSTEM });
    await this.core.repo.transaction(async (tx: ReturnsRepository) => {
      const ret = rep.return_id ? await tx.get('returns', rep.return_id, { forUpdate: true }) : undefined;
      const locked = (await tx.get('replacements', rep.id, { forUpdate: true }))!;
      if (!['pending', 'reserved'].includes(locked.status)) return;
      let status = locked.status as 'pending' | 'reserved' | 'shipped';
      if (status === 'pending') status = replacementMachine.next('pending', 'reserve') as 'reserved';
      status = replacementMachine.next(status, 'ship') as 'shipped';
      await tx.update('replacements', rep.id, { status, shipping_shipment_id: shipmentId, shipped_at: new Date(at) });
      if (!ret) return;
      await this.core.timeline(tx, ret.id, [{ kind: 'replacement_shipped', label: locked.kind === 'exchange' ? 'Exchange shipped' : 'Replacement shipped', visibility: 'customer' }]);
      if (ret.status === 'awaiting_remedy') {
        const outcome = locked.kind === 'exchange' ? 'exchanged' : 'replaced';
        const now = this.core.now();
        await tx.update('returns', ret.id, { status: returnMachine.next('awaiting_remedy', 'complete'), completed_at: now, updated_at: now, terms_snapshot: { ...ret.terms_snapshot, meta: { ...ret.terms_snapshot.meta, outcome } } });
        batch.push('returns.return.completed', { returnId: ret.id, ...this.core.refs(ret), outcome });
      }
    });
    this.core.flush(batch);
  }

  async replacementDelivered(rep: ReplacementRec, shipmentId: string, at: string): Promise<void> {
    await this.replacementShipped(rep, shipmentId, at);
    const fresh = await this.core.repo.get('replacements', rep.id);
    if (!fresh || fresh.status !== 'shipped') return;
    await this.core.repo.update('replacements', rep.id, { status: replacementMachine.next('shipped', 'deliver'), delivered_at: new Date(at) });
    if (fresh.return_id) await this.core.timeline(this.core.repo, fresh.return_id, [{ kind: 'replacement_delivered', label: fresh.kind === 'exchange' ? 'Exchange delivered' : 'Replacement delivered', detail: 'It has a new 30-day return window.', visibility: 'customer' }]);
  }
}
