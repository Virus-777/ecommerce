/** Seller Center stock: a seller's own stock items, their quantities, movements and bulk quantity updates. */
import { isAppError } from '../../../kernel/errors/index.js';
import { inventoryError } from '../errors.js';
import type { PageRequest } from '../../../kernel/lib/pagination.js';
import type * as common from '../../../spec/common.js';
import type {
  AdjustmentResult,
  Movement,
  MovementRef,
  SellerAdjustmentItem,
  SellerAdjustmentRequest,
  SellerStockRow,
  SellerStockSummary,
  StockItem,
  StockItemDetail,
} from '../../../spec/inventory.js';
import { reasonLabel, splitLabel } from '../domain/rules.js';
import { isServiceItem, toMovement } from '../mappers.js';
import type { ItemListFilter, Row } from '../ports.js';
import { BATCH, invalid, type By, type SellerBy, type Core } from './core.js';

export class SellerStock {
  constructor(private readonly core: Core) {}

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

  /** In stock, low, out of stock and reserved totals for the seller dashboard */
  async getSellerStockSummary(sellerId: string): Promise<SellerStockSummary> {
    const items = await this.core.itemsApi(await this.core.repo.items({ ownerType: 'seller', sellerId }));
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

  async sellerListFilter(sellerId: string, q: { q?: string; state?: ItemListFilter['state']; categoryId?: string }): Promise<ItemListFilter> {
    const filter: ItemListFilter = { ownerType: 'seller', sellerId, defaultSellerThreshold: await this.core.defaultThreshold(), ...(q.q ? { q: q.q } : {}), ...(q.state ? { state: q.state } : {}) };
    if (q.categoryId) filter.productIds = await this.#productsInCategory((await this.core.repo.items({ ownerType: 'seller', sellerId })).map((i) => i.product_id), q.categoryId);
    return filter;
  }

  /** Products of a category, through the catalog (without catalog the filter cannot apply and is ignored) */
  async #productsInCategory(productIds: string[], categoryId: string): Promise<string[] | undefined> {
    const catalog = this.core.ctx.tryUse('catalog');
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
    const rows = await this.core.movementsApi(await this.core.repo.recentMovements(itemIds, limit));
    const out = new Map<string, Movement[]>(itemIds.map((id) => [id, []]));
    for (const m of rows) out.get(m.stockItemId)?.push(m);
    return out;
  }

  async #lastChanges(itemIds: string[]): Promise<Map<string, string>> {
    const rows = await this.core.repo.recentMovements(itemIds, 1);
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: this.core.ctx.config.market.timeZone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    return new Map(rows.map((m) => [m.stock_item_id, `${fmt.format(m.at).replace(/,(?=[^,]*$)/, ',')} · ${m.actor_name ?? (m.actor_kind === 'system' ? 'System' : m.actor_kind === 'seller' ? 'Seller' : 'Staff')}`]));
  }

  async listOwnStock(sellerId: string, query: { q?: string; state?: 'in_stock' | 'low_stock' | 'out_of_stock'; categoryId?: string }, page: PageRequest): Promise<common.Page<SellerStockRow>> {
    const p = await this.core.repo.pageItemIds(await this.sellerListFilter(sellerId, query), page);
    const items = await this.core.itemsApi(await this.core.rowsInOrder(p.items.map((r) => r.id)));
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
          // Fulfilled by Marketly: available and reserved are 'At Marketly'; the row is read-only (SERVICE_MANAGED)
          fulfilledByMarketly: !!i.serviceLocationId,
          ownLocationAvailable: i.serviceLocationId ? (i.ownLocationQuantities?.available ?? 0) : null,
          updatedAt: i.updatedAt,
        };
      }),
    };
  }

  async getOwnStockItem(sellerId: string, id: string): Promise<StockItemDetail> {
    return this.core.detail(await this.core.ownItem(sellerId, id));
  }

  /** Sets a seller item's Available quantity (Reserved untouched) with one ledger row */
  async #setSellerAvailable(
    sellerId: string,
    itemId: string,
    newAvailable: number,
    o: { reason: string; note: string | null; ref?: MovementRef; by: By; allowNoChange?: boolean },
  ): Promise<Row<'stock_movements'> | null> {
    if (!Number.isInteger(newAvailable) || newAvailable < 0) throw invalid('newAvailable', 'Available must be a whole number, 0 or more');
    const item = await this.core.ownItem(sellerId, itemId);
    if (isServiceItem(item)) throw inventoryError('SERVICE_MANAGED', undefined, { stockItemId: item.id });
    if (item.archived) throw inventoryError('STOCK_ITEM_ARCHIVED', 'This stock item is archived because its offer was removed');
    const result = await this.core.stock(
      'adjustment',
      async (st) => {
        await st.lock([item.id]);
        if (isServiceItem(st.item(item.id))) throw inventoryError('SERVICE_MANAGED', undefined, { stockItemId: item.id });
        // always the seller's own location (units the item may still have in a Marketly warehouse are not the seller's to edit)
        const location = (await this.core.sellerLocation(st.tx, sellerId)).id;
        const current = st.qty(item.id, location).available;
        const delta = newAvailable - current;
        if (delta === 0) {
          if (o.allowNoChange) return null;
          throw invalid('newAvailable', `Available is already ${current}`);
        }
        return st.move(item.id, location, delta > 0 ? 'outside' : 'available', delta > 0 ? 'available' : 'outside', Math.abs(delta), { reason: o.reason, note: o.note, ref: o.ref ?? { kind: 'adjustment', id: item.id, label: reasonLabel(o.reason) }, actor: o.by.actor });
      },
      this.core.meta(o.by),
    );
    if (result) {
      this.core.ctx.events.publish(
        'inventory.adjustment.recorded',
        { adjustmentId: null, movementId: result.id, stockItemId: item.id, locationId: result.location_id, ownerType: item.owner_type, sellerId: item.seller_id, serviceManaged: false, fromGroup: result.from_group, toGroup: result.to_group, quantity: result.quantity, reasonCode: result.reason_code, actor: o.by.actor },
        this.core.meta(o.by),
      );
    }
    return result;
  }

  async adjustOwnStock(id: string, body: SellerAdjustmentRequest, by: SellerBy): Promise<Movement> {
    const m = await this.#setSellerAvailable(by.sellerId, id, body.newAvailable, { reason: body.reasonCode, note: body.note ?? null, by });
    return toMovement(m!, (await this.core.item(id)).sku);
  }

  async batchAdjustOwnStock(body: { items: SellerAdjustmentItem[]; note?: string | null }, by: SellerBy): Promise<{ results: AdjustmentResult[] }> {
    if (!body.items?.length) throw invalid('items', 'Nothing to save');
    if (body.items.length > BATCH) throw invalid('items', `Save at most ${BATCH} rows at once`);
    const results: AdjustmentResult[] = [];
    for (const it of body.items) {
      try {
        const m = await this.#setSellerAvailable(by.sellerId, it.stockItemId, it.newAvailable, { reason: it.reasonCode, note: body.note ?? null, by, allowNoChange: true });
        results.push({ stockItemId: it.stockItemId, ok: true, movement: m ? toMovement(m, (await this.core.item(it.stockItemId)).sku) : null, error: null });
      } catch (err) {
        if (!isAppError(err) || err.status >= 500) throw err;
        results.push({ stockItemId: it.stockItemId, ok: false, movement: null, error: { code: err.code, message: err.message, ...(err.details === undefined ? {} : { details: err.details }) } });
      }
    }
    return { results };
  }

  async updateOwnStockItem(sellerId: string, id: string, body: { lowStockThreshold?: number | null }): Promise<StockItem> {
    const item = await this.core.ownItem(sellerId, id);
    if (body.lowStockThreshold !== undefined && body.lowStockThreshold !== null && body.lowStockThreshold < 0) throw invalid('lowStockThreshold', 'The low-stock alert must be 0 or more');
    if (body.lowStockThreshold === undefined) return this.core.itemApi(item);
    return this.core.itemApi(await this.core.repo.update('stock_items', id, { low_stock_threshold: body.lowStockThreshold, updated_at: this.core.now() }));
  }

  async listOwnMovements(sellerId: string, query: { stockItemId?: string; reasonCode?: string; from?: string; to?: string }, page: PageRequest): Promise<common.Page<Movement>> {
    const p = await this.core.repo.pageMovements({ ownerType: 'seller', sellerId, ...(query.stockItemId ? { stockItemIds: [query.stockItemId] } : {}), reasonCode: query.reasonCode, from: query.from, to: query.to, timeZone: this.core.ctx.config.market.timeZone }, page);
    return { ...p, items: await this.core.movementsApi(p.items) };
  }
}
