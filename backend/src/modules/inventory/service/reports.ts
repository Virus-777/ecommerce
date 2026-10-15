/** Stock summaries, export datasets, the low-stock digest and the valuation snapshot. */
import { AppError, isNotImplemented } from '../../../kernel/errors/index.js';
import { money } from '../../../kernel/lib/money.js';
import type * as identity from '../../../spec/identity.js';
import type { LowStockDigestItem, StockSummary } from '../../../spec/inventory.js';
import type * as reports from '../../../spec/reports.js';
import { GROUP_INFO, GROUPS, FIELD, splitLabel } from '../domain/rules.js';
import { effectiveThreshold, SYSTEM_ACTOR } from '../mappers.js';
import type { ItemListFilter } from '../ports.js';
import { BATCH, invalid, notFound, type SellerBy, type Core } from './core.js';
import type { SellerStock } from './seller-stock.js';
import type { CompanyStock } from './company-stock.js';

const SELLER_DATASET = 'inventory.seller.stock';

const ADMIN_DATASET = 'inventory.admin.stock';

const EXPORT_PAGE = 500;

const DIGEST_ITEMS = 50;

export class Reports {
  constructor(private readonly core: Core, private readonly sellerStock: SellerStock, private readonly companyStock: CompanyStock) {}

  #datasetsRegistered?: Promise<void>;

  /** Official Store units and value at cost per stock group with low and out-of-stock counts */
  async getStockSummary(locationId?: string): Promise<StockSummary> {
    let rows = await this.core.repo.items({ ownerType: 'official' });
    if (locationId) {
      const here = new Set((await this.core.repo.levelTotals({ ownerType: 'official', locationId })).map((l) => l.stock_item_id));
      rows = rows.filter((r) => here.has(r.id));
    }
    const scoped = await this.core.itemsApi(rows, { locationId });
    const groups = GROUPS.map((g) => {
      const units = scoped.reduce((n, i) => n + i.quantities[FIELD[g]], 0);
      const value = scoped.reduce((n, i) => n + (i.unitCost ? i.unitCost.amount * i.quantities[FIELD[g]] : 0), 0);
      return { group: g, label: GROUP_INFO[g].label, meaning: GROUP_INFO[g].meaning, units, valueAtCost: money(value, this.core.currency) };
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
      const filter = await this.sellerStock.sellerListFilter(principal.sellerId, { q: f.q as string | undefined, state: f.state as ItemListFilter['state'], categoryId: f.categoryId as string | undefined });
      const pageIds = await this.core.repo.itemIds({ ...filter, ...(ids ? { ids } : {}) }, EXPORT_PAGE + 1, offset);
      const items = await this.core.itemsApi(await this.core.rowsInOrder(pageIds.slice(0, EXPORT_PAGE)));
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
      const filter = this.companyStock.adminListFilter({ q: f.q as string, ownerType: f.ownerType as 'official' | 'seller', sellerId: f.sellerId as string, filter: f.filter as string, locationId: f.locationId as string, zone: f.zone as string }, await this.core.defaultThreshold());
      const pageIds = await this.core.repo.itemIds({ ...filter, ...(ids ? { ids } : {}) }, EXPORT_PAGE + 1, offset);
      const items = await this.core.itemsApi(await this.core.rowsInOrder(pageIds.slice(0, EXPORT_PAGE)), { locationId: filter.locationId });
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

  /** Registers the export datasets with reports (once; reports may not be built yet) */
  async registerDatasets(): Promise<void> {
    const api = this.core.ctx.tryUse('reports');
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

  async exportOwnStock(body: { filters?: unknown; stockItemIds?: string[] | null; format?: 'csv' | 'xlsx' | null }, by: SellerBy): Promise<reports.ExportJob> {
    const reportsApi = this.core.ctx.tryUse('reports');
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
      const own = await this.core.repo.items({ ownerType: 'seller', sellerId: by.sellerId, ids: body.stockItemIds, includeArchived: true });
      if (own.length !== new Set(body.stockItemIds).size) throw invalid('stockItemIds', 'Some selected rows are not in your stock list');
      filters.stockItemIds = [...new Set(body.stockItemIds)];
    }
    await this.registerDatasets();
    const job = await reportsApi.requestExport({ dataset: SELLER_DATASET, filters, format: body.format ?? 'csv', principal: by.principal, sellerId: by.sellerId });
    await this.core.audit(
      {
        action: 'inventory.stock.export',
        actionLabel: 'Exported stock list',
        category: 'inventory',
        target: { type: 'export', id: job.id, ref: job.ref, label: 'Stock export', sellerId: by.sellerId, screen: 'seller/inventory' },
        after: { filters, format: job.format },
        visibleToSeller: true,
      },
      by,
    );
    return job;
  }

  async getOwnStockExport(id: string, by: SellerBy): Promise<reports.ExportJob> {
    const reportsApi = this.core.ctx.tryUse('reports');
    if (!reportsApi) throw notFound('Export');
    const job = await reportsApi.getExport(id, by.principal);
    if (!job || job.dataset !== SELLER_DATASET || (job.sellerId && job.sellerId !== by.sellerId)) throw notFound('Export');
    if (job.requestedBy?.id && by.principal.accountId && job.requestedBy.id !== by.principal.accountId) throw new AppError('FORBIDDEN', 'Only the member who requested this export can download it');
    return job;
  }

  /**
   * Job inventory.low-stock-digest (daily 07:00 market time): one inventory.stock.low_digest per seller with low or
   * out-of-stock items and one for the Official Store (notifications emails it); nothing when there is nothing to report.
   */
  async lowStockDigest(): Promise<{ owners: number; items: number }> {
    const def = await this.core.defaultThreshold();
    const date = this.core.today();
    type Entry = { item: LowStockDigestItem; ratio: number };
    const owners = new Map<string, { ownerType: 'official' | 'seller'; sellerId: string | null; entries: Entry[]; low: number; out: number }>();
    let count = 0;
    for (let offset = 0; ; offset += BATCH) {
      const ids = await this.core.repo.itemIds({ filter: 'low_or_out', defaultThreshold: def }, BATCH, offset);
      const rows = await this.core.rowsInOrder(ids);
      const items = await this.core.itemsApi(rows);
      for (const [i, row] of rows.entries()) {
        if (row.archived) continue;
        const api = items[i]!;
        const threshold = effectiveThreshold(row, def);
        const available = api.quantities.available;
        const state = available <= 0 ? 'out_of_stock' : threshold !== null && available <= threshold ? 'low_stock' : null;
        if (!state) continue;
        const key = row.seller_id ?? 'official';
        const o = owners.get(key) ?? { ownerType: row.owner_type as 'official' | 'seller', sellerId: row.seller_id, entries: [], low: 0, out: 0 };
        if (state === 'out_of_stock') o.out++;
        else o.low++;
        o.entries.push({ item: { stockItemId: row.id, offerId: row.offer_id, sku: row.sku, label: row.label, available, threshold, state }, ratio: threshold ? available / threshold : available });
        owners.set(key, o);
        count++;
      }
      if (ids.length < BATCH) break;
    }
    for (const o of owners.values()) {
      // worst first: out of stock, then the lowest share of the threshold, then SKU
      const worst = o.entries.sort((a, b) => Number(b.item.state === 'out_of_stock') - Number(a.item.state === 'out_of_stock') || a.ratio - b.ratio || a.item.sku.localeCompare(b.item.sku));
      this.core.ctx.events.publish(
        'inventory.stock.low_digest',
        { ownerType: o.ownerType, sellerId: o.sellerId, date, lowCount: o.low, outOfStockCount: o.out, items: worst.slice(0, DIGEST_ITEMS).map((e) => e.item) },
        { actor: SYSTEM_ACTOR },
      );
    }
    this.core.ctx.log.info({ owners: owners.size, items: count }, 'inventory: low-stock digest');
    return { owners: owners.size, items: count };
  }

  /** Job inventory.valuation-snapshot (daily 23:59 market time): Snapshot units and value at cost per group for company trading reports */
  async valuationSnapshot(): Promise<StockSummary> {
    const summary = await this.getStockSummary();
    const takenAt = this.core.now();
    await this.core.repo.saveValuationSnapshot(
      summary.groups.map((g) => ({
        snapshot_date: this.core.today(),
        stock_group: g.group,
        units: g.units,
        value_at_cost_amount: g.valueAtCost?.amount ?? 0,
        currency: g.valueAtCost?.currency ?? this.core.currency,
        sku_count: summary.skuCount,
        taken_at: takenAt,
      })),
    );
    this.core.ctx.log.info({ snapshot: { at: this.core.now().toISOString(), date: this.core.today(), skuCount: summary.skuCount, groups: summary.groups.map((g) => ({ group: g.group, units: g.units, valueAtCost: g.valueAtCost?.amount ?? 0 })) } }, 'inventory: valuation snapshot');
    return summary;
  }
}
