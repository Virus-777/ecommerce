/**
 * One unit of stock work inside a database transaction. Every quantity change goes through move():
 * the level rows of an item are locked (SELECT … FOR UPDATE, in a fixed order), the from-group is
 * checked, the level is written with an optimistic version check and one ledger row is appended,
 * all in the same transaction. Units entering Damaged or held get a held_stock row; units leaving it
 * release the oldest holds first. After the work, finish() works out the stock.changed and
 * stock.low events, which the service publishes once the transaction has committed.
 */
import { AppError } from '../../kernel/errors/index.js';
import { inventoryError } from './errors.js';
import { newId } from '../../kernel/lib/ids.js';
import type { Actor } from '../../spec/common.js';
import type { InventoryStockChangedEvent, InventoryStockLowEvent, MovementRef, StockQuantities } from '../../spec/inventory.js';
import { addQty, applyMove, stockState, unitsIn, zeroQty, type GroupOrOutside } from './domain/rules.js';
import type { InventoryRepository, Row } from './ports.js';

export interface HoldInfo {
  reasonCode: string;
  reviewDate: string;
  reason?: string | null;
  sourceRef?: string | null;
}

export interface MoveMeta {
  reason: string;
  note?: string | null;
  ref?: MovementRef | null;
  actor: Actor;
  approvedBy?: Actor | null;
  /** Required when units move into Damaged or held */
  hold?: HoldInfo;
  /** Error when the from-group is short (default GROUP_QUANTITY_EXCEEDED) */
  insufficient?: (have: number) => AppError;
}

export const levelQty = (l: Row<'stock_levels'> | undefined): StockQuantities =>
  l ? { available: l.available, reserved: l.reserved, incoming: l.incoming, damagedHeld: l.damaged_held, returned: l.returned } : zeroQty();

export interface StockEvents {
  changed: InventoryStockChangedEvent[];
  low: InventoryStockLowEvent[];
}

export class StockTx {
  readonly items = new Map<string, Row<'stock_items'>>();
  readonly movements: Row<'stock_movements'>[] = [];
  readonly #levels = new Map<string, Map<string, Row<'stock_levels'>>>();
  readonly #locations = new Map<string, Row<'locations'>>();
  readonly #before = new Map<string, { available: number; reserved: number }>();
  /** Items whose stock.changed is published even without a quantity change (re-keyed, archived, unarchived, merged) */
  readonly #touched = new Set<string>();

  constructor(
    readonly tx: InventoryRepository,
    readonly now: Date,
  ) {}

  /** Loads and locks the items' level rows (in id order, so concurrent work cannot deadlock). Unknown ids are skipped. */
  async lock(itemIds: string[]): Promise<void> {
    const ids = [...new Set(itemIds)].filter((id) => !this.#levels.has(id)).sort();
    if (!ids.length) return;
    const items = await this.tx.items({ ids, includeArchived: true });
    for (const it of items) this.items.set(it.id, it);
    const levels = await this.tx.levels(ids, { forUpdate: true });
    for (const id of ids) if (this.items.has(id)) this.#levels.set(id, new Map());
    for (const l of levels) this.#levels.get(l.stock_item_id)?.set(l.location_id, l);
    await this.#loadLocations(levels.map((l) => l.location_id));
    for (const id of ids) if (this.items.has(id)) this.#before.set(id, { available: this.sellableAvailable(id), reserved: this.total(id).reserved });
  }

  async #loadLocations(ids: string[]) {
    const missing = [...new Set(ids)].filter((id) => !this.#locations.has(id));
    if (!missing.length) return;
    for (const loc of await this.tx.locations({ ids: missing })) this.#locations.set(loc.id, loc);
  }

  /** Publish stock.changed for a locked item even if Available and Reserved did not change; `row` is the item as it is now */
  touch(itemId: string, row?: Row<'stock_items'>): void {
    if (row) this.items.set(itemId, row);
    this.#touched.add(itemId);
  }

  item(id: string): Row<'stock_items'> {
    const it = this.items.get(id);
    if (!it) throw new AppError('NOT_FOUND', 'Stock item not found');
    return it;
  }

  /** Locked level rows of an item */
  levels(itemId: string): Row<'stock_levels'>[] {
    return [...(this.#levels.get(itemId)?.values() ?? [])];
  }

  qty(itemId: string, locationId: string): StockQuantities {
    return levelQty(this.#levels.get(itemId)?.get(locationId));
  }

  total(itemId: string): StockQuantities {
    return this.levels(itemId).reduce((sum, l) => addQty(sum, levelQty(l)), zeroQty());
  }

  location(id: string) {
    return this.#locations.get(id);
  }

  isSellable(locationId: string) {
    const loc = this.#locations.get(locationId);
    return !!loc && loc.sellable && loc.active;
  }

  /** Available units at sellable, active locations (what checkout can hold) */
  sellableAvailable(itemId: string): number {
    return this.levels(itemId).reduce((n, l) => n + (this.isSellable(l.location_id) ? l.available : 0), 0);
  }

  /** Sellable locations of an item with Available units, default location first, most units next */
  sellableLevels(itemId: string): Row<'stock_levels'>[] {
    return this.levels(itemId)
      .filter((l) => this.isSellable(l.location_id) && l.available > 0)
      .sort((a, b) => Number(this.#locations.get(b.location_id)?.is_default) - Number(this.#locations.get(a.location_id)?.is_default) || b.available - a.available);
  }

  /** Moves n units between two groups of one item at one location, with a ledger row. */
  async move(itemId: string, locationId: string, from: GroupOrOutside, to: GroupOrOutside, n: number, meta: MoveMeta): Promise<Row<'stock_movements'>> {
    if (!Number.isInteger(n) || n <= 0) throw new AppError('VALIDATION_FAILED', 'Quantity must be a whole number above zero', { issues: [{ path: 'quantity', message: 'must be at least 1' }] });
    if (from === to) throw new AppError('VALIDATION_FAILED', 'Choose two different stock groups', { issues: [{ path: 'toGroup', message: 'same as fromGroup' }] });
    await this.lock([itemId]);
    const item = this.item(itemId);
    let level = this.#levels.get(itemId)!.get(locationId);
    if (!level) {
      await this.tx.ensureLevel(itemId, locationId, this.now);
      level = (await this.tx.levels([itemId], { forUpdate: true })).find((l) => l.location_id === locationId)!;
      this.#levels.get(itemId)!.set(locationId, level);
      await this.#loadLocations([locationId]);
    }
    const before = levelQty(level);
    const have = unitsIn(before, from);
    if (have < n) throw meta.insufficient?.(have) ?? inventoryError('GROUP_QUANTITY_EXCEEDED', `Only ${have} unit${have === 1 ? '' : 's'} in ${from.replace('_', ' ')} for ${item.sku}`, { group: from, quantity: have, stockItemId: itemId });
    if (to === 'damaged_held' && !meta.hold) throw inventoryError('REVIEW_DATE_REQUIRED', 'Moving units into Damaged or held needs a review date');
    const after = applyMove(before, from, to, n);
    const values = { available: after.available, reserved: after.reserved, incoming: after.incoming, damaged_held: after.damagedHeld, returned: after.returned, updated_at: this.now };
    if (!(await this.tx.updateLevel(itemId, locationId, values, level.version))) throw new AppError('CONFLICT', 'The stock changed at the same time; try again');
    this.#levels.get(itemId)!.set(locationId, { ...level, ...values, version: level.version + 1 });

    const movement = await this.tx.insertMovement({
      id: newId(this.now.getTime()),
      stock_item_id: itemId,
      location_id: locationId,
      from_group: from,
      to_group: to,
      quantity: n,
      reason_code: meta.reason,
      note: meta.note ?? null,
      ref_kind: meta.ref?.kind ?? null,
      ref_id: meta.ref?.id ?? null,
      ref_label: meta.ref?.label ?? null,
      actor_kind: meta.actor.kind,
      actor_id: meta.actor.id ?? null,
      actor_name: meta.actor.name ?? null,
      approved_by: meta.approvedBy ? JSON.stringify(meta.approvedBy) : null,
      after: JSON.stringify(after),
      at: this.now,
    });
    this.movements.push(movement);

    if (to === 'damaged_held') {
      await this.tx.insert('held_stock', {
        id: newId(),
        stock_item_id: itemId,
        location_id: locationId,
        quantity: n,
        reason_code: meta.hold!.reasonCode,
        reason: meta.hold!.reason ?? meta.note ?? null,
        review_date: meta.hold!.reviewDate,
        source_ref: meta.hold!.sourceRef ?? meta.ref?.label ?? null,
        released_at: null,
      });
    }
    if (from === 'damaged_held') await this.#releaseHeld(itemId, locationId, n);
    if (item.updated_at.getTime() !== this.now.getTime()) {
      this.items.set(itemId, await this.tx.update('stock_items', itemId, { updated_at: this.now }));
    }
    return movement;
  }

  /** Oldest holds first */
  async #releaseHeld(itemId: string, locationId: string, n: number) {
    let left = n;
    for (const h of await this.tx.openHeld(itemId, locationId, { forUpdate: true })) {
      if (left <= 0) break;
      const take = Math.min(left, h.quantity);
      left -= take;
      await this.tx.update('held_stock', h.id, take === h.quantity ? { quantity: 0, released_at: this.now } : { quantity: h.quantity - take });
    }
  }

  /**
   * Events for the items whose Available or Reserved changed, and low-stock alerts for items that
   * dropped to or below their threshold (once per cooldown, remembered in low_since).
   */
  async finish(cause: string, opts: { defaultSellerThreshold: number; cooldownHours: number }): Promise<StockEvents> {
    const out: StockEvents = { changed: [], low: [] };
    for (const [id, before] of this.#before) {
      const item = this.items.get(id)!;
      const available = this.sellableAvailable(id);
      const reserved = this.total(id).reserved;
      if (available === before.available && reserved === before.reserved && !this.#touched.has(id)) continue;
      const threshold = item.low_stock_threshold ?? (item.owner_type === 'seller' ? opts.defaultSellerThreshold : null);
      const state = item.archived ? 'out_of_stock' : stockState(available, threshold);
      out.changed.push({
        stockItemId: id,
        offerId: item.offer_id,
        ownerType: item.owner_type,
        sellerId: item.seller_id,
        productId: item.product_id,
        variantId: item.variant_id,
        available,
        reserved,
        previousAvailable: before.available,
        state,
        archived: item.archived,
        cause,
      });
      const cooled = !item.low_since || this.now.getTime() - item.low_since.getTime() >= opts.cooldownHours * 3_600_000;
      if (threshold !== null && !item.archived && available <= threshold && available < before.available && cooled) {
        this.items.set(id, await this.tx.update('stock_items', id, { low_since: this.now }));
        out.low.push({ stockItemId: id, offerId: item.offer_id, ownerType: item.owner_type, sellerId: item.seller_id, productId: item.product_id, variantId: item.variant_id, sku: item.sku, label: item.label, available, threshold });
      }
    }
    return out;
  }
}
