import { notImplemented, routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/inventory.js';
import type { InventoryService } from '../service.js';

/**
 * Admin API: /api/admin/inventory/…  (docs/api/modules/inventory.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const adminRoutes = (service: InventoryService) =>
  routes(endpoints, 'admin', {
    /** GET /stock-items: Stock by SKU with all five groups, bin, reorder point, cost and status */
    listStockItems: notImplemented,
    /** GET /summary: Units and value at cost per stock group, low and out-of-stock counts */
    getStockSummary: notImplemented,
    /** GET /stock-items/{id}: Stock item with levels per location, reservations, incoming, pending adjustments and history */
    getStockItem: notImplemented,
    /** POST /stock-items: Create a company stock item (SKU) at a location */
    createStockItem: notImplemented,
    /** PATCH /stock-items/{id}: Change reorder point, reorder quantity or archive a company SKU */
    updateStockItem: notImplemented,
    /** POST /adjustments: Move company stock between groups, or into or out of stock, with a reason */
    createAdjustment: notImplemented,
    /** GET /adjustments: Adjustments, including those waiting for second review */
    listAdjustments: notImplemented,
    /** POST /adjustments/{id}/cancel: Withdraw an adjustment waiting for review */
    cancelAdjustment: notImplemented,
    /** GET /movements: Movement ledger (adjustment history with reason, staff and date) */
    listMovements: notImplemented,
    /** GET /reservations: Holds and allocations by order or stock item */
    listReservations: notImplemented,
    /** POST /reservations/{id}/release: Release a stuck hold or allocation (e.g. order closed without a cancel event) */
    releaseReservation: notImplemented,
    /** GET /inbound: Received deliveries waiting for the Inventory Manager to make them sellable */
    listInbound: notImplemented,
    /** GET /inbound/{id}: One counted receipt: received, damaged, shortage and proposed sellable per line */
    getInbound: notImplemented,
    /** POST /inbound/{id}/confirm: Make received units available for sale */
    confirmInbound: notImplemented,
    /** GET /return-outcomes: Inspected Official Store returns waiting for their stock outcome */
    listReturnOutcomes: notImplemented,
    /** POST /return-outcomes/{id}/record: Record the stock outcome of a returned item */
    recordReturnOutcome: notImplemented,
    /** GET /discrepancies: Shortages and damage reported by the warehouse */
    listDiscrepancies: notImplemented,
    /** POST /discrepancies/{id}/resolve: Resolve a shortage or damage report (reallocate, adjust or no change) */
    resolveDiscrepancy: notImplemented,
    /** GET /low-stock: SKUs at or below reorder point with incoming stock and suggested reorder quantity */
    listLowStock: notImplemented,
    /** GET /locations: Company stock locations */
    listLocations: notImplemented,
    /** POST /locations: Add a company stock location */
    createLocation: notImplemented,
    /** PATCH /locations/{id}: Rename, deactivate or change whether a location is sellable */
    updateLocation: notImplemented,
    /** POST /transfers: Plan a transfer between warehouses */
    createTransfer: notImplemented,
    /** GET /transfers: Transfers */
    listTransfers: notImplemented,
    /** POST /transfers/{id}/ship: Send a transfer (source Available → destination Incoming) */
    shipTransfer: notImplemented,
    /** POST /transfers/{id}/receive: Receive a transfer (received quantities per line) */
    receiveTransfer: notImplemented,
    /** POST /transfers/{id}/cancel: Cancel a draft transfer */
    cancelTransfer: notImplemented,
    /** POST /counts: Start a stock count for a zone, bin range or SKU list */
    createCount: notImplemented,
    /** PUT /counts/{id}/lines: Record counted quantities */
    recordCountLines: notImplemented,
    /** POST /counts/{id}/submit: Submit a count; differences become count-correction adjustments */
    submitCount: notImplemented,
  });
