/**
 * StockDirectory over inventory's public API: SKU, label and owner of stock items by id
 * (inventory.getStockItems; unknown ids are left out).
 */
import type { InventoryPublicApi } from '../../../spec/inventory.js';
import type { StockDirectory, StockInfo } from '../ports.js';

export function createInventoryStockDirectory(deps: { inventory: () => InventoryPublicApi }): StockDirectory {
  return {
    async describe(stockItemIds) {
      const out = new Map<string, StockInfo>();
      const ids = [...new Set(stockItemIds)];
      if (!ids.length) return out;
      for (const s of await deps.inventory().getStockItems(ids)) out.set(s.id, { stockItemId: s.id, sku: s.sku, label: s.label, ownerType: s.ownerType });
      return out;
    },
  };
}
