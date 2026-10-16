/**
 * Stock items: creation for offers and company SKUs, changes kept in step with offers and catalog, archive and
 * merge, and the stock reads other modules use.
 */
import { AppError } from '../../../kernel/errors/index.js';
import { inventoryError } from '../errors.js';
import type { EventPayload } from '../../../kernel/events/index.js';
import { isUuid, newId } from '../../../kernel/lib/ids.js';
import type * as common from '../../../spec/common.js';
import type { IncomingCue, MovementRef, StockItem, StockItemRef, StockQuantities } from '../../../spec/inventory.js';
import { addDays, availabilityLabel, GROUPS, FIELD, onHand, stockState, weightedAverage, zeroQty } from '../domain/rules.js';
import { effectiveThreshold, groupBy, incomingCue, isServiceItem, sellableAvailable, SYSTEM_ACTOR, unitCostOf } from '../mappers.js';
import type { Row } from '../ports.js';
import { DuplicateKeyError } from '../repository.js';
import { levelQty } from '../stock-tx.js';
import { DEFAULT_HOLD_REVIEW_DAYS, invalid, type Core } from './core.js';

/** Movements that put sold units back on the shelf (net of dispatches in getSalesRate) */
const RESTOCK_REASONS = ['return_restock', 'return_different_condition', 'returned_item_restocked'];

export class Items {
  constructor(private readonly core: Core) {}

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
    const same = await this.core.repo.items({ ownerType: input.ownerType, ...(sellerId ? { sellerId } : {}), skus: [sku], includeArchived: true });
    if (same[0]) {
      if (input.offerId && same[0].offer_id === input.offerId) return this.core.itemApi(same[0]);
      // a company SKU created by staff gets the offer that starts selling it
      if (input.ownerType === 'official' && input.offerId && !same[0].offer_id) return this.core.itemApi(await this.core.repo.update('stock_items', same[0].id, { offer_id: input.offerId, updated_at: this.core.now() }));
      throw inventoryError('SKU_TAKEN', `A stock item with SKU ${sku} already exists`, { sku, stockItemId: same[0].id });
    }
    if (input.offerId && input.ownerType === 'seller') {
      const forOffer = (await this.core.repo.items({ offerIds: [input.offerId], includeArchived: true }))[0];
      if (forOffer) return this.core.itemApi(forOffer);
    }

    const id = newId();
    const row = await this.core.stock('initial', async (st) => {
      const location = input.ownerType === 'seller' ? await this.core.sellerLocation(st.tx, sellerId!) : input.locationId ? await st.tx.get('locations', input.locationId) : await this.core.officialDefault(st.tx);
      if (!location || location.owner_type !== input.ownerType || (sellerId && location.seller_id !== sellerId) || !location.active) {
        throw invalid('locationId', input.ownerType === 'official' ? 'Add an active company stock location first' : 'Unknown stock location');
      }
      const now = st.now;
      const item = await st.tx.insertIfAbsent(
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
          currency: this.core.currency,
          primary_bin_code: null,
          low_since: null,
          archived: false,
          created_at: now,
          updated_at: now,
        },
      );
      if (!item) throw inventoryError('SKU_TAKEN', `A stock item with SKU ${sku} already exists`, { sku });
      await st.tx.ensureLevel(id, location.id, now);
      if (input.initialAvailable > 0) {
        await st.move(id, location.id, 'outside', 'available', input.initialAvailable, { reason: 'initial', ref: { kind: 'initial', id, label: 'Opening stock' }, actor: SYSTEM_ACTOR });
      }
      return item;
    });
    return this.core.itemApi((await this.core.repo.get('stock_items', row.id))!);
  }

  /** Sellable quantity summed over sellable locations */
  async getAvailability(stockItemIds: string[]): Promise<Record<string, { available: number; state: string; lowStockThreshold: number | null; nextIncoming: IncomingCue | null }>> {
    // every storefront quote asks this: levels, locations and expectations are read once and nothing else (no catalog)
    const rows = await this.core.repo.items({ ids: [...new Set(stockItemIds)], includeArchived: true });
    if (!rows.length) return {};
    const stock = await this.core.stockOf(rows);
    const out: Record<string, { available: number; state: string; lowStockThreshold: number | null; nextIncoming: IncomingCue | null }> = {};
    for (const row of rows) {
      const levels = stock.levels.get(row.id) ?? [];
      const sellable = sellableAvailable(row, levels, stock.locations);
      const threshold = effectiveThreshold(row, stock.defaultThreshold);
      const next = stock.expectations.get(row.id)?.find((e) => e.quantity_open > 0);
      // StockItem.state, lowStockThreshold and nextIncoming as toStockItem gives them
      out[row.id] = { available: row.archived ? 0 : sellable, state: row.archived ? 'out_of_stock' : stockState(sellable, threshold), lowStockThreshold: threshold, nextIncoming: next ? incomingCue(next) : null };
    }
    return out;
  }

  /**
   * Keeps a stock item in step with its offer or catalog record (variant change, catalog merge, SKU or condition
   * change). Quantities and history stay on the item. SKU_TAKEN when another item of the same owner has the SKU.
   * Publishes inventory.stock.changed (cause item_updated) so read models re-key.
   */
  async updateStockItem(stockItemId: string, patch: { productId?: string; variantId?: string; condition?: string; sku?: string; label?: string; offerId?: string }, actor: common.Actor): Promise<StockItem> {
    const before = await this.core.item(stockItemId);
    const next: Partial<Row<'stock_items'>> = {};
    for (const [field, column] of [
      ['productId', 'product_id'],
      ['variantId', 'variant_id'],
      ['offerId', 'offer_id'],
    ] as const) {
      const v = patch?.[field];
      if (v === undefined) continue;
      if (!isUuid(v)) throw invalid(field, `Not a valid ${field.replace('Id', '')} id`);
      if (v !== before[column]) next[column] = v;
    }
    for (const [field, column] of [
      ['condition', 'condition'],
      ['sku', 'sku'],
      ['label', 'label'],
    ] as const) {
      const v = patch?.[field];
      if (v === undefined) continue;
      const t = String(v ?? '').trim();
      if (!t) throw invalid(field, `Enter the ${field === 'sku' ? 'SKU' : field}`);
      if (t !== before[column]) next[column] = t;
    }
    if (!Object.keys(next).length) return this.core.itemApi(before);
    if (next.sku) {
      const taken = (await this.core.repo.items({ ownerType: before.owner_type as 'official' | 'seller', ...(before.seller_id ? { sellerId: before.seller_id } : {}), skus: [next.sku], includeArchived: true })).find((i) => i.id !== before.id);
      if (taken) throw inventoryError('SKU_TAKEN', `A stock item with SKU ${next.sku} already exists`, { sku: next.sku, stockItemId: taken.id });
    }
    try {
      await this.core.stock(
        'item_updated',
        async (st) => {
          await st.lock([before.id]);
          st.touch(before.id, await st.tx.update('stock_items', before.id, { ...next, updated_at: st.now }));
        },
        { actor },
      );
    } catch (err) {
      if (err instanceof DuplicateKeyError) throw inventoryError('SKU_TAKEN', `A stock item with SKU ${next.sku} already exists`, { sku: next.sku });
      throw err;
    }
    return this.core.itemApi(await this.core.item(before.id));
  }

  /** Archives or unarchives an item with its quantities kept; publishes inventory.stock.changed (cause archived or unarchived) */
  async setArchived(item: Row<'stock_items'>, archived: boolean, actor: common.Actor): Promise<Row<'stock_items'>> {
    if (item.archived === archived) return item;
    return this.core.stock(
      archived ? 'archived' : 'unarchived',
      async (st) => {
        await st.lock([item.id]);
        const locked = st.item(item.id);
        if (locked.archived === archived) return locked;
        const row = await st.tx.update('stock_items', item.id, { archived, updated_at: st.now, ...(archived ? {} : { low_since: null }) });
        st.touch(item.id, row);
        return row;
      },
      { actor },
    );
  }

  /** Reinstated offer: the archived item becomes active again with the quantities it kept. Publishes inventory.stock.changed (cause unarchived). */
  async unarchiveStockItem(stockItemId: string, actor: common.Actor): Promise<StockItem> {
    const item = await this.core.item(stockItemId);
    return this.core.itemApi(await this.setArchived(item, false, actor));
  }

  /**
   * Two items of the same owner describe the same thing: every quantity group moves to the target with merge
   * movements (held units keep their review dates), open reservation lines and incoming expectations move with
   * their units (still matched by orderItemId), the unit cost is averaged and the source is archived.
   */
  async mergeStockItems(fromStockItemId: string, intoStockItemId: string, reason: string, actor: common.Actor): Promise<StockItem> {
    const why = reason?.trim();
    if (!why) throw invalid('reason', 'Say why the stock items are merged');
    if (fromStockItemId === intoStockItemId) throw invalid('intoStockItemId', 'Choose another stock item to merge into');
    const from = await this.core.item(fromStockItemId);
    const into = isUuid(intoStockItemId) ? await this.core.repo.get('stock_items', intoStockItemId) : undefined;
    if (!into) throw invalid('intoStockItemId', 'Stock item not found');
    if (from.owner_type !== into.owner_type || (from.seller_id ?? null) !== (into.seller_id ?? null)) throw invalid('intoStockItemId', 'Both stock items must belong to the same owner');
    if (into.archived) throw inventoryError('STOCK_ITEM_ARCHIVED', `${into.sku} is archived; unarchive it first or merge into another item`, { stockItemId: into.id });
    if ((await this.core.repo.adjustmentsWhere({ itemIds: [from.id], states: ['requested', 'pending_review'] })).length) {
      throw new AppError('CONFLICT', `${from.sku} has adjustments waiting for review; decide or cancel them first`, { stockItemId: from.id });
    }
    const ref: MovementRef = { kind: 'merge', id: from.id, label: `Merged ${from.sku} into ${into.sku}` };
    const today = this.core.today();
    await this.core.stock(
      'merge',
      async (st) => {
        // lock order: reservations, their lines, then stock levels (as every reservation path does)
        const open = await st.tx.linesWhere({ itemIds: [from.id], states: ['held', 'allocated'] });
        for (const rid of [...new Set(open.map((l) => l.reservation_id))].sort()) await st.tx.get('reservations', rid, { forUpdate: true });
        const openLines = await st.tx.linesWhere({ itemIds: [from.id], states: ['held', 'allocated'] }, { forUpdate: true });
        await st.lock([from.id, into.id]);
        const src = st.item(from.id);
        const dst = st.item(into.id);
        const moved = st.total(from.id);
        const meta = { note: why, ref, actor };
        for (const level of st.levels(from.id)) {
          const q = levelQty(level);
          for (const g of GROUPS) {
            const n = q[FIELD[g]];
            if (n <= 0) continue;
            if (g !== 'damaged_held') {
              await st.move(from.id, level.location_id, g, 'outside', n, { ...meta, reason: 'merged_out' });
              await st.move(into.id, level.location_id, 'outside', g, n, { ...meta, reason: 'merged_in' });
              continue;
            }
            // held units move hold by hold, keeping their reason and review date
            let left = n;
            for (const h of await st.tx.openHeld(from.id, level.location_id)) {
              const take = Math.min(left, h.quantity);
              if (take <= 0) continue;
              await st.move(from.id, level.location_id, 'damaged_held', 'outside', take, { ...meta, reason: 'merged_out' });
              await st.move(into.id, level.location_id, 'outside', 'damaged_held', take, { ...meta, reason: 'merged_in', hold: { reasonCode: h.reason_code, reviewDate: h.review_date, reason: h.reason, sourceRef: h.source_ref } });
              left -= take;
            }
            if (left > 0) {
              await st.move(from.id, level.location_id, 'damaged_held', 'outside', left, { ...meta, reason: 'merged_out' });
              await st.move(into.id, level.location_id, 'outside', 'damaged_held', left, { ...meta, reason: 'merged_in', hold: { reasonCode: 'merged', reviewDate: addDays(today, DEFAULT_HOLD_REVIEW_DAYS), reason: why } });
            }
          }
        }
        // open reservation lines and incoming expectations follow their units
        for (const l of openLines) await st.tx.update('reservation_lines', l.id, { stock_item_id: into.id });
        const theirs = await st.tx.expectations({ itemIds: [into.id], openOnly: true }, { forUpdate: true });
        for (const e of await st.tx.expectations({ itemIds: [from.id], openOnly: true }, { forUpdate: true })) {
          const twin = theirs.find((x) => x.source_kind === e.source_kind && x.source_id === e.source_id && x.location_id === e.location_id);
          if (twin) {
            await st.tx.update('incoming_expectations', twin.id, { quantity_open: twin.quantity_open + e.quantity_open });
            await st.tx.update('incoming_expectations', e.id, { quantity_open: 0 });
          } else await st.tx.update('incoming_expectations', e.id, { stock_item_id: into.id });
        }
        // the target's buying cost becomes the weighted average of both
        const cost = src.unit_cost_amount === null ? null : Number(src.unit_cost_amount);
        const units = onHand(moved);
        const patch: Partial<Row<'stock_items'>> = { updated_at: st.now };
        if (cost !== null && units > 0) patch.unit_cost_amount = weightedAverage(dst.unit_cost_amount === null ? null : Number(dst.unit_cost_amount), onHand(st.total(into.id)) - units, cost, units);
        st.touch(into.id, await st.tx.update('stock_items', into.id, patch));
        st.touch(from.id, await st.tx.update('stock_items', from.id, { archived: true, updated_at: st.now }));
      },
      { actor },
    );
    return this.core.itemApi(await this.core.item(into.id));
  }

  /** Units that left stock to customer orders (dispatched, net of restocked returns) over the last days (default 30) */
  async getSalesRate(stockItemIds: string[], days = 30): Promise<Record<string, { unitsSold: number; days: number; avgDailySales: number }>> {
    const window = Number.isInteger(days) && days >= 1 && days <= 365 ? days : 30;
    const ids = [...new Set((stockItemIds ?? []).filter((id) => isUuid(id)))];
    const since = new Date(this.core.now().getTime() - window * 86_400_000);
    const [sold, restocked] = await Promise.all([this.core.repo.dispatchedSince(ids, since), this.core.repo.unitsByReasonSince(ids, since, RESTOCK_REASONS)]);
    const out: Record<string, { unitsSold: number; days: number; avgDailySales: number }> = {};
    for (const id of ids) {
      const unitsSold = Math.max(0, (sold.get(id) ?? 0) - (restocked.get(id) ?? 0));
      out[id] = { unitsSold, days: window, avgDailySales: Math.round((unitsSold / window) * 100) / 100 };
    }
    return out;
  }

  /** Weighted average buying cost of company stock */
  async getUnitCost(stockItemId: string): Promise<common.Money | null> {
    const item = await this.core.repo.get('stock_items', stockItemId);
    return item ? unitCostOf(item) : null;
  }

  /** Resolve SKUs from scans and files */
  async findBySku(ownerType: 'official' | 'seller', skus: string[], sellerId?: string): Promise<StockItem[]> {
    if (!skus?.length) return [];
    return this.core.itemsApi(await this.core.repo.items({ ownerType, skus: [...new Set(skus.map((s) => s.trim()))], ...(sellerId ? { sellerId } : {}) }));
  }

  /**
   * Stock items by id with SKU, label, owner and main location (unknown ids are left out, input order kept).
   * Main location: the seller's virtual location (a seller item Fulfilled by Marketly: its service location); for
   * company stock the location holding most of the item's units (sellable first), or the default company location
   * when it has none.
   */
  async getStockItems(stockItemIds: string[]): Promise<StockItemRef[]> {
    const ids = [...new Set((stockItemIds ?? []).filter((id) => isUuid(id)))];
    if (!ids.length) return [];
    const rows = await this.core.repo.items({ ids, includeArchived: true });
    if (!rows.length) return [];
    const levels = await this.core.repo.levels(rows.map((r) => r.id));
    const sellerIds = [...new Set(rows.map((r) => (r.owner_type === 'seller' ? r.seller_id : null)).filter((x): x is string => Boolean(x)))];
    const serviceIds = rows.flatMap((r) => (isServiceItem(r) ? [r.service_location_id!] : []));
    const [locationRows, sellerLocationRows, fallback] = await Promise.all([
      this.core.repo.locations({ ids: [...new Set([...levels.map((l) => l.location_id), ...serviceIds])] }),
      sellerIds.length ? this.core.repo.locations({ ownerType: 'seller', sellerIds }) : Promise.resolve([]),
      rows.some((r) => r.owner_type === 'official') ? this.core.officialDefault() : Promise.resolve(undefined),
    ]);
    const locations = new Map(locationRows.map((l) => [l.id, l]));
    // each seller's first location in the repository's order (default first, then code)
    const sellerLocation = new Map<string, Row<'locations'>>();
    for (const l of sellerLocationRows) if (l.seller_id && !sellerLocation.has(l.seller_id)) sellerLocation.set(l.seller_id, l);
    const levelsOf = groupBy(levels, (l) => l.stock_item_id);
    // variant GTINs for warehouse scans (null when catalog is off or the variant has none)
    const gtins = new Map<string, string | null>();
    const catalog = this.core.ctx.tryUse('catalog');
    if (catalog) {
      try {
        for (const v of await catalog.getVariants([...new Set(rows.map((r) => r.variant_id))])) gtins.set(v.id, v.gtin ?? null);
      } catch (err) {
        this.core.ctx.log.warn({ err }, 'inventory: variant GTINs unavailable');
      }
    }
    const units = (l: Row<'stock_levels'>) => l.available + l.reserved + l.incoming + l.damaged_held + l.returned;
    const mainOf = (r: Row<'stock_items'>): Row<'locations'> | undefined => {
      if (r.owner_type === 'seller') {
        if (isServiceItem(r) && locations.has(r.service_location_id!)) return locations.get(r.service_location_id!);
        const held = (levelsOf.get(r.id) ?? []).map((l) => locations.get(l.location_id)).find((l) => l?.kind === 'seller_virtual');
        return (r.seller_id ? sellerLocation.get(r.seller_id) : undefined) ?? held;
      }
      const best = (levelsOf.get(r.id) ?? [])
        .filter((l) => units(l) > 0 && locations.get(l.location_id)?.owner_type === 'official')
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
          gtin: gtins.get(r.variant_id) ?? null,
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
    const rows = (await this.core.repo.items({ offerIds: [...new Set(offerIds)], includeArchived: true })).filter((r) => !viewer.sellerId || (r.owner_type === 'seller' && r.seller_id === viewer.sellerId));
    // a live item wins over an archived one for the same offer
    rows.sort((a, b) => Number(a.archived) - Number(b.archived));
    const api = await this.core.itemsApi(rows);
    const out: Record<string, StockItem | null> = Object.fromEntries(offerIds.map((id) => [id, null]));
    rows.forEach((r, i) => {
      if (r.offer_id && !out[r.offer_id]) out[r.offer_id] = api[i]!;
    });
    return out;
  }

  /** Stock items per variant: the seller's own items, or (staff) company and seller items, never summed */
  async listStockForVariants(variantIds: string[], viewer: { sellerId?: string }): Promise<Record<string, StockItem[]>> {
    const rows = await this.core.repo.items({ variantIds: [...new Set(variantIds)], ...(viewer.sellerId ? { ownerType: 'seller' as const, sellerId: viewer.sellerId } : {}) });
    const api = await this.core.itemsApi(rows);
    const out: Record<string, StockItem[]> = Object.fromEntries(variantIds.map((id) => [id, []]));
    api.forEach((s) => out[s.variantId]?.push(s));
    return out;
  }

  /** Quantities of the items at one location, keyed by stock item id (zeros where an item has no level row there) */
  async getLevels(stockItemIds: string[], locationId: string): Promise<Record<string, StockQuantities>> {
    const ids = [...new Set((stockItemIds ?? []).filter((id) => isUuid(id)))];
    const out: Record<string, StockQuantities> = Object.fromEntries(ids.map((id) => [id, zeroQty()]));
    if (!ids.length || !isUuid(locationId)) return out;
    for (const l of await this.core.repo.levels(ids)) if (l.location_id === locationId) out[l.stock_item_id] = levelQty(l);
    return out;
  }

  /** warehouse.bin.assigned: Update the stock item's primary bin code shown in stock lists */
  async onBinAssignedFromWarehouse(event: EventPayload<'warehouse.bin.assigned'>): Promise<void> {
    if (!event.primary) return;
    const item = await this.core.repo.get('stock_items', event.stockItemId);
    if (!item) {
      this.core.ctx.log.info({ stockItemId: event.stockItemId }, 'inventory: bin assigned to an unknown stock item, ignored');
      return;
    }
    if (item.primary_bin_code !== event.binCode) await this.core.repo.update('stock_items', item.id, { primary_bin_code: event.binCode });
  }

  /**
   * offers.offer.status_changed: Archive a seller stock item when its offer is removed (reserved units stay with their
   * orders); unarchive it when the offer leaves removed (reinstated), so the offer shows its kept quantity again.
   */
  async onOfferStatusChangedFromOffers(event: EventPayload<'offers.offer.status_changed'>): Promise<void> {
    if (event.ownerType !== 'seller') return;
    const removed = event.to === 'removed';
    const reinstated = event.from === 'removed' && event.to !== 'removed';
    if (!removed && !reinstated) return;
    const items = (await this.core.repo.items({ offerIds: [event.offerId], includeArchived: true })).filter((i) => i.owner_type === 'seller');
    const named = event.stockItemId && isUuid(event.stockItemId) ? items.filter((i) => i.id === event.stockItemId) : [];
    const targets = named.length ? named : items;
    if (!targets.length) {
      this.core.ctx.log.debug({ offerId: event.offerId }, 'inventory: offer status change for an offer without a stock item');
      return;
    }
    const actor: common.Actor = { kind: 'system', id: 'offers', name: 'Offers' };
    for (const item of targets) await this.setArchived(item, removed, actor);
  }

  /**
   * catalog.product.merged: company stock items of the merged product follow it to the kept product and the mapped
   * variant (newVariantId or intoVariantId, else the kept variant with the same options) through updateStockItem.
   * When the kept variant already has a company item in the same condition, the pair is raised for the Inventory
   * Manager to merge (POST /stock-items/{id}/merge). Seller items follow their offers (offers re-keys them).
   * Idempotent: a second delivery finds no item left on the merged product.
   */
  async onProductMergedFromCatalog(event: EventPayload<'catalog.product.merged'>): Promise<void> {
    if (event.duplicateProductId === event.keptProductId) return;
    const items = await this.core.repo.items({ ownerType: 'official', productIds: [event.duplicateProductId], includeArchived: true });
    if (!items.length) return;
    const catalog = this.core.ctx.tryUse('catalog');
    let kept: { id: string; options: Record<string, string> }[] = [];
    let options = new Map<string, Record<string, string>>();
    if (catalog && !event.newVariantId && !event.intoVariantId) {
      try {
        kept = (await catalog.getProduct(event.keptProductId))?.variants ?? [];
        options = new Map((await catalog.getVariants([...new Set(items.map((i) => i.variant_id))])).map((v) => [v.id, v.options]));
      } catch (err) {
        this.core.ctx.log.warn({ err, productId: event.keptProductId }, 'inventory: kept product variants unavailable; stock items keep their variant');
      }
    }
    const same = (a: Record<string, string> | undefined, b: Record<string, string>) => !!a && Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([k, v]) => b[k] === v);
    const actor: common.Actor = { kind: 'system', id: 'catalog', name: 'Catalog merge' };
    for (const item of items) {
      const variantId = event.intoVariantId ?? event.newVariantId ?? kept.find((v) => same(options.get(item.variant_id), v.options))?.id ?? item.variant_id;
      const updated = await this.updateStockItem(item.id, { productId: event.keptProductId, variantId }, actor);
      if (item.archived) continue;
      const twin = (await this.core.repo.items({ ownerType: 'official', variantIds: [variantId] })).find((i) => i.id !== item.id && i.condition === item.condition);
      if (twin) {
        await this.core.raise({
          queueKey: 'inventory.merge_candidates',
          kind: 'manual_task',
          title: `Merge ${updated.sku} into ${twin.sku}`,
          summary: `Products were merged in the catalog, so ${updated.sku} and ${twin.sku} now hold the same variant in the same condition. Merge them on the stock item page.`,
          subject: { type: 'stock_item', id: item.id, ref: updated.sku },
          priority: 'normal',
          dedupeKey: `inventory.merge_candidate:${item.id}:${twin.id}`,
        });
      }
    }
  }

  /** sellers.seller.closed: Archive the seller's stock items */
  async onSellerClosedFromSellers(event: EventPayload<'sellers.seller.closed'>): Promise<void> {
    await this.core.repo.archiveItems({ sellerId: event.sellerId }, this.core.now());
  }
}
