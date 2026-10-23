/**
 * Inbound shipments from a seller to our warehouse: plan (lines, boxes, ship-from; the destination is the service
 * location's address, decision D12), submit (labels; inventory expects the units as Incoming), ship, cancel,
 * arrival at the dock (Inbound → Receiving), receiving records (each one a service receipt in inventory; the units
 * stay in Receiving until the Inventory Manager confirms it, decision D3), the confirmation (Available and
 * Unsellable seller-owned stock; the SKU and the enrollment activate), discrepancies the seller accepts or claims,
 * staff decisions (adjust stock, reimburse within limits, reject) and the daily overdue sweep.
 */
import { format as formatMoney } from '../../../kernel/lib/money.js';
import { AppError } from '../../../kernel/errors/index.js';
import type { EventPayload } from '../../../kernel/events/index.js';
import { isUuid, newId } from '../../../kernel/lib/ids.js';
import type { PageRequest } from '../../../kernel/lib/pagination.js';
import type * as common from '../../../spec/common.js';
import type { InboundInput, InboundShipment, ReceivedEventLine, ReceivingInput } from '../../../spec/fulfillment-service.js';
import { inboundShipmentMachine } from '../domain/state-machines.js';
import { actorText, addDays, cubicFeet, physicalUnits, plural, qty, round4, SYSTEM } from '../domain/rules.js';
import type { EnrollmentRec, InboundLineRec, InboundRec, ReceiptLine, SkuRec } from '../ports.js';
import { invalid, notFound, Part, type By } from './core.js';

type State = InboundShipment['state'];

export const REIMBURSE_ACTION = 'fulfillment-service.reimbursements.approve';
export const DISCREPANCY_TARGET = 'inbound_discrepancy';
const LINE_STATES = ['approved', 'active', 'inactive'];
const OPEN = ['draft', 'submitted', 'in_transit', 'arrived', 'receiving', 'received'];

const fmt = (m: common.Money) => formatMoney(m);

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
    // the destination is the service location's address (decision D12)
    const location = await this.core.requireLocation();
    const ref = await this.ctx.refs.next('IB', { digits: 4 });
    const id = newId();
    const row = await this.repo.transaction(async (tx) => {
      const r = await tx.insert('inbound_shipments', {
        id,
        ref,
        seller_id: sellerId,
        state: inboundShipmentMachine.initial,
        ship_from: input.shipFrom,
        destination: location.address,
        boxes: input.boxes,
        carrier: input.carrier?.trim() || null,
        tracking: input.tracking?.trim() || null,
        expected_arrival: input.expectedArrival ?? null,
        arrived_at: null,
        received_at: null,
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
    if (row.state !== 'draft' && row.expected_arrival !== before.expected_arrival) await this.expect(row, { strict: false });
    void by;
    return this.parts.views.inbound(row, { labels: true });
  }

  /** inventory.expectServiceInbound: the shipment's units are Incoming at the service location (repeat = replace) */
  private async expect(row: InboundRec, o: { strict: boolean }) {
    try {
      const location = await this.core.requireLocation();
      const lines = await this.repo.find('inbound_lines', { inbound_id: row.id });
      const skus = new Map((await this.repo.find('sku_enrollments', { id: lines.map((l) => l.sku_enrollment_id) })).map((s) => [s.id, s]));
      await this.ctx.use('inventory').expectServiceInbound({
        inboundId: row.id,
        ref: row.ref,
        locationId: location.locationId,
        lines: lines.filter((l) => skus.get(l.sku_enrollment_id)?.inventory_item_id).map((l) => ({ stockItemId: skus.get(l.sku_enrollment_id)!.inventory_item_id!, quantity: l.expected, ...(row.expected_arrival ? { expectedDate: row.expected_arrival } : {}) })),
      });
    } catch (err) {
      if (o.strict) throw err;
      this.ctx.log.warn({ err, inboundId: row.id }, 'fulfillment-service: inventory did not take the expected inbound units');
    }
  }

  /** inventory.cancelServiceInbound: the open Incoming of a cancelled or completed shipment goes */
  private async unexpect(inboundId: string) {
    await this.ctx
      .use('inventory')
      .cancelServiceInbound(inboundId)
      .catch((err) => this.ctx.log.warn({ err, inboundId }, 'fulfillment-service: inventory kept the open inbound units'));
  }

  async submit(sellerId: string, id: string, by: By): Promise<InboundShipment> {
    const before = await this.ownInbound(sellerId, id);
    inboundShipmentMachine.next(before.state as State, 'submit');
    const enrollment = await this.parts.enrollment.requireOpen(sellerId, 'submit inbound shipments');
    const lines = await this.repo.find('inbound_lines', { inbound_id: id });
    const input: InboundInput = { shipFrom: before.ship_from, boxes: before.boxes, lines: lines.map((l) => ({ skuEnrollmentId: l.sku_enrollment_id, quantity: l.expected })), expectedArrival: null };
    const skus = await this.checkLines(sellerId, input);
    await this.checkCapacity(enrollment, input, skus, id);
    // inventory first: Incoming at the service location (replaces any earlier expectation of this shipment)
    await this.expect(before, { strict: true });
    const row = await this.repo.transaction(async (tx) => {
      const locked = (await tx.get('inbound_shipments', id, { forUpdate: true }))!;
      const state = inboundShipmentMachine.next(locked.state as State, 'submit');
      for (const l of lines) await this.core.move(tx, { sellerId, skuEnrollmentId: l.sku_enrollment_id, movement: 'inbound_expected', quantity: l.expected, from: null, to: 'inbound', reference: locked.ref, actor: by.actor });
      return tx.update('inbound_shipments', id, { state });
    });
    const units = lines.reduce((n, l) => n + l.expected, 0);
    this.core.publish('fulfillment-service.inbound.submitted', { inboundId: id, sellerId, units, expectedArrival: row.expected_arrival }, by);
    const names = await this.core.sellerNames([sellerId]);
    await this.core.notifyStaff('warehouse_manager', 'staff.fulfillment.inbound_submitted', { inbound: { ref: row.ref, units, expectedArrival: row.expected_arrival ?? '' }, seller: { name: names.get(sellerId) ?? 'A seller' } }, { kind: 'queue', id, ref: row.ref, label: 'Open receiving', screen: 'ops/receiving' }, `fs:inbound:${id}:submitted`);
    return this.parts.views.inbound(row, { labels: true });
  }

  async ship(sellerId: string, id: string, body: { carrier: string; tracking: string; expectedArrival?: string | null }, by: By): Promise<InboundShipment> {
    const issues: { path: string; message: string }[] = [];
    if (!body.carrier?.trim()) issues.push({ path: 'carrier', message: 'Enter the carrier' });
    if (!body.tracking?.trim()) issues.push({ path: 'tracking', message: 'Enter the tracking number' });
    if (issues.length) throw invalid(issues);
    const before = await this.ownInbound(sellerId, id);
    const row = await this.repo.transaction(async (tx) => {
      const locked = (await tx.get('inbound_shipments', id, { forUpdate: true }))!;
      const state = inboundShipmentMachine.next(locked.state as State, 'ship');
      return tx.update('inbound_shipments', id, { state, carrier: body.carrier.trim(), tracking: body.tracking.trim(), ...(body.expectedArrival ? { expected_arrival: body.expectedArrival } : {}) });
    });
    if (row.expected_arrival !== before.expected_arrival) await this.expect(row, { strict: false });
    void by;
    return this.parts.views.inbound(row);
  }

  async cancel(sellerId: string, id: string, body: { reason?: string | null }, by: By): Promise<InboundShipment> {
    await this.ownInbound(sellerId, id);
    const { row, wasSubmitted } = await this.repo.transaction(async (tx) => {
      const locked = (await tx.get('inbound_shipments', id, { forUpdate: true }))!;
      const state = inboundShipmentMachine.next(locked.state as State, 'cancel');
      if (locked.state === 'submitted') {
        const lines = await tx.find('inbound_lines', { inbound_id: id });
        for (const l of lines) await this.core.move(tx, { sellerId, skuEnrollmentId: l.sku_enrollment_id, movement: 'inbound_cancelled', quantity: l.expected, from: 'inbound', to: null, reference: locked.ref, reason: body.reason?.trim() || 'Cancelled by the seller', actor: by.actor });
      }
      return { row: await tx.update('inbound_shipments', id, { state }), wasSubmitted: locked.state === 'submitted' };
    });
    if (wasSubmitted) await this.unexpect(id);
    return this.parts.views.inbound(row);
  }

  async respondDiscrepancy(sellerId: string, id: string, body: { response: 'accepted' | 'claimed'; note?: string | null; evidenceIds?: string[] | null }, by: By): Promise<InboundShipment> {
    await this.ownInbound(sellerId, id);
    if (body.response === 'claimed' && !body.note?.trim() && !body.evidenceIds?.length) throw invalid([{ path: 'note', message: 'Explain the claim or add evidence' }]);
    const { row, summary } = await this.repo.transaction(async (tx) => {
      const locked = (await tx.get('inbound_shipments', id, { forUpdate: true }))!;
      const disc = await tx.findOne('discrepancies', { inbound_id: id }, { forUpdate: true });
      if (locked.state !== 'received' || !disc || disc.seller_response !== 'pending') {
        throw new AppError('ILLEGAL_TRANSITION', disc ? 'This discrepancy was already answered' : 'This shipment has no discrepancy to answer', { machine: 'Inbound shipment', from: locked.state, event: 'respondDiscrepancy' });
      }
      if (body.response === 'accepted') {
        await tx.update('discrepancies', disc.id, { seller_response: 'accepted', claim_note: body.note?.trim() || null, decision: 'Accepted by the seller', decided_by: actorText(by.actor), decided_at: this.now() });
        return { row: await tx.update('inbound_shipments', id, { state: inboundShipmentMachine.next('received', 'close') }), summary: disc.summary };
      }
      await tx.update('discrepancies', disc.id, { seller_response: 'claimed', claim_note: body.note?.trim() || null, evidence_media_ids: [...disc.evidence_media_ids, ...(body.evidenceIds ?? [])] });
      return { row: locked, summary: disc.summary };
    });
    if (body.response === 'claimed') {
      const names = await this.core.sellerNames([sellerId]);
      await this.core.notifyStaff('warehouse_manager', 'staff.fulfillment.discrepancy_claimed', { inbound: { ref: row.ref }, seller: { name: names.get(sellerId) ?? 'A seller' }, discrepancy: summary, note: body.note?.trim() ?? '' }, { kind: 'queue', id, ref: row.ref, label: 'Decide the claim', screen: 'ops/receiving' }, `fs:inbound:${id}:claimed`);
      await this.core.raise({
        queueKey: 'fulfillment.receiving',
        kind: 'receiving',
        title: `Receiving claim on ${row.ref}`,
        summary: `${names.get(sellerId) ?? 'Seller'} claims: ${summary}${body.note?.trim() ? ` · ${body.note.trim()}` : ''}`,
        subject: { type: 'other', id, ref: row.ref, label: 'Inbound shipment' },
        sellerId,
        dedupeKey: `fs_discrepancy:${id}`,
      });
    }
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
    await this.core.resolveWork(`fs_inbound_overdue:${id}`, 'Arrived at the warehouse', by.actor);
    await this.core.audit({ action: 'fulfillment-service.inbound.arrive', actionLabel: 'Recorded an inbound shipment arrival', category: 'inventory', target: { type: 'inbound_shipment', id, ref: row.ref, label: `Inbound ${row.ref}`, sellerId: row.seller_id, screen: 'ops/receiving' }, before: { state: before.state }, after: { state: row.state, boxesArrived: body.boxesArrived, boxes: row.boxes }, reason: body.note?.trim() || null }, by);
    return this.parts.views.inbound(row);
  }

  /**
   * One receiving record: the counts (added to earlier ones), receiving and labelling fees, an inventory service
   * receipt the Inventory Manager confirms (the units stay in Receiving until then) and fulfillment-service.inbound.received
   * for warehouse put-away. Completing writes the missing units, cancels the open Incoming and opens a discrepancy
   * when the counts differ.
   */
  async receive(id: string, body: ReceivingInput, by: By): Promise<InboundShipment> {
    const before = await this.ownInbound(null, id);
    const lines = await this.repo.find('inbound_lines', { inbound_id: id });
    const issues: { path: string; message: string }[] = [];
    const seen = new Set<string>();
    (body.lines ?? []).forEach((l, i) => {
      if (!lines.some((x) => x.sku_enrollment_id === l.skuEnrollmentId)) issues.push({ path: `lines[${i}].skuEnrollmentId`, message: 'This SKU is not on the shipment' });
      if (seen.has(l.skuEnrollmentId)) issues.push({ path: `lines[${i}].skuEnrollmentId`, message: 'Each SKU appears once' });
      seen.add(l.skuEnrollmentId);
      if (!Number.isInteger(l.received) || l.received < 0 || !Number.isInteger(l.damaged) || l.damaged < 0) issues.push({ path: `lines[${i}]`, message: 'Counts are whole numbers, 0 or more' });
      else if (l.damaged > l.received) issues.push({ path: `lines[${i}].damaged`, message: 'Damaged units are part of the received units' });
    });
    if (issues.length) throw invalid(issues);
    // the transition is checked before inventory hears anything
    if (before.state !== 'receiving') inboundShipmentMachine.next(before.state as State, 'startReceiving');
    if (body.complete) inboundShipmentMachine.next('receiving', 'finishReceiving');
    const skus = new Map((await this.repo.find('sku_enrollments', { id: lines.map((l) => l.sku_enrollment_id) })).map((s) => [s.id, s]));
    const info = await this.parts.views.skuInfo(lines.map((l) => l.sku_enrollment_id));
    const counted = (body.lines ?? []).filter((l) => l.received > 0);
    const schedule = await this.core.currentSchedule();
    const location = await this.core.requireLocation();
    const receiptId = newId();
    const seq = (await this.repo.count('inbound_receipts', { inbound_id: id })) + 1;
    const receiptLines: ReceiptLine[] = counted.map((l) => ({ skuEnrollmentId: l.skuEnrollmentId, stockItemId: skus.get(l.skuEnrollmentId)?.inventory_item_id ?? null, received: l.received, damaged: l.damaged }));
    const countedAt = this.now();

    // inventory first: the receiving record waits in the Inventory Manager's confirmation queue (decision D3)
    let inventoryReceiptId: string | null = null;
    if (counted.length) {
      const names = await this.core.sellerNames([before.seller_id]);
      const receipt = await this.ctx.use('inventory').submitServiceReceipt({
        receiptId,
        receiptRef: `${before.ref}-R${seq}`,
        inboundId: id,
        inboundRef: before.ref,
        sellerId: before.seller_id,
        sellerName: names.get(before.seller_id) ?? 'Seller',
        locationId: location.locationId,
        receivedBy: by.actor,
        receivedAt: countedAt.toISOString(),
        lines: receiptLines
          .filter((l) => l.stockItemId)
          .map((l) => {
            const line = lines.find((x) => x.sku_enrollment_id === l.skuEnrollmentId)!;
            return { stockItemId: l.stockItemId!, expected: Math.max(0, line.expected - line.received), received: l.received, damaged: l.damaged };
          }),
      });
      inventoryReceiptId = receipt.id;
    }

    const updated = await this.repo.transaction(async (tx) => {
      const locked = (await tx.get('inbound_shipments', id, { forUpdate: true }))!;
      let state = locked.state as State;
      if (state !== 'receiving') state = inboundShipmentMachine.next(state, 'startReceiving');
      const current = await tx.find('inbound_lines', { inbound_id: id });
      const ref = locked.ref;
      for (const l of counted) {
        const line = current.find((x) => x.sku_enrollment_id === l.skuEnrollmentId)!;
        const sku = skus.get(l.skuEnrollmentId)!;
        line.received += l.received;
        line.damaged += l.damaged;
        await tx.updateWhere('inbound_lines', { inbound_id: id, sku_enrollment_id: sku.id }, { received: line.received, damaged: line.damaged });
        const fee = { sellerId: locked.seller_id, sizeTier: sku.size_tier, units: l.received, reference: ref };
        await this.core.accrue(tx, { ...fee, rateType: 'receiving_per_unit', key: `receiving:${id}:${sku.id}:${receiptId}` }, schedule.rates);
        if (sku.label_required) await this.core.accrue(tx, { ...fee, rateType: 'label_per_unit', key: `labelling:${id}:${sku.id}:${receiptId}` }, schedule.rates);
      }
      if (counted.length) {
        await tx.insert('inbound_receipts', { id: receiptId, inbound_id: id, seq, inventory_receipt_id: inventoryReceiptId, lines: receiptLines, state: 'submitted', counted_by: actorText(by.actor)!, counted_at: countedAt, confirmed_by: null, confirmed_at: null });
      }
      const patch: Partial<InboundRec> = { state };
      if (body.complete) {
        patch.state = state = inboundShipmentMachine.next(state, 'finishReceiving');
        patch.received_at = this.now();
        // units expected but never counted are missing; counted units wait in Receiving for the confirmation
        await tx.lockSkus(current.map((l) => l.sku_enrollment_id));
        const balances = await tx.balances(current.map((l) => l.sku_enrollment_id));
        for (const l of current) {
          const missing = Math.min(Math.max(0, l.expected - l.received), qty(balances, l.sku_enrollment_id, 'receiving'));
          await this.core.move(tx, { sellerId: locked.seller_id, skuEnrollmentId: l.sku_enrollment_id, movement: 'missing', quantity: missing, from: 'receiving', to: null, reference: ref, reason: 'Not in the shipment', actor: by.actor });
        }
        const summary = discrepancySummary(current, skus);
        if (summary) {
          await tx.insertIfAbsent('discrepancies', { id: newId(), inbound_id: id, summary, evidence_media_ids: body.evidenceIds ?? [], seller_response: 'pending', claim_note: null, decision: null, decided_by: null, decided_at: null });
        } else {
          patch.state = state = inboundShipmentMachine.next(state, 'close');
        }
      }
      return tx.update('inbound_shipments', id, patch);
    });

    const received = counted.reduce((n, l) => n + l.received, 0);
    const damaged = counted.reduce((n, l) => n + l.damaged, 0);
    if (counted.length) {
      const eventLines: ReceivedEventLine[] = receiptLines
        .filter((l) => l.stockItemId)
        .map((l) => ({ skuEnrollmentId: l.skuEnrollmentId, stockItemId: l.stockItemId!, sku: skus.get(l.skuEnrollmentId)!.sku, label: info.get(l.skuEnrollmentId)?.title ?? skus.get(l.skuEnrollmentId)!.sku, received: l.received, damaged: l.damaged }));
      this.core.publish('fulfillment-service.inbound.received', { inboundId: id, ref: before.ref, receiptId, sellerId: before.seller_id, locationId: location.locationId, received, damaged, complete: body.complete, lines: eventLines }, by);
    }
    if (body.complete) {
      await this.unexpect(id);
      const all = await this.repo.find('inbound_lines', { inbound_id: id });
      const disc = await this.repo.findOne('discrepancies', { inbound_id: id });
      await this.core.notifySeller(
        before.seller_id,
        'seller.fulfillment.inbound_received',
        { inbound: { ref: before.ref }, received: all.reduce((n, l) => n + l.received, 0), damaged: all.reduce((n, l) => n + l.damaged, 0), discrepancy: disc?.summary ?? 'none' },
        { kind: 'queue', id, ref: before.ref, label: disc ? 'Review the discrepancy' : 'View shipment', screen: 'seller/inventory' },
        `fs:inbound:${id}:received`,
      );
    }
    await this.core.audit(
      {
        action: 'fulfillment-service.inbound.receive',
        actionLabel: body.complete ? 'Completed receiving an inbound shipment' : 'Recorded received units',
        category: 'inventory',
        target: { type: 'inbound_shipment', id, ref: before.ref, label: `Inbound ${before.ref}`, sellerId: before.seller_id, screen: 'ops/receiving' },
        before: { state: before.state },
        after: { state: updated.state, receiptId: counted.length ? receiptId : null, received, damaged, complete: body.complete },
        reason: body.note?.trim() || null,
        evidence: body.evidenceIds ?? null,
      },
      by,
    );
    return this.parts.views.inbound(updated, { labels: true });
  }

  /**
   * inventory.receipt.confirmed (service_inbound): per confirmed line the ledger moves Receiving → Available
   * (sellable) and → Unsellable (damaged), extra units from outside, units the Inventory Manager did not accept out;
   * the receipt is confirmed; the SKU (first time: setServiceLocation, then offer.service_changed) and the enrollment
   * activate; the seller hears the stock is on sale. Claimed once per receipt.
   */
  async onReceiptConfirmed(e: EventPayload<'inventory.receipt.confirmed'>): Promise<void> {
    if (e.source?.kind !== 'service_inbound') return;
    const receipt = (isUuid(e.receiptId) ? await this.repo.get('inbound_receipts', e.receiptId) : undefined) ?? (isUuid(e.inboundId) ? await this.repo.findOne('inbound_receipts', { inventory_receipt_id: e.inboundId }) : undefined);
    if (!receipt) {
      this.ctx.log.warn({ receiptId: e.receiptId, inboundId: e.source.id }, 'fulfillment-service: confirmed service receipt is unknown');
      return;
    }
    if (receipt.state === 'confirmed') return;
    const inbound = await this.repo.get('inbound_shipments', receipt.inbound_id);
    if (!inbound) return;
    const confirmed = new Map(e.lines.map((l) => [l.stockItemId, l]));
    const by = { actor: e.confirmedBy ?? SYSTEM };
    const result = await this.repo.transaction(async (tx) => {
      if (!(await tx.claim(`receipt-confirmed:${receipt.id}`))) return null;
      const locked = (await tx.get('inbound_receipts', receipt.id, { forUpdate: true }))!;
      if (locked.state === 'confirmed') return null;
      const skuIds = locked.lines.map((l) => l.skuEnrollmentId);
      await tx.lockSkus(skuIds);
      const balances = await tx.balances(skuIds);
      const mv = { sellerId: inbound.seller_id, reference: inbound.ref, actor: by.actor };
      const sellableSkus: string[] = [];
      let units = 0;
      for (const l of locked.lines) {
        const c = l.stockItemId ? confirmed.get(l.stockItemId) : undefined;
        const received = c?.received ?? l.received;
        const damaged = c ? c.damaged : l.damaged;
        const sellable = c ? c.sellable : Math.max(0, l.received - l.damaged);
        const rejected = Math.max(0, received - sellable - damaged);
        let pool = Math.min(received, qty(balances, l.skuEnrollmentId, 'receiving'));
        const take = (n: number) => {
          const t = Math.min(n, pool);
          pool -= t;
          return t;
        };
        const goodIn = take(sellable);
        const damagedIn = take(damaged);
        const rejectedIn = take(rejected);
        const used = goodIn + damagedIn + rejectedIn;
        await this.core.move(tx, { ...mv, skuEnrollmentId: l.skuEnrollmentId, movement: 'received', quantity: goodIn, from: 'receiving', to: 'available' });
        await this.core.move(tx, { ...mv, skuEnrollmentId: l.skuEnrollmentId, movement: 'received', quantity: sellable - goodIn, from: null, to: 'available', reason: 'More units than expected' });
        await this.core.move(tx, { ...mv, skuEnrollmentId: l.skuEnrollmentId, movement: 'received_damaged', quantity: damagedIn, from: 'receiving', to: 'unsellable', reason: 'Damaged on arrival' });
        await this.core.move(tx, { ...mv, skuEnrollmentId: l.skuEnrollmentId, movement: 'received_damaged', quantity: damaged - damagedIn, from: null, to: 'unsellable', reason: 'Damaged on arrival' });
        await this.core.move(tx, { ...mv, skuEnrollmentId: l.skuEnrollmentId, movement: 'not_accepted', quantity: rejectedIn, from: 'receiving', to: null, reason: 'Not accepted when the receipt was confirmed' });
        const bal = balances.get(l.skuEnrollmentId) ?? {};
        bal.receiving = (bal.receiving ?? 0) - used;
        balances.set(l.skuEnrollmentId, bal);
        if (sellable > 0) sellableSkus.push(l.skuEnrollmentId);
        units += sellable;
      }
      await tx.update('inbound_receipts', locked.id, { state: 'confirmed', confirmed_by: actorText(by.actor), confirmed_at: this.now(), inventory_receipt_id: locked.inventory_receipt_id ?? (isUuid(e.inboundId) ? e.inboundId : null) });
      const activated = await this.parts.skus.activateWithStock(tx, sellableSkus);
      const enrollment = sellableSkus.length ? await this.parts.enrollment.activateIfApproved(tx, inbound.seller_id) : null;
      return { activated, enrollment, units };
    });
    if (!result) return;
    await this.parts.skus.activated(result.activated, by);
    if (result.enrollment) await this.parts.enrollment.activated(result.enrollment, by);
    await this.core.notifySeller(inbound.seller_id, 'seller.fulfillment.stock_available', { inbound: { ref: inbound.ref }, units: result.units }, { kind: 'queue', id: inbound.id, ref: inbound.ref, label: 'View stock', screen: 'seller/inventory' }, `fs:receipt:${receipt.id}:confirmed`);
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
            summary: `Reimburse the seller ${fmt(body.amount)} for inbound ${row.ref}`,
            details: { inboundId: id, ref: row.ref, missing, discrepancy: disc.summary },
            reason,
            requestedBy: principal,
          });
          throw new AppError('APPROVAL_REQUIRED', `${check.reason || 'Above your reimbursement limit'}; sent for approval.`, { approvalRequestId: req.id, approval: { required: true, approvalRequestId: req.id, approvers: (check.eligibleApproverRoles ?? []).map((r) => r.name) } });
        }
      }
    }
    // found units: inventory first (the item sells from the service location, then the units are added there)
    const found = new Map<string, number>();
    if (body.decision === 'adjust_stock') {
      let left = body.units!;
      for (const l of lines) {
        const n = Math.min(left, Math.max(0, l.expected - l.received));
        if (n > 0) found.set(l.sku_enrollment_id, n);
        left -= n;
        if (left <= 0) break;
      }
      const skus = new Map((await this.repo.find('sku_enrollments', { id: [...found.keys()] })).map((s) => [s.id, s]));
      const location = await this.core.requireLocation();
      for (const [skuId, n] of found) {
        const sku = skus.get(skuId)!;
        if (sku.state !== 'active') await this.core.setServiceLocation(sku, location.locationId, by.actor, { strict: true });
        await this.core.moveStock({ key: `fs:found:${id}:${skuId}`, sku, from: null, to: 'available', quantity: n, reasonCode: 'service_found', ref: { kind: 'service_inbound', id, label: `Found units ${row.ref}` }, actor: by.actor }, { strict: true, location });
      }
    }
    const after = await this.applyDecision(id, body.decision, { found, amount: body.amount ?? null, reason }, by);
    await this.core.audit(
      {
        action: 'fulfillment-service.inbound.discrepancy_decide',
        actionLabel: 'Decided an inbound discrepancy claim',
        category: body.decision === 'reimburse' ? 'financial' : 'inventory',
        target: { type: 'inbound_shipment', id, ref: row.ref, label: `Inbound ${row.ref} discrepancy`, sellerId: row.seller_id, screen: 'ops/receiving' },
        before: { discrepancy: disc.summary, claim: disc.claim_note },
        after: { decision: body.decision, units: body.units ?? null, amount: body.amount ?? null },
        reason,
      },
      by,
    );
    return this.parts.views.inbound(after);
  }

  private async applyDecision(id: string, decision: 'adjust_stock' | 'reimburse' | 'reject', o: { found?: Map<string, number>; amount: common.Money | null; reason: string; claim?: string }, by: By): Promise<InboundRec> {
    const result = await this.repo.transaction(async (tx) => {
      if (o.claim && !(await tx.claim(o.claim))) return null; // the decision was already applied
      const locked = (await tx.get('inbound_shipments', id, { forUpdate: true }))!;
      const disc = await tx.findOne('discrepancies', { inbound_id: id }, { forUpdate: true });
      if (locked.state !== 'received' || !disc || disc.decision) return null;
      let text = '';
      let activated: SkuRec[] = [];
      let enrollment: EnrollmentRec | null = null;
      if (decision === 'adjust_stock') {
        // `received` is read and written back without a lock of its own: the inbound record above is locked, and
        // every writer of its lines locks it first, so the parent's lock covers the children (docs/10 Appendix C)
        const lines = await tx.find('inbound_lines', { inbound_id: id });
        let units = 0;
        for (const [skuId, n] of o.found ?? []) {
          const l = lines.find((x) => x.sku_enrollment_id === skuId);
          if (!l) continue;
          await this.core.move(tx, { sellerId: locked.seller_id, skuEnrollmentId: skuId, movement: 'adjusted', quantity: n, from: null, to: 'available', reference: locked.ref, reason: `Found units: ${o.reason}`, actor: by.actor });
          await tx.updateWhere('inbound_lines', { inbound_id: id, sku_enrollment_id: skuId }, { received: l.received + n });
          units += n;
        }
        activated = await this.parts.skus.activateWithStock(tx, [...(o.found?.keys() ?? [])]);
        if (units) enrollment = await this.parts.enrollment.activateIfApproved(tx, locked.seller_id);
        text = `Stock adjusted: ${plural(units, 'unit')} added. ${o.reason}`;
      } else if (decision === 'reimburse') {
        const amount = o.amount!;
        await this.core.accrueReimbursement(tx, { sellerId: locked.seller_id, amount, reference: locked.ref, reason: o.reason, key: `reimbursement:${id}` });
        text = `Reimbursed ${fmt(amount)}. ${o.reason}`;
      } else {
        text = `Claim rejected. ${o.reason}`;
      }
      await tx.update('discrepancies', disc.id, { decision: text, decided_by: actorText(by.actor), decided_at: this.now() });
      const row = await tx.update('inbound_shipments', id, { state: inboundShipmentMachine.next('received', 'close') });
      return { row, text, activated, enrollment };
    });
    if (!result) return (await this.repo.get('inbound_shipments', id))!;
    await this.parts.skus.activated(result.activated, by);
    if (result.enrollment) await this.parts.enrollment.activated(result.enrollment, by);
    await this.core.resolveWork(`fs_discrepancy:${id}`, result.text, by.actor);
    await this.core.notifySeller(result.row.seller_id, 'seller.fulfillment.discrepancy_decided', { inbound: { ref: result.row.ref }, decision: result.text }, { kind: 'queue', id, ref: result.row.ref, label: 'View shipment', screen: 'seller/inventory' }, `fs:discrepancy:${id}`);
    return result.row;
  }

  /** access.approval.decided for fulfillment-service.reimbursements.approve (claimed once per request; posted by the post-fees job) */
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
    await this.applyDecision(row.id, 'reimburse', { amount: e.amount, reason: reason || 'Approved reimbursement', claim: `approval-decided:${e.requestId}` }, { actor: e.decidedBy ?? SYSTEM });
  }

  /* ---------------------------------------------------------------- job */

  /** Shipments past their expected arrival (fulfillment.receiving work items); unanswered discrepancies close */
  async overdue(): Promise<{ overdue: number; closed: number }> {
    const today = this.core.today();
    const late = await this.repo.find('inbound_shipments', { state: ['submitted', 'in_transit'], expected_arrival: { op: '<', value: today } }, { limit: 1000 });
    if (late.length) {
      const names = await this.core.sellerNames(late.map((r) => r.seller_id));
      for (const r of late) {
        await this.core.raise({
          queueKey: 'fulfillment.receiving',
          kind: 'receiving',
          title: `Inbound ${r.ref} is past its expected arrival`,
          summary: `${names.get(r.seller_id) ?? 'Seller'} · expected ${r.expected_arrival}${r.carrier ? ` · ${r.carrier} ${r.tracking ?? ''}`.trimEnd() : ''}`,
          subject: { type: 'other', id: r.id, ref: r.ref, label: 'Inbound shipment' },
          sellerId: r.seller_id,
          dedupeKey: `fs_inbound_overdue:${r.id}`,
        });
      }
    }
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

/** '2 short, 1 damaged, 3 extra' over the lines, or null when everything matched */
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
