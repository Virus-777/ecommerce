/**
 * Reservations: checkout holds with expiry, allocation on order acceptance, fulfilment on dispatch, release on
 * cancel, and the staff release.
 */
import { AppError, isAppError } from '../../../kernel/errors/index.js';
import { inventoryError } from '../errors.js';
import type { EventPayload, PublishMeta } from '../../../kernel/events/index.js';
import { isUuid, newId } from '../../../kernel/lib/ids.js';
import type { PageRequest } from '../../../kernel/lib/pagination.js';
import type * as common from '../../../spec/common.js';
import type { MovementRef, Reservation } from '../../../spec/inventory.js';
import { reservationMachine } from '../domain/state-machines.js';
import { lineStateAfter, mapLinesToItems, openQty, reservationStateOf, type ReservationState } from '../domain/rules.js';
import { SYSTEM_ACTOR, toReservationLine } from '../mappers.js';
import type { Row } from '../ports.js';
import type { InventoryRepository } from '../repository.js';
import { StockTx } from '../stock-tx.js';
import { BATCH, invalid, notFound, type By, type StaffBy, type Core } from './core.js';

/** Allocations open longer than this are raised for review */
const STALE_ALLOCATION_DAYS = 14;

/** reservations.source: checkout holds (and the order's own allocation), or allocateForOrder for a replacement or exchange (never expire; releaseHold may release them) */
type AllocationSource = Row<'reservations'>['source'];

const RESERVATION_EVENT: Record<ReservationState, 'allocate' | 'fulfill' | 'release' | 'expire' | null> = { held: null, allocated: 'allocate', fulfilled: 'fulfill', released: 'release', expired: 'expire' };

export class Reservations {
  constructor(private readonly core: Core) {}

  /** All-or-nothing checkout hold; throws INSUFFICIENT_STOCK with details per line. Same key returns the existing hold (idempotent). */
  async hold(key: string, lines: { stockItemId: string; quantity: number }[], ttlMinutes?: number): Promise<Reservation> {
    if (!key?.trim()) throw invalid('key', 'A hold needs its checkout key');
    if (!lines?.length) throw invalid('lines', 'Nothing to hold');
    const wanted = new Map<string, number>();
    for (const [i, l] of lines.entries()) {
      if (!Number.isInteger(l.quantity) || l.quantity <= 0) throw invalid(`lines[${i}].quantity`, 'Quantity must be at least 1');
      wanted.set(l.stockItemId, (wanted.get(l.stockItemId) ?? 0) + l.quantity);
    }
    const existing = await this.core.repo.reservationByKey('checkout', key);
    if (existing) return this.#existingHold(existing);
    const ttl = ttlMinutes ?? Number(await this.core.ctx.settings.get('holdMinutes'));
    if (!(ttl > 0)) throw invalid('ttlMinutes', 'The hold lifetime must be above zero');
    const id = newId();
    const created = await this.core.stock('checkout_hold', async (st) => {
      const now = st.now;
      const inserted = await st.tx.insertIfAbsent('reservations', { id, source: 'checkout', key, order_id: null, order_ref: null, state: 'held', expires_at: new Date(now.getTime() + ttl * 60_000), released_reason: null, created_at: now, updated_at: now });
      if (!inserted) return false; // the same key won a race: answer with that hold
      await st.lock([...wanted.keys()]);
      const short: { stockItemId: string; requested: number; available: number }[] = [];
      for (const [itemId, qty] of wanted) {
        const item = st.items.get(itemId);
        const available = item && !item.archived ? st.sellableAvailable(itemId) : 0;
        if (available < qty) short.push({ stockItemId: itemId, requested: qty, available });
      }
      if (short.length) throw inventoryError('INSUFFICIENT_STOCK', short.length === 1 ? 'Not enough stock for one item' : `Not enough stock for ${short.length} items`, { lines: short });
      const ref: MovementRef = { kind: 'reservation', id, label: 'Checkout hold' };
      for (const [itemId, qty] of wanted) {
        let left = qty;
        for (const level of st.sellableLevels(itemId)) {
          if (left <= 0) break;
          const take = Math.min(left, level.available);
          await st.move(itemId, level.location_id, 'available', 'reserved', take, {
            reason: 'checkout_hold',
            ref,
            actor: SYSTEM_ACTOR,
            insufficient: (have) => inventoryError('INSUFFICIENT_STOCK', 'Not enough stock for one item', { lines: [{ stockItemId: itemId, requested: qty, available: have }] }),
          });
          await st.tx.insert('reservation_lines', { id: newId(), reservation_id: id, stock_item_id: itemId, location_id: level.location_id, order_item_id: null, quantity: take, fulfilled_qty: 0, released_qty: 0, state: 'held' });
          left -= take;
        }
      }
      return true;
    });
    if (!created) return this.#existingHold((await this.core.repo.reservationByKey('checkout', key))!);
    return this.core.reservationApi(id);
  }

  async #existingHold(r: Row<'reservations'>): Promise<Reservation> {
    if (r.state === 'expired') throw inventoryError('RESERVATION_EXPIRED', 'This checkout hold expired; create a new hold', { reservationId: r.id });
    if (r.state === 'released') throw inventoryError('RESERVATION_EXPIRED', 'This checkout hold was released; create a new hold', { reservationId: r.id });
    return (await this.core.reservationsApi([r]))[0]!;
  }

  /** Keeps stock while a payment result is being checked (scenario 3) */
  async extendHold(reservationId: string, until: string): Promise<Reservation> {
    const target = new Date(until);
    if (Number.isNaN(target.getTime())) throw invalid('until', 'Not a valid time');
    const maxMinutes = Number(await this.core.ctx.settings.get('pendingPaymentHoldMinutes'));
    await this.core.repo.transaction(async (tx) => {
      const r = await tx.get('reservations', reservationId, { forUpdate: true });
      if (!r) throw notFound('Reservation');
      const now = this.core.now();
      if (r.state === 'expired' || r.state === 'released' || (r.state === 'held' && r.expires_at && r.expires_at <= now)) {
        throw inventoryError('RESERVATION_EXPIRED', 'This checkout hold expired; create a new hold', { reservationId });
      }
      if (r.state !== 'held') return; // allocated or fulfilled: nothing expires any more
      const cap = new Date(now.getTime() + maxMinutes * 60_000);
      const next = new Date(Math.min(target.getTime(), cap.getTime()));
      if (!r.expires_at || next > r.expires_at) await tx.update('reservations', r.id, { expires_at: next, updated_at: now });
    });
    return this.core.reservationApi(reservationId);
  }

  /**
   * Links a hold to the placed order and maps its free lines to order items. Acceptance no longer depends on it
   * (orders.order.accepted maps the lines itself), so a late call never remaps a line that already has an order item.
   */
  async attachOrder(reservationId: string, orderId: string, lines: { stockItemId: string; orderItemId: string }[]): Promise<Reservation> {
    await this.core.repo.transaction(async (tx) => {
      const r = await tx.get('reservations', reservationId, { forUpdate: true });
      if (!r) throw notFound('Reservation');
      if (r.state === 'expired' || r.state === 'released') throw inventoryError('RESERVATION_EXPIRED', 'This checkout hold expired; create a new hold', { reservationId });
      if (r.order_id && r.order_id !== orderId) throw new AppError('CONFLICT', 'This hold already belongs to another order', { orderId: r.order_id });
      const own = await tx.lines([r.id], { forUpdate: true });
      for (const [i, l] of (lines ?? []).entries()) {
        const matches = own.filter((x) => x.stock_item_id === l.stockItemId);
        if (!matches.length) throw invalid(`lines[${i}].stockItemId`, 'This stock item is not part of the hold');
        if (matches.some((x) => x.order_item_id === l.orderItemId)) continue;
        for (const x of matches.filter((m) => !m.order_item_id)) {
          await tx.update('reservation_lines', x.id, { order_item_id: l.orderItemId });
          x.order_item_id = l.orderItemId;
        }
      }
      if (r.order_id !== orderId) await tx.update('reservations', r.id, { order_id: orderId, updated_at: this.core.now() });
    });
    return this.core.reservationApi(reservationId);
  }

  /**
   * Abandoned checkout or failed purchase; also releases an allocation made with allocateForOrder that is no longer
   * needed (cancelled replacement or exchange). A normal order's allocation is released by cancelling its items.
   */
  async releaseHold(reservationId: string, reason: string): Promise<void> {
    const r = await this.core.repo.get('reservations', reservationId);
    if (!r) throw notFound('Reservation');
    if (r.state === 'released' || r.state === 'expired') return; // already done (idempotent)
    const source: AllocationSource = r.source;
    const releasable = (state: string) => state === 'held' || (source !== 'checkout' && state === 'allocated');
    if (!releasable(r.state)) {
      throw new AppError('ILLEGAL_TRANSITION', 'The order was accepted: its units are released by cancelling order items', { machine: 'Reservation', from: r.state, event: 'release', allowed: reservationMachine.eventsFrom(r.state as ReservationState) });
    }
    const label = source === 'checkout' ? 'Checkout hold' : `${source === 'exchange' ? 'Exchange' : 'Replacement'} allocation${r.order_ref ? `, order ${r.order_ref}` : ''}`;
    const result = await this.core.stock('hold_released', async (st) => {
      const locked = (await st.tx.get('reservations', reservationId, { forUpdate: true }))!;
      if (!releasable(locked.state)) return null;
      const lines = await st.tx.lines([locked.id], { forUpdate: true });
      return this.#releaseLines(st, locked, lines.filter((l) => l.state === 'held' || l.state === 'allocated'), {
        reason: source === 'checkout' ? 'hold_released' : 'allocation_released',
        note: reason || null,
        releasedReason: reason || (source === 'checkout' ? 'Abandoned checkout' : `${label} no longer needed`),
        ref: { kind: 'reservation', id: locked.id, label },
        actor: SYSTEM_ACTOR,
      });
    });
    if (result) await this.#publishReleased(result.reservation, result.changed, source === 'checkout' ? 'abandoned' : 'cancelled');
  }

  /**
   * All-or-nothing allocation with no expiry for a replacement or exchange shipment of an existing order
   * (Available → Reserved, state allocated). Same key returns the existing reservation. Fulfilled on
   * shipping.shipment.dispatched (replacement shipments) like any allocation; released with releaseHold.
   */
  async allocateForOrder(input: {
    key: string;
    orderId: string;
    orderRef?: string;
    source: { kind: 'replacement' | 'exchange'; id: string; ref?: string };
    lines: { stockItemId: string; quantity: number; orderItemId?: string }[];
    actor: common.Actor;
  }): Promise<Reservation> {
    if (!input?.key?.trim()) throw invalid('key', 'An allocation needs its idempotency key');
    if (!isUuid(input.orderId)) throw invalid('orderId', 'Not an order id');
    if (input.source?.kind !== 'replacement' && input.source?.kind !== 'exchange') throw invalid('source.kind', 'Allocate for a replacement or an exchange');
    if (!input.lines?.length) throw invalid('lines', 'Nothing to allocate');
    const wanted = new Map<string, number>();
    for (const [i, l] of input.lines.entries()) {
      if (!isUuid(l.stockItemId)) throw invalid(`lines[${i}].stockItemId`, 'Not a stock item id');
      if (!Number.isInteger(l.quantity) || l.quantity <= 0) throw invalid(`lines[${i}].quantity`, 'Quantity must be at least 1');
      if (l.orderItemId != null && !isUuid(l.orderItemId)) throw invalid(`lines[${i}].orderItemId`, 'Not an order item id');
      wanted.set(l.stockItemId, (wanted.get(l.stockItemId) ?? 0) + l.quantity);
    }
    const key = input.key.trim();
    const source: AllocationSource = input.source.kind;
    const existing = await this.core.repo.reservationByKey(source, key);
    if (existing) return (await this.core.reservationsApi([existing]))[0]!;
    const what = input.source.kind === 'exchange' ? 'Exchange' : 'Replacement';
    const ref: MovementRef = { kind: 'order', id: input.orderId, label: `${what}${input.source.ref ? ` ${input.source.ref}` : ''}${input.orderRef ? `, order ${input.orderRef}` : ''}` };
    const id = newId();
    const created = await this.core.stock(
      'order_allocated',
      async (st) => {
        const now = st.now;
        const inserted = await st.tx.insertIfAbsent('reservations', { id, source, key, order_id: input.orderId, order_ref: input.orderRef ?? null, state: 'allocated', expires_at: null, released_reason: null, created_at: now, updated_at: now });
        if (!inserted) return false; // the same key won a race
        await st.lock([...wanted.keys()]);
        const short: { stockItemId: string; requested: number; available: number }[] = [];
        for (const [itemId, qty] of wanted) {
          const item = st.items.get(itemId);
          const available = item && !item.archived ? st.sellableAvailable(itemId) : 0;
          if (available < qty) short.push({ stockItemId: itemId, requested: qty, available });
        }
        if (short.length) throw inventoryError('INSUFFICIENT_STOCK', short.length === 1 ? 'Not enough stock for one item' : `Not enough stock for ${short.length} items`, { lines: short });
        for (const l of input.lines) {
          let left = l.quantity;
          for (const level of st.sellableLevels(l.stockItemId)) {
            if (left <= 0) break;
            const take = Math.min(left, level.available);
            await st.move(l.stockItemId, level.location_id, 'available', 'reserved', take, { reason: 'allocated_for_order', note: input.source.ref ?? null, ref, actor: input.actor });
            await st.tx.insert('reservation_lines', { id: newId(), reservation_id: id, stock_item_id: l.stockItemId, location_id: level.location_id, order_item_id: l.orderItemId ?? null, quantity: take, fulfilled_qty: 0, released_qty: 0, state: 'allocated' });
            left -= take;
          }
        }
        return true;
      },
      { actor: input.actor },
    );
    const row = created ? (await this.core.repo.get('reservations', id))! : (await this.core.repo.reservationByKey(source, key))!;
    if (created) await this.#publishAllocated(id, input.orderId, await this.core.repo.lines([id]), input.source.kind, { actor: input.actor });
    return (await this.core.reservationsApi([row]))[0]!;
  }

  /**
   * Returns open units of these lines to Available (all, or `qty(line)` each), closes lines that
   * have nothing open and derives the reservation state from its lines.
   */
  async #releaseLines(
    st: StockTx,
    r: Row<'reservations'>,
    lines: Row<'reservation_lines'>[],
    how: { reason: string; note?: string | null; releasedReason: string; ref: MovementRef; actor: common.Actor; qty?: (l: Row<'reservation_lines'>) => number; closedAs?: 'released' | 'expired' },
  ): Promise<{ reservation: Row<'reservations'>; changed: Row<'reservation_lines'>[] }> {
    const changed: Row<'reservation_lines'>[] = [];
    await st.lock(lines.map((l) => l.stock_item_id));
    for (const l of lines) {
      const open = openQty({ quantity: l.quantity, fulfilled: l.fulfilled_qty, released: l.released_qty, state: l.state });
      const n = Math.min(open, how.qty ? how.qty(l) : open);
      if (n <= 0) continue;
      await st.move(l.stock_item_id, l.location_id, 'reserved', 'available', n, { reason: how.reason, note: how.note, ref: how.ref, actor: how.actor });
      const released = l.released_qty + n;
      const state = lineStateAfter({ quantity: l.quantity, fulfilled: l.fulfilled_qty, released, state: l.state }, how.closedAs ?? 'released');
      changed.push(await st.tx.update('reservation_lines', l.id, { released_qty: released, state }));
    }
    const reservation = await this.syncReservationState(st.tx, r, { releasedReason: how.releasedReason });
    return { reservation, changed };
  }

  /** Reservation state = furthest state of its open lines (validated against the state machine) */
  async syncReservationState(tx: InventoryRepository, r: Row<'reservations'>, extra: { releasedReason?: string } = {}): Promise<Row<'reservations'>> {
    const all = await tx.lines([r.id]);
    const next = reservationStateOf(all);
    if (next === r.state) return tx.update('reservations', r.id, { updated_at: this.core.now() });
    const event = RESERVATION_EVENT[next];
    if (!event) return r;
    reservationMachine.next(r.state as ReservationState, event, next);
    return tx.update('reservations', r.id, {
      state: next,
      updated_at: this.core.now(),
      ...(next === 'released' || next === 'expired' ? { released_reason: extra.releasedReason ?? r.released_reason } : {}),
      ...(next !== 'held' ? { expires_at: null } : {}),
    });
  }

  async #publishReleased(r: Row<'reservations'>, lines: Row<'reservation_lines'>[], reason: 'cancelled' | 'expired' | 'abandoned' | 'staff' | 'unmatched', by: By = { actor: SYSTEM_ACTOR }) {
    if (!lines.length) return;
    const items = await this.core.skus(lines.map((l) => l.stock_item_id));
    this.core.ctx.events.publish(
      'inventory.reservation.released',
      { reservationId: r.id, orderId: r.order_id, reason, lines: lines.map((l) => toReservationLine(l, items.get(l.stock_item_id)?.sku ?? '')) },
      this.core.meta(by),
    );
  }

  async listReservations(query: { orderId?: string; stockItemId?: string; state?: string }, page: PageRequest): Promise<common.Page<Reservation>> {
    const p = await this.core.repo.pageReservations(query, page);
    return { ...p, items: await this.core.reservationsApi(p.items) };
  }

  async releaseReservation(id: string, body: { reason: string; lineIds?: string[] | null }, by: StaffBy): Promise<Reservation> {
    if (!body.reason?.trim()) throw invalid('reason', 'Say why the units are released');
    const r = await this.core.repo.get('reservations', id);
    if (!r) throw notFound('Reservation');
    reservationMachine.next(r.state as ReservationState, 'release'); // ILLEGAL_TRANSITION unless held or allocated
    const result = await this.core.stock(
      'staff_release',
      async (st) => {
        const locked = (await st.tx.get('reservations', id, { forUpdate: true }))!;
        reservationMachine.next(locked.state as ReservationState, 'release');
        const lines = await st.tx.lines([id], { forUpdate: true });
        if (body.lineIds?.length) {
          const unknown = body.lineIds.filter((lid) => !lines.some((l) => l.id === lid));
          if (unknown.length) throw invalid('lineIds', 'Some lines are not part of this reservation');
        }
        const chosen = lines.filter((l) => (l.state === 'held' || l.state === 'allocated') && (!body.lineIds?.length || body.lineIds.includes(l.id)));
        if (!chosen.length) throw new AppError('ILLEGAL_TRANSITION', 'These lines have nothing reserved any more', { machine: 'Reservation', from: locked.state, event: 'release' });
        return this.#releaseLines(st, locked, chosen, { reason: 'staff_release', note: body.reason, releasedReason: body.reason, ref: { kind: 'reservation', id, label: locked.order_ref ? `Order ${locked.order_ref}` : 'Reservation' }, actor: by.actor });
      },
      this.core.meta(by),
    );
    await this.#publishReleased(result.reservation, result.changed, 'staff', by);
    const api = await this.core.reservationApi(id);
    await this.core.audit({ action: 'inventory.reservation.release', actionLabel: 'Released reserved stock', category: 'orders', target: { type: 'reservation', id, ref: r.order_ref, label: r.order_ref ? `Order ${r.order_ref}` : `Reservation ${r.key}`, screen: 'admin/order' }, reason: body.reason, before: { state: r.state }, after: { state: api.state, lines: result.changed.map((l) => l.id) } }, by);
    return api;
  }

  /**
   * orders.order.accepted: Allocate the order's held reservation (reservationId) to its order items: each
   * reservation line is matched to an entry of `items` by stock item and quantity (lines are split when one
   * spans two order items), so allocation never depends on checkout's attachOrder; lines it already attached
   * keep their order item, and an attachOrder arriving later finds nothing left to map. Without a
   * reservationId, the holds checkout attached to the order are allocated. Each allocation claims
   * `order-accepted:<orderId>:<reservationId>` in its own transaction (kernel inbox).
   */
  async onOrderAcceptedFromOrders(event: EventPayload<'orders.order.accepted'>): Promise<void> {
    let reservations: Row<'reservations'>[];
    if (event.reservationId) {
      const r = isUuid(event.reservationId) ? await this.core.repo.get('reservations', event.reservationId) : undefined;
      if (!r) {
        this.core.ctx.log.info({ orderId: event.orderId, reservationId: event.reservationId }, 'inventory: accepted order names an unknown stock hold, nothing to allocate');
        return;
      }
      if (r.order_id && r.order_id !== event.orderId) {
        this.core.ctx.log.warn({ orderId: event.orderId, reservationId: r.id, holdOrderId: r.order_id }, 'inventory: the stock hold of an accepted order belongs to another order');
        return;
      }
      reservations = [r];
    } else {
      reservations = await this.core.repo.reservationsByOrder(event.orderId);
    }
    if (!reservations.length) {
      this.core.ctx.log.info({ orderId: event.orderId }, 'inventory: accepted order has no stock hold, nothing to allocate');
      return;
    }
    for (const r of reservations) {
      if (r.state === 'held') {
        const done = await this.core.stock('order_allocated', async (st) => {
          const tx = st.tx;
          const locked = (await tx.get('reservations', r.id, { forUpdate: true }))!;
          if (locked.state !== 'held' || (locked.order_id && locked.order_id !== event.orderId)) return null;
          if (!(await tx.claimEvent(`order-accepted:${event.orderId}:${r.id}`))) return null;
          await this.#mapToOrderItems(tx, (await tx.lines([r.id], { forUpdate: true })).filter((l) => l.state === 'held'), event.items);
          // hold units no accepted item asks for (quantity reduced or line dropped at placement) go back to Available now
          let released: { reservation: Row<'reservations'>; changed: Row<'reservation_lines'>[] } | null = null;
          const excess = this.#unmatchedUnits((await tx.lines([r.id], { forUpdate: true })).filter((l) => l.state === 'held'), event.items);
          if (excess.size) {
            released = await this.#releaseLines(st, locked, (await tx.lines([r.id], { forUpdate: true })).filter((l) => excess.has(l.id)), {
              reason: 'hold_unmatched',
              releasedReason: 'Not on the accepted order',
              ref: { kind: 'order', id: event.orderId, label: `Order ${event.ref}` },
              actor: SYSTEM_ACTOR,
              qty: (l) => excess.get(l.id) ?? 0,
            });
          }
          const lines = await tx.lines([r.id], { forUpdate: true });
          const allocated: Row<'reservation_lines'>[] = [];
          for (const l of lines) if (l.state === 'held') allocated.push(await tx.update('reservation_lines', l.id, { state: 'allocated' }));
          if (allocated.length) await tx.update('reservations', r.id, { state: reservationMachine.next('held', 'allocate'), order_id: event.orderId, order_ref: event.ref, expires_at: null, updated_at: this.core.now() });
          else await tx.update('reservations', r.id, { order_id: event.orderId, order_ref: event.ref, updated_at: this.core.now() });
          return { allocated, released };
        });
        if (done?.released?.changed.length) await this.#publishReleased({ ...done.released.reservation, order_id: event.orderId }, done.released.changed, 'unmatched');
        if (done?.allocated.length) await this.#publishAllocated(r.id, event.orderId, done.allocated);
      } else if (r.state === 'expired' && !reservations.some((x) => x.state === 'allocated' || x.state === 'fulfilled')) {
        await this.#reallocateExpired(r, event);
      }
    }
  }

  /** Maps reservation lines to the accepted order's items (mapLinesToItems), splitting lines where needed. Inside the caller's transaction. */
  async #mapToOrderItems(tx: InventoryRepository, lines: Row<'reservation_lines'>[], items: EventPayload<'orders.order.accepted'>['items'] | undefined): Promise<void> {
    if (!items?.length || !lines.length) return;
    const plan = mapLinesToItems(
      lines.map((l) => ({ id: l.id, stockItemId: l.stock_item_id, quantity: l.quantity, orderItemId: l.order_item_id, splittable: l.fulfilled_qty === 0 && l.released_qty === 0 })),
      items,
    );
    for (const m of plan) {
      const l = lines.find((x) => x.id === m.lineId)!;
      await tx.update('reservation_lines', l.id, { order_item_id: m.orderItemId, quantity: m.quantity });
      for (const p of m.extra) {
        await tx.insert('reservation_lines', { id: newId(), reservation_id: l.reservation_id, stock_item_id: l.stock_item_id, location_id: l.location_id, order_item_id: p.orderItemId, quantity: p.quantity, fulfilled_qty: 0, released_qty: 0, state: l.state });
      }
    }
  }

  /**
   * Open units of held lines that no accepted item asks for, per line: lines without an order item or with one the
   * order does not list, and units beyond an item's accepted quantity. Empty when the event lists no items.
   */
  #unmatchedUnits(lines: Row<'reservation_lines'>[], items: EventPayload<'orders.order.accepted'>['items'] | undefined): Map<string, number> {
    const out = new Map<string, number>();
    if (!items?.length) return out;
    const need = new Map<string, number>();
    for (const i of items) need.set(`${i.orderItemId}:${i.stockItemId}`, (need.get(`${i.orderItemId}:${i.stockItemId}`) ?? 0) + Math.max(0, i.quantity));
    for (const l of lines) {
      const open = openQty({ quantity: l.quantity, fulfilled: l.fulfilled_qty, released: l.released_qty, state: l.state });
      if (open <= 0) continue;
      const key = `${l.order_item_id}:${l.stock_item_id}`;
      const left = l.order_item_id ? (need.get(key) ?? 0) : 0;
      const keep = Math.min(open, left);
      if (l.order_item_id) need.set(key, left - keep);
      if (open - keep > 0) out.set(l.id, open - keep);
    }
    return out;
  }

  async #publishAllocated(reservationId: string, orderId: string, lines: Row<'reservation_lines'>[], source: AllocationSource = 'checkout', meta: PublishMeta = { actor: SYSTEM_ACTOR }) {
    const items = await this.core.skus(lines.map((l) => l.stock_item_id));
    this.core.ctx.events.publish('inventory.reservation.allocated', { reservationId, orderId, lines: lines.map((l) => toReservationLine(l, items.get(l.stock_item_id)?.sku ?? '')), source }, meta);
  }

  /** The hold expired before payment was accepted: reserve the units again if they are still there */
  async #reallocateExpired(r: Row<'reservations'>, event: EventPayload<'orders.order.accepted'>) {
    const key = `order:${event.orderId}`;
    if (await this.core.repo.reservationByKey('checkout', key)) return;
    const old = await this.core.repo.lines([r.id]);
    const id = newId();
    try {
      const lines = await this.core.stock('order_allocated', async (st) => {
        if (!(await st.tx.claimEvent(`order-accepted:${event.orderId}:${r.id}`))) return null;
        await st.tx.insert('reservations', { id, source: 'checkout', key, order_id: event.orderId, order_ref: event.ref, state: 'allocated', expires_at: null, released_reason: null, created_at: st.now, updated_at: st.now });
        await st.lock(old.map((l) => l.stock_item_id));
        const out: Row<'reservation_lines'>[] = [];
        for (const l of old) {
          let left = l.quantity;
          for (const level of st.sellableLevels(l.stock_item_id)) {
            if (left <= 0) break;
            const take = Math.min(left, level.available);
            await st.move(l.stock_item_id, level.location_id, 'available', 'reserved', take, { reason: 'checkout_hold', ref: { kind: 'order', id: event.orderId, label: `Order ${event.ref}` }, actor: SYSTEM_ACTOR });
            out.push((await st.tx.insert('reservation_lines', { id: newId(), reservation_id: id, stock_item_id: l.stock_item_id, location_id: level.location_id, order_item_id: l.order_item_id, quantity: take, fulfilled_qty: 0, released_qty: 0, state: 'allocated' }))!);
            left -= take;
          }
          if (left > 0) throw inventoryError('INSUFFICIENT_STOCK', 'Not enough stock to allocate the order', { lines: [{ stockItemId: l.stock_item_id, requested: l.quantity, available: l.quantity - left }] });
        }
        await this.#mapToOrderItems(st.tx, out, event.items);
        return out.length ? st.tx.lines([id]) : out;
      });
      if (lines) await this.#publishAllocated(id, event.orderId, lines);
    } catch (err) {
      if (!isAppError(err) || err.code !== 'INSUFFICIENT_STOCK') throw err;
      this.core.ctx.log.warn({ orderId: event.orderId, details: err.details }, 'inventory: accepted order could not be allocated after its hold expired');
      await this.core.raise({ queueKey: 'inventory.reservations', kind: 'manual_task', title: `Order ${event.ref} could not be allocated`, summary: 'The checkout hold expired before payment was accepted and the units are no longer available.', subject: { type: 'order', id: event.orderId, ref: event.ref }, priority: 'high', dedupeKey: `inventory.allocation_failed:${event.orderId}` });
    }
  }

  /**
   * orders.item.split: a line was split for a partial cancel, shipment or return. The reservation line of itemId
   * gives quantity open units (same stock item, location and state) to a new line of newItemId; fulfilled and
   * released counts stay on the original. A line split off whole simply changes its order item. Units that already
   * left stock are not moved. Idempotent per newItemId (inbox), so later cancel, dispatch and release events can name
   * either item.
   */
  async onItemSplitFromOrders(event: EventPayload<'orders.item.split'>): Promise<void> {
    if (!isUuid(event.itemId) || !isUuid(event.newItemId) || !(event.quantity > 0)) return;
    const candidates = (await this.core.repo.linesWhere({ orderItemIds: [event.itemId] })).filter((l) => l.state === 'held' || l.state === 'allocated');
    const reservationIds = [...new Set(candidates.map((l) => l.reservation_id))];
    const moved = await this.core.repo.transaction(async (tx) => {
      if (!(await tx.claimEvent(`item-split:${event.newItemId}`))) return null;
      // lock order: reservations, then their lines (as every reservation path does; a cancellation of the same item runs at the same time)
      for (const rid of [...reservationIds].sort()) await tx.get('reservations', rid, { forUpdate: true });
      const lines = (await tx.lines(reservationIds, { forUpdate: true }))
        .filter((l) => l.order_item_id === event.itemId && (l.state === 'held' || l.state === 'allocated'))
        .filter((l) => !event.stockItemId || !isUuid(event.stockItemId) || l.stock_item_id === event.stockItemId || candidates.every((c) => c.stock_item_id !== event.stockItemId));
      let left = event.quantity;
      let n = 0;
      for (const l of lines) {
        if (left <= 0) break;
        const open = openQty({ quantity: l.quantity, fulfilled: l.fulfilled_qty, released: l.released_qty, state: l.state });
        const take = Math.min(left, open);
        if (take <= 0) continue;
        left -= take;
        n += take;
        if (take === l.quantity) {
          await tx.update('reservation_lines', l.id, { order_item_id: event.newItemId });
          continue;
        }
        const quantity = l.quantity - take;
        await tx.update('reservation_lines', l.id, { quantity, state: lineStateAfter({ quantity, fulfilled: l.fulfilled_qty, released: l.released_qty, state: l.state }) });
        await tx.insert('reservation_lines', { id: newId(), reservation_id: l.reservation_id, stock_item_id: l.stock_item_id, location_id: l.location_id, order_item_id: event.newItemId, quantity: take, fulfilled_qty: 0, released_qty: 0, state: l.state });
      }
      for (const rid of new Set(lines.map((l) => l.reservation_id))) await this.syncReservationState(tx, (await tx.get('reservations', rid))!);
      return n;
    });
    if (moved === 0) this.core.ctx.log.info({ orderId: event.orderId, itemId: event.itemId, newItemId: event.newItemId, reason: event.reason }, 'inventory: split order item has no open reserved units to move');
  }

  /** orders.item.cancelled: Release that item's held or allocated units back to Available (matched by itemId, so a split-off item releases only its own units) */
  async onItemCancelledFromOrders(event: EventPayload<'orders.item.cancelled'>): Promise<void> {
    const note = `Cancellation ${event.cancellationId}`;
    const lines = (await this.core.repo.linesWhere({ orderItemIds: [event.itemId] })).filter((l) => l.state === 'held' || l.state === 'allocated');
    if (!lines.length) return;
    const byReservation = new Map<string, Row<'reservation_lines'>[]>();
    for (const l of lines) byReservation.set(l.reservation_id, [...(byReservation.get(l.reservation_id) ?? []), l]);
    for (const [rid] of byReservation) {
      const result = await this.core.stock('order_cancelled', async (st) => {
        // one claim per cancellation, item and reservation (kernel inbox), committed with the release
        if (!(await st.tx.claimEvent(`item-cancelled:${event.cancellationId}:${event.itemId}:${rid}`))) return null;
        const r = (await st.tx.get('reservations', rid, { forUpdate: true }))!;
        if (r.state !== 'held' && r.state !== 'allocated') return null;
        const own = (await st.tx.lines([rid], { forUpdate: true })).filter((l) => l.order_item_id === event.itemId && (l.state === 'held' || l.state === 'allocated'));
        let left = event.quantity;
        return this.#releaseLines(st, r, own, {
          reason: 'order_cancelled',
          note,
          releasedReason: `Cancelled: ${event.reasonCode}`,
          ref: { kind: 'order', id: event.orderId, label: `Order ${event.ref}` },
          actor: SYSTEM_ACTOR,
          qty: (l) => {
            const n = Math.min(left, openQty({ quantity: l.quantity, fulfilled: l.fulfilled_qty, released: l.released_qty, state: l.state }));
            left -= n;
            return n;
          },
        });
      });
      if (result) await this.#publishReleased(result.reservation, result.changed, 'cancelled');
    }
  }

  /** shipping.shipment.dispatched: Fulfil the allocated lines in the shipment (Reserved → leaves stock) */
  async onShipmentDispatchedFromShipping(event: EventPayload<'shipping.shipment.dispatched'>): Promise<void> {
    if (event.kind === 'return') return;
    const note = `Shipment ${event.shipmentId}`;
    const claim = `shipment-dispatched:${event.shipmentId}`;
    if (await this.core.repo.seenEvent(claim)) return;
    const wanted = new Map<string, number>();
    for (const l of event.lines) wanted.set(l.orderItemId, (wanted.get(l.orderItemId) ?? 0) + l.quantity);
    // replacement shipments use the order's allocateForOrder reservations; normal shipments never touch them
    const replacement = event.kind === 'replacement';
    const allocations = replacement ? await this.core.repo.allocationsForShipments(event.orderId) : [];
    const allocationIds = new Set(allocations.map((r) => r.id));
    const byItem = (await this.core.repo.linesWhere({ orderItemIds: [...wanted.keys()] })).filter((l) => l.state === 'allocated' || l.state === 'held');
    const sources = new Map((await this.#reservationKeys([...new Set(byItem.map((l) => l.reservation_id))])).map((r) => [r.id, r.source]));
    const lines = byItem.filter((l) => (replacement ? allocationIds.has(l.reservation_id) : (sources.get(l.reservation_id) ?? 'checkout') === 'checkout'));
    // allocations made without order items are matched in order for what is left
    const free = replacement ? (await this.core.repo.lines([...allocationIds])).filter((l) => !l.order_item_id && (l.state === 'allocated' || l.state === 'held')) : [];
    if (!lines.length && !free.length) return;
    await this.core.stock('dispatched', async (st) => {
      if (!(await st.tx.claimEvent(claim))) return;
      // lock order: reservations, their lines, then stock levels (as every reservation path does)
      const reservationIds = [...new Set([...lines, ...free].map((x) => x.reservation_id))].sort();
      for (const rid of reservationIds) await st.tx.get('reservations', rid, { forUpdate: true });
      const locked = await st.tx.lines(reservationIds, { forUpdate: true });
      await st.lock([...lines, ...free].map((l) => l.stock_item_id));
      const touched = new Set<string>();
      const own = locked.filter((x) => lines.some((l) => l.id === x.id));
      const spare = locked.filter((x) => free.some((l) => l.id === x.id));
      const plan: { l: Row<'reservation_lines'>; itemId: string | null }[] = [...own.map((l) => ({ l, itemId: l.order_item_id })), ...spare.map((l) => ({ l, itemId: null }))];
      for (const p of plan) {
        const l = p.l;
        const itemId = p.itemId ?? [...wanted].find(([, n]) => n > 0)?.[0];
        if (!itemId) continue;
        const open = openQty({ quantity: l.quantity, fulfilled: l.fulfilled_qty, released: l.released_qty, state: l.state });
        const n = Math.min(open, wanted.get(itemId) ?? 0);
        if (n <= 0) continue;
        wanted.set(itemId, wanted.get(itemId)! - n);
        const r = await st.tx.get('reservations', l.reservation_id);
        await st.move(l.stock_item_id, l.location_id, 'reserved', 'outside', n, { reason: 'dispatched', note, ref: { kind: 'order', id: event.orderId, label: `Order ${r?.order_ref ?? ''}`.trim() }, actor: SYSTEM_ACTOR });
        const fulfilled = l.fulfilled_qty + n;
        // a hold dispatched before acceptance was recorded is treated as allocated
        await st.tx.update('reservation_lines', l.id, { fulfilled_qty: fulfilled, state: lineStateAfter({ quantity: l.quantity, fulfilled, released: l.released_qty, state: 'allocated' }) });
        touched.add(l.reservation_id);
      }
      for (const rid of touched) {
        const r = (await st.tx.get('reservations', rid, { forUpdate: true }))!;
        if (r.state === 'held') await st.tx.update('reservations', rid, { state: reservationMachine.next('held', 'allocate'), expires_at: null });
        await this.syncReservationState(st.tx, (await st.tx.get('reservations', rid))!);
      }
    });
  }

  async #reservationKeys(ids: string[]): Promise<Row<'reservations'>[]> {
    return (await Promise.all(ids.map((id) => this.core.repo.get('reservations', id)))).filter((r): r is Row<'reservations'> => Boolean(r));
  }

  /** Job inventory.expire-holds (every 1 min): Expire held reservations past expiresAt (Reserved → Available); publish inventory.reservation.released with reason expired */
  async expireHolds(): Promise<void> {
    for (;;) {
      const due = await this.core.repo.dueHolds(this.core.now(), BATCH);
      for (const r of due) {
        const result = await this.core.stock('hold_expired', async (st) => {
          const locked = (await st.tx.get('reservations', r.id, { forUpdate: true }))!;
          if (locked.state !== 'held' || !locked.expires_at || locked.expires_at > st.now) return null;
          const lines = (await st.tx.lines([r.id], { forUpdate: true })).filter((l) => l.state === 'held');
          const out = await this.#releaseLines(st, locked, lines, { reason: 'hold_expired', releasedReason: 'Checkout hold expired', ref: { kind: 'reservation', id: r.id, label: 'Checkout hold' }, actor: SYSTEM_ACTOR, closedAs: 'expired' });
          return out;
        });
        if (result) await this.#publishReleased(result.reservation, result.changed, 'expired');
      }
      if (due.length < BATCH) return;
    }
  }

  /** Job inventory.reconcile-reservations (every 15 min): Find allocations whose order items are cancelled, completed or delivered without a matching event and raise them for review (no automatic release of allocated units) */
  async reconcileReservations(): Promise<number> {
    const stale = await this.core.repo.staleAllocations(new Date(this.core.now().getTime() - STALE_ALLOCATION_DAYS * 86_400_000), 500);
    for (const r of stale) {
      await this.core.raise({
        queueKey: 'inventory.reservations',
        kind: 'manual_task',
        title: `Stock still reserved for order ${r.order_ref ?? r.key}`,
        summary: `Allocated for more than ${STALE_ALLOCATION_DAYS} days without dispatch or cancellation. Check the order and release the units if it is closed.`,
        subject: { type: 'order', id: r.order_id ?? r.id, ref: r.order_ref ?? null },
        priority: 'normal',
        dedupeKey: `inventory.stale_allocation:${r.id}`,
      });
    }
    if (stale.length) this.core.ctx.log.info({ count: stale.length }, 'inventory: allocations raised for review');
    return stale.length;
  }
}
