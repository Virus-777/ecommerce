/**
 * Shared plumbing of the inventory use cases: the stock transaction, audit, API object loaders, record lookups and
 * the locations every feature needs.
 */
import { AppError, isNotImplemented } from '../../../kernel/errors/index.js';
import type { PublishMeta } from '../../../kernel/events/index.js';
import { dateInZone } from '../../../kernel/lib/clock.js';
import { newId } from '../../../kernel/lib/ids.js';
import type { ModuleContext } from '../../../kernel/module-system/index.js';
import type * as audit from '../../../spec/audit.js';
import type * as common from '../../../spec/common.js';
import type * as identity from '../../../spec/identity.js';
import type {
  Adjustment,
  Discrepancy,
  InboundReceipt,
  Movement,
  Reservation,
  StockItem,
  StockItemDetail,
  StockQuantities,
} from '../../../spec/inventory.js';
import type * as workqueues from '../../../spec/workqueues.js';
import { applyMove, reasonLabel, type GroupOrOutside } from '../domain/rules.js';
import {
  actorOf,
  groupBy,
  incomingCue,
  iso,
  photoIdsOf,
  sellableAvailable,
  SYSTEM_ACTOR,
  toDiscrepancy,
  toInbound,
  toInboundLine,
  toMovement,
  toReservation,
  toReservationLine,
  toStockItem,
} from '../mappers.js';
import type { Row } from '../ports.js';
import type { InventoryRepository } from '../repository.js';
import { levelQty, StockTx, type StockEvents } from '../stock-tx.js';

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

export const BATCH = 200;

/** Review date of units moved into Damaged or held without one (damage at packing, damaged on receipt) */
export const DEFAULT_HOLD_REVIEW_DAYS = 14;

export const invalid = (path: string, message: string) => new AppError('VALIDATION_FAILED', message, { issues: [{ path, message }] });

export const notFound = (what = 'Stock item') => new AppError('NOT_FOUND', `${what} not found`);

export class Core {
  readonly ctx: ModuleContext<'inventory'>;
  readonly repo: InventoryRepository;

  constructor(deps: InventoryServiceDeps) {
    this.ctx = deps.ctx;
    this.repo = deps.repo;
  }

  now() {
    return this.ctx.clock.now();
  }
  today() {
    return dateInZone(this.now(), this.ctx.config.market.timeZone);
  }
  get currency() {
    return this.ctx.config.market.currency;
  }

  async defaultThreshold(): Promise<number> {
    return Number(await this.ctx.settings.get('defaultLowStockThreshold'));
  }

  /** Runs stock work in one transaction and publishes stock.changed / stock.low once it has committed. */
  async stock<T>(cause: string, fn: (st: StockTx) => Promise<T>, meta: PublishMeta = {}): Promise<T> {
    const [defaultThreshold, cooldownHours] = await Promise.all([this.defaultThreshold(), this.ctx.settings.get('lowStockAlertCooldownHours')]);
    let events: StockEvents = { changed: [], low: [] };
    const result = await this.repo.transaction(async (tx) => {
      const st = new StockTx(tx, this.now());
      const r = await fn(st);
      events = await st.finish(cause, { defaultThreshold, cooldownHours: Number(cooldownHours) });
      return r;
    });
    for (const e of events.changed) this.ctx.events.publish('inventory.stock.changed', e, meta);
    for (const e of events.low) this.ctx.events.publish('inventory.stock.low', e, meta);
    return result;
  }

  async audit(entry: Omit<audit.RecordInput, 'actor' | 'module' | 'requestId'>, by: By) {
    try {
      await this.ctx.tryUse('audit')?.record({ ...entry, actor: by.actor, module: this.ctx.name, requestId: by.requestId ?? null });
    } catch (err) {
      // the change is committed; a missing audit entry is logged, never turned into a failed request
      this.ctx.log[isNotImplemented(err) ? 'debug' : 'error']({ err, action: entry.action }, 'audit entry not recorded');
    }
  }

  meta(by: By): PublishMeta {
    return { actor: by.actor, ...(by.requestId ? { requestId: by.requestId } : {}) };
  }

  /** `images: false` when the caller does not show StockItem.image (summaries, digests, exports): no catalog call */
  async itemsApi(rows: Row<'stock_items'>[], opts: { locationId?: string; images?: boolean } = {}): Promise<StockItem[]> {
    if (!rows.length) return [];
    const [stock, images] = await Promise.all([this.stockOf(rows), opts.images === false ? new Map<string, common.MediaRef>() : this.images(rows)]);
    return rows.map((item) =>
      toStockItem(item, {
        levels: stock.levels.get(item.id) ?? [],
        locations: stock.locations,
        expectations: stock.expectations.get(item.id) ?? [],
        defaultThreshold: stock.defaultThreshold,
        locationId: opts.locationId,
        image: images.get(item.id) ?? null,
      }),
    );
  }

  /** What toStockItem needs besides the item: levels and open expectations per item, their locations, the default threshold */
  async stockOf(rows: Row<'stock_items'>[]): Promise<{ levels: Map<string, Row<'stock_levels'>[]>; expectations: Map<string, Row<'incoming_expectations'>[]>; locations: Map<string, Row<'locations'>>; defaultThreshold: number }> {
    const ids = rows.map((r) => r.id);
    const [levels, expectations, defaultThreshold] = await Promise.all([this.repo.levels(ids), this.repo.expectations({ itemIds: ids, openOnly: true }), this.defaultThreshold()]);
    const locations = new Map((await this.repo.locations({ ids: [...new Set(levels.map((l) => l.location_id))] })).map((l) => [l.id, l]));
    return { levels: groupBy(levels, (l) => l.stock_item_id), expectations: groupBy(expectations, (e) => e.stock_item_id), locations, defaultThreshold };
  }

  /** StockItem.image: the variant's first image, else the product's (catalog, batched; none while catalog is off) */
  async images(rows: Row<'stock_items'>[]): Promise<Map<string, common.MediaRef>> {
    const out = new Map<string, common.MediaRef>();
    const catalog = this.ctx.tryUse('catalog');
    if (!catalog || !rows.length) return out;
    try {
      const products = new Map((await catalog.getProducts([...new Set(rows.map((r) => r.product_id))])).map((rec) => [rec.product.id, rec.product]));
      for (const r of rows) {
        const p = products.get(r.product_id);
        const image = p?.variants.find((v) => v.id === r.variant_id)?.images?.[0] ?? p?.images?.[0];
        if (image) out.set(r.id, image);
      }
    } catch (err) {
      this.ctx.log.warn({ err }, 'inventory: product images unavailable');
    }
    return out;
  }

  async itemApi(row: Row<'stock_items'>): Promise<StockItem> {
    return (await this.itemsApi([row]))[0]!;
  }

  async skus(itemIds: string[]): Promise<Map<string, Row<'stock_items'>>> {
    const ids = [...new Set(itemIds)];
    if (!ids.length) return new Map();
    return new Map((await this.repo.items({ ids, includeArchived: true })).map((i) => [i.id, i]));
  }

  async movementsApi(rows: Row<'stock_movements'>[]): Promise<Movement[]> {
    const items = await this.skus(rows.map((m) => m.stock_item_id));
    return rows.map((m) => toMovement(m, items.get(m.stock_item_id)?.sku ?? ''));
  }

  /** Reservations with their lines; `onlyItem` keeps the lines of one stock item (a seller never sees other sellers' lines) */
  async reservationsApi(rows: Row<'reservations'>[], onlyItem?: string): Promise<Reservation[]> {
    const lines = (await this.repo.lines(rows.map((r) => r.id))).filter((l) => !onlyItem || l.stock_item_id === onlyItem);
    const items = await this.skus(lines.map((l) => l.stock_item_id));
    const byReservation = groupBy(lines, (l) => l.reservation_id);
    return rows.map((r) => toReservation(r, (byReservation.get(r.id) ?? []).map((l) => toReservationLine(l, items.get(l.stock_item_id)?.sku ?? ''))));
  }

  async reservationApi(id: string): Promise<Reservation> {
    const r = await this.repo.get('reservations', id);
    if (!r) throw notFound('Reservation');
    return (await this.reservationsApi([r]))[0]!;
  }

  async adjustmentsApi(rows: Row<'adjustments'>[]): Promise<Adjustment[]> {
    if (!rows.length) return [];
    const itemIds = [...new Set(rows.map((a) => a.stock_item_id))];
    const [items, levels, movementRows] = await Promise.all([this.skus(itemIds), this.repo.levels(itemIds), this.repo.movements(rows.flatMap((a) => (a.movement_id ? [a.movement_id] : [])))]);
    const movements = new Map(movementRows.map((m) => [m.id, m]));
    const access = this.ctx.tryUse('access');
    return Promise.all(
      rows.map(async (a) => {
        const item = items.get(a.stock_item_id);
        const movement = a.movement_id ? movements.get(a.movement_id) : undefined;
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

  async discrepanciesApi(rows: Row<'discrepancies'>[]): Promise<Discrepancy[]> {
    const items = await this.skus(rows.map((d) => d.stock_item_id));
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

  async inboundsApi(rows: Row<'inbound_receipts'>[]): Promise<InboundReceipt[]> {
    const lines = await this.repo.inboundLines(rows.map((r) => r.id));
    const itemIds = [...new Set(lines.map((l) => l.stock_item_id))];
    const [items, levels, shortages] = await Promise.all([
      this.skus(itemIds),
      this.repo.levels(itemIds),
      // no backorders at launch: open pick shortages on these SKUs are shown so they can be reallocated first
      this.repo.discrepanciesWhere({ itemIds, states: ['open'], kinds: ['pick_shortage'] }),
    ]);
    const locations = new Map((await this.repo.locations({ ids: [...new Set(levels.map((l) => l.location_id))] })).map((l) => [l.id, l]));
    const byReceipt = groupBy(lines, (l) => l.inbound_id);
    return rows.map((r) => {
      const own = byReceipt.get(r.id) ?? [];
      const ownItems = new Set(own.map((l) => l.stock_item_id));
      return toInbound(
        r,
        own.map((l) => {
          const item = items.get(l.stock_item_id);
          return toInboundLine(l, item, !item || sellableAvailable(item, levels, locations) === 0, this.currency);
        }),
        shortages.filter((d) => ownItems.has(d.stock_item_id)).length,
      );
    });
  }

  async officialDefault(tx: InventoryRepository = this.repo): Promise<Row<'locations'> | undefined> {
    const all = (await tx.locations({ ownerType: 'official' })).filter((l) => l.active && l.kind === 'warehouse');
    return all.find((l) => l.is_default) ?? all[0];
  }

  /** The seller's virtual location (one per seller), created on first use */
  async sellerLocation(tx: InventoryRepository, sellerId: string): Promise<Row<'locations'>> {
    const existing = (await tx.locations({ ownerType: 'seller', sellerId }))[0];
    if (existing) return existing;
    const row = await tx.insertIfAbsent(
      'locations',
      { id: newId(), code: `SV-${sellerId}`, name: 'Seller stock', kind: 'seller_virtual', owner_type: 'seller', seller_id: sellerId, address: null, time_zone: this.ctx.config.market.timeZone, sellable: true, active: true, is_default: true },
    );
    return row ?? (await tx.locationByCode(`SV-${sellerId}`))!;
  }

  async ownItem(sellerId: string, id: string): Promise<Row<'stock_items'>> {
    const item = await this.repo.get('stock_items', id);
    if (!item || item.owner_type !== 'seller' || item.seller_id !== sellerId) throw notFound();
    return item;
  }

  async item(id: string): Promise<Row<'stock_items'>> {
    const item = await this.repo.get('stock_items', id);
    if (!item) throw notFound();
    return item;
  }

  async officialItem(id: string): Promise<Row<'stock_items'>> {
    const item = await this.item(id);
    if (item.owner_type !== 'official') throw new AppError('VALIDATION_FAILED', 'Seller stock is managed by the seller; staff can only view it', { issues: [{ path: 'stockItemId', message: 'not a company stock item' }] });
    return item;
  }

  async rowsInOrder(ids: string[]): Promise<Row<'stock_items'>[]> {
    const rows = new Map((await this.repo.items({ ids, includeArchived: true })).map((r) => [r.id, r]));
    return ids.flatMap((id) => (rows.has(id) ? [rows.get(id)!] : []));
  }

  async detail(row: Row<'stock_items'>): Promise<StockItemDetail> {
    // independent reads, side by side; the item's levels, locations and expectations are read once for all parts
    const [stock, images, openLines, adjustments, discrepancies, movements] = await Promise.all([
      this.stockOf([row]),
      this.images([row]),
      this.repo.linesWhere({ itemIds: [row.id], states: ['held', 'allocated'] }),
      this.repo.adjustmentsWhere({ itemIds: [row.id], states: ['requested', 'pending_review'] }),
      this.repo.discrepanciesWhere({ itemIds: [row.id], states: ['open'] }),
      this.repo.recentMovements([row.id], 20),
    ]);
    const levels = stock.levels.get(row.id) ?? [];
    const expectations = stock.expectations.get(row.id) ?? [];
    // in the order their lines come
    const rids = [...new Set(openLines.map((l) => l.reservation_id))];
    const byId = new Map((await this.repo.reservations(rids)).map((r) => [r.id, r]));
    const reservations = rids.flatMap((id) => byId.get(id) ?? []);
    const [reservationsApi, pendingAdjustments, openDiscrepancies, recentMovements] = await Promise.all([
      this.reservationsApi(reservations, row.id),
      this.adjustmentsApi(adjustments),
      this.discrepanciesApi(discrepancies),
      this.movementsApi(movements),
    ]);
    return {
      item: toStockItem(row, { levels, locations: stock.locations, expectations, defaultThreshold: stock.defaultThreshold, image: images.get(row.id) ?? null }),
      levels: levels.map((l) => ({ locationId: l.location_id, locationName: stock.locations.get(l.location_id)?.name ?? '', binCode: row.primary_bin_code, quantities: levelQty(l) })),
      reservations: reservationsApi,
      incoming: expectations.map(incomingCue),
      pendingAdjustments,
      openDiscrepancies,
      recentMovements,
    };
  }

  /** Raises a work item when work queues run (they may not be built yet: logged, never fails the job) */
  async raise(input: { queueKey: string; kind: workqueues.RaiseInput['kind']; title: string; summary: string; subject: { type: string; id: string; ref?: string | null }; priority: 'low' | 'normal' | 'high' | 'urgent'; dedupeKey: string }) {
    const wq = this.ctx.tryUse('workqueues');
    if (!wq) return;
    try {
      await wq.raise({ ...input, subject: input.subject as never, relatedSubjects: [], sourceModule: 'inventory' });
    } catch (err) {
      this.ctx.log.warn({ err, dedupeKey: input.dedupeKey }, 'inventory: work item could not be raised');
    }
  }
}
