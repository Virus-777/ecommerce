/**
 * After approval: receipt (seller address, warehouse dock, or staff for a platform-handled return),
 * inspection with its draft and checklist, evidence, and the remedy: a refund request, or a replacement
 * or exchange with stock reserved through inventory and its own shipment.
 */
import { AppError, isAppError } from '../../../kernel/errors/index.js';
import { newId } from '../../../kernel/lib/ids.js';
import type * as common from '../../../spec/common.js';
import type { InspectionDraft, InspectionInput, InspectionQueueRow, RemedyInput, ReturnEvidence } from '../../../spec/returns.js';
import { replacementMachine, returnMachine, returnShipmentMachine } from '../domain/state-machines.js';
import { actorText, human, is, LIVE_REFUND, type ReturnStatus } from '../domain/rules.js';
import type { ReturnsRepository } from '../ports.js';
import { Batch, illegal, invalid, invalidField, SYSTEM, type Agg, type By, type Core } from './core.js';
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
      await tx.update('returns', id, { status, updated_at: now });
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
      // the timeline row carries the receipt time
      await tx.insert('return_events', { id: newId(), return_id: id, kind: 'received_at', label: 'Parcel received', detail: at.toISOString(), visibility: 'staff', actor_kind: by.actor.kind, actor_id: by.actor.id ?? null, at });
      batch.push('returns.return.received', { returnId: id, ...this.core.recipient(a.ret), ownerType: a.ret.owner_type, sellerId: a.ret.seller_id, items: this.core.returnedItems(a), receivedAt: at.toISOString() });
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
      for (const i of a.items) {
        batch.push('returns.return.inspected', { returnId: id, ...this.core.recipient(a.ret), ownerType: a.ret.owner_type, sellerId: a.ret.seller_id, conditionOutcome: input.conditionOutcome, proposedStockOutcome: input.proposedStockOutcome, variantId: i.variant_id, quantity: i.quantity });
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
    const stock = await this.core.ctx.use('inventory').listStockForVariants([variantId], r.seller_id ? { sellerId: r.seller_id } : {});
    const candidates = (stock[variantId] ?? []).filter((s) => s.ownerType === r.owner_type && (r.owner_type === 'official' || s.sellerId === r.seller_id) && s.offerId);
    const pick = candidates[0];
    if (!pick?.offerId) throw this.core.error('REMEDY_NOT_AVAILABLE', 'This variant is not sold by the same seller', { remedy: 'exchange', variantId });
    return { variantId, stockItemId: pick.id, offerId: pick.offerId, kind: 'exchange' };
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

  async createReplacement(agg: Agg, input: RemedyInput, by: By): Promise<void> {
    const r = agg.ret;
    const remedies = r.terms_snapshot.terms.remedies;
    if (!remedies.includes(input.kind as 'replacement' | 'exchange')) throw this.core.error('REMEDY_NOT_AVAILABLE', `${human(input.kind)} is not offered for this item`, { remedy: input.kind });
    const s = await this.source(agg, input);
    const item = agg.items.find((i) => i.variant_id === s.variantId) ?? agg.items[0]!;
    const quantity = agg.items.reduce((n, i) => n + i.quantity, 0);
    const replacementId = newId();
    let reservationId: string;
    try {
      const hold = await this.core.ctx.use('inventory').hold(`replacement:${r.id}:${s.stockItemId}`, [{ stockItemId: s.stockItemId, quantity }], 14 * 24 * 60);
      reservationId = hold.id;
    } catch (err) {
      if (isAppError(err) && /STOCK|RESERV/.test(err.code)) throw this.core.error('REMEDY_NOT_AVAILABLE', 'No stock left for a replacement; offer a refund instead', { remedy: input.kind });
      throw err;
    }
    await this.core.quiet('attach replacement hold', () => this.core.ctx.use('inventory').attachOrder(reservationId, r.order_id, [{ stockItemId: s.stockItemId, orderItemId: item.order_item_id }]));
    const now = this.core.now();
    await this.core.write(r.id, by, async (tx, a, batch) => {
      if (a.replacements.some((x) => x.status !== 'cancelled')) throw illegal('A replacement is already on its way', { from: a.ret.status });
      await tx.insert('replacements', {
        id: replacementId,
        return_id: r.id,
        kind: s.kind,
        status: replacementMachine.next('pending', 'reserve'),
        order_item_id: item.order_item_id,
        variant_id: s.variantId,
        offer_id: s.offerId,
        quantity,
        reservation_id: reservationId,
        shipping_shipment_id: null,
        cancel_reason: null,
        created_at: now,
        shipped_at: null,
        delivered_at: null,
      });
      await this.core.timeline(tx, r.id, [{ kind: 'replacement', label: s.kind === 'exchange' ? 'Exchange on the way' : 'Replacement on the way', detail: `${item.title} × ${quantity}, no charge`, visibility: 'customer', actor: by.actor }]);
      batch.push('returns.replacement.created', { replacementId, returnId: r.id, orderId: r.order_id, ...this.core.recipient(a.ret), orderItemId: item.order_item_id, ownerType: r.owner_type, sellerId: r.seller_id, variantId: s.variantId, offerId: s.offerId, quantity, kind: s.kind });
    });
  }

  /** shipping events for a replacement shipment (matched by return) */
  async replacementShipped(returnId: string, shipmentId: string, at: string): Promise<void> {
    const batch = new Batch({ actor: SYSTEM });
    await this.core.repo.transaction(async (tx: ReturnsRepository) => {
      const ret = await tx.get('returns', returnId, { forUpdate: true });
      if (!ret) return;
      const rep = (await tx.find('replacements', { return_id: returnId }, { orderBy: [['created_at', 'desc']] })).find((x) => x.status !== 'cancelled');
      if (!rep || !['pending', 'reserved'].includes(rep.status)) return;
      let status = rep.status as 'pending' | 'reserved' | 'shipped';
      if (status === 'pending') status = replacementMachine.next('pending', 'reserve') as 'reserved';
      status = replacementMachine.next(status, 'ship') as 'shipped';
      await tx.update('replacements', rep.id, { status, shipping_shipment_id: shipmentId, shipped_at: new Date(at) });
      await this.core.timeline(tx, returnId, [{ kind: 'replacement_shipped', label: rep.kind === 'exchange' ? 'Exchange shipped' : 'Replacement shipped', visibility: 'customer' }]);
      if (ret.status === 'awaiting_remedy') {
        const outcome = rep.kind === 'exchange' ? 'exchanged' : 'replaced';
        const now = this.core.now();
        await tx.update('returns', returnId, { status: returnMachine.next('awaiting_remedy', 'complete'), completed_at: now, updated_at: now, terms_snapshot: { ...ret.terms_snapshot, meta: { ...ret.terms_snapshot.meta, outcome } } });
        batch.push('returns.return.completed', { returnId, outcome });
      }
    });
    this.core.flush(batch);
  }

  async replacementDelivered(returnId: string, shipmentId: string, at: string): Promise<void> {
    await this.replacementShipped(returnId, shipmentId, at);
    const rep = (await this.core.repo.find('replacements', { return_id: returnId, status: 'shipped' }))[0];
    if (!rep) return;
    await this.core.repo.update('replacements', rep.id, { status: replacementMachine.next('shipped', 'deliver'), delivered_at: new Date(at) });
    await this.core.timeline(this.core.repo, returnId, [{ kind: 'replacement_delivered', label: rep.kind === 'exchange' ? 'Exchange delivered' : 'Replacement delivered', detail: 'It has a new 30-day return window.', visibility: 'customer' }]);
  }
}
