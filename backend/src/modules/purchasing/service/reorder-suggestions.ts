/**
 * Reorder suggestions: company stock at or below its reorder point after incoming and drafted units, with the
 * preferred (else cheapest) supplier, and the drafts created from them. Candidates include the stock items inventory
 * reported low (inventory.stock.low), kept in memory until they are back above their reorder point.
 */
import { AppError } from '../../../kernel/errors/index.js';
import type { EventPayload } from '../../../kernel/events/index.js';
import { money } from '../../../kernel/lib/money.js';
import { pageOf, type Page, type PageRequest } from '../../../kernel/lib/pagination.js';
import type { Location } from '../../../spec/inventory.js';
import type { PurchaseOrder, ReorderSuggestion } from '../../../spec/purchasing.js';
import { addDays, invalid, invalidMany, OPEN_PO_STATUSES, openQty, suggestedQuantity } from '../domain/rules.js';
import type { PoRow, StockInfo, SupplierItemRow } from '../ports.js';
import type { Caller, Core, NewLine } from './core.js';
import { groupBy } from '../views.js';

/** Sales velocity window for reorder suggestions (inventory.getSalesRate) */
const SALES_RATE_DAYS = 30;
/** Suppliers deliver to company warehouses only (not seller virtual locations) */
const isCompanyWarehouse = (l: Location) => l.ownerType === 'official' && l.kind === 'warehouse';

export class ReorderSuggestions {
  /** Company stock items inventory reported low (inventory.stock.low), candidates for reorder suggestions */
  readonly #lowStock = new Map<string, StockInfo>();
  #lastSuggestions: { at: Date; count: number } | null = null;

  constructor(private readonly core: Core) {}

  async listReorderSuggestions(query: { supplierId?: string }, page: PageRequest): Promise<Page<ReorderSuggestion>> {
    return pageOf(await this.suggestions({ supplierId: query.supplierId }), page);
  }

  async createFromSuggestions(body: { stockItemIds: string[]; quantities?: Record<string, number> | null; shipToLocationId?: string | null }, by: Caller): Promise<PurchaseOrder[]> {
    const ids = [...new Set(body.stockItemIds ?? [])];
    if (!ids.length) throw invalid('stockItemIds', 'Choose at least one item');
    const quantities = body.quantities ?? {};
    const qIssues = Object.entries(quantities).flatMap(([k, v]) =>
      !ids.includes(k) ? [{ path: `quantities.${k}`, message: 'Not one of the chosen items' }] : !Number.isInteger(v) || v < 1 ? [{ path: `quantities.${k}`, message: 'Order at least 1 unit' }] : [],
    );
    if (qIssues.length) throw invalidMany('Some quantities are invalid', qIssues);
    const suggestions = new Map((await this.suggestions({ stockItemIds: ids, includeAll: true })).map((s) => [s.stockItemId, s]));
    const noSupplier = ids.filter((i) => !suggestions.get(i)?.supplier);
    if (noSupplier.length) throw invalidMany('Some items have no supplier on a price list', noSupplier.map((i) => ({ path: `stockItemIds.${ids.indexOf(i)}`, message: 'No active supplier sells this item; add it to a price list first' })));
    const info = await this.core.requireCompanyStock(ids);
    // every draft ships to the chosen company warehouse, or inventory's default one (never copied from an earlier PO)
    const shipTo = (await this.shipToLocation(body.shipToLocationId ?? null)).id;
    const items = await this.core.repo.itemsForStock({ stockItemIds: ids });
    const priceRow = new Map(items.map((i) => [`${i.supplierId}:${i.stockItemId}`, i]));
    const bySupplier = groupBy(ids, (id) => suggestions.get(id)!.supplier!.id);
    const suppliers = new Map((await this.core.repo.getSuppliers([...bySupplier.keys()])).map((s) => [s.id, s]));
    for (const s of suppliers.values()) if (!s.active) throw new AppError('SUPPLIER_INACTIVE', `${s.name} is deactivated.`, { supplierId: s.id });
    const today = this.core.today();
    const created: PoRow[] = [];
    for (const [supplierId, stockIds] of bySupplier) {
      const supplier = suppliers.get(supplierId)!;
      const lines: NewLine[] = stockIds.map((sid) => {
        const item = priceRow.get(`${supplierId}:${sid}`)!;
        return {
          stockItemId: sid,
          sku: info.get(sid)!.sku,
          label: info.get(sid)!.label,
          quantity: quantities[sid] ?? suggestions.get(sid)!.suggestedQuantity,
          unitCostAmount: item.unitCostAmount,
          expectedDate: addDays(today, item.leadTimeDays ?? supplier.leadTimeDays),
        };
      });
      created.push(
        await this.core.createDraft(
          { supplier, shipToLocationId: shipTo, lines, freightAmount: 0, paymentTerms: supplier.paymentTerms, expectedDate: null, notes: null, attachmentIds: [] },
          by,
          'Created from reorder suggestions',
        ),
      );
    }
    return Promise.all(created.map((p) => this.core.views.purchaseOrder(p)));
  }

  /**
   * Company stock at or below its reorder point after incoming and drafted units, with the preferred
   * (else cheapest) supplier. Candidates: SKUs on a preferred price list row and SKUs inventory reported low.
   */
  async suggestions(filter: { supplierId?: string; stockItemIds?: string[]; includeAll?: boolean }): Promise<ReorderSuggestion[]> {
    const candidates = new Set<string>(filter.stockItemIds ?? []);
    if (!filter.stockItemIds) {
      for (const i of await this.core.repo.itemsForStock({ preferredOnly: true, supplierId: filter.supplierId })) candidates.add(i.stockItemId);
      for (const id of this.#lowStock.keys()) candidates.add(id);
    }
    if (!candidates.size) return [];
    const ids = [...candidates];
    const items = await this.core.repo.itemsForStock({ stockItemIds: ids });
    const best = new Map<string, SupplierItemRow>();
    for (const i of items) if (!best.has(i.stockItemId)) best.set(i.stockItemId, i); // preferred first, then cheapest
    const scoped = filter.supplierId ? ids.filter((id) => best.get(id)?.supplierId === filter.supplierId) : ids;
    if (!scoped.length) return [];
    const [availability, onOrder, coverDays, suppliers, rates] = await Promise.all([
      this.core.inventory().getAvailability(scoped),
      this.core.repo.linesForStock(scoped, OPEN_PO_STATUSES),
      this.core.ctx.settings.get('reorderCoverDays'),
      this.core.repo.getSuppliers([...new Set(scoped.flatMap((id) => (best.get(id) ? [best.get(id)!.supplierId] : [])))]),
      // units sold per day over the last 30 days (inventory.getSalesRate)
      this.core.inventory().getSalesRate(scoped, SALES_RATE_DAYS),
    ]);
    const supplierById = new Map(suppliers.map((s) => [s.id, s]));
    const onOrderOf = groupBy(onOrder, (l) => l.stockItemId);
    const out: (ReorderSuggestion & { gap: number })[] = [];
    const pending: string[] = [];
    for (const id of scoped) {
      const a = availability?.[id];
      if (!a) continue;
      const reorderPoint = a.lowStockThreshold ?? null;
      const lines = onOrderOf.get(id) ?? [];
      const incoming = lines.filter((l) => l.status !== 'draft').reduce((n, l) => n + openQty(l), 0);
      const drafted = lines.filter((l) => l.status === 'draft').reduce((n, l) => n + l.qtyOrdered, 0);
      if (!filter.includeAll && (reorderPoint === null || a.available + incoming + drafted > reorderPoint)) continue;
      const item = best.get(id);
      const supplier = item ? supplierById.get(item.supplierId) : undefined;
      const avgDailySales = rates?.[id] ? Math.round(rates[id]!.avgDailySales * 100) / 100 : null;
      const qty = suggestedQuantity({ available: a.available, incoming: incoming + drafted, reorderPoint: reorderPoint ?? 0, avgDailySales, coverDays, minOrderQuantity: item?.minOrderQty ?? null });
      pending.push(id);
      out.push({
        stockItemId: id,
        sku: '',
        label: '',
        available: a.available,
        reorderPoint,
        incoming,
        avgDailySales,
        suggestedQuantity: qty,
        supplier: supplier ? this.core.views.supplierCue(supplier, supplier.id) : null,
        unitCost: item ? money(item.unitCostAmount, item.currency) : null,
        estimatedCost: item ? money(item.unitCostAmount * qty, item.currency) : null,
        gap: a.available + incoming - (reorderPoint ?? 0),
      });
    }
    const info = await this.core.views.describe(pending);
    for (const s of out) {
      const i = info.get(s.stockItemId) ?? this.#lowStock.get(s.stockItemId);
      s.sku = i?.sku ?? '';
      s.label = i?.label ?? 'Stock item';
    }
    return out.sort((a, b) => a.gap - b.gap || a.sku.localeCompare(b.sku)).map(({ gap: _gap, ...s }) => s);
  }

  /** inventory.stock.low: Refresh reorder suggestions for company stock items */
  async onStockLowFromInventory(event: EventPayload<'inventory.stock.low'>): Promise<void> {
    if (event.ownerType !== 'official') return; // sellers buy their own stock
    const info: StockInfo = { stockItemId: event.stockItemId, sku: event.sku, label: event.label, ownerType: 'official' };
    this.#lowStock.set(event.stockItemId, info);
  }

  /** Job purchasing.reorder-suggestions (hourly): Rebuild suggestions from inventory low stock, incoming quantities and 30-day sales velocity */
  async reorderSuggestions(): Promise<number> {
    const list = await this.suggestions({});
    // items back above their reorder point leave the low-stock candidates
    if (this.#lowStock.size) {
      const availability = await this.core.inventory().getAvailability([...this.#lowStock.keys()]);
      for (const id of [...this.#lowStock.keys()]) {
        const a = availability?.[id];
        if (!a || (a.lowStockThreshold !== null && a.available > a.lowStockThreshold)) this.#lowStock.delete(id);
      }
    }
    this.#lastSuggestions = { at: this.core.now(), count: list.length };
    this.core.ctx.log.info({ suggestions: list.length }, 'purchasing: reorder suggestions rebuilt');
    return list.length;
  }

  get lastSuggestions() {
    return this.#lastSuggestions;
  }

  /**
   * The company warehouse a draft ships to: the given location (known, active, a company warehouse) or
   * inventory's default location. VALIDATION_FAILED otherwise.
   */
  private async shipToLocation(locationId: string | null): Promise<Location> {
    const inventory = this.core.inventory();
    if (!locationId) {
      const def = await inventory.getDefaultLocation();
      if (!def || !isCompanyWarehouse(def)) throw invalid('shipToLocationId', 'There is no default company warehouse yet; choose where the supplier delivers');
      return def;
    }
    const loc = (await inventory.getLocations({ ownerType: 'official', activeOnly: false })).find((l) => l.id === locationId);
    if (!loc) throw invalid('shipToLocationId', 'Unknown stock location');
    if (!loc.active) throw invalid('shipToLocationId', `${loc.name} is not active`);
    if (!isCompanyWarehouse(loc)) throw invalid('shipToLocationId', `${loc.name} is not a company warehouse`);
    return loc;
  }
}
