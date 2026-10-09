import { routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/inventory.js';
import type { InventoryService } from '../service.js';

/**
 * Seller API: /api/seller/inventory/…  (docs/api/modules/inventory.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 * Every call acts for the session's seller (input.sellerId); other sellers' items are not found.
 */
export const sellerRoutes = (service: InventoryService) =>
  routes(endpoints, 'seller', {
    /** GET /stock-items: Quantities for the seller's offers: available, reserved, low-stock threshold, status */
    listOwnStock: async ({ sellerId, query, page }) => service.listOwnStock(sellerId, query, page),
    /** GET /summary: In stock, low, out of stock and reserved totals */
    getOwnStockSummary: async ({ sellerId }) => service.getSellerStockSummary(sellerId),
    /** POST /stock-items/exports: Export the seller's stock rows (current filters or selected rows) as CSV */
    exportOwnStock: async ({ sellerId, body, principal, actor, requestId }) => service.exportOwnStock(body, { sellerId, principal, actor, requestId }),
    /** GET /stock-items/exports/{id}: Stock export status and download link (requesting member only) */
    getOwnStockExport: async ({ sellerId, params, principal, actor, requestId }) => service.getOwnStockExport(params.id, { sellerId, principal, actor, requestId }),
    /** GET /stock-items/{id}: One stock item with reservations and movement history */
    getOwnStockItem: async ({ sellerId, params }) => service.getOwnStockItem(sellerId, params.id),
    /** POST /stock-items/{id}/adjustments: Set a new available quantity with a reason */
    adjustOwnStock: async ({ sellerId, params, body, principal, actor, requestId }) => service.adjustOwnStock(params.id, body, { sellerId, principal, actor, requestId }),
    /** POST /adjustments/batch: Save several inline quantity edits at once (each with a reason) */
    batchAdjustOwnStock: async ({ sellerId, body, principal, actor, requestId }) => service.batchAdjustOwnStock(body, { sellerId, principal, actor, requestId }),
    /** PATCH /stock-items/{id}: Change the low-stock alert threshold */
    updateOwnStockItem: async ({ sellerId, params, body }) => service.updateOwnStockItem(sellerId, params.id, body),
    /** GET /movements: Adjustment and movement history (reason, person, time) */
    listOwnMovements: async ({ sellerId, query, page }) => service.listOwnMovements(sellerId, query, page),
  });
