import { notImplemented, routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/inventory.js';
import type { InventoryService } from '../service.js';

/**
 * Seller API: /api/seller/inventory/…  (docs/api/modules/inventory.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const sellerRoutes = (service: InventoryService) => {
  void service;
  return routes(endpoints, 'seller', {
    /** GET /stock-items: Quantities for the seller's offers: available, reserved, low-stock threshold, status */
    listOwnStock: notImplemented,
    /** GET /summary: In stock, low, out of stock and reserved totals */
    getOwnStockSummary: notImplemented,
    /** POST /stock-items/exports: Export the seller's stock rows (current filters or selected rows) as CSV */
    exportOwnStock: notImplemented,
    /** GET /stock-items/exports/{id}: Stock export status and download link (requesting member only) */
    getOwnStockExport: notImplemented,
    /** GET /stock-items/{id}: One stock item with reservations and movement history */
    getOwnStockItem: notImplemented,
    /** POST /stock-items/{id}/adjustments: Set a new available quantity with a reason */
    adjustOwnStock: notImplemented,
    /** POST /adjustments/batch: Save several inline quantity edits at once (each with a reason) */
    batchAdjustOwnStock: notImplemented,
    /** PATCH /stock-items/{id}: Change the low-stock alert threshold */
    updateOwnStockItem: notImplemented,
    /** GET /movements: Adjustment and movement history (reason, person, time) */
    listOwnMovements: notImplemented,
  });
};
