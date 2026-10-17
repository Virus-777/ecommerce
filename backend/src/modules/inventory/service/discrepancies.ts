/** Discrepancies reported by the warehouse (pick shortage, damage found) and their resolution. */
import { isAppError } from '../../../kernel/errors/index.js';
import { newId } from '../../../kernel/lib/ids.js';
import type { PageRequest } from '../../../kernel/lib/pagination.js';
import type * as common from '../../../spec/common.js';
import type { Discrepancy, MovementRef, ResolveDiscrepancyRequest } from '../../../spec/inventory.js';
import { discrepancyMachine } from '../domain/state-machines.js';
import { addDays, lineStateAfter, openQty } from '../domain/rules.js';
import { actorText } from '../mappers.js';
import type { Row } from '../ports.js';
import type { InventoryRepository } from '../repository.js';
import { StockTx } from '../stock-tx.js';
import { DEFAULT_HOLD_REVIEW_DAYS, invalid, notFound, type StaffBy, type Core } from './core.js';
import type { Adjustments } from './adjustments.js';
import type { Reservations } from './reservations.js';

export class Discrepancies {
  constructor(private readonly core: Core, private readonly adjustments: Adjustments, private readonly reservations: Reservations) {}

  /** Called from pick and pack. Damaged reserved units move to Damaged or held at once. */
  async reportDiscrepancy(input: { kind: 'pick_shortage' | 'damage_found'; stockItemId: string; locationId: string; binCode?: string; quantity: number; orderId?: string; orderRef?: string; note?: string; photoIds?: string[]; reportedBy: common.Actor }): Promise<Discrepancy> {
    if (input.kind !== 'pick_shortage' && input.kind !== 'damage_found') throw invalid('kind', 'Report a pick shortage or damage found');
    if (!Number.isInteger(input.quantity) || input.quantity <= 0) throw invalid('quantity', 'Quantity must be at least 1');
    const item = await this.core.item(input.stockItemId);
    const location = await this.core.repo.get('locations', input.locationId);
    if (!location) throw invalid('locationId', 'Unknown stock location');
    const id = newId();
    const ref: MovementRef = { kind: 'discrepancy', id, label: input.orderRef ? `Damage found, order ${input.orderRef}` : 'Damage found at packing' };
    // photos are attached (inspection_photo) so the media orphan sweep never deletes them
    const photoIds = [...new Set(input.photoIds ?? [])];
    const detach = await this.#attachPhotos(photoIds, input.reportedBy, { refId: id, refLabel: `${input.kind === 'pick_shortage' ? 'Pick shortage' : 'Damage found'} · ${item.sku}` });
    let moved: Row<'stock_movements'>[] = [];
    const changed = await this.core.stock('discrepancy', async (st) => {
      moved = st.movements;
      await st.tx.insert('discrepancies', {
        id,
        kind: input.kind,
        stock_item_id: item.id,
        location_id: location.id,
        bin_code: input.binCode ?? null,
        quantity: input.quantity,
        order_id: input.orderId ?? null,
        order_ref: input.orderRef ?? null,
        note: input.note ?? null,
        photo_media_ids: JSON.stringify(input.photoIds ?? []),
        state: 'open',
        resolution: null,
        resolution_note: null,
        reported_by: actorText(input.reportedBy),
        reported_at: st.now,
        resolved_by: null,
        resolved_at: null,
      });
      if (input.kind !== 'damage_found') return null;
      // damaged units leave the order's allocation (or Available) for Damaged or held at once
      const hold = { reasonCode: 'damage_found', reviewDate: addDays(this.core.today(), DEFAULT_HOLD_REVIEW_DAYS), reason: input.note ?? null, sourceRef: input.orderRef ?? null };
      const meta = { reason: 'damage_found', note: input.note ?? null, ref, actor: input.reportedBy, hold };
      const lines = input.orderId ? await this.#openOrderLines(st.tx, input.orderId, item.id, location.id) : [];
      let left = input.quantity;
      const touched: Row<'reservation_lines'>[] = [];
      for (const l of lines) {
        if (left <= 0) break;
        const n = Math.min(left, openQty({ quantity: l.quantity, fulfilled: l.fulfilled_qty, released: l.released_qty, state: l.state }));
        await st.move(item.id, location.id, 'reserved', 'damaged_held', n, meta);
        const released = l.released_qty + n;
        touched.push(await st.tx.update('reservation_lines', l.id, { released_qty: released, state: lineStateAfter({ quantity: l.quantity, fulfilled: l.fulfilled_qty, released, state: l.state }) }));
        left -= n;
      }
      if (left > 0) await st.move(item.id, location.id, 'available', 'damaged_held', left, meta);
      // the reservation keeps its state while the report is open: the order waits in warehouse for the resolution
      return touched;
    }).catch(async (err) => {
      await detach();
      throw err;
    });
    void changed;
    this.core.ctx.events.publish('inventory.discrepancy.reported', { discrepancyId: id, kind: input.kind, stockItemId: item.id, orderId: input.orderId ?? null, quantity: input.quantity }, { actor: input.reportedBy });
    // damaged units moved at once: the fulfillment service's ledger follows them for seller stock in our warehouse
    await this.adjustments.publishMovementsRecorded(moved, input.reportedBy, { actor: input.reportedBy });
    return (await this.core.discrepanciesApi([(await this.core.repo.get('discrepancies', id))!]))[0]!;
  }

  /**
   * Attaches discrepancy photos (media usage inspection_photo) and returns an undo; unknown files are a validation problem.
   * The photos are the reporting staff member's: warehouse passes on the photos of its damage report, which it attached
   * as that staff member's (media accepts the staff member's own files and the platform files they uploaded, which is
   * what the Admin Center sends; media spec notes, Ownership). A report without a staff member expects platform files.
   */
  async #attachPhotos(photoIds: string[], reportedBy: common.Actor, usage: { refId: string; refLabel: string }): Promise<() => Promise<void>> {
    const media = this.core.ctx.tryUse('media');
    const done: string[] = [];
    const undo = async () => {
      for (const assetId of done) await media?.detach(assetId, { module: 'inventory', kind: 'inspection_photo', refId: usage.refId }).catch(() => {});
    };
    if (!media || !photoIds.length) return undo;
    const owner = reportedBy.kind === 'staff' && reportedBy.id ? { kind: 'staff' as const, id: reportedBy.id } : { kind: 'platform' as const };
    try {
      for (const [i, assetId] of photoIds.entries()) {
        try {
          await media.attach(assetId, { module: 'inventory', kind: 'inspection_photo', refId: usage.refId, refLabel: usage.refLabel }, owner);
        } catch (err) {
          if (isAppError(err) && (err.code === 'NOT_FOUND' || err.code === 'VALIDATION_FAILED')) throw invalid(`photoIds[${i}]`, 'Photo not found or not an inspection photo; upload it again');
          throw err;
        }
        done.push(assetId);
      }
    } catch (err) {
      await undo();
      throw err;
    }
    return undo;
  }

  async #openOrderLines(tx: InventoryRepository, orderId: string, itemId: string, locationId: string): Promise<Row<'reservation_lines'>[]> {
    const rs = await tx.reservationsByOrder(orderId);
    const lines = await tx.lines(
      rs.map((r) => r.id),
      { forUpdate: true },
    );
    return lines.filter((l) => l.stock_item_id === itemId && l.location_id === locationId && (l.state === 'allocated' || l.state === 'held') && openQty({ quantity: l.quantity, fulfilled: l.fulfilled_qty, released: l.released_qty, state: l.state }) > 0);
  }

  async listDiscrepancies(query: { state?: string; kind?: string }, page: PageRequest): Promise<common.Page<Discrepancy>> {
    const p = await this.core.repo.pageDiscrepancies(query, page);
    return { ...p, items: await this.core.discrepanciesApi(p.items) };
  }

  /** A pick shortage served by another unit: the replacement joins the order's allocation, the missing unit leaves stock */
  async #reallocateShortage(st: StockTx, d: Row<'discrepancies'>, source: 'available' | 'returned', actor: common.Actor) {
    const ref: MovementRef = { kind: 'discrepancy', id: d.id, label: d.order_ref ? `Shortage, order ${d.order_ref}` : 'Pick shortage' };
    await st.move(d.stock_item_id, d.location_id, source, 'reserved', d.quantity, { reason: 'reallocated', ref, actor });
    await st.move(d.stock_item_id, d.location_id, 'reserved', 'outside', d.quantity, { reason: 'pick_shortage', ref, actor });
  }

  async resolveDiscrepancy(id: string, body: ResolveDiscrepancyRequest, by: StaffBy): Promise<Discrepancy> {
    if (!body.note?.trim()) throw invalid('note', 'Add a note on how it was resolved');
    const d = await this.core.repo.get('discrepancies', id);
    if (!d) throw notFound('Discrepancy');
    discrepancyMachine.next(d.state as 'open', 'resolve');
    const n = body.adjustQuantity ?? d.quantity;
    if (body.resolution === 'adjusted' && (!Number.isInteger(n) || n <= 0)) throw invalid('adjustQuantity', 'Quantity must be at least 1');
    const source = body.sourceGroup ?? 'available';
    const ref: MovementRef = { kind: 'discrepancy', id, label: d.order_ref ? `${d.kind === 'pick_shortage' ? 'Shortage' : 'Damage'}, order ${d.order_ref}` : d.kind === 'pick_shortage' ? 'Pick shortage' : 'Damage found' };
    const moved = await this.core.stock(
      'discrepancy',
      async (st) => {
        const locked = (await st.tx.get('discrepancies', id, { forUpdate: true }))!;
        const state = discrepancyMachine.next(locked.state as 'open', 'resolve');
        // lock order: the order's reservations, their lines, then stock levels (as every reservation path does)
        if (locked.order_id) await st.tx.reservationsByOrder(locked.order_id, { forUpdate: true });
        const orderLines = locked.order_id ? await this.#openOrderLines(st.tx, locked.order_id, locked.stock_item_id, locked.location_id) : [];
        await st.lock([locked.stock_item_id]);
        if (body.resolution === 'reallocated') {
          if (!locked.order_id) throw invalid('resolution', 'Only a report for an order can be reallocated');
          if (locked.kind === 'damage_found') {
            // the damaged units already left the allocation: replacement units join the order again
            const r = (await st.tx.reservationsByOrder(locked.order_id, { forUpdate: true })).find((x) => x.state === 'allocated' || x.state === 'held');
            if (!r) throw invalid('resolution', 'The order has no open stock allocation any more');
            const template = (await st.tx.lines([r.id])).find((l) => l.stock_item_id === locked.stock_item_id);
            await st.move(locked.stock_item_id, locked.location_id, source, 'reserved', locked.quantity, { reason: 'reallocated', note: body.note, ref, actor: by.actor });
            await st.tx.insert('reservation_lines', { id: newId(), reservation_id: r.id, stock_item_id: locked.stock_item_id, location_id: locked.location_id, order_item_id: template?.order_item_id ?? null, quantity: locked.quantity, fulfilled_qty: 0, released_qty: 0, state: r.state === 'held' ? 'held' : 'allocated' });
          } else {
            if (!orderLines.length) throw invalid('resolution', 'The order has nothing reserved for this item any more');
            await this.#reallocateShortage(st, locked, source, by.actor);
          }
        }
        if (body.resolution === 'adjusted') {
          if (locked.kind === 'damage_found') {
            await st.move(locked.stock_item_id, locked.location_id, 'damaged_held', 'outside', n, { reason: 'damage_found', note: body.note, ref, actor: by.actor });
          } else if (orderLines.length) {
            // the missing units were the order's: written off from Reserved, the order's allocation shrinks
            let left = n;
            for (const l of orderLines) {
              if (left <= 0) break;
              const take = Math.min(left, openQty({ quantity: l.quantity, fulfilled: l.fulfilled_qty, released: l.released_qty, state: l.state }));
              await st.move(locked.stock_item_id, locked.location_id, 'reserved', 'outside', take, { reason: 'pick_shortage', note: body.note, ref, actor: by.actor });
              const released = l.released_qty + take;
              await st.tx.update('reservation_lines', l.id, { released_qty: released, state: lineStateAfter({ quantity: l.quantity, fulfilled: l.fulfilled_qty, released, state: l.state }) });
              left -= take;
            }
            if (left > 0) await st.move(locked.stock_item_id, locked.location_id, 'available', 'outside', left, { reason: 'pick_shortage', note: body.note, ref, actor: by.actor });
            for (const rid of new Set(orderLines.map((l) => l.reservation_id))) await this.reservations.syncReservationState(st.tx, (await st.tx.get('reservations', rid))!, { releasedReason: 'Pick shortage written off' });
          } else {
            await st.move(locked.stock_item_id, locked.location_id, 'available', 'outside', n, { reason: locked.kind === 'count_mismatch' ? 'count_difference' : 'pick_shortage', note: body.note, ref, actor: by.actor });
          }
        }
        if (locked.kind === 'damage_found' && locked.order_id && body.resolution !== 'reallocated') {
          // no replacement: the order's allocation stays without the damaged units
          for (const r of await st.tx.reservationsByOrder(locked.order_id, { forUpdate: true })) {
            if (r.state === 'held' || r.state === 'allocated') await this.reservations.syncReservationState(st.tx, r, { releasedReason: 'Damaged at packing' });
          }
        }
        await st.tx.update('discrepancies', id, { state, resolution: body.resolution, resolution_note: body.note, resolved_by: actorText(by.actor), resolved_at: st.now });
        return st.movements;
      },
      this.core.meta(by),
    );
    this.core.ctx.events.publish('inventory.discrepancy.resolved', { discrepancyId: id, resolution: body.resolution, orderId: d.order_id }, this.core.meta(by));
    await this.adjustments.publishMovementsRecorded(moved, by.actor, by);
    const api = (await this.core.discrepanciesApi([(await this.core.repo.get('discrepancies', id))!]))[0]!;
    await this.core.audit({ action: 'inventory.discrepancy.resolve', actionLabel: 'Resolved warehouse discrepancy', category: 'inventory', target: { type: 'discrepancy', id, ref: d.order_ref, label: `${api.sku} · ${d.kind.replace('_', ' ')}`, screen: 'ops/inventory' }, after: { resolution: body.resolution, adjustQuantity: body.adjustQuantity ?? null, sourceGroup: body.sourceGroup ?? null }, reason: body.note }, by);
    return api;
  }
}
