import { AppError, isAppError, isNotImplemented } from '../../kernel/errors/index.js';
import { inventoryError } from './errors.js';
import type { EventEnvelope, EventPayload, PublishMeta } from '../../kernel/events/index.js';
import { dateInZone } from '../../kernel/lib/clock.js';
import { isUuid, newId } from '../../kernel/lib/ids.js';
import { money } from '../../kernel/lib/money.js';
import type { PageRequest } from '../../kernel/lib/pagination.js';
import type { ModuleContext } from '../../kernel/module-system/index.js';
import type * as audit from '../../spec/audit.js';
import type * as common from '../../spec/common.js';
import type * as identity from '../../spec/identity.js';
import type {
  Adjustment,
  AdjustmentRequest,
  AdjustmentResult,
  ConfirmInboundRequest,
  CountLine,
  Discrepancy,
  IncomingCue,
  InboundReceipt,
  InventoryPublicApi,
  Location,
  LocationInput,
  LowStockRow,
  Movement,
  MovementRef,
  RecordReturnOutcomeRequest,
  Reservation,
  ResolveDiscrepancyRequest,
  ReturnOutcome,
  SellerAdjustmentItem,
  SellerAdjustmentRequest,
  SellerStockRow,
  SellerStockSummary,
  StockCount,
  StockItem,
  StockItemDetail,
  StockItemInput,
  StockItemRef,
  StockQuantities,
  StockSummary,
  Transfer,
  TransferLine,
} from '../../spec/inventory.js';
import type * as reports from '../../spec/reports.js';
import {
  adjustmentMachine,
  discrepancyMachine,
  inboundConfirmationMachine,
  reservationMachine,
  returnStockOutcomeMachine,
  stockCountMachine,
  transferMachine,
} from './domain/state-machines.js';
import {
  addDays,
  applyMove,
  availabilityLabel,
  GROUP_INFO,
  GROUPS,
  FIELD,
  lineStateAfter,
  onHand,
  openQty,
  reasonLabel,
  reservationStateOf,
  splitLabel,
  stockState,
  weightedAverage,
  type Group,
  type GroupOrOutside,
  type ReservationState,
} from './domain/rules.js';
import {
  actorOf,
  actorText,
  effectiveThreshold,
  incomingCue,
  iso,
  photoIdsOf,
  sellableAvailable,
  SYSTEM_ACTOR,
  toCount,
  toDiscrepancy,
  toInbound,
  toInboundLine,
  toLocation,
  toMovement,
  toReservation,
  toReservationLine,
  toReturnOutcome,
  toStockItem,
  toTransfer,
  unitCostOf,
} from './mappers.js';
import type { InventoryRepository, ItemListFilter, Row } from './ports.js';
import { levelQty, StockTx, type StockEvents } from './stock-tx.js';

export interface InventoryServiceDeps {
  repo: InventoryRepository;
  ctx: ModuleContext<'inventory'>;
}

/** Who acts: for events, audit and the ledger */
export interface By {
  actor: common.Actor;
  requestId?: string;
}
export interface StaffBy extends By {
  principal: identity.Principal;
}
export interface SellerBy extends By {
  principal: identity.Principal;
  sellerId: string;
}

const APPROVAL_ACTION = 'inventory.adjustments.apply';
const SELLER_DATASET = 'inventory.seller.stock';
const ADMIN_DATASET = 'inventory.admin.stock';
const EXPORT_PAGE = 500;
const BATCH = 200;
/** Allocations open longer than this are raised for review */
const STALE_ALLOCATION_DAYS = 14;
/** Review date of units moved into Damaged or held without one (damage at packing, damaged on receipt) */
const DEFAULT_HOLD_REVIEW_DAYS = 14;

const invalid = (path: string, message: string) => new AppError('VALIDATION_FAILED', message, { issues: [{ path, message }] });
const notFound = (what = 'Stock item') => new AppError('NOT_FOUND', `${what} not found`);
const RESERVATION_EVENT: Record<ReservationState, 'allocate' | 'fulfill' | 'release' | 'expire' | null> = { held: null, allocated: 'allocate', fulfilled: 'fulfill', released: 'release', expired: 'expire' };
const RETURN_OUTCOMES = ['restock', 'different_condition', 'damaged_stock', 'repair', 'return_to_supplier', 'write_off'] as const;
type ReturnOutcomeKind = (typeof RETURN_OUTCOMES)[number];

/**
 * Inventory use cases. Depends only on ports, the event bus, the clock and other modules' public APIs.
 * Each method maps to a publicApi function, an endpoint, a consumed event or a job in docs/api/spec/modules/inventory.json.
 */
export class InventoryService implements InventoryPublicApi {
  #datasetsRegistered?: Promise<void>;

  constructor(protected readonly deps: InventoryServiceDeps) {}

  private get ctx() {
    return this.deps.ctx;
  }
  private get repo() {
    return this.deps.repo;
  }
  private now() {
    return this.ctx.clock.now();
  }
  private today() {
    return dateInZone(this.now(), this.ctx.config.market.timeZone);
  }
  private get currency() {
    return this.ctx.config.market.currency;
  }

  async #defaultThreshold(): Promise<number> {
    return Number(await this.ctx.settings.get('defaultLowStockThreshold'));
  }

  /* ================================================================ plumbing */

  /** Runs stock work in one transaction and publishes stock.changed / stock.low once it has committed. */
  async #stock<T>(cause: string, fn: (st: StockTx) => Promise<T>, meta: PublishMeta = {}): Promise<T> {
    const [defaultSellerThreshold, cooldownHours] = await Promise.all([this.#defaultThreshold(), this.ctx.settings.get('lowStockAlertCooldownHours')]);
    let events: StockEvents = { changed: [], low: [] };
    const result = await this.repo.transaction(async (tx) => {
      const st = new StockTx(tx, this.now());
      const r = await fn(st);
      events = await st.finish(cause, { defaultSellerThreshold, cooldownHours: Number(cooldownHours) });
      return r;
    });
    for (const e of events.changed) this.ctx.events.publish('inventory.stock.changed', e, meta);
    for (const e of events.low) this.ctx.events.publish('inventory.stock.low', e, meta);
    return result;
  }

  async #audit(entry: Omit<audit.RecordInput, 'actor' | 'module' | 'requestId'>, by: By) {
    await this.ctx.tryUse('audit')?.record({ ...entry, actor: by.actor, module: this.ctx.name, requestId: by.requestId ?? null });
  }

  #meta(by: By): PublishMeta {
    return { actor: by.actor, ...(by.requestId ? { requestId: by.requestId } : {}) };
  }

  /* ---------------------------------------------------------------- loading API objects */

  async #itemsApi(rows: Row<'stock_items'>[], opts: { locationId?: string } = {}): Promise<StockItem[]> {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const [levels, expectations, def] = await Promise.all([this.repo.levels(ids), this.repo.expectations({ itemIds: ids, openOnly: true }), this.#defaultThreshold()]);
    const locations = new Map((await this.repo.locations({ ids: [...new Set(levels.map((l) => l.location_id))] })).map((l) => [l.id, l]));
    return rows.map((item) =>
      toStockItem(item, {
        levels: levels.filter((l) => l.stock_item_id === item.id),
        locations,
        expectations: expectations.filter((e) => e.stock_item_id === item.id),
        defaultSellerThreshold: def,
        locationId: opts.locationId,
      }),
    );
  }

  async #itemApi(row: Row<'stock_items'>): Promise<StockItem> {
    return (await this.#itemsApi([row]))[0]!;
  }

  async #skus(itemIds: string[]): Promise<Map<string, Row<'stock_items'>>> {
    const ids = [...new Set(itemIds)];
    if (!ids.length) return new Map();
    return new Map((await this.repo.items({ ids, includeArchived: true })).map((i) => [i.id, i]));
  }

  async #movementsApi(rows: Row<'stock_movements'>[]): Promise<Movement[]> {
    const items = await this.#skus(rows.map((m) => m.stock_item_id));
    return rows.map((m) => toMovement(m, items.get(m.stock_item_id)?.sku ?? ''));
  }

  /** Reservations with their lines; `onlyItem` keeps the lines of one stock item (a seller never sees other sellers' lines) */
  async #reservationsApi(rows: Row<'reservations'>[], onlyItem?: string): Promise<Reservation[]> {
    const lines = (await this.repo.lines(rows.map((r) => r.id))).filter((l) => !onlyItem || l.stock_item_id === onlyItem);
    const items = await this.#skus(lines.map((l) => l.stock_item_id));
    return rows.map((r) =>
      toReservation(
        r,
        lines.filter((l) => l.reservation_id === r.id).map((l) => toReservationLine(l, items.get(l.stock_item_id)?.sku ?? '')),
      ),
    );
  }

  async #reservationApi(id: string): Promise<Reservation> {
    const r = await this.repo.get('reservations', id);
    if (!r) throw notFound('Reservation');
    return (await this.#reservationsApi([r]))[0]!;
  }

  async #adjustmentsApi(rows: Row<'adjustments'>[]): Promise<Adjustment[]> {
    if (!rows.length) return [];
    const items = await this.#skus(rows.map((a) => a.stock_item_id));
    const levels = await this.repo.levels([...new Set(rows.map((a) => a.stock_item_id))]);
    const access = this.ctx.tryUse('access');
    return Promise.all(
      rows.map(async (a) => {
        const item = items.get(a.stock_item_id);
        const movement = a.movement_id ? await this.repo.get('stock_movements', a.movement_id) : undefined;
        const from = a.from_group as GroupOrOutside;
        const to = a.to_group as GroupOrOutside;
        let before: StockQuantities;
        let after: StockQuantities;
        if (movement) {
          after = (typeof movement.after === 'string' ? JSON.parse(movement.after) : movement.after) as unknown as StockQuantities;
          before = applyMove(after, to, from, a.quantity);
        } else {
          before = levelQty(levels.find((l) => l.stock_item_id === a.stock_item_id && l.location_id === a.location_id));
          after = applyMove(before, from, to, a.quantity);
        }
        let approval: common.ApprovalInfo | null = null;
        if (a.approval_request_id) {
          approval = { required: true, reason: null, approvalRequestId: a.approval_request_id, approvers: [] };
          if (access) {
            try {
              approval = await access.approvalInfo(a.approval_request_id);
            } catch (err) {
              this.ctx.log.warn({ err }, 'inventory: approval details unavailable');
            }
          }
        }
        return {
          id: a.id,
          stockItemId: a.stock_item_id,
          sku: item?.sku ?? '',
          label: item?.label ?? '',
          locationId: a.location_id,
          fromGroup: a.from_group,
          toGroup: a.to_group,
          quantity: a.quantity,
          reasonCode: a.reason_code,
          reasonLabel: reasonLabel(a.reason_code),
          note: a.note,
          reviewDate: a.review_date,
          before,
          after,
          affectedReservedUnits: before.reserved,
          state: a.state as Adjustment['state'],
          approval,
          requestedBy: actorOf(a.requested_by) ?? SYSTEM_ACTOR,
          decidedBy: actorOf(a.decided_by),
          createdAt: iso(a.created_at),
          appliedAt: a.applied_at ? iso(a.applied_at) : null,
        };
      }),
    );
  }

  async #discrepanciesApi(rows: Row<'discrepancies'>[]): Promise<Discrepancy[]> {
    const items = await this.#skus(rows.map((d) => d.stock_item_id));
    const media = this.ctx.tryUse('media');
    const allPhotos = [...new Set(rows.flatMap(photoIdsOf))];
    let refs: common.MediaRef[] = [];
    if (media && allPhotos.length) {
      try {
        refs = await media.refs(allPhotos, 'small');
      } catch (err) {
        this.ctx.log.warn({ err }, 'inventory: discrepancy photos unavailable');
      }
    }
    const byId = new Map(refs.map((r) => [r.id, r]));
    return rows.map((d) => toDiscrepancy(d, items.get(d.stock_item_id), photoIdsOf(d).flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []))));
  }

  async #inboundsApi(rows: Row<'inbound_receipts'>[]): Promise<InboundReceipt[]> {
    const lines = await this.repo.inboundLines(rows.map((r) => r.id));
    const itemIds = [...new Set(lines.map((l) => l.stock_item_id))];
    const items = await this.#skus(itemIds);
    const levels = await this.repo.levels(itemIds);
    const locations = new Map((await this.repo.locations({ ids: [...new Set(levels.map((l) => l.location_id))] })).map((l) => [l.id, l]));
    const waiting = await this.repo.discrepanciesWhere({ itemIds, states: ['open'], kinds: ['pick_shortage'] });
    return rows.map((r) => {
      const own = lines.filter((l) => l.inbound_id === r.id);
      const ownItems = new Set(own.map((l) => l.stock_item_id));
      const orders = new Set(waiting.filter((d) => ownItems.has(d.stock_item_id) && d.order_id).map((d) => d.order_id));
      return toInbound(
        r,
        own.map((l) => toInboundLine(l, items.get(l.stock_item_id), sellableAvailable(levels.filter((x) => x.stock_item_id === l.stock_item_id), locations) === 0, this.currency)),
        orders.size,
      );
    });
  }

  async #returnOutcomesApi(rows: Row<'return_outcomes'>[]): Promise<ReturnOutcome[]> {
    const movements = await this.repo.movementsByRef('return', [...new Set(rows.map((r) => r.return_id))]);
    const items = await this.#skus([...rows.map((r) => r.stock_item_id), ...movements.map((m) => m.stock_item_id)]);
    return rows.map((r) => {
      const own = movements.filter((m) => m.ref_id === r.return_id && (m.stock_item_id === r.stock_item_id || m.stock_item_id === r.target_stock_item_id));
      return toReturnOutcome(r, items.get(r.stock_item_id), own.map((m) => toMovement(m, items.get(m.stock_item_id)?.sku ?? '')));
    });
  }

  async #transferApi(t: Row<'transfers'>): Promise<Transfer> {
    const lines = await this.repo.transferLines(t.id);
    const items = await this.#skus(lines.map((l) => l.stock_item_id));
    return toTransfer(t, lines, new Map([...items].map(([id, i]) => [id, i.sku])));
  }

  async #countApi(c: Row<'stock_counts'>): Promise<StockCount> {
    const lines = await this.repo.countLines(c.id);
    const items = await this.#skus(lines.map((l) => l.stock_item_id));
    return toCount(c, lines, new Map([...items].map(([id, i]) => [id, i.sku])));
  }

  /* ---------------------------------------------------------------- locations */

  async #officialDefault(tx: InventoryRepository = this.repo): Promise<Row<'locations'> | undefined> {
    const all = (await tx.locations({ ownerType: 'official' })).filter((l) => l.active && l.kind === 'warehouse');
    return all.find((l) => l.is_default) ?? all[0];
  }

  /** The seller's virtual location (one per seller), created on first use */
  async #sellerLocation(tx: InventoryRepository, sellerId: string): Promise<Row<'locations'>> {
    const existing = (await tx.locations({ ownerType: 'seller', sellerId }))[0];
    if (existing) return existing;
    const row = await tx.insert(
      'locations',
      { id: newId(), code: `SV-${sellerId}`, name: 'Seller stock', kind: 'seller_virtual', owner_type: 'seller', seller_id: sellerId, address: null, time_zone: this.ctx.config.market.timeZone, sellable: true, active: true, is_default: true },
      { ignoreConflict: true },
    );
    return row ?? (await tx.locationByCode(`SV-${sellerId}`))!;
  }

  /* ---------------------------------------------------------------- record lookups */

  async #ownItem(sellerId: string, id: string): Promise<Row<'stock_items'>> {
    const item = await this.repo.get('stock_items', id);
    if (!item || item.owner_type !== 'seller' || item.seller_id !== sellerId) throw notFound();
    return item;
  }

  async #item(id: string): Promise<Row<'stock_items'>> {
    const item = await this.repo.get('stock_items', id);
    if (!item) throw notFound();
    return item;
  }

  async #officialItem(id: string): Promise<Row<'stock_items'>> {
    const item = await this.#item(id);
    if (item.owner_type !== 'official') throw new AppError('VALIDATION_FAILED', 'Seller stock is managed by the seller; staff can only view it', { issues: [{ path: 'stockItemId', message: 'not a company stock item' }] });
    return item;
  }

  /* ================================================================ public API (in-process) */

  /** Called when an offer is created. Seller items get the seller's virtual location. */
  async createStockItem(input: { ownerType: 'official' | 'seller'; sellerId?: string; offerId?: string; sku: string; productId: string; variantId: string; condition: string; label: string; initialAvailable: number; lowStockThreshold?: number; locationId?: string }): Promise<StockItem> {
    if (input.ownerType === 'seller' && !input.sellerId) throw invalid('sellerId', 'Seller stock items need the seller');
    if (input.ownerType === 'official' && input.sellerId) throw invalid('sellerId', 'Company stock items have no seller');
    if (!input.sku?.trim()) throw invalid('sku', 'Enter the SKU');
    if (!Number.isInteger(input.initialAvailable) || input.initialAvailable < 0) throw invalid('initialAvailable', 'Opening stock must be a whole number, 0 or more');
    if (input.lowStockThreshold !== undefined && (!Number.isInteger(input.lowStockThreshold) || input.lowStockThreshold < 0)) throw invalid('lowStockThreshold', 'The low-stock alert must be 0 or more');
    const sku = input.sku.trim();
    const sellerId = input.ownerType === 'seller' ? input.sellerId! : null;

    // the same offer (or SKU and offer) again: the item that already exists (offers may retry)
    const same = await this.repo.items({ ownerType: input.ownerType, ...(sellerId ? { sellerId } : {}), skus: [sku], includeArchived: true });
    if (same[0]) {
      if (input.offerId && same[0].offer_id === input.offerId) return this.#itemApi(same[0]);
      // a company SKU created by staff gets the offer that starts selling it
      if (input.ownerType === 'official' && input.offerId && !same[0].offer_id) return this.#itemApi(await this.repo.update('stock_items', same[0].id, { offer_id: input.offerId, updated_at: this.now() }));
      throw inventoryError('SKU_TAKEN', `A stock item with SKU ${sku} already exists`, { sku, stockItemId: same[0].id });
    }
    if (input.offerId && input.ownerType === 'seller') {
      const forOffer = (await this.repo.items({ offerIds: [input.offerId], includeArchived: true }))[0];
      if (forOffer) return this.#itemApi(forOffer);
    }

    const id = newId();
    const row = await this.#stock('initial', async (st) => {
      const location = input.ownerType === 'seller' ? await this.#sellerLocation(st.tx, sellerId!) : input.locationId ? await st.tx.get('locations', input.locationId) : await this.#officialDefault(st.tx);
      if (!location || location.owner_type !== input.ownerType || (sellerId && location.seller_id !== sellerId) || !location.active) {
        throw invalid('locationId', input.ownerType === 'official' ? 'Add an active company stock location first' : 'Unknown stock location');
      }
      const now = st.now;
      const item = await st.tx.insert(
        'stock_items',
        {
          id,
          owner_type: input.ownerType,
          seller_id: sellerId,
          sku,
          offer_id: input.offerId ?? null,
          product_id: input.productId,
          variant_id: input.variantId,
          condition: input.condition,
          label: input.label?.trim() || sku,
          low_stock_threshold: input.lowStockThreshold ?? null,
          reorder_quantity: null,
          unit_cost_amount: null,
          currency: this.currency,
          primary_bin_code: null,
          low_since: null,
          archived: false,
          created_at: now,
          updated_at: now,
        },
        { ignoreConflict: true },
      );
      if (!item) throw inventoryError('SKU_TAKEN', `A stock item with SKU ${sku} already exists`, { sku });
      await st.tx.ensureLevel(id, location.id, now);
      if (input.initialAvailable > 0) {
        await st.move(id, location.id, 'outside', 'available', input.initialAvailable, { reason: 'initial', ref: { kind: 'initial', id, label: 'Opening stock' }, actor: SYSTEM_ACTOR });
      }
      return item;
    });
    return this.#itemApi((await this.repo.get('stock_items', row.id))!);
  }

  /** Sellable quantity summed over sellable locations */
  async getAvailability(stockItemIds: string[]): Promise<Record<string, { available: number; state: string; lowStockThreshold: number | null; nextIncoming: IncomingCue | null }>> {
    const rows = await this.repo.items({ ids: [...new Set(stockItemIds)], includeArchived: true });
    const api = await this.#itemsApi(rows);
    const levels = await this.repo.levels(rows.map((r) => r.id));
    const locations = new Map((await this.repo.locations({ ids: [...new Set(levels.map((l) => l.location_id))] })).map((l) => [l.id, l]));
    const out: Record<string, { available: number; state: string; lowStockThreshold: number | null; nextIncoming: IncomingCue | null }> = {};
    rows.forEach((row, i) => {
      const available = row.archived ? 0 : sellableAvailable(levels.filter((l) => l.stock_item_id === row.id), locations);
      out[row.id] = { available, state: api[i]!.state, lowStockThreshold: api[i]!.lowStockThreshold ?? null, nextIncoming: api[i]!.nextIncoming ?? null };
    });
    return out;
  }

  /** All-or-nothing checkout hold; throws INSUFFICIENT_STOCK with details per line. Same key returns the existing hold (idempotent). */
  async hold(key: string, lines: { stockItemId: string; quantity: number }[], ttlMinutes?: number): Promise<Reservation> {
    if (!key?.trim()) throw invalid('key', 'A hold needs its checkout key');
    if (!lines?.length) throw invalid('lines', 'Nothing to hold');
    const wanted = new Map<string, number>();
    for (const [i, l] of lines.entries()) {
      if (!Number.isInteger(l.quantity) || l.quantity <= 0) throw invalid(`lines[${i}].quantity`, 'Quantity must be at least 1');
      wanted.set(l.stockItemId, (wanted.get(l.stockItemId) ?? 0) + l.quantity);
    }
    const existing = await this.repo.reservationByKey(key);
    if (existing) return this.#existingHold(existing);
    const ttl = ttlMinutes ?? Number(await this.ctx.settings.get('holdMinutes'));
    if (!(ttl > 0)) throw invalid('ttlMinutes', 'The hold lifetime must be above zero');
    const id = newId();
    const created = await this.#stock('checkout_hold', async (st) => {
      const now = st.now;
      const inserted = await st.tx.insert('reservations', { id, key, order_id: null, order_ref: null, state: 'held', expires_at: new Date(now.getTime() + ttl * 60_000), released_reason: null, created_at: now, updated_at: now }, { ignoreConflict: true });
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
    if (!created) return this.#existingHold((await this.repo.reservationByKey(key))!);
    return this.#reservationApi(id);
  }

  async #existingHold(r: Row<'reservations'>): Promise<Reservation> {
    if (r.state === 'expired') throw inventoryError('RESERVATION_EXPIRED', 'This checkout hold expired; create a new hold', { reservationId: r.id });
    if (r.state === 'released') throw inventoryError('RESERVATION_EXPIRED', 'This checkout hold was released; create a new hold', { reservationId: r.id });
    return (await this.#reservationsApi([r]))[0]!;
  }

  /** Keeps stock while a payment result is being checked (scenario 3) */
  async extendHold(reservationId: string, until: string): Promise<Reservation> {
    const target = new Date(until);
    if (Number.isNaN(target.getTime())) throw invalid('until', 'Not a valid time');
    const maxMinutes = Number(await this.ctx.settings.get('pendingPaymentHoldMinutes'));
    await this.repo.transaction(async (tx) => {
      const r = await tx.get('reservations', reservationId, { forUpdate: true });
      if (!r) throw notFound('Reservation');
      const now = this.now();
      if (r.state === 'expired' || r.state === 'released' || (r.state === 'held' && r.expires_at && r.expires_at <= now)) {
        throw inventoryError('RESERVATION_EXPIRED', 'This checkout hold expired; create a new hold', { reservationId });
      }
      if (r.state !== 'held') return; // allocated or fulfilled: nothing expires any more
      const cap = new Date(now.getTime() + maxMinutes * 60_000);
      const next = new Date(Math.min(target.getTime(), cap.getTime()));
      if (!r.expires_at || next > r.expires_at) await tx.update('reservations', r.id, { expires_at: next, updated_at: now });
    });
    return this.#reservationApi(reservationId);
  }

  /** Links a hold to the placed order so acceptance can allocate it */
  async attachOrder(reservationId: string, orderId: string, lines: { stockItemId: string; orderItemId: string }[]): Promise<Reservation> {
    await this.repo.transaction(async (tx) => {
      const r = await tx.get('reservations', reservationId, { forUpdate: true });
      if (!r) throw notFound('Reservation');
      if (r.state === 'expired' || r.state === 'released') throw inventoryError('RESERVATION_EXPIRED', 'This checkout hold expired; create a new hold', { reservationId });
      if (r.order_id && r.order_id !== orderId) throw new AppError('CONFLICT', 'This hold already belongs to another order', { orderId: r.order_id });
      const own = await tx.lines([r.id], { forUpdate: true });
      for (const [i, l] of (lines ?? []).entries()) {
        const matches = own.filter((x) => x.stock_item_id === l.stockItemId);
        if (!matches.length) throw invalid(`lines[${i}].stockItemId`, 'This stock item is not part of the hold');
        if (matches.some((x) => x.order_item_id === l.orderItemId)) continue;
        const free = matches.filter((x) => !x.order_item_id);
        for (const x of free.length ? free : matches) {
          await tx.update('reservation_lines', x.id, { order_item_id: l.orderItemId });
          x.order_item_id = l.orderItemId;
        }
      }
      if (r.order_id !== orderId) await tx.update('reservations', r.id, { order_id: orderId, updated_at: this.now() });
    });
    return this.#reservationApi(reservationId);
  }

  /** Abandoned checkout or failed purchase */
  async releaseHold(reservationId: string, reason: string): Promise<void> {
    const r = await this.repo.get('reservations', reservationId);
    if (!r) throw notFound('Reservation');
    if (r.state === 'released' || r.state === 'expired') return; // already done (idempotent)
    if (r.state !== 'held') {
      throw new AppError('ILLEGAL_TRANSITION', 'The order was accepted: its units are released by cancelling order items', { machine: 'Reservation', from: r.state, event: 'release', allowed: reservationMachine.eventsFrom(r.state as ReservationState) });
    }
    const result = await this.#stock('hold_released', async (st) => {
      const locked = (await st.tx.get('reservations', reservationId, { forUpdate: true }))!;
      if (locked.state !== 'held') return null;
      const lines = await st.tx.lines([locked.id], { forUpdate: true });
      return this.#releaseLines(st, locked, lines.filter((l) => l.state === 'held'), {
        reason: 'hold_released',
        note: reason || null,
        releasedReason: reason || 'Abandoned checkout',
        ref: { kind: 'reservation', id: locked.id, label: 'Checkout hold' },
        actor: SYSTEM_ACTOR,
      });
    });
    if (result) this.#publishReleased(result.reservation, result.changed, 'abandoned');
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
    const reservation = await this.#syncReservationState(st.tx, r, { releasedReason: how.releasedReason });
    return { reservation, changed };
  }

  /** Reservation state = furthest state of its open lines (validated against the state machine) */
  async #syncReservationState(tx: InventoryRepository, r: Row<'reservations'>, extra: { releasedReason?: string } = {}): Promise<Row<'reservations'>> {
    const all = await tx.lines([r.id]);
    const next = reservationStateOf(all);
    if (next === r.state) return tx.update('reservations', r.id, { updated_at: this.now() });
    const event = RESERVATION_EVENT[next];
    if (!event) return r;
    reservationMachine.next(r.state as ReservationState, event, next);
    return tx.update('reservations', r.id, {
      state: next,
      updated_at: this.now(),
      ...(next === 'released' || next === 'expired' ? { released_reason: extra.releasedReason ?? r.released_reason } : {}),
      ...(next !== 'held' ? { expires_at: null } : {}),
    });
  }

  async #publishReleased(r: Row<'reservations'>, lines: Row<'reservation_lines'>[], reason: 'cancelled' | 'expired' | 'abandoned' | 'staff', by: By = { actor: SYSTEM_ACTOR }) {
    if (!lines.length) return;
    const items = await this.#skus(lines.map((l) => l.stock_item_id));
    this.ctx.events.publish(
      'inventory.reservation.released',
      { reservationId: r.id, orderId: r.order_id, reason, lines: lines.map((l) => toReservationLine(l, items.get(l.stock_item_id)?.sku ?? '')) },
      this.#meta(by),
    );
  }

  /** Seller bulk file quantities, recorded as 'Bulk update' movements */
  async applyBulkQuantities(sellerId: string, rows: { stockItemId: string; newAvailable: number }[], jobId: string, actor: common.Actor): Promise<{ stockItemId: string; ok: boolean; error?: string }[]> {
    const out: { stockItemId: string; ok: boolean; error?: string }[] = [];
    for (const row of rows ?? []) {
      try {
        await this.#setSellerAvailable(sellerId, row.stockItemId, row.newAvailable, {
          reason: 'bulk_update',
          note: null,
          ref: { kind: 'bulk_update', id: jobId, label: 'Bulk update' },
          by: { actor },
          allowNoChange: true,
        });
        out.push({ stockItemId: row.stockItemId, ok: true });
      } catch (err) {
        if (!isAppError(err) || err.status >= 500) throw err;
        out.push({ stockItemId: row.stockItemId, ok: false, error: err.message });
      }
    }
    return out;
  }

  /** Weighted average buying cost of company stock */
  async getUnitCost(stockItemId: string): Promise<common.Money | null> {
    const item = await this.repo.get('stock_items', stockItemId);
    return item ? unitCostOf(item) : null;
  }

  /** Adds Incoming when a purchase order is sent; repeated calls replace the open quantities for that PO */
  async expectIncoming(purchaseOrderId: string, purchaseOrderRef: string, locationId: string, lines: { stockItemId: string; quantity: number; expectedDate: string }[]): Promise<void> {
    for (const [i, l] of lines.entries()) if (!Number.isInteger(l.quantity) || l.quantity < 0) throw invalid(`lines[${i}].quantity`, 'Quantity must be 0 or more');
    const location = await this.repo.get('locations', locationId);
    if (!location || location.owner_type !== 'official') throw invalid('locationId', 'Unknown company stock location');
    const items = await this.repo.items({ ids: lines.map((l) => l.stockItemId), includeArchived: true });
    for (const [i, l] of lines.entries()) if (!items.find((it) => it.id === l.stockItemId && it.owner_type === 'official')) throw invalid(`lines[${i}].stockItemId`, 'Unknown company stock item');
    const ref: MovementRef = { kind: 'purchase_order', id: purchaseOrderId, label: `Purchase order ${purchaseOrderRef}` };
    await this.#stock('incoming', async (st) => {
      const existing = await st.tx.expectations({ sourceKind: 'purchase_order', sourceId: purchaseOrderId }, { forUpdate: true });
      await st.lock([...lines.map((l) => l.stockItemId), ...existing.map((e) => e.stock_item_id)]);
      const wanted = new Map<string, { quantity: number; expectedDate: string }>();
      for (const l of lines) wanted.set(l.stockItemId, { quantity: (wanted.get(l.stockItemId)?.quantity ?? 0) + l.quantity, expectedDate: l.expectedDate });
      // lines no longer on the order, or moved to another location: their open units leave Incoming
      for (const e of existing) {
        const w = wanted.get(e.stock_item_id);
        if (w && e.location_id === locationId) continue;
        const n = Math.min(e.quantity_open, st.qty(e.stock_item_id, e.location_id).incoming);
        if (n > 0) await st.move(e.stock_item_id, e.location_id, 'incoming', 'outside', n, { reason: 'purchase_order_changed', ref, actor: SYSTEM_ACTOR });
        await st.tx.update('incoming_expectations', e.id, { quantity_open: 0 });
        e.quantity_open = 0;
      }
      for (const [itemId, w] of wanted) {
        const e = existing.find((x) => x.stock_item_id === itemId && x.location_id === locationId);
        const before = e?.quantity_open ?? 0;
        const delta = w.quantity - before;
        if (delta > 0) await st.move(itemId, locationId, 'outside', 'incoming', delta, { reason: e ? 'purchase_order_changed' : 'purchase_order_sent', ref, actor: SYSTEM_ACTOR });
        if (delta < 0) {
          const n = Math.min(-delta, st.qty(itemId, locationId).incoming);
          if (n > 0) await st.move(itemId, locationId, 'incoming', 'outside', n, { reason: 'purchase_order_changed', ref, actor: SYSTEM_ACTOR });
        }
        if (e) await st.tx.update('incoming_expectations', e.id, { quantity_open: w.quantity, expected_date: w.expectedDate, source_ref: purchaseOrderRef });
        else
          await st.tx.insert('incoming_expectations', { id: newId(), stock_item_id: itemId, location_id: locationId, source_kind: 'purchase_order', source_id: purchaseOrderId, source_ref: purchaseOrderRef, quantity_open: w.quantity, expected_date: w.expectedDate });
      }
    });
  }

  /** Cancelled or short-closed purchase orders */
  async cancelIncoming(purchaseOrderId: string, lines?: { stockItemId: string; quantity: number }[]): Promise<void> {
    await this.#stock('incoming', async (st) => {
      const existing = await st.tx.expectations({ sourceKind: 'purchase_order', sourceId: purchaseOrderId, openOnly: true }, { forUpdate: true });
      await st.lock(existing.map((e) => e.stock_item_id));
      for (const e of existing) {
        const asked = lines ? lines.filter((l) => l.stockItemId === e.stock_item_id).reduce((n, l) => n + Math.max(0, l.quantity), 0) : e.quantity_open;
        const cancel = Math.min(asked, e.quantity_open);
        if (cancel <= 0) continue;
        const n = Math.min(cancel, st.qty(e.stock_item_id, e.location_id).incoming);
        if (n > 0) await st.move(e.stock_item_id, e.location_id, 'incoming', 'outside', n, { reason: 'purchase_order_cancelled', ref: { kind: 'purchase_order', id: purchaseOrderId, label: `Purchase order ${e.source_ref}` }, actor: SYSTEM_ACTOR });
        await st.tx.update('incoming_expectations', e.id, { quantity_open: e.quantity_open - cancel });
      }
    });
  }

  /** Counted receipt waiting for the Inventory Manager to confirm what can be sold */
  async submitInbound(receipt: { receiptId: string; receiptRef: string; purchaseOrderId: string; purchaseOrderRef: string; supplierName: string; locationId: string; receivedBy: common.Actor; receivedAt: string; lines: { stockItemId: string; expected: number; received: number; damaged: number; binCode?: string; unitCost: common.Money }[] }): Promise<InboundReceipt> {
    const existing = await this.repo.inboundByReceipt(receipt.receiptId);
    if (existing) return (await this.#inboundsApi([existing]))[0]!;
    if (!receipt.lines?.length) throw invalid('lines', 'A receipt needs at least one line');
    const location = await this.repo.get('locations', receipt.locationId);
    if (!location || location.owner_type !== 'official') throw invalid('locationId', 'Unknown company stock location');
    const items = await this.repo.items({ ids: receipt.lines.map((l) => l.stockItemId), includeArchived: true });
    const seen = new Set<string>();
    for (const [i, l] of receipt.lines.entries()) {
      if (!items.find((it) => it.id === l.stockItemId && it.owner_type === 'official')) throw invalid(`lines[${i}].stockItemId`, 'Unknown company stock item');
      if (seen.has(l.stockItemId)) throw invalid(`lines[${i}].stockItemId`, 'Each stock item appears once per receipt');
      seen.add(l.stockItemId);
      if (![l.expected, l.received, l.damaged].every((n) => Number.isInteger(n) && n >= 0)) throw invalid(`lines[${i}]`, 'Quantities must be whole numbers, 0 or more');
      if (l.damaged > l.received) throw invalid(`lines[${i}].damaged`, 'Damaged units cannot exceed received units');
      if (!Number.isInteger(l.unitCost?.amount) || l.unitCost.amount < 0) throw invalid(`lines[${i}].unitCost`, 'Unit cost must be 0 or more');
    }
    const id = newId();
    const ref: MovementRef = { kind: 'receipt', id: receipt.receiptId, label: `Received ${receipt.purchaseOrderRef}` };
    const inserted = await this.#stock('incoming', async (st) => {
      const row = await st.tx.insert(
        'inbound_receipts',
        {
          id,
          receipt_id: receipt.receiptId,
          receipt_ref: receipt.receiptRef,
          purchase_order_id: receipt.purchaseOrderId,
          purchase_order_ref: receipt.purchaseOrderRef,
          supplier_name: receipt.supplierName,
          location_id: receipt.locationId,
          received_by: actorText(receipt.receivedBy),
          received_at: new Date(receipt.receivedAt),
          state: 'awaiting_confirmation',
          confirmed_by: null,
          confirmed_at: null,
          note: null,
        },
        { ignoreConflict: true },
      );
      if (!row) return false;
      await st.tx.insertInboundLines(
        receipt.lines.map((l) => ({ inbound_id: id, stock_item_id: l.stockItemId, expected: l.expected, received: l.received, damaged: l.damaged, bin_code: l.binCode ?? null, unit_cost_amount: l.unitCost.amount, sellable: null, reason: null })),
      );
      const expectations = await st.tx.expectations({ sourceKind: 'purchase_order', sourceId: receipt.purchaseOrderId }, { forUpdate: true });
      await st.lock(receipt.lines.map((l) => l.stockItemId));
      for (const l of receipt.lines) {
        // received units stay in Incoming until confirmed: they come off the open purchase order quantity
        const e = expectations.find((x) => x.stock_item_id === l.stockItemId && x.location_id === receipt.locationId);
        const fromOrder = Math.min(l.received, e?.quantity_open ?? 0, st.qty(l.stockItemId, receipt.locationId).incoming);
        if (e && fromOrder > 0) await st.tx.update('incoming_expectations', e.id, { quantity_open: e.quantity_open - fromOrder });
        const extra = l.received - fromOrder;
        if (extra > 0) await st.move(l.stockItemId, receipt.locationId, 'outside', 'incoming', extra, { reason: 'received_over_expected', ref, actor: receipt.receivedBy });
      }
      return true;
    });
    const row = inserted ? await this.repo.get('inbound_receipts', id) : await this.repo.inboundByReceipt(receipt.receiptId);
    return (await this.#inboundsApi([row!]))[0]!;
  }

  /** Called from pick and pack. Damaged reserved units move to Damaged or held at once. */
  async reportDiscrepancy(input: { kind: 'pick_shortage' | 'damage_found'; stockItemId: string; locationId: string; binCode?: string; quantity: number; orderId?: string; orderRef?: string; note?: string; photoIds?: string[]; reportedBy: common.Actor }): Promise<Discrepancy> {
    if (input.kind !== 'pick_shortage' && input.kind !== 'damage_found') throw invalid('kind', 'Report a pick shortage or damage found');
    if (!Number.isInteger(input.quantity) || input.quantity <= 0) throw invalid('quantity', 'Quantity must be at least 1');
    const item = await this.#item(input.stockItemId);
    const location = await this.repo.get('locations', input.locationId);
    if (!location) throw invalid('locationId', 'Unknown stock location');
    const id = newId();
    const ref: MovementRef = { kind: 'discrepancy', id, label: input.orderRef ? `Damage found, order ${input.orderRef}` : 'Damage found at packing' };
    const changed = await this.#stock('discrepancy', async (st) => {
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
      const hold = { reasonCode: 'damage_found', reviewDate: addDays(this.today(), DEFAULT_HOLD_REVIEW_DAYS), reason: input.note ?? null, sourceRef: input.orderRef ?? null };
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
    });
    void changed;
    this.ctx.events.publish('inventory.discrepancy.reported', { discrepancyId: id, kind: input.kind, stockItemId: item.id, orderId: input.orderId ?? null, quantity: input.quantity }, { actor: input.reportedBy });
    return (await this.#discrepanciesApi([(await this.repo.get('discrepancies', id))!]))[0]!;
  }

  async #openOrderLines(tx: InventoryRepository, orderId: string, itemId: string, locationId: string): Promise<Row<'reservation_lines'>[]> {
    const rs = await tx.reservationsByOrder(orderId);
    const lines = await tx.lines(
      rs.map((r) => r.id),
      { forUpdate: true },
    );
    return lines.filter((l) => l.stock_item_id === itemId && l.location_id === locationId && (l.state === 'allocated' || l.state === 'held') && openQty({ quantity: l.quantity, fulfilled: l.fulfilled_qty, released: l.released_qty, state: l.state }) > 0);
  }

  /** Resolve SKUs from scans and files */
  async findBySku(ownerType: 'official' | 'seller', skus: string[], sellerId?: string): Promise<StockItem[]> {
    if (!skus?.length) return [];
    return this.#itemsApi(await this.repo.items({ ownerType, skus: [...new Set(skus.map((s) => s.trim()))], ...(sellerId ? { sellerId } : {}) }));
  }

  /**
   * Stock items by id with SKU, label, owner and main location (unknown ids are left out, input order kept).
   * Main location: the seller's virtual location; for company stock the location holding most of the item's
   * units (sellable first), or the default company location when it has none.
   */
  async getStockItems(stockItemIds: string[]): Promise<StockItemRef[]> {
    const ids = [...new Set((stockItemIds ?? []).filter((id) => isUuid(id)))];
    if (!ids.length) return [];
    const rows = await this.repo.items({ ids, includeArchived: true });
    if (!rows.length) return [];
    const levels = await this.repo.levels(rows.map((r) => r.id));
    const sellerIds = [...new Set(rows.map((r) => (r.owner_type === 'seller' ? r.seller_id : null)).filter((x): x is string => Boolean(x)))];
    const locations = new Map((await this.repo.locations({ ids: [...new Set(levels.map((l) => l.location_id))] })).map((l) => [l.id, l]));
    const sellerLocation = new Map<string, Row<'locations'>>();
    for (const sellerId of sellerIds) {
      const own = (await this.repo.locations({ ownerType: 'seller', sellerId }))[0];
      if (own) sellerLocation.set(sellerId, own);
    }
    const fallback = rows.some((r) => r.owner_type === 'official') ? await this.#officialDefault() : undefined;
    const units = (l: Row<'stock_levels'>) => l.available + l.reserved + l.incoming + l.damaged_held + l.returned;
    const mainOf = (r: Row<'stock_items'>): Row<'locations'> | undefined => {
      if (r.owner_type === 'seller') {
        const held = levels.filter((l) => l.stock_item_id === r.id).map((l) => locations.get(l.location_id)).find((l) => l?.kind === 'seller_virtual');
        return (r.seller_id ? sellerLocation.get(r.seller_id) : undefined) ?? held;
      }
      const best = levels
        .filter((l) => l.stock_item_id === r.id && units(l) > 0 && locations.get(l.location_id)?.owner_type === 'official')
        .sort((a, b) => Number(locations.get(b.location_id)!.sellable) - Number(locations.get(a.location_id)!.sellable) || units(b) - units(a) || (a.location_id < b.location_id ? -1 : 1))[0];
      return best ? locations.get(best.location_id) : fallback;
    };
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ids
      .filter((id) => byId.has(id))
      .map((id) => {
        const r = byId.get(id)!;
        const loc = mainOf(r);
        return {
          id: r.id,
          sku: r.sku,
          label: r.label,
          ownerType: r.owner_type,
          sellerId: r.seller_id,
          offerId: r.offer_id,
          productId: r.product_id,
          variantId: r.variant_id,
          condition: r.condition,
          locationId: loc?.id ?? null,
          locationCode: loc?.code ?? null,
          binCode: r.primary_bin_code,
        };
      });
  }

  /** Customer view of offer stock: state, low-stock count, quantity selector limit and restock estimate */
  async getOfferAvailability(offers: { offerId: string; stockItemId: string; purchaseLimit?: number }[]): Promise<Record<string, { state: string; quantity: number | null; maxPerOrder: number; purchaseLimit: number | null; label: string; expectedRestockDate: string | null }>> {
    const avail = await this.getAvailability(offers.map((o) => o.stockItemId).filter(Boolean));
    const out: Record<string, { state: string; quantity: number | null; maxPerOrder: number; purchaseLimit: number | null; label: string; expectedRestockDate: string | null }> = {};
    for (const o of offers) {
      const a = avail[o.stockItemId];
      const available = a?.available ?? 0;
      const state = (a ? a.state : 'out_of_stock') as 'in_stock' | 'low_stock' | 'out_of_stock';
      const limit = o.purchaseLimit ?? null;
      out[o.offerId] = {
        state,
        quantity: state === 'low_stock' ? available : null,
        maxPerOrder: Math.max(0, limit !== null ? Math.min(available, limit) : available),
        purchaseLimit: limit,
        label: availabilityLabel(state, available, limit),
        expectedRestockDate: state === 'out_of_stock' ? (a?.nextIncoming?.expectedDate ?? null) : null,
      };
    }
    return out;
  }

  /** Stock item per offer; with sellerId only that seller's items resolve */
  async getStockForOffers(offerIds: string[], viewer: { sellerId?: string }): Promise<Record<string, StockItem | null>> {
    const rows = (await this.repo.items({ offerIds: [...new Set(offerIds)], includeArchived: true })).filter((r) => !viewer.sellerId || (r.owner_type === 'seller' && r.seller_id === viewer.sellerId));
    // a live item wins over an archived one for the same offer
    rows.sort((a, b) => Number(a.archived) - Number(b.archived));
    const api = await this.#itemsApi(rows);
    const out: Record<string, StockItem | null> = Object.fromEntries(offerIds.map((id) => [id, null]));
    rows.forEach((r, i) => {
      if (r.offer_id && !out[r.offer_id]) out[r.offer_id] = api[i]!;
    });
    return out;
  }

  /** Stock items per variant: the seller's own items, or (staff) company and seller items, never summed */
  async listStockForVariants(variantIds: string[], viewer: { sellerId?: string }): Promise<Record<string, StockItem[]>> {
    const rows = await this.repo.items({ variantIds: [...new Set(variantIds)], ...(viewer.sellerId ? { ownerType: 'seller' as const, sellerId: viewer.sellerId } : {}) });
    const api = await this.#itemsApi(rows);
    const out: Record<string, StockItem[]> = Object.fromEntries(variantIds.map((id) => [id, []]));
    api.forEach((s) => out[s.variantId]?.push(s));
    return out;
  }

  /** In stock, low, out of stock and reserved totals for the seller dashboard */
  async getSellerStockSummary(sellerId: string): Promise<SellerStockSummary> {
    const items = await this.#itemsApi(await this.repo.items({ ownerType: 'seller', sellerId }));
    const out = items.filter((i) => i.state === 'out_of_stock');
    return {
      inStockSkus: items.filter((i) => i.state === 'in_stock').length,
      inStockUnits: items.reduce((n, i) => n + i.quantities.available, 0),
      lowStockSkus: items.filter((i) => i.state === 'low_stock').length,
      outOfStockSkus: out.length,
      reservedUnits: items.reduce((n, i) => n + i.quantities.reserved, 0),
      outOfStockLabels: out.slice(0, 5).map((i) => i.label),
    };
  }

  /** Official Store units and value at cost per stock group with low and out-of-stock counts */
  async getStockSummary(locationId?: string): Promise<StockSummary> {
    let rows = await this.repo.items({ ownerType: 'official' });
    if (locationId) {
      const here = new Set((await this.repo.levelTotals({ ownerType: 'official', locationId })).map((l) => l.stock_item_id));
      rows = rows.filter((r) => here.has(r.id));
    }
    const scoped = await this.#itemsApi(rows, { locationId });
    const groups = GROUPS.map((g) => {
      const units = scoped.reduce((n, i) => n + i.quantities[FIELD[g]], 0);
      const value = scoped.reduce((n, i) => n + (i.unitCost ? i.unitCost.amount * i.quantities[FIELD[g]] : 0), 0);
      return { group: g, label: GROUP_INFO[g].label, meaning: GROUP_INFO[g].meaning, units, valueAtCost: money(value, this.currency) };
    });
    const low = scoped.filter((i) => i.state === 'low_stock').length;
    const outOfStock = scoped.filter((i) => i.state === 'out_of_stock').length;
    const atOrBelow = low + outOfStock;
    return {
      ownerType: 'official',
      locationId: locationId ?? null,
      skuCount: scoped.length,
      groups,
      lowStockCount: low,
      outOfStockCount: outOfStock,
      lowStockHeadline: atOrBelow ? `${atOrBelow} SKU${atOrBelow === 1 ? '' : 's'} at or below reorder point` : null,
    };
  }

  /** Export rows for reports datasets inventory.admin.stock and inventory.seller.stock (seller rows scoped to the principal's seller) */
  async exportRows(dataset: string, filters: unknown, principal: identity.Principal, cursor?: string): Promise<{ rows: unknown[]; nextCursor?: string }> {
    const f = (filters && typeof filters === 'object' ? filters : {}) as Record<string, unknown>;
    const offset = cursor ? Number(cursor) : 0;
    if (!Number.isInteger(offset) || offset < 0) throw invalid('cursor', 'Not a cursor from this export');
    const ids = Array.isArray(f.stockItemIds) ? (f.stockItemIds as string[]) : undefined;
    if (dataset === SELLER_DATASET) {
      if (principal.kind !== 'seller' || !principal.sellerId) throw new AppError('FORBIDDEN', 'Seller stock exports are for the seller only');
      const filter = await this.#sellerListFilter(principal.sellerId, { q: f.q as string | undefined, state: f.state as ItemListFilter['state'], categoryId: f.categoryId as string | undefined });
      const pageIds = await this.repo.itemIds({ ...filter, ...(ids ? { ids } : {}) }, EXPORT_PAGE + 1, offset);
      const items = await this.#itemsApi(await this.#rowsInOrder(pageIds.slice(0, EXPORT_PAGE)));
      return {
        rows: items.map((i) => {
          const { productTitle, variantLabel } = splitLabel(i.label);
          return { product: productTitle, variant: variantLabel, sellerSku: i.sku, condition: i.condition, available: i.quantities.available, reserved: i.quantities.reserved, incoming: i.quantities.incoming, lowStockThreshold: i.lowStockThreshold ?? null, state: i.state, updatedAt: i.updatedAt };
        }),
        ...(pageIds.length > EXPORT_PAGE ? { nextCursor: String(offset + EXPORT_PAGE) } : {}),
      };
    }
    if (dataset === ADMIN_DATASET) {
      if (principal.kind !== 'staff') throw new AppError('FORBIDDEN', 'Company stock exports are for staff');
      const filter = this.#adminListFilter({ q: f.q as string, ownerType: f.ownerType as 'official' | 'seller', sellerId: f.sellerId as string, filter: f.filter as string, locationId: f.locationId as string, zone: f.zone as string }, await this.#defaultThreshold());
      const pageIds = await this.repo.itemIds({ ...filter, ...(ids ? { ids } : {}) }, EXPORT_PAGE + 1, offset);
      const items = await this.#itemsApi(await this.#rowsInOrder(pageIds.slice(0, EXPORT_PAGE)), { locationId: filter.locationId });
      return {
        rows: items.map((i) => ({
          sku: i.sku,
          label: i.label,
          ownerType: i.ownerType,
          sellerId: i.sellerId ?? null,
          condition: i.condition,
          available: i.quantities.available,
          reserved: i.quantities.reserved,
          incoming: i.quantities.incoming,
          damagedHeld: i.quantities.damagedHeld,
          returned: i.quantities.returned,
          state: i.state,
          binCode: i.binCode ?? null,
          reorderPoint: i.lowStockThreshold ?? null,
          reorderQuantity: i.reorderQuantity ?? null,
          unitCost: i.unitCost?.amount ?? null,
          valueAtCost: i.valueAtCost?.amount ?? null,
          updatedAt: i.updatedAt,
        })),
        ...(pageIds.length > EXPORT_PAGE ? { nextCursor: String(offset + EXPORT_PAGE) } : {}),
      };
    }
    throw invalid('dataset', `Inventory has no dataset ${dataset}`);
  }

  async #rowsInOrder(ids: string[]): Promise<Row<'stock_items'>[]> {
    const rows = new Map((await this.repo.items({ ids, includeArchived: true })).map((r) => [r.id, r]));
    return ids.flatMap((id) => (rows.has(id) ? [rows.get(id)!] : []));
  }

  /** Registers the export datasets with reports (once; reports may not be built yet) */
  async registerDatasets(): Promise<void> {
    const api = this.ctx.tryUse('reports');
    if (!api) return;
    this.#datasetsRegistered ??= (async () => {
      const col = (pairs: [string, string][]) => pairs.map(([key, label]) => ({ key, label }));
      await api.registerDataset({
        key: SELLER_DATASET,
        owner: 'inventory',
        title: 'Stock',
        permission: 'inventory.stock.export',
        audience: 'seller',
        screens: ['seller/inventory'],
        available: true,
        phase: 1,
        columns: col([['product', 'Product'], ['variant', 'Variant'], ['sellerSku', 'Seller SKU'], ['condition', 'Condition'], ['available', 'Available'], ['reserved', 'Reserved'], ['incoming', 'Incoming'], ['lowStockThreshold', 'Low-stock threshold'], ['state', 'State'], ['updatedAt', 'Updated at']]),
      });
      await api.registerDataset({
        key: ADMIN_DATASET,
        owner: 'inventory',
        title: 'Stock by SKU',
        permission: 'inventory.stock.view',
        audience: 'staff',
        screens: ['ops/inventory', 'admin/official'],
        available: true,
        phase: 1,
        columns: [
          ...col([['sku', 'SKU'], ['label', 'Product'], ['ownerType', 'Owner'], ['sellerId', 'Seller id'], ['condition', 'Condition'], ['available', 'Available'], ['reserved', 'Reserved'], ['incoming', 'Incoming'], ['damagedHeld', 'Damaged or held'], ['returned', 'Returned'], ['state', 'State'], ['binCode', 'Bin'], ['reorderPoint', 'Reorder point'], ['reorderQuantity', 'Reorder quantity']]),
          { key: 'unitCost', label: 'Unit cost', permission: 'inventory.stock.view' },
          { key: 'valueAtCost', label: 'Value at cost', permission: 'inventory.stock.view' },
          { key: 'updatedAt', label: 'Updated at' },
        ],
      });
    })().catch((err) => {
      this.#datasetsRegistered = undefined;
      if (!isNotImplemented(err)) throw err; // reports not built yet: requestExport answers for it
    });
    return this.#datasetsRegistered;
  }

  /* ================================================================ seller area */

  async #sellerListFilter(sellerId: string, q: { q?: string; state?: ItemListFilter['state']; categoryId?: string }): Promise<ItemListFilter> {
    const filter: ItemListFilter = { ownerType: 'seller', sellerId, defaultSellerThreshold: await this.#defaultThreshold(), ...(q.q ? { q: q.q } : {}), ...(q.state ? { state: q.state } : {}) };
    if (q.categoryId) filter.productIds = await this.#productsInCategory((await this.repo.items({ ownerType: 'seller', sellerId })).map((i) => i.product_id), q.categoryId);
    return filter;
  }

  /** Products of a category, through the catalog (without catalog the filter cannot apply and is ignored) */
  async #productsInCategory(productIds: string[], categoryId: string): Promise<string[] | undefined> {
    const catalog = this.ctx.tryUse('catalog');
    if (!catalog) return undefined;
    const out: string[] = [];
    for (const id of [...new Set(productIds)]) {
      const p = await catalog.getProduct(id);
      if (p?.categoryId === categoryId) out.push(id);
    }
    return out;
  }

  /** GraphQL StockItem.lastChange */
  lastChangesFor(itemIds: string[]): Promise<Map<string, string>> {
    return this.#lastChanges(itemIds);
  }

  /** GraphQL StockItem.recentMovements */
  async recentMovementsFor(itemIds: string[], limit: number): Promise<Map<string, Movement[]>> {
    const rows = await this.#movementsApi(await this.repo.recentMovements(itemIds, limit));
    const out = new Map<string, Movement[]>(itemIds.map((id) => [id, []]));
    for (const m of rows) out.get(m.stockItemId)?.push(m);
    return out;
  }

  async #lastChanges(itemIds: string[]): Promise<Map<string, string>> {
    const rows = await this.repo.recentMovements(itemIds, 1);
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: this.ctx.config.market.timeZone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    return new Map(rows.map((m) => [m.stock_item_id, `${fmt.format(m.at).replace(/,(?=[^,]*$)/, ',')} · ${m.actor_name ?? (m.actor_kind === 'system' ? 'System' : m.actor_kind === 'seller' ? 'Seller' : 'Staff')}`]));
  }

  async listOwnStock(sellerId: string, query: { q?: string; state?: 'in_stock' | 'low_stock' | 'out_of_stock'; categoryId?: string }, page: PageRequest): Promise<common.Page<SellerStockRow>> {
    const p = await this.repo.pageItemIds(await this.#sellerListFilter(sellerId, query), page);
    const items = await this.#itemsApi(await this.#rowsInOrder(p.items.map((r) => r.id)));
    const last = await this.#lastChanges(items.map((i) => i.id));
    return {
      ...p,
      items: items.map((i) => {
        const { productTitle, variantLabel } = splitLabel(i.label);
        return {
          stockItemId: i.id,
          offerId: i.offerId ?? null,
          productTitle,
          variantLabel,
          image: i.image ?? null,
          sku: i.sku,
          available: i.quantities.available,
          reserved: i.quantities.reserved,
          lowStockThreshold: i.lowStockThreshold ?? null,
          state: i.state,
          lastChange: last.get(i.id) ?? null,
          updatedAt: i.updatedAt,
        };
      }),
    };
  }

  async exportOwnStock(body: { filters?: unknown; stockItemIds?: string[] | null; format?: 'csv' | 'xlsx' | null }, by: SellerBy): Promise<reports.ExportJob> {
    const reportsApi = this.ctx.tryUse('reports');
    if (!reportsApi) throw new AppError('SERVICE_UNAVAILABLE', 'Exports are unavailable right now');
    const raw = body.filters ?? {};
    if (typeof raw !== 'object' || Array.isArray(raw)) throw invalid('filters', 'Filters are the list filters: q, state, categoryId');
    const f = raw as Record<string, unknown>;
    const filters: Record<string, unknown> = {};
    if (f.q !== undefined && f.q !== null) {
      if (typeof f.q !== 'string') throw invalid('filters.q', 'Search text must be text');
      filters.q = f.q;
    }
    if (f.state !== undefined && f.state !== null) {
      if (!['in_stock', 'low_stock', 'out_of_stock'].includes(f.state as string)) throw invalid('filters.state', 'State is in_stock, low_stock or out_of_stock');
      filters.state = f.state;
    }
    if (f.categoryId !== undefined && f.categoryId !== null) {
      if (typeof f.categoryId !== 'string') throw invalid('filters.categoryId', 'Category must be an id');
      filters.categoryId = f.categoryId;
    }
    if (body.stockItemIds?.length) {
      const own = await this.repo.items({ ownerType: 'seller', sellerId: by.sellerId, ids: body.stockItemIds, includeArchived: true });
      if (own.length !== new Set(body.stockItemIds).size) throw invalid('stockItemIds', 'Some selected rows are not in your stock list');
      filters.stockItemIds = [...new Set(body.stockItemIds)];
    }
    await this.registerDatasets();
    const job = await reportsApi.requestExport({ dataset: SELLER_DATASET, filters, format: body.format ?? 'csv', principal: by.principal, sellerId: by.sellerId });
    await this.#audit(
      {
        action: 'inventory.stock.export',
        actionLabel: 'Exported stock list',
        category: 'other',
        target: { type: 'export', id: job.id, ref: job.ref, label: 'Stock export', sellerId: by.sellerId, screen: 'seller/inventory' },
        after: { filters, format: job.format },
        visibleToSeller: true,
      },
      by,
    );
    return job;
  }

  async getOwnStockExport(id: string, by: SellerBy): Promise<reports.ExportJob> {
    const reportsApi = this.ctx.tryUse('reports');
    if (!reportsApi) throw notFound('Export');
    const job = await reportsApi.getExport(id, by.principal);
    if (!job || job.dataset !== SELLER_DATASET || (job.sellerId && job.sellerId !== by.sellerId)) throw notFound('Export');
    if (job.requestedBy?.id && by.principal.accountId && job.requestedBy.id !== by.principal.accountId) throw new AppError('FORBIDDEN', 'Only the member who requested this export can download it');
    return job;
  }

  async getOwnStockItem(sellerId: string, id: string): Promise<StockItemDetail> {
    return this.#detail(await this.#ownItem(sellerId, id));
  }

  async #detail(row: Row<'stock_items'>): Promise<StockItemDetail> {
    const [item] = await this.#itemsApi([row]);
    const levels = await this.repo.levels([row.id]);
    const locations = new Map((await this.repo.locations({ ids: levels.map((l) => l.location_id) })).map((l) => [l.id, l]));
    const openLines = await this.repo.linesWhere({ itemIds: [row.id], states: ['held', 'allocated'] });
    const reservations = await Promise.all([...new Set(openLines.map((l) => l.reservation_id))].map((rid) => this.repo.get('reservations', rid)));
    const expectations = await this.repo.expectations({ itemIds: [row.id], openOnly: true });
    return {
      item: item!,
      levels: levels.map((l) => ({ locationId: l.location_id, locationName: locations.get(l.location_id)?.name ?? '', binCode: row.primary_bin_code, quantities: levelQty(l) })),
      reservations: await this.#reservationsApi(reservations.filter((r): r is Row<'reservations'> => !!r), row.id),
      incoming: expectations.map(incomingCue),
      pendingAdjustments: await this.#adjustmentsApi(await this.repo.adjustmentsWhere({ itemIds: [row.id], states: ['requested', 'pending_review'] })),
      openDiscrepancies: await this.#discrepanciesApi(await this.repo.discrepanciesWhere({ itemIds: [row.id], states: ['open'] })),
      recentMovements: await this.#movementsApi(await this.repo.recentMovements([row.id], 20)),
    };
  }

  /** Sets a seller item's Available quantity (Reserved untouched) with one ledger row */
  async #setSellerAvailable(
    sellerId: string,
    itemId: string,
    newAvailable: number,
    o: { reason: string; note: string | null; ref?: MovementRef; by: By; allowNoChange?: boolean },
  ): Promise<Row<'stock_movements'> | null> {
    if (!Number.isInteger(newAvailable) || newAvailable < 0) throw invalid('newAvailable', 'Available must be a whole number, 0 or more');
    const item = await this.#ownItem(sellerId, itemId);
    if (item.archived) throw inventoryError('STOCK_ITEM_ARCHIVED', 'This stock item is archived because its offer was removed');
    const result = await this.#stock(
      'adjustment',
      async (st) => {
        await st.lock([item.id]);
        const location = st.levels(item.id)[0]?.location_id ?? (await this.#sellerLocation(st.tx, sellerId)).id;
        const current = st.qty(item.id, location).available;
        const delta = newAvailable - current;
        if (delta === 0) {
          if (o.allowNoChange) return null;
          throw invalid('newAvailable', `Available is already ${current}`);
        }
        return st.move(item.id, location, delta > 0 ? 'outside' : 'available', delta > 0 ? 'available' : 'outside', Math.abs(delta), { reason: o.reason, note: o.note, ref: o.ref ?? { kind: 'adjustment', id: item.id, label: reasonLabel(o.reason) }, actor: o.by.actor });
      },
      this.#meta(o.by),
    );
    if (result) {
      this.ctx.events.publish(
        'inventory.adjustment.recorded',
        { adjustmentId: null, movementId: result.id, stockItemId: item.id, ownerType: item.owner_type, sellerId: item.seller_id, fromGroup: result.from_group, toGroup: result.to_group, quantity: result.quantity, reasonCode: result.reason_code, actor: o.by.actor },
        this.#meta(o.by),
      );
    }
    return result;
  }

  async adjustOwnStock(id: string, body: SellerAdjustmentRequest, by: SellerBy): Promise<Movement> {
    const m = await this.#setSellerAvailable(by.sellerId, id, body.newAvailable, { reason: body.reasonCode, note: body.note ?? null, by });
    return toMovement(m!, (await this.#item(id)).sku);
  }

  async batchAdjustOwnStock(body: { items: SellerAdjustmentItem[]; note?: string | null }, by: SellerBy): Promise<{ results: AdjustmentResult[] }> {
    if (!body.items?.length) throw invalid('items', 'Nothing to save');
    if (body.items.length > BATCH) throw invalid('items', `Save at most ${BATCH} rows at once`);
    const results: AdjustmentResult[] = [];
    for (const it of body.items) {
      try {
        const m = await this.#setSellerAvailable(by.sellerId, it.stockItemId, it.newAvailable, { reason: it.reasonCode, note: body.note ?? null, by, allowNoChange: true });
        results.push({ stockItemId: it.stockItemId, ok: true, movement: m ? toMovement(m, (await this.#item(it.stockItemId)).sku) : null, error: null });
      } catch (err) {
        if (!isAppError(err) || err.status >= 500) throw err;
        results.push({ stockItemId: it.stockItemId, ok: false, movement: null, error: { code: err.code, message: err.message, ...(err.details === undefined ? {} : { details: err.details }) } });
      }
    }
    return { results };
  }

  async updateOwnStockItem(sellerId: string, id: string, body: { lowStockThreshold?: number | null }): Promise<StockItem> {
    const item = await this.#ownItem(sellerId, id);
    if (body.lowStockThreshold !== undefined && body.lowStockThreshold !== null && body.lowStockThreshold < 0) throw invalid('lowStockThreshold', 'The low-stock alert must be 0 or more');
    if (body.lowStockThreshold === undefined) return this.#itemApi(item);
    return this.#itemApi(await this.repo.update('stock_items', id, { low_stock_threshold: body.lowStockThreshold, updated_at: this.now() }));
  }

  async listOwnMovements(sellerId: string, query: { stockItemId?: string; reasonCode?: string; from?: string; to?: string }, page: PageRequest): Promise<common.Page<Movement>> {
    const p = await this.repo.pageMovements({ ownerType: 'seller', sellerId, ...(query.stockItemId ? { stockItemIds: [query.stockItemId] } : {}), reasonCode: query.reasonCode, from: query.from, to: query.to }, page);
    return { ...p, items: await this.#movementsApi(p.items) };
  }

  /* ================================================================ admin area: stock items */

  #adminListFilter(q: { q?: string; ownerType?: 'official' | 'seller'; sellerId?: string; filter?: string; locationId?: string; zone?: string }, def: number): ItemListFilter {
    const ownerType = q.ownerType ?? (q.sellerId ? 'seller' : 'official');
    return {
      ownerType,
      ...(q.sellerId ? { sellerId: q.sellerId } : {}),
      ...(q.q ? { q: q.q } : {}),
      ...(q.filter ? { filter: q.filter } : {}),
      ...(q.locationId ? { locationId: q.locationId } : {}),
      ...(q.zone ? { zone: q.zone } : {}),
      defaultSellerThreshold: def,
    };
  }

  async listStockItems(query: { q?: string; ownerType?: 'official' | 'seller'; sellerId?: string; filter?: string; locationId?: string; zone?: string }, page: PageRequest): Promise<common.Page<StockItem>> {
    const filter = this.#adminListFilter(query, await this.#defaultThreshold());
    const p = await this.repo.pageItemIds(filter, page);
    return { ...p, items: await this.#itemsApi(await this.#rowsInOrder(p.items.map((r) => r.id)), { locationId: query.locationId }) };
  }

  async getStockItem(id: string): Promise<StockItemDetail> {
    return this.#detail(await this.#item(id));
  }

  async createStockItemAsStaff(body: StockItemInput, by: StaffBy): Promise<StockItem> {
    if (body.lowStockThreshold !== undefined && body.lowStockThreshold !== null && body.lowStockThreshold < 0) throw invalid('lowStockThreshold', 'The reorder point must be 0 or more');
    if (body.reorderQuantity !== undefined && body.reorderQuantity !== null && body.reorderQuantity < 0) throw invalid('reorderQuantity', 'The reorder quantity must be 0 or more');
    if (!body.sku?.trim()) throw invalid('sku', 'Enter the SKU');
    if (!body.condition?.trim()) throw invalid('condition', 'Enter the condition');
    const location = await this.repo.get('locations', body.locationId);
    if (!location || location.owner_type !== 'official' || !location.active) throw invalid('locationId', 'Choose an active company stock location');
    let label = body.sku.trim();
    const catalog = this.ctx.tryUse('catalog');
    if (catalog) {
      const product = await catalog.getProduct(body.productId);
      if (!product) throw invalid('productId', 'Product not found in the catalog');
      const variant = product.variants.find((v) => v.id === body.variantId);
      if (!variant) throw invalid('variantId', 'This variant is not part of the product');
      const options = Object.values(variant.options ?? {}).join(' ');
      label = options ? `${product.title}, ${options}` : product.title;
    }
    const created = await this.createStockItem({ ownerType: 'official', sku: body.sku, productId: body.productId, variantId: body.variantId, condition: body.condition.trim(), label, initialAvailable: 0, ...(body.lowStockThreshold != null ? { lowStockThreshold: body.lowStockThreshold } : {}), locationId: location.id });
    let row = await this.#item(created.id);
    if (body.reorderQuantity != null) row = await this.repo.update('stock_items', row.id, { reorder_quantity: body.reorderQuantity });
    const item = await this.#itemApi(row);
    await this.#audit({ action: 'inventory.stock_item.create', actionLabel: 'Created company stock item', category: 'other', target: { type: 'stock_item', id: item.id, ref: item.sku, label: item.label, screen: 'ops/inventory' }, after: item }, by);
    return item;
  }

  async updateStockItem(id: string, body: { lowStockThreshold?: number | null; reorderQuantity?: number | null; archived?: boolean | null }, by: StaffBy): Promise<StockItem> {
    const before = await this.#officialItem(id);
    if (body.lowStockThreshold != null && body.lowStockThreshold < 0) throw invalid('lowStockThreshold', 'The reorder point must be 0 or more');
    if (body.reorderQuantity != null && body.reorderQuantity < 0) throw invalid('reorderQuantity', 'The reorder quantity must be 0 or more');
    const patch: Partial<Row<'stock_items'>> = {};
    if (body.lowStockThreshold !== undefined) patch.low_stock_threshold = body.lowStockThreshold;
    if (body.reorderQuantity !== undefined) patch.reorder_quantity = body.reorderQuantity;
    if (body.archived !== undefined && body.archived !== null) patch.archived = body.archived;
    if (!Object.keys(patch).length) return this.#itemApi(before);
    const beforeApi = await this.#itemApi(before);
    const after = await this.#itemApi(await this.repo.update('stock_items', id, { ...patch, updated_at: this.now() }));
    await this.#audit(
      { action: body.archived ? 'inventory.stock_item.archive' : 'inventory.stock_item.update', actionLabel: body.archived ? 'Archived company SKU' : 'Changed reorder point', category: 'other', target: { type: 'stock_item', id, ref: after.sku, label: after.label, screen: 'ops/inventory' }, before: beforeApi, after },
      by,
    );
    return after;
  }

  /* ---------------------------------------------------------------- adjustments (company stock) */

  async createAdjustment(body: AdjustmentRequest, by: StaffBy): Promise<Adjustment> {
    const item = await this.#officialItem(body.stockItemId);
    return this.#requestAdjustment(item, { ...body, locationId: body.locationId ?? null }, by);
  }

  async #requestAdjustment(
    item: Row<'stock_items'>,
    body: { locationId: string | null; fromGroup: GroupOrOutside; toGroup: GroupOrOutside; quantity: number; reasonCode: string; note?: string | null; reviewDate?: string | null; secondReviewerId?: string | null },
    by: StaffBy,
  ): Promise<Adjustment> {
    if (item.archived) throw inventoryError('STOCK_ITEM_ARCHIVED', 'This stock item is archived');
    if ((body.fromGroup as string) === 'reserved' || (body.toGroup as string) === 'reserved') throw inventoryError('RESERVED_NOT_ADJUSTABLE', 'Reserved units belong to orders; use the reservation or a discrepancy');
    if (body.fromGroup === body.toGroup) throw invalid('toGroup', 'Choose two different stock groups');
    if (!Number.isInteger(body.quantity) || body.quantity <= 0) throw invalid('quantity', 'Quantity must be at least 1');
    if (body.toGroup === 'damaged_held' && !body.reviewDate) throw inventoryError('REVIEW_DATE_REQUIRED', 'Moving units into Damaged or held needs a review date');
    const levels = await this.repo.levels([item.id]);
    const locationId = body.locationId ?? levels[0]?.location_id ?? (await this.#officialDefault())?.id;
    const location = locationId ? await this.repo.get('locations', locationId) : undefined;
    if (!location || location.owner_type !== 'official') throw invalid('locationId', 'Choose a company stock location');
    const current = levelQty(levels.find((l) => l.location_id === location.id));
    if (body.fromGroup !== 'outside' && current[FIELD[body.fromGroup]] < body.quantity) {
      const have = current[FIELD[body.fromGroup]];
      throw inventoryError('GROUP_QUANTITY_EXCEEDED', `Only ${have} unit${have === 1 ? '' : 's'} in ${GROUP_INFO[body.fromGroup].label}`, { group: body.fromGroup, quantity: have });
    }
    const unitCost = unitCostOf(item);
    const value = unitCost ? money(unitCost.amount * body.quantity, unitCost.currency) : null;
    const access = this.ctx.tryUse('access');
    const check = access ? await access.check(by.principal, APPROVAL_ACTION, { number: body.quantity, ...(value ? { money: value } : {}) }) : null;
    if (check?.decision === 'denied') throw new AppError('FORBIDDEN', check.reason || 'Your role cannot adjust company stock');
    const id = newId();
    const row = {
      id,
      stock_item_id: item.id,
      location_id: location.id,
      from_group: body.fromGroup,
      to_group: body.toGroup,
      quantity: body.quantity,
      reason_code: body.reasonCode,
      note: body.note ?? null,
      review_date: body.reviewDate ?? null,
      approval_request_id: null as string | null,
      requested_by: actorText(by.actor),
      decided_by: null,
      movement_id: null,
      created_at: this.now(),
      applied_at: null,
    };
    const summary = `${item.sku}: ${body.quantity} unit${body.quantity === 1 ? '' : 's'} ${body.fromGroup.replace('_', ' ')} → ${body.toGroup.replace('_', ' ')}`;
    const target = { type: 'stock_adjustment', id, ref: item.sku, label: summary };

    if (check?.decision === 'approval_required') {
      const request = await access!.requestApproval({
        action: APPROVAL_ACTION,
        target: { ...target, screen: 'ops/inventory' },
        amount: value,
        quantity: body.quantity,
        summary,
        details: { stockItemId: item.id, sku: item.sku, label: item.label, locationId: location.id, fromGroup: body.fromGroup, toGroup: body.toGroup, quantity: body.quantity, before: current, after: applyMove(current, body.fromGroup, body.toGroup, body.quantity), valueAtCost: value },
        reason: body.note?.trim() || reasonLabel(body.reasonCode),
        requestedBy: by.principal,
        nominatedReviewerId: body.secondReviewerId ?? null,
      });
      let saved: Row<'adjustments'>;
      try {
        saved = (await this.repo.insert('adjustments', { ...row, state: adjustmentMachine.next('requested', 'requestReview'), approval_request_id: request.id }))!;
      } catch (err) {
        await access!.cancelApproval(request.id, by.actor, 'The adjustment could not be saved').catch((e) => this.ctx.log.warn({ err: e }, 'inventory: could not withdraw approval request'));
        throw err;
      }
      const api = (await this.#adjustmentsApi([saved]))[0]!;
      await this.#audit({ action: 'inventory.adjustment.request', actionLabel: 'Sent stock adjustment for second review', category: 'other', target: { ...target, screen: 'ops/inventory' }, after: api, reason: body.note ?? reasonLabel(body.reasonCode), approvalRequestId: request.id }, by);
      return api;
    }

    const applied = await this.#stock(
      'adjustment',
      async (st) => {
        const m = await st.move(item.id, location.id, body.fromGroup, body.toGroup, body.quantity, {
          reason: body.reasonCode,
          note: body.note ?? null,
          ref: { kind: 'adjustment', id, label: `Adjustment ${reasonLabel(body.reasonCode)}` },
          actor: by.actor,
          ...(body.toGroup === 'damaged_held' ? { hold: { reasonCode: body.reasonCode, reviewDate: body.reviewDate!, reason: body.note ?? null } } : {}),
        });
        return st.tx.insert('adjustments', { ...row, state: adjustmentMachine.next('requested', 'apply'), movement_id: m.id, applied_at: st.now });
      },
      this.#meta(by),
    );
    const api = (await this.#adjustmentsApi([applied!]))[0]!;
    this.#publishAdjustmentRecorded(applied!, item, by.actor, by);
    await this.#reportWriteOff(item, body.toGroup, body.quantity, { kind: 'adjustment', id }, by);
    await this.#audit({ action: 'inventory.adjustment.apply', actionLabel: 'Adjusted company stock', category: 'other', target: { ...target, screen: 'ops/inventory' }, before: api.before, after: api.after, reason: body.note ?? reasonLabel(body.reasonCode), approvalNote: check?.reason ?? null }, by);
    return api;
  }

  #publishAdjustmentRecorded(a: Row<'adjustments'>, item: Row<'stock_items'>, actor: common.Actor, by: By) {
    this.ctx.events.publish(
      'inventory.adjustment.recorded',
      { adjustmentId: a.id, movementId: a.movement_id!, stockItemId: item.id, ownerType: item.owner_type, sellerId: item.seller_id, fromGroup: a.from_group, toGroup: a.to_group, quantity: a.quantity, reasonCode: a.reason_code, actor },
      this.#meta(by),
    );
  }

  /** Units of company stock leaving stock (written off) are reported to finance at cost */
  async #reportWriteOff(item: Row<'stock_items'>, to: GroupOrOutside, quantity: number, reference: { kind: 'adjustment' | 'return'; id: string; ref?: string }, by: By) {
    if (to !== 'outside') return;
    const cost = unitCostOf(item);
    const finance = this.ctx.tryUse('finance');
    if (!cost || !finance || cost.amount === 0) return;
    try {
      await finance.recordCompanyCost({ kind: 'write_off', amount: money(cost.amount * quantity, cost.currency), reference: { kind: reference.kind, id: reference.id, ref: reference.ref ?? item.sku }, at: this.now().toISOString() });
    } catch (err) {
      // the stock has already moved; the write-off is retried by finance reconciliation from the ledger
      this.ctx.log.error({ err, stockItemId: item.id, by: by.actor }, 'inventory: write-off could not be reported to finance');
    }
  }

  async listAdjustments(query: { state?: string; stockItemId?: string }, page: PageRequest): Promise<common.Page<Adjustment>> {
    const p = await this.repo.pageAdjustments(query, page);
    return { ...p, items: await this.#adjustmentsApi(p.items) };
  }

  async cancelAdjustment(id: string, reason: string, by: StaffBy): Promise<Adjustment> {
    if (!reason?.trim()) throw invalid('reason', 'Say why you are withdrawing the adjustment');
    const a = await this.repo.get('adjustments', id);
    if (!a) throw notFound('Adjustment');
    adjustmentMachine.next(a.state as 'pending_review', 'cancel'); // ILLEGAL_TRANSITION unless waiting for review
    const after = await this.repo.transaction(async (tx) => {
      const locked = (await tx.get('adjustments', id, { forUpdate: true }))!;
      return tx.update('adjustments', id, { state: adjustmentMachine.next(locked.state as 'pending_review', 'cancel'), decided_by: actorText(by.actor) });
    });
    if (a.approval_request_id) {
      await this.ctx
        .tryUse('access')
        ?.cancelApproval(a.approval_request_id, by.actor, reason)
        .catch((err) => this.ctx.log.warn({ err }, 'inventory: could not withdraw approval request'));
    }
    const api = (await this.#adjustmentsApi([after]))[0]!;
    await this.#audit({ action: 'inventory.adjustment.cancel', actionLabel: 'Withdrew stock adjustment', category: 'other', target: { type: 'stock_adjustment', id, ref: api.sku, label: api.label, screen: 'ops/inventory' }, reason, before: { state: a.state }, after: { state: api.state } }, by);
    return api;
  }

  async listMovements(query: { stockItemId?: string; sku?: string; reasonCode?: string; referenceKind?: string; from?: string; to?: string }, page: PageRequest): Promise<common.Page<Movement>> {
    const p = await this.repo.pageMovements({ ...(query.stockItemId ? { stockItemIds: [query.stockItemId] } : {}), sku: query.sku, reasonCode: query.reasonCode, referenceKind: query.referenceKind, from: query.from, to: query.to }, page);
    return { ...p, items: await this.#movementsApi(p.items) };
  }

  /* ---------------------------------------------------------------- reservations (staff) */

  async listReservations(query: { orderId?: string; stockItemId?: string; state?: string }, page: PageRequest): Promise<common.Page<Reservation>> {
    const p = await this.repo.pageReservations(query, page);
    return { ...p, items: await this.#reservationsApi(p.items) };
  }

  async releaseReservation(id: string, body: { reason: string; lineIds?: string[] | null }, by: StaffBy): Promise<Reservation> {
    if (!body.reason?.trim()) throw invalid('reason', 'Say why the units are released');
    const r = await this.repo.get('reservations', id);
    if (!r) throw notFound('Reservation');
    reservationMachine.next(r.state as ReservationState, 'release'); // ILLEGAL_TRANSITION unless held or allocated
    const result = await this.#stock(
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
      this.#meta(by),
    );
    await this.#publishReleased(result.reservation, result.changed, 'staff', by);
    const api = await this.#reservationApi(id);
    await this.#audit({ action: 'inventory.reservation.release', actionLabel: 'Released reserved stock', category: 'orders', target: { type: 'reservation', id, ref: r.order_ref, label: r.order_ref ? `Order ${r.order_ref}` : `Reservation ${r.key}`, screen: 'admin/order' }, reason: body.reason, before: { state: r.state }, after: { state: api.state, lines: result.changed.map((l) => l.id) } }, by);
    return api;
  }

  /* ---------------------------------------------------------------- inbound receipts */

  async listInbound(query: { state?: string }, page: PageRequest): Promise<common.Page<InboundReceipt>> {
    const p = await this.repo.pageInbound(query, page);
    return { ...p, items: await this.#inboundsApi(p.items) };
  }

  async getInbound(id: string): Promise<InboundReceipt> {
    const r = await this.repo.get('inbound_receipts', id);
    if (!r) throw notFound('Receipt');
    return (await this.#inboundsApi([r]))[0]!;
  }

  async confirmInbound(id: string, body: ConfirmInboundRequest, by: StaffBy): Promise<InboundReceipt> {
    const receipt = await this.repo.get('inbound_receipts', id);
    if (!receipt) throw notFound('Receipt');
    inboundConfirmationMachine.next(receipt.state as 'awaiting_confirmation', 'confirm');
    if (body.checked !== true) throw invalid('checked', 'Confirm that you counted and checked these units');
    const lines = await this.repo.inboundLines([id]);
    const decided = new Map<string, { sellable: number; damaged: number; reason: string | null }>();
    for (const [i, l] of (body.lines ?? []).entries()) {
      const line = lines.find((x) => x.stock_item_id === l.stockItemId);
      if (!line) throw invalid(`lines[${i}].stockItemId`, 'This stock item is not on the receipt');
      if (!Number.isInteger(l.sellable) || l.sellable < 0 || !Number.isInteger(l.damaged) || l.damaged < 0) throw invalid(`lines[${i}]`, 'Quantities must be whole numbers, 0 or more');
      if (l.sellable + l.damaged > line.received) throw inventoryError('SELLABLE_EXCEEDS_RECEIVED', `Sellable and damaged units of ${l.stockItemId} add up to more than the ${line.received} received`, { stockItemId: l.stockItemId, received: line.received });
      if (l.sellable !== line.received - l.damaged && !l.reason?.trim()) throw invalid(`lines[${i}].reason`, 'Say why the sellable quantity differs from received minus damaged');
      decided.set(l.stockItemId, { sellable: l.sellable, damaged: l.damaged, reason: l.reason?.trim() || null });
    }
    const ref: MovementRef = { kind: 'receipt', id: receipt.receipt_id, label: `Received ${receipt.purchase_order_ref}` };
    const reviewDate = addDays(this.today(), DEFAULT_HOLD_REVIEW_DAYS);
    const resolved: Row<'discrepancies'>[] = [];
    await this.#stock(
      'receipt_confirmed',
      async (st) => {
        const locked = (await st.tx.get('inbound_receipts', id, { forUpdate: true }))!;
        const state = inboundConfirmationMachine.next(locked.state as 'awaiting_confirmation', 'confirm');
        await st.lock(lines.map((l) => l.stock_item_id));
        for (const line of lines) {
          const d = decided.get(line.stock_item_id) ?? { sellable: Math.max(0, line.received - line.damaged), damaged: line.damaged, reason: null };
          const item = st.item(line.stock_item_id);
          // weighted average cost over units on hand plus the units accepted at the receipt's cost
          const accepted = d.sellable + d.damaged;
          if (accepted > 0) {
            const cost = weightedAverage(item.unit_cost_amount === null ? null : Number(item.unit_cost_amount), onHand(st.total(item.id)), Number(line.unit_cost_amount), accepted);
            st.items.set(item.id, await st.tx.update('stock_items', item.id, { unit_cost_amount: cost, ...(line.bin_code && !item.primary_bin_code ? { primary_bin_code: line.bin_code } : {}) }));
          }
          if (d.sellable > 0) await st.move(item.id, locked.location_id, 'incoming', 'available', d.sellable, { reason: 'receipt_confirmed', note: d.reason, ref, actor: by.actor });
          if (d.damaged > 0)
            await st.move(item.id, locked.location_id, 'incoming', 'damaged_held', d.damaged, { reason: 'receipt_damaged', ref, actor: by.actor, hold: { reasonCode: 'receipt_damaged', reviewDate, reason: 'Supplier claim follow-up', sourceRef: receipt.receipt_ref } });
          const rejected = line.received - accepted;
          if (rejected > 0) await st.move(item.id, locked.location_id, 'incoming', 'outside', rejected, { reason: 'receipt_not_accepted', note: d.reason, ref, actor: by.actor });
          await st.tx.updateInboundLine(id, item.id, { sellable: d.sellable, damaged: d.damaged, reason: d.reason });
        }
        // orders waiting on a pick shortage of these SKUs are served first from the new units
        const waiting = (await st.tx.discrepanciesWhere({ itemIds: lines.map((l) => l.stock_item_id), states: ['open'], kinds: ['pick_shortage'] })).filter((x) => x.order_id && x.location_id === locked.location_id).reverse();
        for (const w of waiting) {
          if (st.qty(w.stock_item_id, w.location_id).available < w.quantity) continue;
          const lines = await this.#openOrderLines(st.tx, w.order_id!, w.stock_item_id, w.location_id);
          if (!lines.length) continue;
          await this.#reallocateShortage(st, w, 'available', by.actor);
          resolved.push(await st.tx.update('discrepancies', w.id, { state: discrepancyMachine.next('open', 'resolve'), resolution: 'reallocated', resolution_note: `Served from receipt ${receipt.receipt_ref}`, resolved_by: actorText(by.actor), resolved_at: st.now }));
        }
        await st.tx.update('inbound_receipts', id, { state, confirmed_by: actorText(by.actor), confirmed_at: st.now, note: body.note ?? null });
      },
      this.#meta(by),
    );
    const api = await this.getInbound(id);
    this.ctx.events.publish('inventory.receipt.confirmed', { inboundId: id, receiptId: receipt.receipt_id, purchaseOrderId: receipt.purchase_order_id, lines: api.lines, confirmedBy: by.actor }, this.#meta(by));
    for (const d of resolved) this.ctx.events.publish('inventory.discrepancy.resolved', { discrepancyId: d.id, resolution: 'reallocated', orderId: d.order_id }, this.#meta(by));
    await this.#audit({ action: 'inventory.inbound.confirm', actionLabel: 'Confirmed received stock', category: 'other', target: { type: 'receipt', id: receipt.receipt_id, ref: receipt.receipt_ref, label: `${receipt.supplier_name} · ${receipt.purchase_order_ref}`, screen: 'ops/receiving' }, after: api.totals, reason: body.note ?? null }, by);
    return api;
  }

  /* ---------------------------------------------------------------- return outcomes */

  async listReturnOutcomes(query: { state?: string }, page: PageRequest): Promise<common.Page<ReturnOutcome>> {
    const p = await this.repo.pageReturnOutcomes(query, page);
    return { ...p, items: await this.#returnOutcomesApi(p.items) };
  }

  async recordReturnOutcome(id: string, body: RecordReturnOutcomeRequest, by: StaffBy): Promise<ReturnOutcome> {
    const o = await this.repo.get('return_outcomes', id);
    if (!o) throw notFound('Return outcome');
    returnStockOutcomeMachine.next(o.state as 'pending', 'record');
    const outcome = body.outcome as ReturnOutcomeKind;
    const source = await this.#item(o.stock_item_id);
    let target: Row<'stock_items'> | undefined;
    if (outcome === 'different_condition') {
      if (!body.targetStockItemId) throw invalid('targetStockItemId', 'Choose the company stock item for the new condition');
      target = await this.repo.get('stock_items', body.targetStockItemId);
      if (!target || target.owner_type !== 'official' || target.id === source.id) throw invalid('targetStockItemId', 'Choose another company stock item');
      if (target.archived) throw inventoryError('STOCK_ITEM_ARCHIVED', 'The target stock item is archived');
    }
    const holding = outcome === 'damaged_stock' || outcome === 'repair' || outcome === 'return_to_supplier';
    if (holding && !body.reviewDate) throw inventoryError('REVIEW_DATE_REQUIRED', 'Units kept in Damaged or held need a review date');
    const ref: MovementRef = { kind: 'return', id: o.return_id, label: `Return ${o.return_ref}` };
    const moveReason = outcome === 'return_to_supplier' ? 'return_to_supplier' : `return_${outcome}`;
    let valueAtCost: common.Money | null = null;
    await this.#stock(
      'return_outcome',
      async (st) => {
        const locked = (await st.tx.get('return_outcomes', id, { forUpdate: true }))!;
        const state = returnStockOutcomeMachine.next(locked.state as 'pending', 'record');
        await st.lock([source.id, ...(target ? [target.id] : [])]);
        const at = st.levels(source.id).find((l) => l.returned >= locked.quantity) ?? st.levels(source.id)[0];
        if (!at) throw inventoryError('GROUP_QUANTITY_EXCEEDED', 'No returned units of this item', { group: 'returned', quantity: 0 });
        const loc = at.location_id;
        const meta = { reason: moveReason, note: body.note ?? null, ref, actor: by.actor };
        if (outcome === 'restock') await st.move(source.id, loc, 'returned', 'available', locked.quantity, meta);
        if (holding) await st.move(source.id, loc, 'returned', 'damaged_held', locked.quantity, { ...meta, hold: { reasonCode: moveReason, reviewDate: body.reviewDate!, reason: body.note ?? null, sourceRef: o.return_ref } });
        if (outcome === 'write_off') {
          await st.move(source.id, loc, 'returned', 'outside', locked.quantity, meta);
          const cost = unitCostOf(st.item(source.id));
          valueAtCost = cost ? money(cost.amount * locked.quantity, cost.currency) : null;
        }
        if (outcome === 'different_condition') {
          await st.move(source.id, loc, 'returned', 'outside', locked.quantity, meta);
          const tgt = st.item(target!.id);
          const targetLoc = st.levels(tgt.id).find((l) => l.location_id === loc)?.location_id ?? st.levels(tgt.id)[0]?.location_id ?? loc;
          // the unit keeps its original cost in the target condition
          const cost = unitCostOf(st.item(source.id));
          if (cost) st.items.set(tgt.id, await st.tx.update('stock_items', tgt.id, { unit_cost_amount: weightedAverage(tgt.unit_cost_amount === null ? null : Number(tgt.unit_cost_amount), onHand(st.total(tgt.id)), cost.amount, locked.quantity) }));
          await st.move(tgt.id, targetLoc, 'outside', 'available', locked.quantity, meta);
        }
        if (body.binCode && outcome !== 'different_condition' && !st.item(source.id).primary_bin_code) await st.tx.update('stock_items', source.id, { primary_bin_code: body.binCode });
        await st.tx.update('return_outcomes', id, { state, recorded_outcome: outcome, target_stock_item_id: target?.id ?? null, recorded_by: actorText(by.actor), recorded_at: st.now });
      },
      this.#meta(by),
    );
    this.ctx.events.publish('inventory.return_outcome.recorded', { returnId: o.return_id, stockItemId: source.id, outcome, targetStockItemId: target?.id ?? null, quantity: o.quantity, valueAtCost }, this.#meta(by));
    if (outcome === 'write_off') await this.#reportWriteOff(source, 'outside', o.quantity, { kind: 'return', id: o.return_id, ref: o.return_ref }, by);
    const api = (await this.#returnOutcomesApi([(await this.repo.get('return_outcomes', id))!]))[0]!;
    await this.#audit({ action: 'inventory.return_outcome.record', actionLabel: 'Recorded stock outcome of a return', category: 'returns', target: { type: 'return', id: o.return_id, ref: o.return_ref, label: `${source.sku} · ${o.quantity} unit${o.quantity === 1 ? '' : 's'}`, screen: 'ops/return-inspection' }, after: { outcome, targetStockItemId: target?.id ?? null, valueAtCost }, reason: body.note ?? null }, by);
    return api;
  }

  /* ---------------------------------------------------------------- discrepancies */

  async listDiscrepancies(query: { state?: string; kind?: string }, page: PageRequest): Promise<common.Page<Discrepancy>> {
    const p = await this.repo.pageDiscrepancies(query, page);
    return { ...p, items: await this.#discrepanciesApi(p.items) };
  }

  /** A pick shortage served by another unit: the replacement joins the order's allocation, the missing unit leaves stock */
  async #reallocateShortage(st: StockTx, d: Row<'discrepancies'>, source: 'available' | 'returned', actor: common.Actor) {
    const ref: MovementRef = { kind: 'discrepancy', id: d.id, label: d.order_ref ? `Shortage, order ${d.order_ref}` : 'Pick shortage' };
    await st.move(d.stock_item_id, d.location_id, source, 'reserved', d.quantity, { reason: 'reallocated', ref, actor });
    await st.move(d.stock_item_id, d.location_id, 'reserved', 'outside', d.quantity, { reason: 'pick_shortage', ref, actor });
  }

  async resolveDiscrepancy(id: string, body: ResolveDiscrepancyRequest, by: StaffBy): Promise<Discrepancy> {
    if (!body.note?.trim()) throw invalid('note', 'Add a note on how it was resolved');
    const d = await this.repo.get('discrepancies', id);
    if (!d) throw notFound('Discrepancy');
    discrepancyMachine.next(d.state as 'open', 'resolve');
    const n = body.adjustQuantity ?? d.quantity;
    if (body.resolution === 'adjusted' && (!Number.isInteger(n) || n <= 0)) throw invalid('adjustQuantity', 'Quantity must be at least 1');
    const source = body.sourceGroup ?? 'available';
    const ref: MovementRef = { kind: 'discrepancy', id, label: d.order_ref ? `${d.kind === 'pick_shortage' ? 'Shortage' : 'Damage'}, order ${d.order_ref}` : d.kind === 'pick_shortage' ? 'Pick shortage' : 'Damage found' };
    await this.#stock(
      'discrepancy',
      async (st) => {
        const locked = (await st.tx.get('discrepancies', id, { forUpdate: true }))!;
        const state = discrepancyMachine.next(locked.state as 'open', 'resolve');
        await st.lock([locked.stock_item_id]);
        const orderLines = locked.order_id ? await this.#openOrderLines(st.tx, locked.order_id, locked.stock_item_id, locked.location_id) : [];
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
            for (const rid of new Set(orderLines.map((l) => l.reservation_id))) await this.#syncReservationState(st.tx, (await st.tx.get('reservations', rid))!, { releasedReason: 'Pick shortage written off' });
          } else {
            await st.move(locked.stock_item_id, locked.location_id, 'available', 'outside', n, { reason: locked.kind === 'count_mismatch' ? 'count_difference' : 'pick_shortage', note: body.note, ref, actor: by.actor });
          }
        }
        if (locked.kind === 'damage_found' && locked.order_id && body.resolution !== 'reallocated') {
          // no replacement: the order's allocation stays without the damaged units
          for (const r of await st.tx.reservationsByOrder(locked.order_id, { forUpdate: true })) {
            if (r.state === 'held' || r.state === 'allocated') await this.#syncReservationState(st.tx, r, { releasedReason: 'Damaged at packing' });
          }
        }
        await st.tx.update('discrepancies', id, { state, resolution: body.resolution, resolution_note: body.note, resolved_by: actorText(by.actor), resolved_at: st.now });
      },
      this.#meta(by),
    );
    this.ctx.events.publish('inventory.discrepancy.resolved', { discrepancyId: id, resolution: body.resolution, orderId: d.order_id }, this.#meta(by));
    const api = (await this.#discrepanciesApi([(await this.repo.get('discrepancies', id))!]))[0]!;
    await this.#audit({ action: 'inventory.discrepancy.resolve', actionLabel: 'Resolved warehouse discrepancy', category: 'other', target: { type: 'discrepancy', id, ref: d.order_ref, label: `${api.sku} · ${d.kind.replace('_', ' ')}`, screen: 'ops/inventory' }, after: { resolution: body.resolution, adjustQuantity: body.adjustQuantity ?? null, sourceGroup: body.sourceGroup ?? null }, reason: body.note }, by);
    return api;
  }

  /* ---------------------------------------------------------------- low stock */

  async listLowStock(query: { ownerType?: 'official' | 'seller'; locationId?: string }, page: PageRequest): Promise<common.Page<LowStockRow>> {
    const def = await this.#defaultThreshold();
    const p = await this.repo.pageItemIds({ ownerType: query.ownerType ?? 'official', filter: 'low_or_out', ...(query.locationId ? { locationId: query.locationId } : {}), defaultSellerThreshold: def }, page);
    const items = await this.#itemsApi(await this.#rowsInOrder(p.items.map((r) => r.id)));
    const sold = await this.repo.dispatchedSince(items.map((i) => i.id), new Date(this.now().getTime() - 30 * 86_400_000));
    return {
      ...p,
      items: items.map((item) => {
        const daily = (sold.get(item.id) ?? 0) / 30;
        const threshold = item.lowStockThreshold ?? null;
        const incoming = item.nextIncoming ?? null;
        return {
          item,
          daysOfCover: daily > 0 ? Math.round((item.quantities.available / daily) * 10) / 10 : null,
          suggestedReorderQuantity: item.reorderQuantity ?? (threshold !== null ? Math.max(0, threshold * 2 - item.quantities.available - item.quantities.incoming) : null),
          incoming,
        };
      }),
    };
  }

  /* ---------------------------------------------------------------- locations */

  async listLocations(): Promise<Location[]> {
    return (await this.repo.locations({ ownerType: 'official' })).map(toLocation);
  }

  #checkTimeZone(tz: string) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
    } catch {
      throw invalid('timeZone', 'Not a known time zone');
    }
  }

  /** One sellable warehouse at launch; a second one is operational expansion (phase 4) */
  async #checkSecondSellable(exceptId?: string) {
    if (this.ctx.config.launchPhase >= 4) return;
    const others = (await this.repo.locations({ ownerType: 'official' })).filter((l) => l.id !== exceptId && l.active && l.sellable && l.kind === 'warehouse');
    if (others.length) throw invalid('sellable', 'A second sellable warehouse is part of operational expansion (launch phase 4)');
  }

  async createLocation(body: LocationInput, by: StaffBy): Promise<Location> {
    const code = body.code?.trim();
    if (!code) throw invalid('code', 'Enter the location code');
    if (!body.name?.trim()) throw invalid('name', 'Enter the location name');
    this.#checkTimeZone(body.timeZone);
    const sellable = body.sellable ?? true;
    const active = body.active ?? true;
    if (sellable && active) await this.#checkSecondSellable();
    if (await this.repo.locationByCode(code)) throw new AppError('CONFLICT', `A location with code ${code} already exists`, { code });
    const hasDefault = !!(await this.repo.locations({ ownerType: 'official' })).find((l) => l.is_default);
    const row = await this.repo.insert(
      'locations',
      { id: newId(), code, name: body.name.trim(), kind: 'warehouse', owner_type: 'official', seller_id: null, address: JSON.stringify(body.address), time_zone: body.timeZone, sellable, active, is_default: !hasDefault && active },
      { ignoreConflict: true },
    );
    if (!row) throw new AppError('CONFLICT', `A location with code ${code} already exists`, { code });
    const api = toLocation(row);
    await this.#audit({ action: 'inventory.location.create', actionLabel: 'Added stock location', category: 'other', target: { type: 'location', id: api.id, ref: api.code, label: api.name, screen: 'ops/inventory' }, after: api }, by);
    return api;
  }

  async updateLocation(id: string, body: { name?: string | null; address?: common.Address | null; sellable?: boolean | null; active?: boolean | null }, by: StaffBy): Promise<Location> {
    const before = await this.repo.get('locations', id);
    if (!before || before.owner_type !== 'official') throw notFound('Location');
    const patch: Partial<Row<'locations'>> = {};
    if (body.name != null) {
      if (!body.name.trim()) throw invalid('name', 'Enter the location name');
      patch.name = body.name.trim();
    }
    if (body.address != null) patch.address = JSON.stringify(body.address);
    if (body.sellable != null) patch.sellable = body.sellable;
    if (body.active != null) patch.active = body.active;
    const sellable = patch.sellable ?? before.sellable;
    const active = patch.active ?? before.active;
    if (sellable && active && !(before.sellable && before.active)) await this.#checkSecondSellable(id);
    if (before.active && active === false) {
      const totals = await this.repo.levelTotals({ ownerType: 'official', locationId: id });
      const units = totals.reduce((n, l) => n + l.available + l.reserved + l.incoming + l.damaged_held + l.returned, 0);
      if (units > 0) throw invalid('active', `${units} unit${units === 1 ? ' is' : 's are'} still at this location; move them first`);
    }
    const after = await this.repo.transaction(async (tx) => {
      let row = await tx.update('locations', id, patch);
      if (row.is_default && !row.active) {
        row = await tx.update('locations', id, { is_default: false });
        const next = (await tx.locations({ ownerType: 'official' })).find((l) => l.active && l.kind === 'warehouse' && l.id !== id);
        if (next) await tx.update('locations', next.id, { is_default: true });
      }
      if (row.active && !(await tx.locations({ ownerType: 'official' })).some((l) => l.is_default && l.active)) row = await tx.update('locations', id, { is_default: true });
      return row;
    });
    const api = toLocation(after);
    await this.#audit({ action: 'inventory.location.update', actionLabel: 'Changed stock location', category: 'other', target: { type: 'location', id, ref: api.code, label: api.name, screen: 'ops/inventory' }, before: toLocation(before), after: api }, by);
    return api;
  }

  /* ---------------------------------------------------------------- transfers (phase 4) */

  async createTransfer(body: { fromLocationId: string; toLocationId: string; lines: TransferLine[]; note?: string | null }, by: StaffBy): Promise<Transfer> {
    if (body.fromLocationId === body.toLocationId) throw invalid('toLocationId', 'Choose two different warehouses');
    const [from, to] = await Promise.all([this.repo.get('locations', body.fromLocationId), this.repo.get('locations', body.toLocationId)]);
    if (!from || from.owner_type !== 'official' || !from.active) throw invalid('fromLocationId', 'Choose an active company warehouse');
    if (!to || to.owner_type !== 'official' || !to.active) throw invalid('toLocationId', 'Choose an active company warehouse');
    if (!body.lines?.length) throw invalid('lines', 'Add at least one line');
    const items = await this.repo.items({ ids: body.lines.map((l) => l.stockItemId) });
    const seen = new Set<string>();
    for (const [i, l] of body.lines.entries()) {
      if (!items.find((it) => it.id === l.stockItemId && it.owner_type === 'official')) throw invalid(`lines[${i}].stockItemId`, 'Unknown company stock item');
      if (seen.has(l.stockItemId)) throw invalid(`lines[${i}].stockItemId`, 'Each stock item appears once');
      seen.add(l.stockItemId);
      if (!Number.isInteger(l.quantity) || l.quantity <= 0) throw invalid(`lines[${i}].quantity`, 'Quantity must be at least 1');
    }
    const id = newId();
    const ref = await this.ctx.refs.next('TRF', { digits: 4 });
    const row = await this.repo.transaction(async (tx) => {
      const t = await tx.insert('transfers', { id, ref, from_location_id: from.id, to_location_id: to.id, state: 'draft', created_by: actorText(by.actor), shipped_at: null, received_at: null });
      await tx.insertTransferLines(body.lines.map((l) => ({ transfer_id: id, stock_item_id: l.stockItemId, quantity: l.quantity, received_quantity: null })));
      return t!;
    });
    const api = await this.#transferApi(row);
    await this.#audit({ action: 'inventory.transfer.create', actionLabel: 'Planned stock transfer', category: 'other', target: { type: 'transfer', id, ref, label: `${from.code} → ${to.code}`, screen: 'ops/inventory' }, after: api, reason: body.note ?? null }, by);
    return api;
  }

  async listTransfers(query: { state?: string }, page: PageRequest): Promise<common.Page<Transfer>> {
    const p = await this.repo.pageTransfers(query, page);
    return { ...p, items: await Promise.all(p.items.map((t) => this.#transferApi(t))) };
  }

  async #transfer(id: string) {
    const t = await this.repo.get('transfers', id);
    if (!t) throw notFound('Transfer');
    return t;
  }

  async shipTransfer(id: string, by: StaffBy): Promise<Transfer> {
    const t = await this.#transfer(id);
    transferMachine.next(t.state as 'draft', 'ship');
    const ref: MovementRef = { kind: 'transfer', id, label: `Transfer ${t.ref}` };
    await this.#stock(
      'transfer',
      async (st) => {
        const locked = (await st.tx.get('transfers', id, { forUpdate: true }))!;
        const state = transferMachine.next(locked.state as 'draft', 'ship');
        const lines = await st.tx.transferLines(id);
        await st.lock(lines.map((l) => l.stock_item_id));
        for (const l of lines) {
          await st.move(l.stock_item_id, locked.from_location_id, 'available', 'outside', l.quantity, { reason: 'transfer_shipped', ref, actor: by.actor });
          await st.move(l.stock_item_id, locked.to_location_id, 'outside', 'incoming', l.quantity, { reason: 'transfer_shipped', ref, actor: by.actor });
          await st.tx.insert('incoming_expectations', { id: newId(), stock_item_id: l.stock_item_id, location_id: locked.to_location_id, source_kind: 'transfer', source_id: id, source_ref: locked.ref, quantity_open: l.quantity, expected_date: null });
        }
        await st.tx.update('transfers', id, { state, shipped_at: st.now });
      },
      this.#meta(by),
    );
    const api = await this.#transferApi((await this.repo.get('transfers', id))!);
    await this.#audit({ action: 'inventory.transfer.ship', actionLabel: 'Sent stock transfer', category: 'other', target: { type: 'transfer', id, ref: t.ref, screen: 'ops/inventory' }, before: { state: t.state }, after: { state: api.state } }, by);
    return api;
  }

  async receiveTransfer(id: string, body: { lines: TransferLine[]; note?: string | null }, by: StaffBy): Promise<Transfer> {
    const t = await this.#transfer(id);
    transferMachine.next(t.state as 'in_transit', 'receive');
    const lines = await this.repo.transferLines(id);
    const received = new Map<string, number>();
    for (const [i, l] of (body.lines ?? []).entries()) {
      const line = lines.find((x) => x.stock_item_id === l.stockItemId);
      if (!line) throw invalid(`lines[${i}].stockItemId`, 'This stock item is not on the transfer');
      const n = l.receivedQuantity ?? l.quantity;
      if (!Number.isInteger(n) || n < 0 || n > line.quantity) throw invalid(`lines[${i}].receivedQuantity`, `Received must be between 0 and ${line.quantity}`);
      received.set(l.stockItemId, n);
    }
    const ref: MovementRef = { kind: 'transfer', id, label: `Transfer ${t.ref}` };
    await this.#stock(
      'transfer',
      async (st) => {
        const locked = (await st.tx.get('transfers', id, { forUpdate: true }))!;
        const state = transferMachine.next(locked.state as 'in_transit', 'receive');
        await st.lock(lines.map((l) => l.stock_item_id));
        const expectations = await st.tx.expectations({ sourceKind: 'transfer', sourceId: id }, { forUpdate: true });
        for (const l of lines) {
          const n = received.get(l.stock_item_id) ?? l.quantity;
          if (n > 0) await st.move(l.stock_item_id, locked.to_location_id, 'incoming', 'available', n, { reason: 'transfer_received', note: body.note ?? null, ref, actor: by.actor });
          if (l.quantity - n > 0) await st.move(l.stock_item_id, locked.to_location_id, 'incoming', 'outside', l.quantity - n, { reason: 'transfer_short', note: body.note ?? null, ref, actor: by.actor });
          await st.tx.updateTransferLine(id, l.stock_item_id, { received_quantity: n });
          for (const e of expectations.filter((x) => x.stock_item_id === l.stock_item_id)) await st.tx.update('incoming_expectations', e.id, { quantity_open: 0 });
        }
        await st.tx.update('transfers', id, { state, received_at: st.now });
      },
      this.#meta(by),
    );
    this.ctx.events.publish('inventory.transfer.received', { transferId: id, toLocationId: t.to_location_id }, this.#meta(by));
    const api = await this.#transferApi((await this.repo.get('transfers', id))!);
    await this.#audit({ action: 'inventory.transfer.receive', actionLabel: 'Received stock transfer', category: 'other', target: { type: 'transfer', id, ref: t.ref, screen: 'ops/inventory' }, before: { state: t.state }, after: { state: api.state, lines: api.lines }, reason: body.note ?? null }, by);
    return api;
  }

  async cancelTransfer(id: string, reason: string, by: StaffBy): Promise<Transfer> {
    if (!reason?.trim()) throw invalid('reason', 'Say why the transfer is cancelled');
    const t = await this.#transfer(id);
    const state = transferMachine.next(t.state as 'draft', 'cancel');
    const after = await this.repo.update('transfers', id, { state });
    const api = await this.#transferApi(after);
    await this.#audit({ action: 'inventory.transfer.cancel', actionLabel: 'Cancelled stock transfer', category: 'other', target: { type: 'transfer', id, ref: t.ref, screen: 'ops/inventory' }, before: { state: t.state }, after: { state }, reason }, by);
    return api;
  }

  /* ---------------------------------------------------------------- stock counts (phase 4) */

  async createCount(body: { locationId: string; scope: string }, by: StaffBy): Promise<StockCount> {
    const location = await this.repo.get('locations', body.locationId);
    if (!location || location.owner_type !== 'official') throw invalid('locationId', 'Choose a company stock location');
    const scope = body.scope?.trim();
    if (!scope) throw invalid('scope', 'Enter a zone, bin prefix or SKU list');
    const levels = await this.repo.levelTotals({ ownerType: 'official', locationId: location.id });
    const items = await this.repo.items({ ids: levels.map((l) => l.stock_item_id) });
    const skus = scope.split(/[\s,;]+/).filter(Boolean);
    const bySku = items.filter((i) => skus.includes(i.sku));
    const chosen = bySku.length ? bySku : items.filter((i) => (i.primary_bin_code ?? '').toUpperCase().startsWith(scope.toUpperCase()));
    if (!chosen.length) throw invalid('scope', 'No stock items at this location match the scope');
    const id = newId();
    const row = await this.repo.transaction(async (tx) => {
      const c = await tx.insert('stock_counts', { id, location_id: location.id, scope, state: 'open', created_by: actorText(by.actor), submitted_at: null });
      await tx.insertCountLines(
        chosen.map((i) => {
          const l = levels.find((x) => x.stock_item_id === i.id)!;
          return { count_id: id, stock_item_id: i.id, bin_code: i.primary_bin_code, expected: l.available + l.reserved, counted: null };
        }),
      );
      return c!;
    });
    return this.#countApi(row);
  }

  async recordCountLines(id: string, lines: CountLine[]): Promise<StockCount> {
    const c = await this.repo.get('stock_counts', id);
    if (!c) throw notFound('Stock count');
    if (c.state !== 'open') stockCountMachine.next(c.state as 'open', 'cancel'); // ILLEGAL_TRANSITION once submitted
    const own = await this.repo.countLines(id);
    for (const [i, l] of (lines ?? []).entries()) {
      if (!own.find((x) => x.stock_item_id === l.stockItemId)) throw invalid(`lines[${i}].stockItemId`, 'This stock item is not in the count');
      if (l.counted !== null && l.counted !== undefined && (!Number.isInteger(l.counted) || l.counted < 0)) throw invalid(`lines[${i}].counted`, 'Counted must be a whole number, 0 or more');
    }
    await this.repo.transaction(async (tx) => {
      const locked = (await tx.get('stock_counts', id, { forUpdate: true }))!;
      if (locked.state !== 'open') stockCountMachine.next(locked.state as 'open', 'cancel');
      for (const l of lines ?? []) await tx.updateCountLine(id, l.stockItemId, { counted: l.counted ?? null });
    });
    return this.#countApi((await this.repo.get('stock_counts', id))!);
  }

  async submitCount(id: string, by: StaffBy): Promise<StockCount> {
    const c = await this.repo.get('stock_counts', id);
    if (!c) throw notFound('Stock count');
    const submitted = stockCountMachine.next(c.state as 'open', 'submit');
    const lines = await this.repo.countLines(id);
    const levels = await this.repo.levels(lines.map((l) => l.stock_item_id));
    // all differences are checked before any becomes an adjustment
    const diffs: { item: Row<'stock_items'>; diff: number }[] = [];
    const items = await this.#skus(lines.map((l) => l.stock_item_id));
    for (const l of lines) {
      if (l.counted === null) continue;
      const level = levelQty(levels.find((x) => x.stock_item_id === l.stock_item_id && x.location_id === c.location_id));
      const diff = l.counted - (level.available + level.reserved);
      if (diff < 0 && -diff > level.available) throw inventoryError('RESERVED_NOT_ADJUSTABLE', `${items.get(l.stock_item_id)?.sku}: the count is short of the reserved units; report a discrepancy for the order`, { stockItemId: l.stock_item_id });
      if (diff !== 0) diffs.push({ item: items.get(l.stock_item_id)!, diff });
    }
    await this.repo.update('stock_counts', id, { state: submitted, submitted_at: this.now() });
    for (const d of diffs) {
      await this.#requestAdjustment(d.item, { locationId: c.location_id, fromGroup: d.diff > 0 ? 'outside' : 'available', toGroup: d.diff > 0 ? 'available' : 'outside', quantity: Math.abs(d.diff), reasonCode: 'count_correction', note: `Stock count ${c.scope}` }, by);
    }
    const after = await this.repo.update('stock_counts', id, { state: stockCountMachine.next(submitted, 'apply') });
    const api = await this.#countApi(after);
    await this.#audit({ action: 'inventory.count.submit', actionLabel: 'Submitted stock count', category: 'other', target: { type: 'stock_count', id, ref: c.scope, screen: 'ops/inventory' }, after: { differences: diffs.map((d) => ({ sku: d.item.sku, difference: d.diff })) } }, by);
    return api;
  }

  /* ================================================================ events consumed */

  /**
   * orders.order.accepted: Allocate the order's held reservation lines to order items. The order's hold is the
   * one checkout attached (attachOrder), or, when the event arrives first, the payload's reservationId; the
   * hold is then linked to the order here and attachOrder later only maps its lines to order items. Each
   * allocation claims `order-accepted:<orderId>:<reservationId>` in its own transaction (kernel inbox).
   */
  async onOrderAcceptedFromOrders(event: EventPayload<'orders.order.accepted'>): Promise<void> {
    let reservations = await this.repo.reservationsByOrder(event.orderId);
    if (!reservations.length && event.reservationId) {
      const r = isUuid(event.reservationId) ? await this.repo.get('reservations', event.reservationId) : undefined;
      if (!r) {
        this.ctx.log.info({ orderId: event.orderId, reservationId: event.reservationId }, 'inventory: accepted order names an unknown stock hold, nothing to allocate');
        return;
      }
      if (r.order_id && r.order_id !== event.orderId) {
        this.ctx.log.warn({ orderId: event.orderId, reservationId: r.id, holdOrderId: r.order_id }, 'inventory: the stock hold of an accepted order belongs to another order');
        return;
      }
      reservations = [r];
    }
    if (!reservations.length) {
      this.ctx.log.info({ orderId: event.orderId }, 'inventory: accepted order has no stock hold, nothing to allocate');
      return;
    }
    for (const r of reservations) {
      if (r.state === 'held') {
        const done = await this.repo.transaction(async (tx) => {
          const locked = (await tx.get('reservations', r.id, { forUpdate: true }))!;
          if (locked.state !== 'held' || (locked.order_id && locked.order_id !== event.orderId)) return null;
          if (!(await tx.claimEvent(`order-accepted:${event.orderId}:${r.id}`))) return null;
          const lines = await tx.lines([r.id], { forUpdate: true });
          const allocated: Row<'reservation_lines'>[] = [];
          for (const l of lines) if (l.state === 'held') allocated.push(await tx.update('reservation_lines', l.id, { state: 'allocated' }));
          await tx.update('reservations', r.id, { state: reservationMachine.next('held', 'allocate'), order_id: event.orderId, order_ref: event.ref, expires_at: null, updated_at: this.now() });
          return allocated;
        });
        if (done?.length) await this.#publishAllocated(r.id, event.orderId, done);
      } else if (r.state === 'expired' && !reservations.some((x) => x.state === 'allocated' || x.state === 'fulfilled')) {
        await this.#reallocateExpired(r, event);
      }
    }
  }

  async #publishAllocated(reservationId: string, orderId: string, lines: Row<'reservation_lines'>[]) {
    const items = await this.#skus(lines.map((l) => l.stock_item_id));
    this.ctx.events.publish('inventory.reservation.allocated', { reservationId, orderId, lines: lines.map((l) => toReservationLine(l, items.get(l.stock_item_id)?.sku ?? '')) }, { actor: SYSTEM_ACTOR });
  }

  /** The hold expired before payment was accepted: reserve the units again if they are still there */
  async #reallocateExpired(r: Row<'reservations'>, event: EventPayload<'orders.order.accepted'>) {
    const key = `order:${event.orderId}`;
    if (await this.repo.reservationByKey(key)) return;
    const old = await this.repo.lines([r.id]);
    const id = newId();
    try {
      const lines = await this.#stock('order_allocated', async (st) => {
        if (!(await st.tx.claimEvent(`order-accepted:${event.orderId}:${r.id}`))) return null;
        await st.tx.insert('reservations', { id, key, order_id: event.orderId, order_ref: event.ref, state: 'allocated', expires_at: null, released_reason: null, created_at: st.now, updated_at: st.now });
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
        return out;
      });
      if (lines) await this.#publishAllocated(id, event.orderId, lines);
    } catch (err) {
      if (!isAppError(err) || err.code !== 'INSUFFICIENT_STOCK') throw err;
      this.ctx.log.warn({ orderId: event.orderId, details: err.details }, 'inventory: accepted order could not be allocated after its hold expired');
      await this.#raise({ queueKey: 'inventory.reservations', kind: 'manual_task', title: `Order ${event.ref} could not be allocated`, summary: 'The checkout hold expired before payment was accepted and the units are no longer available.', subject: { type: 'order', id: event.orderId, ref: event.ref }, priority: 'high', dedupeKey: `inventory.allocation_failed:${event.orderId}` });
    }
  }

  /** orders.item.cancelled: Release that item's held or allocated units back to Available */
  async onItemCancelledFromOrders(event: EventPayload<'orders.item.cancelled'>): Promise<void> {
    const dedupe = `Cancellation ${event.cancellationId}`;
    const lines = (await this.repo.linesWhere({ orderItemIds: [event.itemId] })).filter((l) => l.state === 'held' || l.state === 'allocated');
    if (!lines.length) return;
    const done = (await this.repo.movementsByRef('order', [event.orderId])).some((m) => m.note === dedupe && m.reason_code === 'order_cancelled');
    if (done) return;
    const byReservation = new Map<string, Row<'reservation_lines'>[]>();
    for (const l of lines) byReservation.set(l.reservation_id, [...(byReservation.get(l.reservation_id) ?? []), l]);
    for (const [rid] of byReservation) {
      const result = await this.#stock('order_cancelled', async (st) => {
        const r = (await st.tx.get('reservations', rid, { forUpdate: true }))!;
        if (r.state !== 'held' && r.state !== 'allocated') return null;
        const own = (await st.tx.lines([rid], { forUpdate: true })).filter((l) => l.order_item_id === event.itemId && (l.state === 'held' || l.state === 'allocated'));
        let left = event.quantity;
        return this.#releaseLines(st, r, own, {
          reason: 'order_cancelled',
          note: dedupe,
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
    const dedupe = `Shipment ${event.shipmentId}`;
    if ((await this.repo.movementsByRef('order', [event.orderId])).some((m) => m.note === dedupe && m.reason_code === 'dispatched')) return;
    const wanted = new Map<string, number>();
    for (const l of event.lines) wanted.set(l.orderItemId, (wanted.get(l.orderItemId) ?? 0) + l.quantity);
    const lines = (await this.repo.linesWhere({ orderItemIds: [...wanted.keys()] })).filter((l) => l.state === 'allocated' || l.state === 'held');
    if (!lines.length) return;
    await this.#stock('dispatched', async (st) => {
      await st.lock(lines.map((l) => l.stock_item_id));
      const touched = new Set<string>();
      for (const l of (await st.tx.lines([...new Set(lines.map((x) => x.reservation_id))], { forUpdate: true })).filter((x) => wanted.has(x.order_item_id ?? ''))) {
        const open = openQty({ quantity: l.quantity, fulfilled: l.fulfilled_qty, released: l.released_qty, state: l.state });
        const n = Math.min(open, wanted.get(l.order_item_id!) ?? 0);
        if (n <= 0) continue;
        wanted.set(l.order_item_id!, wanted.get(l.order_item_id!)! - n);
        const r = await st.tx.get('reservations', l.reservation_id);
        await st.move(l.stock_item_id, l.location_id, 'reserved', 'outside', n, { reason: 'dispatched', note: dedupe, ref: { kind: 'order', id: event.orderId, label: `Order ${r?.order_ref ?? ''}`.trim() }, actor: SYSTEM_ACTOR });
        const fulfilled = l.fulfilled_qty + n;
        // a hold dispatched before acceptance was recorded is treated as allocated
        await st.tx.update('reservation_lines', l.id, { fulfilled_qty: fulfilled, state: lineStateAfter({ quantity: l.quantity, fulfilled, released: l.released_qty, state: 'allocated' }) });
        touched.add(l.reservation_id);
      }
      for (const rid of touched) {
        const r = (await st.tx.get('reservations', rid, { forUpdate: true }))!;
        if (r.state === 'held') await st.tx.update('reservations', rid, { state: reservationMachine.next('held', 'allocate'), expires_at: null });
        await this.#syncReservationState(st.tx, (await st.tx.get('reservations', rid))!);
      }
    });
  }

  /** returns.return.received: Official Store items: add the units to Returned at the receiving warehouse. Seller returns are recorded by sellers through adjustments. */
  async onReturnReceivedFromReturns(event: EventPayload<'returns.return.received'>): Promise<void> {
    // The event names no items or quantities, so the units are added to Returned when inspection
    // reports the variant and quantity (returns.return.inspected), once per return and item.
    if (event.ownerType !== 'official') return;
    this.ctx.log.debug({ returnId: event.returnId }, 'inventory: official return received; units are added to Returned on inspection');
  }

  /** returns.return.inspected: Create a pending return stock outcome with the inspector's proposed outcome */
  async onReturnInspectedFromReturns(event: EventPayload<'returns.return.inspected'>, envelope?: Pick<EventEnvelope, 'at'>): Promise<void> {
    if (event.ownerType !== 'official') return;
    const candidates = (await this.repo.items({ ownerType: 'official', variantIds: [event.variantId] })).sort((a, b) => Number(b.condition === 'new') - Number(a.condition === 'new'));
    const item = candidates[0];
    if (!item) {
      this.ctx.log.warn({ returnId: event.returnId, variantId: event.variantId }, 'inventory: inspected return has no company stock item for its variant, ignored');
      return;
    }
    if ((await this.repo.returnOutcomesWhere({ returnId: event.returnId })).some((o) => o.stock_item_id === item.id)) return;
    const location = (await this.repo.levels([item.id]))[0]?.location_id ?? (await this.#officialDefault())?.id;
    if (!location) {
      this.ctx.log.warn({ returnId: event.returnId }, 'inventory: no company location for an inspected return, ignored');
      return;
    }
    const proposed = (RETURN_OUTCOMES as readonly string[]).includes(event.proposedStockOutcome) ? event.proposedStockOutcome : 'damaged_stock';
    const quantity = Math.max(1, event.quantity);
    const short = event.returnId.slice(0, 8).toUpperCase();
    await this.#stock('return_received', async (st) => {
      const row = await st.tx.insert(
        'return_outcomes',
        {
          id: newId(),
          return_id: event.returnId,
          return_ref: `RT-${short}`,
          order_ref: '',
          stock_item_id: item.id,
          quantity,
          inspected_condition: event.conditionOutcome,
          proposed_outcome: proposed,
          proposed_target_sku: null,
          state: 'pending',
          recorded_outcome: null,
          target_stock_item_id: null,
          recorded_by: null,
          recorded_at: null,
          inspected_at: envelope?.at ? new Date(envelope.at) : st.now,
        },
        { ignoreConflict: true },
      );
      if (!row) return;
      await st.move(item.id, location, 'outside', 'returned', quantity, { reason: 'return_received', ref: { kind: 'return', id: event.returnId, label: `Return RT-${short}` }, actor: SYSTEM_ACTOR });
    });
  }

  /** warehouse.bin.assigned: Update the stock item's primary bin code shown in stock lists */
  async onBinAssignedFromWarehouse(event: EventPayload<'warehouse.bin.assigned'>): Promise<void> {
    if (!event.primary) return;
    const item = await this.repo.get('stock_items', event.stockItemId);
    if (!item) {
      this.ctx.log.info({ stockItemId: event.stockItemId }, 'inventory: bin assigned to an unknown stock item, ignored');
      return;
    }
    if (item.primary_bin_code !== event.binCode) await this.repo.update('stock_items', item.id, { primary_bin_code: event.binCode });
  }

  /** offers.offer.status_changed: Archive a seller stock item when its offer is removed (reserved units stay with their orders) */
  async onOfferStatusChangedFromOffers(event: EventPayload<'offers.offer.status_changed'>): Promise<void> {
    if (event.to !== 'removed' || event.ownerType !== 'seller') return;
    const archived = await this.repo.archiveItems({ offerId: event.offerId }, this.now());
    if (!archived.length) this.ctx.log.debug({ offerId: event.offerId }, 'inventory: removed offer has no live stock item');
  }

  /** sellers.seller.closed: Archive the seller's stock items */
  async onSellerClosedFromSellers(event: EventPayload<'sellers.seller.closed'>): Promise<void> {
    await this.repo.archiveItems({ sellerId: event.sellerId }, this.now());
  }

  /** access.approval.decided: Apply or reject adjustments waiting for second review */
  async onApprovalDecidedFromAccess(event: EventPayload<'access.approval.decided'>): Promise<void> {
    if (event.actionKey !== APPROVAL_ACTION) return;
    const a = await this.repo.adjustmentByApproval(event.requestId);
    if (!a || a.state !== 'pending_review') {
      if (!a) this.ctx.log.info({ requestId: event.requestId }, 'inventory: approval decided for an unknown adjustment, ignored');
      return;
    }
    const decidedBy = event.decidedBy ?? SYSTEM_ACTOR;
    const by: By = { actor: decidedBy };
    if (event.outcome !== 'approved') {
      await this.repo.transaction(async (tx) => {
        const locked = (await tx.get('adjustments', a.id, { forUpdate: true }))!;
        if (locked.state !== 'pending_review') return;
        await tx.update('adjustments', a.id, { state: adjustmentMachine.next('pending_review', event.outcome === 'cancelled' ? 'cancel' : 'reject'), decided_by: actorText(decidedBy) });
      });
      return;
    }
    const item = await this.#item(a.stock_item_id);
    const requester = actorOf(a.requested_by) ?? SYSTEM_ACTOR;
    try {
      const applied = await this.#stock(
        'adjustment',
        async (st) => {
          const locked = (await st.tx.get('adjustments', a.id, { forUpdate: true }))!;
          if (locked.state !== 'pending_review') return null;
          const m = await st.move(item.id, locked.location_id, locked.from_group as GroupOrOutside, locked.to_group as GroupOrOutside, locked.quantity, {
            reason: locked.reason_code,
            note: locked.note,
            ref: { kind: 'adjustment', id: locked.id, label: `Adjustment ${reasonLabel(locked.reason_code)}` },
            actor: requester,
            approvedBy: decidedBy,
            ...(locked.to_group === 'damaged_held' ? { hold: { reasonCode: locked.reason_code, reviewDate: locked.review_date ?? addDays(this.today(), DEFAULT_HOLD_REVIEW_DAYS), reason: locked.note } } : {}),
          });
          return st.tx.update('adjustments', a.id, { state: adjustmentMachine.next('pending_review', 'approve'), decided_by: actorText(decidedBy), movement_id: m.id, applied_at: st.now });
        },
        this.#meta(by),
      );
      if (!applied) return;
      this.#publishAdjustmentRecorded(applied, item, requester, by);
      await this.#reportWriteOff(item, applied.to_group as GroupOrOutside, applied.quantity, { kind: 'adjustment', id: applied.id }, by);
      await this.#audit({ action: 'inventory.adjustment.apply', actionLabel: 'Applied stock adjustment after second review', category: 'other', target: { type: 'stock_adjustment', id: a.id, ref: item.sku, label: item.label, screen: 'ops/inventory' }, after: { state: 'applied', quantity: a.quantity, fromGroup: a.from_group, toGroup: a.to_group }, reason: event.reason ?? null, approvalRequestId: event.requestId }, by);
    } catch (err) {
      if (!isAppError(err) || err.code !== 'GROUP_QUANTITY_EXCEEDED') throw err;
      // the units moved elsewhere while the adjustment waited: it cannot apply any more
      await this.repo.update('adjustments', a.id, { state: adjustmentMachine.next('pending_review', 'reject'), decided_by: actorText(decidedBy) });
      this.ctx.log.warn({ adjustmentId: a.id, details: err.details }, 'inventory: approved adjustment no longer fits the stock; marked rejected');
    }
  }

  /* ================================================================ jobs */

  /** Job inventory.expire-holds (every 1 min): Expire held reservations past expiresAt (Reserved → Available); publish inventory.reservation.released with reason expired */
  async expireHolds(): Promise<void> {
    for (;;) {
      const due = await this.repo.dueHolds(this.now(), BATCH);
      for (const r of due) {
        const result = await this.#stock('hold_expired', async (st) => {
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
    const stale = await this.repo.staleAllocations(new Date(this.now().getTime() - STALE_ALLOCATION_DAYS * 86_400_000), 500);
    for (const r of stale) {
      await this.#raise({
        queueKey: 'inventory.reservations',
        kind: 'manual_task',
        title: `Stock still reserved for order ${r.order_ref ?? r.key}`,
        summary: `Allocated for more than ${STALE_ALLOCATION_DAYS} days without dispatch or cancellation. Check the order and release the units if it is closed.`,
        subject: { type: 'order', id: r.order_id ?? r.id, ref: r.order_ref ?? null },
        priority: 'normal',
        dedupeKey: `inventory.stale_allocation:${r.id}`,
      });
    }
    if (stale.length) this.ctx.log.info({ count: stale.length }, 'inventory: allocations raised for review');
    return stale.length;
  }

  /** Raises a work item when work queues run (they may not be built yet: logged, never fails the job) */
  async #raise(input: { queueKey: string; kind: string; title: string; summary: string; subject: { type: string; id: string; ref?: string | null }; priority: 'low' | 'normal' | 'high' | 'urgent'; dedupeKey: string }) {
    const wq = this.ctx.tryUse('workqueues');
    if (!wq) return;
    try {
      await wq.raise({ ...input, subject: input.subject as never, relatedSubjects: [] });
    } catch (err) {
      this.ctx.log.warn({ err, dedupeKey: input.dedupeKey }, 'inventory: work item could not be raised');
    }
  }

  /** Job inventory.low-stock-digest (daily 07:00 market time): Low and out-of-stock summary per seller and for the Official Store (notifications) */
  async lowStockDigest(): Promise<{ owners: number; items: number }> {
    const def = await this.#defaultThreshold();
    const cooldownHours = Number(await this.ctx.settings.get('lowStockAlertCooldownHours'));
    const now = this.now();
    const owners = new Set<string>();
    let count = 0;
    for (let offset = 0; ; offset += BATCH) {
      const ids = await this.repo.itemIds({ filter: 'low_or_out', defaultSellerThreshold: def }, BATCH, offset);
      const rows = await this.#rowsInOrder(ids);
      const items = await this.#itemsApi(rows);
      for (const [i, row] of rows.entries()) {
        const api = items[i]!;
        const threshold = effectiveThreshold(row, def);
        if (threshold === null) continue;
        owners.add(row.seller_id ?? 'official');
        count++;
        // a reminder per item through inventory.stock.low (notifications turns it into the owner's notice), at most once per cooldown
        if (row.low_since && now.getTime() - row.low_since.getTime() < cooldownHours * 3_600_000) continue;
        await this.repo.update('stock_items', row.id, { low_since: now });
        this.ctx.events.publish('inventory.stock.low', { stockItemId: row.id, offerId: row.offer_id, ownerType: row.owner_type, sellerId: row.seller_id, sku: row.sku, label: row.label, available: api.quantities.available, threshold }, { actor: SYSTEM_ACTOR });
      }
      if (ids.length < BATCH) break;
    }
    this.ctx.log.info({ owners: owners.size, items: count }, 'inventory: low-stock digest');
    return { owners: owners.size, items: count };
  }

  /** Job inventory.held-stock-review (daily 07:00 market time): Publish inventory.hold.review_due for Damaged or held stock past its review date (work queue for the Inventory Manager) */
  async heldStockReview(): Promise<number> {
    const due = await this.repo.dueHeld(this.today(), 1000);
    for (const h of due) {
      if (h.quantity <= 0) continue;
      this.ctx.events.publish('inventory.hold.review_due', { stockItemId: h.stock_item_id, quantity: h.quantity, reasonCode: h.reason_code, reviewDate: h.review_date }, { actor: SYSTEM_ACTOR });
    }
    return due.length;
  }

  /** Job inventory.valuation-snapshot (daily 23:59 market time): Snapshot units and value at cost per group for company trading reports */
  async valuationSnapshot(): Promise<StockSummary> {
    const summary = await this.getStockSummary();
    // no snapshot table in the spec: the snapshot goes to the log for the trading reports to pick up
    this.ctx.log.info({ snapshot: { at: this.now().toISOString(), date: this.today(), skuCount: summary.skuCount, groups: summary.groups.map((g) => ({ group: g.group, units: g.units, valueAtCost: g.valueAtCost?.amount ?? 0 })) } }, 'inventory: valuation snapshot');
    return summary;
  }
}

/** Used by tests and the HTTP layer */
export const stockStateOf = stockState;
export type { Group };
