/**
 * Inbound shipments from a seller to our warehouse: plan (lines, boxes, ship-from), submit (labels; the units
 * become Inbound), ship, cancel, arrival at the dock (Inbound → Receiving), receiving counts (sellable units
 * become Available seller-owned stock in inventory, damaged units Unsellable; receiving and labelling fees),
 * discrepancies the seller accepts or claims, staff decisions (adjust stock, reimburse within limits, reject)
 * and the daily overdue sweep.
 */
import { AppError } from '../../../kernel/errors/index.js';
import type { EventPayload } from '../../../kernel/events/index.js';
import { isUuid, newId } from '../../../kernel/lib/ids.js';
import type { PageRequest } from '../../../kernel/lib/pagination.js';
import type * as common from '../../../spec/common.js';
import type { InboundInput, InboundShipment, ReceivingInput } from '../../../spec/fulfillment-service.js';
import { inboundShipmentMachine } from '../domain/state-machines.js';
import { actorText, addDays, cubicFeet, physicalUnits, plural, qty, REIMBURSEMENT, round4, SYSTEM } from '../domain/rules.js';
import type { EnrollmentRec, InboundLineRec, InboundRec, SkuRec } from '../ports.js';
import { invalid, notFound, Part, type By } from './core.js';

type State = InboundShipment['state'];

export const REIMBURSE_ACTION = 'fulfillment-service.reimbursements.approve';
export const DISCREPANCY_TARGET = 'inbound_discrepancy';
const LINE_STATES = ['approved', 'active', 'inactive'];
const OPEN = ['draft', 'submitted', 'in_transit', 'arrived', 'receiving', 'received'];

export class InboundPart extends Part {
  /* ---------------------------------------------------------------- reads */

  async ownInbound(sellerId: string | null, id: string): Promise<InboundRec> {
    const row = isUuid(id) ? await this.repo.get('inbound_shipments', id) : undefined;
    if (!row || (sellerId && row.seller_id !== sellerId)) throw notFound('Inbound shipment');
    return row;
  }

  async get(sellerId: string | null, id: string): Promise<InboundShipment> {
    return this.parts.views.inbound(await this.ownInbound(sellerId, id), { labels: true });
  }

  async list(sellerId: string, q: { state?: string }, page: PageRequest) {
    const res = await this.repo.page('inbound_shipments', { seller_id: sellerId, ...(q.state ? { state: q.state } : {}) }, page, { order: { column: 'created_at', direction: 'desc' } });
    return { ...res, items: await this.parts.views.inbounds(res.items) };
  }

  async listAdmin(q: { state?: string; sellerId?: string; expectedFrom?: string; expectedTo?: string }, page: PageRequest) {
    const where: Record<string, unknown> = {};
    if (q.state) where.state = q.state;
    if (q.sellerId) where.seller_id = q.sellerId;
    if (q.expectedFrom && q.expectedTo) where.expected_arrival = { op: 'between', value: [q.expectedFrom, q.expectedTo] };
    else if (q.expectedFrom) where.expected_arrival = { op: '>=', value: q.expectedFrom };
    else if (q.expectedTo) where.expected_arrival = { op: '<=', value: q.expectedTo };
    const res = await this.repo.page('inbound_shipments', where, page, { order: { column: 'created_at', direction: 'desc' } });
    return { ...res, items: await this.parts.views.inbounds(res.items) };
  }

  /** Open shipments of a seller (overview) */
  async open(sellerId: string): Promise<InboundShipment[]> {
    const rows = await this.repo.find('inbound_shipments', { seller_id: sellerId, state: OPEN }, { orderBy: [['created_at', 'desc']], limit: 20 });
    return this.parts.views.inbounds(rows);
  }

  /* ---------------------------------------------------------------- seller: plan, submit, ship, cancel */

  /** Lines of SKUs the seller has enrolled and may send */
  private async checkLines(sellerId: string, input: InboundInput): Promise<Map<string, SkuRec>> {
    const issues: { path: string; message: string }[] = [];
    if (!input.lines?.length) issues.push({ path: 'lines', message: 'Add at least one SKU to send' });
    if (!Number.isInteger(input.boxes) || input.boxes < 1) issues.push({ path: 'boxes', message: 'Enter the number of boxes, at least 1' });
    const seen = new Set<string>();
    input.lines?.forEach((l, i) => {
      if (!Number.isInteger(l.quantity) || l.quantity < 1) issues.push({ path: `lines[${i}].quantity`, message: 'Quantity must be at least 1' });
      if (seen.has(l.skuEnrollmentId)) issues.push({ path: `lines[${i}].skuEnrollmentId`, message: 'Each SKU appears once per shipment' });
      seen.add(l.skuEnrollmentId);
    });
    const skus = new Map((await this.repo.find('sku_enrollments', { id: [...seen].filter(isUuid), seller_id: sellerId })).map((s) => [s.id, s]));
    input.lines?.forEach((l, i) => {
      const s = skus.get(l.skuEnrollmentId);
      if (!s) issues.push({ path: `lines[${i}].skuEnrollmentId`, message: 'Not one of your enrolled SKUs' });
      else if (!LINE_STATES.includes(s.state)) issues.push({ path: `lines[${i}].skuEnrollmentId`, message: s.state === 'pending' ? `${s.sku} is waiting for approval` : `${s.sku} can't be sent to our warehouse` });
    });
    if (input.expectedArrival && input.expectedArrival < this.core.today()) issues.push({ path: 'expectedArrival', message: 'The expected arrival date has passed' });
    if (issues.length) throw invalid(issues);
    return skus;
  }

  /** Stored volume + shipments on the way + this one must fit the storage allowance */
  private async checkCapacity(enrollment: EnrollmentRec, input: InboundInput, skus: Map<string, SkuRec>, excludeInboundId?: string) {
    const all = await this.repo.find('sku_enrollments', { seller_id: enrollment.seller_id });
    const balances = await this.repo.balances(all.map((s) => s.id));
    let used = 0;
    for (const s of all) used += (physicalUnits(balances, s.id) + qty(balances, s.id, 'inbound')) * cubicFeet(s.dimensions);
    if (excludeInboundId) {
      const own = await this.repo.find('inbound_lines', { inbound_id: excludeInboundId });
      const row = await this.repo.get('inbound_shipments', excludeInboundId);
      // a submitted shipment being edited is already counted as Inbound
      if (row && row.state !== 'draft') for (const l of own) used -= l.expected * cubicFeet(all.find((s) => s.id === l.sku_enrollment_id)?.dimensions ?? { length: 0, width: 0, height: 0 });
    }
    const adding = input.lines.reduce((n, l) => n + l.quantity * cubicFeet(skus.get(l.skuEnrollmentId)!.dimensions), 0);
    const max = Number(enrollment.max_cubic_feet);
    if (round4(used + adding) > max) {
      throw this.core.error('CAPACITY_EXCEEDED', `This shipment needs ${round4(adding)} cubic feet; ${round4(Math.max(0, max - used))} of your ${max} cubic feet are free`, { maxCubicFeet: max, usedCubicFeet: round4(used), shipmentCubicFeet: round4(adding) });
    }
  }

  async create(sellerId: string, input: InboundInput, by: By): Promise<InboundShipment> {
    const enrollment = await this.parts.enrollment.requireOpen(sellerId, 'plan inbound shipments');
    const skus = await this.checkLines(sellerId, input);
    await this.checkCapacity(enrollment, input, skus);
    const [ref, destination] = await Promise.all([this.ctx.refs.next('IB', { digits: 4 }), this.core.destination()]);
    const id = newId();
    const row = await this.repo.transaction(async (tx) => {
      const r = await tx.insert('inbound_shipments', {
        id,
        ref,
        seller_id: sellerId,
        state: inboundShipmentMachine.initial,
        ship_from: input.shipFrom,
        destination,
        boxes: input.boxes,
        carrier: input.carrier?.trim() || null,
        tracking: input.tracking?.trim() || null,
        expected_arrival: input.expectedArrival ?? null,
        arrived_at: null,
        received_at: null,
        warehouse_receipt_id: null,
        created_at: this.now(),
      });
      await tx.insertMany(
        'inbound_lines',
        input.lines.map((l) => ({ inbound_id: id, sku_enrollment_id: l.skuEnrollmentId, expected: l.quantity, received: 0, damaged: 0 })),
      );
      return r;
    });
    void by;
    return this.parts.views.inbound(row);
  }

  /** A draft changes freely; once submitted only the carrier, tracking and expected arrival */
  async update(sellerId: string, id: string, input: InboundInput, by: By): Promise<InboundShipment> {
    const before = await this.ownInbound(sellerId, id);
    if (before.state === 'draft') {
      const enrollment = await this.parts.enrollment.requireOpen(sellerId, 'plan inbound shipments');
      const skus = await this.checkLines(sellerId, input);
      await this.checkCapacity(enrollment, input, skus, id);
    } else if (before.state === 'submitted' || before.state === 'in_transit') {
      const lines = await this.repo.find('inbound_lines', { inbound_id: id });
      const same = lines.length === input.lines.length && input.lines.every((l) => lines.some((x) => x.sku_enrollment_id === l.skuEnrollmentId && x.expected === l.quantity));
      if (!same || input.boxes !== before.boxes) throw new AppError('ILLEGAL_TRANSITION', 'Lines and boxes are fixed once the shipment is submitted; cancel it and plan a new one', { machine: 'Inbound shipment', from: before.state, event: 'edit' });
    } else {
      throw new AppError('ILLEGAL_TRANSITION', 'This inbound shipment can no longer be edited', { machine: 'Inbound shipment', from: before.state, event: 'edit' });
    }
    const row = await this.repo.transaction(async (tx) => {
      const locked = (await tx.get('inbound_shipments', id, { forUpdate: true }))!;
      if (locked.state !== before.state) throw new AppError('CONFLICT', 'The shipment changed meanwhile; reload it');
      // PATCH: a field left out keeps its value; null clears it
      const common = {
        carrier: input.carrier === undefined ? locked.carrier : input.carrier?.trim() || null,
        tracking: input.tracking === undefined ? locked.tracking : input.tracking?.trim() || null,
        expected_arrival: input.expectedArrival === undefined ? locked.expected_arrival : (input.expectedArrival ?? null),
      };
      if (locked.state !== 'draft') return tx.update('inbound_shipments', id, common);
      await tx.removeWhere('inbound_lines', { inbound_id: id });
      await tx.insertMany(
        'inbound_lines',
        input.lines.map((l) => ({ inbound_id: id, sku_enrollment_id: l.skuEnrollmentId, expected: l.quantity, received: 0, damaged: 0 })),
      );
      return tx.update('inbound_shipments', id, { ...common, ship_from: input.shipFrom, boxes: input.boxes });
    });
    void by;
    return this.parts.views.inbound(row, { labels: true });
  }

  async submit(sellerId: string, id: string, by: By): Promise<InboundShipment> {
    const before = await this.ownInbound(sellerId, id);
    inboundShipmentMachine.next(before.state as State, 'submit');
    const enrollment = await this.parts.enrollment.requireOpen(sellerId, 'submit inbound shipments');
    const lines = await this.repo.find('inbound_lines', { inbound_id: id });
    const input: InboundInput = { shipFrom: before.ship_from, boxes: before.boxes, lines: lines.map((l) => ({ skuEnrollmentId: l.sku_enrollment_id, quantity: l.expected })), expectedArrival: null };
    const skus = await this.checkLines(sellerId, input);
    await this.checkCapacity(enrollment, input, skus, id);
    const row = await this.repo.transaction(async (tx) => {
      const locked = (await tx.get('inbound_shipments', id, { forUpdate: true }))!;
      const state = inboundShipmentMachine.next(locked.state as State, 'submit');
      for (const l of lines) await this.core.move(tx, { sellerId, skuEnrollmentId: l.sku_enrollment_id, movement: 'inbound_expected', quantity: l.expected, from: null, to: 'inbound', reference: locked.ref, actor: by.actor });
      return tx.update('inbound_shipments', id, { state });
    });
    const units = lines.reduce((n, l) => n + l.expected, 0);
    this.core.publish('fulfillment-service.inbound.submitted', { inboundId: id, sellerId, units, expectedArrival: row.expected_arrival }, by);
    return this.parts.views.inbound(row, { labels: true });
  }

  async ship(sellerId: string, id: string, body: { carrier: string; tracking: string; expectedArrival?: string | null }, by: By): Promise<InboundShipment> {
    const issues: { path: string; message: string }[] = [];
    if (!body.carrier?.trim()) issues.push({ path: 'carrier', message: 'Enter the carrier' });
    if (!body.tracking?.trim()) issues.push({ path: 'tracking', message: 'Enter the tracking number' });
    if (issues.length) throw invalid(issues);
    await this.ownInbound(sellerId, id);
    const row = await this.repo.transaction(async (tx) => {
      const locked = (await tx.get('inbound_shipments', id, { forUpdate: true }))!;
      const state = inboundShipmentMachine.next(locked.state as State, 'ship');
      return tx.update('inbound_shipments', id, { state, carrier: body.carrier.trim(), tracking: body.tracking.trim(), ...(body.expectedArrival ? { expected_arrival: body.expectedArrival } : {}) });
    });
    void by;
    return this.parts.views.inbound(row);
  }

  async cancel(sellerId: string, id: string, body: { reason?: string | null }, by: By): Promise<InboundShipment> {
    await this.ownInbound(sellerId, id);
    const row = await this.repo.transaction(async (tx) => {
      const locked = (await tx.get('inbound_shipments', id, { forUpdate: true }))!;
      const state = inboundShipmentMachine.next(locked.state as State, 'cancel');
      if (locked.state === 'submitted') {
        const lines = await tx.find('inbound_lines', { inbound_id: id });
        for (const l of lines) await this.core.move(tx, { sellerId, skuEnrollmentId: l.sku_enrollment_id, movement: 'inbound_cancelled', quantity: l.expected, from: 'inbound', to: null, reference: locked.ref, reason: body.reason?.trim() || 'Cancelled by the seller', actor: by.actor });
      }
      return tx.update('inbound_shipments', id, { state });
    });
    return this.parts.views.inbound(row);
  }

  async respondDiscrepancy(sellerId: string, id: string, body: { response: 'accepted' | 'claimed'; note?: string | null; evidenceIds?: string[] | null }, by: By): Promise<InboundShipment> {
    const before = await this.ownInbound(sellerId, id);
    if (body.response === 'claimed' && !body.note?.trim() && !body.evidenceIds?.length) throw invalid([{ path: 'note', message: 'Explain the claim or add evidence' }]);
    const row = await this.repo.transaction(async (tx) => {
      const locked = (await tx.get('inbound_shipments', id, { forUpdate: true }))!;
      const disc = await tx.findOne('discrepancies', { inbound_id: id }, { forUpdate: true });
      if (locked.state !== 'received' || !disc || disc.seller_response !== 'pending') {
        throw new AppError('ILLEGAL_TRANSITION', disc ? 'This discrepancy was already answered' : 'This shipment has no discrepancy to answer', { machine: 'Inbound shipment', from: locked.state, event: 'respondDiscrepancy' });
      }
      if (body.response === 'accepted') {
        await tx.update('discrepancies', disc.id, { seller_response: 'accepted', claim_note: body.note?.trim() || null, decision: 'Accepted by the seller', decided_by: actorText(by.actor), decided_at: this.now() });
        return tx.update('inbound_shipments', id, { state: inboundShipmentMachine.next('received', 'close') });
      }
      await tx.update('discrepancies', disc.id, { seller_response: 'claimed', claim_note: body.note?.trim() || null, evidence_media_ids: [...disc.evidence_media_ids, ...(body.evidenceIds ?? [])] });
      return locked;
    });
    void before;
    return this.parts.views.inbound(row);
  }

  /* ---------------------------------------------------------------- staff: arrival and receiving */

  async arrive(id: string, body: { boxesArrived: number; note?: string | null }, by: By): Promise<InboundShipment> {
    if (!Number.isInteger(body.boxesArrived) || body.boxesArrived < 0) throw invalid([{ path: 'boxesArrived', message: 'Boxes arrived must be 0 or more' }]);
    const before = await this.ownInbound(null, id);
    const row = await this.repo.transaction(async (tx) => {
      const locked = (await tx.get('inbound_shipments', id, { forUpdate: true }))!;
      const state = inboundShipmentMachine.next(locked.state as State, 'arrive');
      const lines = await tx.find('inbound_lines', { inbound_id: id });
      const boxes = body.boxesArrived === locked.boxes ? `${plural(locked.boxes, 'box')} arrived` : `${body.boxesArrived} of ${locked.boxes} boxes arrived`;
      const reason = [boxes, body.note?.trim()].filter(Boolean).join(' · ');
      for (const l of lines) await this.core.move(tx, { sellerId: locked.seller_id, skuEnrollmentId: l.sku_enrollment_id, movement: 'arrived', quantity: l.expected, from: 'inbound', to: 'receiving', reference: locked.ref, reason, actor: by.actor });
      return tx.update('inbound_shipments', id, { state, arrived_at: this.now() });
    });
    void before;
    return this.parts.views.inbound(row);
  }

  /**
   * Received and damaged units (added to what was counted before). Sellable units become Available seller-owned
   * stock (in inventory too), damaged units Unsellable; completing with differences opens a discrepancy.
   */
  async receive(id: string, body: ReceivingInput, by: By): Promise<InboundShipment> {
    const before = await this.ownInbound(null, id);
    const lines = await this.repo.find('inbound_lines', { inbound_id: id });
    const issues: { path: string; message: string }[] = [];
    const seen = new Set<string>();
    body.lines.forEach((l, i) => {
      if (!lines.some((x) => x.sku_enrollment_id === l.skuEnrollmentId)) issues.push({ path: `lines[${i}].skuEnrollmentId`, message: 'This SKU is not on the shipment' });
      if (seen.has(l.skuEnrollmentId)) issues.push({ path: `lines[${i}].skuEnrollmentId`, message: 'Each SKU appears once' });
      seen.add(l.skuEnrollmentId);
      if (!Number.isInteger(l.received) || l.received < 0 || !Number.isInteger(l.damaged) || l.damaged < 0) issues.push({ path: `lines[${i}]`, message: 'Counts are whole numbers, 0 or more' });
      else if (l.damaged > l.received) issues.push({ path: `lines[${i}].damaged`, message: 'Damaged units are part of the received units' });
    });
    if (issues.length) throw invalid(issues);
    const skus = new Map((await this.repo.find('sku_enrollments', { id: lines.map((l) => l.sku_enrollment_id) })).map((s) => [s.id, s]));
    const schedule = await this.core.currentSchedule();
    const key = by.idempotencyKey ?? by.requestId ?? newId();
    const sellable = new Map<string, number>();
    let totalReceived = 0;
    let totalDamaged = 0;

    const result = await this.repo.transaction(async (tx) => {
      const locked = (await tx.get('inbound_shipments', id, { forUpdate: true }))!;
      let state = locked.state as State;
      if (state === 'arrived') state = inboundShipmentMachine.next(state, 'startReceiving');
      else if (state !== 'receiving') inboundShipmentMachine.next(state, 'startReceiving');
      await tx.lockSkus(lines.map((l) => l.sku_enrollment_id));
      const balances = await tx.balances(lines.map((l) => l.sku_enrollment_id));
      const ref = locked.ref;
      const mv = { sellerId: locked.seller_id, reference: ref, actor: by.actor };
      for (const l of body.lines) {
        if (!l.received) continue;
        const line = lines.find((x) => x.sku_enrollment_id === l.skuEnrollmentId)!;
        const sku = skus.get(l.skuEnrollmentId)!;
        const fromReceiving = Math.min(l.received, qty(balances, sku.id, 'receiving'));
        const damagedFromReceiving = Math.min(l.damaged, fromReceiving);
        const goodFromReceiving = fromReceiving - damagedFromReceiving;
        const damagedExtra = l.damaged - damagedFromReceiving;
        const goodExtra = l.received - fromReceiving - damagedExtra;
        await this.core.move(tx, { ...mv, skuEnrollmentId: sku.id, movement: 'received', quantity: goodFromReceiving, from: 'receiving', to: 'available' });
        await this.core.move(tx, { ...mv, skuEnrollmentId: sku.id, movement: 'received', quantity: goodExtra, from: null, to: 'available', reason: 'More units than expected' });
        await this.core.move(tx, { ...mv, skuEnrollmentId: sku.id, movement: 'received_damaged', quantity: damagedFromReceiving, from: 'receiving', to: 'unsellable', reason: body.note ?? 'Damaged on arrival' });
        await this.core.move(tx, { ...mv, skuEnrollmentId: sku.id, movement: 'received_damaged', quantity: damagedExtra, from: null, to: 'unsellable', reason: body.note ?? 'Damaged on arrival' });
        const bal = balances.get(sku.id) ?? {};
        bal.receiving = (bal.receiving ?? 0) - fromReceiving;
        balances.set(sku.id, bal);
        await tx.updateWhere('inbound_lines', { inbound_id: id, sku_enrollment_id: sku.id }, { received: line.received + l.received, damaged: line.damaged + l.damaged });
        line.received += l.received;
        line.damaged += l.damaged;
        sellable.set(sku.id, (sellable.get(sku.id) ?? 0) + l.received - l.damaged);
        totalReceived += l.received;
        totalDamaged += l.damaged;
        const fee = { sellerId: locked.seller_id, sizeTier: sku.size_tier, units: l.received, reference: ref };
        await this.core.accrue(tx, { ...fee, rateType: 'receiving_per_unit', key: `receiving:${id}:${sku.id}:${key}` }, schedule.rates);
        if (sku.label_required) await this.core.accrue(tx, { ...fee, rateType: 'label_per_unit', key: `labelling:${id}:${sku.id}:${key}` }, schedule.rates);
      }
      const patch: Partial<InboundRec> = { state };
      if (body.complete) {
        patch.state = state = inboundShipmentMachine.next(state, 'finishReceiving');
        patch.received_at = this.now();
        // units still expected but not counted are missing
        for (const l of lines) await this.core.move(tx, { ...mv, skuEnrollmentId: l.sku_enrollment_id, movement: 'missing', quantity: qty(balances, l.sku_enrollment_id, 'receiving'), from: 'receiving', to: null, reason: 'Not in the shipment' });
        const summary = discrepancySummary(lines, skus);
        if (summary) {
          await tx.insertIfNew('discrepancies', { id: newId(), inbound_id: id, summary, evidence_media_ids: body.evidenceIds ?? [], seller_response: 'pending', claim_note: null, decision: null, decided_by: null, decided_at: null });
        } else {
          patch.state = state = inboundShipmentMachine.next(state, 'close');
        }
      }
      const updated = await tx.update('inbound_shipments', id, patch);
      const received = [...sellable].filter(([, n]) => n > 0).map(([skuId]) => skuId);
      await this.parts.skus.activateWithStock(tx, received);
      const activated = received.length ? await this.parts.enrollment.activateIfApproved(tx, locked.seller_id) : null;
      return { updated, activated };
    });

    // inventory: the sellable units join the seller's stock item (after the commit)
    for (const [skuId, n] of sellable) {
      if (n <= 0) continue;
      const sku = skus.get(skuId)!;
      await this.core.adjustInventory(before.seller_id, sku.inventory_item_id, n, id, by.actor).catch((err) => this.ctx.log.warn({ err, inboundId: id, skuId }, 'fulfillment-service: received units not added to inventory'));
    }
    if (result.activated) this.parts.enrollment.activated(result.activated, by);
    this.core.publish('fulfillment-service.inbound.received', { inboundId: id, sellerId: before.seller_id, received: totalReceived, damaged: totalDamaged, complete: body.complete }, by);
    return this.parts.views.inbound(result.updated, { labels: true });
  }

  /* ---------------------------------------------------------------- staff: discrepancy decisions */

  async decideDiscrepancy(id: string, body: { decision: 'adjust_stock' | 'reimburse' | 'reject'; units?: number | null; amount?: common.Money | null; reason: string }, by: By): Promise<InboundShipment> {
    const reason = body.reason?.trim();
    if (!reason) throw invalid([{ path: 'reason', message: 'Give the reason the seller will see' }]);
    const row = await this.ownInbound(null, id);
    const disc = await this.repo.findOne('discrepancies', { inbound_id: id });
    if (row.state !== 'received' || !disc || disc.seller_response !== 'claimed' || disc.decision) {
      throw new AppError('ILLEGAL_TRANSITION', disc?.decision ? 'This discrepancy was already decided' : 'Only a claimed discrepancy can be decided', { machine: 'Inbound shipment', from: row.state, event: 'decideDiscrepancy' });
    }
    const lines = await this.repo.find('inbound_lines', { inbound_id: id });
    const missing = lines.reduce((n, l) => n + Math.max(0, l.expected - l.received), 0);
    if (body.decision === 'adjust_stock') {
      if (!Number.isInteger(body.units) || body.units! < 1) throw invalid([{ path: 'units', message: 'Enter the units found, at least 1' }]);
      if (body.units! > missing) throw invalid([{ path: 'units', message: `Only ${plural(missing, 'unit')} are missing on this shipment` }]);
    }
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
            target: { type: DISCREPANCY_TARGET, id, ref: row.ref, label: `Inbound ${row.ref} discrepancy`, sellerId: row.seller_id, screen: 'ops/receiving' },
            amount: body.amount,
            summary: `Reimburse the seller ${(body.amount.amount / 100).toFixed(2)} ${body.amount.currency} for inbound ${row.ref}`,
            details: { inboundId: id, ref: row.ref, missing, discrepancy: disc.summary },
            reason,
            requestedBy: principal,
          });
          throw new AppError('APPROVAL_REQUIRED', `${check.reason || 'Above your reimbursement limit'}; sent for approval.`, { approvalRequestId: req.id, approval: { required: true, approvalRequestId: req.id, approvers: (check.eligibleApproverRoles ?? []).map((r) => r.name) } });
        }
      }
    }
    return this.parts.views.inbound(await this.applyDecision(id, body.decision, { units: body.units ?? null, amount: body.amount ?? null, reason }, by));
  }

  private async applyDecision(id: string, decision: 'adjust_stock' | 'reimburse' | 'reject', o: { units: number | null; amount: common.Money | null; reason: string }, by: By): Promise<InboundRec> {
    const found = new Map<string, number>();
    const result = await this.repo.transaction(async (tx) => {
      const locked = (await tx.get('inbound_shipments', id, { forUpdate: true }))!;
      const disc = await tx.findOne('discrepancies', { inbound_id: id }, { forUpdate: true });
      if (locked.state !== 'received' || !disc || disc.decision) return null;
      let text = '';
      if (decision === 'adjust_stock') {
        let left = o.units ?? 0;
        const lines = await tx.find('inbound_lines', { inbound_id: id });
        for (const l of lines) {
          if (left <= 0) break;
          const n = Math.min(left, Math.max(0, l.expected - l.received));
          if (!n) continue;
          await this.core.move(tx, { sellerId: locked.seller_id, skuEnrollmentId: l.sku_enrollment_id, movement: 'adjusted', quantity: n, from: null, to: 'available', reference: locked.ref, reason: `Found units: ${o.reason}`, actor: by.actor });
          await tx.updateWhere('inbound_lines', { inbound_id: id, sku_enrollment_id: l.sku_enrollment_id }, { received: l.received + n });
          found.set(l.sku_enrollment_id, n);
          left -= n;
        }
        await this.parts.skus.activateWithStock(tx, [...found.keys()]);
        text = `Stock adjusted: ${plural(o.units ?? 0, 'unit')} added. ${o.reason}`;
      } else if (decision === 'reimburse') {
        const amount = o.amount!;
        await tx.insertIfNew('fee_charges', {
          id: newId(),
          seller_id: locked.seller_id,
          type: REIMBURSEMENT,
          period: this.core.month(),
          reference: locked.ref,
          units: '1',
          rate: -amount.amount,
          amount: -amount.amount,
          currency: amount.currency,
          state: 'accrued',
          posted_at: null,
          reason: o.reason,
          idempotency_key: `reimbursement:${id}`,
        });
        text = `Reimbursed ${(amount.amount / 100).toFixed(2)} ${amount.currency}. ${o.reason}`;
      } else {
        text = `Claim rejected. ${o.reason}`;
      }
      await tx.update('discrepancies', disc.id, { decision: text, decided_by: actorText(by.actor), decided_at: this.now() });
      return tx.update('inbound_shipments', id, { state: inboundShipmentMachine.next('received', 'close') });
    });
    const row = result ?? (await this.repo.get('inbound_shipments', id))!;
    if (result) {
      const skus = new Map((await this.repo.find('sku_enrollments', { id: [...found.keys()] })).map((s) => [s.id, s]));
      for (const [skuId, n] of found) await this.core.adjustInventory(row.seller_id, skus.get(skuId)?.inventory_item_id ?? null, n, id, by.actor).catch((err) => this.ctx.log.warn({ err, inboundId: id }, 'fulfillment-service: found units not added to inventory'));
    }
    return row;
  }

  /** access.approval.decided for fulfillment-service.reimbursements.approve */
  async onReimbursementDecided(e: EventPayload<'access.approval.decided'>): Promise<void> {
    if (e.outcome !== 'approved' || !isUuid(e.target.id) || !e.amount) return;
    const row = await this.repo.get('inbound_shipments', e.target.id);
    if (!row) return;
    let reason = e.reason ?? null;
    try {
      reason = (await this.ctx.tryUse('access')?.getApproval(e.requestId))?.reason ?? reason;
    } catch {
      /* keep the decision note */
    }
    await this.applyDecision(row.id, 'reimburse', { units: null, amount: e.amount, reason: reason || 'Approved reimbursement' }, { actor: e.decidedBy ?? SYSTEM });
  }

  /* ---------------------------------------------------------------- job */

  /** Shipments past their expected arrival (logged for the receiving queue); unanswered discrepancies close */
  async overdue(): Promise<{ overdue: number; closed: number }> {
    const today = this.core.today();
    const late = await this.repo.find('inbound_shipments', { state: ['submitted', 'in_transit'], expected_arrival: { op: '<', value: today } }, { limit: 1000 });
    if (late.length) this.ctx.log.info({ count: late.length, refs: late.slice(0, 20).map((r) => r.ref) }, 'fulfillment-service: inbound shipments past their expected arrival');
    const days = await this.core.setting('discrepancyResponseDays', 14);
    const cutoff = this.core.dayStart(addDays(today, -days));
    const waiting = await this.repo.find('inbound_shipments', { state: 'received', received_at: { op: '<', value: cutoff } }, { limit: 500 });
    let closed = 0;
    for (const r of waiting) {
      const done = await this.repo.transaction(async (tx) => {
        const locked = await tx.get('inbound_shipments', r.id, { forUpdate: true });
        const disc = await tx.findOne('discrepancies', { inbound_id: r.id }, { forUpdate: true });
        if (!locked || locked.state !== 'received' || !disc || disc.seller_response !== 'pending') return false;
        await tx.update('discrepancies', disc.id, { seller_response: 'accepted', decision: `Closed without a seller response after ${days} days`, decided_by: actorText(SYSTEM), decided_at: this.now() });
        await tx.update('inbound_shipments', r.id, { state: inboundShipmentMachine.next('received', 'close') });
        return true;
      });
      if (done) closed += 1;
    }
    return { overdue: late.length, closed };
  }
}

/** '2 units short, 1 damaged, 3 extra' over the lines, or null when everything matched */
function discrepancySummary(lines: readonly InboundLineRec[], skus: Map<string, SkuRec>): string | null {
  const parts: string[] = [];
  for (const l of lines) {
    const bits: string[] = [];
    const missing = Math.max(0, l.expected - l.received);
    const extra = Math.max(0, l.received - l.expected);
    if (missing) bits.push(`${missing} short`);
    if (l.damaged) bits.push(`${l.damaged} damaged`);
    if (extra) bits.push(`${extra} extra`);
    if (bits.length) parts.push(`${skus.get(l.sku_enrollment_id)?.sku ?? 'SKU'}: ${bits.join(', ')}`);
  }
  return parts.length ? parts.join('; ') : null;
}
