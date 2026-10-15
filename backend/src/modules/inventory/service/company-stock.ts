/** Admin Center stock: company stock items, the movement ledger and low stock. */
import type { PageRequest } from '../../../kernel/lib/pagination.js';
import type * as common from '../../../spec/common.js';
import type { LowStockRow, Movement, StockItem, StockItemDetail, StockItemInput } from '../../../spec/inventory.js';
import type { ItemListFilter, Row } from '../ports.js';
import { invalid, type StaffBy, type Core } from './core.js';
import type { Items } from './items.js';

export class CompanyStock {
  constructor(private readonly core: Core, private readonly items: Items) {}

  adminListFilter(q: { q?: string; ownerType?: 'official' | 'seller'; sellerId?: string; filter?: string; locationId?: string; zone?: string }, def: number): ItemListFilter {
    const ownerType = q.ownerType ?? (q.sellerId ? 'seller' : 'official');
    return {
      ownerType,
      ...(q.sellerId ? { sellerId: q.sellerId } : {}),
      ...(q.q ? { q: q.q } : {}),
      ...(q.filter ? { filter: q.filter } : {}),
      ...(q.locationId ? { locationId: q.locationId } : {}),
      ...(q.zone ? { zone: q.zone } : {}),
      defaultThreshold: def,
    };
  }

  async listStockItems(query: { q?: string; ownerType?: 'official' | 'seller'; sellerId?: string; filter?: string; locationId?: string; zone?: string }, page: PageRequest): Promise<common.Page<StockItem>> {
    const filter = this.adminListFilter(query, await this.core.defaultThreshold());
    const p = await this.core.repo.pageItemIds(filter, page);
    return { ...p, items: await this.core.itemsApi(await this.core.rowsInOrder(p.items.map((r) => r.id)), { locationId: query.locationId }) };
  }

  async getStockItem(id: string): Promise<StockItemDetail> {
    return this.core.detail(await this.core.item(id));
  }

  async createStockItemAsStaff(body: StockItemInput, by: StaffBy): Promise<StockItem> {
    if (body.lowStockThreshold !== undefined && body.lowStockThreshold !== null && body.lowStockThreshold < 0) throw invalid('lowStockThreshold', 'The reorder point must be 0 or more');
    if (body.reorderQuantity !== undefined && body.reorderQuantity !== null && body.reorderQuantity < 0) throw invalid('reorderQuantity', 'The reorder quantity must be 0 or more');
    if (!body.sku?.trim()) throw invalid('sku', 'Enter the SKU');
    if (!body.condition?.trim()) throw invalid('condition', 'Enter the condition');
    const location = await this.core.repo.get('locations', body.locationId);
    if (!location || location.owner_type !== 'official' || !location.active) throw invalid('locationId', 'Choose an active company stock location');
    let label = body.sku.trim();
    const catalog = this.core.ctx.tryUse('catalog');
    if (catalog) {
      const product = await catalog.getProduct(body.productId);
      if (!product) throw invalid('productId', 'Product not found in the catalog');
      const variant = product.variants.find((v) => v.id === body.variantId);
      if (!variant) throw invalid('variantId', 'This variant is not part of the product');
      const options = Object.values(variant.options ?? {}).join(' ');
      label = options ? `${product.title}, ${options}` : product.title;
    }
    const created = await this.items.createStockItem({ ownerType: 'official', sku: body.sku, productId: body.productId, variantId: body.variantId, condition: body.condition.trim(), label, initialAvailable: 0, ...(body.lowStockThreshold != null ? { lowStockThreshold: body.lowStockThreshold } : {}), locationId: location.id });
    let row = await this.core.item(created.id);
    if (body.reorderQuantity != null) row = await this.core.repo.update('stock_items', row.id, { reorder_quantity: body.reorderQuantity });
    const item = await this.core.itemApi(row);
    await this.core.audit({ action: 'inventory.stock_item.create', actionLabel: 'Created company stock item', category: 'inventory', target: { type: 'stock_item', id: item.id, ref: item.sku, label: item.label, screen: 'ops/inventory' }, after: item }, by);
    return item;
  }

  /** PATCH /stock-items/{id}: reorder point, reorder quantity, archive; archived false unarchives (same as unarchiveStockItem) */
  async updateStockItemAsStaff(id: string, body: { lowStockThreshold?: number | null; reorderQuantity?: number | null; archived?: boolean | null }, by: StaffBy): Promise<StockItem> {
    const before = await this.core.officialItem(id);
    if (body.lowStockThreshold != null && body.lowStockThreshold < 0) throw invalid('lowStockThreshold', 'The reorder point must be 0 or more');
    if (body.reorderQuantity != null && body.reorderQuantity < 0) throw invalid('reorderQuantity', 'The reorder quantity must be 0 or more');
    const patch: Partial<Row<'stock_items'>> = {};
    if (body.lowStockThreshold !== undefined) patch.low_stock_threshold = body.lowStockThreshold;
    if (body.reorderQuantity !== undefined) patch.reorder_quantity = body.reorderQuantity;
    const archive = body.archived !== undefined && body.archived !== null && body.archived !== before.archived ? body.archived : null;
    if (!Object.keys(patch).length && archive === null) return this.core.itemApi(before);
    const beforeApi = await this.core.itemApi(before);
    let row = Object.keys(patch).length ? await this.core.repo.update('stock_items', id, { ...patch, updated_at: this.core.now() }) : before;
    if (archive !== null) row = await this.items.setArchived(row, archive, by.actor);
    const after = await this.core.itemApi(row);
    const action = archive === true ? 'archive' : archive === false ? 'unarchive' : 'update';
    const label = { archive: 'Archived company SKU', unarchive: 'Unarchived company SKU', update: 'Changed reorder point' }[action];
    await this.core.audit({ action: `inventory.stock_item.${action}`, actionLabel: label, category: 'inventory', target: { type: 'stock_item', id, ref: after.sku, label: after.label, screen: 'ops/inventory' }, before: beforeApi, after }, by);
    return after;
  }

  /** POST /stock-items/{id}/merge: merge a company SKU into another one (mergeStockItems), audited */
  async mergeStockItemAsStaff(id: string, body: { intoStockItemId: string; reason: string }, by: StaffBy): Promise<StockItem> {
    const from = await this.core.officialItem(id);
    const beforeApi = await this.core.itemApi(from);
    const after = await this.items.mergeStockItems(from.id, body.intoStockItemId, body.reason, by.actor);
    await this.core.audit(
      {
        action: 'inventory.stock_item.merge',
        actionLabel: 'Merged company SKU into another',
        category: 'inventory',
        target: { type: 'stock_item', id: after.id, ref: after.sku, label: after.label, screen: 'ops/inventory' },
        relatedTargets: [{ type: 'stock_item', id: from.id, ref: from.sku, label: from.label }],
        reason: body.reason?.trim() || null,
        before: beforeApi,
        after,
      },
      by,
    );
    return after;
  }

  async listMovements(query: { stockItemId?: string; sku?: string; reasonCode?: string; referenceKind?: string; from?: string; to?: string }, page: PageRequest): Promise<common.Page<Movement>> {
    const p = await this.core.repo.pageMovements({ ...(query.stockItemId ? { stockItemIds: [query.stockItemId] } : {}), sku: query.sku, reasonCode: query.reasonCode, referenceKind: query.referenceKind, from: query.from, to: query.to, timeZone: this.core.ctx.config.market.timeZone }, page);
    return { ...p, items: await this.core.movementsApi(p.items) };
  }

  async listLowStock(query: { ownerType?: 'official' | 'seller'; locationId?: string }, page: PageRequest): Promise<common.Page<LowStockRow>> {
    const def = await this.core.defaultThreshold();
    const p = await this.core.repo.pageItemIds({ ownerType: query.ownerType ?? 'official', filter: 'low_or_out', ...(query.locationId ? { locationId: query.locationId } : {}), defaultThreshold: def }, page);
    const items = await this.core.itemsApi(await this.core.rowsInOrder(p.items.map((r) => r.id)));
    const sold = await this.core.repo.dispatchedSince(items.map((i) => i.id), new Date(this.core.now().getTime() - 30 * 86_400_000));
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
}
