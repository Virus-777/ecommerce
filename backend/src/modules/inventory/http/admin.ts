import { routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/inventory.js';
import type { InventoryService } from '../service.js';

/**
 * Admin API: /api/admin/inventory/…  (docs/api/modules/inventory.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const adminRoutes = (service: InventoryService) =>
  routes(endpoints, 'admin', {
    /** GET /stock-items: Stock by SKU with all five groups, bin, reorder point, cost and status */
    listStockItems: async ({ query, page }) => service.listStockItems(query, page),
    /** GET /summary: Units and value at cost per stock group, low and out-of-stock counts */
    getStockSummary: async ({ query }) => service.getStockSummary(query.locationId),
    /** GET /stock-items/{id}: Stock item with levels per location, reservations, incoming, pending adjustments and history */
    getStockItem: async ({ params }) => service.getStockItem(params.id),
    /** POST /stock-items: Create a company stock item (SKU) at a location */
    createStockItem: async ({ body, principal, actor, requestId }) => service.createStockItemAsStaff(body, { principal, actor, requestId }),
    /** PATCH /stock-items/{id}: Change reorder point, reorder quantity or archive a company SKU */
    updateStockItem: async ({ params, body, principal, actor, requestId }) => service.updateStockItemAsStaff(params.id, body, { principal, actor, requestId }),
    /** POST /adjustments: Move company stock between groups, or into or out of stock, with a reason */
    createAdjustment: async ({ body, principal, actor, requestId }) => service.createAdjustment(body, { principal, actor, requestId }),
    /** GET /adjustments: Adjustments, including those waiting for second review */
    listAdjustments: async ({ query, page }) => service.listAdjustments(query, page),
    /** POST /adjustments/{id}/cancel: Withdraw an adjustment waiting for review */
    cancelAdjustment: async ({ params, body, principal, actor, requestId }) => service.cancelAdjustment(params.id, body.reason, { principal, actor, requestId }),
    /** GET /movements: Movement ledger (adjustment history with reason, staff and date) */
    listMovements: async ({ query, page }) => service.listMovements(query, page),
    /** GET /reservations: Holds and allocations by order or stock item */
    listReservations: async ({ query, page }) => service.listReservations(query, page),
    /** POST /reservations/{id}/release: Release a stuck hold or allocation (e.g. order closed without a cancel event) */
    releaseReservation: async ({ params, body, principal, actor, requestId }) => service.releaseReservation(params.id, body, { principal, actor, requestId }),
    /** GET /inbound: Received deliveries waiting for the Inventory Manager to make them sellable */
    listInbound: async ({ query, page }) => service.listInbound(query, page),
    /** GET /inbound/{id}: One counted receipt: received, damaged, shortage and proposed sellable per line */
    getInbound: async ({ params }) => service.getInbound(params.id),
    /** POST /inbound/{id}/confirm: Make received units available for sale */
    confirmInbound: async ({ params, body, principal, actor, requestId }) => service.confirmInbound(params.id, body, { principal, actor, requestId }),
    /** GET /return-outcomes: Inspected Official Store returns waiting for their stock outcome */
    listReturnOutcomes: async ({ query, page }) => service.listReturnOutcomes(query, page),
    /** POST /return-outcomes/{id}/record: Record the stock outcome of a returned item */
    recordReturnOutcome: async ({ params, body, principal, actor, requestId }) => service.recordReturnOutcome(params.id, body, { principal, actor, requestId }),
    /** GET /discrepancies: Shortages and damage reported by the warehouse */
    listDiscrepancies: async ({ query, page }) => service.listDiscrepancies(query, page),
    /** POST /discrepancies/{id}/resolve: Resolve a shortage or damage report (reallocate, adjust or no change) */
    resolveDiscrepancy: async ({ params, body, principal, actor, requestId }) => service.resolveDiscrepancy(params.id, body, { principal, actor, requestId }),
    /** GET /low-stock: SKUs at or below reorder point with incoming stock and suggested reorder quantity */
    listLowStock: async ({ query, page }) => service.listLowStock(query, page),
    /** GET /locations: Company stock locations */
    listLocations: async () => service.listLocations(),
    /** POST /locations: Add a company stock location */
    createLocation: async ({ body, principal, actor, requestId }) => service.createLocation(body, { principal, actor, requestId }),
    /** PATCH /locations/{id}: Rename, deactivate or change whether a location is sellable */
    updateLocation: async ({ params, body, principal, actor, requestId }) => service.updateLocation(params.id, body, { principal, actor, requestId }),
    /** POST /transfers: Plan a transfer between warehouses */
    createTransfer: async ({ body, principal, actor, requestId }) => service.createTransfer(body, { principal, actor, requestId }),
    /** GET /transfers: Transfers */
    listTransfers: async ({ query, page }) => service.listTransfers(query, page),
    /** POST /transfers/{id}/ship: Send a transfer (source Available → destination Incoming) */
    shipTransfer: async ({ params, principal, actor, requestId }) => service.shipTransfer(params.id, { principal, actor, requestId }),
    /** POST /transfers/{id}/receive: Receive a transfer (received quantities per line) */
    receiveTransfer: async ({ params, body, principal, actor, requestId }) => service.receiveTransfer(params.id, body, { principal, actor, requestId }),
    /** POST /transfers/{id}/cancel: Cancel a draft transfer */
    cancelTransfer: async ({ params, body, principal, actor, requestId }) => service.cancelTransfer(params.id, body.reason, { principal, actor, requestId }),
    /** POST /counts: Start a stock count for a zone, bin range or SKU list */
    createCount: async ({ body, principal, actor, requestId }) => service.createCount(body, { principal, actor, requestId }),
    /** PUT /counts/{id}/lines: Record counted quantities */
    recordCountLines: async ({ params, body }) => service.recordCountLines(params.id, body.lines),
    /** POST /counts/{id}/submit: Submit a count; differences become count-correction adjustments */
    submitCount: async ({ params, principal, actor, requestId }) => service.submitCount(params.id, { principal, actor, requestId }),
    /** POST /stock-items/{id}/merge: Merge this company SKU into another one (e.g. after a catalog variant merge) */
    mergeStockItem: async ({ params, body, principal, actor, requestId }) => service.mergeStockItemAsStaff(params.id, body, { principal, actor, requestId }),
  });
