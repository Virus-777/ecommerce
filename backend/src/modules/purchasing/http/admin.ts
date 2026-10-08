import { notImplemented, routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/purchasing.js';
import type { PurchasingService } from '../service.js';

/**
 * Admin API: /api/admin/purchasing/…  (docs/api/modules/purchasing.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const adminRoutes = (service: PurchasingService) =>
  routes(endpoints, 'admin', {
    /** GET /summary: Open purchase orders, committed cost, incoming units, late or short, low-stock items */
    getPurchasingSummary: notImplemented,
    /** GET /suppliers: Suppliers with lead time, on-time rate and open POs */
    listSuppliers: notImplemented,
    /** POST /suppliers: Add a supplier */
    createSupplier: notImplemented,
    /** GET /suppliers/{id}: Supplier with price list, performance, recent POs and open claims */
    getSupplier: notImplemented,
    /** PATCH /suppliers/{id}: Edit or deactivate a supplier */
    updateSupplier: notImplemented,
    /** PUT /suppliers/{id}/items: Replace a supplier's price list (buying costs per SKU) */
    putSupplierItems: notImplemented,
    /** GET /purchase-orders: Purchase orders with status, cost and expected arrival */
    listPurchaseOrders: notImplemented,
    /** POST /purchase-orders: Create a draft purchase order */
    createPurchaseOrder: notImplemented,
    /** GET /purchase-orders/{id}: Purchase order: lines expected vs received, costs, deliveries, receipts, claims, approval and timeline */
    getPurchaseOrder: notImplemented,
    /** PATCH /purchase-orders/{id}: Edit a draft, or update expected dates and notes after sending */
    updatePurchaseOrder: notImplemented,
    /** POST /purchase-orders/{id}/send: Send to the supplier (or request approval when above the buyer's limit) */
    sendPurchaseOrder: notImplemented,
    /** POST /purchase-orders/{id}/cancel: Cancel a draft or a sent PO with nothing received */
    cancelPurchaseOrder: notImplemented,
    /** POST /purchase-orders/{id}/close: Close a partly received PO short (remaining units will not arrive) */
    closePurchaseOrder: notImplemented,
    /** GET /reorder-suggestions: SKUs at or below reorder point after incoming stock, with suggested quantity and preferred supplier */
    listReorderSuggestions: notImplemented,
    /** POST /purchase-orders/from-suggestions: Create draft POs (one per preferred supplier) from selected suggestions */
    createFromSuggestions: notImplemented,
    /** GET /deliveries: Expected and arrived purchase deliveries for receiving */
    listDeliveries: notImplemented,
    /** POST /purchase-orders/{id}/deliveries: Add an expected delivery (carrier, reference, arrival window) */
    addDelivery: notImplemented,
    /** PATCH /deliveries/{id}: Reschedule or mark a delivery delayed, with a reason */
    updateDelivery: notImplemented,
    /** POST /deliveries/{id}/arrive: Check in a delivery at the dock */
    arriveDelivery: notImplemented,
    /** POST /deliveries/{id}/receipts: Start receiving: creates the receiving record with expected quantities */
    startReceipt: notImplemented,
    /** GET /deliveries/stats: Receiving KPIs and tab counts */
    getReceivingStats: notImplemented,
    /** GET /receipts: Receiving records (in progress, waiting for confirmation, with issues, completed) */
    listReceipts: notImplemented,
    /** GET /receipts/{id}: One receiving record: expected vs received, damage photos, bins, buying cost */
    getReceipt: notImplemented,
    /** PATCH /receipts/{id}: Record counted, damaged, bin and photos per line (save and finish later) */
    updateReceipt: notImplemented,
    /** POST /receipts/{id}/submit: Finish counting: shortages go to Purchasing, units wait in Incoming for Inventory to confirm */
    submitReceipt: notImplemented,
    /** POST /receipts/{id}/cancel: Discard a receiving record started by mistake */
    cancelReceipt: notImplemented,
    /** GET /claims: Supplier claims for shortages and damage */
    listClaims: notImplemented,
    /** POST /claims: Open a supplier claim */
    createClaim: notImplemented,
    /** POST /claims/{id}/submit: Mark a claim as sent to the supplier */
    submitClaim: notImplemented,
    /** POST /claims/{id}/settle: Record the supplier's settlement (credit note, refund or replacement) */
    settleClaim: notImplemented,
    /** POST /claims/{id}/close: Close a claim as rejected by the supplier or withdrawn */
    closeClaim: notImplemented,
  });
