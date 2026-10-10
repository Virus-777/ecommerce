/**
 * Warehouse fulfillments: created from accepted orders, picked in waves (bin and item scans), held for shortage and
 * damage reports until inventory resolves them, cancelled line by line with the order.
 */
import { AppError, isAppError } from '../../../kernel/errors/index.js';
import type { EventPayload } from '../../../kernel/events/index.js';
import { newId } from '../../../kernel/lib/ids.js';
import type { PageRequest } from '../../../kernel/lib/pagination.js';
import type * as common from '../../../spec/common.js';
import type { Fulfillment, FulfillmentRow, PickConfirm, ShortageReport, DamageReport, Wave } from '../../../spec/warehouse.js';
import { actorText, damageHold, deliveryChoiceLabel, itemMatches, NIL_UUID, parseActor, shortageHold, WAVE_DONE_STATUSES } from '../domain/rules.js';
import { waveMachine, warehouseFulfillmentMachine } from '../domain/state-machines.js';
import type { DiscrepancyNote, FulfillmentRec, LineRec, WarehouseRepository, WaveRec, Where } from '../ports.js';
import type { Bins } from './bins.js';
import { Batch, invalidField, notFound, type By, type Core } from './core.js';
import type { Views } from './views.js';

type FulfillmentEvent = Parameters<typeof warehouseFulfillmentMachine.next>[1];
type Status = Fulfillment['status'];

const PICKABLE: readonly string[] = ['awaiting_pick', 'picking', 'on_hold'];
const DEFAULT_LIST: Status[] = ['awaiting_pick', 'picking', 'picked', 'packing', 'packed', 'on_hold'];

export class Fulfillments {
  constructor(
    private readonly core: Core,
    private readonly views: Views,
    private readonly bins: Bins,
  ) {}

  private get repo() {
    return this.core.repo;
  }

  /* ---------------------------------------------------------------- reads */

  async load(id: string, tx: WarehouseRepository = this.repo, o: { forUpdate?: boolean } = {}): Promise<FulfillmentRec> {
    const f = await tx.get('fulfillments', id, o);
    if (!f) throw notFound('Fulfillment');
    return f;
  }

  async get(id: string, o: { detail?: boolean } = {}): Promise<Fulfillment> {
    const f = await this.load(id);
    const parts = await this.views.parts([f]);
    let otherSellers: string[] | undefined;
    if (o.detail && f.total_packages_in_order > 1) {
      const order = await this.core.ctx
        .use('orders')
        .getOrder(f.order_id)
        .catch((err) => {
          if (!isAppError(err)) throw err;
          return null;
        });
      otherSellers = order ? [...new Set(order.groups.filter((g) => g.id !== f.seller_group_id).map((g) => g.seller.name))] : undefined;
    }
    return this.views.fulfillment(f, parts, { otherSellers });
  }

  async list(q: { status?: Status; waveId?: string; shipByBefore?: string; q?: string }, page: PageRequest): Promise<common.Page<FulfillmentRow>> {
    const where: Where<FulfillmentRec> = { status: q.status ? q.status : DEFAULT_LIST };
    if (q.waveId) where.wave_id = q.waveId;
    if (q.shipByBefore) where.ship_by = { op: '<=', value: new Date(q.shipByBefore) };
    const result = await this.repo.page('fulfillments', where, page, { order: { column: 'ship_by', direction: 'asc' }, ...(q.q?.trim() ? { search: { columns: ['order_ref'], term: q.q } } : {}) });
    return { ...result, items: await this.views.rows(result.items) };
  }

  async forOrder(orderId: string): Promise<Fulfillment | null> {
    const rows = await this.repo.find('fulfillments', { order_id: orderId }, { orderBy: [['created_at', 'desc']] });
    const f = rows.find((r) => r.status !== 'cancelled') ?? rows[0];
    return f ? ((await this.views.fulfillments([f]))[0] ?? null) : null;
  }

  async forGroups(groupIds: string[]): Promise<Record<string, Fulfillment | null>> {
    const out: Record<string, Fulfillment | null> = Object.fromEntries(groupIds.map((id) => [id, null]));
    const ids = [...new Set(groupIds)];
    if (!ids.length) return out;
    const rows = await this.repo.find('fulfillments', { seller_group_id: ids });
    for (const v of await this.views.fulfillments(rows)) out[v.sellerGroupId] = v;
    return out;
  }

  /* ---------------------------------------------------------------- transitions */

  /** Moves a fulfillment through its state machine (ILLEGAL_TRANSITION otherwise) and queues status_changed */
  async move(tx: WarehouseRepository, f: FulfillmentRec, event: FulfillmentEvent, batch: Batch, o: { reason?: string | null; patch?: Partial<FulfillmentRec> } = {}): Promise<FulfillmentRec> {
    const to = warehouseFulfillmentMachine.next(f.status as never, event);
    const after = await tx.update('fulfillments', f.id, { ...o.patch, status: to, updated_at: this.core.now() });
    batch.push('warehouse.fulfillment.status_changed', { fulfillmentId: f.id, orderId: f.order_id, sellerGroupId: f.seller_group_id, from: f.status, to, reason: o.reason ?? null });
    return after;
  }

  /** Picking is finished when every line still wanted is picked */
  static allPicked = (lines: LineRec[]) => {
    const live = lines.filter((l) => l.state !== 'cancelled');
    return live.length > 0 && live.every((l) => l.state === 'picked');
  };

  /** A wave completes when each of its orders is packed, on hold or cancelled; on-hold orders move to the next wave */
  async settleWave(tx: WarehouseRepository, waveId: string | null): Promise<void> {
    if (!waveId) return;
    const w = await tx.get('waves', waveId, { forUpdate: true });
    if (!w) return;
    const fs = await tx.find('fulfillments', { wave_id: waveId });
    const now = this.core.now();
    if (w.status === 'picking' && fs.every((f) => WAVE_DONE_STATUSES.includes(f.status))) {
      await tx.update('waves', waveId, { status: waveMachine.next('picking', 'complete'), completed_at: now });
      const held = fs.filter((f) => f.status === 'on_hold').map((f) => f.id);
      if (held.length) await tx.updateWhere('fulfillments', { id: held }, { wave_id: null, updated_at: now });
    } else if (w.status === 'open' && fs.length && fs.every((f) => f.status === 'cancelled')) {
      await tx.update('waves', waveId, { status: waveMachine.next('open', 'cancel'), completed_at: now });
    }
  }

  /* ---------------------------------------------------------------- creation */

  /** orders.order.accepted: one fulfillment per Official Store seller group, lines with stock items and primary bins */
  async onOrderAccepted(e: EventPayload<'orders.order.accepted'>): Promise<void> {
    const orders = this.core.ctx.use('orders');
    for (const g of e.groups) {
      if (g.fulfilledBy !== 'official_warehouse' || g.ownerType !== 'official') continue;
      if ((await this.repo.count('fulfillments', { seller_group_id: g.groupId })) > 0) continue;
      let task;
      try {
        task = await orders.getFulfillmentTask(g.groupId);
      } catch (err) {
        if (!isAppError(err)) throw err;
        this.core.ctx.log.warn({ err, groupId: g.groupId }, 'warehouse: accepted order group has no fulfillment task');
        continue;
      }
      if (!task.openLines.length) continue;
      const stockIds = task.openLines.map((l) => l.stockItemId);
      const info = await this.core.stockInfo(stockIds);
      const primaries = await this.repo.find('bin_assignments', { stock_item_id: stockIds, primary_bin: true });
      const bins = primaries.length ? await this.repo.find('bins', { id: primaries.map((a) => a.bin_id), active: true }) : [];
      const locationId = bins[0]?.location_id ?? (await this.core.defaultLocation()) ?? NIL_UUID;
      const binOf = (stockItemId: string) => {
        const a = primaries.find((x) => x.stock_item_id === stockItemId);
        return (a && bins.find((b) => b.id === a.bin_id && b.location_id === locationId)?.code) ?? null;
      };
      const now = this.core.now();
      const id = newId();
      const shipBy = new Date(task.dispatchDeadline.dueAt || g.dispatchBy);
      const created = await this.repo.transaction(async (tx) => {
        const inserted = await tx.insertIfNew('fulfillments', {
          id,
          order_id: task.orderId,
          order_ref: task.orderRef,
          seller_group_id: g.groupId,
          location_id: locationId,
          status: warehouseFulfillmentMachine.initial,
          ship_by: shipBy,
          delivery_choice: deliveryChoiceLabel(task.delivery),
          ship_to: task.shipTo,
          wave_id: null,
          hold_reason: null,
          discrepancy_ids: [],
          total_packages_in_order: Math.max(1, e.groups.length),
          created_at: now,
          updated_at: now,
        });
        if (!inserted) return false;
        await tx.insertMany(
          'fulfillment_lines',
          task.openLines.map((l) => ({
            id: newId(),
            fulfillment_id: id,
            order_item_id: l.orderItemId,
            stock_item_id: l.stockItemId,
            sku: info.get(l.stockItemId)?.sku ?? l.sellerSku ?? l.stockItemId.slice(0, 8).toUpperCase(),
            label: info.get(l.stockItemId)?.label ?? [l.title, l.variantLabel].filter(Boolean).join(', '),
            quantity: l.quantityToShip,
            bin_code: binOf(l.stockItemId),
            picked: 0,
            short: 0,
            state: 'pending',
            picked_by: null,
            picked_at: null,
          })),
        );
        return true;
      });
      if (created) this.core.publish('warehouse.fulfillment.created', { fulfillmentId: id, orderId: task.orderId, sellerGroupId: g.groupId, shipBy: shipBy.toISOString() });
    }
  }

  /* ---------------------------------------------------------------- waves */

  async listWaves(q: { status?: Wave['status']; locationId?: string }, page: PageRequest): Promise<common.Page<Wave>> {
    const where: Where<WaveRec> = {};
    if (q.status) where.status = q.status;
    if (q.locationId) where.location_id = q.locationId;
    const result = await this.repo.page('waves', where, page, { order: { column: 'created_at', direction: 'desc' } });
    return { ...result, items: await this.views.waves(result.items) };
  }

  async getWave(id: string): Promise<Wave> {
    const w = await this.repo.get('waves', id);
    if (!w) throw notFound('Wave');
    return (await this.views.waves([w]))[0]!;
  }

  /** Given orders, or every order awaiting pick at the location (due by the pickup when one is given) */
  async createWave(body: { locationId: string; fulfillmentIds?: string[] | null; carrierPickupAt?: string | null }, by: By): Promise<Wave> {
    const cfg = await this.core.cfg();
    const pickup = body.carrierPickupAt ? new Date(body.carrierPickupAt) : this.core.pickups(cfg).next;
    if (pickup && Number.isNaN(pickup.getTime())) throw invalidField('carrierPickupAt', 'Enter a valid pickup time');
    const now = this.core.now();
    const wave = await this.repo.transaction(async (tx) => {
      let rows: FulfillmentRec[];
      const ids = [...new Set(body.fulfillmentIds ?? [])];
      if (ids.length) {
        rows = await tx.find('fulfillments', { id: ids }, { forUpdate: true });
        const waves = await tx.find('waves', { id: [...new Set(rows.map((r) => r.wave_id).filter((x): x is string => Boolean(x)))] });
        const issues: { path: string; message: string }[] = [];
        ids.forEach((id, i) => {
          const f = rows.find((r) => r.id === id);
          const path = `fulfillmentIds.${i}`;
          if (!f) issues.push({ path, message: 'Unknown fulfillment' });
          else if (f.location_id !== body.locationId) issues.push({ path, message: `${f.order_ref} is picked at another location` });
          else if (!PICKABLE.includes(f.status)) issues.push({ path, message: `${f.order_ref} is ${f.status.replace('_', ' ')}` });
          else if (f.wave_id && ['open', 'picking'].includes(waves.find((w) => w.id === f.wave_id)?.status ?? '')) issues.push({ path, message: `${f.order_ref} is already in ${waves.find((w) => w.id === f.wave_id)!.ref}` });
        });
        if (issues.length) throw new AppError('VALIDATION_FAILED', issues[0]!.message, { issues });
      } else {
        rows = await tx.find(
          'fulfillments',
          { location_id: body.locationId, status: [...PICKABLE], wave_id: null, ...(body.carrierPickupAt ? { ship_by: { op: '<=' as const, value: pickup! } } : {}) },
          { orderBy: [['ship_by', 'asc']], forUpdate: true },
        );
        if (!rows.length) throw invalidField('fulfillmentIds', body.carrierPickupAt ? 'No orders are waiting to be picked before that pickup' : 'No orders are waiting to be picked');
      }
      const today = await tx.count('waves', { location_id: body.locationId, created_at: { op: '>=', value: this.core.dayStart() } });
      const w = await tx.insert('waves', { id: newId(), ref: `Wave ${today + 1}`, location_id: body.locationId, status: waveMachine.initial, carrier_pickup_at: pickup, created_by: actorText(by.actor), created_at: now, completed_at: null });
      await tx.updateWhere('fulfillments', { id: rows.map((r) => r.id) }, { wave_id: w.id, updated_at: now });
      return w;
    });
    return (await this.views.waves([wave]))[0]!;
  }

  /** Starts picking: orders awaiting pick move to picking (which closes instant customer cancellation in orders) */
  async startWave(id: string, by: By): Promise<Wave> {
    const batch = new Batch(by);
    const w = await this.repo.transaction(async (tx) => {
      const w = await tx.get('waves', id, { forUpdate: true });
      if (!w) throw notFound('Wave');
      const after = await tx.update('waves', id, { status: waveMachine.next(w.status as never, 'start') });
      for (const f of await tx.find('fulfillments', { wave_id: id, status: 'awaiting_pick' }, { forUpdate: true })) await this.move(tx, f, 'startPicking', batch, { reason: `${w.ref} started` });
      await this.settleWave(tx, id);
      return after;
    });
    this.core.flush(batch);
    return (await this.views.waves([(await this.repo.get('waves', w.id))!]))[0]!;
  }

  /* ---------------------------------------------------------------- picking */

  private async lineAndFulfillment(lineId: string): Promise<{ line: LineRec; f: FulfillmentRec }> {
    const line = await this.repo.get('fulfillment_lines', lineId);
    if (!line) throw notFound('Pick line');
    return { line, f: await this.load(line.fulfillment_id) };
  }

  private checkPickable(f: FulfillmentRec, line: LineRec) {
    if (f.status === 'on_hold') throw this.core.error('FULFILLMENT_ON_HOLD', f.hold_reason ?? `${f.order_ref} is on hold`, { holdReason: f.hold_reason });
    if (f.status !== 'picking') {
      throw new AppError('ILLEGAL_TRANSITION', f.status === 'awaiting_pick' ? `${f.order_ref} is not being picked yet. Start its wave first.` : `${f.order_ref} is ${f.status.replace('_', ' ')}; nothing is left to pick`, { machine: 'Warehouse fulfillment', from: f.status, event: 'pick', allowed: [] });
    }
    if (line.state !== 'pending') throw new AppError('ILLEGAL_TRANSITION', `This line is ${line.state}`, { machine: 'Pick line', from: line.state, event: 'pick', allowed: [] });
  }

  private checkClaim(line: LineRec, by: By) {
    const picker = parseActor(line.picked_by);
    if (line.picked > 0 && picker?.id && by.actor.id && picker.id !== by.actor.id) {
      throw new AppError('CONFLICT', `${picker.name ?? 'Another picker'} is picking this line`, { pickedBy: picker });
    }
  }

  /** Confirms a pick: the scanned bin and item must match the line; counts never exceed what was ordered */
  async pickLine(lineId: string, body: PickConfirm, by: By): Promise<Fulfillment> {
    const cfg = await this.core.cfg();
    const { line, f } = await this.lineAndFulfillment(lineId);
    this.checkPickable(f, line);
    this.checkClaim(line, by);
    const qty = body.quantity;
    if (!Number.isInteger(qty) || qty < 1) throw invalidField('quantity', 'Pick at least one unit');
    const left = line.quantity - line.picked;
    if (qty > left) throw invalidField('quantity', `Only ${left} left to pick on this line`);
    if (cfg.requireItemScan && qty !== 1) throw invalidField('quantity', 'Scan each unit: one unit per scan');
    const mismatch = async (what: 'bin' | 'item', expected: string | null, scanned: string, message: string) => {
      await this.core.logScan({ context: 'pick', contextId: line.id, code: scanned, result: `wrong_${what}`, actor: by.actor });
      return this.core.error('SCAN_MISMATCH', message, { expected, scanned, kind: what });
    };
    const binCode = body.binCode?.trim() ?? '';
    if (cfg.requireBinScan || binCode) {
      const bin = binCode ? await this.bins.byScan(binCode, f.location_id) : undefined;
      const ok = line.bin_code ? bin?.code === line.bin_code : Boolean(bin?.active);
      if (!ok) throw await mismatch('bin', line.bin_code, binCode, line.bin_code ? `Wrong bin: pick from ${line.bin_code}` : 'Scan the bin you pick from');
    }
    const itemCode = body.itemCode?.trim() ?? '';
    if (cfg.requireItemScan || itemCode) {
      // the SKU label or the variant GTIN (the manufacturer barcode)
      const gtins = itemCode && !itemMatches(itemCode, { sku: line.sku, stockItemId: line.stock_item_id }) ? await this.core.gtins([line.stock_item_id]) : new Map<string, string>();
      if (!itemMatches(itemCode, { sku: line.sku, stockItemId: line.stock_item_id, extraCodes: [gtins.get(line.stock_item_id)] })) {
        const siblings = await this.repo.find('fulfillment_lines', { fulfillment_id: f.id });
        const sibGtins = await this.core.gtins(siblings.map((l) => l.stock_item_id));
        const other = siblings.find((l) => l.id !== line.id && itemMatches(itemCode, { sku: l.sku, stockItemId: l.stock_item_id, extraCodes: [sibGtins.get(l.stock_item_id)] }));
        throw await mismatch('item', line.sku, itemCode, other ? `Wrong item: this line is ${line.sku}; ${other.sku} is another line of the order` : `Wrong item: not on this pick list (expected ${line.sku})`);
      }
    }
    const batch = new Batch(by);
    await this.repo.transaction(async (tx) => {
      const fresh = await this.load(f.id, tx, { forUpdate: true });
      const l = (await tx.get('fulfillment_lines', lineId, { forUpdate: true }))!;
      this.checkPickable(fresh, l);
      this.checkClaim(l, by);
      if (qty > l.quantity - l.picked) throw invalidField('quantity', `Only ${l.quantity - l.picked} left to pick on this line`);
      const picked = l.picked + qty;
      await tx.update('fulfillment_lines', lineId, { picked, state: picked >= l.quantity ? 'picked' : 'pending', picked_by: actorText(by.actor), picked_at: this.core.now() });
      await this.core.logScan({ context: 'pick', contextId: lineId, code: `${binCode}|${itemCode}`, result: `picked ${qty}`, actor: by.actor }, tx);
      if (Fulfillments.allPicked(await tx.find('fulfillment_lines', { fulfillment_id: f.id }))) await this.move(tx, fresh, 'finishPicking', batch, { reason: 'All items picked' });
    });
    this.core.flush(batch);
    return this.get(f.id);
  }

  /** The bin has fewer units than the line needs: the order is held (not packed partly) and inventory resolves it */
  async reportShortage(lineId: string, body: ShortageReport, by: By): Promise<Fulfillment> {
    const { line, f } = await this.lineAndFulfillment(lineId);
    warehouseFulfillmentMachine.next(f.status as never, 'hold');
    if (f.status !== 'picking' || line.state !== 'pending') throw new AppError('ILLEGAL_TRANSITION', `This line is ${line.state}; only lines still to pick can be short`, { machine: 'Pick line', from: line.state, event: 'report_shortage', allowed: [] });
    const left = line.quantity - line.picked;
    const found = body.quantityFound;
    if (!Number.isInteger(found) || found < 0) throw invalidField('quantityFound', 'Enter how many units you found (0 if the bin is empty)');
    if (found >= left) throw invalidField('quantityFound', `All ${left} needed units are there: confirm the pick instead`);
    const short = left - found;
    const d = await this.core.ctx.use('inventory').reportDiscrepancy({
      kind: 'pick_shortage',
      stockItemId: line.stock_item_id,
      locationId: f.location_id,
      ...(line.bin_code ? { binCode: line.bin_code } : {}),
      quantity: short,
      orderId: f.order_id,
      orderRef: f.order_ref,
      ...(body.note ? { note: body.note } : {}),
      reportedBy: by.actor,
    });
    const batch = new Batch(by);
    const now = this.core.now();
    await this.repo.transaction(async (tx) => {
      const fresh = await this.load(f.id, tx, { forUpdate: true });
      const l = (await tx.get('fulfillment_lines', lineId, { forUpdate: true }))!;
      const note: DiscrepancyNote = { id: d.id, kind: 'pick_shortage', lineId, stockItemId: l.stock_item_id, quantity: short, binCode: l.bin_code, open: true, resolution: null, reportedAt: now.toISOString() };
      await tx.update('fulfillment_lines', lineId, { picked: l.picked + found, short, state: 'short', ...(found > 0 ? { picked_by: actorText(by.actor), picked_at: now } : {}) });
      const reason = shortageHold(l.bin_code, l.picked + found, l.quantity);
      if (fresh.status === 'on_hold') await tx.update('fulfillments', f.id, { hold_reason: reason, discrepancy_ids: [...fresh.discrepancy_ids, note], updated_at: now });
      else await this.move(tx, fresh, 'hold', batch, { reason, patch: { hold_reason: reason, discrepancy_ids: [...fresh.discrepancy_ids, note] } });
      await this.core.logScan({ context: 'pick', contextId: lineId, code: l.bin_code ?? '', result: `short ${short}`, actor: by.actor }, tx);
      await this.settleWave(tx, fresh.wave_id);
      batch.push('warehouse.shortage.reported', { fulfillmentId: f.id, orderId: f.order_id, stockItemId: l.stock_item_id, binCode: l.bin_code, quantityShort: short, discrepancyId: d.id });
    });
    this.core.flush(batch);
    return this.get(f.id);
  }

  /** A damaged unit at pick or pack, also once every line is picked (photos required): inventory moves it to Damaged or held, the order waits */
  async reportDamage(id: string, body: DamageReport, by: By): Promise<Fulfillment> {
    const f = await this.load(id);
    const line = (await this.repo.find('fulfillment_lines', { id: body.lineId, fulfillment_id: id }))[0];
    if (!line) throw notFound('Line');
    warehouseFulfillmentMachine.next(f.status as never, 'hold');
    const issues: { path: string; message: string }[] = [];
    if (!body.photoIds?.length) issues.push({ path: 'photoIds', message: 'Add at least one photo of the damage' });
    if (!body.note?.trim()) issues.push({ path: 'note', message: 'Describe the damage' });
    if (!Number.isInteger(body.quantity) || body.quantity < 1 || body.quantity > line.quantity) issues.push({ path: 'quantity', message: `Between 1 and ${line.quantity} units` });
    if (line.state === 'cancelled') issues.push({ path: 'lineId', message: 'This line was cancelled' });
    if (issues.length) throw new AppError('VALIDATION_FAILED', issues[0]!.message, { issues });
    // the photos are inspection evidence of this fulfillment (media usage inspection_photo), so the orphan sweep keeps them
    const media = this.core.ctx.tryUse('media');
    if (media) {
      for (const assetId of [...new Set(body.photoIds)]) await media.attach(assetId, { module: 'warehouse', kind: 'inspection_photo', refId: id, refLabel: `Damage on ${f.order_ref}` }, { kind: 'staff', id: by.actor.id ?? null });
    }
    const d = await this.core.ctx.use('inventory').reportDiscrepancy({
      kind: 'damage_found',
      stockItemId: line.stock_item_id,
      locationId: f.location_id,
      ...(line.bin_code ? { binCode: line.bin_code } : {}),
      quantity: body.quantity,
      orderId: f.order_id,
      orderRef: f.order_ref,
      note: body.note.trim(),
      photoIds: body.photoIds,
      reportedBy: by.actor,
    });
    const batch = new Batch(by);
    const now = this.core.now();
    await this.repo.transaction(async (tx) => {
      const fresh = await this.load(id, tx, { forUpdate: true });
      const l = (await tx.get('fulfillment_lines', line.id, { forUpdate: true }))!;
      // the damaged units are set aside: replacements are picked (and scanned into the box) again
      const picked = Math.max(0, l.picked - body.quantity);
      await tx.update('fulfillment_lines', l.id, { picked, state: l.state === 'picked' && picked < l.quantity ? 'pending' : l.state });
      const pkgs = await tx.find('packages', { fulfillment_id: id, status: ['open', 'labelled'] });
      if (pkgs.length) {
        for (const it of await tx.find('package_items', { package_id: pkgs.map((p) => p.id), order_item_id: l.order_item_id })) {
          const scanned = Math.max(0, it.scanned - body.quantity);
          await tx.updateWhere('package_items', { package_id: it.package_id, order_item_id: it.order_item_id }, { scanned, serial_numbers: (it.serial_numbers ?? []).slice(0, scanned) });
        }
      }
      const note: DiscrepancyNote = { id: d.id, kind: 'damage_found', lineId: l.id, stockItemId: l.stock_item_id, quantity: body.quantity, binCode: l.bin_code, open: true, resolution: null, reportedAt: now.toISOString() };
      const reason = damageHold(l.label, body.quantity);
      if (fresh.status === 'on_hold') await tx.update('fulfillments', id, { hold_reason: reason, discrepancy_ids: [...fresh.discrepancy_ids, note], updated_at: now });
      else await this.move(tx, fresh, 'hold', batch, { reason, patch: { hold_reason: reason, discrepancy_ids: [...fresh.discrepancy_ids, note] } });
      await this.settleWave(tx, fresh.wave_id);
      batch.push('warehouse.damage.reported', { fulfillmentId: id, orderId: f.order_id, stockItemId: l.stock_item_id, quantity: body.quantity, discrepancyId: d.id });
    });
    this.core.flush(batch);
    return this.get(id);
  }

  /** Back to picking: short lines are picked again from what inventory reallocated; fully picked orders go on to packing */
  private async doResume(tx: WarehouseRepository, f: FulfillmentRec, batch: Batch, reason: string): Promise<FulfillmentRec> {
    const lines = await tx.find('fulfillment_lines', { fulfillment_id: f.id }, { forUpdate: true });
    for (const l of lines.filter((x) => x.state === 'short')) await tx.update('fulfillment_lines', l.id, { short: 0, state: l.picked >= l.quantity ? 'picked' : 'pending' });
    let after = await this.move(tx, f, 'resume', batch, { reason, patch: { hold_reason: null } });
    if (Fulfillments.allPicked(await tx.find('fulfillment_lines', { fulfillment_id: f.id }))) after = await this.move(tx, after, 'finishPicking', batch, { reason: 'All items picked' });
    return after;
  }

  /** Staff resume a held order once inventory resolved every shortage and damage report */
  async resume(id: string, body: { note?: string | null }, by: By): Promise<Fulfillment> {
    const f = await this.load(id);
    warehouseFulfillmentMachine.next(f.status as never, 'resume');
    const open = f.discrepancy_ids.filter((d) => d.open);
    if (open.length) throw this.core.error('DISCREPANCY_OPEN', 'Inventory has not resolved the shortage or damage yet', { discrepancyIds: open.map((d) => d.id) });
    const batch = new Batch(by);
    await this.repo.transaction(async (tx) => {
      const fresh = await this.load(id, tx, { forUpdate: true });
      if (fresh.discrepancy_ids.some((d) => d.open)) throw this.core.error('DISCREPANCY_OPEN', 'Inventory has not resolved the shortage or damage yet');
      await this.doResume(tx, fresh, batch, body.note?.trim() || 'Resumed by the warehouse');
    });
    this.core.flush(batch);
    return this.get(id);
  }

  /* ---------------------------------------------------------------- consumers */

  /** inventory.discrepancy.resolved: the report closes; reallocated → the held order resumes by itself */
  async onDiscrepancyResolved(e: EventPayload<'inventory.discrepancy.resolved'>): Promise<void> {
    const candidates = e.orderId ? await this.repo.find('fulfillments', { order_id: e.orderId }) : await this.repo.find('fulfillments', { status: 'on_hold' }, { limit: 500 });
    const f = candidates.find((x) => x.discrepancy_ids.some((d) => d.id === e.discrepancyId));
    if (!f) {
      this.core.ctx.log.debug({ discrepancyId: e.discrepancyId }, 'warehouse: resolved discrepancy of no fulfillment, ignored');
      return;
    }
    const batch = new Batch({ actor: { kind: 'system', id: null, name: 'Inventory' } });
    await this.repo.transaction(async (tx) => {
      const fresh = await this.load(f.id, tx, { forUpdate: true });
      const note = fresh.discrepancy_ids.find((d) => d.id === e.discrepancyId);
      if (!note || !note.open) return;
      const notes = fresh.discrepancy_ids.map((d) => (d.id === e.discrepancyId ? { ...d, open: false, resolution: e.resolution } : d));
      const allClosed = notes.every((d) => !d.open);
      const reallocated = notes.filter((d) => d.resolution).every((d) => d.resolution === 'reallocated');
      const updated = await tx.update('fulfillments', f.id, {
        discrepancy_ids: notes,
        updated_at: this.core.now(),
        ...(fresh.status === 'on_hold' && allClosed && !reallocated ? { hold_reason: `Inventory resolved the report (${e.resolution.replace('_', ' ')}). Resume when ready.` } : {}),
      });
      if (updated.status === 'on_hold' && allClosed && reallocated) await this.doResume(tx, updated, batch, 'Inventory reallocated the stock');
    });
    this.core.flush(batch);
  }

  /** orders.item.cancelled: the line goes (picked units back to the bin); packed or labelled boxes are flagged to reopen */
  async onItemCancelled(e: EventPayload<'orders.item.cancelled'>): Promise<void> {
    if (e.ownerType !== 'official') return;
    const f = (await this.repo.find('fulfillments', { seller_group_id: e.groupId }))[0];
    if (!f) return;
    if ((await this.repo.count('scan_log', { context: 'order_cancel', context_id: e.cancellationId })) > 0) return;
    const actor: common.Actor = { kind: 'system', id: null, name: 'Orders' };
    const batch = new Batch({ actor });
    await this.repo.transaction(async (tx) => {
      const fresh = await this.load(f.id, tx, { forUpdate: true });
      const lines = await tx.find('fulfillment_lines', { fulfillment_id: f.id }, { forUpdate: true });
      const line = lines.find((l) => l.order_item_id === e.itemId && l.state !== 'cancelled') ?? lines.find((l) => l.stock_item_id === e.stockItemId && l.state !== 'cancelled');
      await this.core.logScan({ context: 'order_cancel', contextId: e.cancellationId, code: e.itemId, result: line ? `cancelled ${e.quantity}` : 'no line', actor }, tx);
      if (!line) return;
      const qty = Math.min(e.quantity, line.quantity);
      const left = line.quantity - qty;
      const backToBin = Math.max(0, line.picked - left);
      if (left === 0) await tx.update('fulfillment_lines', line.id, { state: 'cancelled', picked: 0, short: 0 });
      else {
        const picked = Math.min(line.picked, left);
        const short = Math.min(line.short, left - picked);
        await tx.update('fulfillment_lines', line.id, { quantity: left, picked, short, state: line.state === 'short' && short > 0 ? 'short' : picked >= left ? 'picked' : 'pending' });
      }
      if (backToBin > 0) await this.core.logScan({ context: 'order_cancel', contextId: line.id, code: line.bin_code ?? line.sku, result: `return ${backToBin} to bin`, actor }, tx);
      const pkgs = await tx.find('packages', { fulfillment_id: f.id, status: ['open', 'labelled', 'packed'] });
      for (const p of pkgs) {
        const it = (await tx.find('package_items', { package_id: p.id, order_item_id: line.order_item_id }))[0];
        if (!it) continue;
        if (p.status === 'open') {
          const quantity = it.quantity - qty;
          if (quantity <= 0) await tx.removeWhere('package_items', { package_id: p.id, order_item_id: it.order_item_id });
          else await tx.updateWhere('package_items', { package_id: p.id, order_item_id: it.order_item_id }, { quantity, scanned: Math.min(it.scanned, quantity), serial_numbers: (it.serial_numbers ?? []).slice(0, Math.min(it.scanned, quantity)) });
        } else {
          const flag = `Reopen: ${qty} × ${line.label} cancelled. Return to ${line.bin_code ?? 'its bin'}.`;
          await tx.update('packages', p.id, { handling_note: p.handling_note ? `${p.handling_note} ${flag}` : flag });
        }
      }
      const after = await tx.find('fulfillment_lines', { fulfillment_id: f.id });
      if (after.every((l) => l.state === 'cancelled')) {
        if (warehouseFulfillmentMachine.can(fresh.status as never, 'cancel')) {
          await this.move(tx, fresh, 'cancel', batch, { reason: 'Every item was cancelled', patch: { hold_reason: null } });
          await tx.updateWhere('packages', { fulfillment_id: f.id, status: 'open' }, { status: 'voided' });
        } else this.core.ctx.log.warn({ fulfillmentId: f.id, status: fresh.status }, 'warehouse: every item cancelled after packing started; packages flagged to reopen');
      } else if (fresh.status === 'picking' && Fulfillments.allPicked(after)) await this.move(tx, fresh, 'finishPicking', batch, { reason: 'All remaining items picked' });
      await this.settleWave(tx, fresh.wave_id);
    });
    this.core.flush(batch);
  }

  /**
   * orders.item.split (decision S-D1): the line of itemId is split so newItemId gets its own line with
   * `quantity` units; picked (and short) units stay on the original line first, and open package items
   * follow the same split. Later cancel and dispatch events naming either item find their line.
   * Idempotent per newItemId.
   */
  async onItemSplit(e: EventPayload<'orders.item.split'>): Promise<void> {
    // only Official Store groups have a fulfillment
    const f = (await this.repo.find('fulfillments', { seller_group_id: e.groupId }))[0];
    if (!f) return;
    await this.repo.transaction(async (tx) => {
      const lines = await tx.find('fulfillment_lines', { fulfillment_id: f.id }, { forUpdate: true });
      if (lines.some((l) => l.order_item_id === e.newItemId)) return; // already split
      const line = lines.find((l) => l.order_item_id === e.itemId && l.state !== 'cancelled');
      if (!line) {
        this.core.ctx.log.debug({ itemId: e.itemId, newItemId: e.newItemId }, 'warehouse: split of an item with no fulfillment line, ignored');
        return;
      }
      const moved = Math.min(e.quantity, line.quantity);
      if (moved < 1) return;
      const keep = line.quantity - moved;
      // picked, then short units stay on the original line first
      const keepPicked = Math.min(line.picked, keep);
      const keepShort = Math.min(line.short, keep - keepPicked);
      const newPicked = line.picked - keepPicked;
      const newShort = Math.min(line.short - keepShort, moved - newPicked);
      const stateOf = (qty: number, picked: number, short: number) => (line.state === 'cancelled' ? 'cancelled' : qty === 0 ? 'cancelled' : short > 0 && line.state === 'short' ? 'short' : picked >= qty ? 'picked' : 'pending');
      await tx.update('fulfillment_lines', line.id, { quantity: keep, picked: keepPicked, short: keepShort, state: stateOf(keep, keepPicked, keepShort) });
      await tx.insert('fulfillment_lines', {
        id: newId(),
        fulfillment_id: f.id,
        order_item_id: e.newItemId,
        stock_item_id: line.stock_item_id,
        sku: line.sku,
        label: line.label,
        quantity: moved,
        bin_code: line.bin_code,
        picked: newPicked,
        short: newShort,
        state: stateOf(moved, newPicked, newShort),
        picked_by: newPicked > 0 ? line.picked_by : null,
        picked_at: newPicked > 0 ? line.picked_at : null,
      });
      // package items of the original item split the same way (original first)
      let left = keep;
      for (const it of await tx.find('package_items', { order_item_id: line.order_item_id })) {
        const pkg = await tx.get('packages', it.package_id);
        if (!pkg || pkg.fulfillment_id !== f.id || ['voided', 'dispatched'].includes(pkg.status)) continue;
        const stay = Math.min(it.quantity, left);
        left -= stay;
        const go = it.quantity - stay;
        if (go <= 0) continue;
        const stayScanned = Math.min(it.scanned, stay);
        const serials = it.serial_numbers ?? [];
        if (stay > 0) await tx.updateWhere('package_items', { package_id: it.package_id, order_item_id: it.order_item_id }, { quantity: stay, scanned: stayScanned, serial_numbers: serials.slice(0, stayScanned) });
        else await tx.removeWhere('package_items', { package_id: it.package_id, order_item_id: it.order_item_id });
        await tx.insert('package_items', { package_id: it.package_id, order_item_id: e.newItemId, stock_item_id: it.stock_item_id, quantity: go, scanned: it.scanned - stayScanned, serial_numbers: serials.slice(stayScanned) });
      }
      await this.core.logScan({ context: 'order_split', contextId: e.newItemId, code: e.itemId, result: `split ${moved} to a new line`, actor: { kind: 'system', id: null, name: 'Orders' } }, tx);
    });
  }

  /** shipping.dispatch.overdue: the order goes to the top of the pick list (ship-by is the passed deadline) */
  async onDispatchOverdue(e: EventPayload<'shipping.dispatch.overdue'>): Promise<void> {
    if (e.ownerType !== 'official') return;
    const f = (await this.repo.find('fulfillments', { seller_group_id: e.groupId }))[0];
    if (!f || ['dispatched', 'cancelled'].includes(f.status)) return;
    if ((await this.repo.count('scan_log', { context: 'overdue', context_id: e.exceptionId })) > 0) return;
    const due = new Date(e.dueAt);
    await this.repo.transaction(async (tx) => {
      if (!Number.isNaN(due.getTime()) && due.getTime() < f.ship_by.getTime()) await tx.update('fulfillments', f.id, { ship_by: due, updated_at: this.core.now() });
      await this.core.logScan({ context: 'overdue', contextId: e.exceptionId, code: f.order_ref, result: 'dispatch overdue', actor: { kind: 'system', id: null, name: 'Shipping' } }, tx);
    });
  }
}
